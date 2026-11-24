/**
 * Converts GTA: Vice City game data into assets for the viewer.
 *
 *   npm run build:assets
 *
 * Reads the game install (read-only) and writes to public/assets/:
 *   manifest.json        description of everything else
 *   far.bin              buildings seen from afar (LOD), loaded at startup
 *   tiles/t_X_Y.bin      detailed objects, split into 250 m tiles
 *   interiors/<id>.bin   one file per enterable interior
 *   tex/*.bin            textures, grouped into arrays by size/format
 *   radar.png            the game's radar map, for the minimap
 *   logo.png             the game's "Vice City" logo, for the intro page
 *   player.bin           player character model, skeleton and animations
 * plus a human-readable report in docs/build-report.txt.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FORMAT_VERSION, HD_SAME_PACK, type InteriorInfo, type Manifest, type RadarInfo, type TileInfo } from '../shared/format.ts';
import { parseDat, parseIde, parseIpl, resolveGamePath, type Instance, type ObjectDef } from './lib/gamedata.ts';
import { parseIfp } from './lib/ifp.ts';
import { ImgArchive } from './lib/img.ts';
import { CUTSCENE_AREAS, INTERIORS } from './lib/interiors.ts';
import { LOD_DISTANCE, LodLinker, farOf, type Vec3 } from './lib/lod.ts';
import { convertModel, type ConvertedModel } from './lib/model.ts';
import { GAME_DIR, OUT_DIR as FINAL_DIR, ROOT } from './lib/paths.ts';
import { buildPed } from './lib/ped.ts';
import { writePng } from './lib/png.ts';
import { parseDff, parseTxd, type TxdTexture } from './lib/rw.ts';
import { TELEPORTS } from './lib/teleports.ts';
import { TextureStore, decodeTexture, type TexRef } from './lib/textures.ts';
import { buildTile, type PlacedInstance } from './lib/tile.ts';
import { parseTimecyc, parseWaterPro, waterRects } from './lib/world.ts';

const TILE_SIZE = 250;
/**
 * The conversion writes to a temporary folder, swapped with public/assets
 * at the very end: a viewer open during the conversion never sees
 * half-written files.
 */
const OUT_DIR = FINAL_DIR + '.tmp';
/** "Visible everywhere" area of the IPL interior field. */
const AREA_EVERYWHERE = 13;
/** Player animations exported from anim/ped.ifp. */
const PLAYER_CLIPS = ['idle_stance', 'run_player', 'sprint_civi', 'walk_player'];

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);

function need(rel: string): string {
  const p = resolveGamePath(GAME_DIR, rel);
  if (!p) throw new Error(`game file not found: ${rel}`);
  return p;
}


/* ------------------------------------------------------------ reading */

log(`Game: ${GAME_DIR}`);
const img = new ImgArchive(need('models/gta3.img'), need('models/gta3.dir'));

const defs = new Map<number, ObjectDef>();
/** ID range of each IDE file: the game looks there for a LOD's detailed model. */
const ideRange = new Map<string, [number, number]>();
const instances: Instance[] = [];
const notes: string[] = [];

for (const datName of ['data/default.dat', 'data/gta_vc.dat']) {
  const dat = parseDat(need(datName));
  for (const rel of dat.ide) {
    const list = parseIde(need(rel));
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of list) {
      if (defs.has(d.id)) notes.push(`ID ${d.id} defined twice (${defs.get(d.id)!.name}, ${d.name})`);
      defs.set(d.id, d);
      lo = Math.min(lo, d.id);
      hi = Math.max(hi, d.id);
    }
    if (list.length) ideRange.set(list[0].source, [lo, hi]);
  }
  for (const rel of dat.ipl) instances.push(...parseIpl(need(rel)));
}
log(`${defs.size} object definitions, ${instances.length} instances read`);

const lods = new LodLinker(defs.values(), ideRange);

/* ------------------------------------------------- instance filtering */

const excluded = new Map<string, { count: number; examples: string[] }>();
function exclude(reason: string, inst: Instance): void {
  let e = excluded.get(reason);
  if (!e) excluded.set(reason, (e = { count: 0, examples: [] }));
  e.count++;
  if (e.examples.length < 6 && !e.examples.includes(inst.name)) e.examples.push(inst.name);
}

