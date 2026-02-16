import { describe, expect, it } from 'vitest';
import {
  createPriceAdapter,
  formatPriceAmount,
  formatPriceAsOfTimestamp,
} from '../../src/shared/price-adapter.js';

describe('price adapter', () => {
  it('returns preferred EUR quote when available', () => {
    const adapter = createPriceAdapter({
      resolveCard: (name) => ({ name, prices: { eur: '2.50', usd: '2.90' } }),
      asOf: 1700000000000,
      now: () => 1700000001000,
    });

    const quote = adapter.getPrice('Lightning Bolt');
    expect(quote.status).toBe('ok');
    expect(quote.currency).toBe('EUR');
    expect(quote.amount).toBe(2.5);
    expect(quote.stale).toBe(false);
  });

  it('falls back to USD when EUR is missing', () => {
    const adapter = createPriceAdapter({
      resolveCard: (name) => ({ name, prices: { eur: null, usd: '1.25' } }),
    });

    const quote = adapter.getPrice('Arcane Signet');
    expect(quote.status).toBe('ok');
    expect(quote.currency).toBe('USD');
    expect(quote.amount).toBe(1.25);
  });

  it('marks missing cards and missing prices with explicit fallback status', () => {
    const missingCardAdapter = createPriceAdapter({
      resolveCard: () => null,
    });
    expect(missingCardAdapter.getPrice('Unknown').status).toBe('missing_card');

    const missingPriceAdapter = createPriceAdapter({
      resolveCard: (name) => ({ name, prices: { eur: null, usd: null } }),
    });
    expect(missingPriceAdapter.getPrice('NoPriceCard').status).toBe('missing_price');
  });

  it('marks stale quotes based on configured threshold', () => {
    const adapter = createPriceAdapter({
      resolveCard: (name) => ({ name, prices: { eur: '1.00' } }),
      asOf: 1000,
      staleAfterMs: 500,
      now: () => 1700,
    });

    const quote = adapter.getPrice('Counterspell');
    expect(quote.stale).toBe(true);
  });

  it('formats price amount and timestamp', () => {
    expect(formatPriceAmount(2.345, 'EUR')).toBe('EUR 2.35');
    expect(formatPriceAmount(null, null)).toBe('N/A');
    expect(formatPriceAsOfTimestamp(null)).toBe('unknown');
    expect(formatPriceAsOfTimestamp(0)).toBe('unknown');
    expect(formatPriceAsOfTimestamp(1700000000000)).toContain('2023-11');
  });
});
