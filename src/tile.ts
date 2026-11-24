/**
 * A loaded pack (tile, far pack or interior): its geometry batches (one
 * BatchedMesh per texture class and render mode), its instance table, and
 * what is needed to cast rays against its geometry.
 *
 * A BatchedMesh stores each model's geometry once and draws it as many times
 * as there are instances, with per-instance visibility. That is what provides
 * instancing for repeated models (palm trees, street lights...).
 */
import * as THREE from 'three';
import { HD_SAME_PACK, MODE, TILE_MAGIC, batchKeyMode, type TileHeader } from '../shared/format.ts';
import type { WorldMaterials } from './materials.ts';

export interface ParsedTile {
  header: TileHeader;
  payload: ArrayBuffer;
  payloadOffset: number;
}

/** Downloads a geometry file (gzip-compressed by the conversion) and decompresses it. */
export async function fetchPack(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export function parseTile(buf: ArrayBuffer): ParsedTile {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== TILE_MAGIC) throw new Error('invalid tile file');
  const headerLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen))) as TileHeader;
  return { header, payload: buf, payloadOffset: 8 + headerLen };
}

/** "auto": like the game, LODs in the distance. "hd": all detailed models, no LODs. "lod": LODs only (diagnostics). */
export type LodMode = 'auto' | 'hd' | 'lod';

export interface VisibilityQuery {
  /** Camera position. */
  x: number;
  y: number;
  z: number;
  /** Draw distance multiplier. */
  scale: number;
  /** Whole game hour, for day/night objects. */
  hour: number;
  mode: LodMode;
  /** True if the given tile (the one holding a LOD's detailed model) is displayed. */
  hdReady: (tile: number) => boolean;
  /**
   * True when inside an interior and this pack belongs to the outside world:
   * only its area 13 ("visible everywhere") instances remain.
   */
  everywhereOnly: boolean;
  /**
   * True for the far pack: its objects are not hidden by their draw distance
   * (fog and the horizon take care of that). The game hides them, but its
   * camera never goes high enough to notice; here, seen from altitude, the
   * city would vanish in patches.
   */
  ignoreFar: boolean;
}

/** Ray cast against geometry. `t` is the range on input and the distance to the first hit on output. */
export interface RayHit {
  t: number;
  hit: boolean;
  /** Normal of the face hit, facing the ray origin. */
  nx: number;
  ny: number;
  nz: number;
}

/** Render order per mode. The water surface is at 1. */
const RENDER_ORDER: Record<number, number> = {
  [MODE.OPAQUE]: 0,
  [MODE.CUTOUT]: 0,
  [MODE.BLEND_UNDERWATER]: 0.5,
  [MODE.BLEND_NO_DEPTH]: 2,
  [MODE.BLEND]: 2.5,
  [MODE.ADDITIVE]: 3,
};

const AREA_EVERYWHERE = 13;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

interface CollisionBatch {
  pos: Float32Array;
  idx: Uint16Array | Uint32Array;
  /** [firstVertex, vertexCount, firstIndex, indexCount] per sub-geometry. */
  geoms: number[];
  /** False for halos and decals: you pass through them. */
  solid: boolean;
}

export class TileContent {
  readonly meshes: THREE.BatchedMesh[] = [];
  readonly count: number;
  /** xyz position of each instance. */
  readonly pos: Float32Array;
  readonly far: Float32Array;
  readonly near: Float32Array;
  readonly hdTile: Int16Array;
  readonly area: Uint8Array;
  readonly timeOn: Int8Array;
  readonly timeOff: Int8Array;
  readonly modelOf: Uint16Array;
  readonly modelNames: string[];
  /** Bounding box of all the pack's geometry (to sort raycasts). */
  readonly box = new THREE.Box3();
  private readonly visible: Uint8Array;
  /**
   * Instances that currently exist (right hour, right area), whether or not
   * they are close enough to be drawn: these are the obstacles.
   */
  private readonly present: Uint8Array;
  /** For instance i, its parts run from partStart[i] to partStart[i + 1]. */
  private readonly partStart: Uint32Array;
  private readonly partMesh: Uint16Array;
  private readonly partId: Uint32Array;
  /** Visible part count per batch: a batch with nothing visible is removed from rendering. */
  private readonly meshShown: Uint32Array;
  /** Position and quaternion of each instance (7 floats), for collisions. */
  private readonly inst: Float32Array;
  /** World bounding sphere of each instance: xyz center and radius. */
  private readonly sphere: Float32Array;
  private readonly batches: CollisionBatch[];
  private readonly modelParts: number[][];
  triangles = 0;

