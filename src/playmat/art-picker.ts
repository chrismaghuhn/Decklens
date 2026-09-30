// ==================== Playmat Artwork Picker ====================
// Context-menu "Change Artwork": shows every paper printing of a card
// and stores the chosen set/collector number on the deck entry, so the
// picked artwork also survives reloads (state.resolveMissing re-fetches
// entries whose cached card does not match the stored printing).

import { fetchCardPrints, type DeckbuilderSearchCard } from '../shared/scryfall-client.js';
import { showToast } from '../deckbuilder/toast.js';
import type { DeckBoard } from '../deckbuilder/types.js';
import { mutateDeck, normalizeNameKey, type PlaymatState } from './state.js';

let overlayEl: HTMLElement | null = null;

function closeArtPicker(): void {
  overlayEl?.remove();
  overlayEl = null;
  document.removeEventListener('keydown', onKeydown);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation();
    closeArtPicker();
  }
}

export async function openArtPicker(state: PlaymatState, name: string, board: DeckBoard): Promise<void> {
  closeArtPicker();

  const overlay = document.createElement('div');
  overlay.className = 'pm-artpicker';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeArtPicker(); });

  const box = document.createElement('div');
  box.className = 'pm-artpicker-box';
  box.innerHTML = `
    <div class="pm-artpicker-head">
      <h2>Artwork — ${name.replace(/</g, '&lt;')}</h2>
      <button type="button" class="pm-drawer-close" aria-label="Close">✕</button>
    </div>
    <div class="pm-artpicker-grid"><span class="pm-muted">Loading printings …</span></div>`;
  box.querySelector('.pm-drawer-close')!.addEventListener('click', closeArtPicker);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlayEl = overlay;
  document.addEventListener('keydown', onKeydown);

  let prints: DeckbuilderSearchCard[];
  try {
    prints = await fetchCardPrints(name);
  } catch {
    showToast({ message: 'Could not load printings.', type: 'error' });
    closeArtPicker();
    return;
  }
  if (overlayEl !== overlay) return; // picker was closed meanwhile
  const grid = box.querySelector<HTMLElement>('.pm-artpicker-grid')!;
  grid.textContent = '';
  if (prints.length === 0) {
    grid.innerHTML = '<span class="pm-muted">No printings found.</span>';
    return;
  }

  const key = normalizeNameKey(name);
  const entry = state.deck.boards[board].find((e) => normalizeNameKey(e.name) === key);
  const currentSet = entry?.set || state.cardByName[key]?.set;
  const currentNum = entry?.collectorNumber || state.cardByName[key]?.collector_number;

  for (const card of prints) {
    const img = card.image_uris?.small || card.image_uris?.normal;
    if (!img) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pm-artpicker-item';
    if (card.set === currentSet && card.collector_number === currentNum) btn.classList.add('current');
    btn.innerHTML = `
      <img src="${img}" alt="" loading="lazy">
      <span>${(card.set || '').toUpperCase()} · #${card.collector_number || '?'}</span>`;
    btn.addEventListener('click', () => {
      mutateDeck(state, (d) => {
        const e = d.boards[board].find((x) => normalizeNameKey(x.name) === key);
        if (e) {
          e.set = card.set ?? null;
          e.collectorNumber = card.collector_number ?? null;
        }
      });
      state.cardByName[key] = card;
      const frontKey = normalizeNameKey(card.name.split('//')[0]);
      if (frontKey) state.cardByName[frontKey] = card;
      document.dispatchEvent(new CustomEvent('pm-render-mat'));
      closeArtPicker();
      showToast({ message: `Artwork set to ${(card.set || '').toUpperCase()} #${card.collector_number || ''}.`, type: 'success' });
    });
    grid.appendChild(btn);
  }
}
