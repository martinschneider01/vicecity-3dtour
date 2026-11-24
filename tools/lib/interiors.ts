/**
 * Enterable interiors of Vice City.
 *
 * In the IPLs, the third field of an instance is an area code; the game only
 * shows one area at a time (plus area 13, visible everywhere).
 * Door positions are not in the map files: they come from the game script
 * (main.scm), where each entrance checks whether the player is near a point
 * and then calls SET_AREA_VISIBLE with the area code.
 * The coordinates below were extracted by scanning that script; `spawn` is
 * the point where the script drops the player, when it specifies one.
 * (Reproducible with `npx tsx tools/scan-scm.ts --areas`.)
 *
 * The three stadium arenas are only accessible during missions in the game;
 * their sets float high above the map. We place their markers in front of
 * the stadium entrance.
 */
export interface InteriorDef {
  area: number;
  id: string;
  label: string;
  /** Entrance marker, outside. */
  door: [number, number, number];
  /** Arrival point inside. If absent, computed from the door and the interior's centre. */
  spawn?: [number, number, number];
}

/**
 * Areas used only for cutscenes: partial sets (a street seen through a
 * window, a stage) with no floor or entrance. They are not offered.
 */
export const CUTSCENE_AREAS: Record<number, string> = {
  6: "lawyer's office",
  8: 'concert hall',
  9: 'recording studio',
};

export const INTERIORS: InteriorDef[] = [
  { area: 1, id: 'hotel', label: 'Ocean View Hotel', door: [229.5, -1277.3, 11.2], spawn: [225.0, -1277.3, 11.5] },
  { area: 2, id: 'mansion', label: 'Vercetti Mansion', door: [-378.5, -554.4, 18.3] },
  { area: 3, id: 'bank', label: 'El Banco Corrupto Grande', door: [-896.5, -341.0, 12.6], spawn: [-903.0, -341.0, 12.5] },
  { area: 4, id: 'mall', label: 'North Point Mall', door: [449.8, 996.2, 17.6] },
  { area: 5, id: 'stripclub', label: 'Pole Position Club', door: [97.5, -1470.5, 9.6], spawn: [91.2, -1460.9, 10.0] },
  { area: 7, id: 'coffeeshop', label: 'Café Robina', door: [-1170.0, -606.5, 10.8], spawn: [-1170.0, -611.0, 11.0] },
  { area: 10, id: 'riflerange', label: 'Shooting Range', door: [-667.8, 1211.9, 10.3], spawn: [-667.8, 1221.0, 10.5] },
  { area: 11, id: 'apartment', label: 'Ocean Heights Apartment', door: [26.7, -1331.5, 12.0], spawn: [27.2, -1327.0, 12.0] },
  { area: 12, id: 'police', label: 'Washington Beach Police Station', door: [399.0, -474.5, 10.8], spawn: [393.8, -475.8, 11.4] },
  { area: 14, id: 'dirtring', label: 'Stadium: Dirtring', door: [-1102.4, 1343.2, 19.0] },
  { area: 15, id: 'bloodring', label: 'Stadium: Bloodring', door: [-1102.4, 1331.2, 19.0] },
  { area: 16, id: 'hotring', label: 'Stadium: Hotring', door: [-1102.4, 1319.2, 19.0] },
  { area: 17, id: 'malibu', label: 'Malibu Club', door: [491.0, -77.7, 10.4], spawn: [484.2, -72.5, 9.5] },
  { area: 18, id: 'printworks', label: 'Print Works', door: [-1045.7, -292.5, 9.8] },
];
