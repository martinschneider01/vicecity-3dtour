/**
 * S3TC decoding (BC1/DXT1, BC2/DXT3, BC3/DXT5) and compressed image sizes.
 * The conversion uses it to read the game's textures; the viewer uses it to
 * know the size of each mipmap level.
 *
 * All RGBA images are Uint8Arrays of width*height*4 bytes.
 */

function unpack565(c: number, out: Uint8Array, o: number): void {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

const pal = new Uint8Array(16);

/**
 * Decodes a BC1 colour block into `pal` (4 RGBA colours).
 * `fourColorOnly` forces 4-colour mode (BC2/BC3 colour blocks).
 */
function blockPalette(src: Uint8Array, p: number, fourColorOnly: boolean): void {
  const c0 = src[p] | (src[p + 1] << 8);
  const c1 = src[p + 2] | (src[p + 3] << 8);
  unpack565(c0, pal, 0);
  unpack565(c1, pal, 4);
  pal[3] = pal[7] = pal[11] = pal[15] = 255;
  if (c0 > c1 || fourColorOnly) {
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = ((2 * pal[k] + pal[4 + k] + 1) / 3) | 0;
      pal[12 + k] = ((pal[k] + 2 * pal[4 + k] + 1) / 3) | 0;
    }
  } else {
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = (pal[k] + pal[4 + k]) >> 1;
      pal[12 + k] = 0;
    }
    pal[15] = 0;
  }
}

export type DxtKind = 1 | 3 | 5;

/** Decodes a DXT1/3/5 image to RGBA. Any width and height. */
export function decodeDxt(src: Uint8Array, width: number, height: number, kind: DxtKind): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const bw = Math.max(1, (width + 3) >> 2);
  const bh = Math.max(1, (height + 3) >> 2);
  const blockBytes = kind === 1 ? 8 : 16;
  const alpha = new Uint8Array(16);
  const a8 = new Uint8Array(8);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let p = (by * bw + bx) * blockBytes;
      if (kind === 3) {
        for (let i = 0; i < 16; i++) {
          const nib = (src[p + (i >> 1)] >> ((i & 1) * 4)) & 15;
          alpha[i] = nib * 17;
        }
        p += 8;
      } else if (kind === 5) {
        a8[0] = src[p];
        a8[1] = src[p + 1];
        if (a8[0] > a8[1]) {
          for (let k = 1; k < 7; k++) a8[k + 1] = (((7 - k) * a8[0] + k * a8[1]) / 7) | 0;
        } else {
          for (let k = 1; k < 5; k++) a8[k + 1] = (((5 - k) * a8[0] + k * a8[1]) / 5) | 0;
          a8[6] = 0;
          a8[7] = 255;
        }
        // 48 bits of 3-bit indices
        let lo = src[p + 2] | (src[p + 3] << 8) | (src[p + 4] << 16);
        let hi = src[p + 5] | (src[p + 6] << 8) | (src[p + 7] << 16);
        for (let i = 0; i < 8; i++) {
          alpha[i] = a8[lo & 7];
          lo >>= 3;
        }
        for (let i = 8; i < 16; i++) {
          alpha[i] = a8[hi & 7];
          hi >>= 3;
        }
        p += 8;
      }
      blockPalette(src, p, kind !== 1);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) break;
        const bits = src[p + 4 + y];
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= width) continue;
          const idx = (bits >> (x * 2)) & 3;
          const o = (py * width + px) * 4;
          out[o] = pal[idx * 4];
          out[o + 1] = pal[idx * 4 + 1];
          out[o + 2] = pal[idx * 4 + 2];
          out[o + 3] = kind === 1 ? pal[idx * 4 + 3] : alpha[y * 4 + x];
        }
      }
    }
  }
  return out;
}

/** Byte size of a compressed image (8 bytes per block for BC1, 16 for BC2). */
export function dxtByteLength(width: number, height: number, blockBytes: number): number {
  return Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * blockBytes;
}

/** Mipmap level sizes of a square texture, down to 1x1. */
export function mipSizes(size: number): number[] {
  const out: number[] = [];
  for (let s = size; s >= 1; s >>= 1) out.push(s);
  return out;
}

/** Bytes taken by a full layer (all levels) of a class. */
export function layerByteLength(size: number, blockBytes: number): number {
  let n = 0;
  for (const s of mipSizes(size)) n += dxtByteLength(s, s, blockBytes);
  return n;
}
