/**
 * Texture transcoding worker.
 *
 * Receives a KTX2 file (Basis Universal, ETC1S) holding a few layers of a
 * texture class, and returns those layers transcoded to the GPU format (BC1
 * or BC3, or RGBA if the GPU lacks S3TC), one after another, each with all
 * of its mipmap levels. The work runs off the main thread so rendering
 * doesn't stutter.
 *
 * The transcoder is the one shipped with three.js (WebAssembly).
 */
import transcoderSource from 'three/examples/jsm/libs/basis/basis_transcoder.js?raw';
import transcoderWasm from 'three/examples/jsm/libs/basis/basis_transcoder.wasm?url';

export interface TranscodeRequest {
  id: number;
  buffer: ArrayBuffer;
  /** Expected texture side length and layer count. */
  size: number;
  count: number;
  format: 'bc1' | 'bc3' | 'rgba';
}

export interface TranscodeResponse {
  id: number;
  /** count layers back to back; absent on error. */
  data?: Uint8Array;
  error?: string;
}

/** Basis transcoder output formats. */
const FORMAT = { bc1: 2, bc3: 3, rgba: 13 } as const;

interface Ktx2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLayers(): number;
  getLevels(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, flags: number, a: number, b: number): boolean;
  close(): void;
  delete(): void;
}
interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => Ktx2File;
}

let modulePromise: Promise<BasisModule> | null = null;
function loadModule(): Promise<BasisModule> {
  modulePromise ??= (async () => {
    const wasmBinary = await (await fetch(transcoderWasm)).arrayBuffer();
    // The transcoder file declares a global BASIS function (it is not a module).
    const factory = new Function(`${transcoderSource}\nreturn BASIS;`)() as (m: object) => unknown;
    const mod = await new Promise<BasisModule>((resolve) => {
      const m = { wasmBinary, onRuntimeInitialized: () => resolve(m as unknown as BasisModule) };
      factory(m);
    });
    mod.initializeBasis();
    return mod;
  })();
  return modulePromise;
}

async function transcode(req: TranscodeRequest): Promise<Uint8Array> {
  const mod = await loadModule();
  const file = new mod.KTX2File(new Uint8Array(req.buffer));
  try {
    if (!file.isValid()) throw new Error('invalid KTX2 file');
    const layers = Math.max(1, file.getLayers());
    const levels = file.getLevels();
    if (file.getWidth() !== req.size || file.getHeight() !== req.size || layers !== req.count) {
      throw new Error(`unexpected KTX2: ${file.getWidth()}x${file.getHeight()}, ${layers} layers`);
    }
    if (!file.startTranscoding()) throw new Error('transcoding failed');
    const format = FORMAT[req.format];
    const sizes: number[] = [];
    let stride = 0;
    for (let level = 0; level < levels; level++) {
      sizes.push(file.getImageTranscodedSizeInBytes(level, 0, 0, format));
      stride += sizes[level];
    }
    const out = new Uint8Array(stride * layers);
    let offset = 0;
    for (let layer = 0; layer < layers; layer++) {
      for (let level = 0; level < levels; level++) {
        const dst = new Uint8Array(sizes[level]);
        if (!file.transcodeImage(dst, level, layer, 0, format, 0, -1, -1)) throw new Error(`layer ${layer}, level ${level}: failed`);
        out.set(dst, offset);
        offset += sizes[level];
      }
    }
    return out;
  } finally {
    file.close();
    file.delete();
  }
}

self.onmessage = (e: MessageEvent<TranscodeRequest>) => {
  const req = e.data;
  transcode(req).then(
    (data) => (self as unknown as Worker).postMessage({ id: req.id, data } satisfies TranscodeResponse, [data.buffer]),
    (err: Error) => (self as unknown as Worker).postMessage({ id: req.id, error: err.message } satisfies TranscodeResponse),
  );
};
