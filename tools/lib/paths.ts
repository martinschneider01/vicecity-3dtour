import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Game install folder (the one containing data/ and models/).
 * Can be forced with the VC_GAME_DIR environment variable; otherwise we
 * look under "./originalgame/". This folder is never modified.
 */
function findGameDir(): string {
  const candidates = [
    process.env.VC_GAME_DIR,
    path.join(ROOT, 'originalgame'),
    path.join(ROOT, 'originalgame', 'GTAVC'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'data', 'gta_vc.dat')) && fs.existsSync(path.join(c, 'models', 'gta3.img'))) {
      return c;
    }
  }
  throw new Error(
    `Vice City install not found. Folders tried:\n  ${candidates.join('\n  ')}\n` +
      'Set VC_GAME_DIR to the folder containing data/ and models/.',
  );
}

export const GAME_DIR = findGameDir();

/** Output folder for converted assets (ignored by git, served by Vite). */
export const OUT_DIR = path.join(ROOT, 'public', 'assets');
