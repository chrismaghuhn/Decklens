import { h, replaceChildren } from '../shared/dom.js';
import type { DeckBoard, DeckbuilderCardEntry, DeckbuilderCardView } from './types.js';

// ==================== Hover Preview ====================

let previewEl: HTMLElement | null = null;
let previewVisible = false;

export function initCardPreview(): void {
  previewEl = document.createElement('div');
  previewEl.className = 'card-hover-preview';
  const img = document.createElement('img');
  img.className = 'preview-img';
  img.alt = '';
  previewEl.appendChild(img);
  document.body.appendChild(previewEl);
}

export function showHoverPreview(card: DeckbuilderCardView, anchorEvent: MouseEvent): void {
  if (!previewEl) return;
  const imgSrc = card.image_uris?.normal || card.image_uris?.small
    || card.card_faces?.[0]?.image_uris?.normal || card.card_faces?.[0]?.image_uris?.small || '';
  if (!imgSrc) return;

  const img = previewEl.querySelector<HTMLImageElement>('img');
  if (img) {
    img.src = imgSrc;
    img.alt = card.name;
  }

  const x = anchorEvent.clientX;
  const y = anchorEvent.clientY;
  const previewW = 280;
  const previewH = 390;

  let left = x + 20;
  let top = y - previewH / 2;

  if (left + previewW > window.innerWidth) left = x - previewW - 20;
  if (top < 8) top = 8;
  if (top + previewH > window.innerHeight - 8) top = window.innerHeight - previewH - 8;

  previewEl.style.left = `${left}px`;
  previewEl.style.top = `${top}px`;
  previewEl.classList.add('visible');
  previewVisible = true;
}

/**
 * Show hover preview using just a card name (for [[Card Name]] links in description).
 * Uses Scryfall image API directly when no resolved card data is available.
 */
export function showHoverPreviewByName(cardName: string, anchorEvent: MouseEvent): void {
  if (!previewEl) return;
  const encodedName = encodeURIComponent(cardName);
  const imgSrc = `https://api.scryfall.com/cards/named?exact=${encodedName}&format=image&version=normal`;

  const img = previewEl.querySelector<HTMLImageElement>('img');
  if (img) {
    img.src = imgSrc;
    img.alt = cardName;
  }

  const x = anchorEvent.clientX;
  const y = anchorEvent.clientY;
  const previewW = 280;
  const previewH = 390;

  let left = x + 20;
  let top = y - previewH / 2;

  if (left + previewW > window.innerWidth) left = x - previewW - 20;
  if (top < 8) top = 8;
  if (top + previewH > window.innerHeight - 8) top = window.innerHeight - previewH - 8;

  previewEl.style.left = `${left}px`;
  previewEl.style.top = `${top}px`;
  previewEl.classList.add('visible');
  previewVisible = true;
}

export function hideHoverPreview(): void {
  if (!previewEl || !previewVisible) return;
  previewEl.classList.remove('visible');
  previewVisible = false;
}

// ==================== Detail Modal ====================

let currentOverlay: HTMLElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

