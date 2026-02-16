import { fetchDeckbuilderPublicDecks, type DeckbuilderShareSummary } from '../shared/api.js';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function formatDate(iso: string): string {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return 'unknown';
  return new Date(value).toLocaleString();
}

function renderList(items: DeckbuilderShareSummary[]): void {
  const list = byId<HTMLDivElement>('publicDecksList');
  list.textContent = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No public decks found for this search.';
    list.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'deck-row';

    const left = document.createElement('div');
    left.className = 'deck-row-title';
    const title = document.createElement('strong');
    title.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `${item.commanderLine} - ${item.cardCount} cards - shared ${formatDate(item.createdAt)}`;
    left.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'deck-row-actions';
    const openButton = document.createElement('button');
    openButton.className = 'btn primary';
    openButton.textContent = 'Open';
    openButton.addEventListener('click', () => {
      window.location.href = `/d/${encodeURIComponent(item.slug)}`;
    });
    actions.append(openButton);

    row.append(left, actions);
    list.append(row);
  }
}

async function loadPublicDecks(): Promise<void> {
  const status = byId<HTMLDivElement>('publicStatus');
  const query = byId<HTMLInputElement>('publicSearch').value.trim();
  status.textContent = 'Loading public decks...';
  status.className = 'muted';

  try {
    const items = await fetchDeckbuilderPublicDecks({ q: query, limit: 60 });
    renderList(items);
    status.textContent = `${items.length} public deck(s) loaded.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Failed to load public decks.';
    status.className = 'danger';
  }
}

function init(): void {
  byId<HTMLButtonElement>('btnSearchPublic').addEventListener('click', () => {
    void loadPublicDecks();
  });
  byId<HTMLButtonElement>('btnClearPublic').addEventListener('click', () => {
    byId<HTMLInputElement>('publicSearch').value = '';
    void loadPublicDecks();
  });
  byId<HTMLButtonElement>('btnBackMyDecks').addEventListener('click', () => {
    window.location.href = '/decks';
  });
  byId<HTMLInputElement>('publicSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void loadPublicDecks();
    }
  });

  void loadPublicDecks();
}

document.addEventListener('DOMContentLoaded', init);
