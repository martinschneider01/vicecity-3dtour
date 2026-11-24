/**
 * The world's texture arrays.
 *
 * Each manifest class becomes a WebGL array of S3TC-compressed textures. On
 * disk, a class is split into small KTX2 (Basis Universal) files of a few
 * layers each. A pack lists the layers it needs; we download the matching
 * files, a worker transcodes them to the GPU format, and the layers are
 * uploaded one by one. three.js can't fill a texture array piecemeal, so we
 * manage the WebGL texture by hand and hand it over via ExternalTexture.
 */
import * as THREE from 'three';
import { dxtByteLength, mipSizes } from '../shared/dxt.ts';
import type { TexClass } from '../shared/format.ts';
import type { TranscodeRequest, TranscodeResponse } from './basis-worker.ts';

const COMPRESSED_RGB_S3TC_DXT1 = 0x83f0;
const COMPRESSED_RGBA_S3TC_DXT5 = 0x83f3;
/** Number of download attempts per file before giving up. */
const ATTEMPTS = 3;

interface ClassState {
  info: TexClass;
  texture: THREE.ExternalTexture;
  glTexture: WebGLTexture | null;
  /** Load of each file in the class: null = not requested, promise = in progress or done. */
  chunks: (Promise<void> | null)[];
}

export class TextureArrays {
  private readonly gl: WebGL2RenderingContext;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly baseUrl: string;
  private readonly classes: ClassState[];
  private readonly s3tc: boolean;
  private readonly maxAnisotropy: number;
  private readonly anisoExt: EXT_texture_filter_anisotropic | null;
  private readonly workers: Worker[] = [];
  private readonly waiting = new Map<number, { resolve: (d: Uint8Array) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  /** Number of texture files currently loading. */
  inFlight = 0;
  bytesLoaded = 0;
  /** Longest single texture upload to the GPU, in milliseconds. */
  maxUploadMs = 0;
  /**
   * Transcoded files waiting for their GPU upload. Uploading one can take a
   * while: they are spread over frames by flushUploads().
   */
  private readonly pendingUploads: { c: ClassState; first: number; count: number; data: Uint8Array; done: () => void }[] = [];

  constructor(renderer: THREE.WebGLRenderer, classes: TexClass[], baseUrl: string) {
    this.renderer = renderer;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.baseUrl = baseUrl;
    this.s3tc = !!this.gl.getExtension('WEBGL_compressed_texture_s3tc');
    this.anisoExt = this.gl.getExtension('EXT_texture_filter_anisotropic');
    this.maxAnisotropy = this.anisoExt
      ? Math.min(8, this.gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
      : 1;
    const maxLayers = this.gl.getParameter(this.gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    this.classes = classes.map((info) => {
      if (info.layers > maxLayers) {
        throw new Error(`This GPU limits texture arrays to ${maxLayers} layers (${info.layers} needed).`);
      }
      return { info, texture: new THREE.ExternalTexture(null), glTexture: null, chunks: info.chunks.map(() => null) };
    });
    if (!this.s3tc) console.warn('S3TC extension missing: textures are uncompressed in video memory (about six times larger).');

    // A few transcoding workers: loading the full map keeps several busy.
    const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./basis-worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<TranscodeResponse>) => {
        const job = this.waiting.get(e.data.id);
        if (!job) return;
        this.waiting.delete(e.data.id);
        if (e.data.data) job.resolve(e.data.data);
        else job.reject(new Error(e.data.error ?? 'transcoding failed'));
      };
      this.workers.push(w);
    }
  }

  get usesSoftwareDecoding(): boolean {
    return !this.s3tc;
  }

  /**
   * Allocates the video memory of every texture array now. The first upload
   * to an array would otherwise pay for it, a long freeze on some drivers
   * (several hundred ms for the big arrays under Direct3D).
   */
  allocateAll(): void {
    for (const c of this.classes) if (!c.glTexture) this.allocate(c);
  }

  /**
   * Uploads waiting textures to the GPU, one file at least, then more while
   * the time budget (ms) allows. Call once per frame.
   */
  flushUploads(budgetMs: number): void {
    const t0 = performance.now();
    while (this.pendingUploads.length) {
      const job = this.pendingUploads.shift()!;
      this.upload(job.c, job.first, job.count, job.data);
      job.done();
      if (performance.now() - t0 > budgetMs) break;
    }
    this.lastFlushMs = performance.now() - t0;
  }

  /** Time spent uploading textures during the last flushUploads() call, in ms. */
  lastFlushMs = 0;

  /** three.js texture for a class, to plug into a sampler2DArray uniform. */
  texture(cls: number): THREE.ExternalTexture {
    const c = this.classes[cls];
    if (!c.glTexture) this.allocate(c);
    return c.texture;
  }

  private bind(c: ClassState): void {
    const gl = this.gl;
    this.renderer.state.activeTexture(gl.TEXTURE0);
    this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, c.glTexture!);
  }

