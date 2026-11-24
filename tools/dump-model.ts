/**
 * Diagnostic tool: summarizes a DFF model from gta3.img (frames, materials,
 * vertex colours).  npx tsx tools/dump-model.ts <name> [name...]
 */
import path from 'node:path';
import { ImgArchive } from './lib/img.ts';
import { GAME_DIR } from './lib/paths.ts';
import { parseDff } from './lib/rw.ts';

const img = new ImgArchive(path.join(GAME_DIR, 'models/gta3.img'), path.join(GAME_DIR, 'models/gta3.dir'));
for (const name of process.argv.slice(2)) {
  const buf = img.read(name + '.dff');
  if (!buf) {
    console.log(name, ': not found');
    continue;
  }
  const c = parseDff(buf);
  console.log(`${name}: RW ${c.version.toString(16)}, ${c.atomics.length} atomic(s)`);
  for (const a of c.atomics) {
    const g = c.geometries[a.geometry];
    const sum = [0, 0, 0, 0];
    const min = [255, 255, 255, 255];
    const max = [0, 0, 0, 0];
    if (g.colors) {
      for (let i = 0; i < g.numVerts; i++) for (let k = 0; k < 4; k++) {
        const v = g.colors[i * 4 + k];
        sum[k] += v; min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
      }
    }
    console.log(`  frame "${c.frames[a.frame]?.name}" flags=0x${g.flags.toString(16)} vertices=${g.numVerts} triangles=${g.numTris} radius=${g.sphere[3].toFixed(1)}`);
    console.log(`  mean colour=${sum.map((s) => (s / Math.max(1, g.numVerts)).toFixed(0))} min=${min} max=${max}`);
    g.materials.forEach((m, i) => console.log(`    mat ${i}: colour=${m.color} texture=${m.texture} mask=${m.mask}`));
  }
}
