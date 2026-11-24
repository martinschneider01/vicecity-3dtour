/**
 * Intro page: what the project is, where it comes from, and who owns the
 * content. Behind it, the map seen from the sky:
 *   1. first the poster (public/intro.jpg, rendered by `npm run intro-image`
 *      from INTRO_CAMERA), shown instantly;
 *   2. then, once the viewer has loaded the LOD pack (a few MB), the live 3D
 *      view slowly orbiting the island, cross-faded over the poster;
 *   3. "Enter Vice City" turns into a progress bar while the viewer preloads
 *      the whole detailed map; then the page fades out and the camera flies
 *      down to the starting point, fog rolling in.
 * Without the poster, a CSS sunset is shown instead.
 */

/** Camera of the poster, where the 3D orbit starts (game coordinates, degrees). */
export const INTRO_CAMERA = { pos: [2350, -1350, 1550] as [number, number, number], yaw: -80, pitch: -37 };
/** Orbit speed around the island, in degrees per second (a full turn in 6 minutes). */
export const ORBIT_SPEED = 1;

const GITHUB_URL = 'https://github.com/martinschneider01';
const GITHUB_NAME = 'martinschneider01';
const REPO_URL = 'https://github.com/martinschneider01/vicecity-3dtour';

const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

export interface Intro {
  /** Resolves when the visitor clicks "Enter Vice City"; the button then shows the loading progress. */
  readonly entered: Promise<void>;
  /**
   * Resolves once the poster has finished fading in (or right away without
   * one): the viewer starts loading only then, so the fade stays smooth.
   */
  readonly posterShown: Promise<void>;
  /** The live 3D view is ready: cross-fades from the poster to it. */
  goLive(): void;
  /** Loading progress after the click, 0 to 1. */
  setProgress(fraction: number): void;
  /** Everything is loaded: fades the page out and removes it. */
  leave(): void;
}

/** Duration of the poster to live view cross-fade, in ms (see #intro.live .intro-bg in style.css). */
export const CROSSFADE_MS = 1500;
/** Duration of the poster fade-in, in ms (see .intro-bg in style.css). */
const POSTER_FADE_MS = 800;

/**
 * Camera pose of the intro orbit after t seconds (t in "orbit seconds": the
 * caller eases it in, so the camera starts moving smoothly): around the island centre,
 * keeping the poster's height, pitch and framing (island in the right half).
 */
export function orbitPose(t: number, cx: number, cy: number): { pos: [number, number, number]; yaw: number; pitch: number } {
  const [x0, y0, z] = INTRO_CAMERA.pos;
  const DEG = Math.PI / 180;
  const radius = Math.hypot(x0 - cx, y0 - cy);
  const angle = Math.atan2(y0 - cy, x0 - cx) - t * ORBIT_SPEED * DEG;
  const x = cx + Math.cos(angle) * radius;
  const y = cy + Math.sin(angle) * radius;
  // Heading towards the centre (0 = north, 90 = east), plus the poster's offset.
  const bearing = (p: number, q: number) => Math.atan2(cx - p, cy - q) / DEG;
  const yaw = bearing(x, y) + (INTRO_CAMERA.yaw - bearing(x0, y0));
  return { pos: [x, y, z], yaw, pitch: INTRO_CAMERA.pitch };
}

/**
 * @param assets URL of the converted assets folder (for the logo)
 * @param base   site base URL (for the intro.jpg poster)
 */
