/**
 * Texture store for the conversion.
 *
 * Game textures are sorted into "classes": all textures in a class have the
 * same (square) size and the same GPU format (opaque BC1 or BC3 with alpha),
 * which lets the viewer load a class as a single texture array and draw a
 * large number of materials in one call.
 *
 * On disk, textures are lossily recompressed with Basis Universal (ETC1S, in
 * KTX2 files): three to ten times smaller than the original DXT blocks. The
 * viewer transcodes them to BC1/BC3 on load. Each class is split into small
 * files of a few layers: ETC1S shares one block palette per file, and quality
 * collapses if too many different textures share it.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeDxt, layerByteLength } from '../../shared/dxt.ts';
import type { TexChunk, TexClass } from '../../shared/format.ts';
import { ROOT } from './paths.ts';
import { writePng } from './png.ts';
import { RASTER, type TxdTexture } from './rw.ts';

export type AlphaKind = 'opaque' | 'binary' | 'graded';

export interface TexRef {
  /** Class index. */
  cls: number;
  /** Layer index within the class. */
  layer: number;
  alpha: AlphaKind;
}

/** Maximum number of layers per texture array (common GPU limit: 2048). */
const MAX_LAYERS = 1024;
const MIN_SIZE = 32;
/**
 * ETC1S quality, from 1 to 255. 192 cuts texture size by 3 to 4x with no
 * noticeable degradation on these 2002-era textures; VC_TEXTURE_QUALITY overrides it.
 */
const QUALITY = Math.max(1, Math.min(255, Number(process.env.VC_TEXTURE_QUALITY) || 192));
/** 4x4 blocks per file: 16 layers of 256 pixels, 64 of 128, 256 of 64... */
const CHUNK_BLOCKS = 65536;
const BASISU = path.join(ROOT, 'node_modules', 'basis_universal', 'bin', process.platform === 'win32' ? 'basisu.exe' : 'basisu');
const CACHE_DIR = path.join(ROOT, '.cache', 'basis');

interface OpenClass {
  size: number;
  fmt: 'bc1' | 'bc3';
  /** Content hash of each layer, for the encoding cache. */
  hashes: string[];
  dir: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`basisu failed (code ${code}) ${err.slice(0, 300)}`))));
  });
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Decodes level 0 of a native texture to RGBA. */
export function decodeTexture(tex: TxdTexture): Uint8Array {
  const { width: w, height: h } = tex;
  const src = tex.levels[0];
  const fmt = tex.rasterFormat & RASTER.FORMAT_MASK;
  const formatHasAlpha = fmt === RASTER.F8888 || fmt === RASTER.F1555 || fmt === RASTER.F4444;
  let out: Uint8Array;
  if (tex.compression === 1 || tex.compression === 3 || tex.compression === 5) {
    out = decodeDxt(src, w, h, tex.compression);
  } else if (tex.palette) {
    out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const p = src[i] * 4;
      out[i * 4] = tex.palette[p];
      out[i * 4 + 1] = tex.palette[p + 1];
      out[i * 4 + 2] = tex.palette[p + 2];
      out[i * 4 + 3] = tex.palette[p + 3];
    }
  } else if (tex.depth === 32) {
    out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = src[i * 4 + 2];
      out[i * 4 + 1] = src[i * 4 + 1];
      out[i * 4 + 2] = src[i * 4];
      out[i * 4 + 3] = src[i * 4 + 3];
    }
  } else if (tex.depth === 16) {
    out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = src[i * 2] | (src[i * 2 + 1] << 8);
      let r: number, g: number, b: number, a = 255;
      if (fmt === RASTER.F565) {
        r = ((v >> 11) & 31) * 255 / 31; g = ((v >> 5) & 63) * 255 / 63; b = (v & 31) * 255 / 31;
      } else if (fmt === RASTER.F4444) {
        a = ((v >> 12) & 15) * 17; r = ((v >> 8) & 15) * 17; g = ((v >> 4) & 15) * 17; b = (v & 15) * 17;
      } else {
        a = fmt === RASTER.F1555 ? (v >> 15) * 255 : 255;
        r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31;
      }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = a;
    }
  } else if (tex.depth === 8) {
    // Luminance
    out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = src[i];
      out[i * 4 + 3] = 255;
    }
  } else {
    throw new Error(`unsupported raster format: 0x${tex.rasterFormat.toString(16)} depth ${tex.depth}`);
  }
  if (!formatHasAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/**
 * Classifies an image's alpha:
 *  - opaque;
 *  - "binary": a cut-out shape (foliage, fencing, cables, sign), i.e. an
 *    image with both truly transparent and truly opaque areas; rendered as
 *    cutout, without sorting;
 *  - "graded": a translucent material (glass: no transparent area) or a
 *    veil (shadow, grime, halo: no opaque area); rendered with sorted
 *    transparency.
 */
export function classifyAlpha(rgba: Uint8Array): AlphaKind {
  let transparent = 0;
  let mid = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const a = rgba[i];
    if (a < 24) transparent++;
    else if (a < 232) mid++;
  }
  if (transparent + mid === 0) return 'opaque';
  const n = rgba.length / 4;
  const opaque = n - transparent - mid;
  return transparent / n >= 0.04 && opaque / n >= 0.02 ? 'binary' : 'graded';
}

