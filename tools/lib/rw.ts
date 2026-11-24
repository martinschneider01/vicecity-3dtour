/**
 * Reads the RenderWare 3.x binary format ("RW stream") as used by
 * GTA: Vice City on PC: DFF models (clump) and TXD texture dictionaries
 * (Direct3D 8 native rasters).
 *
 * An RW stream is a tree of chunks. Each chunk starts with 12 bytes:
 * type (uint32), content size (uint32), version ID (uint32).
 */
import { Reader } from './binary.ts';

export const RW = {
  STRUCT: 0x01,
  STRING: 0x02,
  EXTENSION: 0x03,
  TEXTURE: 0x06,
  MATERIAL: 0x07,
  MATERIAL_LIST: 0x08,
  FRAME_LIST: 0x0e,
  GEOMETRY: 0x0f,
  CLUMP: 0x10,
  ATOMIC: 0x14,
  TEXTURE_NATIVE: 0x15,
  TEXTURE_DICTIONARY: 0x16,
  GEOMETRY_LIST: 0x1a,
  SKIN: 0x0116,
  HANIM: 0x011e,
  NODE_NAME: 0x0253f2fe,
} as const;

interface Chunk {
  type: number;
  size: number;
  version: number;
  /** Position of the first content byte. */
  start: number;
  /** Position just past the content. */
  end: number;
}

function unpackVersion(libId: number): number {
  if (libId & 0xffff0000) {
    return (((libId >>> 14) & 0x3ff00) + 0x30000) | ((libId >>> 16) & 0x3f);
  }
  return libId << 8;
}

function readChunk(r: Reader): Chunk {
  const type = r.u32();
  const size = r.u32();
  const version = unpackVersion(r.u32());
  return { type, size, version, start: r.pos, end: r.pos + size };
}

function expectChunk(r: Reader, type: number): Chunk {
  const c = readChunk(r);
  if (c.type !== type) {
    throw new Error(
      `unexpected RW chunk 0x${c.type.toString(16)} at ${c.start - 12} (expected 0x${type.toString(16)})`,
    );
  }
  return c;
}

/* ------------------------------------------------------------------ DFF */

export const GEOM = {
  TRISTRIP: 0x01,
  POSITIONS: 0x02,
  TEXTURED: 0x04,
  PRELIT: 0x08,
  NORMALS: 0x10,
  LIGHT: 0x20,
  MODULATE: 0x40,
  TEXTURED2: 0x80,
  NATIVE: 0x01000000,
} as const;

export interface DffMaterial {
  /** RGBA colour 0..255. */
  color: [number, number, number, number];
  /** Texture name (original case) or null. */
  texture: string | null;
  mask: string | null;
  /** Ambient coefficient from the surface properties (usually 1). */
  ambient: number;
}

export interface DffGeometry {
  flags: number;
  numVerts: number;
  numTris: number;
  positions: Float32Array;
  /** Prelit RGBA colours, 4 bytes per vertex, or null. */
  colors: Uint8Array | null;
  /** First texture coordinate set, or null. */
  uvs: Float32Array | null;
  /** Vertex indices, 3 per triangle. */
  indices: Uint16Array;
  /** Material index per triangle. */
  triMaterial: Uint16Array;
  materials: DffMaterial[];
  /** Bounding sphere x, y, z, radius. */
  sphere: [number, number, number, number];
  /** Normals (lit models: characters), or null. */
  normals: Float32Array | null;
  /** Skin data (characters), or null. */
  skin: DffSkin | null;
}

export interface DffSkin {
  numBones: number;
  /** 4 bone indices per vertex. */
  boneIndices: Uint8Array;
  /** 4 weights per vertex. */
  weights: Float32Array;
  /** One 4x4 inverse matrix per bone, 16 floats, basis vectors as rows (RenderWare convention). */
  inverseBind: Float32Array;
}

export interface DffFrame {
  name: string;
  parent: number;
  rot: Float32Array;
  pos: Float32Array;
  /** HAnim bone ID, or -1. */
  boneId: number;
  /** On the skeleton's root frame: bone IDs, in skin order. */
  boneOrder: number[] | null;
}

export interface DffAtomic {
  frame: number;
  geometry: number;
  flags: number;
}

