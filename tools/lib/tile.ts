/** Writes a tile file (see shared/format.ts for the layout). */
import { TILE_MAGIC, type BatchHeader, type TileHeader, type TileModel } from '../../shared/format.ts';
import type { ObjectDef } from './gamedata.ts';
import type { ConvertedModel } from './model.ts';

export interface PlacedInstance {
  def: ObjectDef;
  model: ConvertedModel;
  pos: [number, number, number];
  /** Final quaternion x, y, z, w. */
  quat: [number, number, number, number];
  /** The model's draw distance. */
  far: number;
  /** For a LOD: distance below which it fades out; 0 otherwise. */
  near: number;
  /** For a LOD: tile of the matching detailed model, HD_SAME_PACK, or -1. */
  hdTile: number;
  /** IPL area code (0 = exterior, 13 = visible everywhere, otherwise an interior). */
  area: number;
}

/** Accumulates 4-byte-aligned buffers and returns the offset of each. */
export class Payload {
  chunks: Buffer[] = [];
  length = 0;
  add(view: ArrayBufferView): number {
    const off = this.length;
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    this.chunks.push(buf);
    this.length += buf.length;
    const pad = (4 - (this.length & 3)) & 3;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.length += pad;
    }
    return off;
  }
}

/**
 * time: display hours forced on some models (LODs inheriting the hours of
 * their day/night detailed model).
 */
export function buildTile(instances: PlacedInstance[], time?: Map<ObjectDef, [number, number]>): Buffer {
  const models: ConvertedModel[] = [];
  const modelIndex = new Map<ConvertedModel, number>();
  const modelDef: ObjectDef[] = [];
  for (const inst of instances) {
    if (!modelIndex.has(inst.model)) {
      modelIndex.set(inst.model, models.length);
      models.push(inst.model);
      modelDef.push(inst.def);
    }
  }
  if (models.length > 65535) throw new Error('too many models in one tile');

  // Group the parts of all models by batch.
  const keys = [...new Set(models.flatMap((m) => m.parts.map((p) => p.key)))].sort((a, b) => a - b);
  const batchOf = new Map(keys.map((k, i) => [k, i]));
  const acc = keys.map(() => ({ verts: 0, indices: 0, geoms: [] as number[], parts: [] as ConvertedModel['parts'], max: 0 }));
  const tileModels: TileModel[] = models.map((m, mi) => {
    const parts: number[] = [];
    for (const p of m.parts) {
      const b = batchOf.get(p.key)!;
      const a = acc[b];
      const vCount = p.positions.length / 3;
      parts.push(b, a.geoms.length / 4);
      a.geoms.push(a.verts, vCount, a.indices, p.indices.length);
      a.verts += vCount;
      a.indices += p.indices.length;
      a.max = Math.max(a.max, vCount);
      a.parts.push(p);
    }
    const d = modelDef[mi];
    const [on, off] = time?.get(d) ?? [d.timeOn ?? -1, d.timeOff ?? -1];
    return { name: m.name, far: Math.max(...d.drawDists), on, off, parts };
  });

  const payload = new Payload();
  const batches: BatchHeader[] = keys.map((key, b) => {
    const a = acc[b];
    const pos = new Float32Array(a.verts * 3);
    const uv = new Float32Array(a.verts * 2);
    const col = new Uint8Array(a.verts * 4);
    const amb = new Uint8Array(a.verts * 4);
    const lay = new Uint16Array(a.verts);
    const idx16 = a.max <= 65535;
    const idx = idx16 ? new Uint16Array(a.indices) : new Uint32Array(a.indices);
    let v = 0;
    let i = 0;
    for (const p of a.parts) {
      pos.set(p.positions, v * 3);
      uv.set(p.uvs, v * 2);
      col.set(p.colors, v * 4);
      amb.set(p.ambient, v * 4);
      lay.set(p.layers, v);
      idx.set(p.indices, i);
      v += p.positions.length / 3;
      i += p.indices.length;
    }
    return {
      key,
      verts: a.verts,
      indices: a.indices,
      idx16,
      pos: payload.add(pos),
      uv: payload.add(uv),
      col: payload.add(col),
      amb: payload.add(amb),
      lay: payload.add(lay),
      idx: payload.add(idx),
      geoms: a.geoms,
    };
  });

  const n = instances.length;
  const inst = new Float32Array(n * 7);
  const instModel = new Uint16Array(n);
  const near = new Float32Array(n);
  const hdTile = new Int16Array(n);
  const area = new Uint8Array(n);
  instances.forEach((it, i) => {
    inst.set(it.pos, i * 7);
    inst.set(it.quat, i * 7 + 3);
    instModel[i] = modelIndex.get(it.model)!;
    near[i] = it.near;
    hdTile[i] = it.hdTile;
    area[i] = it.area;
  });

  const tex = new Set<number>();
  for (const m of models) for (const t of m.textures) tex.add(t);
  const header: TileHeader = {
    batches,
    models: tileModels,
    count: n,
    inst: payload.add(inst),
    instModel: payload.add(instModel),
    near: payload.add(near),
    hdTile: payload.add(hdTile),
    area: payload.add(area),
    tex: [...tex].sort((a, b) => a - b).flatMap((t) => [t >> 16, t & 0xffff]),
  };

  return packContainer(TILE_MAGIC, header, payload);
}

/**
 * Assembles a container file: magic (uint32), header length (uint32), JSON
 * header padded with spaces to a multiple of 4, then the binary payload.
 */
export function packContainer(magic: number, header: unknown, payload: Payload): Buffer {
  let json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length & 3)) & 3;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(magic, 0);
  head.writeUInt32LE(json.length, 4);
  return Buffer.concat([head, json, ...payload.chunks]);
}
