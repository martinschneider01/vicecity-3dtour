/**
 * Format of the converted assets, shared between the conversion (tools/) and
 * the viewer (src/). Any incompatible change must bump FORMAT_VERSION.
 */
export const FORMAT_VERSION = 7;

/** Render mode of a geometry batch. */
export const MODE = {
  /** Opaque, writes depth. */
  OPAQUE: 0,
  /** Alpha-tested cutout (foliage, fences), writes depth. */
  CUTOUT: 1,
  /** Regular sorted transparency; writes depth, as in the game. */
  BLEND: 2,
  /** Additive (halos, neon), no depth write. */
  ADDITIVE: 3,
  /** Transparency of an object fully underwater: drawn before the water surface. */
  BLEND_UNDERWATER: 4,
  /** Transparency without depth write (IDE flag 64: decals, shadows). */
  BLEND_NO_DEPTH: 5,
} as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

/** A batch is identified by its texture class and its mode. */
export function batchKey(texClass: number, mode: Mode): number {
  return texClass * 8 + mode;
}
export function batchKeyClass(key: number): number {
  return key >> 3;
}
export function batchKeyMode(key: number): Mode {
  return (key & 7) as Mode;
}

/** A KTX2 file (Basis Universal, ETC1S) holding a few consecutive layers of a class. */
export interface TexChunk {
  file: string;
  first: number;
  count: number;
}

export interface TexClass {
  /** Side length in pixels (square textures). */
  size: number;
  /** GPU format once transcoded: bc1 = opaque DXT1, bc3 = DXT5 with alpha. */
  fmt: 'bc1' | 'bc3';
  layers: number;
  /** Bytes per layer once transcoded (all mipmap levels included). */
  stride: number;
  chunks: TexChunk[];
}

export interface TileInfo {
  file: string;
  /** Bounding box of the instance origins (game coordinates, Z up). */
  min: [number, number, number];
  max: [number, number, number];
  /** Largest draw distance among the tile's instances. */
  far: number;
  count: number;
  bytes: number;
}

export interface BatchHeader {
  key: number;
  verts: number;
  indices: number;
  idx16: boolean;
  /** Byte offsets into the payload. */
  pos: number;
  uv: number;
  /** Prelit RGBA colours (already multiplied by the material colour). */
  col: number;
  /** Ambient light factor RGBX. */
  amb: number;
  lay: number;
  idx: number;
  /** Flattened sub-geometries: [firstVertex, vertexCount, firstIndex, indexCount] x n. */
  geoms: number[];
}

export interface TileModel {
  name: string;
  /** Draw distance (IDE). */
  far: number;
  /** Display hours for day/night objects, otherwise -1. */
  on: number;
  off: number;
  /** Flattened [batch, sub-geometry] pairs. */
  parts: number[];
}

/**
 * JSON header of a tile file. The gzip-compressed file is: 'VCT1' (4 bytes),
 * header length (uint32), JSON header padded with spaces to a multiple of 4,
 * then the binary payload.
 */
export interface TileHeader {
  batches: BatchHeader[];
  models: TileModel[];
  count: number;
  /** count x 7 float32: xyz position then xyzw quaternion (ready to use). */
  inst: number;
  /** count x uint16: index into models. */
  instModel: number;
  /**
   * count x float32: distance below which the instance (a LOD) gives way
   * to the detailed model; 0 for other instances.
   */
  near: number;
  /**
   * count x int16: for a LOD, the tile of its detailed model; HD_SAME_PACK
   * if it is in the same file; -1 otherwise.
   */
  hdTile: number;
  /** count x uint8: IPL area code (0 = outdoors, 13 = visible everywhere, otherwise an interior). */
  area: number;
  /** Required textures, flattened [class, layer] pairs. */
  tex: number[];
}

export const TILE_MAGIC = 0x31544356; // 'VCT1'
/** hdTile value: the detailed model is in the same file as its LOD. */
export const HD_SAME_PACK = -2;

export interface TimecycWeather {
  name: string;
  /** 24 rows (one per hour) of TIMECYC_COLUMNS numbers. */
  hours: number[][];
}

