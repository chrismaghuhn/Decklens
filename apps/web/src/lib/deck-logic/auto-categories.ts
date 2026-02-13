import type { DeckbuilderCardEntry, AnalyzerCardView } from './types';

export type CardCategory =
  | 'Ramp'
  | 'Mana Rock'
  | 'Draw'
  | 'Removal'
  | 'Board Wipe'
  | 'Counter'
  | 'Tutor'
  | 'Protection'
  | 'Recursion'
  | 'Finisher'
  | 'Combo Piece'
  | 'Utility'
  | 'Token Generator'
  | 'Lifegain'
  | 'Land'
  | 'Tribal Payoff'
  | 'Stax';

export const CATEGORY_COLORS: Record<CardCategory, string> = {
  'Land': '#6b7280',
  'Mana Rock': '#a3e635',
  'Ramp': '#22c55e',
  'Draw': '#3b82f6',
  'Removal': '#ef4444',
  'Board Wipe': '#dc2626',
  'Counter': '#8b5cf6',
  'Tutor': '#a855f7',
  'Protection': '#f9faf4',
  'Stax': '#f97316',
  'Recursion': '#6366f1',
  'Token Generator': '#f59e0b',
  'Tribal Payoff': '#14b8a6',
  'Lifegain': '#34d399',
  'Finisher': '#e2b340',
  'Combo Piece': '#ec4899',
  'Utility': '#94a3b8',
};

function text(card: AnalyzerCardView): string {
  return (card.oracle_text || '').toLowerCase();
}

function typeLine(card: AnalyzerCardView): string {
  return (card.type_line || '').toLowerCase();
}

function hasKeyword(card: AnalyzerCardView, keyword: string): boolean {
  if (!card.keywords) return false;
  return card.keywords.some((k) => k.toLowerCase() === keyword.toLowerCase());
}

interface CategoryRule {
  category: CardCategory;
  priority: number;
  match: (card: AnalyzerCardView) => boolean;
}

