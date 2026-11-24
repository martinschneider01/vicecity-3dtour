/**
 * Reads the map definition text files:
 *  - gta_vc.dat / default.dat: list of IDEs and IPLs to load;
 *  - IDE: object definitions (objs and tobj sections);
 *  - IPL: instance placements (inst section).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Bits of the "flags" column in the objs/tobj sections. */
export const IDE_FLAG = {
  WET_ROAD: 1,
  NO_FADE: 2,
  DRAW_LAST: 4,
  ADDITIVE: 8,
  IS_SUBWAY: 16,
  IGNORE_LIGHTING: 32,
  NO_ZWRITE: 64,
  NO_SHADOWS: 128,
  IGNORE_DRAW_DIST: 256,
} as const;

export interface ObjectDef {
  id: number;
  /** Model name, original case. */
  name: string;
  /** Texture dictionary name, original case. */
  txd: string;
  meshCount: number;
  /** Draw distances, one per internal level of detail (1 to 3). */
  drawDists: number[];
  flags: number;
  /** Appear/disappear hours for tobj objects, otherwise null. */
  timeOn: number | null;
  timeOff: number | null;
  /** Source IDE file (for diagnostics). */
  source: string;
}

export interface Instance {
  id: number;
  name: string;
  /** Interior area code: 0 = exterior world, 13 = visible everywhere. */
  interior: number;
  pos: [number, number, number];
  scale: [number, number, number];
  /** Quaternion x, y, z, w as written in the file. */
  rot: [number, number, number, number];
  source: string;
  line: number;
}

export interface DatFile {
  ide: string[];
  ipl: string[];
  texDictionaries: string[];
}

/**
 * Resolves a game path ("DATA\MAPS\haitin\haitin.IDE") case-insensitively,
 * so the script also works on a case-sensitive file system.
 */
export function resolveGamePath(gameDir: string, rel: string): string | null {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  let cur = gameDir;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

export function parseDat(file: string): DatFile {
  const out: DatFile = { ide: [], ipl: [], texDictionaries: [] };
  for (const raw of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    if (kind === 'IDE') out.ide.push(m[2].trim());
    else if (kind === 'IPL') out.ipl.push(m[2].trim());
    else if (kind === 'TEXDICTION') out.texDictionaries.push(m[2].trim());
  }
  return out;
}

/** Iterates over the meaningful lines of a sectioned file ("objs" ... "end"). */
function* sectionLines(file: string): Generator<{ section: string; fields: string[]; line: number }> {
  const lines = fs.readFileSync(file, 'latin1').split(/\r?\n/);
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#')[0].trim();
    if (!line || line.startsWith(';')) continue;
    if (section === null) {
      section = line.toLowerCase();
      continue;
    }
    if (line.toLowerCase() === 'end') {
      section = null;
      continue;
    }
    const fields = line
      .split(/[\s,]+/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    yield { section, fields, line: i + 1 };
  }
}

export function parseIde(file: string): ObjectDef[] {
  const out: ObjectDef[] = [];
  const source = path.basename(file).toLowerCase();
  for (const { section, fields, line } of sectionLines(file)) {
    if (section !== 'objs' && section !== 'tobj') continue;
    const isTime = section === 'tobj';
    // objs: id, model, txd, meshCount, dist1[, dist2[, dist3]], flags
    // tobj: same, then timeOn, timeOff
    const tail = isTime ? 2 : 0;
    const meshCount = Number(fields[3]);
    const nDist = fields.length - 5 - tail;
    if (!(meshCount >= 1 && meshCount <= 3) || nDist !== meshCount) {
      throw new Error(`${source}:${line}: unexpected ${section} line: ${fields.join(', ')}`);
    }
    const drawDists = fields.slice(4, 4 + nDist).map(Number);
    out.push({
      id: Number(fields[0]),
      name: fields[1],
      txd: fields[2],
      meshCount,
      drawDists,
      flags: Number(fields[4 + nDist]),
      timeOn: isTime ? Number(fields[5 + nDist]) : null,
      timeOff: isTime ? Number(fields[6 + nDist]) : null,
      source,
    });
  }
  return out;
}

export function parseIpl(file: string): Instance[] {
  const out: Instance[] = [];
  const source = path.basename(file).toLowerCase();
  for (const { section, fields, line } of sectionLines(file)) {
    if (section !== 'inst') continue;
    // Vice City: id, model, interior, pos(3), scale(3), rotation(4) = 13 fields.
    // Some lines inherited from GTA III lack the interior field (12 fields).
    let f = fields;
    let interior = 0;
    if (f.length === 13) {
      interior = Number(f[2]);
      f = [f[0], f[1], ...f.slice(3)];
    } else if (f.length !== 12) {
      throw new Error(`${source}:${line}: unexpected inst line (${fields.length} fields)`);
    }
    const n = f.slice(2).map(Number);
    if (n.some((v) => !Number.isFinite(v))) {
      throw new Error(`${source}:${line}: invalid number: ${fields.join(', ')}`);
    }
    out.push({
      id: Number(f[0]),
      name: f[1],
      interior,
      pos: [n[0], n[1], n[2]],
      scale: [n[3], n[4], n[5]],
      rot: [n[6], n[7], n[8], n[9]],
      source,
      line,
    });
  }
  return out;
}