  constructor(parsed: ParsedTile, materials: WorldMaterials) {
    const { header, payload, payloadOffset: base } = parsed;
    const n = header.count;
    this.count = n;
    const inst = new Float32Array(payload, base + header.inst, n * 7);
    this.inst = inst;
    this.modelOf = new Uint16Array(payload, base + header.instModel, n);
    this.near = new Float32Array(payload, base + header.near, n);
    this.hdTile = new Int16Array(payload, base + header.hdTile, n);
    this.area = new Uint8Array(payload, base + header.area, n);
    this.modelNames = header.models.map((m) => m.name);
    this.modelParts = header.models.map((m) => m.parts);

    // Instance count per batch: each model instance takes a slot in every
    // batch where the model has a part.
    const perBatch = new Uint32Array(header.batches.length);
    let totalParts = 0;
    for (let i = 0; i < n; i++) {
      const parts = header.models[this.modelOf[i]].parts;
      for (let k = 0; k < parts.length; k += 2) perBatch[parts[k]]++;
      totalParts += parts.length / 2;
    }

    const geomIds: number[][] = [];
    this.batches = [];
    header.batches.forEach((b, bi) => {
      const mode = batchKeyMode(b.key);
      const mesh = new THREE.BatchedMesh(Math.max(1, perBatch[bi]), b.verts, b.indices, materials.get(b.key));
      mesh.name = `batch-${b.key}`;
      // Per-instance sorting and frustum culling only matter for transparent
      // batches; elsewhere they would waste CPU every frame for nothing (the
      // GPU culls off-screen triangles very well).
      const sorted = mode === MODE.BLEND || mode === MODE.BLEND_UNDERWATER || mode === MODE.BLEND_NO_DEPTH;
      mesh.sortObjects = sorted;
      mesh.perObjectFrustumCulled = sorted;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = RENDER_ORDER[mode];
      const pos = new Float32Array(payload, base + b.pos, b.verts * 3);
      const uv = new Float32Array(payload, base + b.uv, b.verts * 2);
      const col = new Uint8Array(payload, base + b.col, b.verts * 4);
      const amb = new Uint8Array(payload, base + b.amb, b.verts * 4);
      const lay = new Uint16Array(payload, base + b.lay, b.verts);
      const idx = b.idx16
        ? new Uint16Array(payload, base + b.idx, b.indices)
        : new Uint32Array(payload, base + b.idx, b.indices);
      const ids: number[] = [];
      for (let g = 0; g < b.geoms.length; g += 4) {
        const [v0, vn, i0, inum] = [b.geoms[g], b.geoms[g + 1], b.geoms[g + 2], b.geoms[g + 3]];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(v0 * 3, (v0 + vn) * 3), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(v0 * 2, (v0 + vn) * 2), 2));
        geo.setAttribute('acolor', new THREE.BufferAttribute(col.subarray(v0 * 4, (v0 + vn) * 4), 4, true));
        geo.setAttribute('aamb', new THREE.BufferAttribute(amb.subarray(v0 * 4, (v0 + vn) * 4), 4, true));
        geo.setAttribute('layer', new THREE.BufferAttribute(lay.subarray(v0, v0 + vn), 1));
        geo.setIndex(new THREE.BufferAttribute(idx.subarray(i0, i0 + inum), 1));
        ids.push(mesh.addGeometry(geo));
      }
      geomIds.push(ids);
      this.meshes.push(mesh);
      // Obstacles: everything except halos (additive) and decals lying on the ground.
      this.batches.push({ pos, idx, geoms: b.geoms, solid: mode !== MODE.ADDITIVE && mode !== MODE.BLEND_NO_DEPTH });
    });

    // Bounding sphere of each model in its local frame: center of its box and radius.
    const modelSphere = new Float32Array(header.models.length * 4);
    header.models.forEach((model, mi) => {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < model.parts.length; k += 2) {
        const b = this.batches[model.parts[k]];
        const g = model.parts[k + 1] * 4;
        for (let v = b.geoms[g] * 3, end = (b.geoms[g] + b.geoms[g + 1]) * 3; v < end; v += 3) {
          const x = b.pos[v], y = b.pos[v + 1], z = b.pos[v + 2];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
      }
      modelSphere[mi * 4] = (x0 + x1) / 2;
      modelSphere[mi * 4 + 1] = (y0 + y1) / 2;
      modelSphere[mi * 4 + 2] = (z0 + z1) / 2;
      modelSphere[mi * 4 + 3] = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
    });

    this.pos = new Float32Array(n * 3);
    this.far = new Float32Array(n);
    this.timeOn = new Int8Array(n);
    this.timeOff = new Int8Array(n);
    this.visible = new Uint8Array(n);
    this.present = new Uint8Array(n);
    this.sphere = new Float32Array(n * 4);
    this.partStart = new Uint32Array(n + 1);
    this.partMesh = new Uint16Array(totalParts);
    this.partId = new Uint32Array(totalParts);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const mi = this.modelOf[i];
      const model = header.models[mi];
      const o = i * 7;
      this.pos[i * 3] = inst[o];
      this.pos[i * 3 + 1] = inst[o + 1];
      this.pos[i * 3 + 2] = inst[o + 2];
      this.far[i] = model.far;
      this.timeOn[i] = model.on;
      this.timeOff[i] = model.off;
      _p.set(inst[o], inst[o + 1], inst[o + 2]);
      _q.set(inst[o + 3], inst[o + 4], inst[o + 5], inst[o + 6]);
      _m.compose(_p, _q, _one);
      _p.set(modelSphere[mi * 4], modelSphere[mi * 4 + 1], modelSphere[mi * 4 + 2]).applyMatrix4(_m);
      const r = modelSphere[mi * 4 + 3];
      this.sphere[i * 4] = _p.x;
      this.sphere[i * 4 + 1] = _p.y;
      this.sphere[i * 4 + 2] = _p.z;
      this.sphere[i * 4 + 3] = r;
      this.box.min.x = Math.min(this.box.min.x, _p.x - r);
      this.box.min.y = Math.min(this.box.min.y, _p.y - r);
      this.box.min.z = Math.min(this.box.min.z, _p.z - r);
      this.box.max.x = Math.max(this.box.max.x, _p.x + r);
      this.box.max.y = Math.max(this.box.max.y, _p.y + r);
      this.box.max.z = Math.max(this.box.max.z, _p.z + r);
      this.partStart[i] = p;
      for (let k = 0; k < model.parts.length; k += 2) {
        const bi = model.parts[k];
        const mesh = this.meshes[bi];
        const id = mesh.addInstance(geomIds[bi][model.parts[k + 1]]);
        mesh.setMatrixAt(id, _m);
        mesh.setVisibleAt(id, false);
        this.partMesh[p] = bi;
        this.partId[p] = id;
        p++;
        this.triangles += header.batches[bi].geoms[model.parts[k + 1] * 4 + 3] / 3;
      }
    }
    this.partStart[n] = p;
    this.meshShown = new Uint32Array(this.meshes.length);
    for (const mesh of this.meshes) {
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      mesh.visible = false;
    }
  }

  /**
   * Updates the visibility of each instance.
   *
   * Game rules: an object is visible if its distance to the camera is below
   * its draw distance; a LOD disappears below its detailed model's draw
   * distance, provided that model is loaded; a day/night object only exists
   * between its two hours.
   * Returns the number of visible instances.
   */
  updateVisibility(q: VisibilityQuery): number {
    const { pos, far, near, hdTile, timeOn, timeOff, visible, area, present } = this;
    const { x: cx, y: cy, z: cz, scale, hour, mode } = q;
    let shown = 0;
    for (let i = 0; i < this.count; i++) {
      let vis = !q.everywhereOnly || area[i] === AREA_EVERYWHERE;
      const on = timeOn[i];
      if (vis && on >= 0) {
        const off = timeOff[i];
        vis = on > off ? hour >= on || hour < off : hour >= on && hour < off;
      }
      // A LOD is never an obstacle: its detailed model is.
      present[i] = vis && near[i] === 0 ? 1 : 0;
      if (vis) {
        const ready = near[i] > 0 && (hdTile[i] === HD_SAME_PACK || q.hdReady(hdTile[i]));
        if (mode === 'hd') {
          vis = !ready;
        } else if (mode === 'lod') {
          vis = far[i] > 300;
        } else {
          const dx = pos[i * 3] - cx;
          const dy = pos[i * 3 + 1] - cy;
          const dz = pos[i * 3 + 2] - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          const f = far[i] * scale;
          vis = q.ignoreFar || d2 < f * f;
          if (vis && ready) {
            const nr = near[i] * scale;
            if (d2 < nr * nr) vis = false;
          }
        }
      }
      if (vis) shown++;
      const v = vis ? 1 : 0;
      if (v !== visible[i]) {
        visible[i] = v;
        for (let p = this.partStart[i]; p < this.partStart[i + 1]; p++) {
          const mi = this.partMesh[p];
          const mesh = this.meshes[mi];
          mesh.setVisibleAt(this.partId[p], vis);
          // Even when empty, a batch costs a full pass through the renderer: hide it.
          this.meshShown[mi] += vis ? 1 : -1;
          mesh.visible = this.meshShown[mi] > 0;
        }
      }
    }
    return shown;
  }

  /**
   * Casts a ray (origin o, unit direction d) against the pack's present, solid
   * instances (even those too far away to be drawn). Updates `hit` if a hit
   * closer than hit.t is found.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, hit: RayHit): void {
    const { sphere, inst, present } = this;
    for (let i = 0; i < this.count; i++) {
      if (!present[i]) continue;
      // Quick test against the bounding sphere.
      const sx = sphere[i * 4] - ox;
      const sy = sphere[i * 4 + 1] - oy;
      const sz = sphere[i * 4 + 2] - oz;
      const r = sphere[i * 4 + 3];
      const along = sx * dx + sy * dy + sz * dz;
      if (along < -r || along > hit.t + r) continue;
      if (sx * sx + sy * sy + sz * sz - along * along > r * r) continue;

      // Ray in the model's frame: inverse rotation (conjugate quaternion),
      // with v' = v + 2 q × (q × v + w v).
      const o = i * 7;
      const qx = -inst[o + 3], qy = -inst[o + 4], qz = -inst[o + 5], qw = inst[o + 6];
      const px = ox - inst[o], py = oy - inst[o + 1], pz = oz - inst[o + 2];
      let tx = qy * pz - qz * py + qw * px;
      let ty = qz * px - qx * pz + qw * py;
      let tz = qx * py - qy * px + qw * pz;
      const lox = px + 2 * (qy * tz - qz * ty);
      const loy = py + 2 * (qz * tx - qx * tz);
      const loz = pz + 2 * (qx * ty - qy * tx);
      tx = qy * dz - qz * dy + qw * dx;
      ty = qz * dx - qx * dz + qw * dy;
      tz = qx * dy - qy * dx + qw * dz;
      const ldx = dx + 2 * (qy * tz - qz * ty);
      const ldy = dy + 2 * (qz * tx - qx * tz);
      const ldz = dz + 2 * (qx * ty - qy * tx);

      const parts = this.modelParts[this.modelOf[i]];
      let best = hit.t;
      let bnx = 0, bny = 0, bnz = 0;
      for (let k = 0; k < parts.length; k += 2) {
        const b = this.batches[parts[k]];
        if (!b.solid) continue;
        const g = parts[k + 1] * 4;
        const v0 = b.geoms[g] * 3;
        const { pos, idx } = b;
        for (let t = b.geoms[g + 2], end = t + b.geoms[g + 3]; t < end; t += 3) {
          const a = v0 + idx[t] * 3;
          const bb = v0 + idx[t + 1] * 3;
          const c = v0 + idx[t + 2] * 3;
          const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
          const e1x = pos[bb] - ax, e1y = pos[bb + 1] - ay, e1z = pos[bb + 2] - az;
          const e2x = pos[c] - ax, e2y = pos[c + 1] - ay, e2z = pos[c + 2] - az;
          // Möller-Trumbore, double-sided faces.
          const hx = ldy * e2z - ldz * e2y, hy = ldz * e2x - ldx * e2z, hz = ldx * e2y - ldy * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (det > -1e-9 && det < 1e-9) continue;
          const f = 1 / det;
          const wx = lox - ax, wy = loy - ay, wz = loz - az;
          const u = f * (wx * hx + wy * hy + wz * hz);
          if (u < 0 || u > 1) continue;
          const cx = wy * e1z - wz * e1y, cy = wz * e1x - wx * e1z, cz = wx * e1y - wy * e1x;
          const v = f * (ldx * cx + ldy * cy + ldz * cz);
          if (v < 0 || u + v > 1) continue;
          const dist = f * (e2x * cx + e2y * cy + e2z * cz);
          if (dist > 1e-4 && dist < best) {
            best = dist;
            bnx = e1y * e2z - e1z * e2y;
            bny = e1z * e2x - e1x * e2z;
            bnz = e1x * e2y - e1y * e2x;
          }
        }
      }
      if (best < hit.t) {
        // Normal brought back to world space (forward rotation) and turned to face the ray origin.
        const rx = -qx, ry = -qy, rz = -qz;
        tx = ry * bnz - rz * bny + qw * bnx;
        ty = rz * bnx - rx * bnz + qw * bny;
        tz = rx * bny - ry * bnx + qw * bnz;
        let nx = bnx + 2 * (ry * tz - rz * ty);
        let ny = bny + 2 * (rz * tx - rx * tz);
        let nz = bnz + 2 * (rx * ty - ry * tx);
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        if (nx * dx + ny * dy + nz * dz > 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        hit.t = best;
        hit.hit = true;
        hit.nx = nx;
        hit.ny = ny;
        hit.nz = nz;
      }
    }
  }

  /** Finds the instance (index within the pack) from a batch and a batch instance id. */
  findInstance(mesh: THREE.BatchedMesh, batchId: number): number {
    const bi = this.meshes.indexOf(mesh);
    if (bi < 0) return -1;
    for (let i = 0; i < this.count; i++) {
      for (let p = this.partStart[i]; p < this.partStart[i + 1]; p++) {
        if (this.partMesh[p] === bi && this.partId[p] === batchId) return i;
      }
    }
    return -1;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.meshes.length = 0;
  }
}
