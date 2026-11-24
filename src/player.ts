/**
 * "On foot" mode: the game's character (Tommy Vercetti), animated, running
 * around the map, followed by a third-person camera.
 *
 * The model, its skeleton and its animations come from player.bin, converted
 * from player.dff and anim/ped.ifp. Collisions use raycasts against the
 * rendered geometry: one ray down for the ground, horizontal rays for walls.
 */
import * as THREE from 'three';
import { PED_MAGIC, type PedHeader } from '../shared/format.ts';
import { globalUniforms } from './materials.ts';
import type { TextureArrays } from './textures.ts';
import { fetchPack, type RayHit } from './tile.ts';
import type { World } from './world.ts';

const DEG = Math.PI / 180;
/** A game character's origin is 1 m above its feet. */
const ORIGIN_HEIGHT = 1.0;
/** Character radius for wall collisions. */
const RADIUS = 0.35;
/** Step height that can be climbed without jumping. */
const STEP = 0.45;
const GRAVITY = 22;
/** Maximum water depth: Tommy can't swim, he wades. */
const WADE_DEPTH = 1.0;
/** Fraction of the sprint animation's speed (as is, it gives nearly 15 m/s). */
const SPRINT_RATE = 0.7;

const VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform vec3 uAmbientObj;
uniform vec3 uDirColor;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vLight;
varying float vDist;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 n = normalize(mat3(modelMatrix) * objectNormal);
  // Like the game's characters: the "objects" ambient light from timecyc.dat plus a directional light.
  vLight = min(uAmbientObj + uDirColor * (0.25 + 0.55 * max(dot(n, uSunDir), 0.0)), vec3(1.0));
  vUv = uv;
  vDist = length(mv.xyz);
}
`;

const FRAGMENT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray map;
uniform float uLayer;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying vec3 vLight;
varying float vDist;
void main() {
  vec3 c = texture(map, vec3(vUv, uLayer)).rgb * vLight;
  float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  gl_FragColor = vec4(mix(c, uFogColor, fog), 1.0);
}
`;

export interface MoveInput {
  /** Forward/back and right/left, from -1 to 1, relative to the camera. */
  forward: number;
  right: number;
  sprint: boolean;
}

export class Player {
  readonly group = new THREE.Group();
  /** World position of the feet. */
  readonly position = new THREE.Vector3();
  /** Character heading in radians (0 = north, clockwise). */
  heading = 0;
  /** Camera distance, adjustable with the mouse wheel. */
  cameraDistance = 4.5;
  grounded = false;
  ready = false;
  private velocityZ = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current = '';
  /** Movement speed of each animation, derived from how far its root travels. */
  private readonly clipSpeed = new Map<string, number>();
  private readonly lastSafe = new THREE.Vector3();
  private readonly hit: RayHit = { t: 0, hit: false, nx: 0, ny: 0, nz: 0 };

  constructor() {
    this.group.name = 'player';
    this.group.visible = false;
  }

