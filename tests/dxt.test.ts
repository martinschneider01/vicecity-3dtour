import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeDxt, dxtByteLength, layerByteLength, mipSizes } from '../shared/dxt.ts';

const RED = 0xf800;
const BLUE = 0x001f;
/** BC1 colour block: two 565 colours, then 16 2-bit indices (4 rows). */
function colorBlock(c0: number, c1: number, rows: number[]): number[] {
  return [c0 & 255, c0 >> 8, c1 & 255, c1 >> 8, ...rows];
}

test('level and layer sizes', () => {
  assert.deepEqual(mipSizes(32), [32, 16, 8, 4, 2, 1]);
  assert.equal(dxtByteLength(256, 256, 8), 32768);
  assert.equal(dxtByteLength(2, 2, 8), 8);
  // 64 + 16 + 4 + 1 + 1 + 1 blocks of 8 bytes
  assert.equal(layerByteLength(32, 8), 87 * 8);
});

test('BC1 four-colour: endpoints and intermediate colours', () => {
  // c0 > c1: indices 0 = c0, 1 = c1, 2 = 2/3 c0 + 1/3 c1, 3 = 1/3 c0 + 2/3 c1
  const px = decodeDxt(new Uint8Array(colorBlock(RED, BLUE, [0b11100100, 0, 0, 0])), 4, 4, 1);
  assert.deepEqual([...px.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...px.subarray(4, 8)], [0, 0, 255, 255]);
  assert.deepEqual([...px.subarray(8, 12)], [170, 0, 85, 255]);
  assert.deepEqual([...px.subarray(12, 16)], [85, 0, 170, 255]);
});

test('BC1 three-colour: index 3 is transparent', () => {
  // c0 <= c1: indices 2 = average, 3 = transparent
  const px = decodeDxt(new Uint8Array(colorBlock(BLUE, RED, [0b11100100, 0, 0, 0])), 4, 4, 1);
  assert.deepEqual([...px.subarray(8, 12)], [127, 0, 127, 255]);
  assert.deepEqual([...px.subarray(12, 16)], [0, 0, 0, 0]);
});

test('DXT3: explicit 4-bit alpha, colour block always four-colour', () => {
  const alpha = [0xf0, 0x08, 0, 0, 0, 0, 0, 0]; // pixels 0..3: 0, 15, 8, 0
  const px = decodeDxt(new Uint8Array([...alpha, ...colorBlock(BLUE, RED, [0b11100100, 0, 0, 0])]), 4, 4, 3);
  assert.deepEqual([px[3], px[7], px[11], px[15]], [0, 255, 136, 0]);
  // Despite c0 <= c1, no transparent mode: index 3 is an intermediate colour.
  assert.deepEqual([...px.subarray(12, 15)], [170, 0, 85]);
});

test('DXT5: alpha interpolated between two endpoints', () => {
  // a0 = 255 > a1 = 0: indices 0 = a0, 1 = a1, 2..7 = 6 intermediate values
  const alpha = [255, 0, 0b10001000, 0, 0, 0, 0, 0]; // pixels 0, 1, 2: indices 0, 1, 2
  const px = decodeDxt(new Uint8Array([...alpha, ...colorBlock(RED, BLUE, [0, 0, 0, 0])]), 4, 4, 5);
  assert.deepEqual([px[3], px[7], px[11]], [255, 0, 218]);
});

test('image whose size is not a multiple of 4', () => {
  const px = decodeDxt(new Uint8Array(colorBlock(RED, BLUE, [0, 0, 0, 0])), 2, 2, 1);
  assert.equal(px.length, 16);
  assert.deepEqual([...px.subarray(12, 16)], [255, 0, 0, 255]);
});