export function showDetailModal(
  cardName: string,
  card: DeckbuilderCardView,
  entry: DeckbuilderCardEntry | null,
  board: DeckBoard,
): void {
  // Hide hover preview first
  hideHoverPreview();
  // Close any existing modal
  hideDetailModal();

  const isDFC = Array.isArray(card.card_faces) && card.card_faces.length === 2;
  let showingBack = false;

  // Get face data — for DFCs, start with front face
  function getFaceData() {
    if (!isDFC || !card.card_faces) {
      return {
        imgSrc: card.image_uris?.normal || '',
        name: card.name,
        typeLine: card.type_line || '',
        manaCost: card.mana_cost || '',
        oracleText: card.oracle_text || 'No oracle text.',
      };
    }
    const face = showingBack ? card.card_faces[1] : card.card_faces[0];
    return {
      imgSrc: face.image_uris?.normal || face.image_uris?.small || card.image_uris?.normal || '',
      name: face.name || card.name,
      typeLine: face.type_line || card.type_line || '',
      manaCost: face.mana_cost || '',
      oracleText: face.oracle_text || 'No oracle text.',
    };
  }

  function updateFaceDisplay() {
    const face = getFaceData();
    const img = overlay.querySelector<HTMLImageElement>('.detail-image img');
    if (img) { img.src = face.imgSrc; img.alt = face.name; }
    const nameEl = overlay.querySelector<HTMLElement>('.detail-face-name');
    if (nameEl) nameEl.textContent = face.name;
    const typeEl = overlay.querySelector<HTMLElement>('.detail-face-type');
    if (typeEl) typeEl.textContent = face.typeLine;
    const manaEl = overlay.querySelector<HTMLElement>('.detail-face-mana');
    if (manaEl) { manaEl.textContent = face.manaCost ? `Mana: ${face.manaCost}` : ''; manaEl.style.display = face.manaCost ? '' : 'none'; }
    const oracleEl = overlay.querySelector<HTMLElement>('.detail-face-oracle');
    if (oracleEl) oracleEl.textContent = face.oracleText;
    const flipBtn = overlay.querySelector<HTMLButtonElement>('.detail-flip-btn');
    if (flipBtn) flipBtn.textContent = showingBack ? '↩ Front Face' : '↪ Back Face';
  }

  const face = getFaceData();
  const scryfallUrl = card.set && card.collector_number
    ? `https://scryfall.com/card/${card.set}/${card.collector_number}`
    : `https://scryfall.com/search?q=${encodeURIComponent(cardName)}`;

  const overlay = h('div', { className: 'detail-overlay', onClick: () => hideDetailModal() },
    h('div', { className: 'detail-modal', onClick: (e: Event) => e.stopPropagation() },

      // Left: card image
      h('div', { className: 'detail-image' },
        face.imgSrc
          ? h('img', { src: face.imgSrc, alt: face.name })
          : h('div', { className: 'muted' }, 'No image available'),
        isDFC
          ? h('button', {
              className: 'btn detail-flip-btn',
              style: 'margin-top:8px;width:100%;font-size:0.78rem;',
              onClick: () => { showingBack = !showingBack; updateFaceDisplay(); },
            }, '↪ Back Face')
          : null,
      ),

      // Right: card info
      h('div', { className: 'detail-info' },
        h('h2', { className: 'detail-face-name' }, face.name),
        h('div', { className: 'muted detail-face-type' }, face.typeLine),
        h('div', { className: 'detail-face-mana', style: face.manaCost ? 'margin-top:4px;' : 'display:none;' }, face.manaCost ? `Mana: ${face.manaCost}` : ''),

        // Oracle text
        h('div', { className: 'detail-section' },
          h('h4', {}, 'Oracle Text'),
          h('p', { className: 'detail-face-oracle', style: 'white-space:pre-wrap;' }, face.oracleText),
        ),

        // DFC indicator
        isDFC
          ? h('div', { className: 'detail-section', style: 'padding:4px 8px;background:rgba(201,168,76,0.08);border-radius:6px;font-size:0.75rem;color:var(--gold-dim);' },
              `Double-faced card — ${card.card_faces![0].name || '?'} // ${card.card_faces![1].name || '?'}`,
            )
          : null,

        // Keywords
        card.keywords && card.keywords.length > 0
          ? h('div', { className: 'detail-section' },
              h('h4', {}, 'Keywords'),
              h('p', {}, card.keywords.join(', ')),
            )
          : null,

        // Prices
        h('div', { className: 'detail-section' },
          h('h4', {}, 'Prices'),
          h('p', {},
            `EUR: ${card.prices?.eur || 'N/A'}`,
            ' | ',
            `USD: ${card.prices?.usd || 'N/A'}`,
          ),
        ),

        // Legalities
        card.legalities
          ? h('div', { className: 'detail-section' },
              h('h4', {}, 'Legality'),
              renderLegalities(card.legalities),
            )
          : null,

        // Set / Printing
        h('div', { className: 'detail-section' },
          h('h4', {}, 'Set / Printing'),
          h('p', {}, `${(card.set || '?').toUpperCase()} #${card.collector_number || '?'}`),
        ),

        // Deck info
        entry
          ? h('div', { className: 'detail-section' },
              h('h4', {}, 'In Deck'),
              h('p', {},
                `Board: ${board} | Qty: ${entry.qty} | Tags: ${entry.tags.join(', ') || 'none'}`,
              ),
            )
          : null,

        // Actions
        h('div', { className: 'detail-actions' },
          h('a', { href: scryfallUrl, target: '_blank', className: 'btn' }, 'View on Scryfall'),
          h('button', { className: 'btn', onClick: () => hideDetailModal() }, 'Close'),
        ),
      ),
    ),
  );

  document.body.appendChild(overlay);
  currentOverlay = overlay;

  escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hideDetailModal();
  };
  document.addEventListener('keydown', escHandler);
}

export function hideDetailModal(): void {
  if (currentOverlay) {
    currentOverlay.remove();
    currentOverlay = null;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

// ==================== Helpers ====================

function renderLegalities(legalities: Record<string, string>): HTMLElement {
  const importantFormats = ['commander', 'standard', 'modern', 'pioneer', 'legacy', 'vintage', 'pauper'];
  const container = h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });

  for (const fmt of importantFormats) {
    const status = legalities[fmt];
    if (!status) continue;

    let colorClass = 'muted';
    if (status === 'legal') colorClass = 'ok';
    else if (status === 'banned') colorClass = 'danger';
    else if (status === 'restricted') colorClass = 'warn-text';

    container.appendChild(
      h('span', { className: colorClass, style: 'font-size:0.78rem;' },
        `${fmt}: ${status}`,
      ),
    );
  }

  return container;
}
