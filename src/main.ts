/**
 * Viewer entry point.
 *
 * URL parameters (all optional), handy for sharing a view and for automated
 * captures:
 *   pos=x,y,z  yaw=deg  pitch=deg   camera position and orientation
 *   tp=<id>                         teleport location
 *   mode=foot                       start on foot (character plus a follow camera)
 *   interior=<id>                   start inside an interior (hotel, malibu, bank...)
 *   time=13.5                       decimal hour
 *   weather=0..6                    weather from timecyc.dat
 *   detail=auto                     like the game: LODs in the distance (default: full detail, no LODs)
 *   preload=0                       load tiles around the camera instead of the whole map
 *   dist=1.2                        draw distance multiplier
 *   fog=0                           disable the game's fog and horizon
 *   hud=map|all|none                minimap only (default), full HUD, or nothing (ui=0 is the same as hud=none)
 *   map=1                           open the full map
 *   rawmouse=0                      classic mouse mode (with OS acceleration)
 *   intro=0                         skip the intro page
 * Diagnostics:
 *   view=top                        orthographic top-down view of the map
 *   center=x,y  span=metres         with view=top: center and height of the framed area
 *   lod=hd|lod                      force all detailed models / all LODs
 *   water=0  bg=ff00ff              hide water, force the background color
 */
import * as THREE from 'three';
import { FORMAT_VERSION, type InteriorInfo, type Manifest, type Teleport } from '../shared/format.ts';
import { Controls } from './controls.ts';
import { Environment, FOG_FADE_DISTANCE } from './environment.ts';
import { InteriorMarkers, type MarkerTarget } from './interiors.ts';
import { CROSSFADE_MS, INTRO_CAMERA, orbitPose, showIntro } from './intro.ts';
import { WorldMaterials, globalUniforms } from './materials.ts';
import { Minimap } from './minimap.ts';
import { Player } from './player.ts';
import { TextureArrays } from './textures.ts';
import type { LodMode, RayHit } from './tile.ts';
import { HUD_MODES, Ui, type HudMode, type MoveMode, type UiModel } from './ui.ts';
import { World } from './world.ts';

const ASSETS = `${import.meta.env.BASE_URL}assets/`;
/** Vertical field of view; close to the game's at 16:9. */
const FOV = 60;
/** Eye height above the ground, for the free camera placed inside an interior. */
const EYE_HEIGHT = 1.7;
/** Distance within which the F key offers to enter a building. */
const INTERACT_DISTANCE = 8;
/** Duration of the flight from the intro orbit down to the starting point, in seconds. */
const FLIGHT_SECONDS = 4.5;
/** Tiles this close to the arrival point are loaded before the flight whatever the direction, in metres. */
const ARRIVAL_RING = 120;
/** Frame rate cap behind the intro page: the orbit is slow, no need for more. */
const INTRO_FPS = 30;
/**
 * Time for the intro orbit to reach full speed, in seconds. It starts as soon
 * as the live view appears: barely moving during the cross-fade, the poster
 * stays aligned with it.
 */
