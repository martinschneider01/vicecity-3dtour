/**
 * Keyboard and mouse input, shared by both movement modes.
 *
 * - Free camera: WASD (physical keys, so ZQSD on AZERTY), mouse with pointer
 *   lock, Q/E (physical; A/E on AZERTY) to go down and up, Shift to speed up,
 *   wheel to adjust the speed.
 * - On foot: same keys to run, the mouse orbits the camera around the
 *   character, Shift to sprint, wheel for the camera distance.
 *
 * Everything is expressed in the game's frame: X east, Y north, Z up.
 * Heading is 0 towards north and increases towards east.
 */
import * as THREE from 'three';

const DEG = Math.PI / 180;
const _qz = new THREE.Quaternion();
const _qx = new THREE.Quaternion();
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const AXIS_X = new THREE.Vector3(1, 0, 0);
/**
 * Mouse "spike" filter. Under pointer lock, Chromium sometimes sends a bogus
 * movement (several hundred pixels at once), which made the camera snap
 * around. A genuine fast gesture ramps up over several events; a spike is
 * isolated. So we reject a movement much larger than the previous one, or a
 * very large one after a pause.
 */
const SPIKE_AFTER_PAUSE = 250;
const SPIKE_MIN = 80;
const SPIKE_RATIO = 5;
const PAUSE_MS = 60;

export class Controls {
  /** Free camera position. */
  readonly position = new THREE.Vector3();
  /** View heading and pitch in degrees. */
  yaw = 0;
  pitch = 0;
  /** Base free camera speed, in metres per second. */
  speed = 40;
  readonly minSpeed = 2;
  readonly maxSpeed = 2000;
  sprintFactor = 4;
  mouseSensitivity = 0.12;
  locked = false;
  /** False while a panel (the full map) has focus: movement keys are ignored. */
  enabled = true;
  onChange: (() => void) | null = null;
  /** Click in the view. Returns true if the click was consumed (otherwise the mouse is captured). */
  onClick: ((nx: number, ny: number) => boolean) | null = null;
  /** Wheel: -1 or +1. Returns true if it was consumed (otherwise it adjusts the speed). */
  onWheel: ((direction: number) => boolean) | null = null;
  /** Action key pressed: the lowercase letter ("v"), or the key name ("Escape"). */
  onKey: ((code: string) => void) | null = null;
  /**
   * Raw mouse movement (without OS acceleration), when the browser supports
   * it: smoother, and without the spikes of classic mode.
   */
  rawMouse = true;
  private readonly keys = new Set<string>();
  private readonly dom: HTMLElement;
  /** Mouse events to ignore right after capture (the first one carries a meaningless delta). */
  private skipMoves = 0;
  private lastMoveSize = 0;
  private lastMoveTime = 0;