const RULES: CategoryRule[] = [
  {
    category: 'Land',
    priority: 100,
    match: (card) => typeLine(card).includes('land'),
  },
  {
    category: 'Board Wipe',
    priority: 90,
    match: (card) => {
      const t = text(card);
      return (
        t.includes('destroy all') ||
        t.includes('exile all') ||
        /each creature gets -\d+\/-\d+/.test(t) ||
        /all creatures get -\d+\/-\d+/.test(t) ||
        (t.includes('destroy each') && !t.includes('destroy each opponent')) ||
        t.includes('exile each') ||
        (hasKeyword(card, 'overload') && (/destroy target|exile target/.test(t)))
      );
    },
  },
  {
    category: 'Counter',
    priority: 85,
    match: (card) => {
      const t = text(card);
      return (
        t.includes('counter target spell') ||
        t.includes('counter target activated') ||
        t.includes('counter target triggered') ||
        t.includes('counter that spell') ||
        (typeLine(card).includes('instant') && t.includes('counter target'))
      );
    },
  },
  {
    category: 'Removal',
    priority: 80,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('destroy target') ||
        t.includes('exile target') ||
        t.includes('return target') && t.includes('to its owner') ||
        /deals \d+ damage to (target|any|each)/.test(t) ||
        /-\d+\/-\d+ until end of turn/.test(t) ||
        t.includes('fight') ||
        t.includes('destroy another') ||
        t.includes('exile another')
      );
    },
  },
  {
    category: 'Tutor',
    priority: 75,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      if (!t.includes('search your library')) return false;
      if (/search your library for a (basic )?land/.test(t)) return false;
      if (/search your library for up to \w+ basic land/.test(t)) return false;
      return true;
    },
  },
  {
    category: 'Ramp',
    priority: 70,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land') && !tl.includes('creature')) return false;
      return (
        (tl.includes('creature') && /add \{[wubrgc]\}/i.test(t)) ||
        (tl.includes('artifact') && /add \{[wubrgc]\}/i.test(t) && !tl.includes('creature')) ||
        /search your library for a (basic )?land/.test(t) ||
        /search your library for up to \w+ basic land/.test(t) ||
        /put .* land .* onto the battlefield/.test(t) ||
        t.includes('you may play an additional land') ||
        t.includes('create a treasure token') ||
        /add \{[wubrgc]\}\{[wubrgc]\}/i.test(t) ||
        t.includes('add {c}{c}')
      );
    },
  },
  {
    category: 'Draw',
    priority: 65,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('draw a card') ||
        t.includes('draw cards') ||
        /draw \w+ cards?/.test(t) ||
        t.includes('draw x cards') ||
        hasKeyword(card, 'cycling') ||
        t.includes('exile the top') && t.includes('you may play') ||
        t.includes('exile the top') && t.includes('you may cast') ||
        (t.includes('enters') && t.includes('draw'))
      );
    },
  },
  {
    category: 'Recursion',
    priority: 60,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        /return .* from .* graveyard/.test(t) ||
        /put .* from .* graveyard/.test(t) ||
        t.includes('from your graveyard to your hand') ||
        t.includes('from your graveyard to the battlefield') ||
        t.includes('from a graveyard to the battlefield') ||
        hasKeyword(card, 'flashback') ||
        hasKeyword(card, 'unearth') ||
        hasKeyword(card, 'embalm') ||
        hasKeyword(card, 'eternalize')
      );
    },
  },
  {
    category: 'Protection',
    priority: 55,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('hexproof') ||
        t.includes('indestructible') ||
        /protection from \w+/.test(t) ||
        t.includes('shroud') ||
        t.includes('can\'t be the target') ||
        t.includes('can\'t be countered') ||
        t.includes('phase out')
      );
    },
  },
  {
    category: 'Token Generator',
    priority: 50,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      const noTreasure = t.replace(/create .* treasure token/g, '');
      return (
        /create .* token/.test(noTreasure) ||
        /put .* token/.test(noTreasure)
      );
    },
  },
  {
    category: 'Lifegain',
    priority: 40,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      const gainCount = (t.match(/gain .* life/g) || []).length;
      return (
        gainCount >= 1 && (
          hasKeyword(card, 'lifelink') ||
          t.includes('whenever you gain life') ||
          t.includes('you gain life equal to') ||
          gainCount >= 2
        )
      );
    },
  },
  {
    category: 'Finisher',
    priority: 35,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      const power = Number(card.power);
      return (
        t.includes('you win the game') ||
        t.includes('target player loses the game') ||
        (tl.includes('creature') && !isNaN(power) && power >= 6) ||
        (hasKeyword(card, 'infect') && tl.includes('creature'))
      );
    },
  },
  {
    category: 'Mana Rock',
    priority: 71,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      return (
        tl.includes('artifact') &&
        !tl.includes('creature') &&
        !tl.includes('land') &&
        /add \{[wubrgc]\}/i.test(t)
      );
    },
  },
  {
    category: 'Tribal Payoff',
    priority: 45,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('choose a creature type') ||
        /each .* you control get/.test(t) ||
        /other .* you control get/.test(t) ||
        /whenever another .* enters the battlefield/.test(t) && /creature type/.test(t) ||
        t.includes('creatures of the chosen type') ||
        t.includes('shares a creature type')
      );
    },
  },
  {
    category: 'Stax',
    priority: 42,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        /opponents can't/.test(t) ||
        /players can't/.test(t) ||
        /spells cost \{?\d?\}? ?more to cast/.test(t) ||
        t.includes('nonland permanents don\'t untap') ||
        t.includes('opponents can\'t cast') ||
        t.includes('each opponent\'s upkeep') && t.includes('sacrifice') ||
        t.includes('at the beginning of each opponent\'s upkeep') ||
        (t.includes('each player') && t.includes('sacrifice'))
      );
    },
  },
  {
    category: 'Combo Piece',
    priority: 30,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      const triggerWords = (t.match(/whenever|at the beginning|at end of|if .* would/g) || []).length;
      const hasUntap = t.includes('untap') && !t.includes('untap step');
      const hasInfiniteIndicator = t.includes('doesn\'t untap') || t.includes('skip your');
      return (
        (triggerWords >= 3) ||
        (hasUntap && triggerWords >= 1) ||
        hasInfiniteIndicator ||
        t.includes('take an extra turn')
      );
    },
  },
];

const SORTED_RULES = [...RULES].sort((a, b) => b.priority - a.priority);

export function categorizeCard(card: AnalyzerCardView): CardCategory[] {
  const categories: CardCategory[] = [];

  for (const rule of SORTED_RULES) {
    try {
      if (rule.match(card)) {
        categories.push(rule.category);
      }
    } catch {
      // ignore
    }
  }

  if (categories.length === 0) {
    categories.push('Utility');
  }

  return categories;
}

export function getAutoTagForEntry(
  entry: DeckbuilderCardEntry,
  resolvedByName: Record<string, AnalyzerCardView | undefined>,
): string {
  if (entry.tags.length > 0) return entry.tags[0];

  const key = entry.name.trim().toLowerCase().replace(/\s+/g, ' ');
  const card = resolvedByName[key];
  if (!card) return 'Utility';

  const categories = categorizeCard(card);
  return categories[0];
}
