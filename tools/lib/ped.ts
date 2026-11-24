/**
 * Exports a character (skinned model, skeleton and animations) for the
 * viewer's "on foot" mode.
 *
 * A character DFF contains a frame hierarchy (the bones), a geometry and a
 * Skin plugin (4 bones and 4 weights per vertex, one inverse matrix per
 * bone). The skin's bone order is that of the root frame's HAnim plugin;
 * animations (IFP) refer to bones by their HAnim ID or, failing that, by
 * their name.
 */
import { PED_MAGIC, type PedBone, type PedClip, type PedHeader } from '../../shared/format.ts';
import type { IfpAnimation } from './ifp.ts';
import type { DffClump } from './rw.ts';
import type { TexRef } from './textures.ts';
import { Payload, packContainer } from './tile.ts';

export interface PedBuild {
  file: Buffer;
  notes: string[];
}

export function buildPed(clump: DffClump, animations: IfpAnimation[], clipNames: string[], tex: TexRef): PedBuild {
  const notes: string[] = [];
  const g = clump.geometries[clump.atomics[0].geometry];
  if (!g.skin || !g.normals || !g.uvs) throw new Error('the character model must have a skin, normals and UVs');
  const root = clump.frames.find((f) => f.boneOrder);
  if (!root?.boneOrder) throw new Error('missing HAnim hierarchy');
  const order = root.boneOrder;
  if (order.length !== g.skin.numBones) throw new Error(`${order.length} HAnim bones for ${g.skin.numBones} skin bones`);

  const frameOfBone = order.map((id) => clump.frames.findIndex((f) => f.boneId === id));
  if (frameOfBone.some((f) => f < 0)) throw new Error('HAnim bone without a frame');
  const boneOfFrame = new Map(frameOfBone.map((f, b) => [f, b]));
  const bones: PedBone[] = frameOfBone.map((fi) => {
    const f = clump.frames[fi];
    return { name: f.name, parent: boneOfFrame.get(f.parent) ?? -1, pos: [...f.pos], rot: [...f.rot] };
  });

  const payload = new Payload();
  const clips: PedClip[] = [];
  for (const wanted of clipNames) {
    const anim = animations.find((a) => a.name.toLowerCase() === wanted.toLowerCase());
    if (!anim) {
      notes.push(`animation "${wanted}" missing from ped.ifp`);
      continue;
    }
    const clip: PedClip = { name: wanted, duration: anim.duration, tracks: [] };
    for (const t of anim.tracks) {
      let bone = t.boneId >= 0 ? order.indexOf(t.boneId) : -1;
      if (bone < 0) bone = bones.findIndex((b) => b.name.toLowerCase() === t.bone.toLowerCase());
      if (bone < 0 || t.times.length === 0) continue;
      clip.tracks.push({
        bone,
        count: t.times.length,
        times: payload.add(t.times),
        rot: payload.add(t.rotations),
        pos: t.translations ? payload.add(t.translations) : -1,
      });
    }
    clips.push(clip);
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 2; i < g.positions.length; i += 3) {
    minZ = Math.min(minZ, g.positions[i]);
    maxZ = Math.max(maxZ, g.positions[i]);
  }
  const header: PedHeader = {
    verts: g.numVerts,
    indices: g.indices.length,
    pos: payload.add(g.positions),
    nrm: payload.add(g.normals),
    uv: payload.add(g.uvs),
    skinIndex: payload.add(g.skin.boneIndices),
    skinWeight: payload.add(g.skin.weights),
    idx: payload.add(g.indices),
    inverseBind: payload.add(g.skin.inverseBind),
    tex: [tex.cls, tex.layer],
    bones,
    clips,
    minZ,
    maxZ,
  };
  return { file: packContainer(PED_MAGIC, header, payload), notes };
}
