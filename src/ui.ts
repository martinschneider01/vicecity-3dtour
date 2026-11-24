/** UI: coordinates, performance, movement mode, time of day, weather, display, teleport. */
import type { Teleport, TimecycWeather } from '../shared/format.ts';

export type MoveMode = 'free' | 'foot';
/** What the UI shows: the minimap only (default), everything, or nothing. */
export type HudMode = 'all' | 'map' | 'none';
/** Cycle order of the H key and the HUD button; the first one is the default. */
export const HUD_MODES: HudMode[] = ['map', 'all', 'none'];
const HUD_TITLES: Record<HudMode, string> = {
  map: 'Minimap only — click to show the full HUD (H)',
  all: 'Full HUD — click to hide everything (H)',
  none: 'HUD hidden — click to show the minimap (H)',
};
const ICON_HUD =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 6h13M10.5 6v7.5"/></svg>';
const ICON_FULLSCREEN =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';

export interface UiModel {
  hour: number;
  autoTime: boolean;
  weather: number;
  drawScale: number;
  fog: boolean;
  mode: MoveMode;
  /** "auto": like the game (LODs in the distance). "hd": all detailed models, no LODs. */
  detail: 'auto' | 'hd';
  /** Load the whole map at startup rather than around the camera. */
  preload: boolean;
}

export interface UiCallbacks {
  onChange(model: UiModel): void;
  onTeleport(t: Teleport): void;
  onMode(mode: MoveMode): void;
  onExitInterior(): void;
  /** Request to switch to the next HUD mode (everything, map only, nothing). */
  onCycleHud(): void;
}

