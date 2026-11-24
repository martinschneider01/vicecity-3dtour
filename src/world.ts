/**
 * World: permanent far pack, detailed tiles (loaded around the camera or all
 * up front), optional interior, instance visibility, and raycasts against the
 * geometry.
 */
import * as THREE from 'three';
import type { InteriorInfo, Manifest, TileInfo } from '../shared/format.ts';
import type { WorldMaterials } from './materials.ts';
import type { TextureArrays } from './textures.ts';
import { TileContent, fetchPack, parseTile, type LodMode, type ParsedTile, type RayHit, type VisibilityQuery } from './tile.ts';

/** Margin added to the draw distance so a tile loads a little before it is needed. */
const LOAD_MARGIN = 40;
/** A loaded tile is only released beyond this extra margin. */
const UNLOAD_MARGIN = 160;
const MAX_CONCURRENT_LOADS = 6;
/** Delay before retrying a tile that failed to load. */
const RETRY_DELAY_MS = 3000;

type TileState = 'idle' | 'loading' | 'ready' | 'failed';

interface Tile {
  index: number;
  info: TileInfo;
  state: TileState;
  content: TileContent | null;
  /** Downloaded data waiting to be built (at most one tile per frame). */
  parsed: ParsedTile | null;
  /** Distance from the camera to the tile's box, recomputed every frame. */
  dist: number;
  /** Incremented on every unload, to ignore a load that is no longer needed. */
  generation: number;
  /** Time of the last failure, to space out retries. */
  failedAt: number;
}

export interface WorldStats {
  tilesReady: number;
  tilesLoading: number;
  tilesWanted: number;
  /** Tiles needed for the current view that are not displayed yet. */
  tilesMissing: number;
  instancesShown: number;
  trianglesLoaded: number;
  /** Longest tile build observed, in milliseconds. */
  maxBuildMs: number;
}

export class World {
  readonly group = new THREE.Group();
  /** Multiplier applied to every draw distance (the game's "draw distance" setting). */
  drawScale = 1.2;
  lodMode: LodMode = 'auto';
  /** True: all tiles are loaded up front and kept; false: loaded around the camera. */
  preload = true;
  /**
   * When set, only these tiles are loaded (whatever preload and the camera
   * say), nearest to loadFocus first; nothing is unloaded. Used while the
   * camera flies in from the intro: just what the arrival view shows.
   */
  loadOnly: ReadonlySet<number> | null = null;
  /** Point the loadOnly tiles are sorted by. */
  loadFocus: [number, number, number] | null = null;
  readonly stats: WorldStats = { tilesReady: 0, tilesLoading: 0, tilesWanted: 0, tilesMissing: 0, instancesShown: 0, trianglesLoaded: 0, maxBuildMs: 0 };
  far: TileContent | null = null;
  readonly tiles: Tile[];
  /** Interior we are currently in, or null when outdoors. */
  inside: InteriorInfo | null = null;
  lastError: string | null = null;
  private readonly baseUrl: string;
  private readonly materials: WorldMaterials;
  private readonly textures: TextureArrays;
  private readonly interiors = new Map<string, TileContent>();
  private loading = 0;
  private readonly query: VisibilityQuery;

  constructor(manifest: Manifest, baseUrl: string, materials: WorldMaterials, textures: TextureArrays) {
    this.baseUrl = baseUrl;
    this.materials = materials;
    this.textures = textures;
    this.tiles = manifest.tiles.map((info, index) => ({
      index, info, state: 'idle', content: null, parsed: null, dist: Infinity, generation: 0, failedAt: 0,
    }));
    this.group.name = 'world';
    this.group.matrixAutoUpdate = false;
    this.query = {
      x: 0, y: 0, z: 0, scale: 1, hour: 12, mode: 'auto', everywhereOnly: false, ignoreFar: false,
      hdReady: (tile: number): boolean => tile >= 0 && this.tiles[tile].state === 'ready',
    };
  }