export interface DffClump {
  version: number;
  frames: DffFrame[];
  geometries: DffGeometry[];
  atomics: DffAtomic[];
}

function readString(r: Reader): string {
  const c = expectChunk(r, RW.STRING);
  const s = r.fixedString(c.size);
  r.pos = c.end;
  return s;
}

function readMaterial(r: Reader): DffMaterial {
  const mat = expectChunk(r, RW.MATERIAL);
  const st = expectChunk(r, RW.STRUCT);
  r.u32(); // flags, unused
  const color: [number, number, number, number] = [r.u8(), r.u8(), r.u8(), r.u8()];
  r.u32(); // unused
  const textured = r.u32() !== 0;
  // RW > 3.0.4: surface properties (ambient, specular, diffuse).
  const ambient = st.end - r.pos >= 12 ? r.f32() : 1;
  r.pos = st.end;
  let texture: string | null = null;
  let mask: string | null = null;
  if (textured) {
    const tex = expectChunk(r, RW.TEXTURE);
    const ts = expectChunk(r, RW.STRUCT);
    r.pos = ts.end;
    texture = readString(r) || null;
    mask = readString(r) || null;
    r.pos = tex.end;
  }
  r.pos = mat.end;
  return { color, texture, mask, ambient };
}

/** Skin plugin: per-vertex bones and weights, inverse matrices of the bind pose. */
function readSkin(r: Reader, numVerts: number): DffSkin {
  const numBones = r.u8();
  const numUsedBones = r.u8();
  r.skip(2);
  // Old format (RW 3.4 and earlier): no used-bones list, 4 bytes before each matrix.
  const oldFormat = numUsedBones === 0;
  if (!oldFormat) r.skip(numUsedBones);
  const boneIndices = new Uint8Array(r.bytes(numVerts * 4));
  const weights = r.f32Array(numVerts * 4);
  const inverseBind = new Float32Array(numBones * 16);
  for (let b = 0; b < numBones; b++) {
    if (oldFormat) r.skip(4);
    inverseBind.set(r.f32Array(16), b * 16);
  }
  return { numBones, boneIndices, weights, inverseBind };
}

function readGeometry(r: Reader): DffGeometry {
  const geo = expectChunk(r, RW.GEOMETRY);
  const st = expectChunk(r, RW.STRUCT);

  const parse = (withSurfaceProps: boolean): Omit<DffGeometry, 'materials' | 'skin'> => {
    r.pos = st.start;
    const flags = r.u32();
    const numTris = r.u32();
    const numVerts = r.u32();
    const numMorph = r.u32();
    if (withSurfaceProps) r.skip(12);
    let numUv = (flags >>> 16) & 0xff;
    if (numUv === 0) numUv = flags & GEOM.TEXTURED2 ? 2 : flags & GEOM.TEXTURED ? 1 : 0;

    let colors: Uint8Array | null = null;
    let uvs: Float32Array | null = null;
    const indices = new Uint16Array(numTris * 3);
    const triMaterial = new Uint16Array(numTris);
    if (!(flags & GEOM.NATIVE)) {
      if (flags & GEOM.PRELIT) colors = new Uint8Array(r.bytes(numVerts * 4));
      for (let s = 0; s < numUv; s++) {
        const set = r.f32Array(numVerts * 2);
        if (s === 0) uvs = set;
      }
      // On disk a triangle is (vertex2, vertex1, material, vertex3).
      for (let t = 0; t < numTris; t++) {
        const v2 = r.u16();
        const v1 = r.u16();
        triMaterial[t] = r.u16();
        const v3 = r.u16();
        indices[t * 3] = v1;
        indices[t * 3 + 1] = v2;
        indices[t * 3 + 2] = v3;
      }
    }
    let positions: Float32Array = new Float32Array(0);
    let normals: Float32Array | null = null;
    let sphere: [number, number, number, number] = [0, 0, 0, 0];
    for (let m = 0; m < numMorph; m++) {
      const s: [number, number, number, number] = [r.f32(), r.f32(), r.f32(), r.f32()];
      const hasVerts = r.u32() !== 0;
      const hasNormals = r.u32() !== 0;
      const p = hasVerts ? r.f32Array(numVerts * 3) : null;
      const n = hasNormals ? r.f32Array(numVerts * 3) : null;
      if (m === 0) normals = n;
      if (m === 0) {
        sphere = s;
        if (p) positions = p;
      }
    }
    return { flags, numVerts, numTris, positions, colors, uvs, indices, triMaterial, sphere, normals };
  };

  // RW < 3.4 also stores 3 floats (ambient, specular, diffuse). We go by the
  // version, then check that we land exactly on the end of the chunk.
  let body: Omit<DffGeometry, 'materials' | 'skin'> | null = null;
  const guess = st.version < 0x34000;
  for (const withProps of [guess, !guess]) {
    try {
      const b = parse(withProps);
      if (r.pos === st.end) {
        body = b;
        break;
      }
    } catch {
      /* out-of-bounds read: try the other layout */
    }
  }
  if (!body) throw new Error('inconsistent geometry structure');
  r.pos = st.end;

  const ml = expectChunk(r, RW.MATERIAL_LIST);
  const mls = expectChunk(r, RW.STRUCT);
  const numMat = r.u32();
  const refs: number[] = [];
  for (let i = 0; i < numMat; i++) refs.push(r.i32());
  r.pos = mls.end;
  const materials: DffMaterial[] = [];
  for (let i = 0; i < numMat; i++) {
    // -1: material defined here; otherwise it reuses an earlier one.
    if (refs[i] < 0) materials.push(readMaterial(r));
    else materials.push(materials[refs[i]]);
  }
  r.pos = ml.end;
  // Geometry extension: we only read the character skin from it.
  let skin: DffSkin | null = null;
  if (r.pos + 12 <= geo.end) {
    const ext = readChunk(r);
    if (ext.type === RW.EXTENSION) {
      while (r.pos + 12 <= ext.end) {
        const c = readChunk(r);
        if (c.type === RW.SKIN) skin = readSkin(r, body.numVerts);
        r.pos = c.end;
      }
    }
  }
  r.pos = geo.end;
  return { ...body, materials, skin };
}

