export type PriceCurrency = 'EUR' | 'USD';

export interface PriceAdapterCardLike {
  name: string;
  prices?: Record<string, string | null | undefined>;
}

export type PriceQuoteStatus = 'ok' | 'missing_card' | 'missing_price';

export interface PriceQuote {
  cardName: string;
  amount: number | null;
  currency: PriceCurrency | null;
  source: string;
  asOf: number | null;
  stale: boolean;
  status: PriceQuoteStatus;
}

export interface PriceAdapter {
  getPrice(cardName: string): PriceQuote;
}

export interface PriceAdapterOptions {
  resolveCard: (cardName: string) => PriceAdapterCardLike | null;
  asOf?: number | null;
  source?: string;
  preferredCurrency?: PriceCurrency;
  fallbackCurrency?: PriceCurrency;
  staleAfterMs?: number;
  now?: () => number;
}

const DEFAULT_STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 2;

function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function formatPriceAmount(amount: number | null, currency: PriceCurrency | null): string {
  if (amount === null || currency === null) return 'N/A';
  const symbol = currency === 'EUR' ? 'EUR' : 'USD';
  return `${symbol} ${amount.toFixed(2)}`;
}

export function formatPriceAsOfTimestamp(asOf: number | null): string {
  if (!asOf) return 'unknown';
  return new Date(asOf).toISOString();
}

export function createPriceAdapter(options: PriceAdapterOptions): PriceAdapter {
  const source = options.source || 'scryfall.prices';
  const asOf = options.asOf ?? null;
  const preferredCurrency = options.preferredCurrency || 'EUR';
  const fallbackCurrency = options.fallbackCurrency || 'USD';
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now || (() => Date.now());

  const stale = asOf !== null && (now() - asOf) > staleAfterMs;

  return {
    getPrice(cardName: string): PriceQuote {
      const card = options.resolveCard(cardName);
      if (!card) {
        return {
          cardName,
          amount: null,
          currency: null,
          source,
          asOf,
          stale,
          status: 'missing_card',
        };
      }

      const preferred = parsePrice(card.prices?.[preferredCurrency.toLowerCase()]);
      if (preferred !== null) {
        return {
          cardName: card.name,
          amount: preferred,
          currency: preferredCurrency,
          source,
          asOf,
          stale,
          status: 'ok',
        };
      }

      const fallback = parsePrice(card.prices?.[fallbackCurrency.toLowerCase()]);
      if (fallback !== null) {
        return {
          cardName: card.name,
          amount: fallback,
          currency: fallbackCurrency,
          source,
          asOf,
          stale,
          status: 'ok',
        };
      }

      return {
        cardName: card.name,
        amount: null,
        currency: null,
        source,
        asOf,
        stale,
        status: 'missing_price',
      };
    },
  };
}
