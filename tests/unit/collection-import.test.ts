import { describe, expect, it } from 'vitest';
import {
  createFallbackCollectionCardId,
  mapCollectionRowsToCanonical,
  normalizeCollectionCardName,
  parseCollectionCsv,
  type CollectionCanonicalCard,
} from '../../src/shared/collection-import.js';

const CANONICAL_CARDS: CollectionCanonicalCard[] = [
  { id: 'oracle:bolt', name: 'Lightning Bolt' },
  { id: 'oracle:counterspell', name: 'Counterspell' },
  { id: 'oracle:rhystic', name: 'Rhystic Study' },
  { id: 'oracle:helix', name: 'Lightning Helix' },
];

describe('collection CSV parsing', () => {
  it('supports flexible header mapping', () => {
    const csv = [
      'Card Name,Count,Notes',
      'Lightning Bolt,4,Main',
      'Counterspell,2,Main',
    ].join('\n');

    const parsed = parseCollectionCsv(csv);
    expect(parsed.headerMap.hasHeader).toBe(true);
    expect(parsed.headerMap.nameKey).toBe('Card Name');
    expect(parsed.headerMap.qtyKey).toBe('Count');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.name).toBe('Lightning Bolt');
    expect(parsed.rows[0]?.qty).toBe(4);
  });

  it('handles semicolon CSV and no-header quantity rows', () => {
    const csv = [
      'qty;name',
      '3;Lightning Bolt',
      '1;Counterspell',
    ].join('\n');

    const parsed = parseCollectionCsv(csv);
    expect(parsed.detectedDelimiter).toBe(';');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1]?.qty).toBe(1);

    const noHeader = parseCollectionCsv('2,Lightning Helix\n1,Counterspell');
    expect(noHeader.headerMap.hasHeader).toBe(false);
    expect(noHeader.rows[0]?.qty).toBe(2);
    expect(noHeader.rows[0]?.name).toBe('Lightning Helix');
  });

  it('accepts ID-only rows when card IDs are provided', () => {
    const csv = [
      'oracle_id,qty',
      'oracle:bolt,2',
      'oracle:counterspell,1',
    ].join('\n');

    const parsed = parseCollectionCsv(csv);
    const mapped = mapCollectionRowsToCanonical(parsed.rows, CANONICAL_CARDS, parsed.unresolved);
    expect(mapped.unresolved).toHaveLength(0);
    expect(mapped.mapped.find((item) => item.id === 'oracle:bolt')?.qty).toBe(2);
  });

  it('parses decklist-style lines as fallback', () => {
    const parsed = parseCollectionCsv('4 Lightning Bolt\n2x Counterspell\nRhystic Study');
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]?.qty).toBe(4);
    expect(parsed.rows[1]?.qty).toBe(2);
    expect(parsed.rows[2]?.qty).toBe(1);
  });
});

describe('collection normalization + mapping', () => {
  it('normalizes names before canonical mapping', () => {
    const parsed = parseCollectionCsv('name,qty\n"Lightning Bolt (M11) 146",2');
    const mapped = mapCollectionRowsToCanonical(parsed.rows, CANONICAL_CARDS, parsed.unresolved);

    expect(normalizeCollectionCardName('Lightning Bolt (M11) 146')).toBe('Lightning Bolt');
    expect(mapped.mapped).toHaveLength(1);
    expect(mapped.mapped[0]?.id).toBe('oracle:bolt');
    expect(mapped.mapped[0]?.qty).toBe(2);
  });

  it('deduplicates repeated entries and aggregates quantities', () => {
    const parsed = parseCollectionCsv([
      'name,qty',
      'Lightning Bolt,1',
      'lightning bolt,2',
      'Counterspell,3',
    ].join('\n'));
    const mapped = mapCollectionRowsToCanonical(parsed.rows, CANONICAL_CARDS, parsed.unresolved);

    const bolt = mapped.mapped.find((item) => item.id === 'oracle:bolt');
    const counterspell = mapped.mapped.find((item) => item.id === 'oracle:counterspell');
    expect(bolt?.qty).toBe(3);
    expect(counterspell?.qty).toBe(3);
    expect(mapped.stats.mappedRows).toBe(3);
  });

  it('marks invalid and unresolved rows with actionable reasons', () => {
    const parsed = parseCollectionCsv([
      'name,qty',
      ',4',
      'Unknown Card,2',
      'Lightning Bolt,abc',
    ].join('\n'));
    const mapped = mapCollectionRowsToCanonical(parsed.rows, CANONICAL_CARDS, parsed.unresolved);

    const reasons = mapped.unresolved.map((row) => row.reason);
    expect(reasons).toContain('missing_name');
    expect(reasons).toContain('invalid_quantity');
    expect(reasons).toContain('unknown_card');
    expect(mapped.stats.autoMapRate).toBeLessThan(1);
  });

  it('provides deterministic fallback IDs for manual resolves', () => {
    expect(createFallbackCollectionCardId('  Rhystic Study  ')).toBe('name:rhystic study');
  });

  it('reports automap rate for acceptance tracking', () => {
    const csv = [
      'name,qty',
      'Lightning Bolt,1',
      'Counterspell,1',
      'Rhystic Study,1',
      'Lightning Helix,1',
      'Lightning Bolt,1',
      'Counterspell,1',
      'Rhystic Study,1',
      'Lightning Helix,1',
      'Lightning Bolt,1',
      'Unknown Card,1',
    ].join('\n');

    const parsed = parseCollectionCsv(csv);
    const mapped = mapCollectionRowsToCanonical(parsed.rows, CANONICAL_CARDS, parsed.unresolved);
    expect(mapped.stats.totalRows).toBe(10);
    expect(mapped.stats.mappedRows).toBe(9);
    expect(mapped.stats.autoMapRate).toBe(0.9);
  });
});