interface Candidate {
  inst: Instance;
  def: ObjectDef;
}
const exterior: Candidate[] = [];
const interiorCands = new Map<number, Candidate[]>();
const knownAreas = new Set(INTERIORS.map((i) => i.area));
let ignoredScale = 0;
const seen = new Set<string>();
for (const inst of instances) {
  const def = defs.get(inst.id);
  if (!def) {
    exclude('ID missing from IDE files', inst);
    continue;
  }
  if (def.name.toLowerCase() !== inst.name.toLowerCase()) {
    notes.push(`${inst.source}:${inst.line}: name "${inst.name}" ≠ definition "${def.name}" (id ${inst.id}), the ID takes precedence`);
  }
  // A few instances are written twice, identically, in the IPLs.
  const key = `${inst.id}/${inst.interior}/${inst.pos.join(',')}/${inst.rot.join(',')}`;
  if (seen.has(key)) {
    exclude('exact duplicate (same model, same position, same rotation)', inst);
    continue;
  }
  seen.add(key);
  if (farOf(def) < 2) {
    exclude('draw distance < 2 (the game makes the object invisible)', inst);
    continue;
  }
  if (inst.scale.some((s) => Math.abs(s - 1) > 1e-3)) ignoredScale++;
  if (inst.interior !== 0 && inst.interior !== AREA_EVERYWHERE) {
    if (CUTSCENE_AREAS[inst.interior]) {
      exclude(`cutscene set with no free-roam entrance (area ${inst.interior}: ${CUTSCENE_AREAS[inst.interior]})`, inst);
      continue;
    }
    if (!knownAreas.has(inst.interior)) {
      exclude(`area ${inst.interior} unknown to the game (never shown)`, inst);
      continue;
    }
    let l = interiorCands.get(inst.interior);
    if (!l) interiorCands.set(inst.interior, (l = []));
    l.push({ inst, def });
    continue;
  }
  if (/^islandlod/i.test(def.name)) {
    exclude('whole-island LOD (the game only shows it from the other island, instead of the individual LODs)', inst);
    continue;
  }
  exterior.push({ inst, def });
}

/* -------------------------------------------------- textures and models */

fs.rmSync(OUT_DIR, { recursive: true, force: true });
for (const d of ['tiles', 'tex', 'interiors']) fs.mkdirSync(path.join(OUT_DIR, d), { recursive: true });
const store = new TextureStore(path.join(OUT_DIR, 'tex'));

const txdCache = new Map<string, Map<string, TxdTexture> | null>();
const missingTxd = new Set<string>();
function loadTxd(name: string): Map<string, TxdTexture> | null {
  const key = name.toLowerCase();
  let t = txdCache.get(key);
  if (t !== undefined) return t;
  t = null;
  const sources: Buffer[] = [];
  // The game's "generic" dictionary is models/generic.txd (loaded at
  // startup); gta3.img contains a second, smaller one. We take the union.
  if (key === 'generic') sources.push(fs.readFileSync(need('models/generic.txd')));
  const fromImg = img.read(key + '.txd');
  if (fromImg) sources.push(fromImg);
  if (sources.length) {
    t = new Map();
    for (const buf of sources) {
      for (const tex of parseTxd(buf)) {
        const k = tex.name.toLowerCase();
        if (!t.has(k)) t.set(k, tex);
      }
    }
  } else {
    missingTxd.add(name);
  }
  txdCache.set(key, t);
  return t;
}

// Water: read early, since the sea level is used to spot submerged objects.
const grid = parseWaterPro(need('data/waterpro.dat'));
const seaLevel = grid.levels[0] ?? 6;
/** Per model: highest instance origin, and true if all its instances are upright (rotation around Z only). */
const defPlacement = new Map<ObjectDef, { maxZ: number; upright: boolean }>();
for (const c of [...exterior, ...[...interiorCands.values()].flat()]) {
  let p = defPlacement.get(c.def);
  if (!p) defPlacement.set(c.def, (p = { maxZ: -Infinity, upright: true }));
  p.maxZ = Math.max(p.maxZ, c.inst.pos[2]);
  if (Math.abs(c.inst.rot[0]) > 0.01 || Math.abs(c.inst.rot[1]) > 0.01) p.upright = false;
}