  async load(url: string, textures: TextureArrays): Promise<void> {
    const buf = await fetchPack(url);
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== PED_MAGIC) throw new Error('invalid character file');
    const headerLen = dv.getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen))) as PedHeader;
    const base = 8 + headerLen;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, base + h.pos, h.verts * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf, base + h.nrm, h.verts * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, base + h.uv, h.verts * 2), 2));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(new Uint8Array(buf, base + h.skinIndex, h.verts * 4)), 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(buf, base + h.skinWeight, h.verts * 4), 4));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(buf, base + h.idx, h.indices), 1));

    // Bones: local rest transform = the frame's matrix (basis vectors as columns).
    const bones = h.bones.map((b, i) => {
      const bone = new THREE.Bone();
      bone.name = `b${i}`;
      const r = b.rot;
      new THREE.Matrix4()
        .set(r[0], r[3], r[6], b.pos[0], r[1], r[4], r[7], b.pos[1], r[2], r[5], r[8], b.pos[2], 0, 0, 0, 1)
        .decompose(bone.position, bone.quaternion, bone.scale);
      return bone;
    });
    h.bones.forEach((b, i) => {
      if (b.parent >= 0) bones[b.parent].add(bones[i]);
    });
    const inv = new Float32Array(buf, base + h.inverseBind, h.bones.length * 16);
    const inverses = h.bones.map((_, i) => {
      const m = new THREE.Matrix4().fromArray(inv, i * 16);
      // In the file, the 4th component of each vector is an internal RenderWare field.
      m.elements[3] = m.elements[7] = m.elements[11] = 0;
      m.elements[15] = 1;
      return m;
    });

    await textures.request([h.tex[0], h.tex[1]]);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        map: { value: textures.texture(h.tex[0]) },
        uLayer: { value: h.tex[1] },
        uAmbientObj: globalUniforms.uAmbientObj,
        uDirColor: globalUniforms.uDirColor,
        uSunDir: globalUniforms.uSunDir,
        uFogColor: globalUniforms.uFogColor,
        uFogNear: globalUniforms.uFogNear,
        uFogFar: globalUniforms.uFogFar,
      },
    });
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.frustumCulled = false;
    for (let i = 0; i < bones.length; i++) if (h.bones[i].parent < 0) mesh.add(bones[i]);
    mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
    this.group.add(mesh);

    this.mixer = new THREE.AnimationMixer(mesh);
    for (const clip of h.clips) {
      const tracks: THREE.KeyframeTrack[] = [];
      for (const t of clip.tracks) {
        const times = new Float32Array(buf, base + t.times, t.count);
        tracks.push(new THREE.QuaternionKeyframeTrack(`b${t.bone}.quaternion`, times, new Float32Array(buf, base + t.rot, t.count * 4)));
        if (t.pos >= 0) {
          const pos = new Float32Array(buf.slice(base + t.pos, base + t.pos + t.count * 12));
          if (h.bones[t.bone].parent < 0) {
            // The root moves along +Y during the cycle: that is the character's
            // speed. Measure it, then remove it so the character runs in place.
            const travel = pos[(t.count - 1) * 3 + 1] - pos[1];
            if (clip.duration > 0) this.clipSpeed.set(clip.name, Math.abs(travel) / clip.duration);
            for (let k = 0; k < t.count; k++) pos[k * 3 + 1] = 0;
          }
          tracks.push(new THREE.VectorKeyframeTrack(`b${t.bone}.position`, times, pos));
        }
      }
      const action = this.mixer.clipAction(new THREE.AnimationClip(clip.name, clip.duration, tracks));
      action.setLoop(THREE.LoopRepeat, Infinity);
      this.actions.set(clip.name, action);
    }
    this.play('idle_stance', 0);
    this.ready = true;
  }

  private play(name: string, fade = 0.15): void {
    if (name === this.current || !this.actions.has(name)) return;
    const next = this.actions.get(name)!;
    const prev = this.actions.get(this.current);
    next.reset().play();
    next.timeScale = name === 'sprint_civi' ? SPRINT_RATE : 1;
    if (prev && fade > 0) next.crossFadeFrom(prev, fade, false);
    else prev?.stop();
    this.current = name;
  }

  /** Places the character at a spot (feet on the ground), with no velocity. */
  place(x: number, y: number, z: number, heading = this.heading): void {
    this.position.set(x, y, z);
    this.lastSafe.copy(this.position);
    this.heading = heading;
    this.velocityZ = 0;
    this.grounded = false;
    this.sync();
  }

  private sync(): void {
    this.group.position.set(this.position.x, this.position.y, this.position.z + ORIGIN_HEIGHT);
    // The model faces +Y; heading turns clockwise seen from above.
    this.group.rotation.set(0, 0, -this.heading);
    this.group.updateMatrix();
  }

  /**
   * Advances the simulation by dt seconds.
   * cameraYaw: camera heading in degrees (keys are relative to the camera).
   */
  update(dt: number, input: MoveInput, cameraYaw: number, world: World, seaLevel: number): void {
    if (!this.ready) return;
    const hit = this.hit;
    const p = this.position;
    const moving = input.forward !== 0 || input.right !== 0;
    const clip = moving ? (input.sprint ? 'sprint_civi' : 'run_player') : 'idle_stance';
    this.play(clip);

    if (moving) {
      const yaw = cameraYaw * DEG;
      let mx = Math.sin(yaw) * input.forward + Math.cos(yaw) * input.right;
      let my = Math.cos(yaw) * input.forward - Math.sin(yaw) * input.right;
      const len = Math.hypot(mx, my);
      mx /= len;
      my /= len;
      // The character turns towards its running direction.
      const target = Math.atan2(mx, my);
      let diff = target - this.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      this.heading += diff * Math.min(1, dt * 12);

      const speed = (this.clipSpeed.get(clip) ?? 6.4) * (clip === 'sprint_civi' ? SPRINT_RATE : 1);
      let stepX = mx * speed * dt;
      let stepY = my * speed * dt;
      // Walls: two passes, the second along the wall that was hit (sliding).
      for (let pass = 0; pass < 2; pass++) {
        const dist = Math.hypot(stepX, stepY);
        if (dist < 1e-5) break;
        const dx = stepX / dist;
        const dy = stepY / dist;
        let blocked = false;
        for (const height of [STEP, 1.0, 1.6]) {
          world.raycast(p.x, p.y, p.z + height, dx, dy, 0, dist + RADIUS, hit);
          if (hit.hit) {
            // Remove the component of the movement that goes into the wall.
            const nl = Math.hypot(hit.nx, hit.ny);
            if (nl > 0.05) {
              const nx = hit.nx / nl;
              const ny = hit.ny / nl;
              const into = stepX * nx + stepY * ny;
              stepX -= into * nx;
              stepY -= into * ny;
            } else {
              stepX = 0;
              stepY = 0;
            }
            blocked = true;
            break;
          }
        }
        if (!blocked) {
          p.x += stepX;
          p.y += stepY;
          break;
        }
        if (pass === 1) break;
      }
    }

    // Ground: ray cast down from step height.
    const reach = STEP + (this.grounded ? STEP : 0.05) + Math.max(0, -this.velocityZ * dt);
    world.raycast(p.x, p.y, p.z + STEP, 0, 0, -1, reach, hit);
    const waterFloor = seaLevel - WADE_DEPTH;
    if (hit.hit && this.velocityZ <= 0) {
      p.z += STEP - hit.t;
      this.velocityZ = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
      this.velocityZ -= GRAVITY * dt;
      p.z += this.velocityZ * dt;
    }
    if (p.z < waterFloor) {
      // In water: don't sink deeper than waist height.
      p.z = waterFloor;
      this.velocityZ = 0;
      this.grounded = true;
    }
    if (this.grounded) this.lastSafe.copy(p);
    else if (p.z < this.lastSafe.z - 80) this.place(this.lastSafe.x, this.lastSafe.y, this.lastSafe.z + 0.5);

    this.mixer!.update(dt);
    this.sync();
  }

  /**
   * Places the camera behind the character, as in the game: it orbits around
   * them with the mouse and moves closer if a wall gets in the way.
   */
  applyCamera(camera: THREE.Camera, yawDeg: number, pitchDeg: number, world: World): void {
    const yaw = yawDeg * DEG;
    const pitch = pitchDeg * DEG;
    const cp = Math.cos(pitch);
    const fx = Math.sin(yaw) * cp;
    const fy = Math.cos(yaw) * cp;
    const fz = Math.sin(pitch);
    const tx = this.position.x;
    const ty = this.position.y;
    const tz = this.position.z + 1.55;
    let dist = this.cameraDistance;
    world.raycast(tx, ty, tz, -fx, -fy, -fz, dist + 0.3, this.hit);
    if (this.hit.hit) dist = Math.max(0.6, this.hit.t - 0.3);
    camera.position.set(tx - fx * dist, ty - fy * dist, tz - fz * dist);
  }
}