export interface HudData {
  x: number;
  y: number;
  z: number;
  yaw: number;
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  tiles: string;
  instances: number;
  speed: number;
  place: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

export function formatHour(h: number): string {
  const total = Math.round((((h % 24) + 24) % 24) * 60) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export class Ui {
  private readonly root: HTMLElement;
  private readonly hudValues = new Map<string, HTMLElement>();
  private readonly status: HTMLElement;
  private readonly help: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly exit: HTMLButtonElement;
  private readonly hudButton: HTMLButtonElement;
  private readonly hourInput: HTMLInputElement;
  private readonly hourValue: HTMLElement;
  private readonly modeButtons = new Map<MoveMode, HTMLButtonElement>();
  private readonly distInput: HTMLInputElement;
  private readonly model: UiModel;

  constructor(root: HTMLElement, model: UiModel, weathers: TimecycWeather[], teleports: Teleport[], hasPlayer: boolean, cb: UiCallbacks) {
    this.root = root;
    this.model = model;
    const emit = () => cb.onChange(model);

    // Info panel
    const dl = el('dl');
    for (const [key, label] of [
      ['pos', 'Position'],
      ['yaw', 'Heading'],
      ['place', 'Location'],
      ['fps', 'FPS'],
      ['calls', 'Draw calls'],
      ['tris', 'Triangles'],
      ['tiles', 'Tiles'],
      ['inst', 'Visible objects'],
      ['speed', 'Speed'],
    ]) {
      const dd = el('dd');
      this.hudValues.set(key, dd);
      dl.append(el('dt', { textContent: label }), dd);
    }
    root.append(el('div', { id: 'hud', className: 'panel' }, [el('div', { className: 'title', textContent: 'VICE CITY — 3D TOUR' }), dl]));

    // Movement mode
    const modes = el('div', { className: 'segmented' });
    for (const [mode, label] of [['free', 'Free camera'], ['foot', 'On foot (Tommy)']] as const) {
      const b = el('button', { textContent: label, disabled: mode === 'foot' && !hasPlayer });
      b.addEventListener('click', () => {
        cb.onMode(mode);
        b.blur();
      });
      this.modeButtons.set(mode, b);
      modes.append(b);
    }

    // Time of day
    this.hourInput = el('input', { type: 'range', min: '0', max: '24', step: '0.05', value: String(model.hour) });
    this.hourValue = el('span', { className: 'value', textContent: formatHour(model.hour) });
    this.hourInput.addEventListener('input', () => {
      model.hour = Number(this.hourInput.value) % 24;
      this.hourValue.textContent = formatHour(model.hour);
      emit();
    });
    const auto = el('input', { type: 'checkbox', checked: model.autoTime });
    auto.addEventListener('change', () => {
      model.autoTime = auto.checked;
      emit();
    });

    const weatherSelect = el('select');
    weathers.forEach((w, i) => weatherSelect.append(el('option', { value: String(i), textContent: w.name, selected: i === model.weather })));
    weatherSelect.addEventListener('change', () => {
      model.weather = Number(weatherSelect.value);
      emit();
    });

    // Display
    const detail = el('select');
    detail.append(
      el('option', { value: 'auto', textContent: 'Like the game (distant LODs)', selected: model.detail === 'auto' }),
      el('option', { value: 'hd', textContent: 'Full detail (no LODs)', selected: model.detail === 'hd' }),
    );
    this.distInput = el('input', { type: 'range', min: '0.5', max: '4', step: '0.1', value: String(model.drawScale) });
    const distValue = el('span', { className: 'value', textContent: `×${model.drawScale.toFixed(1)}` });
    this.distInput.addEventListener('input', () => {
      model.drawScale = Number(this.distInput.value);
      distValue.textContent = `×${model.drawScale.toFixed(1)}`;
      emit();
    });
    detail.addEventListener('change', () => {
      model.detail = detail.value as UiModel['detail'];
      this.distInput.disabled = model.detail === 'hd';
      emit();
      detail.blur();
    });
    this.distInput.disabled = model.detail === 'hd';
    const preload = el('input', { type: 'checkbox', checked: model.preload });
    preload.addEventListener('change', () => {
      model.preload = preload.checked;
      emit();
    });
    const fog = el('input', { type: 'checkbox', checked: model.fog });
    fog.addEventListener('change', () => {
      model.fog = fog.checked;
      emit();
    });

    const tp = el('div', { className: 'teleports' });
    for (const t of teleports) {
      const b = el('button', { textContent: t.label });
      b.addEventListener('click', () => {
        cb.onTeleport(t);
        b.blur();
      });
      tp.append(b);
    }

    root.append(
      el('div', { id: 'controls', className: 'panel' }, [
        el('h2', { textContent: 'Movement' }),
        modes,
        el('h2', { textContent: 'Time' }),
        el('div', { className: 'row' }, [this.hourInput, this.hourValue]),
        el('label', {}, [auto, 'Time passes (1 game minute per second)']),
        el('h2', { textContent: 'Weather' }),
        el('div', { className: 'row' }, [weatherSelect]),
        el('h2', { textContent: 'Display' }),
        el('div', { className: 'row' }, [detail]),
        el('div', { className: 'row' }, [el('span', { textContent: 'Distance' }), this.distInput, distValue]),
        el('label', {}, [preload, 'Load the whole map at startup']),
        el('label', {}, [fog, "Game's fog and horizon"]),
        el('h2', { textContent: 'Teleport' }),
        tp,
      ]),
    );

    // Once a setting has changed, the keyboard must go back to movement:
    // otherwise keys would stay captured by the slider or the list.
    root.addEventListener('change', (e) => (e.target as HTMLElement).blur());

    this.help = el('div', { id: 'help', className: 'panel' });
    this.status = el('div', { id: 'status', className: 'panel' });
    this.prompt = el('div', { id: 'prompt', className: 'panel' });
    this.exit = el('button', { id: 'exit', className: 'panel' });
    this.exit.addEventListener('click', () => {
      cb.onExitInterior();
      this.exit.blur();
    });
    // Two small buttons in the corner: HUD mode and fullscreen.
    // With the HUD hidden, they only reappear when hovering the corner.
    this.hudButton = el('button', { id: 'hud-toggle', innerHTML: ICON_HUD });
    this.hudButton.addEventListener('click', () => {
      cb.onCycleHud();
      this.hudButton.blur();
    });
    const fullscreen = el('button', { id: 'fullscreen', innerHTML: ICON_FULLSCREEN, title: 'Fullscreen' });
    fullscreen.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => undefined);
      fullscreen.blur();
    });
    document.addEventListener('fullscreenchange', () => {
      fullscreen.title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    });
    root.append(this.help, this.status, this.prompt, this.exit, el('div', { id: 'corner' }, [this.hudButton, fullscreen]));
    this.setMode(model.mode);
    this.setInterior(null);
    this.setPrompt('');
    this.setHelp({ KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyQ: 'Q', KeyE: 'E' }, false);
  }

  setMode(mode: MoveMode): void {
    this.model.mode = mode;
    for (const [m, b] of this.modeButtons) b.classList.toggle('active', m === mode);
  }

  /** Help text at the bottom of the screen, depending on the mode and keyboard layout. */
  setHelp(k: Record<string, string>, locked: boolean): void {
    const kbd = (s: string) => `<kbd>${s}</kbd>`;
    const move = `${kbd(k.KeyW)}${kbd(k.KeyA)}${kbd(k.KeyS)}${kbd(k.KeyD)}`;
    const lock = locked ? `${kbd('Esc')} releases the mouse` : 'Click in the view to capture the mouse';
    const common = ` · ${kbd('V')} switch mode · ${kbd('M')} map · ${kbd('F')} enter / exit · ${kbd('H')} HUD`;
    this.help.innerHTML =
      this.model.mode === 'foot'
        ? `${lock} · ${move} run · ${kbd('Shift')} sprint · wheel: camera distance${common}`
        : `${lock} · ${move} move · ${kbd(k.KeyQ)} down, ${kbd(k.KeyE)} up · ${kbd('Shift')} speed up · wheel: speed${common}`;
  }

  setHour(h: number): void {
    this.model.hour = h;
    this.hourInput.value = String(h);
    this.hourValue.textContent = formatHour(h);
  }

  setStatus(text: string): void {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  /** Contextual prompt in the center of the screen ("F: enter ..."). Empty to hide it. */
  setPrompt(text: string): void {
    if (this.prompt.textContent !== text) this.prompt.textContent = text;
    this.prompt.hidden = text === '';
  }

  /** Shows the exit button when inside an interior. */
  setInterior(label: string | null): void {
    this.exit.hidden = label === null;
    if (label !== null) this.exit.textContent = `Exit: ${label}  (F)`;
  }

  setHudData(d: HudData): void {
    const set = (k: string, v: string) => {
      const e = this.hudValues.get(k)!;
      if (e.textContent !== v) e.textContent = v;
    };
    set('pos', `${d.x.toFixed(1)}  ${d.y.toFixed(1)}  ${d.z.toFixed(1)}`);
    const yaw = ((d.yaw % 360) + 360) % 360;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    set('yaw', `${yaw.toFixed(0)}° ${names[Math.round(yaw / 45) % 8]}`);
    set('place', d.place);
    set('fps', `${d.fps.toFixed(0)}  (${d.frameMs.toFixed(1)} ms)`);
    set('calls', String(d.drawCalls));
    set('tris', d.triangles.toLocaleString('en-US'));
    set('tiles', d.tiles);
    set('inst', d.instances.toLocaleString('en-US'));
    set('speed', `${d.speed.toFixed(0)} m/s`);
  }

  /** Shows everything, the minimap only (with the enter and exit prompts), or nothing. */
  setHud(mode: HudMode): void {
    this.root.classList.toggle('hud-map', mode === 'map');
    this.root.classList.toggle('hud-none', mode === 'none');
    this.hudButton.title = HUD_TITLES[mode];
  }

  static fatal(message: string): void {
    document.body.append(el('div', { id: 'fatal' }, [el('div', { innerHTML: message })]));
  }
}
