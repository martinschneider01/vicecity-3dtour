/**
 * Minimap and full map, drawn from the game's radar.
 *
 * The minimap (bottom left) is centered on the current position and rotates
 * with the view, as in the game. Clicking enlarges it: the full map shows all
 * of Vice City, north up; clicking a spot teleports there, clicking a pink
 * marker enters the building.
 */
import type { InteriorInfo, RadarInfo, Teleport } from '../shared/format.ts';

const DEG = Math.PI / 180;
const PINK = '#ff4fb8';
/** Ground radius covered by the minimap, in metres. */
const MINI_RANGE = 230;

export interface MapState {
  x: number;
  y: number;
  /** View heading in degrees (0 = north). */
  yaw: number;
  /** Character heading in degrees when on foot, otherwise the view heading. */
  heading: number;
}

export interface MapCallbacks {
  onTeleport(x: number, y: number): void;
  onEnter(interior: InteriorInfo): void;
  onToggle(open: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

export class Minimap {
  open = false;
  private readonly radar: RadarInfo;
  private readonly interiors: InteriorInfo[];
  private readonly teleports: Teleport[];
  private readonly image = new Image();
  private loaded = false;
  private readonly mini: HTMLCanvasElement;
  private readonly big: HTMLCanvasElement;
  private readonly overlay: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly cb: MapCallbacks;
  private state: MapState = { x: 0, y: 0, yaw: 0, heading: 0 };
  private hover: InteriorInfo | null = null;

  constructor(root: HTMLElement, radar: RadarInfo, baseUrl: string, interiors: InteriorInfo[], teleports: Teleport[], cb: MapCallbacks) {
    this.radar = radar;
    this.interiors = interiors;
    this.teleports = teleports;
    this.cb = cb;
    this.image.onload = () => (this.loaded = true);
    this.image.src = baseUrl + radar.file;

    this.mini = el('canvas', { id: 'minimap', title: 'Enlarge the map (M)' });
    this.mini.addEventListener('click', () => this.toggle(true));
    this.big = el('canvas', { id: 'bigmap-canvas' });
    this.tip = el('div', { id: 'bigmap-tip' });
    const close = el('button', { id: 'bigmap-close', textContent: '✕', title: 'Close (M or Esc)' });
    close.addEventListener('click', () => this.toggle(false));
    this.overlay = el('div', { id: 'bigmap' }, [
      el('div', { id: 'bigmap-frame' }, [
        this.big,
        close,
        this.tip,
        el('div', { id: 'bigmap-hint', innerHTML: `Click a spot to teleport there · a <span style="color:${PINK}">●</span> marker to enter the building` }),
      ]),
    ]);
    this.overlay.hidden = true;
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.toggle(false);
    });
    this.big.addEventListener('mousemove', (e) => this.onMove(e));
    this.big.addEventListener('mouseleave', () => this.setHover(null));
    this.big.addEventListener('click', (e) => this.onClick(e));
    root.append(this.mini, this.overlay);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  toggle(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.overlay.hidden = !open;
    this.setHover(null);
    if (open) this.drawBig();
    this.cb.onToggle(open);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const miniCss = 190;
    this.mini.width = this.mini.height = Math.round(miniCss * dpr);
    const bigCss = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.86);
    this.big.style.width = this.big.style.height = `${bigCss}px`;
    this.big.width = this.big.height = Math.round(bigCss * dpr);
    if (this.open) this.drawBig();
  }

  /** World coordinates -> radar image pixel. */
  private toImage(x: number, y: number): [number, number] {
    const { min, max, size } = this.radar;
    return [((x - min[0]) / (max[0] - min[0])) * size, ((max[1] - y) / (max[1] - min[1])) * size];
  }

  /** Call every frame. */
  update(state: MapState): void {
    this.state = state;
    this.drawMini();
    if (this.open) this.drawBig();
  }

