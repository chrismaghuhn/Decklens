/**
 * Collection Management Panel for DeckLens
 * Provides UI for viewing collection status, importing/exporting,
 * and showing missing cards with purchase cost and owned quantity.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import {
  isOwned,
  loadCollection,
  getCollectionSize,
  getTotalCollectionCards,
  getOwnedQty,
  setOwnedQty,
  importCollectionText,
  exportCollectionText,
  toggleOwned,
} from './collection.js';

// ==================== Types ====================

interface MissingCard {
  name: string;
  qtyNeeded: number;
  qtyOwned: number;
  eurPrice: number;
}

export interface CollectionPanelCallbacks {
  onCollectionChanged(): void;
}

// ==================== Helpers ====================

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getEurPrice(card: DeckbuilderSearchCard | undefined): number {
  if (!card?.prices?.eur) return 0;
  return parseFloat(card.prices.eur) || 0;
}

// ==================== Core Logic ====================

function getCollectionStats(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): { ownedCount: number; totalUnique: number; missingCards: MissingCard[]; missingTotalEur: number } {
  const allEntries = [...deck.boards.commander, ...deck.boards.mainboard];
  let ownedCount = 0;
  let totalUnique = 0;
  const missingCards: MissingCard[] = [];
  let missingTotalEur = 0;

  for (const entry of allEntries) {
    totalUnique++;
    const qtyOwned = getOwnedQty(entry.name);
    const qtyNeeded = entry.qty;

    if (qtyOwned >= qtyNeeded) {
      ownedCount++;
    } else {
      const card = cardByName[normalizeKey(entry.name)];
      const eur = getEurPrice(card);
      const stillNeeded = qtyNeeded - qtyOwned;
      missingCards.push({ name: entry.name, qtyNeeded: stillNeeded, qtyOwned, eurPrice: eur });
      missingTotalEur += eur * stillNeeded;
    }
  }

  // Sort missing by price (most expensive first)
  missingCards.sort((a, b) => b.eurPrice - a.eurPrice);

  return { ownedCount, totalUnique, missingCards, missingTotalEur };
}

// ==================== Rendering ====================

export function renderCollectionPanel(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  callbacks: CollectionPanelCallbacks,
): void {
  container.textContent = '';

  // Ensure collection is loaded
  loadCollection();

  const stats = getCollectionStats(deck, cardByName);
  const collectionSize = getCollectionSize();
  const totalCards = getTotalCollectionCards();
  const completionPct = stats.totalUnique > 0 ? Math.round((stats.ownedCount / stats.totalUnique) * 100) : 0;

  // ── Section Header ──
  const header = document.createElement('div');
  header.className = 'collection-header';

  const title = document.createElement('h4');
  title.textContent = 'Collection Tracker';
  title.style.margin = '0';

  const badge = document.createElement('span');
  badge.className = 'collection-size-badge';
  badge.textContent = `${collectionSize} unique (${totalCards} total) in collection`;

  header.append(title, badge);
  container.appendChild(header);

  // ── Completion Bar ──
  const completionBox = document.createElement('div');
  completionBox.className = 'collection-completion';

  const completionText = document.createElement('div');
  completionText.className = 'collection-completion-text';
  completionText.innerHTML = `<span>You own <strong>${stats.ownedCount}/${stats.totalUnique}</strong> cards in this deck</span><span class="collection-pct">${completionPct}%</span>`;

  const progressBar = document.createElement('div');
  progressBar.className = 'collection-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'collection-progress-fill';
  progressFill.style.width = `${completionPct}%`;
  if (completionPct >= 80) progressFill.classList.add('high');
  else if (completionPct >= 50) progressFill.classList.add('mid');
  else progressFill.classList.add('low');
  progressBar.appendChild(progressFill);

  completionBox.append(completionText, progressBar);
  container.appendChild(completionBox);

  // ── Action Buttons ──
  const actions = document.createElement('div');
  actions.className = 'collection-actions';

  const importBtn = document.createElement('button');
  importBtn.className = 'btn collection-btn';
  importBtn.textContent = 'Import Collection';
  importBtn.addEventListener('click', () => showImportModal(container, callbacks));

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn collection-btn';
  exportBtn.textContent = 'Export Collection';
  exportBtn.addEventListener('click', () => {
    const text = exportCollectionText();
    if (!text) {
      alert('Collection is empty. Mark cards as owned or import a collection first.');
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
 exportBtn.textContent = ' Copied!';
      setTimeout(() => { exportBtn.textContent = 'Export Collection'; }, 1500);
    }).catch(() => {
      // Fallback: show in a copyable textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:40%;z-index:13000;padding:16px;font-size:12px;';
      document.body.appendChild(ta);
      ta.select();
      ta.addEventListener('blur', () => ta.remove());
    });
  });

  const markAllBtn = document.createElement('button');
  markAllBtn.className = 'btn collection-btn';
 markAllBtn.textContent = ' Mark All Owned';
  markAllBtn.addEventListener('click', () => {
    const allEntries = [...deck.boards.commander, ...deck.boards.mainboard];
    for (const entry of allEntries) {
      if (!isOwned(entry.name)) {
        toggleOwned(entry.name);
      }
    }
    callbacks.onCollectionChanged();
  });

  actions.append(importBtn, exportBtn, markAllBtn);
  container.appendChild(actions);

  // ── Missing Cards List ──
  if (stats.missingCards.length > 0) {
    const missingSection = document.createElement('div');
    missingSection.className = 'collection-missing';

    const missingHeader = document.createElement('div');
    missingHeader.className = 'collection-missing-header';
    missingHeader.innerHTML = `<span>Missing Cards (${stats.missingCards.length})</span><strong class="collection-missing-cost">\u20AC${stats.missingTotalEur.toFixed(2)} to complete</strong>`;
    missingSection.appendChild(missingHeader);

    const missingList = document.createElement('div');
    missingList.className = 'collection-missing-list';

    for (const mc of stats.missingCards.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'collection-missing-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'collection-missing-name';
      const ownedBadge = mc.qtyOwned > 0 ? ` <span class="collection-owned-badge">${mc.qtyOwned} owned</span>` : '';
      nameSpan.innerHTML = `${mc.qtyNeeded}x ${mc.name}${ownedBadge}`;

      const priceSpan = document.createElement('span');
      priceSpan.className = 'collection-missing-price';
      priceSpan.textContent = mc.eurPrice > 0 ? `\u20AC${(mc.eurPrice * mc.qtyNeeded).toFixed(2)}` : '\u2014';

      // Qty spinner for setting owned quantity
      const qtyControls = document.createElement('div');
      qtyControls.className = 'collection-qty-controls';

      const minusBtn = document.createElement('button');
      minusBtn.className = 'btn collection-qty-btn';
      minusBtn.textContent = '\u2212';
      minusBtn.disabled = mc.qtyOwned <= 0;
      minusBtn.addEventListener('click', () => {
        const newQty = Math.max(0, mc.qtyOwned - 1);
        setOwnedQty(mc.name, newQty);
        callbacks.onCollectionChanged();
      });

      const qtyLabel = document.createElement('span');
      qtyLabel.className = 'collection-qty-label';
      qtyLabel.textContent = String(mc.qtyOwned);

      const plusBtn = document.createElement('button');
      plusBtn.className = 'btn collection-qty-btn';
      plusBtn.textContent = '+';
      plusBtn.addEventListener('click', () => {
        setOwnedQty(mc.name, mc.qtyOwned + 1);
        callbacks.onCollectionChanged();
      });

      qtyControls.append(minusBtn, qtyLabel, plusBtn);

      row.append(nameSpan, priceSpan, qtyControls);
      missingList.appendChild(row);
    }

    if (stats.missingCards.length > 20) {
      const more = document.createElement('div');
      more.className = 'muted';
      more.style.cssText = 'font-size:0.72rem; padding: 4px 0;';
      more.textContent = `... and ${stats.missingCards.length - 20} more`;
      missingList.appendChild(more);
    }

    missingSection.appendChild(missingList);
    container.appendChild(missingSection);
  } else if (stats.totalUnique > 0) {
    const complete = document.createElement('div');
    complete.className = 'collection-complete';
    complete.textContent = 'You own every card in this deck!';
    container.appendChild(complete);
  }
}

// ==================== Import Modal ====================

function showImportModal(parentContainer: HTMLElement, callbacks: CollectionPanelCallbacks): void {
  // Check if modal already open
  const existing = document.getElementById('collectionImportModal');
  if (existing) {
    existing.remove();
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'collectionImportModal';
  modal.className = 'collection-import-modal';

  const modalContent = document.createElement('div');
  modalContent.className = 'collection-import-content';

  const modalTitle = document.createElement('h4');
  modalTitle.textContent = 'Import Collection';
  modalTitle.style.margin = '0 0 8px';

  const modalDesc = document.createElement('p');
  modalDesc.className = 'muted';
  modalDesc.style.cssText = 'margin:0 0 8px; font-size:0.78rem;';
  modalDesc.textContent = 'Paste your collection as one card name per line. Optionally prefix with quantity: "3x Sol Ring" or "3 Sol Ring".';

  const textarea = document.createElement('textarea');
  textarea.className = 'collection-import-textarea';
  textarea.placeholder = '3x Sol Ring\n2x Command Tower\nSwords to Plowshares\n...';
  textarea.rows = 10;

  const btnRow = document.createElement('div');
  btnRow.className = 'collection-import-btns';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.remove());

  const importBtnEl = document.createElement('button');
  importBtnEl.className = 'btn primary';
  importBtnEl.textContent = 'Import';
  importBtnEl.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) {
      alert('Please paste your collection first.');
      return;
    }
    const added = importCollectionText(text);
    modal.remove();
    callbacks.onCollectionChanged();
    // Show brief toast
    const toast = document.createElement('div');
    toast.className = 'collection-toast';
 toast.textContent = ` Added ${added} cards to collection`;
    parentContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  });

  btnRow.append(cancelBtn, importBtnEl);
  modalContent.append(modalTitle, modalDesc, textarea, btnRow);
  modal.appendChild(modalContent);

  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  parentContainer.appendChild(modal);
  textarea.focus();
}
