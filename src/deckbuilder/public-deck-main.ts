import {
  fetchDeckbuilderSharedSnapshot,
  resolveDeckbuilderCards,
  type DeckbuilderShareDeckPayload,
  type DeckbuilderSharedSnapshot,
} from '../shared/api.js';
import { createDeck, upsertDeck } from './storage.js';
import type { DeckbuilderDeck } from './types.js';
import { buildCardmarketWantsListText, buildTcgplayerMassEntryText, computeDeckPriceSummary } from './pricing.js';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseSlugFromPath(): string | null {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'd') {
    return parts[1] || null;
  }
  const query = new URLSearchParams(window.location.search).get('slug');
  return query && query.trim() ? query.trim() : null;
}

function toLocalDeck(snapshot: DeckbuilderSharedSnapshot): DeckbuilderDeck {
  const now = new Date().toISOString();
  return {
    id: '',
    name: snapshot.deck.name,
    visibility: 'private',
    createdAt: now,
    updatedAt: now,
    boards: {
      commander: snapshot.deck.boards.commander.map((entry) => ({
        name: entry.name,
        qty: entry.qty,
        set: entry.set || null,
        collectorNumber: entry.collectorNumber || null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
      })),
      mainboard: snapshot.deck.boards.mainboard.map((entry) => ({
        name: entry.name,
        qty: entry.qty,
        set: entry.set || null,
        collectorNumber: entry.collectorNumber || null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
      })),
      sideboard: snapshot.deck.boards.sideboard.map((entry) => ({
        name: entry.name,
        qty: entry.qty,
        set: entry.set || null,
        collectorNumber: entry.collectorNumber || null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
      })),
      maybeboard: snapshot.deck.boards.maybeboard.map((entry) => ({
        name: entry.name,
        qty: entry.qty,
        set: entry.set || null,
        collectorNumber: entry.collectorNumber || null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
      })),
    },
  };
}

function deckToText(deck: DeckbuilderShareDeckPayload): string {
  const lines: string[] = [];
  for (const entry of deck.boards.commander) lines.push(`${entry.qty} ${entry.name}`);
  lines.push('');
  lines.push('Mainboard:');
  for (const entry of deck.boards.mainboard) lines.push(`${entry.qty} ${entry.name}`);
  if (deck.boards.sideboard.length > 0) {
    lines.push('');
    lines.push('Sideboard:');
    for (const entry of deck.boards.sideboard) lines.push(`${entry.qty} ${entry.name}`);
  }
  if (deck.boards.maybeboard.length > 0) {
    lines.push('');
    lines.push('Maybeboard:');
    for (const entry of deck.boards.maybeboard) lines.push(`${entry.qty} ${entry.name}`);
  }
  return lines.join('\n').trim();
}

function renderBoardSection(title: string, rows: Array<{ name: string; qty: number }>): string {
  const items = rows
    .map((entry) => `<li><span>${entry.qty}x</span> ${escapeHtml(entry.name)}</li>`)
    .join('');
  return `
    <section class="board-section">
      <h3>${escapeHtml(title)} (${rows.reduce((sum, row) => sum + row.qty, 0)})</h3>
      <ul>${items || '<li class="muted">No cards</li>'}</ul>
    </section>
  `;
}

async function loadPriceSummary(snapshot: DeckbuilderSharedSnapshot): Promise<void> {
  const status = byId<HTMLDivElement>('publicPriceStatus');
  status.textContent = 'Resolving card prices...';

  const names = [
    ...snapshot.deck.boards.commander.map((entry) => entry.name),
    ...snapshot.deck.boards.mainboard.map((entry) => entry.name),
  ];
  const { resolved } = await resolveDeckbuilderCards(names);
  const summary = computeDeckPriceSummary(toLocalDeck(snapshot), resolved);

  byId<HTMLSpanElement>('publicEurTotal').textContent = `EUR ${summary.eurTotal.toFixed(2)}`;
  byId<HTMLSpanElement>('publicUsdTotal').textContent = `USD ${summary.usdTotal.toFixed(2)}`;
  byId<HTMLDivElement>('publicPriceStatus').textContent = `${summary.cardsWithMissingPrice} card(s) without EUR/USD price data.`;
}