const texRefCache = new Map<string, TexRef | null>();
const missingTextures = new Map<string, string[]>();
const ctx = {
  lookup(txd: string, texture: string): TexRef | null {
    const key = `${txd.toLowerCase()}/${texture.toLowerCase()}`;
    let ref = texRefCache.get(key);
    if (ref !== undefined) return ref;
    const tex = loadTxd(txd)?.get(texture.toLowerCase());
    ref = tex ? store.add(tex) : null;
    texRefCache.set(key, ref);
    return ref;
  },
  white: () => store.white(),
  isUnderwater(def: ObjectDef, zMax: number): boolean {
    const p = defPlacement.get(def);
    return !!p && p.upright && p.maxZ + zMax < seaLevel - 0.2;
  },
  onMissingTexture(def: ObjectDef, texture: string): void {
    const key = `${def.txd}/${texture}`;
    let list = missingTextures.get(key);
    if (!list) missingTextures.set(key, (list = []));
    if (!list.includes(def.name)) list.push(def.name);
  },
  onNote: (n: string) => notes.push(n),
};
store.white();

const modelCache = new Map<ObjectDef, ConvertedModel | string>();
const missingModels = new Map<string, string>();
function getModel(def: ObjectDef): ConvertedModel | null {
  let m = modelCache.get(def);
  if (m === undefined) {
    const buf = img.read(def.name + '.dff');
    if (!buf) m = 'DFF missing from gta3.img';
    else {
      try {
        m = convertModel(def, parseDff(buf), ctx);
        if (m.tris === 0) m = 'model has no triangles';
      } catch (e) {
        m = `unreadable DFF: ${(e as Error).message}`;
      }
    }
    modelCache.set(def, m);
    if (typeof m === 'string') missingModels.set(def.name, m);
  }
  return typeof m === 'string' ? null : m;
}

/** Rotation as the game builds it: axis (x, y, z), angle = -2·acos(w). */
function gameQuat(r: [number, number, number, number]): [number, number, number, number] {
  const len = Math.hypot(r[0], r[1], r[2]);
  const w = Math.min(1, Math.max(-1, r[3]));
  if (len < 1e-9) return [0, 0, 0, 1];
  // VC_RAW_QUATERNIONS=1 disables the rotation-direction flip: only used to
  // reproduce the validation screenshot (docs/screenshots/validation-rotation-raw.png).
  const sign = process.env.VC_RAW_QUATERNIONS === '1' ? 1 : -1;
  const s = (sign * Math.sqrt(1 - w * w)) / len;
  return [r[0] * s, r[1] * s, r[2] * s, w];
}

let placed = 0;
let totalTris = 0;
const usedModels = new Set<ConvertedModel>();

function place(cands: Candidate[]): PlacedInstance[] {
  const out: PlacedInstance[] = [];
  for (const c of cands) {
    const model = getModel(c.def);
    if (!model) {
      exclude(`unusable model (${missingModels.get(c.def.name)})`, c.inst);
      continue;
    }
    usedModels.add(model);
    out.push({ def: c.def, model, pos: c.inst.pos, quat: gameQuat(c.inst.rot), far: farOf(c.def), near: 0, hdTile: -1, area: c.inst.interior });
    placed++;
    totalTris += model.tris;
  }
  return out;
}

/* --------------------------------------------------- tile partitioning */

const farCands: Candidate[] = [];
const tileCands = new Map<string, Candidate[]>();
for (const c of exterior) {
  if (farOf(c.def) > LOD_DISTANCE) {
    farCands.push(c);
    continue;
  }
  const key = `${Math.floor(c.inst.pos[0] / TILE_SIZE)}_${Math.floor(c.inst.pos[1] / TILE_SIZE)}`;
  let list = tileCands.get(key);
  if (!list) tileCands.set(key, (list = []));
  list.push(c);
}

function morton(x: number, y: number): number {
  let m = 0;
  for (let b = 0; b < 12; b++) m |= ((x >> b) & 1) << (2 * b) | ((y >> b) & 1) << (2 * b + 1);
  return m;
}
// Morton order: neighbouring tiles follow each other, and so do their textures
// in the class files (reads over contiguous ranges).
const tileKeys = [...tileCands.keys()].sort((a, b) => {
  const [ax, ay] = a.split('_').map(Number);
  const [bx, by] = b.split('_').map(Number);
  return morton(ax + 64, ay + 64) - morton(bx + 64, by + 64);
});

const exteriorHd = LodLinker.index(
  tileKeys.flatMap((key, tile) => tileCands.get(key)!.map((c) => ({ def: c.def, pos: c.inst.pos, tile }))),
);

/* ------------------------------------------------------------ far pack */