/** timecyc.dat columns (52 numbers per row). */
export const TC = {
  AMB: 0,
  AMB_OBJ: 3,
  AMB_BL: 6,
  AMB_OBJ_BL: 9,
  DIR: 12,
  SKY_TOP: 15,
  SKY_BOTTOM: 18,
  SUN_CORE: 21,
  SUN_CORONA: 24,
  SUN_SIZE: 27,
  SPRITE_SIZE: 28,
  SPRITE_BRIGHTNESS: 29,
  SHADOW: 30,
  LIGHT_SHADOW: 31,
  POLE_SHADOW: 32,
  FAR_CLIP: 33,
  FOG_START: 34,
  LIGHT_ON_GROUND: 35,
  LOW_CLOUDS: 36,
  TOP_CLOUDS: 39,
  BOTTOM_CLOUDS: 42,
  BLUR: 45,
  WATER: 48,
  COUNT: 52,
} as const;

export interface WaterData {
  /** Merged water rectangles: flattened [x0, y0, x1, y1, z]. */
  rects: number[];
  /** Rectangles without water (dry land): flattened [x0, y0, x1, y1]. */
  land: number[];
  /** Sea level, used for the ocean beyond the grid. */
  seaLevel: number;
  /** Extent of the game's water grid. */
  min: [number, number];
  max: [number, number];
  /** Surface texture (class and layer), if found. */
  tex: [number, number] | null;
}

export interface Teleport {
  id: string;
  label: string;
  /** Camera position (game coordinates). */
  pos: [number, number, number];
  /** Heading in degrees: 0 = north (+Y), 90 = east (+X). */
  yaw: number;
  /** Pitch in degrees, negative looking down. */
  pitch: number;
  /** Character arrival point in on-foot mode (above the ground), if different from pos. */
  foot?: [number, number, number];
}

export const PED_MAGIC = 0x31504356; // 'VCP1'

export interface PedBone {
  name: string;
  /** Index of the parent bone in the list, or -1 for the root. */
  parent: number;
  /** Local rest transform: position, then 3x3 matrix (basis vectors in sequence). */
  pos: number[];
  rot: number[];
}

export interface PedTrack {
  bone: number;
  count: number;
  /** Payload offsets: timestamps (float32), xyzw quaternions, xyz translations or -1. */
  times: number;
  rot: number;
  pos: number;
}

export interface PedClip {
  name: string;
  duration: number;
  tracks: PedTrack[];
}

/** Character file header (same container as tiles, PED_MAGIC signature). */
export interface PedHeader {
  verts: number;
  indices: number;
  pos: number;
  nrm: number;
  uv: number;
  /** 4 bone indices (uint8) and 4 weights (float32) per vertex. */
  skinIndex: number;
  skinWeight: number;
  idx: number;
  /** One 4x4 inverse matrix per bone (float32, column-major). */
  inverseBind: number;
  /** Texture: class and layer in the world's texture arrays. */
  tex: [number, number];
  bones: PedBone[];
  clips: PedClip[];
  /** Height of the lowest and highest vertex, in model space. */
  minZ: number;
  maxZ: number;
}

/** An enterable interior (area from the IPL "interior" field). */
export interface InteriorInfo {
  /** Game area code (1 = hotel, 2 = mansion...). */
  area: number;
  id: string;
  label: string;
  file: string;
  count: number;
  /** Position of the entrance marker, outside. */
  door: [number, number, number];
  /** Arrival point inside (on the ground) and view heading in degrees. */
  spawn: [number, number, number];
  yaw: number;
  /** Bounding box of the interior's instances. */
  min: [number, number, number];
  max: [number, number, number];
}

/** The game's radar map, assembled into a single image. */
export interface RadarInfo {
  file: string;
  size: number;
  /** World extent covered by the image: south-west and north-east corners. */
  min: [number, number];
  max: [number, number];
}

export interface Manifest {
  version: number;
  tileSize: number;
  tiles: TileInfo[];
  far: { file: string; count: number; bytes: number };
  interiors: InteriorInfo[];
  radar: RadarInfo | null;
  /** Character file (model, skeleton, animations), or null. */
  player: string | null;
  texClasses: TexClass[];
  timecyc: TimecycWeather[];
  water: WaterData;
  /** Extent of the placed instances. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  teleports: Teleport[];
  stats: Record<string, number>;
}
