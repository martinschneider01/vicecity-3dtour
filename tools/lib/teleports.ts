import type { Teleport } from '../../shared/format.ts';

/**
 * Teleport locations offered by the viewer. Positions in the game's frame
 * (X east, Y north, Z up); heading 0 = north, 90 = east. `pos` is the free
 * camera's viewpoint, `foot` the spot where the character lands on foot.
 */
export const TELEPORTS: Teleport[] = [
  { id: 'ocean-drive', label: 'Ocean Drive', pos: [262, -1265, 14], yaw: 20, pitch: -4, foot: [262, -1265, 12] },
  { id: 'mansion', label: 'Vercetti Mansion (Starfish Island)', pos: [-300, -470, 42], yaw: 213, pitch: -14, foot: [-378, -520, 16] },
  { id: 'downtown', label: 'Downtown', pos: [-170, 1020, 95], yaw: -72, pitch: -7, foot: [-672, 1204, 12] },
  { id: 'airport', label: 'Escobar International Airport', pos: [-1290, -1140, 60], yaw: -38, pitch: -14, foot: [-1440, -790, 16] },
  { id: 'malibu', label: 'Malibu Club', pos: [455, -95, 16], yaw: 60, pitch: -4, foot: [476, -84, 12] },
];