log('Converting the far pack (LOD)...');
const farPlaced = place(farCands);
lods.link(farPlaced, exteriorHd);
// Tiles are linked before anything is written: hours inherited by a LOD apply to every pack.
const tilePlaced = tileKeys.map((key) => {
  const list = place(tileCands.get(key)!);
  lods.link(list, exteriorHd);
  return list;
});
/** Geometry files are gzip-compressed; the viewer decompresses them on load. */
const pack = (buf: Buffer): Buffer => zlib.gzipSync(buf, { level: 9 });
const farBuf = pack(buildTile(farPlaced, lods.inheritedTime));
fs.writeFileSync(path.join(OUT_DIR, 'far.bin'), farBuf);

/* ------------------------------------------------------------------ tiles */

log(`Converting ${tileKeys.length} tiles...`);
const tiles: TileInfo[] = [];
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const p of farPlaced) {
  for (let k = 0; k < 3; k++) {
    bounds.min[k] = Math.min(bounds.min[k], p.pos[k]);
    bounds.max[k] = Math.max(bounds.max[k], p.pos[k]);
  }
}
tileKeys.forEach((key, ti) => {
  const list = tilePlaced[ti];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let far = 0;
  for (const p of list) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.pos[k]);
      max[k] = Math.max(max[k], p.pos[k]);
      bounds.min[k] = Math.min(bounds.min[k], p.pos[k]);
      bounds.max[k] = Math.max(bounds.max[k], p.pos[k]);
    }
    far = Math.max(far, p.far);
  }
  const file = `tiles/t_${key}.bin`;
  // An empty tile (all models unusable) keeps its slot so indices stay stable.
  const buf = pack(buildTile(list, lods.inheritedTime));
  fs.writeFileSync(path.join(OUT_DIR, file), buf);
  tiles.push({ file, min: list.length ? min : [0, 0, 0], max: list.length ? max : [0, 0, 0], far, count: list.length, bytes: buf.length });
});
const exteriorPlaced = placed;

/* -------------------------------------------------------------- interiors */

log(`Converting ${interiorCands.size} interiors...`);
const interiors: InteriorInfo[] = [];
let interiorBytes = 0;
for (const def of INTERIORS) {
  const cands = interiorCands.get(def.area);
  if (!cands?.length) {
    notes.push(`interior "${def.label}" (area ${def.area}): no instances in the IPLs`);
    continue;
  }
  const list = place(cands);
  lods.link(list, LodLinker.index(list.map((p) => ({ def: p.def, pos: p.pos, tile: HD_SAME_PACK }))));
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const centre: Vec3 = [0, 0, 0];
  for (const p of list) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.pos[k]);
      max[k] = Math.max(max[k], p.pos[k]);
      centre[k] += p.pos[k] / list.length;
    }
  }
  // With no known arrival point: a few metres past the door, towards the centre of
  // the interior; or the centre itself when it is built somewhere other than behind its door.
  let spawn = def.spawn;
  const doorInside = def.door.every((v, k) => v > min[k] - 10 && v < max[k] + 10);
  if (!spawn && !doorInside) spawn = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  if (!spawn) {
    const dx = centre[0] - def.door[0];
    const dy = centre[1] - def.door[1];
    const len = Math.hypot(dx, dy) || 1;
    const step = Math.min(4, len);
    spawn = [def.door[0] + (dx / len) * step, def.door[1] + (dy / len) * step, def.door[2] + 0.3];
  }
  const yaw = (Math.atan2(centre[0] - spawn[0], centre[1] - spawn[1]) * 180) / Math.PI;
  const file = `interiors/${def.id}.bin`;
  const buf = pack(buildTile(list, lods.inheritedTime));
  fs.writeFileSync(path.join(OUT_DIR, file), buf);
  interiorBytes += buf.length;
  interiors.push({ area: def.area, id: def.id, label: def.label, file, count: list.length, door: def.door, spawn, yaw, min, max });
}

/* ----------------------------------------------------------- water and sky */

const rects = waterRects(grid);
let waterTex: [number, number] | null = null;
try {
  const particle = parseTxd(fs.readFileSync(need('models/particle.txd')));
  const wt = particle.find((t) => t.name.toLowerCase() === 'waterclear256');
  if (wt) {
    const ref = store.add(wt);
    waterTex = [ref.cls, ref.layer];
  } else notes.push('water texture waterclear256 missing from particle.txd');
} catch (e) {
  notes.push(`unreadable particle.txd: ${(e as Error).message}`);
}
const timecyc = parseTimecyc(need('data/timecyc.dat'));

/* ------------------------------------------------------------------ radar */

