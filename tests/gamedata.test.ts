import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseDat, parseIde, parseIpl, resolveGamePath } from '../tools/lib/gamedata.ts';
import { classifyAlpha } from '../tools/lib/textures.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicemap-test-'));
function file(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('IDE: objs and tobj sections, 1 to 3 draw distances', () => {
  const p = file(
    'Test.IDE',
    [
      '# comment',
      'objs',
      '300, bar_gate, docentrance, 1, 84, 0',
      '316, bar_barrier12, fences, 2, 73, 39, 4',
      '400, lamp, generic, 3, 100, 50, 25, 128',
      'end',
      'tobj',
      '3092, road_dy, Generic, 1, 200, 1, 5, 20',
      'end',
      'path',
      'ped, 300, bar_gate',
      'end',
    ].join('\r\n'),
  );
  const defs = parseIde(p);
  assert.equal(defs.length, 4);
  assert.deepEqual(defs[0], { id: 300, name: 'bar_gate', txd: 'docentrance', meshCount: 1, drawDists: [84], flags: 0, timeOn: null, timeOff: null, source: 'test.ide' });
  assert.deepEqual(defs[1].drawDists, [73, 39]);
  assert.equal(defs[1].flags, 4);
  assert.deepEqual(defs[2].drawDists, [100, 50, 25]);
  assert.deepEqual([defs[3].timeOn, defs[3].timeOff, defs[3].flags], [5, 20, 1]);
});

test('IPL: 13-field lines (with interior area) and 12-field lines', () => {
  const p = file(
    'test.ipl',
    [
      '# IPL generated from Max file',
      'inst',
      '3085, plants01, 13, 297.5, -1173.25, 14.125, 1, 1, 1, 0, 0, 0, 1',
      '425, lamppost1, 322, -935.5, 13.25, 1, 1, 1, 0, 0, 0.5, 0.75',
      '4737, club_exterior07, -1, 1, 2, 3, 1, 1, 1, 0, 0, 0, 1',
      'end',
      'cull',
      '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11',
      'end',
    ].join('\n'),
  );
  const insts = parseIpl(p);
  assert.equal(insts.length, 3);
  assert.equal(insts[0].interior, 13);
  assert.deepEqual(insts[0].pos, [297.5, -1173.25, 14.125]);
  assert.equal(insts[1].interior, 0);
  assert.deepEqual(insts[1].pos, [322, -935.5, 13.25]);
  assert.deepEqual(insts[1].rot, [0, 0, 0.5, 0.75]);
  assert.equal(insts[2].interior, -1);
});

test('DAT and case-insensitive path resolution', () => {
  file('data/maps/HaitiN/haitiN.ide', 'objs\nend\n');
  const dat = file('data/gta.dat', ['# list', 'IDE DATA\\MAPS\\haitin\\haitin.IDE', 'SPLASH loadsc2', 'IPL DATA\\MAPS\\x.IPL', 'TEXDICTION MODELS\\GENERIC.TXD'].join('\n'));
  const parsed = parseDat(dat);
  assert.deepEqual(parsed.ide, ['DATA\\MAPS\\haitin\\haitin.IDE']);
  assert.deepEqual(parsed.ipl, ['DATA\\MAPS\\x.IPL']);
  assert.deepEqual(parsed.texDictionaries, ['MODELS\\GENERIC.TXD']);
  const resolved = resolveGamePath(dir, parsed.ide[0]);
  assert.ok(resolved && fs.existsSync(resolved));
  assert.equal(path.basename(resolved), 'haitiN.ide');
  assert.equal(resolveGamePath(dir, 'DATA\\MAPS\\absent.ide'), null);
});

test('texture alpha classification', () => {
  const make = (alphas: number[]) => {
    const px = new Uint8Array(alphas.length * 4);
    alphas.forEach((a, i) => (px[i * 4 + 3] = a));
    return px;
  };
  const rep = (a: number, n: number) => new Array<number>(n).fill(a);
  assert.equal(classifyAlpha(make(rep(255, 100))), 'opaque');
  // Foliage: transparent and opaque areas, soft edges
  assert.equal(classifyAlpha(make([...rep(0, 50), ...rep(128, 20), ...rep(255, 30)])), 'binary');
  // Glass: nothing fully transparent
  assert.equal(classifyAlpha(make([...rep(120, 80), ...rep(255, 20)])), 'graded');
  // Shadow: nothing opaque
  assert.equal(classifyAlpha(make([...rep(0, 60), ...rep(100, 40)])), 'graded');
});
