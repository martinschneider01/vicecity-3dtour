/**
 * Diagnostic tool: opens a view and evaluates an expression in the page.
 *   npx tsx scripts/probe.ts "tp=malibu&time=12" "vicemap.pick(0, -0.5)" ["another expression" ...]
 * With --shot <name>, also saves a screenshot in docs/screenshots/debug/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, gotoView, openSession } from './lib/browser.ts';

const args = process.argv.slice(2);
const shotIdx = args.indexOf('--shot');
let shot: string | null = null;
if (shotIdx >= 0) {
  shot = args[shotIdx + 1];
  args.splice(shotIdx, 2);
}
const [query, ...exprs] = args;
const session = await openSession();
await gotoView(session, `${query}&ui=0`);
for (const expr of exprs) {
  const result = await session.page.evaluate(`(async () => { const vicemap = window.vicemap; return (${expr}); })()`);
  console.log(`${expr} =>`, JSON.stringify(result, null, 1));
}
if (shot) {
  const dir = path.join(ROOT, 'docs', 'screenshots', 'debug');
  fs.mkdirSync(dir, { recursive: true });
  await session.page.screenshot({ path: path.join(dir, `${shot}.png`) });
}
await session.close();