  private allocate(c: ClassState): void {
    const gl = this.gl;
    const { size, fmt, layers } = c.info;
    c.glTexture = gl.createTexture();
    this.bind(c);
    const internal = !this.s3tc ? gl.RGBA8 : fmt === 'bc1' ? COMPRESSED_RGB_S3TC_DXT1 : COMPRESSED_RGBA_S3TC_DXT5;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, mipSizes(size).length, internal, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (this.anisoExt) {
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy);
    }
    c.texture.sourceTexture = c.glTexture;
  }

  /** Uploads consecutive transcoded layers to the GPU (back to back, each with its mipmaps). */
  private upload(c: ClassState, first: number, count: number, data: Uint8Array): void {
    const gl = this.gl;
    const { size, fmt } = c.info;
    const blockBytes = fmt === 'bc1' ? 8 : 16;
    const t0 = performance.now();
    if (!c.glTexture) this.allocate(c);
    this.bind(c);
    let off = 0;
    for (let layer = first; layer < first + count; layer++) {
      mipSizes(size).forEach((s, level) => {
        if (this.s3tc) {
          const n = dxtByteLength(s, s, blockBytes);
          gl.compressedTexSubImage3D(
            gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, s, s, 1,
            fmt === 'bc1' ? COMPRESSED_RGB_S3TC_DXT1 : COMPRESSED_RGBA_S3TC_DXT5,
            data.subarray(off, off + n),
          );
          off += n;
        } else {
          const n = s * s * 4;
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, s, s, 1, gl.RGBA, gl.UNSIGNED_BYTE, data.subarray(off, off + n));
          off += n;
        }
      });
    }
    this.maxUploadMs = Math.max(this.maxUploadMs, performance.now() - t0);
  }

  private transcode(buffer: ArrayBuffer, size: number, count: number, format: TranscodeRequest['format']): Promise<Uint8Array> {
    const id = this.nextId++;
    const worker = this.workers[id % this.workers.length];
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.postMessage({ id, buffer, size, count, format } satisfies TranscodeRequest, [buffer]);
    });
  }

  private async loadChunk(c: ClassState, index: number): Promise<void> {
    const chunk = c.info.chunks[index];
    this.inFlight++;
    try {
      let buffer: ArrayBuffer | null = null;
      let failure: Error | null = null;
      for (let attempt = 0; attempt < ATTEMPTS && !buffer; attempt++) {
        try {
          const res = await fetch(this.baseUrl + chunk.file);
          if (!res.ok) throw new Error(`${chunk.file}: HTTP ${res.status}`);
          buffer = await res.arrayBuffer();
        } catch (e) {
          failure = e as Error;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
      if (!buffer) throw failure ?? new Error(`${chunk.file}: read failed`);
      this.bytesLoaded += buffer.byteLength;
      const data = await this.transcode(buffer, c.info.size, chunk.count, this.s3tc ? c.info.fmt : 'rgba');
      await new Promise<void>((done) => this.pendingUploads.push({ c, first: chunk.first, count: chunk.count, data, done }));
    } catch (e) {
      // Failure: the file can be requested again.
      c.chunks[index] = null;
      throw e;
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Ensures the requested layers (flat [class, layer] pairs) are loaded.
   * The promise resolves once they are all on the GPU.
   */
  request(pairs: number[]): Promise<unknown> {
    const waits = new Set<Promise<void>>();
    for (let i = 0; i < pairs.length; i += 2) {
      const c = this.classes[pairs[i]];
      // All files in a class have the same layer count, except the last one.
      const index = Math.floor(pairs[i + 1] / c.info.chunks[0].count);
      let p = c.chunks[index];
      if (!p) {
        p = this.loadChunk(c, index);
        c.chunks[index] = p;
      }
      waits.add(p);
    }
    return Promise.all(waits);
  }
}