  /**
   * Downloads a pack file and the textures it needs. The pack is only built
   * once its textures are on the GPU, so black faces are never shown.
   */
  private async fetchParsed(file: string): Promise<ParsedTile> {
    const parsed = parseTile(await fetchPack(this.baseUrl + file));
    await this.textures.request(parsed.header.tex);
    return parsed;
  }

  private show(content: TileContent): void {
    for (const m of content.meshes) this.group.add(m);
    this.stats.trianglesLoaded += content.triangles;
  }

  /** Loads the far pack (LODs for the whole map). Call once at startup. */
  async loadFar(file: string): Promise<void> {
    this.far = new TileContent(await this.fetchParsed(file), this.materials);
    this.show(this.far);
  }

  private async loadTile(tile: Tile): Promise<void> {
    tile.state = 'loading';
    this.loading++;
    const generation = tile.generation;
    try {
      const parsed = await this.fetchParsed(tile.info.file);
      // No longer needed in the meantime: drop it. Otherwise it waits for its turn to be built.
      if (tile.generation === generation) tile.parsed = parsed;
    } catch (e) {
      if (tile.generation === generation) {
        tile.state = 'failed';
        tile.failedAt = performance.now();
      }
      this.lastError = (e as Error).message;
      console.error('Tile failed to load (retrying in a few seconds)', tile.info.file, e);
    } finally {
      this.loading--;
    }
  }

