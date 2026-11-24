/**
 * Exploration tool: statistics on the game data (instances, models,
 * texture formats, LOD rule). Used to validate assumptions before
 * conversion. Usage: npx tsx tools/inspect.ts
 */
import path from 'node:path';
import { ImgArchive } from './lib/img.ts';
import { parseDat, parseIde, parseIpl, resolveGamePath, type ObjectDef } from './lib/gamedata.ts';
import { parseDff, parseTxd, RASTER } from './lib/rw.ts';
import { GAME_DIR } from './lib/paths.ts';

const img = new ImgArchive(path.join(GAME_DIR, 'models/gta3.img'), path.join(GAME_DIR, 'models/gta3.dir'));
console.log('IMG entries:', img.entries.size);
const byExt = new Map<string, number>();
for (const e of img.entries.values()) {
  const ext = path.extname(e.name).toLowerCase();
  byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
}
console.log('by ext:', Object.fromEntries(byExt));

const defs = new Map<number, ObjectDef>();
const byName = new Map<string, ObjectDef>();
const insts = [];
for (const datName of ['data/default.dat', 'data/gta_vc.dat']) {
  const dat = parseDat(resolveGamePath(GAME_DIR, datName)!);
  for (const rel of dat.ide) {
    const f = resolveGamePath(GAME_DIR, rel);
    if (!f) {
      console.log('IDE not found', rel);
      continue;
    }
    for (const d of parseIde(f)) {
      if (defs.has(d.id)) console.log('duplicate id', d.id, d.name, defs.get(d.id)!.name);
      defs.set(d.id, d);
      if (byName.has(d.name.toLowerCase())) console.log('duplicate name', d.name);
      byName.set(d.name.toLowerCase(), d);
    }
  }
  for (const rel of dat.ipl) {
    const f = resolveGamePath(GAME_DIR, rel);
    if (!f) {
      console.log('IPL not found', rel);
      continue;
    }
    insts.push(...parseIpl(f));
  }
}
console.log('defs:', defs.size, 'instances:', insts.length);

const interiors = new Map<number, number>();
let idMismatch = 0;
let noDef = 0;
for (const i of insts) {
  interiors.set(i.interior, (interiors.get(i.interior) ?? 0) + 1);
  const d = defs.get(i.id);
  if (!d) noDef++;
  else if (d.name.toLowerCase() !== i.name.toLowerCase()) idMismatch++;
}
console.log('interiors:', Object.fromEntries([...interiors].sort((a, b) => a[0] - b[0])));
console.log('inst without def:', noDef, 'name ≠ def:', idMismatch);

// Scales and rotations
let nonUnitScale = 0;
for (const i of insts) if (i.scale.some((s) => Math.abs(s - 1) > 1e-3)) nonUnitScale++;
console.log('scale ≠ 1:', nonUnitScale);

// Draw distances and LOD
let big = 0;
let bigLodName = 0;
let lodNameSmall = 0;
const related = new Map<string, ObjectDef[]>();
for (const d of defs.values()) {
  const key = d.name.toLowerCase().slice(3);
  if (!related.has(key)) related.set(key, []);
  related.get(key)!.push(d);
}
let bigWithRelated = 0;
let bigNoRelated = 0;
const bigNoRelNames: string[] = [];
const relBig: string[] = [];
for (const d of defs.values()) {
  const dist = Math.max(...d.drawDists);
  const isLodName = d.name.toLowerCase().startsWith('lod');
  if (dist > 300) {
    big++;
    if (isLodName) bigLodName++;
    const rel = related.get(d.name.toLowerCase().slice(3))!.filter((o) => o !== d);
    if (rel.length) {
      bigWithRelated++;
      if (rel.some((o) => Math.max(...o.drawDists) > 300)) relBig.push(`${d.name}(${dist})~${rel.map((o) => `${o.name}(${Math.max(...o.drawDists)})`).join('|')}`);
    } else {
      bigNoRelated++;
      bigNoRelNames.push(`${d.name}(${dist})`);
    }
  } else if (isLodName) lodNameSmall++;
}
console.log({ big, bigLodName, lodNameSmall, bigWithRelated, bigNoRelated });
console.log('big with no related model (sample):', bigNoRelNames.slice(0, 60).join(' '));
console.log('big whose related model is also big:', relBig.length, relBig.slice(0, 30).join(' '));
const multi = [...related.entries()].filter(([, v]) => v.length > 2);
console.log('groups of >2 related names:', multi.length, multi.slice(0, 15).map(([k, v]) => `${k}: ${v.map((o) => o.name).join('|')}`));