/** Reads the first clump of a DFF file. */
export function parseDff(buf: Buffer): DffClump {
  const r = new Reader(buf);
  let clump: Chunk | null = null;
  while (r.remaining >= 12) {
    const c = readChunk(r);
    if (c.type === RW.CLUMP) {
      clump = c;
      break;
    }
    if (c.type === 0 || c.end > buf.length) break;
    r.pos = c.end;
  }
  if (!clump) throw new Error('no clump in the DFF');

  const st = expectChunk(r, RW.STRUCT);
  const numAtomics = r.u32();
  r.pos = st.end;

  const fl = expectChunk(r, RW.FRAME_LIST);
  const fls = expectChunk(r, RW.STRUCT);
  const numFrames = r.u32();
  const frames: DffFrame[] = [];
  for (let i = 0; i < numFrames; i++) {
    const rot = r.f32Array(9);
    const pos = r.f32Array(3);
    const parent = r.i32();
    r.u32();
    frames.push({ name: '', parent, rot, pos, boneId: -1, boneOrder: null });
  }
  r.pos = fls.end;
  for (let i = 0; i < numFrames && r.pos < fl.end; i++) {
    const ext = expectChunk(r, RW.EXTENSION);
    while (r.pos < ext.end) {
      const c = readChunk(r);
      if (c.type === RW.NODE_NAME) frames[i].name = r.fixedString(c.size);
      else if (c.type === RW.HANIM) {
        r.u32(); // plugin version
        frames[i].boneId = r.i32();
        const numNodes = r.u32();
        if (numNodes > 0) {
          r.skip(8); // flags, keyframe size
          const order: number[] = [];
          for (let k = 0; k < numNodes; k++) {
            order.push(r.i32());
            r.skip(8); // index, flags
          }
          frames[i].boneOrder = order;
        }
      }
      r.pos = c.end;
    }
    r.pos = ext.end;
  }
  r.pos = fl.end;

  const gl = expectChunk(r, RW.GEOMETRY_LIST);
  const gls = expectChunk(r, RW.STRUCT);
  const numGeom = r.u32();
  r.pos = gls.end;
  const geometries: DffGeometry[] = [];
  for (let i = 0; i < numGeom; i++) geometries.push(readGeometry(r));
  r.pos = gl.end;

  const atomics: DffAtomic[] = [];
  for (let i = 0; i < numAtomics; i++) {
    // Light/camera chunks may be interleaved: skip them.
    let c = readChunk(r);
    while (c.type !== RW.ATOMIC) {
      r.pos = c.end;
      if (r.pos >= clump.end) return { version: clump.version, frames, geometries, atomics };
      c = readChunk(r);
    }
    const as = expectChunk(r, RW.STRUCT);
    const frame = r.u32();
    const geometry = r.u32();
    const flags = r.u32();
    r.pos = as.end;
    r.pos = c.end;
    atomics.push({ frame, geometry, flags });
  }
  return { version: clump.version, frames, geometries, atomics };
}

