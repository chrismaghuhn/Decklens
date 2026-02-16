/**
 * CollabPackages — Card Packages (reusable building blocks) for collaborative deck editing.
 *
 * Browse, create, and apply card packages: "Simic Ramp Package", "Jeskai Removal Suite", etc.
 * Packages are pre-built card bundles that can be applied to any deck.
 */

import { h } from '../shared/dom.js';
import { attachCardAutocomplete, cardNameWithPreview } from './card-autocomplete.js';

// ───── Types ─────

export interface CardPackage {
  id: string;
  name: string;
  description: string;
  category: string;
  cards_json: string;
  created_by: string | null;
  is_public: number;
  upvotes: number;
  created_at: string;
}

// ───── Constants ─────

const PACKAGE_CATEGORIES = [
  { key: 'ramp', label: 'Ramp', icon: '\uD83C\uDF3F' },
  { key: 'removal', label: 'Removal', icon: '\uD83D\uDCA5' },
  { key: 'draw', label: 'Card Draw', icon: '\uD83C\uDCCF' },
  { key: 'combo', label: 'Combo', icon: '\u26A1' },
  { key: 'manabase', label: 'Manabase', icon: '\uD83D\uDC8E' },
  { key: 'protection', label: 'Protection', icon: '\uD83D\uDEE1\uFE0F' },
  { key: 'synergy', label: 'Synergy', icon: '\uD83D\uDD17' },
  { key: 'other', label: 'Other', icon: '\uD83D\uDCE6' },
];

// ───── State ─────

let packages: CardPackage[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let initialized = false;
let activeCategory: string | null = null;
let onApplyPackage: ((cards: string[]) => void) | null = null;

// ───── Public API ─────

export function initPackages(applyCallback: (cards: string[]) => void): void {
  if (initialized) return;
  initialized = true;
  onApplyPackage = applyCallback;
  loadPackages();
}

export function togglePackagePanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isPackagePanelOpen(): boolean {
  return panelVisible;
}

export function refreshPackages(): void {
  loadPackages();
}

/** Create a new package */
export async function createPackage(
  name: string,
  description: string,
  category: string,
  cards: string[],
): Promise<CardPackage | null> {
  try {
    const resp = await fetch(`${getApiOrigin()}/api/packages`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, category, cards }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { package: CardPackage } };
    if (data.ok && data.data?.package) {
      packages.unshift(data.data.package);
      if (panelVisible) renderPanel();
      return data.data.package;
    }
  } catch { /* ignore */ }
  return null;
}