// Flags
const flagCount = new Map<number, number>();
for (const d of defs.values()) for (let b = 0; b < 12; b++) if (d.flags & (1 << b)) flagCount.set(1 << b, (flagCount.get(1 << b) ?? 0) + 1);
console.log('flags:', Object.fromEntries(flagCount));
console.log('tobj:', [...defs.values()].filter((d) => d.timeOn !== null).length, 'meshCount>1:', [...defs.values()].filter((d) => d.meshCount > 1).length);

// Models and TXDs used by the instances
const usedDefs = new Set<ObjectDef>();
for (const i of insts) {
  const d = defs.get(i.id);
  if (d) usedDefs.add(d);
}
const usedTxd = new Set<string>();
let missingDff = 0;
let missingTxd = 0;
for (const d of usedDefs) {
  usedTxd.add(d.txd.toLowerCase());
  if (!img.has(d.name + '.dff')) {
    missingDff++;
    console.log('missing DFF:', d.name, d.id);
  }
}
for (const t of usedTxd) if (!img.has(t + '.txd')) { missingTxd++; console.log('missing TXD:', t); }
console.log('models used:', usedDefs.size, 'txds used:', usedTxd.size, { missingDff, missingTxd });

// Textures
const fmt = new Map<string, number>();
const sizes = new Map<string, number>();
let texCount = 0;
let bytesRgba = 0;
let mipped = 0;
const addr = new Map<string, number>();
for (const t of usedTxd) {
  const buf = img.read(t + '.txd');
  if (!buf) continue;
  for (const tex of parseTxd(buf)) {
    texCount++;
    const f = `${tex.compression ? 'DXT' + tex.compression : tex.rasterFormat & RASTER.PAL8 ? 'PAL8' : 'RAW'}/${(tex.rasterFormat & RASTER.FORMAT_MASK).toString(16)}/d${tex.depth}/a${tex.hasAlphaFlag ? 1 : 0}`;
    fmt.set(f, (fmt.get(f) ?? 0) + 1);
    const s = `${tex.width}x${tex.height}`;
    sizes.set(s, (sizes.get(s) ?? 0) + 1);
    bytesRgba += tex.width * tex.height * 4;
    if (tex.levels.length > 1) mipped++;
    const a = `${tex.addressU}/${tex.addressV}/f${tex.filter}`;
    addr.set(a, (addr.get(a) ?? 0) + 1);
  }
}
console.log('textures:', texCount, 'with mipmaps:', mipped, 'RGBA8 level 0 (MB):', (bytesRgba / 1e6).toFixed(1));
console.log('formats:', Object.fromEntries([...fmt].sort((a, b) => b[1] - a[1])));
console.log('sizes:', Object.fromEntries([...sizes].sort((a, b) => b[1] - a[1])));
console.log('addressing/filter:', Object.fromEntries(addr));

// Geometry
let verts = 0;
let tris = 0;
let mats = 0;
let fail = 0;
let multiAtomic = 0;
let nonIdentityFrame = 0;
const versions = new Map<string, number>();
const frameNameIssues: string[] = [];
let noPrelit = 0;
let hasNormals = 0;
let modulate = 0;
let nonWhiteMat = 0;
for (const d of usedDefs) {
  const buf = img.read(d.name + '.dff');
  if (!buf) continue;
  try {
    const c = parseDff(buf);
    versions.set(c.version.toString(16), (versions.get(c.version.toString(16)) ?? 0) + 1);
    if (c.atomics.length > 1) multiAtomic++;
    for (const a of c.atomics) {
      const fr = c.frames[a.frame];
      const g = c.geometries[a.geometry];
      verts += g.numVerts;
      tris += g.numTris;
      mats += g.materials.length;
      if (!g.colors) noPrelit++;
      if (g.flags & 0x10) hasNormals++;
      if (g.flags & 0x40) modulate++;
      if (g.materials.some((m) => m.color[0] !== 255 || m.color[1] !== 255 || m.color[2] !== 255 || m.color[3] !== 255)) nonWhiteMat++;
      const idRot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (fr.rot.some((v, k) => Math.abs(v - idRot[k]) > 1e-4) || fr.pos.some((v) => Math.abs(v) > 1e-4)) nonIdentityFrame++;
      if (c.atomics.length > 1 || fr.name.toLowerCase() !== d.name.toLowerCase()) {
        if (frameNameIssues.length < 40) frameNameIssues.push(`${d.name}[${d.meshCount}]:${fr.name}`);
      }
    }
  } catch (e) {
    fail++;
    console.log('unreadable DFF:', d.name, (e as Error).message);
  }
}
console.log({ verts, tris, mats, fail, multiAtomic, nonIdentityFrame, noPrelit, hasNormals, modulate, nonWhiteMat });
console.log('RW versions:', Object.fromEntries(versions));
console.log('frame names (sample):', frameNameIssues.join(' '));