/* ------------------------------------------------------------------ TXD */

export const RASTER = {
  FORMAT_MASK: 0x0f00,
  F1555: 0x0100,
  F565: 0x0200,
  F4444: 0x0300,
  LUM8: 0x0400,
  F8888: 0x0500,
  F888: 0x0600,
  F555: 0x0a00,
  PAL8: 0x2000,
  PAL4: 0x4000,
} as const;

export interface TxdTexture {
  name: string;
  mask: string;
  width: number;
  height: number;
  depth: number;
  rasterFormat: number;
  /** 0 = uncompressed, 1 = DXT1, 3 = DXT3, 5 = DXT5. */
  compression: number;
  hasAlphaFlag: boolean;
  filter: number;
  addressU: number;
  addressV: number;
  /** RGBA palette (256 or 16 entries) for palettized textures. */
  palette: Buffer | null;
  /** Raw data of each mipmap level, from largest to smallest. */
  levels: Buffer[];
}

export function parseTxd(buf: Buffer): TxdTexture[] {
  const r = new Reader(buf);
  const dict = expectChunk(r, RW.TEXTURE_DICTIONARY);
  const st = expectChunk(r, RW.STRUCT);
  const count = r.u16();
  r.pos = st.end;
  const out: TxdTexture[] = [];
  for (let i = 0; i < count && r.pos < dict.end; i++) {
    const tn = expectChunk(r, RW.TEXTURE_NATIVE);
    const s = expectChunk(r, RW.STRUCT);
    const platform = r.u32();
    if (platform !== 8 && platform !== 9) {
      throw new Error(`native texture: unsupported platform ${platform}`);
    }
    const filter = r.u8();
    const addressing = r.u8();
    r.skip(2);
    const name = r.fixedString(32);
    const mask = r.fixedString(32);
    const rasterFormat = r.u32();
    const alphaOrFourCC = r.u32();
    const width = r.u16();
    const height = r.u16();
    const depth = r.u8();
    const numLevels = r.u8();
    r.u8(); // raster type
    const compByte = r.u8();
    let compression = 0;
    let hasAlphaFlag = false;
    if (platform === 8) {
      compression = compByte;
      hasAlphaFlag = alphaOrFourCC !== 0;
    } else {
      // Direct3D 9 (San Andreas): the field is a D3D format, possibly a FourCC.
      hasAlphaFlag = (compByte & 1) !== 0;
      if (alphaOrFourCC === 0x31545844) compression = 1;
      else if (alphaOrFourCC === 0x33545844) compression = 3;
      else if (alphaOrFourCC === 0x35545844) compression = 5;
    }
    let palette: Buffer | null = null;
    if (rasterFormat & RASTER.PAL8) palette = r.bytes(256 * 4);
    else if (rasterFormat & RASTER.PAL4) palette = r.bytes(depth === 4 ? 16 * 4 : 256 * 4);
    const levels: Buffer[] = [];
    for (let l = 0; l < numLevels && r.pos + 4 <= s.end; l++) {
      const size = r.u32();
      levels.push(r.bytes(size));
    }
    r.pos = tn.end;
    out.push({
      name,
      mask,
      width,
      height,
      depth,
      rasterFormat,
      compression,
      hasAlphaFlag,
      filter,
      addressU: addressing & 0x0f,
      addressV: addressing >> 4,
      palette,
      levels,
    });
  }
  return out;
}
