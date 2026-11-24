/**
 * Converts a DFF model into ready-to-draw "parts": one part per
 * (texture class, render mode) pair. The texture layer index and the
 * material colour are carried by the vertices, so all materials of a
 * given class can be drawn in a single call.
 */
import { MODE, batchKey, type Mode } from '../../shared/format.ts';
import { IDE_FLAG, type ObjectDef } from './gamedata.ts';
import { GEOM, type DffClump } from './rw.ts';
import type { TexRef } from './textures.ts';

export interface ModelPart {
  key: number;
  positions: Float32Array;
  uvs: Float32Array;
  colors: Uint8Array;
  /** Per-vertex ambient light factor (material colour x ambient coefficient), RGBX. */
  ambient: Uint8Array;
  layers: Uint16Array;
  indices: Uint32Array;
}

export interface ConvertedModel {
  name: string;
  parts: ModelPart[];
  /** Textures used, as class * 65536 + layer. */
  textures: Set<number>;
  verts: number;
  tris: number;
  radius: number;
}

export interface ConvertContext {
  /** Returns a material's texture, or null if it cannot be found. */
  lookup(txd: string, texture: string): TexRef | null;
  white(): TexRef;
  /** True if every instance of the model is below the water surface (zMax = the model's highest vertex). */
  isUnderwater(def: ObjectDef, zMax: number): boolean;
  onMissingTexture(def: ObjectDef, texture: string): void;
  onNote(note: string): void;
}

/** Splits "name_L1" into (name, 1). "_dam" variants (damaged object) are flagged. */
function frameLod(name: string): { lod: number; damaged: boolean } {
  const lower = name.toLowerCase();
  if (lower.endsWith('_dam')) return { lod: 0, damaged: true };
  const m = /_l(\d)$/.exec(lower);
  return { lod: m ? Number(m[1]) : 0, damaged: false };
}

class PartBuilder {
  readonly key: number;
  positions: number[] = [];
  uvs: number[] = [];
  colors: number[] = [];
  ambient: number[] = [];
  layers: number[] = [];
  indices: number[] = [];
  /** (source vertex, material) -> vertex index in the part. */
  remap = new Map<number, number>();
  constructor(key: number) {
    this.key = key;
  }
}

