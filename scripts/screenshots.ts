/**
 * Verification screenshots, saved in docs/screenshots/.
 *
 *   npm run screenshots                 all reference screenshots
 *   npm run screenshots -- malibu       only those whose name contains "malibu"
 *   npm run screenshots -- --shot name "pos=10,20,30&yaw=90&time=12"
 *                                        an arbitrary view (in docs/screenshots/debug/)
 *   --software                          force software rendering (SwiftShader)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from '../shared/format.ts';
import { ROOT, gotoView, openSession } from './lib/browser.ts';

const OUT = path.join(ROOT, 'docs', 'screenshots');
const args = process.argv.slice(2);
const software = args.includes('--software');
const shotIdx = args.indexOf('--shot');
const filters = args.filter((a, i) => !a.startsWith('--') && (shotIdx < 0 || (i !== shotIdx + 1 && i !== shotIdx + 2)));

interface Shot {
  name: string;
  query: string;
  dir?: string;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/manifest.json'), 'utf8')) as Manifest;
const shots: Shot[] = [];
if (shotIdx >= 0) {
  shots.push({ name: args[shotIdx + 1], query: args[shotIdx + 2], dir: 'debug' });
} else {
  for (const [label, time] of [['noon', 12], ['midnight', 0]] as const) {
    shots.push({ name: `top-view-detail-${label}`, query: `view=top&lod=hd&time=${time}` });
    shots.push({ name: `top-view-lod-${label}`, query: `view=top&lod=lod&time=${time}` });
    for (const t of manifest.teleports) shots.push({ name: `${t.id}-${label}`, query: `tp=${t.id}&time=${time}` });
  }
  // Modes and features: on foot, interiors, full detail, view from altitude, large map.
  shots.push({ name: 'on-foot-ocean-drive', query: 'tp=ocean-drive&mode=foot&time=17&ui=1' });
  shots.push({ name: 'on-foot-malibu-night', query: 'tp=malibu&mode=foot&time=22' });
  shots.push({ name: 'interior-malibu', query: 'interior=malibu&mode=foot&time=22' });
  shots.push({ name: 'interior-bank', query: 'interior=bank&time=12' });
  shots.push({ name: 'interior-mall', query: 'interior=mall&mode=foot&time=12' });
  shots.push({ name: 'interior-stadium-dirtring', query: 'interior=dirtring&time=12' });
  shots.push({ name: 'altitude-like-the-game', query: 'pos=0,-1700,300&yaw=350&pitch=-20&time=17&detail=auto' });
  shots.push({ name: 'altitude-full-detail', query: 'pos=0,-1700,300&yaw=350&pitch=-20&time=17' });
  shots.push({ name: 'hud-minimap-only', query: 'tp=mansion&mode=foot&time=18&hud=map' });
  shots.push({ name: 'lighthouse-night', query: 'pos=300,-1600,90&yaw=130&pitch=-18&time=22' });
  shots.push({ name: 'large-map', query: 'tp=ocean-drive&time=12&map=1&ui=1' });
}

const session = await openSession({ software });
console.log(`WebGL renderer: ${session.gpu}`);
for (const shot of shots) {
  if (filters.length && !filters.some((f) => shot.name.includes(f))) continue;
  const dir = shot.dir ? path.join(OUT, shot.dir) : OUT;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${shot.name}.png`);
  const t = Date.now();
  await gotoView(session, /\b(ui|hud)=/.test(shot.query) ? shot.query : `${shot.query}&ui=0`);
  await session.page.screenshot({ path: file });
  const info = await session.page.evaluate(() => (window as unknown as { vicemap: { info(): Record<string, unknown> } }).vicemap.info());
  console.log(`${path.relative(ROOT, file)}  (${Date.now() - t} ms, ${info.calls} calls, ${info.triangles} triangles, ${info.instancesShown} objects)`);
}
await session.close();
