/**
 * Interior entrance markers: the translucent pink cylinder the game draws in
 * front of an enterable door, topped with an arrow to spot it from afar. An
 * identical marker inside is used to get back out.
 */
import * as THREE from 'three';
import type { InteriorInfo } from '../shared/format.ts';
import { globalUniforms } from './materials.ts';

/** Distance at which markers become visible. */
const VISIBLE_DISTANCE = 100;
/** Cylinder radius, the one used by the game script's position checks. */
const RADIUS = 1.5;

const VERTEX = /* glsl */ `
varying float vHeight;
varying float vDist;
void main() {
  vHeight = uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vDist = length(mv.xyz);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uSolid;
uniform float uFogNear;
uniform float uFogFar;
varying float vHeight;
varying float vDist;
void main() {
  // The game's pink, denser at the base, with a slight pulse.
  float pulse = 0.82 + 0.18 * sin(uTime * 4.0);
  float a = mix(0.55 * (1.0 - vHeight) * (1.0 - vHeight) + 0.08, 0.85, uSolid) * pulse;
  float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  gl_FragColor = vec4(vec3(1.0, 0.25, 0.72), a * (1.0 - fog));
}
`;

/** What a marker points to: an interior to enter, or the exit of the current interior. */
export type MarkerTarget = { kind: 'enter'; interior: InteriorInfo } | { kind: 'exit' };

interface Marker {
  target: MarkerTarget;
  object: THREE.Group;
  arrow: THREE.Mesh;
  position: THREE.Vector3;
}

export class InteriorMarkers {
  readonly group = new THREE.Group();
  private readonly markers: Marker[] = [];
  private readonly exitMarker: Marker;
  private readonly cylinder: THREE.BufferGeometry;
  private readonly cone: THREE.BufferGeometry;
  private readonly sphere = new THREE.Sphere();

  constructor(interiors: InteriorInfo[]) {
    this.group.name = 'markers';
    // three.js primitives are built around the Y axis: rotate them upright onto Z.
    this.cylinder = new THREE.CylinderGeometry(RADIUS, RADIUS, 2.6, 28, 1, true).rotateX(Math.PI / 2).translate(0, 0, 1.3);
    this.cone = new THREE.ConeGeometry(0.45, 1.1, 4).rotateX(-Math.PI / 2);
    for (const interior of interiors) this.markers.push(this.make({ kind: 'enter', interior }, interior.door));
    this.exitMarker = this.make({ kind: 'exit' }, [0, 0, 0]);
    this.exitMarker.object.visible = false;
  }

  private make(target: MarkerTarget, at: [number, number, number]): Marker {
    const material = (solid: number) =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          uTime: globalUniforms.uTime,
          uSolid: { value: solid },
          uFogNear: globalUniforms.uFogNear,
          uFogFar: globalUniforms.uFogFar,
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
    const object = new THREE.Group();
    const body = new THREE.Mesh(this.cylinder, material(0));
    const arrow = new THREE.Mesh(this.cone, material(1));
    body.renderOrder = arrow.renderOrder = 4;
    object.add(body, arrow);
    const position = new THREE.Vector3(at[0], at[1], at[2]);
    // The script's point is at waist height: the cylinder's base is one metre lower.
    object.position.set(at[0], at[1], at[2] - 1);
    this.group.add(object);
    return { target, object, arrow, position };
  }

  /** Active markers: the doors when outdoors, or just the exit when inside an interior. */
  private active(inside: InteriorInfo | null): Marker[] {
    return inside ? [this.exitMarker] : this.markers;
  }

  update(time: number, camera: THREE.Vector3, inside: InteriorInfo | null): void {
    if (inside) {
      this.exitMarker.position.set(inside.spawn[0], inside.spawn[1], inside.spawn[2]);
      this.exitMarker.object.position.set(inside.spawn[0], inside.spawn[1], inside.spawn[2] - 1);
    }
    this.exitMarker.object.visible = inside !== null;
    for (const m of this.markers) m.object.visible = !inside && m.position.distanceTo(camera) < VISIBLE_DISTANCE;
    for (const m of this.active(inside)) {
      if (!m.object.visible) continue;
      m.arrow.position.z = 4.2 + 0.35 * Math.sin(time * 2.5);
      m.arrow.rotation.z = time * 1.5;
    }
  }

  /** Marker hit by a ray (click), nearest first. */
  pick(ray: THREE.Ray, inside: InteriorInfo | null): MarkerTarget | null {
    let best: Marker | null = null;
    let bestD = Infinity;
    for (const m of this.active(inside)) {
      if (!m.object.visible) continue;
      this.sphere.center.set(m.position.x, m.position.y, m.position.z + 0.8);
      this.sphere.radius = 2.6;
      if (!ray.intersectsSphere(this.sphere)) continue;
      const d = m.position.distanceTo(ray.origin);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best?.target ?? null;
  }

  /** Marker containing a point (character walking into it, or camera right next to it). */
  at(p: THREE.Vector3, inside: InteriorInfo | null, radius = RADIUS): MarkerTarget | null {
    for (const m of this.active(inside)) {
      if (Math.hypot(m.position.x - p.x, m.position.y - p.y) < radius && Math.abs(m.position.z - p.z) < 3) return m.target;
    }
    return null;
  }
}
