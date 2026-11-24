/**
 * End-to-end test of the controls and the HUD in a real browser: mouse
 * capture, keyboard movement, mouse wheel, teleporting, time slider.
 * Exits with an error code if any check fails.
 *   npm run test:controls
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, gotoView, openSession } from './lib/browser.ts';

interface State {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  hour: number;
}

const session = await openSession();
const { page } = session;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
const state = () =>
  page.evaluate(() => {
    const v = (window as unknown as { vicemap: { info(): State; controls: { speed: number; locked: boolean } } }).vicemap;
    return { ...v.info(), speed: v.controls.speed, locked: v.controls.locked };
  });

// rawmouse=0: in raw mode, the test browser's synthetic mouse movements are not faithful.
await gotoView(session, 'tp=ocean-drive&time=12&rawmouse=0');
const s0 = await state();
const shown = async () => ({
  hud: await page.locator('#hud').isVisible(),
  panel: await page.locator('#controls').isVisible(),
  map: await page.locator('#minimap').isVisible(),
});
let v = await shown();
check('default: minimap only', !v.hud && !v.panel && v.map);
await page.keyboard.press('h');
v = await shown();
check('H: full HUD', v.hud && v.panel && v.map);
check('5 teleport buttons', (await page.locator('.teleports button').count()) === 5);

// Mouse capture by clicking in the view
await page.mouse.click(800, 450);
await page.waitForTimeout(300);
const locked = (await state()).locked;
check('mouse captured on click', locked);

// Mouse look. The viewer ignores the first movement after capture (unreliable value).
await page.mouse.move(810, 450);
await page.waitForTimeout(100);
await page.mouse.move(910, 430);
await page.waitForTimeout(100);
const s1 = await state();
// 100 px to the right and 20 px up, at 0.12° per pixel.
check('mouse turns the camera', locked && Math.abs(s1.yaw - s0.yaw - 12) < 0.5 && Math.abs(s1.pitch - s0.pitch - 2.4) < 0.5, `heading ${s0.yaw.toFixed(1)} → ${s1.yaw.toFixed(1)}, pitch ${s0.pitch.toFixed(1)} → ${s1.pitch.toFixed(1)}`);

// Move forward with W (physical key)
await page.keyboard.down('KeyW');
await page.waitForTimeout(500);
await page.keyboard.up('KeyW');
const s2 = await state();
const moved = Math.hypot(s2.pos[0] - s1.pos[0], s2.pos[1] - s1.pos[1], s2.pos[2] - s1.pos[2]);
check('W moves forward', moved > 5 && moved < 60, `${moved.toFixed(1)} m in 0.5 s`);

// Shift speeds up
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyW');
await page.waitForTimeout(500);
await page.keyboard.up('KeyW');
await page.keyboard.up('ShiftLeft');
const s3 = await state();
const fast = Math.hypot(s3.pos[0] - s2.pos[0], s3.pos[1] - s2.pos[1], s3.pos[2] - s2.pos[2]);
check('Shift speeds up', fast > moved * 2.5, `${fast.toFixed(1)} m in 0.5 s`);

// E goes up, Q goes down
await page.keyboard.down('KeyE');
await page.waitForTimeout(300);
await page.keyboard.up('KeyE');
const s4 = await state();
check('E goes up', s4.pos[2] > s3.pos[2] + 2, `z ${s3.pos[2].toFixed(1)} → ${s4.pos[2].toFixed(1)}`);
await page.keyboard.down('KeyQ');
await page.waitForTimeout(300);
await page.keyboard.up('KeyQ');
const s5 = await state();
check('Q goes down', s5.pos[2] < s4.pos[2] - 2, `z ${s4.pos[2].toFixed(1)} → ${s5.pos[2].toFixed(1)}`);

// A and D strafe in opposite directions
await page.keyboard.down('KeyD');
await page.waitForTimeout(300);
await page.keyboard.up('KeyD');
const s6 = await state();
await page.keyboard.down('KeyA');
await page.waitForTimeout(300);
await page.keyboard.up('KeyA');
const s7 = await state();
const right = [s6.pos[0] - s5.pos[0], s6.pos[1] - s5.pos[1]];
const left = [s7.pos[0] - s6.pos[0], s7.pos[1] - s6.pos[1]];
check('A and D go in opposite directions', right[0] * left[0] + right[1] * left[1] < -1, `D (${right.map((v) => v.toFixed(1))}) A (${left.map((v) => v.toFixed(1))})`);

// Mouse wheel: speed
const speedBefore = (await state()).speed;
await page.mouse.wheel(0, -300);
await page.waitForTimeout(100);
const speedAfter = (await state()).speed;
check('mouse wheel sets the speed', speedAfter > speedBefore, `${speedBefore.toFixed(1)} → ${speedAfter.toFixed(1)} m/s`);

// Release the mouse, then teleport via the HUD
await page.keyboard.press('Escape');
await page.evaluate(() => document.exitPointerLock());
await page.waitForTimeout(200);
await page.locator('.teleports button', { hasText: 'Malibu' }).click();
await page.waitForTimeout(200);
const s8 = await state();
check('teleport to the Malibu Club', Math.hypot(s8.pos[0] - 455, s8.pos[1] + 95) < 5, `position ${s8.pos.map((v) => v.toFixed(0))}`);

// Time slider
await page.locator('#controls input[type=range]').first().fill('23');
await page.waitForTimeout(200);
const s9 = await state();
check('slider sets the time', Math.abs(s9.hour - 23) < 0.01, `hour ${s9.hour}`);
await page.waitForFunction(() => (window as unknown as { vicemap: { settled(): boolean } }).vicemap.settled(), null, { timeout: 60000 });
const dir = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(dir, { recursive: true });
await page.screenshot({ path: path.join(dir, 'interface.png') });
console.log('screenshot: docs/screenshots/interface.png');

/* ------------------------------------------------------ on-foot mode */