export function showIntro(assets: string, base: string): Intro {
  const root = document.createElement('div');
  root.id = 'intro';
  root.innerHTML = `
    <img class="intro-bg" src="${base}intro-2560.jpg" srcset="${base}intro-2560.jpg 2560w, ${base}intro.jpg 5120w" sizes="237vh" alt="" />
    <div class="intro-shade"></div>
    <div class="intro-card" role="dialog" aria-labelledby="intro-title">
      <h1 id="intro-title">
        <img class="intro-logo" src="${assets}logo.png" alt="Vice City" />
        <span class="intro-logo-text" hidden>Vice City</span>
      </h1>
      <p class="intro-tagline">A 3D tour of the 2002 map, right in your browser</p>

      <p>
        After playing GTA&nbsp;VI, I was hit by a wave of nostalgia: I wanted to wander the streets of
        the old Vice City again, without having to launch the game. So I built this viewer. It reads the
        original game's data and lets you roam the whole map freely, with a flying camera or on foot as
        Tommy, at any hour and in any weather.
      </p>
      <p class="intro-note">
        <b>Heads-up: the rendering is not 100% faithful.</b> Everything is redrawn by a homemade engine
        from the game's files, so lighting, fog, water and some details differ from what you remember.
      </p>
      <p class="intro-legal">
        All content shown in this app (the map, models, textures, characters, logo and the names
        Grand Theft Auto and Vice City) belongs to <b>Rockstar Games</b> and <b>Take-Two Interactive</b>.
        This is an unofficial, non-commercial fan project, not affiliated with or endorsed by them.
      </p>
      <p class="intro-credits">
        This project is entirely vibe-coded, and it stands on open source work. Thanks to
        <a href="https://threejs.org" target="_blank" rel="noopener noreferrer">three.js</a> for the
        rendering, <a href="https://github.com/BinomialLLC/basis_universal" target="_blank" rel="noopener noreferrer">Basis Universal</a>
        for the textures, Vite, TypeScript and Playwright for the tooling, and above all to the GTA
        modding community: the <a href="https://gtamods.com/wiki" target="_blank" rel="noopener noreferrer">GTAMods wiki</a>
        and the re3 / reVC reverse-engineering projects documented the game's file formats and
        engine, which is what made decoding the map possible.
      </p>
      <p class="intro-thanks">
        Thank you, Rockstar, for these magnificent games, and congratulations on the launch of
        GTA&nbsp;VI.
      </p>

      <button type="button" class="intro-enter">Enter Vice City</button>
      <div class="intro-links">
        <a class="intro-github" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
          ${GITHUB_ICON}<span>Made by ${GITHUB_NAME}</span>
        </a>
        <a class="intro-github" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">
          <span>Source code on GitHub</span>
        </a>
      </div>
    </div>`;
  document.body.append(root);

  const logo = root.querySelector<HTMLImageElement>('.intro-logo')!;
  // Without converted assets, a text title replaces the game's logo.
  logo.addEventListener('error', () => {
    logo.hidden = true;
    root.querySelector<HTMLElement>('.intro-logo-text')!.hidden = false;
  });

  // The poster fades in once loaded; without it, the CSS sunset stays until the 3D view.
  const bg = root.querySelector<HTMLImageElement>('.intro-bg')!;
  // Decoded, then drawn once almost transparent, before the fade starts: the
  // first paint of a 5120 x 2160 image (decoding, upload to the GPU) takes
  // a long frame, which would otherwise freeze the fade.
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
  const posterShown = bg
    .decode()
    .then(async () => {
      bg.style.transition = 'none';
      bg.style.opacity = '0.01';
      // Until a few frames in a row come back on time (the compositor has
      // caught up), at most a second.
      const t0 = performance.now();
      let calm = 0;
      let last = await frame().then(() => performance.now());
      while (calm < 6 && performance.now() - t0 < 1000) {
        await frame();
        const now = performance.now();
        calm = now - last < 25 ? calm + 1 : 0;
        last = now;
      }
      bg.style.transition = '';
      bg.style.opacity = '';
      root.classList.add('has-bg');
      await new Promise((r) => setTimeout(r, POSTER_FADE_MS + 100));
    })
    .catch(() => bg.remove());

  const button = root.querySelector<HTMLButtonElement>('.intro-enter')!;
  button.focus();
  const entered = new Promise<void>((resolve) => {
    button.addEventListener('click', () => {
      button.disabled = true;
      button.classList.add('loading');
      button.setAttribute('aria-busy', 'true');
      button.innerHTML = '<span class="intro-spinner" aria-hidden="true"></span><span class="intro-progress-label">Loading Vice City… 0%</span><span class="intro-progress"></span>';
      resolve();
    });
  });
  return {
    entered,
    posterShown,
    goLive: () => root.classList.add('live'),
    setProgress(fraction) {
      const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      const label = root.querySelector('.intro-progress-label');
      if (label) label.textContent = `Loading Vice City… ${pct}%`;
      root.querySelector<HTMLElement>('.intro-progress')?.style.setProperty('--progress', `${pct}%`);
    },
    leave() {
      root.classList.add('leaving');
      // Removed after its fade-out (see #intro.leaving in style.css).
      setTimeout(() => root.remove(), 700);
    },
  };
}