  constructor(dom: HTMLElement) {
    this.dom = dom;
    dom.addEventListener('click', (e) => {
      // Mouse captured: the click targets the center of the screen.
      const rect = dom.getBoundingClientRect();
      const nx = this.locked ? 0 : ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = this.locked ? 0 : 1 - ((e.clientY - rect.top) / rect.height) * 2;
      if (this.onClick?.(nx, ny)) return;
      if (!this.locked) this.lock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === dom;
      this.skipMoves = 1;
      this.lastMoveSize = 0;
      if (!this.locked) this.keys.clear();
      this.onChange?.();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      if (this.skipMoves > 0) {
        this.skipMoves--;
        return;
      }
      const size = Math.hypot(e.movementX, e.movementY);
      const paused = e.timeStamp - this.lastMoveTime > PAUSE_MS;
      this.lastMoveTime = e.timeStamp;
      const spike = paused ? size > SPIKE_AFTER_PAUSE : size > SPIKE_MIN && size > SPIKE_RATIO * this.lastMoveSize + SPIKE_MIN;
      if (spike) return;
      this.lastMoveSize = size;
      this.yaw += e.movementX * this.mouseSensitivity;
      this.pitch = Math.max(-89, Math.min(89, this.pitch - e.movementY * this.mouseSensitivity));
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'].includes(e.code)) e.preventDefault();
      // Action keys are identified by their letter (V, M, F), whatever the layout.
      this.onKey?.(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const direction = -Math.sign(e.deltaY);
        if (direction === 0 || this.onWheel?.(direction)) return;
        this.speed = Math.max(this.minSpeed, Math.min(this.maxSpeed, this.speed * Math.pow(1.15, direction)));
        this.onChange?.();
      },
      { passive: false },
    );
  }

  /** Captures the mouse, without OS acceleration if possible (raw movement, smoother). */
  lock(): void {
    type RawLock = (options?: { unadjustedMovement?: boolean }) => Promise<void> | undefined;
    const request = this.dom.requestPointerLock.bind(this.dom) as RawLock;
    try {
      const p = this.rawMouse ? request({ unadjustedMovement: true }) : request();
      // Rejected (option unsupported, or exited too recently): silently retry without the option.
      if (p) p.catch(() => Promise.resolve(request()).catch(() => undefined));
    } catch {
      /* browser without pointer lock */
    }
  }

  unlock(): void {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  private key(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.keys.has(c));
  }

  /** Forward/back, right/left, up/down: -1, 0 or 1 each. */
  axes(): { forward: number; right: number; up: number; sprint: boolean } {
    return {
      forward: (this.key('KeyW', 'ArrowUp') ? 1 : 0) - (this.key('KeyS', 'ArrowDown') ? 1 : 0),
      right: (this.key('KeyD', 'ArrowRight') ? 1 : 0) - (this.key('KeyA', 'ArrowLeft') ? 1 : 0),
      up: (this.key('KeyE', 'Space') ? 1 : 0) - (this.key('KeyQ') ? 1 : 0),
      sprint: this.key('ShiftLeft', 'ShiftRight'),
    };
  }

  /** Advances the free camera by dt seconds according to the keys held. */
  updateFree(dt: number): void {
    const a = this.axes();
    if (a.forward === 0 && a.right === 0 && a.up === 0) return;
    // Speed stays the same diagonally.
    const step = (this.speed * (a.sprint ? this.sprintFactor : 1) * dt) / Math.hypot(a.forward, a.right, a.up);
    const yaw = this.yaw * DEG;
    const pitch = this.pitch * DEG;
    const cp = Math.cos(pitch);
    // forward = view direction, right = horizontal, up = world Z axis
    this.position.x += (Math.sin(yaw) * cp * a.forward + Math.cos(yaw) * a.right) * step;
    this.position.y += (Math.cos(yaw) * cp * a.forward - Math.sin(yaw) * a.right) * step;
    this.position.z += (Math.sin(pitch) * a.forward + a.up) * step;
  }

  /** Orients a three.js camera according to the current heading and pitch. */
  applyOrientation(camera: THREE.Camera): void {
    // A three.js camera looks down -Z with +Y up. A rotation of
    // (90° + pitch) around X makes it look towards +Y (north) with +Z up;
    // the heading then rotates around Z.
    _qz.setFromAxisAngle(AXIS_Z, -this.yaw * DEG);
    _qx.setFromAxisAngle(AXIS_X, (90 + this.pitch) * DEG);
    camera.quaternion.copy(_qz).multiply(_qx);
  }

  set(pos: [number, number, number], yaw: number, pitch: number): void {
    this.position.set(pos[0], pos[1], pos[2]);
    this.yaw = yaw;
    this.pitch = pitch;
  }

  /** Key labels for the actual keyboard layout (AZERTY, QWERTY...). */
  async keyLabels(): Promise<Record<string, string>> {
    const codes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'];
    const labels: Record<string, string> = Object.fromEntries(codes.map((c) => [c, c.slice(3)]));
    try {
      const kb = (navigator as unknown as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
      const map = await kb?.getLayoutMap();
      if (map) for (const c of codes) labels[c] = (map.get(c) ?? labels[c]).toUpperCase();
    } catch {
      /* API missing: keep the QWERTY labels */
    }
    return labels;
  }
}