const ORBIT_EASE_IN = 3;

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const num = (k: string, d: number) => (params.has(k) && Number.isFinite(Number(params.get(k))) ? Number(params.get(k)) : d);

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /**
   * Intro page: the viewer starts behind it with the LOD pack only, orbiting
   * the island ('intro'). "Enter Vice City" preloads the whole detailed map
   * while the orbit goes on ('loading'), then the camera flies down to the
   * starting point ('flight') and the visitor takes over ('play').
   */
  const intro = params.get('intro') !== '0' ? showIntro(ASSETS, import.meta.env.BASE_URL) : null;
  let phase: 'intro' | 'loading' | 'flight' | 'play' = intro ? 'intro' : 'play';
  document.body.classList.toggle('intro', !!intro);
  // The viewer starts loading only once the poster has faded in, to keep the fade smooth.
  if (intro) await intro.posterShown;
  /** Errors are shown once the visitor has left the intro page. */
  const fatal = (message: string) => {
    if (intro) void intro.entered.then(() => Ui.fatal(message));
    else Ui.fatal(message);
  };

  let manifest: Manifest;
  try {
    const res = await fetch(`${ASSETS}manifest.json`, { cache: 'no-cache' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as Manifest;
  } catch {
    fatal('<b>Assets not found.</b><br>First convert the game data with <code>npm run build:assets</code>, then reload the page.');
    return;
  }
  if (manifest.version !== FORMAT_VERSION) {
    fatal(`<b>Assets out of date</b> (format ${manifest.version}, expected ${FORMAT_VERSION}).<br>Run <code>npm run build:assets</code> again.`);
    return;
  }

  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    fatal('<b>WebGL 2 unavailable.</b><br>This viewer needs a recent browser with hardware acceleration enabled.');
    return;
  }
  // Same resolution behind the intro (and the poster cross-fade) as afterwards.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // No color space conversion or tone mapping: we reproduce the game's arithmetic.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.sortObjects = true;

  const glc = renderer.getContext();
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('<b>The graphics context was lost</b> (driver reset or video memory full).<br>Reload the page.');
  });
  let textures: TextureArrays;
  try {
    textures = new TextureArrays(renderer, manifest.texClasses, ASSETS);
  } catch (e) {
    fatal(`<b>Graphics card not supported.</b><br>${(e as Error).message}`);
    return;
  }
  const materials = new WorldMaterials(textures, (glc.getParameter(glc.SAMPLES) as number) > 1);
  const world = new World(manifest, ASSETS, materials, textures);
  const env = new Environment(manifest, textures);
  const markers = new InteriorMarkers(manifest.interiors);
  const player = new Player();
  const scene = new THREE.Scene();
  scene.matrixAutoUpdate = false;
  scene.add(env.group, world.group, markers.group, player.group);

  const topView = params.get('view') === 'top';
  const showWater = params.get('water') !== '0';
  const forcedBackground = /^[0-9a-f]{6}$/i.test(params.get('bg') ?? '') ? new THREE.Color(`#${params.get('bg')}`) : null;
  const perspective = new THREE.PerspectiveCamera(FOV, 1, 0.3, 2000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 8000);
  const camera: THREE.Camera = topView ? ortho : perspective;
  const controls = new Controls(canvas);
  controls.rawMouse = params.get('rawmouse') !== '0';
  const seaLevel = manifest.water.seaLevel;

  // The top view is taken from very high up: without a forced mode, every draw distance would be exceeded.
  const forcedLod = (['hd', 'lod'].includes(params.get('lod') ?? '') ? params.get('lod') : topView ? 'hd' : null) as LodMode | null;
  const model: UiModel = {
    hour: ((num('time', 12) % 24) + 24) % 24,
    autoTime: false,
    weather: Math.max(0, Math.min(manifest.timecyc.length - 1, Math.round(num('weather', 0)))),
    drawScale: Math.max(0.5, Math.min(4, num('dist', 1.2))),
    fog: params.get('fog') !== '0' && !topView,
    mode: 'free',
    detail: params.get('detail') === 'auto' ? 'auto' : 'hd',
    // The "LODs only" view needs no tiles at all.
    preload: params.get('preload') !== '0' && forcedLod !== 'lod',
  };

  /* ------------------------------------------------ movement and locations */

  const ray: RayHit = { t: 0, hit: false, nx: 0, ny: 0, nz: 0 };
  /**
   * Pending landing after a teleport: x and y are known, but the ground
   * height is only known once the local geometry has loaded.
   */
  let landing: { x: number; y: number; fromZ: number; heading: number; wait: number } | null = null;
  /** True once the character has left every marker since the last transition. */
  let markerArmed = false;
  let transition = false;

  const currentPosition = () => (model.mode === 'foot' ? player.position : controls.position);

  function land(x: number, y: number, fromZ: number, headingDeg: number): void {
    // Wait two frames: the world must first recompute what is visible at this spot.
    landing = { x, y, fromZ, heading: headingDeg, wait: 2 };
    markerArmed = false;
    if (model.mode === 'foot') player.place(x, y, fromZ - 1, headingDeg * (Math.PI / 180));
    else controls.position.set(x, y, fromZ);
  }

  /** Tries to put the camera or character on the ground; returns true once done. */
  function tryLand(): boolean {
    if (!landing) return true;
    if (landing.wait > 0) {
      landing.wait--;
      return false;
    }
    const { x, y, fromZ, heading } = landing;
    world.raycast(x, y, fromZ, 0, 0, -1, 1200, ray);
    // No ground below this point (open sea): once everything is loaded, land on the surface.
    if (!ray.hit && !world.settled) return false;
    const ground = ray.hit ? Math.max(fromZ - ray.t, seaLevel - 1) : seaLevel - 1;
    if (model.mode === 'foot') player.place(x, y, ground, heading * (Math.PI / 180));
    else controls.position.set(x, y, ground + (world.inside ? EYE_HEIGHT : 20));
    landing = null;
    return true;
  }

  /** Teleport to a named location. */
  function goTo(t: Teleport): void {
    leaveInterior();
    if (model.mode === 'foot') {
      const [x, y, z] = t.foot ?? t.pos;
      controls.yaw = t.yaw;
      controls.pitch = -8;
      land(x, y, z + 3, t.yaw);
    } else {
      landing = null;
      controls.set(t.pos, t.yaw, t.pitch);
    }
  }

  /** Teleport to a point on the map. */
  function teleportTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    leaveInterior();
    if (model.mode !== 'foot') controls.pitch = -20;
    land(x, y, 600, controls.yaw);
  }

  function leaveInterior(): void {
    if (!world.inside) return;
    world.exitInterior();
    ui.setInterior(null);
  }

  async function enterInterior(info: InteriorInfo): Promise<void> {
    if (transition) return;
    transition = true;
    ui.setStatus(`Loading: ${info.label}…`);
    try {
      await world.enterInterior(info);
      ui.setInterior(info.label);
      controls.yaw = info.yaw;
      controls.pitch = 0;
      land(info.spawn[0], info.spawn[1], info.spawn[2] + 1.2, info.yaw);
    } catch (e) {
      world.lastError = (e as Error).message;
    } finally {
      transition = false;
    }
  }

  function exitInterior(): void {
    const info = world.inside;
    if (!info) return;
    leaveInterior();
    // Come out in front of the door, back to the building.
    let dx = info.door[0] - info.spawn[0];
    let dy = info.door[1] - info.spawn[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const yaw = (Math.atan2(dx, dy) * 180) / Math.PI;
    controls.yaw = yaw;
    controls.pitch = 0;
    land(info.door[0] + dx * 3, info.door[1] + dy * 3, info.door[2] + 1.5, yaw);
    if (model.mode !== 'foot') controls.position.z = info.door[2] + 0.7;
  }

  function activate(target: MarkerTarget): void {
    if (target.kind === 'exit') exitInterior();
    else void enterInterior(target.interior);
  }

  function setMode(mode: MoveMode): void {
    if (mode === model.mode || (mode === 'foot' && !player.ready) || topView) return;
    if (mode === 'foot') {
      // The character appears on the ground below the camera, which moves behind them.
      const p = controls.position;
      model.mode = 'foot';
      controls.pitch = Math.max(-35, Math.min(10, controls.pitch));
      land(p.x, p.y, world.inside ? p.z : p.z + 2, controls.yaw);
    } else {
      // The free camera resumes from where the chase camera was.
      controls.position.copy(perspective.position);
      model.mode = 'free';
      landing = null;
    }
    player.group.visible = model.mode === 'foot';
    ui.setMode(model.mode);
    ui.setHelp(keyLabels, controls.locked);
  }

  /* ------------------------------------------------------------ interface */

  const startTeleport = manifest.teleports.find((t) => t.id === params.get('tp')) ?? manifest.teleports[0];
  controls.set(startTeleport.pos, startTeleport.yaw, startTeleport.pitch);
  if (params.has('pos')) {
    const p = params.get('pos')!.split(',').map(Number);
    if (p.length === 3 && p.every(Number.isFinite)) controls.position.set(p[0], p[1], p[2]);
  }
  controls.yaw = num('yaw', controls.yaw);
  controls.pitch = num('pitch', controls.pitch);
  /** Where the flight from the intro orbit ends. */
  const startPose = { pos: controls.position.clone(), yaw: controls.yaw, pitch: controls.pitch };
  const startFocus: [number, number, number] = [startPose.pos.x, startPose.pos.y, startPose.pos.z];
  if (intro) {
    controls.set(INTRO_CAMERA.pos, INTRO_CAMERA.yaw, INTRO_CAMERA.pitch);
    controls.enabled = false;
  }

  let keyLabels: Record<string, string> = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyQ: 'Q', KeyE: 'E' };
  const ui = new Ui(document.getElementById('ui')!, model, manifest.timecyc, manifest.teleports, manifest.player !== null, {
    onChange: () => {},
    onTeleport: goTo,
    onMode: setMode,
    onExitInterior: exitInterior,
    onCycleHud: () => setHud(HUD_MODES[(HUD_MODES.indexOf(hud) + 1) % HUD_MODES.length]),
  });
  // HUD mode: the one from the URL, otherwise the last one chosen.
  const HUD_KEY = 'vicemap.hud';
  const requestedHud = params.get('ui') === '0' ? 'none' : params.get('hud');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(HUD_KEY);
  } catch {
    /* storage unavailable */
  }
  let hud: HudMode = HUD_MODES.find((m) => m === (requestedHud ?? stored)) ?? HUD_MODES[0];
  function setHud(mode: HudMode): void {
    hud = mode;
    ui.setHud(mode);
    try {
      localStorage.setItem(HUD_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }
  ui.setHud(hud);
  void controls.keyLabels().then((k) => {
    keyLabels = k;
    ui.setHelp(k, controls.locked);
  });
  controls.onChange = () => ui.setHelp(keyLabels, controls.locked);

  const minimap = manifest.radar
    ? new Minimap(document.getElementById('ui')!, manifest.radar, ASSETS, manifest.interiors, manifest.teleports, {
        onTeleport: teleportTo,
        onEnter: (it) => void enterInterior(it),
        onToggle: (open) => {
          controls.enabled = !open;
          if (open) controls.unlock();
        },
      })
    : null;

  const pickRaycaster = new THREE.Raycaster();
  controls.onClick = (nx, ny) => {
    if (topView || phase !== 'play') return true;
    pickRaycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const target = markers.pick(pickRaycaster.ray, world.inside);
    if (!target) return false;
    activate(target);
    return true;
  };
  controls.onWheel = (direction) => {
    if (model.mode !== 'foot') return false;
    player.cameraDistance = Math.max(1.8, Math.min(18, player.cameraDistance * Math.pow(1.12, -direction)));
    return true;
  };
  /** Marker within reach of the F key: the exit when inside, otherwise the nearest door. */
  function nearbyTarget(): MarkerTarget | null {
    if (world.inside) return { kind: 'exit' };
    return markers.at(currentPosition(), null, INTERACT_DISTANCE);
  }
  controls.onKey = (key) => {
    if (phase !== 'play') return;
    if (key === 'm') minimap?.toggle(!minimap.open);
    else if (key === 'Escape') minimap?.toggle(false);
    else if (minimap?.open) return;
    else if (key === 'h') setHud(HUD_MODES[(HUD_MODES.indexOf(hud) + 1) % HUD_MODES.length]);
    else if (key === 'v') setMode(model.mode === 'foot' ? 'free' : 'foot');
    else if (key === 'f') {
      const target = nearbyTarget();
      if (target) activate(target);
    }
  };

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    perspective.aspect = w / h;
    perspective.updateProjectionMatrix();
    // Top view: the whole map, north up, framed on the extent of the instances.
    const { min, max } = manifest.bounds;
    let cx = (min[0] + max[0]) / 2;
    let cy = (min[1] + max[1]) / 2;
    const margin = 1.04;
    let halfW = ((max[0] - min[0]) / 2) * margin;
    let halfH = ((max[1] - min[1]) / 2) * margin;
    if (halfW / halfH < w / h) halfW = halfH * (w / h);
    else halfH = halfW / (w / h);
    const center = (params.get('center') ?? '').split(',').map(Number);
    if (center.length === 2 && center.every(Number.isFinite)) [cx, cy] = center;
    if (params.has('span')) {
      halfH = num('span', halfH * 2) / 2;
      halfW = halfH * (w / h);
    }
    ortho.left = -halfW;
    ortho.right = halfW;
    ortho.top = halfH;
    ortho.bottom = -halfH;
    ortho.position.set(cx, cy, 4000);
    ortho.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  /* ----------------------------------------------------------------- loop */

  ui.setStatus('Loading the distant map…');
  const farLoaded = world.loadFar(manifest.far.file).catch((e: Error) => {
    fatal(`<b>Loading failed.</b><br>${e.message}`);
    throw e;
  });
  const playerLoaded = manifest.player
    ? player.load(ASSETS + manifest.player, textures).catch((e: Error) => console.error('Character not loaded', e))
    : Promise.resolve();

  let last = performance.now();
  let fps = 0;
  let frameMs = 0;
  let frames = 0;
  let accum = 0;
  let settledFrames = 0;
  /** CPU time of the last renderer.render() call (includes first-draw buffer uploads), in ms. */
  let lastRenderMs = 0;

  /* Intro orbit, preloading, then the flight down once the visitor has entered. */
  const orbitCenter = [(manifest.bounds.min[0] + manifest.bounds.max[0]) / 2, (manifest.bounds.min[1] + manifest.bounds.max[1]) / 2];
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  let orbitTime = 0;
  /** Time the live view replaced the poster (ms), or null. */
  let liveAt: number | null = null;
  /**
   * Time driving the water animation. Behind the intro it stays at 0, like
   * the poster (rendered with wtime=0), until the cross-fade is over.
   */
  let waterTime = num('wtime', 0);
  let flight: { t: number; k: number; from: { pos: THREE.Vector3; yaw: number; pitch: number } } | null = null;
  let flightDone: () => void = () => {};
  const flightOver = new Promise<void>((resolve) => (flightDone = resolve));
  /** Tiles the arrival view shows, computed on the click (see arrivalTileSet). */
  let arrivalTiles: ReadonlySet<number> = new Set();
  void intro?.entered.then(() => {
    arrivalTiles = arrivalTileSet();
    phase = 'loading';
    textures.allocateAll();
  });

  /**
   * Tiles visible from the arrival point: those in its view frustum, up to
   * the fog distance (full detail draws every model that far), plus a small
   * ring around it. Nothing behind the camera or beyond the fog.
   */
  function arrivalTileSet(): ReadonlySet<number> {
    const view = perspective.clone();
    view.fov = FOV + 10; // a little margin on the sides
    view.near = 0.3;
    view.far = env.state.farClip + 50;
    view.updateProjectionMatrix();
    const [yaw, pitch] = [controls.yaw, controls.pitch];
    controls.yaw = startPose.yaw;
    controls.pitch = startPose.pitch;
    controls.applyOrientation(view);
    [controls.yaw, controls.pitch] = [yaw, pitch];
    view.position.copy(startPose.pos);
    view.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse));
    const box = new THREE.Box3();
    const set = new Set<number>();
    world.tiles.forEach((t, i) => {
      if (t.info.count === 0) return;
      box.min.fromArray(t.info.min);
      box.max.fromArray(t.info.max);
      if (frustum.intersectsBox(box) || box.distanceToPoint(startPose.pos) < ARRIVAL_RING) set.add(i);
    });
    return set;
  }

  /** After the click: once the arrival spot is loaded and every shader compiled, the flight starts. */
  /**
   * 'fetch': loading the arrival tiles. 'warm': drawing them a few frames in
   * the final mode, still behind the loader: the first draw of a model sends
   * its buffers to the GPU, a long freeze that would otherwise hit the flight.
   * 'compile': compiling every shader. 'done'.
   */
  let loadState: 'fetch' | 'warm' | 'compile' | 'done' = 'fetch';
  let warmFrames = 0;
  function loadStep(): void {
    const s = world.stats;
    if (loadState === 'fetch') {
      intro?.setProgress(s.tilesWanted ? (0.9 * s.tilesReady) / s.tilesWanted : 0);
      if (world.settled && s.tilesWanted > 0) loadState = 'warm';
      return;
    }
    if (loadState === 'warm') {
      intro?.setProgress(0.95);
      if (!world.settled || ++warmFrames < 3) return;
    }
    if (loadState !== 'warm') return;
    loadState = 'compile';
    void renderer
      .compileAsync(scene, perspective)
      .catch(() => {})
      .then(() => {
        loadState = 'done';
        intro?.setProgress(1);
        phase = 'flight';
        flight = { t: 0, k: 0, from: { pos: controls.position.clone(), yaw: controls.yaw, pitch: controls.pitch } };
        intro?.leave();
      });
  }

  function flyStep(dt: number): void {
    if (!flight) return;
    flight.t += dt;
    const k = reducedMotion ? 1 : Math.min(1, flight.t / FLIGHT_SECONDS);
    flight.k = k;
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const { from } = flight;
    const turn = ((((startPose.yaw - from.yaw) % 360) + 540) % 360) - 180;
    controls.position.lerpVectors(from.pos, startPose.pos, e);
    controls.yaw = from.yaw + turn * e;
    controls.pitch = from.pitch + (startPose.pitch - from.pitch) * e;
    if (k < 1) return;
    flight = null;
    phase = 'play';
    controls.enabled = !minimap?.open;
    document.body.classList.remove('intro');
    flightDone();
  }

  function frame(now: number): void {
    if (phase === 'intro' && now - last < 1000 / INTRO_FPS - 2) {
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frames++;
    accum += dt;
    if (accum >= 0.5) {
      fps = frames / accum;
      frameMs = (accum / frames) * 1000;
      frames = 0;
      accum = 0;
    }

    if (model.autoTime) ui.setHour((model.hour + dt / 60) % 24);
    env.hour = model.hour;
    env.weather = model.weather;
    // From the sky, the game's fog would hide the island: it rolls in during the flight down.
    const fog = model.fog && (phase === 'flight' || phase === 'play');
    env.fogEnabled = fog;
    env.fogAmount = phase === 'flight' && flight ? smoothstep(0.3, 1, flight.k) : 1;
    world.drawScale = model.drawScale;
    // Intro: the LOD pack only. Preloading: only the tiles seen from the
    // arrival point, nearest first, drawn as in the game (LODs in the distance)
    // behind the loader. Flight: already in the chosen mode, so nothing pops in
    // on landing; nothing else loads during the flight, so it stays smooth.
    // Then the rest of the map streams in.
    world.preload = phase === 'intro' ? false : model.preload;
    world.lodMode = phase === 'intro' ? 'lod' : phase === 'loading' && loadState === 'fetch' ? 'auto' : (forcedLod ?? model.detail);
    world.loadFocus = startFocus;
    world.loadOnly = phase === 'loading' || phase === 'flight' ? arrivalTiles : null;
    const fadedIn = liveAt !== null && now - liveAt > CROSSFADE_MS;
    if (phase === 'intro' || phase === 'loading') {
      const pose = orbitPose(orbitTime, orbitCenter[0], orbitCenter[1]);
      controls.set(pose.pos, pose.yaw, pose.pitch);
      // The orbit starts with the live view, easing in.
      if (liveAt !== null && !reducedMotion) orbitTime += dt * smoothstep(0, ORBIT_EASE_IN * 1000, now - liveAt);
      if (phase === 'loading') loadStep();
    } else if (phase === 'flight') flyStep(dt);
    if (!params.has('wtime') && (phase !== 'intro' || fadedIn)) waterTime += dt;

    const landed = tryLand();
    if (!topView) {
      controls.applyOrientation(perspective);
      if (model.mode === 'foot') {
        if (landed) {
          const a = controls.axes();
          player.update(dt, { forward: a.forward, right: a.right, sprint: a.sprint }, controls.yaw, world, seaLevel);
        }
        player.applyCamera(perspective, controls.yaw, controls.pitch, world);
      } else {
        if (landed) controls.updateFree(dt);
        perspective.position.copy(controls.position);
      }
      const far = fog ? env.state.farClip + (1 - env.fogAmount) * FOG_FADE_DISTANCE : 12000;
      // Without fog, the view reaches kilometres away: the near plane moves out
      // with altitude, otherwise the depth buffer lacks precision at a distance
      // (flickering between the water surface and the seabed just below).
      const near = fog && env.fogAmount >= 1 ? 0.3 : Math.round(Math.max(1, Math.min(100, (perspective.position.z - seaLevel) / 20)));
      if (perspective.far !== far || perspective.near !== near) {
        perspective.far = far;
        perspective.near = near;
        perspective.updateProjectionMatrix();
      }
    }
    camera.updateMatrixWorld();
    env.sky.visible = !topView;
    env.water.visible = showWater;
    env.underlay.visible = showWater;
    env.update(camera);
    if (forcedBackground) env.clearColor.copy(forcedBackground);
    globalUniforms.uTime.value = waterTime;
    world.update(camera.position.x, camera.position.y, camera.position.z, Math.floor(model.hour));
    // Behind the loader, upload fast; in play, a few ms per frame so as not to stutter.
    textures.flushUploads(phase === 'loading' ? 50 : 4);
    markers.update(now / 1000, camera.position, world.inside);

    // Markers: the character enters by walking into them; otherwise the F key works nearby.
    const here = currentPosition();
    if (landed && !transition && model.mode === 'foot') {
      const under = markers.at(here, world.inside);
      if (!under) markerArmed = true;
      else if (markerArmed) {
        markerArmed = false;
        activate(under);
      }
    }
    const near = !topView && landed ? nearbyTarget() : null;
    ui.setPrompt(near && near.kind === 'enter' ? `F: enter — ${near.interior.label}` : '');

    renderer.setClearColor(env.clearColor);
    const renderStart = performance.now();
    renderer.render(scene, camera);
    lastRenderMs = performance.now() - renderStart;
    settledFrames = world.settled && landed && !transition ? settledFrames + 1 : 0;
    if (phase === 'intro' && liveAt === null && settledFrames >= 3) {
      liveAt = now;
      intro?.goLive();
    }

    const s = world.stats;
    ui.setHudData({
      x: here.x,
      y: here.y,
      z: here.z,
      yaw: controls.yaw,
      fps,
      frameMs,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      tiles: `${s.tilesReady} / ${world.tiles.length}`,
      instances: s.instancesShown,
      speed: model.mode === 'foot' ? 0 : controls.speed,
      place: world.inside ? world.inside.label : 'Outdoors',
    });
    minimap?.update({ x: here.x, y: here.y, yaw: controls.yaw, heading: model.mode === 'foot' ? (player.heading * 180) / Math.PI : controls.yaw });
    ui.setStatus(
      world.lastError && s.tilesMissing > 0
        ? `Loading error, retrying: ${world.lastError}`
        : s.tilesMissing > 0
          ? `Loading the map: ${s.tilesReady} / ${s.tilesWanted} tiles…`
          : world.far
            ? ''
            : 'Loading the distant map…',
    );
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  await Promise.all([farLoaded, playerLoaded]);
  if (intro) await flightOver;

  const startInterior = manifest.interiors.find((i) => i.id === params.get('interior'));
  if (params.get('mode') === 'foot') setMode('foot');
  if (startInterior) await enterInterior(startInterior);
  if (params.get('map') === '1') minimap?.toggle(true);

  // Small diagnostics API, used by the capture and benchmark scripts.
  const debugInfo = glc.getExtension('WEBGL_debug_renderer_info');
  const api = {
    manifest,
    world,
    controls,
    player,
    model,
    /** True when the current view has been fully loaded and displayed for a few frames. */
    settled: () => settledFrames >= 3,
    gpu: () => (debugInfo ? String(glc.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'unknown'),
    softwareTextures: () => textures.usesSoftwareDecoding,
    info: () => ({
      fps,
      frameMs,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textureBytes: textures.bytesLoaded,
      maxTextureUploadMs: textures.maxUploadMs,
      programs: renderer.info.programs?.length ?? 0,
      uploadMs: textures.lastFlushMs,
      renderMs: lastRenderMs,
      ...world.stats,
      pos: currentPosition().toArray(),
      camera: camera.position.toArray(),
      yaw: controls.yaw,
      pitch: controls.pitch,
      hour: model.hour,
      mode: model.mode,
      inside: world.inside?.id ?? null,
      grounded: player.grounded,
    }),
    setView(v: { pos?: [number, number, number]; yaw?: number; pitch?: number; time?: number; tp?: string }) {
      const t = manifest.teleports.find((x) => x.id === v.tp);
      if (t) goTo(t);
      if (v.pos) controls.position.set(...v.pos);
      if (v.yaw !== undefined) controls.yaw = v.yaw;
      if (v.pitch !== undefined) controls.pitch = v.pitch;
      if (v.time !== undefined) ui.setHour(v.time);
      settledFrames = 0;
    },
    setMode,
    teleportTo,
    enter: (id: string) => {
      const it = manifest.interiors.find((i) => i.id === id);
      return it ? enterInterior(it) : Promise.reject(new Error(`unknown interior: ${id}`));
    },
    exit: exitInterior,
    /** Average frame time in ms, measured over n consecutive renders without waiting for the display. */
    bench(n = 200) {
      const pixel = new Uint8Array(4);
      const t = performance.now();
      for (let i = 0; i < n; i++) renderer.render(scene, camera);
      // Reading a pixel forces the GPU to finish all pending work.
      glc.readPixels(0, 0, 1, 1, glc.RGBA, glc.UNSIGNED_BYTE, pixel);
      const ms = (performance.now() - t) / n;
      return { ms, fps: 1000 / ms, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
    /** Model under a screen point (normalized coordinates -1..1). */
    pick(nx = 0, ny = 0) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
      const hit = world.pick(rc);
      return hit ? { model: hit.model, distance: hit.distance, point: hit.point.toArray() } : null;
    },
  };
  (window as unknown as { vicemap: typeof api }).vicemap = api;
}

void start();
