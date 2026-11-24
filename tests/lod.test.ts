import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObjectDef } from '../tools/lib/gamedata.ts';
import { LodLinker, isLodLike, type LodItem } from '../tools/lib/lod.ts';

let nextId = 100;
function def(name: string, far: number, source = 'a.ide', time: [number, number] | null = null): ObjectDef {
  return { id: nextId++, name, txd: 't', meshCount: 1, drawDists: [far], flags: 0, timeOn: time?.[0] ?? null, timeOff: time?.[1] ?? null, source };
}
const item = (d: ObjectDef, x: number, y = 0): LodItem => ({ def: d, pos: [x, y, 0], near: 0, hdTile: -1 });

function setup(defs: ObjectDef[]): LodLinker {
  const ranges = new Map<string, [number, number]>();
  for (const d of defs) {
    const r = ranges.get(d.source) ?? [Infinity, -Infinity];
    ranges.set(d.source, [Math.min(r[0], d.id), Math.max(r[1], d.id)]);
  }
  return new LodLinker(defs, ranges);
}

test('a LOD is a model with a draw distance over 300 or named LOD', () => {
  assert.ok(isLodLike(def('LODshop', 900)));
  assert.ok(isLodLike(def('seabed', 700)));
  assert.ok(isLodLike(def('lodsign', 200)));
  assert.ok(!isLodLike(def('od_shop', 150)));
});

test('game rule: same name from the 4th character on, in the same IDE file', () => {
  const hd = def('od_shop', 150);
  const lod = def('LODshop', 900);
  const other = def('nb_shop', 120, 'b.ide');
  const linker = setup([hd, lod, other]);
  const pack = [item(lod, 0)];
  linker.link(pack, LodLinker.index([{ def: hd, pos: [1, 0, 0], tile: 7 }, { def: other, pos: [0, 0, 0], tile: 9 }]));
  assert.equal(pack[0].near, 150);
  assert.equal(pack[0].hdTile, 7);
  assert.deepEqual(linker.stats, { byName: 1, byPlace: 0, byNeighbour: 0, none: 0, far: 0 });
});

test('several models with the same suffix: the one with the closest instance', () => {
  const a = def('lhsbackbit', 100);
  const b = def('havbackbit', 180);
  const lod = def('lodbackbit', 800);
  const linker = setup([a, b, lod]);
  const pack = [item(lod, 500)];
  linker.link(pack, LodLinker.index([{ def: a, pos: [160, 0, 0], tile: 1 }, { def: b, pos: [501, 0, 0], tile: 2 }]));
  assert.equal(pack[0].near, 180);
  assert.equal(pack[0].hdTile, 2);
});

test('failing a name match: detailed model at the same spot whose name extends the LOD name', () => {
  const day = def('odalleyground5_dy', 150, 'a.ide', [5, 20]);
  const lod = def('LODlleyground5', 700);
  const linker = setup([day, lod]);
  const pack = [item(lod, 10)];
  linker.link(pack, LodLinker.index([{ def: day, pos: [10, 0, 0], tile: 3 }]));
  assert.equal(pack[0].near, 150);
  assert.equal(pack[0].hdTile, 3);
  assert.equal(linker.stats.byPlace, 1);
  // Linked by position only: the LOD serves both day and night, so it does not inherit the hours.
  assert.equal(linker.inheritedTime.size, 0);
});

test('LOD without hours linked by name to a day/night object: it inherits its hours', () => {
  const day = def('od_road1_dy', 200, 'a.ide', [5, 20]);
  const lod = def('LODroad1_dy', 900);
  const linker = setup([day, lod]);
  linker.link([item(lod, 0)], LodLinker.index([{ def: day, pos: [0, 0, 0], tile: 0 }]));
  assert.deepEqual(linker.inheritedTime.get(lod), [5, 20]);
});

test('named LOD surrounded by detailed objects fades out up close; an isolated one stays', () => {
  const palm = def('veg_palm', 200);
  const trees = def('LODrtrees1', 1000);
  const alone = def('LODnetopa0', 1000);
  const seabed = def('cdseabed01', 700);
  const linker = setup([palm, trees, alone, seabed]);
  const pack = [item(trees, 0), item(alone, 900), item(seabed, 5)];
  linker.link(pack, LodLinker.index([{ def: palm, pos: [20, 0, 0], tile: 4 }]));
  assert.deepEqual([pack[0].near, pack[0].hdTile], [150, 4]);
  assert.deepEqual([pack[1].near, pack[1].hdTile], [0, -1]);
  // A large object not named LOD (seabed) is never faded out by proximity.
  assert.deepEqual([pack[2].near, pack[2].hdTile], [0, -1]);
  assert.deepEqual([...linker.unlinked], ['LODnetopa0']);
});

test('a detailed model is never treated as a LOD', () => {
  const hd = def('od_shop', 150);
  const lod = def('LODshop', 900);
  const linker = setup([hd, lod]);
  const pack = [item(hd, 0)];
  linker.link(pack, LodLinker.index([{ def: hd, pos: [0, 0, 0], tile: 0 }]));
  assert.equal(pack[0].near, 0);
});