function wireExportButtons(snapshot: DeckbuilderSharedSnapshot): void {
  const textOutput = byId<HTMLTextAreaElement>('publicExportOutput');

  byId<HTMLButtonElement>('btnExportText').addEventListener('click', () => {
    textOutput.value = deckToText(snapshot.deck);
  });

  byId<HTMLButtonElement>('btnExportWants').addEventListener('click', () => {
    textOutput.value = buildCardmarketWantsListText(toLocalDeck(snapshot));
  });

  byId<HTMLButtonElement>('btnExportMass').addEventListener('click', () => {
    textOutput.value = buildTcgplayerMassEntryText(toLocalDeck(snapshot));
  });

  byId<HTMLButtonElement>('btnCopyExport').addEventListener('click', async () => {
    if (!textOutput.value.trim()) return;
    await navigator.clipboard.writeText(textOutput.value);
  });
}

function updateOGMetaTags(snapshot: DeckbuilderSharedSnapshot): void {
  const deckName = snapshot.deck.name || 'Untitled Deck';
  const commanderNames = snapshot.deck.boards.commander.map(e => e.name);
  const commanderLine = commanderNames.length > 0 ? commanderNames.join(' & ') : '';
  const cardCount = snapshot.deck.boards.mainboard.length + snapshot.deck.boards.commander.length + snapshot.deck.boards.sideboard.length;

  const title = commanderLine
    ? `${deckName} — ${commanderLine} | DeckLens`
    : `${deckName} | DeckLens`;
  const description = commanderLine
    ? `${deckName} featuring ${commanderLine} — ${cardCount} cards. View deck, pricing & analytics on DeckLens.`
    : `${deckName} — ${cardCount} cards. View deck, pricing & analytics on DeckLens.`;

  // Update document title
  document.title = title;

  // Update OG tags
  const setMeta = (id: string, content: string) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('content', content);
  };

  setMeta('ogTitle', title);
  setMeta('ogDescription', description);
  setMeta('ogUrl', window.location.href);
  setMeta('twitterTitle', title);
  setMeta('twitterDescription', description);

  // Use commander card image if available (Scryfall art crop)
  if (commanderNames.length > 0) {
    const cmdImageUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(commanderNames[0])}&format=image&version=art_crop`;
    setMeta('ogImage', cmdImageUrl);
    setMeta('twitterImage', cmdImageUrl);
  }
}

function wireClone(snapshot: DeckbuilderSharedSnapshot): void {
  byId<HTMLButtonElement>('btnCloneDeck').addEventListener('click', () => {
    const clone = createDeck(`${snapshot.deck.name} (Clone)`);
    const local = toLocalDeck(snapshot);
    local.id = clone.id;
    local.name = `${snapshot.deck.name} (Clone)`;
    upsertDeck(local);
    window.location.href = `/decks/${encodeURIComponent(clone.id)}`;
  });
}

async function init(): Promise<void> {
  byId<HTMLButtonElement>('btnBackPublicList').addEventListener('click', () => {
    window.location.href = '/decks/public';
  });

  const slug = parseSlugFromPath();
  if (!slug) {
    byId<HTMLDivElement>('publicError').textContent = 'Missing shared deck slug.';
    return;
  }

  try {
    const snapshot = await fetchDeckbuilderSharedSnapshot(slug);
    updateOGMetaTags(snapshot);
    byId<HTMLHeadingElement>('publicDeckTitle').textContent = snapshot.deck.name;
    byId<HTMLDivElement>('publicDeckMeta').textContent = `${snapshot.summary.commanderLine} - ${snapshot.summary.cardCount} cards - shared ${new Date(snapshot.createdAt).toLocaleString()}`;

    const sectionsHtml = [
      renderBoardSection('Commander', snapshot.deck.boards.commander),
      renderBoardSection('Mainboard', snapshot.deck.boards.mainboard),
      renderBoardSection('Maybeboard', snapshot.deck.boards.maybeboard),
      renderBoardSection('Sideboard', snapshot.deck.boards.sideboard),
    ].join('');
    byId<HTMLDivElement>('publicBoards').innerHTML = sectionsHtml;

    wireClone(snapshot);
    wireExportButtons(snapshot);

    byId<HTMLAnchorElement>('publicCardmarketLink').href = `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(snapshot.deck.name)}`;
    byId<HTMLAnchorElement>('publicTcgLink').href = `https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=${encodeURIComponent(snapshot.deck.name)}`;

    await loadPriceSummary(snapshot);
  } catch (error) {
    byId<HTMLDivElement>('publicError').textContent = error instanceof Error ? error.message : 'Failed to load public deck.';
  }
}

void init();