export function convertModel(def: ObjectDef, clump: DffClump, ctx: ConvertContext): ConvertedModel {
  // The game sorts each atomic by the _L<n> suffix of its frame name and
  // ignores the frame transform. We keep only level 0 (the most detailed);
  // if there are several, the last one wins, as in the game.
  let chosen = -1;
  let chosenLod = 99;
  let sameLod = 0;
  clump.atomics.forEach((a, i) => {
    const { lod, damaged } = frameLod(clump.frames[a.frame]?.name ?? '');
    if (damaged) return;
    if (lod < chosenLod) {
      chosenLod = lod;
      chosen = i;
      sameLod = 1;
    } else if (lod === chosenLod) {
      chosen = i;
      sameLod++;
    }
  });
  if (chosen < 0) throw new Error('no usable atomic');
  if (sameLod > 1) ctx.onNote(`${def.name}: ${sameLod} atomics at the same level, keeping the last one`);

  const g = clump.geometries[clump.atomics[chosen].geometry];
  const modulate = (g.flags & GEOM.MODULATE) !== 0;
  // Ambient light only applies to lit geometries; IDE flag 32
  // ("ignore lighting": neons, night windows, light beams) removes it.
  const lit = (g.flags & GEOM.LIGHT) !== 0 && (def.flags & IDE_FLAG.IGNORE_LIGHTING) === 0;
  const additive = (def.flags & IDE_FLAG.ADDITIVE) !== 0;
  const noZWrite = (def.flags & IDE_FLAG.NO_ZWRITE) !== 0;

  // Vertex alpha per material: the slightest transparency forces blending.
  const matVertexAlpha = new Uint8Array(g.materials.length);
  if (g.colors) {
    for (let t = 0; t < g.numTris; t++) {
      const m = g.triMaterial[t];
      if (m >= g.materials.length || matVertexAlpha[m]) continue;
      for (let k = 0; k < 3; k++) {
        const v = g.indices[t * 3 + k];
        if (v < g.numVerts && g.colors[v * 4 + 3] < 250) matVertexAlpha[m] = 1;
      }
    }
  }

  let zMax = -Infinity;
  for (let i = 2; i < g.positions.length; i += 3) zMax = Math.max(zMax, g.positions[i]);
  const underwater = ctx.isUnderwater(def, zMax);

  const textures = new Set<number>();
  const matInfo = g.materials.map((mat, m) => {
    let ref: TexRef | null = null;
    if (mat.texture) {
      ref = ctx.lookup(def.txd, mat.texture);
      if (!ref) ctx.onMissingTexture(def, mat.texture);
    }
    if (!ref) ref = ctx.white();
    textures.add(ref.cls * 65536 + ref.layer);
    const color = modulate ? mat.color : [255, 255, 255, 255];
    let mode: Mode;
    if (additive) mode = MODE.ADDITIVE;
    else if (ref.alpha === 'graded' || color[3] < 250 || matVertexAlpha[m]) mode = MODE.BLEND;
    else if (ref.alpha === 'binary') mode = noZWrite ? MODE.BLEND : MODE.CUTOUT;
    else mode = MODE.OPAQUE;
    if (mode === MODE.BLEND) {
      if (underwater) mode = MODE.BLEND_UNDERWATER;
      else if (noZWrite) mode = MODE.BLEND_NO_DEPTH;
    }
    const amb = lit ? Math.min(1, Math.max(0, mat.ambient)) : 0;
    const ambient = [color[0] * amb, color[1] * amb, color[2] * amb].map((v) => Math.round(v));
    return { ref, color, ambient, key: batchKey(ref.cls, mode) };
  });

  const builders = new Map<number, PartBuilder>();
  let tris = 0;
  for (let t = 0; t < g.numTris; t++) {
    const m = g.triMaterial[t];
    const a = g.indices[t * 3];
    const b = g.indices[t * 3 + 1];
    const c = g.indices[t * 3 + 2];
    if (m >= matInfo.length || a >= g.numVerts || b >= g.numVerts || c >= g.numVerts) continue;
    const info = matInfo[m];
    let pb = builders.get(info.key);
    if (!pb) {
      pb = new PartBuilder(info.key);
      builders.set(info.key, pb);
    }
    for (const v of [a, b, c]) {
      const rk = v * matInfo.length + m;
      let idx = pb.remap.get(rk);
      if (idx === undefined) {
        idx = pb.positions.length / 3;
        pb.remap.set(rk, idx);
        pb.positions.push(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2]);
        if (g.uvs) pb.uvs.push(g.uvs[v * 2], g.uvs[v * 2 + 1]);
        else pb.uvs.push(0, 0);
        for (let k = 0; k < 4; k++) {
          const vc = g.colors ? g.colors[v * 4 + k] : 255;
          pb.colors.push(Math.round((vc * info.color[k]) / 255));
        }
        pb.ambient.push(info.ambient[0], info.ambient[1], info.ambient[2], 255);
        pb.layers.push(info.ref.layer);
      }
      pb.indices.push(idx);
    }
    tris++;
  }

  let radius = 0;
  let verts = 0;
  const parts: ModelPart[] = [];
  for (const pb of [...builders.values()].sort((x, y) => x.key - y.key)) {
    for (let i = 0; i < pb.positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot(pb.positions[i], pb.positions[i + 1], pb.positions[i + 2]));
    }
    verts += pb.positions.length / 3;
    parts.push({
      key: pb.key,
      positions: new Float32Array(pb.positions),
      uvs: new Float32Array(pb.uvs),
      colors: new Uint8Array(pb.colors),
      ambient: new Uint8Array(pb.ambient),
      layers: new Uint16Array(pb.layers),
      indices: new Uint32Array(pb.indices),
    });
  }
  return { name: def.name, parts, textures, verts, tris, radius };
}
