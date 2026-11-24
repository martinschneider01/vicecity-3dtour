/**
 * Checks and captures the intro page:
 *   - docs/screenshots/intro.png: the live 3D view behind the intro text;
 *   - what was downloaded before the click (only the LOD pack should be);
 *   - "Enter Vice City" turns into a progress bar, loads the tiles seen from
 *     the arrival point, then flies down there without dropping frames; the
 *     rest of the map streams in after landing.
 *   npx tsx scripts/shot-intro.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';
import { ROOT } from './lib/browser.ts';

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5184, strictPort: false, open: false } });
await server.listen();
const address = server.httpServer!.address();
const port = typeof address === 'object' && address ? address.port : 5184;
const browser = await chromium.launch({
  channel: 'chromium',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const check = (ok: boolean, name: string, detail = '') => console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);

try {
  for (const [w, h, name] of [[1600, 900, 'intro'], [420, 860, 'intro-mobile']] as const) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.log(`  [page exception] ${e.message}`));
    // Frame timestamps from the very start, and when each fade begins.
    await page.addInitScript(`
      window.frames_ = [];
      window.marks_ = {};
      const tick = (t) => { window.frames_.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      addEventListener('DOMContentLoaded', () => new MutationObserver(() => {
        const el = document.getElementById('intro');
        if (!el) return;
        for (const c of ['has-bg', 'live', 'leaving']) if (el.classList.contains(c) && !window.marks_[c]) window.marks_[c] = performance.now();
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] }));
    `);
    const t0 = Date.now();
    await page.goto(`http://localhost:${port}/`);
    await page.locator('#intro .intro-enter').waitFor();
    await page.locator('#intro.live').waitFor({ timeout: 60000 });
    const liveAfter = Date.now() - t0;
    await page.waitForTimeout(2500); // cross-fade, then a bit of orbit
    if (name === 'intro') {
      const fades = (await page.evaluate(`(() => {
        const worst = (from, ms) => {
          const f = window.frames_.filter((t) => t >= from && t <= from + ms);
          return Math.max(...f.slice(1).map((t, i) => t - f[i]));
        };
        return { poster: worst(window.marks_['has-bg'], 800), crossfade: worst(window.marks_.live, 1500) };
      })()`)) as { poster: number; crossfade: number };
      check(fades.poster < 25, 'the poster fades in smoothly', `worst frame ${fades.poster.toFixed(1)} ms`);
      check(fades.crossfade < 40, 'the cross-fade to 3D is smooth', `worst frame ${fades.crossfade.toFixed(1)} ms (3D capped at 30 fps)`);
    }
    await page.screenshot({ path: path.join(ROOT, 'docs/screenshots', `${name}.png`) });
    console.log(`screenshot: docs/screenshots/${name}.png`);
    if (name !== 'intro') {
      await page.close();
      continue;
    }
    const before = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((r) => r as PerformanceResourceTiming)
        .filter((r) => r.name.includes('/assets/'))
        .map((r) => ({ name: r.name.split('/assets/')[1], bytes: r.encodedBodySize })),
    );
    const mb = before.reduce((n, r) => n + r.bytes, 0) / 1e6;
    check(liveAfter < 30000, 'the live 3D view replaces the poster', `${(liveAfter / 1000).toFixed(1)} s`);
    check(!before.some((r) => r.name.startsWith('tiles/')), 'no detailed tile loaded before the click', `${before.length} files, ${mb.toFixed(1)} MB`);
    check(!(await page.evaluate(() => 'vicemap' in window)), 'the viewer stays in intro mode before the click');

    // Frame timestamps, and the moment the page starts fading out (= the flight starts).
    await page.evaluate(`
      new MutationObserver(() => {
        if (!window.leaveAt && document.querySelector('#intro.leaving')) window.leaveAt = performance.now();
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    `);
    await page.locator('#intro .intro-enter').click();
    const t1 = Date.now();
    await page.waitForTimeout(300);
    const label = (await page.locator('.intro-progress-label').textContent()) ?? '';
    check(label.startsWith('Loading Vice City'), 'the button turns into a loader', label);
    await page.locator('#intro.leaving').waitFor({ timeout: 120000 });
    const loading = Date.now() - t1;
    const tilesBefore = await page.evaluate(() =>
      performance.getEntriesByType('resource').filter((r) => r.name.includes('/assets/tiles/')).length,
    );
    check(tilesBefore > 0, 'the arrival spot is loaded before the flight', `${tilesBefore} tiles in ${(loading / 1000).toFixed(1)} s`);
    await page.waitForFunction(() => 'vicemap' in window, null, { timeout: 30000 });
    const flight = Date.now() - t1 - loading;
    check(flight > 3000 && flight < 15000, 'the flight down ends', `${(flight / 1000).toFixed(1)} s`);
    const frames = await page.evaluate(() => {
      const w = window as unknown as { frames_: number[]; leaveAt: number };
      const f = w.frames_.filter((t) => t >= w.leaveAt);
      const d = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
      return { count: d.length, median: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] };
    });
    check(frames.max < 50, 'no frame drop during the flight', `${frames.count} frames, median ${frames.median.toFixed(1)} ms, p95 ${frames.p95.toFixed(1)} ms, max ${frames.max.toFixed(1)} ms`);
    check((await page.locator('#intro').count()) === 0, 'the intro page is removed');
    check(await page.locator('#minimap').isVisible(), 'the minimap is shown');
    check(!(await page.locator('#hud').isVisible()), 'the full HUD is not (minimap-only by default)');
    const landedAt = await page.evaluate(() => performance.now());
    await page.waitForFunction(
      () => {
        const v = (window as unknown as { vicemap: { settled(): boolean; world: { tiles: { info: { count: number } }[] }; info(): { tilesReady: number } } }).vicemap;
        return v.settled() && v.info().tilesReady === v.world.tiles.filter((t) => t.info.count > 0).length;
      },
      null,
      { timeout: 120000, polling: 250 },
    );
    const after = await page.evaluate((from) => {
      const w = window as unknown as { frames_: number[]; vicemap: { info(): { pos: number[]; tilesReady: number } } };
      const f = w.frames_.filter((t) => t >= from);
      const d = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
      return { info: w.vicemap.info(), seconds: (f[f.length - 1] - from) / 1000, p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] };
    }, landedAt);
    check(true, 'the rest of the map streams in after landing', `${after.info.tilesReady} tiles in ${after.seconds.toFixed(1)} s, frames p95 ${after.p95.toFixed(1)} ms, max ${after.max.toFixed(1)} ms`);
    await page.waitForTimeout(1000); // HUD fade-in
    await page.screenshot({ path: path.join(ROOT, 'docs/screenshots/debug/after-intro.png') });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
