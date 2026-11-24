/**
 * Consistency checks on the converted assets (public/assets). Skipped
 * until `npm run build:assets` has been run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { FORMAT_VERSION, TILE_MAGIC, batchKeyClass, type Manifest, type TileHeader } from '../shared/format.ts';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets');
const manifestPath = path.join(ASSETS, 'manifest.json');
const skip = fs.existsSync(manifestPath) ? false : 'assets missing (run npm run build:assets)';
const manifest = skip ? null : (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest);

function readTile(file: string): { header: TileHeader; payloadBytes: number } {
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(ASSETS, file)));
  assert.equal(buf.readUInt32LE(0), TILE_MAGIC, `${file}: signature`);
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen)) as TileHeader;
  return { header, payloadBytes: buf.length - 8 - headerLen };
}

/** isFar: true for the far pack, false for a tile, null for an interior (a mix of both). */
function checkTile(file: string, m: Manifest, isFar: boolean | null): number {
  const { header, payloadBytes } = readTile(file);
  for (const b of header.batches) {
    const cls = batchKeyClass(b.key);
    assert.ok(cls < m.texClasses.length, `${file}: texture class ${cls}`);
    assert.ok(b.pos + b.verts * 12 <= payloadBytes && b.uv + b.verts * 8 <= payloadBytes, `${file}: vertices outside file`);
    assert.ok(b.idx + b.indices * (b.idx16 ? 2 : 4) <= payloadBytes, `${file}: indices outside file`);
    assert.equal(b.geoms.length % 4, 0);
    let v = 0;
    let i = 0;
    for (let g = 0; g < b.geoms.length; g += 4) {
      assert.equal(b.geoms[g], v, `${file}: contiguous sub-geometries`);
      assert.equal(b.geoms[g + 2], i);
      assert.equal(b.geoms[g + 3] % 3, 0, `${file}: whole triangles`);
      v += b.geoms[g + 1];
      i += b.geoms[g + 3];
    }
    assert.equal(v, b.verts);
    assert.equal(i, b.indices);
  }
  for (const model of header.models) {
    assert.ok(model.far >= 2, `${file}: draw distance of ${model.name}`);
    for (let k = 0; k < model.parts.length; k += 2) {
      const b = header.batches[model.parts[k]];
      assert.ok(b && model.parts[k + 1] < b.geoms.length / 4, `${file}: part of ${model.name}`);
    }
    // Far pack = draw distance > 300; tiles = the rest.
    if (isFar !== null) assert.equal(model.far > 300, isFar, `${file}: ${model.name} (${model.far}) on the wrong side`);
  }
  for (let k = 0; k < header.tex.length; k += 2) {
    const c = m.texClasses[header.tex[k]];
    assert.ok(c && header.tex[k + 1] < c.layers, `${file}: texture outside class`);
  }
  assert.ok(header.inst + header.count * 28 <= payloadBytes);
  assert.ok(header.near + header.count * 4 <= payloadBytes && header.area + header.count <= payloadBytes);
  return header.count;
}

test('manifest', { skip }, () => {
  const m = manifest!;
  assert.equal(m.version, FORMAT_VERSION);
  assert.equal(m.timecyc.length, 7);
  for (const w of m.timecyc) assert.equal(w.hours.length, 24);
  assert.equal(m.teleports.length, 5);
  assert.ok(m.water.rects.length > 0 && m.water.rects.length % 5 === 0);
  assert.ok(m.water.land.length > 0 && m.water.land.length % 4 === 0);
  assert.equal(m.stats.instancesRead, m.stats.instancesPlaced + m.stats.instancesExcluded);
});

test('texture files: each layer is in exactly one KTX2 file', { skip }, () => {
  const KTX2 = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const c of manifest!.texClasses) {
    assert.ok(c.layers <= 1024);
    let next = 0;
    for (const chunk of c.chunks) {
      assert.equal(chunk.first, next, `${chunk.file}: contiguous layers`);
      // The viewer finds a layer's file by division: all the same size except the last.
      if (chunk !== c.chunks[c.chunks.length - 1]) assert.equal(chunk.count, c.chunks[0].count, chunk.file);
      next += chunk.count;
      const buf = fs.readFileSync(path.join(ASSETS, chunk.file));
      assert.ok(buf.subarray(0, 12).equals(KTX2), `${chunk.file}: signature KTX2`);
      // KTX2 header: width, height at byte 20, layer count at 32, level count at 40.
      assert.equal(buf.readUInt32LE(20), c.size, chunk.file);
      assert.equal(buf.readUInt32LE(24), c.size, chunk.file);
      assert.equal(Math.max(1, buf.readUInt32LE(32)), chunk.count, `${chunk.file}: layers`);
      assert.equal(buf.readUInt32LE(40), Math.log2(c.size) + 1, `${chunk.file}: mipmap levels`);
    }
    assert.equal(next, c.layers);
  }
});

test('far pack and tiles are consistent', { skip }, () => {
  const m = manifest!;
  let total = checkTile(m.far.file, m, true);
  assert.equal(total, m.far.count);
  for (const t of m.tiles) {
    const n = checkTile(t.file, m, false);
    assert.equal(n, t.count, t.file);
    total += n;
  }
  assert.equal(total, m.stats.instancesExterior);
  for (const it of m.interiors) total += checkTile(it.file, m, null);
  assert.equal(total, m.stats.instancesPlaced);
});

test('each linked LOD points to an existing tile', { skip }, () => {
  const m = manifest!;
  const buf = zlib.gunzipSync(fs.readFileSync(path.join(ASSETS, m.far.file)));
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen)) as TileHeader;
  const base = 8 + headerLen;
  let linked = 0;
  for (let i = 0; i < header.count; i++) {
    const near = buf.readFloatLE(base + header.near + i * 4);
    const tile = buf.readInt16LE(base + header.hdTile + i * 2);
    if (near > 0) {
      linked++;
      assert.ok(near <= 300, 'a detailed model has a draw distance ≤ 300');
      assert.ok(tile >= 0 && tile < m.tiles.length);
    } else assert.equal(tile, -1);
  }
  assert.ok(linked > 900, `${linked} linked LODs`);
});