/**
 * The game's radar is split into 8 x 8 textures (radar00 to radar63, ordered
 * west to east then north to south) covering 4000 x 4000 units, from
 * (-2000, -2000) to (2000, 2000). We stitch them into a single image.
 */
function buildRadar(): RadarInfo | null {
  const TILE = 128;
  const size = TILE * 8;
  const out = new Uint8Array(size * size * 4);
  let found = 0;
  for (let i = 0; i < 64; i++) {
    const name = `radar${String(i).padStart(2, '0')}`;
    const buf = img.read(`${name}.txd`);
    const tex = buf ? parseTxd(buf)[0] : null;
    if (!tex) continue;
    found++;
    const rgba = decodeTexture(tex);
    if (tex.width !== TILE || tex.height !== TILE) {
      notes.push(`${name}: ${tex.width}x${tex.height}, radar tile skipped`);
      continue;
    }
    const ox = (i % 8) * TILE;
    const oy = Math.floor(i / 8) * TILE;
    for (let y = 0; y < TILE; y++) {
      out.set(rgba.subarray(y * TILE * 4, (y + 1) * TILE * 4), ((oy + y) * size + ox) * 4);
    }
  }
  if (found === 0) {
    notes.push('radar textures missing: no minimap');
    return null;
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  writePng(path.join(OUT_DIR, 'radar.png'), out, size, size);
  return { file: 'radar.png', size, min: [-2000, -2000], max: [2000, 2000] };
}
const radar = buildRadar();

/* ------------------------------------------------------------------- logo */

/**
 * The "Vice City" logo from the game's main menu (fronten1.txd), cropped to
 * its visible pixels, for the intro page. Not in the manifest: the intro is
 * shown before the manifest is loaded, and falls back to text without it.
 */
function buildLogo(): boolean {
  const p = resolveGamePath(GAME_DIR, 'models/fronten1.txd');
  const tex = p ? parseTxd(fs.readFileSync(p)).find((t) => t.name.toLowerCase() === 'vc_logo') : undefined;
  if (!tex) {
    notes.push('vc_logo not found in fronten1.txd: the intro page shows a text title');
    return false;
  }
  const rgba = decodeTexture(tex);
  const { width: w, height: h } = tex;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] < 8) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return false;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  writePng(path.join(OUT_DIR, 'logo.png'), out, cw, ch);
  return true;
}
const logo = buildLogo();

/* ------------------------------------------------------------- player */

let player: string | null = null;
try {
  const dff = img.read('player.dff');
  const txd = img.read('player.txd');
  if (!dff || !txd) throw new Error('player.dff or player.txd missing from gta3.img');
  const skinTex = parseTxd(txd)[0];
  const ped = buildPed(parseDff(dff), parseIfp(fs.readFileSync(need('anim/ped.ifp'))), PLAYER_CLIPS, store.add(skinTex));
  notes.push(...ped.notes);
  fs.writeFileSync(path.join(OUT_DIR, 'player.bin'), pack(ped.file));
  player = 'player.bin';
} catch (e) {
  notes.push(`player not exported: ${(e as Error).message}`);
}

/* -------------------------------------------------------------- manifest */