/** Cleanup */
export function resetPackages(): void {
  packages = [];
  initialized = false;
  if (panelEl) panelEl.remove();
  panelEl = null;
  panelVisible = false;
  onApplyPackage = null;
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadPackages(): Promise<void> {
  try {
    const categoryParam = activeCategory ? `?category=${activeCategory}` : '';
    const resp = await fetch(`${getApiOrigin()}/api/packages${categoryParam}`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { packages: CardPackage[] } };
    if (data.ok && data.data?.packages) {
      packages = data.data.packages;
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

async function deletePackage(packageId: string): Promise<void> {
  try {
    const resp = await fetch(`${getApiOrigin()}/api/packages/${packageId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (resp.ok) {
      packages = packages.filter((p) => p.id !== packageId);
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadPackages(); return; }

  panelEl = h('div', { className: 'package-panel' },
    h('div', { className: 'package-header' },
      h('span', { className: 'package-title' }, '\uD83D\uDCE6 Card Packages'),
      h('div', { className: 'package-actions-header' },
        h('button', { className: 'package-create-btn', onClick: () => promptCreatePackage(), title: 'Create new package' }, '+ Package'),
        h('button', { className: 'package-close', onClick: () => togglePackagePanel(), title: 'Close' }, '\u2715'),
      ),
    ),
    h('div', { className: 'package-categories', id: '_pkgCategories' }),
    h('div', { className: 'package-body', id: '_pkgBody' }),
  );
  document.body.appendChild(panelEl);
  renderCategories();
  renderPanel();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderCategories(): void {
  const container = document.getElementById('_pkgCategories');
  if (!container) return;

  const allBtn = h('button', {
    className: `package-cat-btn${activeCategory === null ? ' active' : ''}`,
    onClick: () => { activeCategory = null; loadPackages(); renderCategories(); },
  }, 'All');

  const catBtns = PACKAGE_CATEGORIES.map((cat) =>
    h('button', {
      className: `package-cat-btn${activeCategory === cat.key ? ' active' : ''}`,
      onClick: () => { activeCategory = cat.key; loadPackages(); renderCategories(); },
    }, `${cat.icon} ${cat.label}`),
  );

  container.replaceChildren(allBtn, ...catBtns);
}

function renderPanel(): void {
  const container = document.getElementById('_pkgBody');
  if (!container) return;

  if (packages.length === 0) {
    container.replaceChildren(
      h('div', { className: 'package-empty' },
        h('p', {}, 'No packages found.'),
        h('p', {}, 'Create a package to share card bundles with your team.'),
      ),
    );
    return;
  }

  const cards = packages.map((pkg) => renderPackageCard(pkg));
  container.replaceChildren(...cards);
}

function renderPackageCard(pkg: CardPackage): HTMLElement {
  let cardList: string[] = [];
  try { cardList = JSON.parse(pkg.cards_json); } catch { /* ignore */ }

  const catInfo = PACKAGE_CATEGORIES.find((c) => c.key === pkg.category);
  const catLabel = catInfo ? `${catInfo.icon} ${catInfo.label}` : pkg.category;

  return h('div', { className: 'package-card' },
    h('div', { className: 'package-card-header' },
      h('span', { className: 'package-card-name' }, pkg.name),
      h('span', { className: 'package-card-cat' }, catLabel),
    ),
    pkg.description
      ? h('div', { className: 'package-card-desc' }, pkg.description)
      : '',
    h('div', { className: 'package-card-cards' },
      h('span', { className: 'package-card-count' }, `${cardList.length} cards`),
      h('div', { className: 'package-card-list' },
        ...cardList.slice(0, 8).map((name) =>
          cardNameWithPreview(name, 'package-card-item'),
        ),
        cardList.length > 8
          ? h('span', { className: 'package-card-more' }, `+${cardList.length - 8} more`)
          : '',
      ),
    ),
    h('div', { className: 'package-card-footer' },
      h('button', {
        className: 'package-apply-btn',
        onClick: () => {
          if (onApplyPackage && cardList.length > 0) {
            onApplyPackage(cardList);
          }
        },
      }, '\u2B07 Apply to Deck'),
      h('button', {
        className: 'package-delete-btn',
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (confirm(`Delete package "${pkg.name}"?`)) deletePackage(pkg.id);
        },
        title: 'Delete',
      }, '\u2715'),
    ),
  );
}

// ───── Create Modal ─────

function promptCreatePackage(): void {
  const overlay = h('div', { className: 'package-modal-overlay' },
    h('div', { className: 'package-modal' },
      h('h3', {}, 'New Card Package'),
      h('label', {}, 'Name'),
      h('input', { type: 'text', className: 'package-input', placeholder: 'e.g. Simic Ramp Package', id: '_pkgName' }),
      h('label', {}, 'Category'),
      h('select', { className: 'package-select', id: '_pkgCat' },
        ...PACKAGE_CATEGORIES.map((cat) =>
          h('option', { value: cat.key }, `${cat.icon} ${cat.label}`),
        ),
      ),
      h('label', {}, 'Description (optional)'),
      h('input', { type: 'text', className: 'package-input', placeholder: 'Describe the package...', id: '_pkgDesc' }),
      h('label', {}, 'Cards (one per line)'),
      h('textarea', {
        className: 'package-textarea',
        placeholder: 'Sol Ring\nArcane Signet\nCultivate\nKodama\'s Reach',
        id: '_pkgCards',
        rows: '6',
      }),
      h('div', { className: 'package-modal-actions' },
        h('button', { className: 'package-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'package-modal-confirm', onClick: async () => {
          const name = (document.getElementById('_pkgName') as HTMLInputElement)?.value?.trim();
          if (!name) return;
          const category = (document.getElementById('_pkgCat') as HTMLSelectElement)?.value || 'other';
          const desc = (document.getElementById('_pkgDesc') as HTMLInputElement)?.value?.trim() || '';
          const cardsText = (document.getElementById('_pkgCards') as HTMLTextAreaElement)?.value?.trim() || '';
          const cards = cardsText.split('\n').map((l) => l.trim()).filter(Boolean);
          if (cards.length === 0) return;
          await createPackage(name, desc, category, cards);
          overlay.remove();
        }}, 'Create'),
      ),
    ),
  );
  document.body.appendChild(overlay);

  // Attach autocomplete to cards textarea (multi-line mode)
  const cardsTextarea = document.getElementById('_pkgCards') as HTMLTextAreaElement;
  if (cardsTextarea) {
    attachCardAutocomplete({ input: cardsTextarea, multiLine: true });
  }

  setTimeout(() => (document.getElementById('_pkgName') as HTMLInputElement)?.focus(), 50);
}
