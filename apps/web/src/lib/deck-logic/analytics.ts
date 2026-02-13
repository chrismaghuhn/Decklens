import type { DeckbuilderDeck } from './types';
import type { AnalyzerCardView } from './types';
import { getAutoTagForEntry } from './auto-categories';

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function computeAnalyticsData(
  deck: DeckbuilderDeck,
  resolvedByName: Record<string, AnalyzerCardView | undefined>
): {
  curve: Record<string, number>;
  colors: Record<string, number>;
  types: Record<string, number>;
  tags: Record<string, number>;
  landCount: number;
} {
  const curve: Record<string, number> = {};
  const colors: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const types: Record<string, number> = {
    creature: 0, instant: 0, sorcery: 0, enchantment: 0,
    artifact: 0, land: 0, planeswalker: 0, battle: 0,
  };
  const tags: Record<string, number> = {};

  for (const entry of deck.boards.mainboard) {
    const key = normalizeNameKey(entry.name);
    const card = resolvedByName[key];
    const typeLine = (card?.type_line || '').toLowerCase();

    // Mana Curve (exclude lands)
    if (card && !typeLine.includes('land')) {
      const cmc = Number.isFinite(card.cmc) ? Math.trunc(card.cmc!) : 0;
      curve[String(cmc)] = (curve[String(cmc)] || 0) + entry.qty;
    }

    // Colors
    const identity = Array.isArray(card?.color_identity) ? card?.color_identity : [];
    if (identity.length === 0) {
      colors.C += entry.qty;
    } else {
      for (const c of identity) {
        const v = c.toUpperCase();
        if (v in colors) colors[v] += entry.qty;
      }
    }

    // Types
    if (typeLine.includes('creature')) types.creature += entry.qty;
    if (typeLine.includes('instant')) types.instant += entry.qty;
    if (typeLine.includes('sorcery')) types.sorcery += entry.qty;
    if (typeLine.includes('enchantment')) types.enchantment += entry.qty;
    if (typeLine.includes('artifact')) types.artifact += entry.qty;
    if (typeLine.includes('land')) types.land += entry.qty;
    if (typeLine.includes('planeswalker')) types.planeswalker += entry.qty;
    if (typeLine.includes('battle')) types.battle += entry.qty;

    // Tags
    if (entry.tags.length > 0) {
      for (const tag of entry.tags) {
        tags[tag] = (tags[tag] || 0) + entry.qty;
      }
    } else {
      // Auto-categorize
      const autoTag = getAutoTagForEntry(entry, resolvedByName);
      tags[autoTag] = (tags[autoTag] || 0) + entry.qty;
    }
  }

  return { curve, colors, types, tags, landCount: types.land };
}
