// ==================== Playmat Pile Projection ====================
// Pure projection of a deck's mainboard into labeled piles for the
// active sort mode. The commander lives in its own zone and is never
// part of a pile. Unresolved cards fall into a trailing "Unknown"
// pile instead of crashing a mode that needs card data.

import type { DeckbuilderDeck, DeckbuilderCardEntry } from '../deckbuilder/types.js';
import type { DeckbuilderSearchCard } from '../shared/scryfall-client.js';
import { classifyRole, ROLE_LABELS, ROLE_PRIORITY, type Role } from '../deckbuilder/role-classifier.js';

export type SortMode = 'type' | 'mana' | 'color' | 'role' | 'tags' | 'free';

export interface Pile {
  id: string;
  label: string;
  entries: DeckbuilderCardEntry[];
  count: number;
}

const TYPE_ORDER: Array<[string, string]> = [
  ['creature', 'Creatures'],
  ['planeswalker', 'Planeswalkers'],
  ['instant', 'Instants'],
  ['sorcery', 'Sorceries'],
  ['enchantment', 'Enchantments'],
  ['artifact', 'Artifacts'],
  ['battle', 'Battles'],
  ['land', 'Lands'],
];

const COLOR_ORDER: Array<[string, string]> = [
  ['W', 'White'], ['U', 'Blue'], ['B', 'Black'], ['R', 'Red'], ['G', 'Green'],
];

const UNKNOWN = 'Unknown';

function lookup(
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  name: string,
): DeckbuilderSearchCard | undefined {
  return cardByName[name.trim().toLowerCase().replace(/\s+/g, ' ')] ?? cardByName[name];
}

function bucketOf(
  entry: DeckbuilderCardEntry,
  card: DeckbuilderSearchCard | undefined,
  mode: Exclude<SortMode, 'free' | 'tags'>,
): string {
  if (!card) return UNKNOWN;
  const typeLine = (card.type_line || '').toLowerCase();

  if (mode === 'role') {
    return ROLE_LABELS[classifyRole(card)];
  }

  if (mode === 'type') {
    // land first so e.g. "Artifact Land" counts as Land
    if (typeLine.includes('land')) return 'Lands';
    for (const [key, label] of TYPE_ORDER) {
      if (typeLine.includes(key)) return label;
    }
    return 'Other';
  }

  if (mode === 'mana') {
    if (typeLine.includes('land')) return ROLE_LABELS.land;
    const mv = Math.floor(card.cmc ?? 0);
    return mv >= 7 ? '7+' : String(mv);
  }

  // color
  if (typeLine.includes('land')) return ROLE_LABELS.land;
  const ci = card.color_identity || [];
  if (ci.length === 0) return 'Colorless';
  if (ci.length > 1) return 'Multicolor';
  return COLOR_ORDER.find(([c]) => c === ci[0])?.[1] ?? 'Colorless';
}

function orderFor(mode: Exclude<SortMode, 'free'>): string[] {
  switch (mode) {
    case 'type':
      return [...TYPE_ORDER.map(([, l]) => l), 'Other', UNKNOWN];
    case 'mana':
      return ['0', '1', '2', '3', '4', '5', '6', '7+', ROLE_LABELS.land, UNKNOWN];
    case 'color':
      return [...COLOR_ORDER.map(([, l]) => l), 'Multicolor', 'Colorless', ROLE_LABELS.land, UNKNOWN];
    case 'role':
      return [...ROLE_PRIORITY.map((r) => ROLE_LABELS[r]), ROLE_LABELS.utility, ROLE_LABELS.land, UNKNOWN];
    case 'tags':
      return []; // alphabetical, computed by caller
  }
}

/** Reorder piles by a saved id order; ids not in the order keep their
 * projection order after the ordered ones. */
export function applyPileOrder(piles: Pile[], order?: string[]): Pile[] {
  if (!order?.length) return piles;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...piles].sort((a, b) =>
    (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
}

export function projectPiles(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  mode: Exclude<SortMode, 'free'>,
): Pile[] {
  const buckets = new Map<string, DeckbuilderCardEntry[]>();
  const put = (label: string, entry: DeckbuilderCardEntry) => {
    const list = buckets.get(label) || [];
    list.push(entry);
    buckets.set(label, list);
  };

  for (const entry of deck.boards.mainboard) {
    const card = lookup(cardByName, entry.name);
    if (mode === 'tags') {
      const tags = entry.tags?.length ? entry.tags : null;
      if (tags) {
        for (const t of tags) put(t, entry);
      } else {
        put('Untagged', entry);
      }
      continue;
    }
    put(bucketOf(entry, card, mode), entry);
  }

  let labels: string[];
  if (mode === 'tags') {
    labels = [...buckets.keys()].filter((l) => l !== 'Untagged').sort((a, b) => a.localeCompare(b));
    if (buckets.has('Untagged')) labels.push('Untagged');
  } else {
    labels = orderFor(mode).filter((l) => buckets.has(l));
  }

  return labels.map((label) => {
    const entries = buckets.get(label)!;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return {
      id: `pile-${label.toLowerCase().replace(/[^a-z0-9+]+/g, '-')}`,
      label,
      entries,
      count: entries.reduce((s, e) => s + e.qty, 0),
    };
  });
}
