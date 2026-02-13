import type { DeckBoard, DeckbuilderCardEntry, DeckbuilderDeck, AnalyzerCardView } from './types';

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parsePrice(raw: any): number {
  const parsed = Number.parseFloat(String(raw || '0').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function flatten(deck: DeckbuilderDeck, boards: DeckBoard[]): Array<{ board: DeckBoard; entry: DeckbuilderCardEntry }> {
  const out: Array<{ board: DeckBoard; entry: DeckbuilderCardEntry }> = [];
  for (const board of boards) {
    if (!deck.boards[board]) continue;
    for (const entry of deck.boards[board]) {
      out.push({ board, entry });
    }
  }
  return out;
}

export interface DeckPriceSummary {
  eurTotal: number;
  usdTotal: number;
  cardsWithMissingPrice: number;
  lineItems: Array<{
    board: DeckBoard;
    name: string;
    qty: number;
    eur: number;
    usd: number;
  }>;
}

export function computeDeckPriceSummary(
  deck: DeckbuilderDeck,
  cardByName: Record<string, any>,
): DeckPriceSummary {
  const lineItems: DeckPriceSummary['lineItems'] = [];
  let eurTotal = 0;
  let usdTotal = 0;
  let cardsWithMissingPrice = 0;

  for (const { board, entry } of flatten(deck, ['commander', 'mainboard'])) {
    const card = cardByName[normalizeNameKey(entry.name)];
    const eur = parsePrice(card?.prices?.eur);
    const usd = parsePrice(card?.prices?.usd);
    
    if (eur <= 0 && usd <= 0) cardsWithMissingPrice += 1;
    
    eurTotal += eur * entry.qty;
    usdTotal += usd * entry.qty;

    lineItems.push({
      board,
      name: entry.name,
      qty: entry.qty,
      eur,
      usd,
    });
  }

  lineItems.sort((a, b) => (b.eur || b.usd) - (a.eur || a.usd));

  return {
    eurTotal,
    usdTotal,
    cardsWithMissingPrice,
    lineItems,
  };
}