interface Ext {
  pos: [number, number, number];
  mode: string;
  inside: string | null;
  grounded: boolean;
}
const ext = () => page.evaluate(`window.vicemap.info()`) as Promise<Ext>;
const settle = async () => {
  await page.waitForTimeout(150);
  await page.waitForFunction(`window.vicemap.settled()`, null, { timeout: 90000, polling: 100 });
};
const dist2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

await page.keyboard.press('v');
await settle();
const f0 = await ext();
check('V switches to on-foot mode, the character is on the ground', f0.mode === 'foot' && f0.grounded, `position ${f0.pos.map((v) => v.toFixed(1))}`);
check('"On foot" button active', await page.locator('.segmented button.active', { hasText: 'On foot' }).isVisible());

await page.keyboard.down('KeyW');
await page.waitForTimeout(1000);
await page.keyboard.up('KeyW');
const f1 = await ext();
const ran = dist2(f1.pos, f0.pos);
check('W makes the character run', ran > 3 && ran < 12 && f1.grounded, `${ran.toFixed(1)} m in 1 s`);

const camBefore = (await page.evaluate(`window.vicemap.player.cameraDistance`)) as number;
await page.mouse.move(800, 450);
await page.mouse.wheel(0, 300);
await page.waitForTimeout(100);
const camAfter = (await page.evaluate(`window.vicemap.player.cameraDistance`)) as number;
check('mouse wheel moves the follow camera away', camAfter > camBefore, `${camBefore.toFixed(1)} → ${camAfter.toFixed(1)} m`);

/* ------------------------------------------------- map and interiors */

await page.keyboard.press('m');
await page.waitForTimeout(300);
check('M opens the large map', await page.locator('#bigmap').isVisible());
// Click on Starfish Island: the map covers -2000..2000 on both axes.
const box = (await page.locator('#bigmap-canvas').boundingBox())!;
const target = [-420, -500];
await page.mouse.click(box.x + ((target[0] + 2000) / 4000) * box.width, box.y + ((2000 - target[1]) / 4000) * box.height);
await settle();
const f2 = await ext();
check('clicking the map teleports', dist2(f2.pos, target) < 15 && f2.grounded, `position ${f2.pos.map((v) => v.toFixed(0))}`);
check('the map closes', !(await page.locator('#bigmap').isVisible()));

// At the Malibu door: the prompt appears, F enters, F leaves again.
// (The character is placed on the ground 3 m from the marker: a map teleport would land on the roof.)
await page.evaluate(`window.vicemap.player.place(488, -77.7, 10.2)`);
await page.waitForTimeout(600);
check('the enter prompt appears near a door', (await page.locator('#prompt').textContent())?.includes('Malibu') ?? false);
await page.keyboard.press('f');
await settle();
const f3 = await ext();
check('F enters the Malibu Club', f3.inside === 'malibu' && f3.grounded, `position ${f3.pos.map((v) => v.toFixed(1))}`);
check('the exit button is shown', await page.locator('#exit').isVisible());
await page.screenshot({ path: path.join(dir, 'interior-malibu-hud.png') });
await page.keyboard.press('f');
await settle();
const f4 = await ext();
check('F leaves in front of the door', f4.inside === null && dist2(f4.pos, [491, -77.7]) < 8 && f4.grounded, `position ${f4.pos.map((v) => v.toFixed(1))}`);

// Entering from the map: click on the bank marker.
await page.keyboard.press('m');
await page.waitForTimeout(300);
const bank = [-896.5, -341];
await page.mouse.click(box.x + ((bank[0] + 2000) / 4000) * box.width, box.y + ((2000 - bank[1]) / 4000) * box.height);
await settle();
const f5 = await ext();
check('clicking a map marker enters the building', f5.inside === 'bank', `place ${f5.inside}`);
await page.locator('#exit').click();
await settle();
check('the button leaves the interior', (await ext()).inside === null);

await page.keyboard.press('v');
await page.waitForTimeout(200);
check('V returns to the free camera', (await ext()).mode === 'free');

/* ------------------------------------------------------- HUD display */

check('default: full detail, no LOD', (await page.locator('#controls select').nth(1).inputValue()) === 'hd');
await page.keyboard.press('h');
v = await shown();
check('H: HUD hidden', !v.hud && !v.panel && !v.map);
// The button, though invisible, stays clickable in the corner of the screen.
await page.locator('#hud-toggle').click();
v = await shown();
check('the button brings back the minimap', !v.hud && !v.panel && v.map);
await page.locator('#hud-toggle').click();
v = await shown();
check('then the full HUD', v.hud && v.panel && v.map);
check('the button is an icon with no text', ((await page.locator('#hud-toggle').textContent()) ?? '').trim() === '');
await page.locator('#fullscreen').click();
await page.waitForTimeout(400);
check('the fullscreen button enters fullscreen', (await page.evaluate(`!!document.fullscreenElement`)) as boolean);
await page.locator('#fullscreen').click();
await page.waitForTimeout(400);
check('and leaves it', !((await page.evaluate(`!!document.fullscreenElement`)) as boolean));
await page.reload();
await page.waitForFunction(`!!window.vicemap`, null, { timeout: 60000 });
check('the display choice is kept between visits', (await shown()).hud);
await page.keyboard.press('h');
await page.reload();
await page.waitForFunction(`!!window.vicemap`, null, { timeout: 60000 });
v = await shown();
check('after reload: still hidden', !v.hud && !v.map);

await session.close();
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
