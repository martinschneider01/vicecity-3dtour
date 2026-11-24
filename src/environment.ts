/**
 * Sky, fog, ambient light and water, driven by timecyc.dat.
 *
 * For a given time we linearly interpolate between the row for the current
 * hour and the row for the next hour, as the game does.
 */
import * as THREE from 'three';
import { TC, type Manifest, type TimecycWeather } from '../shared/format.ts';
import { globalUniforms } from './materials.ts';
import type { TextureArrays } from './textures.ts';


export interface EnvState {
  farClip: number;
  fogStart: number;
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uSunCore;
uniform vec3 uSunCorona;
uniform float uSunSize;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  // Gradient from the horizon (bottom color) to the zenith (top color).
  float t = smoothstep(0.0, 0.45, d.z);
  vec3 col = mix(uBottom, uTop, t);
  if (uSunDir.z > -0.05) {
    float s = max(dot(d, uSunDir), 0.0);
    float visible = smoothstep(-0.05, 0.03, uSunDir.z);
    float radius = 0.012 + 0.0015 * uSunSize;
    float disc = smoothstep(cos(radius * 1.15), cos(radius), s);
    float halo = pow(s, 300.0 / uSunSize) * 0.35;
    col = mix(col, uSunCore, disc * visible);
    col += uSunCorona * halo * visible * (1.0 - disc);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

// Water rectangles are up to several kilometres across: the distance to the
// camera must be computed per pixel (a distance interpolated between distant
// vertices would drown nearby water in fog).
const WATER_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = position.xy / 32.0;
  vView = mv.xyz;
}
`;

const WATER_FRAGMENT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray map;
uniform float uLayer;
uniform float uHasMap;
uniform vec4 uColor;
uniform float uTime;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying vec3 vView;
void main() {
  float vDist = length(vView);
  vec3 c = uColor.rgb;
  if (uHasMap > 0.5) {
    // Two layers of the game's water texture scrolling at different speeds.
    vec3 a = texture(map, vec3(vUv + vec2(uTime * 0.021, uTime * 0.013), uLayer)).rgb;
    vec3 b = texture(map, vec3(vUv * 0.61 + vec2(-uTime * 0.012, uTime * 0.017), uLayer)).rgb;
    c *= (a + b) * 0.5 * 1.35;
  }
  float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  c = mix(c, uFogColor, fog);
  gl_FragColor = vec4(c, mix(uColor.a, 1.0, fog));
}
`;

/** How far the fog is pushed out when it is about to roll in (fogAmount = 0). */
export const FOG_FADE_DISTANCE = 12000;

function lerpRow(a: number[], b: number[], t: number, out: Float32Array): void {
  for (let i = 0; i < TC.COUNT; i++) out[i] = a[i] + (b[i] - a[i]) * t;
}

const UNDERLAY_VERTEX = /* glsl */ `
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vView = mv.xyz;
}
`;

const UNDERLAY_FRAGMENT = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vView;
void main() {
  float fog = clamp((length(vView) - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(0.07, 0.065, 0.06), uFogColor, fog), 1.0);
}
`;

/** Builds a flat mesh of horizontal rectangles [x0, y0, x1, y1(, z)]. */
function rectGeometry(rects: number[], stride: number, zOf: (i: number) => number): THREE.BufferGeometry {
  const count = rects.length / stride;
  const positions = new Float32Array(count * 12);
  const indices = new Uint32Array(count * 6);
  for (let i = 0, q = 0; i < rects.length; i += stride, q++) {
    const [x0, y0, x1, y1] = [rects[i], rects[i + 1], rects[i + 2], rects[i + 3]];
    const h = zOf(i);
    positions.set([x0, y0, h, x1, y0, h, x1, y1, h, x0, y1, h], q * 12);
    indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

export class Environment {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  readonly water: THREE.Mesh;
  /**
   * Dark backdrop beneath dry land. A few buildings have no roof in the game
   * data (you are never meant to see them from above); without this backdrop
   * the sky color would show through.
   */
  readonly underlay: THREE.Mesh;
  /** Decimal hour, 0 to 24. */
  hour = 12;
  weather = 0;
  /** The game's fog and far plane; disabled for overview shots. */
  fogEnabled = true;
  /**
   * How much of the game's fog applies, 0 to 1, when enabled: rises
   * gradually during the flight down from the intro, so the fog rolls in
   * instead of switching on.
   */
  fogAmount = 1;
  readonly state: EnvState = { farClip: 2000, fogStart: 10 };
  readonly weathers: TimecycWeather[];
  private readonly row = new Float32Array(TC.COUNT);
  private readonly skyUniforms = {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 0, 1) },
    uSunCore: { value: new THREE.Color() },
    uSunCorona: { value: new THREE.Color() },
    uSunSize: { value: 1 },
  };
  private readonly waterUniforms;
  readonly clearColor = new THREE.Color();

  constructor(manifest: Manifest, textures: TextureArrays) {
    this.weathers = manifest.timecyc;

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // Water: the rectangles of the game's grid, plus a flat ocean all around.
    const w = manifest.water;
    const rects = [...w.rects];
    const R = 30000;
    const z = w.seaLevel;
    rects.push(-R, -R, R, w.min[1], z, -R, w.max[1], R, R, z, -R, w.min[1], w.min[0], w.max[1], z, w.max[0], w.min[1], R, w.max[1], z);
    const geo = rectGeometry(rects, 5, (i) => rects[i + 4]);

    // Backdrop beneath dry land, 6 m below sea level, only visible from above.
    this.underlay = new THREE.Mesh(
      rectGeometry(w.land, 4, () => w.seaLevel - 6),
      new THREE.ShaderMaterial({
        vertexShader: UNDERLAY_VERTEX,
        fragmentShader: UNDERLAY_FRAGMENT,
        uniforms: {
          uFogColor: globalUniforms.uFogColor,
          uFogNear: globalUniforms.uFogNear,
          uFogFar: globalUniforms.uFogFar,
        },
        side: THREE.FrontSide,
      }),
    );
    this.underlay.frustumCulled = false;
    this.group.add(this.underlay);
    this.waterUniforms = {
      map: { value: w.tex ? textures.texture(w.tex[0]) : null },
      uLayer: { value: w.tex ? w.tex[1] : 0 },
      uHasMap: { value: w.tex ? 1 : 0 },
      uColor: { value: new THREE.Vector4(0.3, 0.6, 0.6, 0.75) },
      uTime: globalUniforms.uTime,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    };
    if (w.tex) textures.request([w.tex[0], w.tex[1]]).catch((e) => console.error('Water texture not loaded', e));
    this.water = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
        uniforms: this.waterUniforms,
        transparent: true,
        // Water writes depth: transparent things below the surface (the bottom
        // of the lighthouse beam, for example) must not draw on top of it.
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );
    // After opaque geometry, before the world's transparent batches.
    this.water.renderOrder = 1;
    this.water.frustumCulled = false;
    this.group.add(this.water);
  }

  /** Recomputes every color for the current time and weather. */
  update(camera: THREE.Camera): void {
    const w = this.weathers[Math.min(this.weather, this.weathers.length - 1)];
    const h = ((this.hour % 24) + 24) % 24;
    const h0 = Math.floor(h) % 24;
    const h1 = (h0 + 1) % 24;
    const row = this.row;
    lerpRow(w.hours[h0], w.hours[h1], h - Math.floor(h), row);

    const top = this.skyUniforms.uTop.value.setRGB(row[TC.SKY_TOP] / 255, row[TC.SKY_TOP + 1] / 255, row[TC.SKY_TOP + 2] / 255);
    const bottom = this.skyUniforms.uBottom.value.setRGB(row[TC.SKY_BOTTOM] / 255, row[TC.SKY_BOTTOM + 1] / 255, row[TC.SKY_BOTTOM + 2] / 255);
    this.skyUniforms.uSunCore.value.setRGB(row[TC.SUN_CORE] / 255, row[TC.SUN_CORE + 1] / 255, row[TC.SUN_CORE + 2] / 255);
    this.skyUniforms.uSunCorona.value.setRGB(row[TC.SUN_CORONA] / 255, row[TC.SUN_CORONA + 1] / 255, row[TC.SUN_CORONA + 2] / 255);
    this.skyUniforms.uSunSize.value = Math.max(1, row[TC.SUN_SIZE]);
    // The game's sun path: rises in the east (+X) at 6:00, peaks at noon, sets in the west.
    const angle = (2 * Math.PI * h) / 24;
    this.skyUniforms.uSunDir.value.set(Math.sin(angle), 1, 0.2 - Math.cos(angle)).normalize();

    // The game's fog: (sky top + 2 x sky bottom) / 3.
    globalUniforms.uFogColor.value.setRGB((top.r + 2 * bottom.r) / 3, (top.g + 2 * bottom.g) / 3, (top.b + 2 * bottom.b) / 3);
    this.clearColor.copy(globalUniforms.uFogColor.value);
    this.state.farClip = row[TC.FAR_CLIP];
    this.state.fogStart = row[TC.FOG_START];
    if (this.fogEnabled) {
      // Partial fog: both distances pushed out, up to well beyond the view.
      const out = (1 - this.fogAmount) * FOG_FADE_DISTANCE;
      globalUniforms.uFogNear.value = this.state.fogStart + out;
      globalUniforms.uFogFar.value = this.state.farClip + out;
    } else {
      globalUniforms.uFogNear.value = 1e9;
      globalUniforms.uFogFar.value = 2e9;
    }
    // "Amb" column: ambient light the game adds to the buildings' prelit colors.
    globalUniforms.uAmbient.value.setRGB(row[TC.AMB] / 255, row[TC.AMB + 1] / 255, row[TC.AMB + 2] / 255);
    globalUniforms.uAmbientObj.value.setRGB(row[TC.AMB_OBJ] / 255, row[TC.AMB_OBJ + 1] / 255, row[TC.AMB_OBJ + 2] / 255);
    globalUniforms.uDirColor.value.setRGB(row[TC.DIR] / 255, row[TC.DIR + 1] / 255, row[TC.DIR + 2] / 255);
    // At night the sun is below the horizon: directional light then comes from the zenith.
    const sun = this.skyUniforms.uSunDir.value;
    if (sun.z > 0.1) globalUniforms.uSunDir.value.copy(sun);
    else globalUniforms.uSunDir.value.set(0.3, 0.3, 0.9).normalize();
    this.waterUniforms.uColor.value.set(row[TC.WATER] / 255, row[TC.WATER + 1] / 255, row[TC.WATER + 2] / 255, row[TC.WATER + 3] / 255);

    // The sky dome follows the camera and stays inside the far plane.
    const far = (camera as THREE.PerspectiveCamera).far ?? 2000;
    this.sky.position.copy(camera.position);
    this.sky.scale.setScalar(far * 0.5);
    this.sky.updateMatrix();
  }
}
