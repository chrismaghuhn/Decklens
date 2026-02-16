import type { Deck } from '../../shared/types.js';

/**
 * Split an array into fixed-size chunks.
 */
export function chunkBySize<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Process items with bounded concurrency.
 */
export async function processWithConcurrency<T>(
  items: T[],
  handler: (item: T, index: number) => Promise<void>,
  concurrency = 1,
): Promise<void> {
  if (items.length === 0) return;

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await handler(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

/**
 * Collect unique card names from all deck zones.
 * Names are normalized to lowercase.
 */
export function collectUniqueDeckCardNames(deck: Deck): string[] {
  const seen = new Set<string>();
  for (const entry of [...deck.main, ...deck.sideboard, ...deck.commander]) {
    const normalized = entry.name.trim().toLowerCase();
    if (normalized) {
      seen.add(normalized);
    }
  }
  return [...seen];
}
