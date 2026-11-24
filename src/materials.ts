/**
 * World materials. One material per (texture class, mode) pair.
 *
 * Rendering reproduces the game's logic: no dynamic lighting, the color comes
 * from the texture multiplied by (prelit vertex color + ambient color from
 * timecyc.dat), then blended with fog. No color space conversion: as in the
 * game, all the math is done directly on the texture values.
 */
import * as THREE from 'three';
import { MODE, batchKeyClass, batchKeyMode } from '../shared/format.ts';
import type { TextureArrays } from './textures.ts';

/** Uniforms shared by all world materials (same objects, updated once per frame). */
export const globalUniforms = {
  uAmbient: { value: new THREE.Color(1, 1, 1) },
  uFogColor: { value: new THREE.Color(0.5, 0.6, 0.7) },
  uFogNear: { value: 10 },
  uFogFar: { value: 2000 },
  uTime: { value: 0 },
  /** Character lighting: "objects" ambient, directional light and sun direction. */
  uAmbientObj: { value: new THREE.Color(0.4, 0.4, 0.4) },
  uDirColor: { value: new THREE.Color(1, 1, 1) },
  uSunDir: { value: new THREE.Vector3(0, 0, 1) },
};

const VERTEX = /* glsl */ `
#include <batching_pars_vertex>
attribute vec4 acolor;
attribute vec4 aamb;
attribute float layer;
uniform vec3 uAmbient;
varying vec2 vUv;
varying vec4 vColor;
varying float vLayer;
varying float vDist;
void main() {
  #include <batching_vertex>
  vec4 p = vec4(position, 1.0);
  #ifdef USE_BATCHING
    p = batchingMatrix * p;
  #endif
  vec4 mv = modelViewMatrix * p;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  // The game's lighting (Direct3D fixed pipeline): prelit vertex color plus
  // ambient light, clamped to 1 before being multiplied by the texture.
  vColor = vec4(min(acolor.rgb + uAmbient * aamb.rgb, vec3(1.0)), acolor.a);
  vLayer = layer;
  vDist = length(mv.xyz);
}
`;

const FRAGMENT = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray map;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying vec4 vColor;
varying float vLayer;
varying float vDist;
void main() {
  vec4 c = texture(map, vec3(vUv, vLayer)) * vColor;
  #if defined(MODE_CUTOUT)
    #ifdef USE_A2C
      // "Alpha to coverage" cutout: alpha becomes the fraction of MSAA samples
      // covered. Soft edges (leaves, thin cables) stay soft without needing to
      // sort objects. The transition is tightened so nearly transparent
      // fringes don't leave a ghost halo around foliage.
      c.a = clamp((c.a - 0.2) * 1.8, 0.0, 1.0);
      if (c.a < 0.05) discard;
    #else
      if (c.a < 0.5) discard;
      c.a = 1.0;
    #endif
  #elif defined(MODE_BLEND)
    // Like the game's alpha test: nearly invisible pixels must neither draw
    // nor write to the depth buffer.
    if (c.a < 0.03) discard;
  #elif defined(MODE_ADDITIVE)
    if (c.a < 0.004) discard;
  #else
    c.a = 1.0;
  #endif
  float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  #if defined(MODE_ADDITIVE)
    c.rgb *= 1.0 - fog;
  #else
    c.rgb = mix(c.rgb, uFogColor, fog);
  #endif
  gl_FragColor = c;
}
`;

export class WorldMaterials {
  private readonly cache = new Map<number, THREE.ShaderMaterial>();
  private readonly textures: TextureArrays;
  private readonly msaa: boolean;

  /** msaa: true if the framebuffer is multisampled (required for soft cutout). */
  constructor(textures: TextureArrays, msaa: boolean) {
    this.textures = textures;
    this.msaa = msaa;
  }

  get(key: number): THREE.ShaderMaterial {
    let m = this.cache.get(key);
    if (m) return m;
    const mode = batchKeyMode(key);
    const defines: Record<string, string> = {};
    const blend = mode === MODE.BLEND || mode === MODE.BLEND_UNDERWATER || mode === MODE.BLEND_NO_DEPTH;
    if (mode === MODE.CUTOUT) {
      defines.MODE_CUTOUT = '';
      if (this.msaa) defines.USE_A2C = '';
    } else if (blend) defines.MODE_BLEND = '';
    else if (mode === MODE.ADDITIVE) defines.MODE_ADDITIVE = '';
    m = new THREE.ShaderMaterial({
      name: `world-${batchKeyClass(key)}-${mode}`,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines,
      uniforms: {
        map: { value: this.textures.texture(batchKeyClass(key)) },
        uAmbient: globalUniforms.uAmbient,
        uFogColor: globalUniforms.uFogColor,
        uFogNear: globalUniforms.uFogNear,
        uFogFar: globalUniforms.uFogFar,
      },
      // The game doesn't reliably cull building back faces: many models
      // (vegetation, fences, awnings) rely on both sides being drawn.
      side: THREE.DoubleSide,
    });
    if (mode === MODE.CUTOUT) {
      m.alphaToCoverage = this.msaa;
    } else if (blend) {
      m.transparent = true;
      // As in the game, a transparent surface writes depth: a wall whose
      // texture has translucent windows must hide what is behind it. Only
      // models flagged "no depth write" in the IDEs (decals, shadows) are
      // exceptions. Submerged surfaces (the seabed) do not either: the water,
      // drawn right after, writes depth over them anyway, and their large
      // overlapping pieces, half faded out, would otherwise hide one another
      // depending on the sort order (dark wedges in the sea seen from the sky).
      m.depthWrite = mode !== MODE.BLEND_NO_DEPTH && mode !== MODE.BLEND_UNDERWATER;
      // Decals (road markings, shadows) lie on the ground: slight depth offset.
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -2;
    } else if (mode === MODE.ADDITIVE) {
      m.transparent = true;
      m.depthWrite = false;
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneFactor;
      m.blendEquation = THREE.AddEquation;
    }
    this.cache.set(key, m);
    return m;
  }
}
