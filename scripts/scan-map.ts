/**
 * Verification sweep: splits the map into top views at 1 m per pixel, on a
 * magenta background and without water, to spot holes in the ground and
 * misplaced objects. Output in docs/screenshots/debug/scan-*.png.
 *   npx tsx scripts/scan-map.ts [hd|lod] [hour]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, gotoView, openSession } from './lib/browser.ts';

const mode = process.argv[2] ?? 'hd';
const time = process.argv[3] ?? '12';
const dir = path.join(ROOT, 'docs', 'screenshots', 'debug');
fs.mkdirSync(dir, { recursive: true });
const session = await openSession();
const cols = [-1450, -250, 850];
const rows = [1300, 500, -300, -1100, -1700];
for (let r = 0; r < rows.length; r++) {
  for (let c = 0; c < cols.length; c++) {
    const name = `scan-${mode}-r${r}c${c}`;
    await gotoView(session, `view=top&lod=${mode}&time=${time}&center=${cols[c]},${rows[r]}&span=900&water=0&bg=ff00ff&ui=0`);
    await session.page.screenshot({ path: path.join(dir, `${name}.png`) });
    console.log(name, `center ${cols[c]},${rows[r]}`);
  }
}
await session.close();
