/** Reads timecyc.dat (colours per hour and weather) and waterpro.dat (water). */
import fs from 'node:fs';
import { TC, type TimecycWeather } from '../../shared/format.ts';

const WEATHER_NAMES = ['Sunny', 'Cloudy', 'Rain', 'Fog', 'Extra sunny', 'Hurricane', 'Interior colours'];

export function parseTimecyc(file: string): TimecycWeather[] {
  const rows: number[][] = [];
  for (const raw of fs.readFileSync(file, 'latin1').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const nums = line.split(/\s+/).map(Number);
    if (nums.length !== TC.COUNT || nums.some((n) => !Number.isFinite(n))) {
      throw new Error(`timecyc.dat: unexpected line (${nums.length} fields): ${line.slice(0, 60)}`);
    }
    rows.push(nums);
  }
  if (rows.length % 24 !== 0) throw new Error(`timecyc.dat: ${rows.length} lines, not a multiple of 24`);
  const out: TimecycWeather[] = [];
  for (let w = 0; w < rows.length / 24; w++) {
    out.push({ name: WEATHER_NAMES[w] ?? `Weather ${w}`, hours: rows.slice(w * 24, w * 24 + 24) });
  }
  return out;
}

export interface WaterGrid {
  levels: number[];
  /** 128 x 128 blocks of 32 units; level index or -1. Indexed [x * 128 + y]. */
  fine: Int16Array;
  /** World coordinate of the grid's (0, 0) corner. */
  originX: number;
  originY: number;
  cell: number;
}

/**
 * Vice City's waterpro.dat: level count (int32), 48 heights (float32),
 * 48 rectangles (4 float32, unused here), a coarse 64x64 grid, then a fine
 * 128x128 byte grid (level index, bit 7 = no water). The grid covers 4096
 * units, shifted 400 to the west in X.
 */
export function parseWaterPro(file: string): WaterGrid {
  const buf = fs.readFileSync(file);
  const expected = 4 + 48 * 4 + 48 * 16 + 64 * 64 + 128 * 128;
  if (buf.length !== expected) throw new Error(`waterpro.dat: ${buf.length} bytes, expected ${expected}`);
  const count = buf.readInt32LE(0);
  const levels: number[] = [];
  for (let i = 0; i < count; i++) levels.push(buf.readFloatLE(4 + i * 4));
  const fineOff = 4 + 48 * 4 + 48 * 16 + 64 * 64;
  const fine = new Int16Array(128 * 128);
  for (let i = 0; i < 128 * 128; i++) {
    const v = buf[fineOff + i];
    fine[i] = v & 0x80 ? -1 : v;
  }
  return { levels, fine, originX: -2048 - 400, originY: -2048, cell: 32 };
}

/**
 * Merges adjacent blocks of the same level into rectangles
 * [x0, y0, x1, y1, z]. With land = true, returns instead the blocks without
 * water (dry land), as [x0, y0, x1, y1].
 */
export function waterRects(grid: WaterGrid, land = false): number[] {
  const n = 128;
  const used = new Uint8Array(n * n);
  const out: number[] = [];
  const at = (x: number, y: number) => (land ? (grid.fine[x * n + y] < 0 ? 0 : -1) : grid.fine[x * n + y]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const lv = at(x, y);
      if (lv < 0 || used[x * n + y]) continue;
      let w = 1;
      while (x + w < n && at(x + w, y) === lv && !used[(x + w) * n + y]) w++;
      let h = 1;
      outer: while (y + h < n) {
        for (let i = 0; i < w; i++) if (at(x + i, y + h) !== lv || used[(x + i) * n + y + h]) break outer;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used[(x + i) * n + y + j] = 1;
      out.push(
        grid.originX + x * grid.cell,
        grid.originY + y * grid.cell,
        grid.originX + (x + w) * grid.cell,
        grid.originY + (y + h) * grid.cell,
      );
      if (!land) out.push(grid.levels[lv] ?? 6);
    }
  }
  return out;
}
