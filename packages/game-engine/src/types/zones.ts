/** All game zones a card can exist in */
export type Zone =
  | 'library'
  | 'hand'
  | 'battlefield'
  | 'graveyard'
  | 'exile'
  | 'commandZone'
  | 'stack';

/** All zones in standard traversal order */
export const ALL_ZONES: Zone[] = [
  'library',
  'hand',
  'battlefield',
  'graveyard',
  'exile',
  'commandZone',
  'stack',
];

/** Zones that are public information */
export const PUBLIC_ZONES: Zone[] = [
  'battlefield',
  'graveyard',
  'exile',
  'commandZone',
  'stack',
];

/** Zones that are normally hidden */
export const HIDDEN_ZONES: Zone[] = ['library', 'hand'];