  private drawMini(): void {
    const c = this.mini;
    const ctx = c.getContext('2d')!;
    const size = c.width;
    const r = size / 2;
    const { x, y, yaw, heading } = this.state;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r - 3, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#7fb6e6';
    ctx.fillRect(0, 0, size, size);
    const pxPerMetre = (r - 3) / MINI_RANGE;
    ctx.translate(r, r);
    // The map rotates so the view direction points up.
    ctx.rotate(-yaw * DEG);
    if (this.loaded) {
      // Only draw the square of the image around the position: drawing the
      // whole image every frame would cost several milliseconds.
      const { min, max, size: img } = this.radar;
      const imgPerMetre = img / (max[0] - min[0]);
      const half = MINI_RANGE * 1.45;
      const [u, v] = this.toImage(x, y);
      ctx.drawImage(
        this.image,
        u - half * imgPerMetre, v - half * imgPerMetre, 2 * half * imgPerMetre, 2 * half * imgPerMetre,
        -half * pxPerMetre, -half * pxPerMetre, 2 * half * pxPerMetre, 2 * half * pxPerMetre,
      );
    }
    for (const it of this.interiors) {
      const dx = (it.door[0] - x) * pxPerMetre;
      const dy = -(it.door[1] - y) * pxPerMetre;
      if (Math.hypot(dx, dy) > r) continue;
      ctx.fillStyle = PINK;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = size / 190;
      ctx.beginPath();
      ctx.arc(dx, dy, size / 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Position: an arrow pointing like the character (or like the view in free camera).
    ctx.rotate(heading * DEG);
    this.arrow(ctx, size / 17);
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = size / 40;
    ctx.beginPath();
    ctx.arc(r, r, r - size / 80, 0, Math.PI * 2);
    ctx.stroke();
    // North marker on the rim.
    const a = -yaw * DEG - Math.PI / 2;
    const nx = r + Math.cos(a) * (r - size / 13);
    const ny = r + Math.sin(a) * (r - size / 13);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = size / 60;
    ctx.font = `bold ${Math.round(size / 9)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeText('N', nx, ny);
    ctx.fillText('N', nx, ny);
  }

  private arrow(ctx: CanvasRenderingContext2D, s: number): void {
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.7, s * 0.8);
    ctx.lineTo(0, s * 0.35);
    ctx.lineTo(-s * 0.7, s * 0.8);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(1.5, s / 5);
    ctx.stroke();
    ctx.fill();
  }

  private drawBig(): void {
    const c = this.big;
    const ctx = c.getContext('2d')!;
    const size = c.width;
    const k = size / this.radar.size;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#7fb6e6';
    ctx.fillRect(0, 0, size, size);
    if (this.loaded) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.image, 0, 0, size, size);
    }
    ctx.font = `600 ${Math.round(size / 62)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const t of this.teleports) {
      const [u, v] = this.toImage(t.pos[0], t.pos[1]);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = size / 400;
      ctx.beginPath();
      ctx.arc(u * k, v * k, size / 220, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const it of this.interiors) {
      const [u, v] = this.toImage(it.door[0], it.door[1]);
      const big = it === this.hover;
      ctx.fillStyle = PINK;
      ctx.strokeStyle = big ? '#fff' : '#000';
      ctx.lineWidth = size / (big ? 250 : 400);
      ctx.beginPath();
      ctx.arc(u * k, v * k, size / (big ? 95 : 130), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const [pu, pv] = this.toImage(this.state.x, this.state.y);
    ctx.save();
    ctx.translate(pu * k, pv * k);
    ctx.rotate(this.state.heading * DEG);
    this.arrow(ctx, size / 55);
    ctx.restore();
  }

  /** Mouse position -> canvas pixel and world coordinates. */
  private locate(e: MouseEvent): { px: number; py: number; x: number; y: number } {
    const rect = this.big.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const { min, max } = this.radar;
    return { px: fx * rect.width, py: fy * rect.height, x: min[0] + fx * (max[0] - min[0]), y: max[1] - fy * (max[1] - min[1]) };
  }

  private interiorAt(e: MouseEvent): InteriorInfo | null {
    const rect = this.big.getBoundingClientRect();
    const { px, py } = this.locate(e);
    let best: InteriorInfo | null = null;
    let bestD = 14;
    for (const it of this.interiors) {
      const [u, v] = this.toImage(it.door[0], it.door[1]);
      const d = Math.hypot((u / this.radar.size) * rect.width - px, (v / this.radar.size) * rect.height - py);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  private setHover(it: InteriorInfo | null): void {
    this.hover = it;
    this.tip.hidden = !it;
    this.big.style.cursor = it ? 'pointer' : 'crosshair';
  }

  private onMove(e: MouseEvent): void {
    const it = this.interiorAt(e);
    this.setHover(it);
    if (it) {
      const frame = this.big.getBoundingClientRect();
      this.tip.textContent = `Enter: ${it.label}`;
      this.tip.style.left = `${e.clientX - frame.left + 14}px`;
      this.tip.style.top = `${e.clientY - frame.top + 10}px`;
    }
  }

  private onClick(e: MouseEvent): void {
    // Compute before closing the map: once hidden, it has no dimensions.
    const it = this.interiorAt(e);
    const { x, y } = this.locate(e);
    this.toggle(false);
    if (it) this.cb.onEnter(it);
    else this.cb.onTeleport(x, y);
  }
}
