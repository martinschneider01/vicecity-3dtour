/**
 * Reads an IFP version 1 ("ANPK") animation archive, the GTA III and
 * Vice City format. Structure, as nested blocks (4-letter name, size,
 * content aligned to 4 bytes):
 *
 *   ANPK  INFO (animation count, name)
 *         then per animation: NAME, DGAN { INFO (bone count),
 *           per bone: CPAN { ANIM (bone name, frame count, ID),
 *                            KR00 | KRT0 | KRTS (keyframes) } }
 *
 * A keyframe holds a rotation (quaternion), optionally a translation and a
 * scale, then its time in seconds.
 */
import { Reader } from './binary.ts';

export interface IfpTrack {
  /** Bone name as written in the file. */
  bone: string;
  /** HAnim bone ID (Vice City), or -1. */
  boneId: number;
  times: Float32Array;
  /** Ready-to-use x, y, z, w quaternions (already conjugated, see below). */
  rotations: Float32Array;
  /** x, y, z translations, or null if the animation has none for this bone. */
  translations: Float32Array | null;
}

export interface IfpAnimation {
  name: string;
  duration: number;
  tracks: IfpTrack[];
}

interface Block {
  id: string;
  start: number;
  end: number;
}

function block(r: Reader): Block {
  const id = r.buf.toString('latin1', r.pos, r.pos + 4);
  const size = r.buf.readUInt32LE(r.pos + 4);
  const start = r.pos + 8;
  r.pos = start;
  return { id, start, end: start + ((size + 3) & ~3) };
}

function expect(r: Reader, id: string): Block {
  const b = block(r);
  if (b.id !== id) throw new Error(`IFP: unexpected block ${b.id} at ${b.start - 8}, expected ${id}`);
  return b;
}

export function parseIfp(buf: Buffer): IfpAnimation[] {
  const r = new Reader(buf);
  expect(r, 'ANPK');
  const info = expect(r, 'INFO');
  const count = r.i32();
  r.pos = info.end;
  const out: IfpAnimation[] = [];
  for (let a = 0; a < count; a++) {
    const nameBlock = expect(r, 'NAME');
    const name = r.fixedString(nameBlock.end - nameBlock.start);
    r.pos = nameBlock.end;
    const dgan = expect(r, 'DGAN');
    const dinfo = expect(r, 'INFO');
    const numTracks = r.i32();
    r.pos = dinfo.end;
    const tracks: IfpTrack[] = [];
    let duration = 0;
    for (let t = 0; t < numTracks; t++) {
      const cpan = expect(r, 'CPAN');
      const anim = expect(r, 'ANIM');
      const bone = r.fixedString(28);
      const numFrames = r.i32();
      // Vice City appends the bone ID at the end of the block (44-byte block).
      const boneId = anim.end - anim.start >= 44 ? buf.readInt32LE(anim.start + 40) : -1;
      r.pos = anim.end;
      const times = new Float32Array(numFrames);
      const rotations = new Float32Array(numFrames * 4);
      let translations: Float32Array | null = null;
      if (numFrames > 0) {
        const kf = block(r);
        const hasTrans = kf.id === 'KRT0' || kf.id === 'KRTS';
        const hasScale = kf.id === 'KRTS';
        if (kf.id !== 'KR00' && !hasTrans) throw new Error(`IFP: unknown keyframe type ${kf.id}`);
        if (hasTrans) translations = new Float32Array(numFrames * 3);
        for (let f = 0; f < numFrames; f++) {
          // The game negates x, y, z on load: the file's quaternion is the conjugate.
          rotations[f * 4] = -r.f32();
          rotations[f * 4 + 1] = -r.f32();
          rotations[f * 4 + 2] = -r.f32();
          rotations[f * 4 + 3] = r.f32();
          if (translations) {
            translations[f * 3] = r.f32();
            translations[f * 3 + 1] = r.f32();
            translations[f * 3 + 2] = r.f32();
          }
          if (hasScale) r.skip(12);
          times[f] = r.f32();
        }
        duration = Math.max(duration, times[numFrames - 1]);
        r.pos = kf.end;
      }
      tracks.push({ bone, boneId, times, rotations, translations });
      r.pos = cpan.end;
    }
    r.pos = dgan.end;
    out.push({ name, duration, tracks });
  }
  return out;
}