  /**
   * Builds the batches of a downloaded tile. This is the expensive loading
   * step (a few milliseconds): update() only starts one per frame.
   */
  private buildTile(tile: Tile): void {
    const t0 = performance.now();
    const content = new TileContent(tile.parsed!, this.materials);
    this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, performance.now() - t0);
    tile.parsed = null;
    tile.content = content;
    tile.state = 'ready';
    this.show(content);
  }

  private unloadTile(tile: Tile): void {
    tile.generation++;
    tile.parsed = null;
    if (tile.content) {
      this.stats.trianglesLoaded -= tile.content.triangles;
      tile.content.dispose();
      tile.content = null;
    }
    tile.state = 'idle';
  }

  /** Enters an interior: loads its pack if needed, then shows only it and area 13. */
  async enterInterior(info: InteriorInfo): Promise<void> {
    let content = this.interiors.get(info.id);
    if (!content) {
      content = new TileContent(await this.fetchParsed(info.file), this.materials);
      this.interiors.set(info.id, content);
    }
    this.exitInterior();
    this.show(content);
    this.inside = info;
  }

  exitInterior(): void {
    if (!this.inside) return;
    const content = this.interiors.get(this.inside.id);
    if (content) {
      for (const m of content.meshes) m.removeFromParent();
      this.stats.trianglesLoaded -= content.triangles;
    }
    this.inside = null;
  }

  /** Call every frame with the camera position (game frame) and the whole hour. */
  update(cx: number, cy: number, cz: number, hour: number): void {
    const scale = this.drawScale;
    const only = this.loadOnly;
    const all = !only && (this.preload || this.lodMode === 'hd');
    const none = this.lodMode === 'lod';
    const [fx, fy, fz] = (only && this.loadFocus) || [cx, cy, cz];
    const now = performance.now();

    // Build at most one downloaded tile per frame, nearest first (distances
    // from the previous frame), to spread out the loading cost.
    let toBuild: Tile | null = null;
    for (const t of this.tiles) if (t.parsed && (!toBuild || t.dist < toBuild.dist)) toBuild = t;
    if (toBuild) this.buildTile(toBuild);

    const wanted: Tile[] = [];
    let ready = 0;
    let want = 0;
    let missing = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (t.info.count === 0) continue;
      const { min, max } = t.info;
      const dx = Math.max(min[0] - fx, 0, fx - max[0]);
      const dy = Math.max(min[1] - fy, 0, fy - max[1]);
      const dz = Math.max(min[2] - fz, 0, fz - max[2]);
      t.dist = Math.hypot(dx, dy, dz);
      const reach = t.info.far * scale;
      const needed = !none && (only ? only.has(i) : all || t.dist < reach + LOAD_MARGIN);
      if (t.state === 'failed' && now - t.failedAt > RETRY_DELAY_MS) t.state = 'idle';
      if (needed) {
        want++;
        if (t.state === 'idle') wanted.push(t);
        if (t.state !== 'ready') missing++;
      } else if (!only && (t.state === 'ready' || t.state === 'loading') && (none || t.dist > reach + LOAD_MARGIN + UNLOAD_MARGIN)) {
        this.unloadTile(t);
      }
      if (t.state === 'ready') ready++;
    }
    if (wanted.length && this.loading < MAX_CONCURRENT_LOADS) {
      wanted.sort((a, b) => a.dist - b.dist);
      for (const t of wanted) {
        if (this.loading >= MAX_CONCURRENT_LOADS) break;
        void this.loadTile(t);
      }
    }

    const q = this.query;
    q.x = cx;
    q.y = cy;
    q.z = cz;
    q.scale = scale;
    q.hour = hour;
    q.mode = this.lodMode;
    q.everywhereOnly = this.inside !== null;
    let shown = 0;
    q.ignoreFar = true;
    if (this.far) shown += this.far.updateVisibility(q);
    q.ignoreFar = false;
    for (const t of this.tiles) if (t.content) shown += t.content.updateVisibility(q);
    if (this.inside) {
      // The interior itself: always shown in full, whatever the distance.
      q.everywhereOnly = false;
      q.mode = 'hd';
      shown += this.interiors.get(this.inside.id)!.updateVisibility(q);
    }
    this.stats.tilesReady = ready;
    this.stats.tilesLoading = this.loading;
    this.stats.tilesWanted = want;
    this.stats.tilesMissing = missing;
    this.stats.instancesShown = shown;
  }

  /** True when everything the current view needs is loaded. */
  get settled(): boolean {
    return !!this.far && this.loading === 0 && this.textures.inFlight === 0 && this.stats.tilesMissing === 0;
  }

  /**
   * First solid obstacle along a ray (unit direction), up to maxT.
   * Only tests loaded detailed tiles and the current interior: LODs are not
   * obstacles.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, hit: RayHit): RayHit {
    hit.t = maxT;
    hit.hit = false;
    const x0 = Math.min(ox, ox + dx * maxT), x1 = Math.max(ox, ox + dx * maxT);
    const y0 = Math.min(oy, oy + dy * maxT), y1 = Math.max(oy, oy + dy * maxT);
    const z0 = Math.min(oz, oz + dz * maxT), z1 = Math.max(oz, oz + dz * maxT);
    const test = (c: TileContent) => {
      const b = c.box;
      if (x1 < b.min.x || x0 > b.max.x || y1 < b.min.y || y0 > b.max.y || z1 < b.min.z || z0 > b.max.z) return;
      c.raycast(ox, oy, oz, dx, dy, dz, hit);
    };
    for (const t of this.tiles) if (t.content) test(t.content);
    if (this.inside) test(this.interiors.get(this.inside.id)!);
    return hit;
  }

  /** Name of the model hit by a ray (diagnostics tool). */
  pick(raycaster: THREE.Raycaster): { model: string; distance: number; point: THREE.Vector3 } | null {
    const hits = raycaster.intersectObject(this.group, true);
    for (const hit of hits) {
      const mesh = hit.object as THREE.BatchedMesh;
      if (!mesh.isBatchedMesh || hit.batchId === undefined) continue;
      const contents = [this.far, ...this.tiles.map((t) => t.content), ...this.interiors.values()];
      for (const c of contents) {
        if (!c) continue;
        const i = c.findInstance(mesh, hit.batchId);
        if (i >= 0) return { model: c.modelNames[c.modelOf[i]], distance: hit.distance, point: hit.point };
      }
    }
    return null;
  }
}
