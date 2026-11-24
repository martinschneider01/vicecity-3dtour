/**
 * Links LODs (models seen from afar) to the detailed models they replace.
 * The two are never shown at the same time: the LOD fades out below the
 * draw distance of its detailed model.
 */
import type { ObjectDef } from './gamedata.ts';

export type Vec3 = [number, number, number];

/** Beyond this draw distance, the game treats a model as a "big building" (LOD). */
export const LOD_DISTANCE = 300;
/** Fade-out distance of a LOD linked only by proximity (see rule 3). */
const NEIGHBOUR_NEAR = 150;

/** An instance to link, or to link to. */
export interface LodItem {
  def: ObjectDef;
  pos: Vec3;
  /** Set by link(): distance below which the LOD fades out; 0 = never. */
  near: number;
  /** Set by link(): tile of the detailed model, HD_SAME_PACK, or -1. */
  hdTile: number;
}

export interface HdPlacement {
  def: ObjectDef;
  pos: Vec3;
  /** Tile of the instance, or HD_SAME_PACK. */
  tile: number;
}

export interface HdIndex {
  byDef: Map<ObjectDef, HdPlacement[]>;
  all: HdPlacement[];
}

export const farOf = (d: ObjectDef): number => Math.max(...d.drawDists);
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * A model is a LOD (it stands in for a detailed model) if its draw distance
 * exceeds 300, per the game's rule, or if its name starts with "LOD": a few
 * LODs have a shorter distance (the shopping mall signs).
 */
export const isLodLike = (d: ObjectDef): boolean => farOf(d) > LOD_DISTANCE || /^lod/i.test(d.name);

export class LodLinker {
  readonly stats = { byName: 0, byPlace: 0, byNeighbour: 0, none: 0, far: 0 };
  /** Names of "LOD..." models left without a detailed model. */
  readonly unlinked = new Set<string>();
  /**
   * Inherited hours: a LOD with no hours whose detailed model is a day/night
   * object (LODoceanrdN1_dy) must only be shown at the same hours, otherwise
   * the day and night LODs overlap in the distance.
   */
  readonly inheritedTime = new Map<ObjectDef, [number, number]>();
  private readonly bySuffix = new Map<string, ObjectDef[]>();
  private readonly ideRange: Map<string, [number, number]>;

  /** ideRange: ID range of each IDE file (key: ObjectDef.source). */
  constructor(defs: Iterable<ObjectDef>, ideRange: Map<string, [number, number]>) {
    this.ideRange = ideRange;
    for (const d of defs) {
      const k = d.name.slice(3);
      let l = this.bySuffix.get(k);
      if (!l) this.bySuffix.set(k, (l = []));
      l.push(d);
    }
  }

  /** Index of detailed instances (LODs in the list are skipped). */
  static index(list: HdPlacement[]): HdIndex {
    const byDef = new Map<ObjectDef, HdPlacement[]>();
    const all: HdPlacement[] = [];
    for (const it of list) {
      if (isLodLike(it.def)) continue;
      let l = byDef.get(it.def);
      if (!l) byDef.set(it.def, (l = []));
      l.push(it);
      all.push(it);
    }
    return { byDef, all };
  }

  /**
   * Links each LOD in `pack` to the detailed instance it replaces.
   *
   * 1. Game rule (CSimpleModelInfo::SetupBigBuilding): the detailed model is
   *    another model from the same IDE file whose name is identical from the
   *    4th character on (LODbigshops1 / od_bigshops1). The game takes the
   *    first match and works per model; here we work per instance and, when
   *    several models share the same suffix, keep the one with an instance
   *    closest to the LOD.
   * 2. Failing that, for a model named "LOD...": a detailed instance placed
   *    at the same spot whose name extends the LOD's (LODlleyground5 /
   *    odalleyground5_dy).
   * 3. Failing that too, for a model named "LOD..." surrounded by detailed
   *    objects (LODrtrees tree clusters): it fades out up close, when the
   *    tile of its nearest detailed neighbour is shown.
   * Without rules 2 and 3, these LODs would stay drawn on top of the
   * detailed models.
   */
  link(pack: LodItem[], hd: HdIndex): void {
    for (const p of pack) {
      if (!isLodLike(p.def)) continue;
      const [lo, hi] = this.ideRange.get(p.def.source) ?? [-Infinity, Infinity];
      const suffix = p.def.name.slice(3);
      const named = /^lod/i.test(p.def.name);
      let best: HdPlacement | null = null;
      let bestD = Infinity;
      for (const cand of this.bySuffix.get(suffix) ?? []) {
        if (cand === p.def || cand.id < lo || cand.id > hi) continue;
        for (const h of hd.byDef.get(cand) ?? []) {
          const d = dist3(h.pos, p.pos);
          if (d < bestD) {
            bestD = d;
            best = h;
          }
        }
      }
      let near = best ? farOf(best.def) : 0;
      const byName = best !== null;
      if (best) this.stats.byName++;
      else if (named && suffix.length >= 4) {
        const want = suffix.toLowerCase();
        for (const h of hd.all) {
          const d = dist3(h.pos, p.pos);
          if (d < 5 && d < bestD && h.def.name.slice(3).toLowerCase().startsWith(want)) {
            bestD = d;
            best = h;
          }
        }
        if (best) {
          this.stats.byPlace++;
          near = farOf(best.def);
        } else {
          for (const h of hd.all) {
            const d = dist3(h.pos, p.pos);
            if (d < 30 && d < bestD) {
              bestD = d;
              best = h;
            }
          }
          if (best) {
            this.stats.byNeighbour++;
            near = NEIGHBOUR_NEAR;
          }
        }
      }
      if (!best) {
        this.stats.none++;
        if (named) this.unlinked.add(p.def.name);
        continue;
      }
      if (bestD > 50) this.stats.far++;
      p.near = near;
      p.hdTile = best.tile;
      if (byName && p.def.timeOn === null && best.def.timeOn !== null && best.def.timeOff !== null) {
        this.inheritedTime.set(p.def, [best.def.timeOn, best.def.timeOff]);
      }
    }
  }
}
