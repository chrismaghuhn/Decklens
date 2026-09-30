// ==================== MTG Role Classifier ====================
// Classifies a card into ONE functional role for the playmat's
// "Funktion" sort mode — the Magic analogue of Yu-Gi-Oh hand traps /
// starters. Heuristics over type_line + oracle_text; a card takes its
// first matching role by priority (spec: wincon > wipe > counter >
// removal > tutor > ramp > draw > recursion > protection > utility).
// Lands are always 'land'.

export type Role =
  | 'ramp' | 'draw' | 'removal' | 'wipe' | 'counter' | 'tutor'
  | 'recursion' | 'protection' | 'wincon' | 'utility' | 'land';

export const ROLE_LABELS: Record<Role, string> = {
  wincon: 'Wincons',
  wipe: 'Board Wipes',
  counter: 'Counter',
  removal: 'Removal',
  tutor: 'Tutoren',
  ramp: 'Rampe',
  draw: 'Kartenzug',
  recursion: 'Recursion',
  protection: 'Schutz',
  utility: 'Utility',
  land: 'Länder',
};

/** English keys the draw-probability presets expect (renderDrawProbability). */
export const ROLE_PROB_KEYS: Record<Role, string> = {
  wincon: 'Wincon',
  wipe: 'Board Wipe',
  counter: 'Counter',
  removal: 'Removal',
  tutor: 'Tutor',
  ramp: 'Ramp',
  draw: 'Draw',
  recursion: 'Recursion',
  protection: 'Protection',
  utility: 'Utility',
  land: 'Land',
};

/** Priority order for classification (first match wins). */
export const ROLE_PRIORITY: Exclude<Role, 'utility' | 'land'>[] = [
  'wincon', 'wipe', 'counter', 'removal', 'tutor', 'ramp', 'draw', 'recursion', 'protection',
];

const MATCHERS: Record<Exclude<Role, 'utility' | 'land'>, RegExp[]> = {
  wincon: [
    /you win the game/,
    /each opponent loses the game/,
    /loses? the game/,
    /deals? \w+ damage to each opponent/,
  ],
  wipe: [
    /destroy all/,
    /destroys? each/,
    /exile all/,
    /each (?:player|opponent) sacrifices/,
    /deals? \d+ damage to each creature/,
  ],
  counter: [
    /counter target/,
    /counter that spell/,
    /counter it/,
  ],
  removal: [
    /destroy target/,
    /exile target/,
    /destroys? up to \w+ target/,
    /exile up to \w+ target/,
    /target creature gets -\d+\/-\d+/,
    /deals? \d+ damage to (?:any target|target creature|target planeswalker)/,
    /target player sacrifices/,
  ],
  tutor: [
    // non-land searches; land searches are ramp and are checked there first
    /search your library for a(?!.{0,40}land)/,
    /search your library for up to \w+(?!.{0,40}land)/,
  ],
  ramp: [
    /add \{/,
    /add \w+ mana/,
    /search your library for .{0,40}land/,
    /put .{0,30}land .{0,30}onto the battlefield/,
    /lands? you control .{0,30}add/,
    /untap target land/,
  ],
  draw: [
    /draws? (?:a|one|two|three|four|x) cards?/,
    /draws? cards? equal/,
    /draw that many cards/,
  ],
  recursion: [
    /return .{0,60}from (?:your|a) graveyard/,
    /put .{0,50}from (?:your|a) graveyard/,
    /from your graveyard to (?:your hand|the battlefield)/,
  ],
  protection: [
    /gains? (?:hexproof|indestructible|shroud|protection)/,
    /have (?:hexproof|indestructible|shroud)/,
    /gain (?:hexproof|indestructible)/,
    /can't be (?:countered|targeted|destroyed)/,
    /prevent all (?:combat )?damage/,
    /phases? out/,
  ],
};

export function classifyRole(card: { type_line?: string; oracle_text?: string }): Role {
  const typeLine = (card.type_line || '').toLowerCase();
  if (typeLine.includes('land')) return 'land';

  const text = (card.oracle_text || '').toLowerCase();
  if (!text) return 'utility';

  // Tutor exception: land-searching belongs to ramp, so test ramp's
  // land-search patterns before tutor can claim a generic search.
  for (const role of ROLE_PRIORITY) {
    if (role === 'tutor' && MATCHERS.ramp.some((rx) => rx.test(text) && /land/.test(text))) {
      continue; // let ramp claim it below
    }
    if (MATCHERS[role].some((rx) => rx.test(text))) return role;
  }
  return 'utility';
}
