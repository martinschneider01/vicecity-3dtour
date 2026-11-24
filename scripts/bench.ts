/**
 * Performance measurement: for a series of views, number of draw calls and
 * triangles (renderer.info) and average frame time.
 *   npm run bench            on the machine's GPU
 *   npm run bench -- --software    with software rendering (SwiftShader)
 *
 * "ms/frame" is measured by chaining 300 renders (20 with software rendering) without waiting for the
 * display, then forcing the GPU to finish: this is the real cost of a frame (CPU + GPU).
 * "fps shown" is the rate observed in the animation loop, everything included
 * (rendering, visibility, collisions, minimap), with no display cap.
 * "calls" counts one call per batch (BatchedMesh); each batch draws several objects.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Manifest } from '../shared/format.ts';
import { ROOT, gotoView, openSession } from './lib/browser.ts';

interface Bench {
  ms: number;
  fps: number;
  calls: number;
  triangles: number;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/manifest.json'), 'utf8')) as Manifest;
const GAME = '&detail=auto';
const views: { name: string; query: string }[] = [
  // Default setting: full detail, no LOD.
  ...manifest.teleports.map((t) => ({ name: t.label, query: `tp=${t.id}&time=12` })),
  { name: 'Little Haiti at dusk', query: 'pos=-1050,-150,25&yaw=120&pitch=-5&time=19' },
  { name: 'Prawn Island at night', query: 'pos=10,1000,25&yaw=200&pitch=-5&time=23' },
  { name: 'Ocean Beach from the sky (120 m)', query: 'pos=150,-1500,120&yaw=20&pitch=-20&time=12' },
  { name: 'On foot outside the Malibu', query: 'tp=malibu&mode=foot&time=12' },
  { name: 'Inside the mall', query: 'interior=mall&time=12' },
  // "Like the game" mode: LOD in the distance.
  { name: 'Ocean Drive, like the game', query: `tp=ocean-drive&time=12${GAME}` },
  { name: 'Prawn Island at night, like the game', query: `pos=10,1000,25&yaw=200&pitch=-5&time=23${GAME}` },
  { name: 'Ocean Beach from sky, like the game', query: `pos=150,-1500,120&yaw=20&pitch=-20&time=12${GAME}` },
  { name: 'Whole map from above', query: 'view=top&lod=hd&time=12' },
];

const software = process.argv.includes('--software');
// Software rendering is about a hundred times slower: fewer frames, and skip the diagnostic view.
const frames = software ? 20 : 300;
if (software) views.pop();
const session = await openSession({ width: 1920, height: 1080, software });
console.log(`WebGL renderer: ${session.gpu}`);
console.log('Window 1920×1080\n');
console.log(`${'View'.padEnd(36)} ${'calls'.padStart(7)} ${'triangles'.padStart(10)} ${'ms/frame'.padStart(9)} ${'fps max'.padStart(10)} ${'fps shown'.padStart(16)}`);
for (const v of views) {
  await gotoView(session, `${v.query}&ui=0`);
  await session.page.waitForTimeout(1500);
  // Real rate of the animation loop (rendering + movement + HUD), before the bare measurement.
  const shown = await session.page.evaluate(() => (window as unknown as { vicemap: { info(): { fps: number } } }).vicemap.info().fps);
  const b = (await session.page.evaluate(`window.vicemap.bench(${frames})`)) as Bench;
  const line = `${v.name.padEnd(36)} ${String(b.calls).padStart(7)} ${String(b.triangles).padStart(10)} ${b.ms.toFixed(2).padStart(9)} ${b.fps.toFixed(0).padStart(10)} ${shown.toFixed(0).padStart(16)}`;
  console.log(line);
}

if (!software) {
  // Fast flight: crossing the east island from south to north at 120 m/s, 40 m up.
  // Records each frame's duration while tiles load and unload.
  await gotoView(session, 'pos=250,-1700,40&yaw=0&pitch=-8&time=12&ui=0&detail=auto&preload=0');
  // Code passed as a string: it runs in the page, out of reach of the transpiler's helpers.
  const flight = (await session.page.evaluate(`(async () => {
    const v = window.vicemap;
    const times = [];
    let maxTiles = 0;
    const start = performance.now();
    let last = start;
    await new Promise((resolve) => {
      function step(now) {
        const t = (now - start) / 1000;
        times.push(now - last);
        last = now;
        v.controls.position.set(250 + t * 10, -1700 + t * 120, 40);
        maxTiles = Math.max(maxTiles, v.info().tilesReady);
        if (t < 25) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
    times.shift();
    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    return {
      frames: times.length,
      avg: sum / times.length,
      p99: times[Math.floor(times.length * 0.99)],
      max: times[times.length - 1],
      over16: times.filter((x) => x > 16.7).length,
      over33: times.filter((x) => x > 33.4).length,
      maxTiles,
      build: v.info().maxBuildMs,
      upload: v.info().maxTextureUploadMs,
    };
  })()`)) as { frames: number; avg: number; p99: number; max: number; over16: number; over33: number; maxTiles: number; build: number; upload: number };
  console.log(`
25 s flight at 120 m/s (3 km): ${flight.frames} frames, average ${flight.avg.toFixed(2)} ms, 99th percentile ${flight.p99.toFixed(1)} ms, worst frame ${flight.max.toFixed(1)} ms`);
  console.log(`  frames over 16.7 ms: ${flight.over16}; over 33 ms: ${flight.over33}; up to ${flight.maxTiles} tiles loaded at once`);
  console.log(`  longest tile build: ${flight.build.toFixed(1)} ms; longest texture upload: ${flight.upload.toFixed(1)} ms`);
}
await session.close();
