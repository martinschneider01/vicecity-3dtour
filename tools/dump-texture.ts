/**
 * Diagnostic tool: lists the textures of a TXD, or exports one as PNG
 * into .cache/ (ignored by git).
 *   npx tsx tools/dump-texture.ts <txd|path.txd> [texture]
 */
import fs from 'node:fs';
import path from 'node:path';
import { ImgArchive } from './lib/img.ts';
import { GAME_DIR, ROOT } from './lib/paths.ts';
import { writePng } from './lib/png.ts';
import { parseTxd } from './lib/rw.ts';
import { classifyAlpha, decodeTexture } from './lib/textures.ts';

if (process.argv[1]?.endsWith('dump-texture.ts')) {
  const [src, name] = process.argv.slice(2);
  let buf: Buffer | null;
  if (/[\\/]/.test(src)) buf = fs.readFileSync(path.join(GAME_DIR, src));
  else {
    const img = new ImgArchive(path.join(GAME_DIR, 'models/gta3.img'), path.join(GAME_DIR, 'models/gta3.dir'));
    buf = img.read(src + '.txd');
  }
  if (!buf) throw new Error('TXD not found');
  for (const t of parseTxd(buf)) {
    if (!name) {
      console.log(`${t.name.padEnd(28)} ${t.width}x${t.height} d${t.depth} fmt=0x${t.rasterFormat.toString(16)} comp=${t.compression} alphaFlag=${t.hasAlphaFlag} levels=${t.levels.length} sizes=${t.levels.map((l) => l.length).join('/')} alpha=${classifyAlpha(decodeTexture(t))}`);
    } else if (t.name.toLowerCase() === name.toLowerCase()) {
      const out = path.join(ROOT, '.cache', `${t.name}.png`);
      writePng(out, decodeTexture(t), t.width, t.height);
      console.log('wrote', out);
    }
  }
}
