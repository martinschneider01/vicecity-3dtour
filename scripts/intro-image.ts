/**
 * Renders the aerial views of the whole map. Derived from the game: the
 * outputs are ignored by git, like the assets.
 *   npm run intro-image                     the default views below
 *   npx tsx scripts/intro-image.ts "<view query>" output.jpg [more pairs...]
 *
 * public/intro.jpg is the intro page poster, cross-faded into the live 3D
 * view: it is rendered exactly like that view (same camera, LOD pack only,
 * water animation frozen at 0, no fog), only wider than any screen, since the
 * page fits it to the window height as the 3D camera does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { INTRO_CAMERA } from '../src/intro.ts';
import { ROOT, gotoView, openSession } from './lib/browser.ts';

/** Shared by the views: noon, no game fog (it would hide the island from this high). */
const COMMON = 'time=12&weather=0&fog=0';
const INTRO_VIEW = `pos=${INTRO_CAMERA.pos.join(',')}&yaw=${INTRO_CAMERA.yaw}&pitch=${INTRO_CAMERA.pitch}&${COMMON}&lod=lod&preload=0&wtime=0`;
/** The whole island centred, closer, every detailed model: a wallpaper-style shot. */
const AERIAL_VIEW = `pos=1500,-1250,900&yaw=-62&pitch=-36&${COMMON}&detail=hd`;

interface Job {
  query: string;
  out: string;
  /** Viewport in CSS pixels. */
  width: number;
  height: number;
  /** Device scale factor: the image is width * scale pixels wide. */
  scale: number;
}

const args = process.argv.slice(2);
const jobs: Job[] = [];
if (args.length === 0) {
  // 2560 x 1080 CSS pixels: covers windows up to 21:9; narrower ones crop the
  // sides. Two sizes: the page picks the one matching the screen (srcset), a
  // 5120-pixel image is costly to show on a standard screen.
  jobs.push({ query: INTRO_VIEW, out: path.join(ROOT, 'public', 'intro.jpg'), width: 2560, height: 1080, scale: 2 });
  jobs.push({ query: INTRO_VIEW, out: path.join(ROOT, 'public', 'intro-2560.jpg'), width: 2560, height: 1080, scale: 1 });
  jobs.push({ query: AERIAL_VIEW, out: path.join(ROOT, 'public', 'aerial.jpg'), width: 1920, height: 1080, scale: 2 });
}
for (let i = 0; i + 1 < args.length; i += 2) jobs.push({ query: args[i], out: path.resolve(args[i + 1]), width: 1920, height: 1080, scale: 2 });

for (const scale of [...new Set(jobs.map((j) => j.scale))]) {
  const session = await openSession({ width: 1920, height: 1080, scale });
  try {
    console.log(`GPU: ${session.gpu}`);
    for (const job of jobs.filter((j) => j.scale === scale)) {
      await session.page.setViewportSize({ width: job.width, height: job.height });
      await gotoView(session, `${job.query}&ui=0`);
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      await session.page.screenshot({ path: job.out, type: 'jpeg', quality: 88 });
      console.log(`${path.relative(ROOT, job.out)} (${job.width * scale}x${job.height * scale})  ←  ${job.query}`);
    }
  } finally {
    await session.close();
  }
}