function resizeNearest(src: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const s = (sy * w + sx) * 4;
      const d = (y * nw + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return out;
}

export class TextureStore {
  private readonly classes: OpenClass[] = [];
  private readonly byHash = new Map<string, TexRef>();
  private readonly outDir: string;
  private readonly tmpDir: string;
  private whiteRef: TexRef | null = null;
  stats = { unique: 0, duplicates: 0, resized: 0, bytes: 0, encoded: 0, cached: 0 };

  /** outDir: texture file folder (public/assets/tex during the conversion). */
  constructor(outDir: string) {
    this.outDir = outDir;
    this.tmpDir = path.join(ROOT, '.cache', 'tex-tmp');
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  /** Stores a square RGBA image in the right class; encoding happens in finish(). */
  private allocate(size: number, fmt: 'bc1' | 'bc3', rgba: Uint8Array): { cls: number; layer: number } {
    let idx = this.classes.findIndex((c) => c.size === size && c.fmt === fmt && c.hashes.length < MAX_LAYERS);
    if (idx < 0) {
      idx = this.classes.length;
      const dir = path.join(this.tmpDir, String(idx));
      fs.mkdirSync(dir, { recursive: true });
      this.classes.push({ size, fmt, hashes: [], dir });
    }
    const c = this.classes[idx];
    const layer = c.hashes.length;
    writePng(path.join(c.dir, `${layer}.png`), rgba, size, size, 1);
    c.hashes.push(crypto.createHash('sha1').update(rgba).digest('hex'));
    return { cls: idx, layer };
  }

  /** White texture for untextured materials. */
  white(): TexRef {
    if (!this.whiteRef) {
      const { cls, layer } = this.allocate(MIN_SIZE, 'bc1', new Uint8Array(MIN_SIZE * MIN_SIZE * 4).fill(255));
      this.whiteRef = { cls, layer, alpha: 'opaque' };
    }
    return this.whiteRef;
  }

  add(tex: TxdTexture): TexRef {
    const hash = crypto
      .createHash('sha1')
      .update(`${tex.width}x${tex.height}/${tex.compression}/${tex.rasterFormat}/`)
      .update(tex.levels[0])
      .update(tex.palette ?? Buffer.alloc(0))
      .digest('hex');
    const hit = this.byHash.get(hash);
    if (hit) {
      this.stats.duplicates++;
      return hit;
    }
    const { width: w, height: h } = tex;
    let rgba = decodeTexture(tex);
    const alpha = classifyAlpha(rgba);
    const size = Math.max(MIN_SIZE, nextPow2(Math.max(w, h)));
    if (w !== size || h !== size) {
      // Non-square textures are stretched: since texture coordinates are relative, nothing changes on screen.
      rgba = resizeNearest(rgba, w, h, size, size);
      this.stats.resized++;
    }
    const { cls, layer } = this.allocate(size, alpha === 'opaque' ? 'bc1' : 'bc3', rgba);
    const ref: TexRef = { cls, layer, alpha };
    this.byHash.set(hash, ref);
    this.stats.unique++;
    return ref;
  }

  /**
   * Encodes all classes and returns their description. Files already encoded
   * with the same content and settings are reused from the cache
   * (.cache/basis), which makes later conversions fast.
   */
  async finish(): Promise<TexClass[]> {
    interface Job {
      cls: OpenClass;
      first: number;
      count: number;
      file: string;
    }
    const jobs: Job[] = [];
    const out: TexClass[] = this.classes.map((c, ci) => {
      const perChunk = Math.max(1, Math.floor(CHUNK_BLOCKS / (c.size / 4) ** 2));
      const chunks: TexChunk[] = [];
      for (let first = 0; first < c.hashes.length; first += perChunk) {
        const count = Math.min(perChunk, c.hashes.length - first);
        const file = `tex/${c.size}_${c.fmt}_${ci}_${chunks.length}.ktx2`;
        chunks.push({ file, first, count });
        jobs.push({ cls: c, first, count, file });
      }
      return { size: c.size, fmt: c.fmt, layers: c.hashes.length, stride: layerByteLength(c.size, c.fmt === 'bc1' ? 8 : 16), chunks };
    });

    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const { cls } = job;
        const args = [
          '-ktx2', '-tex_type', '2darray', '-mipmap', '-q', String(QUALITY), '-comp_level', '2',
          cls.fmt === 'bc1' ? '-no_alpha' : '-force_alpha',
        ];
        const key = crypto
          .createHash('sha1')
          .update(`${args.join(' ')}/${cls.size}/`)
          .update(cls.hashes.slice(job.first, job.first + job.count).join(','))
          .digest('hex');
        const cached = path.join(CACHE_DIR, `${key}.ktx2`);
        if (fs.existsSync(cached)) this.stats.cached++;
        else {
          const tmp = path.join(cls.dir, `${job.first}.ktx2`);
          await run(
            BASISU,
            [...args, '-multifile_printf', '%u.png', '-multifile_first', String(job.first), '-multifile_num', String(job.count), '-output_file', tmp],
            cls.dir,
          );
          fs.renameSync(tmp, cached);
          this.stats.encoded++;
        }
        const dest = path.join(this.outDir, path.basename(job.file));
        fs.copyFileSync(cached, dest);
        this.stats.bytes += fs.statSync(dest).size;
      }
    };
    if (jobs.length && !fs.existsSync(BASISU)) throw new Error(`encoder not found: ${BASISU} (npm install)`);
    await Promise.all(Array.from({ length: Math.max(2, Math.min(8, os.cpus().length >> 1)) }, worker));
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
    return out;
  }
}
