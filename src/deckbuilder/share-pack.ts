// ============================================================
// Share Pack — Export/Import .decklens bundles
// ============================================================
// Creates self-contained deck bundles with metadata, card data,
// and optional images. Supports shareable links and file import.
// ============================================================

import type { DeckbuilderDeck, DeckbuilderBoards } from './types.js';

// ==================== Types ====================

export interface SharePackManifest {
  version: 1;
  name: string;
  description: string;
  format: string;
  exportedAt: string;
  exportedBy: string;
  cardCount: number;
  commanderNames: string[];
}

export interface SharePackData {
  manifest: SharePackManifest;
  deck: DeckbuilderDeck;
  cardImages?: Record<string, string>;   // name → base64 data URI
  primer?: string;                        // primer markdown
  tags?: Record<string, string[]>;        // name → tags
  customCategories?: Array<{ id: string; name: string; color: string }>;
}

export interface ShareLinkResult {
  url: string;
  expiresAt: string;
  packId: string;
}

// ==================== Export ====================

/**
 * Create a share pack from a deck.
 */
export function createSharePack(
  deck: DeckbuilderDeck,
  options: {
    includeImages?: boolean;
    includePrimer?: string;
    exporterName?: string;
  } = {}
): SharePackData {
  const allCards = getAllCardNames(deck.boards);
  const commanderNames = deck.boards.commander.map(c => c.name);

  const manifest: SharePackManifest = {
    version: 1,
    name: deck.name,
    description: deck.description || '',
    format: deck.format || 'commander',
    exportedAt: new Date().toISOString(),
    exportedBy: options.exporterName || 'DeckLens User',
    cardCount: allCards.length,
    commanderNames,
  };

  const pack: SharePackData = {
    manifest,
    deck: structuredClone(deck),
  };

  if (options.includePrimer) {
    pack.primer = options.includePrimer;
  }

  if (deck.customCategories) {
    pack.customCategories = deck.customCategories;
  }

  // Collect tags
  const tags: Record<string, string[]> = {};
  for (const board of Object.values(deck.boards)) {
    for (const card of board) {
      if (card.tags.length > 0) {
        tags[card.name] = card.tags;
      }
    }
  }
  if (Object.keys(tags).length > 0) {
    pack.tags = tags;
  }

  return pack;
}

/**
 * Export a share pack as a downloadable .decklens file.
 */
export function exportAsFile(pack: SharePackData): void {
  const json = JSON.stringify(pack, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(pack.manifest.name)}.decklens`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export as compressed .decklens.gz file (smaller for sharing).
 */
export async function exportCompressed(pack: SharePackData): Promise<void> {
  const json = JSON.stringify(pack);
  const blob = new Blob([json], { type: 'application/json' });

  // Try using CompressionStream if available
  if ('CompressionStream' in window) {
    const cs = new CompressionStream('gzip');
    const compressedStream = blob.stream().pipeThrough(cs);
    const compressedBlob = await new Response(compressedStream).blob();

    const url = URL.createObjectURL(compressedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(pack.manifest.name)}.decklens.gz`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } else {
    // Fallback to uncompressed
    exportAsFile(pack);
  }
}

// ==================== Import ====================

/**
 * Import a .decklens file from a File object.
 */
export async function importFromFile(file: File): Promise<SharePackData> {
  let text: string;

  // Handle .gz compressed files
  if (file.name.endsWith('.gz') && 'DecompressionStream' in window) {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = file.stream().pipeThrough(ds);
    text = await new Response(decompressedStream).text();
  } else {
    text = await file.text();
  }

  return parseSharePack(text);
}

/**
 * Parse share pack JSON string.
 */
export function parseSharePack(json: string): SharePackData {
  const data = JSON.parse(json) as SharePackData;

  // Validate manifest
  if (!data.manifest || data.manifest.version !== 1) {
    throw new Error('Invalid share pack: unsupported version or missing manifest');
  }
  if (!data.deck || !data.deck.boards) {
    throw new Error('Invalid share pack: missing deck data');
  }

  return data;
}

/**
 * Apply an imported share pack to create a new deck.
 */
export function applySharePack(pack: SharePackData): DeckbuilderDeck {
  const deck = structuredClone(pack.deck);

  // Generate new ID to avoid conflicts
  deck.id = `deck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  deck.name = `${deck.name} (Imported)`;
  deck.createdAt = new Date().toISOString();
  deck.updatedAt = new Date().toISOString();

  // Re-apply tags if present
  if (pack.tags) {
    for (const board of Object.values(deck.boards)) {
      for (const card of board) {
        if (pack.tags[card.name]) {
          card.tags = pack.tags[card.name];
        }
      }
    }
  }

  // Re-apply custom categories
  if (pack.customCategories) {
    deck.customCategories = pack.customCategories;
  }

  return deck;
}

// ==================== Shareable Link ====================

const API_BASE = typeof window !== 'undefined'
  ? (window.location.hostname === 'localhost' ? 'http://localhost:8787' : '')
  : '';

/**
 * Upload a share pack and get a shareable link.
 */
export async function createShareLink(pack: SharePackData): Promise<ShareLinkResult> {
  const resp = await fetch(`${API_BASE}/api/share-packs`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pack),
  });

  if (!resp.ok) {
    throw new Error(`Failed to create share link: ${resp.statusText}`);
  }

  return resp.json() as Promise<ShareLinkResult>;
}

/**
 * Load a share pack from a shareable link.
 */
export async function loadFromShareLink(packId: string): Promise<SharePackData> {
  const resp = await fetch(`${API_BASE}/api/share-packs/${packId}`, {
    credentials: 'include',
  });

  if (!resp.ok) {
    throw new Error(`Share pack not found or expired`);
  }

  return resp.json() as Promise<SharePackData>;
}

// ==================== Clipboard Export ====================

/**
 * Copy deck as Arena format to clipboard.
 */
export function copyAsArenaFormat(boards: DeckbuilderBoards): string {
  const lines: string[] = [];

  if (boards.commander.length > 0) {
    for (const c of boards.commander) {
      lines.push(`${c.qty} ${c.name}`);
    }
    lines.push('');
  }

  lines.push('Deck');
  for (const c of boards.mainboard) {
    lines.push(`${c.qty} ${c.name}`);
  }

  if (boards.sideboard.length > 0) {
    lines.push('');
    lines.push('Sideboard');
    for (const c of boards.sideboard) {
      lines.push(`${c.qty} ${c.name}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate a text summary for sharing.
 */
export function generateSummary(pack: SharePackData): string {
  const { manifest } = pack;
  const lines = [
    `${manifest.name}`,
    `Format: ${manifest.format}`,
    `Cards: ${manifest.cardCount}`,
  ];
  if (manifest.commanderNames.length > 0) {
    lines.push(`Commander: ${manifest.commanderNames.join(' / ')}`);
  }
  if (manifest.description) {
    lines.push(`\n${manifest.description}`);
  }
  lines.push(`\nExported from DeckLens on ${new Date(manifest.exportedAt).toLocaleDateString()}`);
  return lines.join('\n');
}

// ==================== Helpers ====================

function getAllCardNames(boards: DeckbuilderBoards): string[] {
  const names: string[] = [];
  for (const board of Object.values(boards)) {
    for (const card of board) {
      names.push(card.name);
    }
  }
  return names;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}
