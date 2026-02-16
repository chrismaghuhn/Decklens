import type { DeckBoard, DeckbuilderCardEntry, DeckbuilderCardView, DeckbuilderDeck } from './types.js';

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parsePrice(raw: string | null | undefined): number {
  const parsed = Number.parseFloat(String(raw || '0').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function flatten(deck: DeckbuilderDeck, boards: DeckBoard[]): Array<{ board: DeckBoard; entry: DeckbuilderCardEntry }> {
  const out: Array<{ board: DeckBoard; entry: DeckbuilderCardEntry }> = [];
  for (const board of boards) {
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
  cardByName: Record<string, DeckbuilderCardView | undefined>,
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

export function getTopExpensiveCards(summary: DeckPriceSummary, max = 10): DeckPriceSummary['lineItems'] {
  return summary.lineItems.slice(0, Math.max(1, max));
}

export function buildCardmarketWantsListText(deck: DeckbuilderDeck): string {
  const lines: string[] = [];
  for (const { entry } of flatten(deck, ['commander', 'mainboard'])) {
    lines.push(`${entry.qty} ${entry.name}`);
  }
  return lines.join('\n');
}

export function buildTcgplayerMassEntryText(deck: DeckbuilderDeck): string {
  const lines: string[] = [];
  for (const { entry } of flatten(deck, ['commander', 'mainboard'])) {
    lines.push(`${entry.qty} ${entry.name}`);
  }
  return lines.join('\n');
}

// ── Affiliate URL Builders ──

const AFFILIATE_TAG = 'utm_source=decklens&utm_medium=referral';

/** Build Cardmarket search URL with affiliate tracking for a single card. */
export function buildCardmarketCardUrl(cardName: string): string {
  return `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(cardName)}&${AFFILIATE_TAG}`;
}

/** Build TCGplayer search URL with affiliate tracking for a single card. */
export function buildTcgplayerCardUrl(cardName: string): string {
  return `https://www.tcgplayer.com/search/magic/product?q=${encodeURIComponent(cardName)}&productLineName=magic&${AFFILIATE_TAG}`;
}

/** Build Cardmarket deck-level search URL with affiliate tracking. */
export function buildCardmarketDeckUrl(deckName: string): string {
  return `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(deckName)}&${AFFILIATE_TAG}`;
}

/** Build TCGplayer deck-level search URL with affiliate tracking. */
export function buildTcgplayerDeckUrl(deckName: string): string {
  return `https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=${encodeURIComponent(deckName)}&${AFFILIATE_TAG}`;
}

function escapeCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildDeckCsvExport(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderCardView | undefined>,
): string {
  const header = 'qty,name,set,collector_no,eur,usd,board,tags';
  const rows: string[] = [header];
  for (const { board, entry } of flatten(deck, ['commander', 'mainboard', 'sideboard', 'maybeboard'])) {
    const card = cardByName[normalizeNameKey(entry.name)];
    const set = entry.set || card?.set || '';
    const collector = entry.collectorNumber || card?.collector_number || '';
    const eur = card?.prices?.eur || '';
    const usd = card?.prices?.usd || '';
    rows.push(
      [
        String(entry.qty),
        escapeCsv(entry.name),
        escapeCsv(set),
        escapeCsv(collector),
        escapeCsv(String(eur || '')),
        escapeCsv(String(usd || '')),
        escapeCsv(board),
        escapeCsv(entry.tags.join('|')),
      ].join(','),
    );
  }
  return rows.join('\n');
}