log('Encoding textures (Basis Universal)...');
const texClasses = await store.finish();
const texBytes = store.stats.bytes;
const texGpuBytes = texClasses.reduce((s, c) => s + c.layers * c.stride, 0);
const tileBytes = tiles.reduce((s, t) => s + t.bytes, 0);
const stats = {
  instancesRead: instances.length,
  instancesPlaced: placed,
  instancesExterior: exteriorPlaced,
  instancesInterior: placed - exteriorPlaced,
  instancesExcluded: instances.length - placed,
  farInstances: farPlaced.length,
  models: usedModels.size,
  vertices: [...usedModels].reduce((s, m) => s + m.verts, 0),
  triangles: [...usedModels].reduce((s, m) => s + m.tris, 0),
  placedTriangles: totalTris,
  textures: store.stats.unique,
  textureBytes: texBytes,
  geometryBytes: tileBytes + farBuf.length + interiorBytes,
};
const manifest: Manifest = {
  version: FORMAT_VERSION,
  tileSize: TILE_SIZE,
  tiles,
  far: { file: 'far.bin', count: farPlaced.length, bytes: farBuf.length },
  interiors,
  radar,
  player,
  texClasses,
  timecyc,
  water: {
    rects,
    land: waterRects(grid, true),
    seaLevel,
    min: [grid.originX, grid.originY],
    max: [grid.originX + 128 * grid.cell, grid.originY + 128 * grid.cell],
    tex: waterTex,
  },
  bounds: bounds as Manifest['bounds'],
  teleports: TELEPORTS,
  stats,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

/* ------------------------------------------------------------------ report */

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const lines: string[] = [];
const out = (s = '') => lines.push(s);
out('CONVERSION REPORT');
out('=================');
out(`Instances read from IPLs ........... ${instances.length}`);
out(`Instances placed ................... ${placed}`);
out(`  exterior world ................... ${exteriorPlaced}  (${farPlaced.length} in the far pack, ${exteriorPlaced - farPlaced.length} in ${tiles.length} tiles)`);
out(`  interiors ........................ ${placed - exteriorPlaced}  (${interiors.map((i) => `${i.id}: ${i.count}`).join(', ')})`);
out(`Instances excluded ................. ${instances.length - placed}`);
for (const [reason, e] of [...excluded].sort((a, b) => b[1].count - a[1].count)) {
  out(`  ${String(e.count).padStart(5)}  ${reason}`);
  out(`         e.g. ${e.examples.join(', ')}`);
}
out(`Scales ≠ 1 ignored ................. ${ignoredScale}  (the game reads this field but does not apply it)`);
out();
out(`Models converted ................... ${usedModels.size}  (${stats.vertices} vertices, ${stats.triangles} unique triangles; ${totalTris} triangles once instanced)`);
out(`Models missing or unreadable ....... ${missingModels.size}`);
for (const [name, why] of missingModels) out(`    ${name}: ${why}`);
out();
out(`LODs linked by name ................ ${lods.stats.byName}  (game rule: same name from the 4th character on)`);
out(`LODs linked by position ............ ${lods.stats.byPlace}  (detailed model at the same spot, with a longer name)`);
out(`LODs linked by proximity ........... ${lods.stats.byNeighbour}  (tree clusters and ground: fade out closer than 150 m)`);
out(`Large objects with no detailed model ${lods.stats.none}  (seabeds, lights, blimp... always shown)`);
if (lods.unlinked.size) out(`    of which named LOD: ${[...lods.unlinked].join(', ')}`);
out(`LODs more than 50 m from their detailed model: ${lods.stats.far}`);
out(`LODs inheriting the hours of a day/night object: ${lods.inheritedTime.size}`);
out();
out(`Unique textures .................... ${store.stats.unique}  (${store.stats.duplicates} duplicates merged, ${store.stats.resized} stretched to square)`);
out(`Texture classes .................... ${texClasses.map((c) => `${c.size}/${c.fmt}×${c.layers}`).join(', ')}`);
out(`Texture files ...................... ${texClasses.reduce((n, c) => n + c.chunks.length, 0)} KTX2 files (${store.stats.encoded} encoded, ${store.stats.cached} reused from cache)`);
out(`TXD dictionaries not found ......... ${missingTxd.size}${missingTxd.size ? ': ' + [...missingTxd].join(', ') : ''}`);
out(`Textures not found ................. ${missingTextures.size}  (referenced by a model but missing from its TXD;`);
out('                                     the game then draws the face untextured, and so do we)');
for (const [key, models] of [...missingTextures].sort()) out(`    ${key}  ← ${models.slice(0, 4).join(', ')}${models.length > 4 ? '…' : ''}`);
out();
out(`Water .............................. ${rects.length / 5} rectangles, levels ${[...new Set(grid.levels)].join(', ')}`);
out(`Timecyc weathers ................... ${timecyc.length}`);
out(`Radar .............................. ${radar ? `${radar.size}×${radar.size} pixels` : 'missing'}`);
out(`Intro logo ......................... ${logo ? 'exported' : 'missing'}`);
out(`Player ............................. ${player ? `exported (${PLAYER_CLIPS.join(', ')})` : 'missing'}`);
out(`Asset size ......................... geometry ${mb(stats.geometryBytes)} (gzip), textures ${mb(texBytes)} (${mb(texGpuBytes)} once in video memory)`);
if (notes.length) {
  out();
  out('Notes');
  for (const n of notes) out(`  - ${n}`);
}
const report = lines.join('\n') + '\n';
console.log('\n' + report);
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'build-report.txt'), report);
img.close();
// Swap the temporary folder with the final one.
fs.rmSync(FINAL_DIR, { recursive: true, force: true });
fs.renameSync(OUT_DIR, FINAL_DIR);
log(`Done. Assets in ${path.relative(ROOT, FINAL_DIR)}, report in docs/build-report.txt`);
