/**
 * Diagnostic tool: searches data/main.scm for commands that hide or replace
 * buildings on the map:
 *   0363 SET_VISIBILITY_OF_CLOSEST_OBJECT_OF_TYPE x y z radius model visible
 *   03B6 SWAP_NEAREST_BUILDING_MODEL          x y z radius old new
 * The compiled script is scanned byte by byte: only occurrences whose
 * arguments all have consistent types are kept.
 *   npx tsx tools/scan-scm.ts
 *
 * With --areas, lists instead the calls to 04BB SET_AREA_VISIBLE (entering
 * an interior) and the coordinates preceding them in the script: the door
 * point, then the point where the player is dropped. This is the source of
 * tools/lib/interiors.ts.
 *   npx tsx tools/scan-scm.ts --areas
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDat, parseIde, parseIpl, resolveGamePath, type Instance, type ObjectDef } from './lib/gamedata.ts';
import { GAME_DIR } from './lib/paths.ts';

const scm = fs.readFileSync(path.join(GAME_DIR, 'data', 'main.scm'));

// Header: three segments, each starting with a jump (opcode 0002 + address).
const seg1 = scm.readInt32LE(3); // start of the 2nd segment (model table)
const numModels = scm.readInt32LE(seg1 + 8);
const modelNames: string[] = [];
for (let i = 0; i < numModels; i++) {
  const p = seg1 + 12 + i * 24;
  let end = scm.indexOf(0, p);
  if (end > p + 24) end = p + 24;
  modelNames.push(scm.toString('latin1', p, end));
}
const seg2 = scm.readInt32LE(seg1 + 3);
const mainSize = scm.readInt32LE(seg2 + 8);
console.log(`${numModels} models named in the script, main script size ${mainSize} bytes`);

const defs = new Map<number, ObjectDef>();
const insts: Instance[] = [];
for (const datName of ['data/default.dat', 'data/gta_vc.dat']) {
  const dat = parseDat(resolveGamePath(GAME_DIR, datName)!);
  for (const rel of dat.ide) for (const d of parseIde(resolveGamePath(GAME_DIR, rel)!)) defs.set(d.id, d);
  for (const rel of dat.ipl) insts.push(...parseIpl(resolveGamePath(GAME_DIR, rel)!));
}

interface Arg {
  kind: 'float' | 'int' | 'var';
  value: number;
  size: number;
}
function readArg(p: number): Arg | null {
  const t = scm[p];
  if (t === 0x06) return { kind: 'float', value: scm.readFloatLE(p + 1), size: 5 }; // Vice City: 4-byte IEEE float
  if (t === 0x01) return { kind: 'int', value: scm.readInt32LE(p + 1), size: 5 };
  if (t === 0x04) return { kind: 'int', value: scm.readInt8(p + 1), size: 2 };
  if (t === 0x05) return { kind: 'int', value: scm.readInt16LE(p + 1), size: 3 };
  if (t === 0x02 || t === 0x03) return { kind: 'var', value: scm.readUInt16LE(p + 1), size: 3 };
  return null;
}
const modelName = (a: Arg) => (a.kind !== 'int' ? '(variable)' : a.value < 0 ? modelNames[-a.value] ?? `?${a.value}` : defs.get(a.value)?.name ?? `#${a.value}`);

if (process.argv.includes('--areas')) {
  // Float triples (plausible x, y, z) in the bytes preceding each call.
  const triples = (end: number, span: number): string[] => {
    const out: string[] = [];
    for (let q = Math.max(0, end - span); q < end - 14; q++) {
      if (scm[q] !== 0x06 || scm[q + 5] !== 0x06 || scm[q + 10] !== 0x06) continue;
      const [x, y, z] = [scm.readFloatLE(q + 1), scm.readFloatLE(q + 6), scm.readFloatLE(q + 11)];
      if (!Number.isFinite(x + y + z) || Math.abs(x) > 2500 || Math.abs(y) > 2500 || Math.abs(z) > 500 || (Math.abs(x) < 4 && Math.abs(y) < 4)) continue;
      out.push(`(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
      q += 14;
    }
    return out;
  };
  for (let p = 0; p + 4 < scm.length; p++) {
    if ((scm.readUInt16LE(p) & 0x7fff) !== 0x04bb || scm[p + 2] !== 0x04) continue;
    const area = scm.readInt8(p + 3);
    if (area <= 0 || area > 18) continue;
    console.log(`@${p} [${p < mainSize ? 'main' : 'mission'}] area ${area}:${triples(p, 260).slice(-4).join(' ')}`);
  }
  process.exit(0);
}

for (let p = 0; p + 2 < scm.length; p++) {
  const op = scm.readUInt16LE(p) & 0x7fff;
  if (op !== 0x0363 && op !== 0x03b6) continue;
  const args: Arg[] = [];
  let q = p + 2;
  for (let i = 0; i < 6; i++) {
    const a = readArg(q);
    if (!a) break;
    args.push(a);
    q += a.size;
  }
  if (args.length < 6 || args.slice(0, 4).some((a) => a.kind !== 'float')) continue;
  const [x, y, z, r] = args.map((a) => a.value);
  if (Math.abs(x) > 3000 || Math.abs(y) > 3000 || r <= 0 || r > 500) continue;
  const where = p < mainSize ? 'main' : 'mission';
  const name = modelName(args[4]);
  const near = insts.filter((i) => i.name.toLowerCase() === name.toLowerCase() && Math.hypot(i.pos[0] - x, i.pos[1] - y, i.pos[2] - z) <= r + 5);
  if (op === 0x0363) {
    console.log(`@${p} [${where}] VISIBILITY ${name} at (${x}, ${y}, ${z}) r=${r} visible=${args[5].value}  → ${near.length} IPL instance(s)${near.length ? ` area ${near[0].interior}` : ''}`);
  } else {
    console.log(`@${p} [${where}] SWAP ${name} for ${modelName(args[5])} at (${x}, ${y}, ${z}) r=${r}  → ${near.length} IPL instance(s)`);
  }
}
