// ==================== Print Proxy Sheets (S3-F3) ====================
// Sprint 3 S3-F3: Print Proxy Sheets MVP
//
// Features:
// - Generate printable proxy sheets
// - Standard MTG card size (63x88mm)
// - 3x3 grid per page (9 cards)
// - Cut guides and page breaks

import { escapeHtml } from '../utils.js';

// ==================== Constants ====================


/**
 * Page layout configuration.
 */
export const PAGE_LAYOUT = {
  /** Cards per row */
  columns: 3,
  /** Rows per page */
  rows: 3,
  /** Cards per page */
  cardsPerPage: 9,
  /** Page margin in mm */
  margin: 10,
  /** Gap between cards in mm */
  gap: 2,
};

// ==================== Types ====================

export interface ProxyCard {
  name: string;
  qty: number;
  imageUrl?: string;
  /** Fallback text if no image */
  text?: string;
  /** Card type for placeholder */
  type?: string;
}

export interface ProxySheetOptions {
  /** Include card names on proxy */
  showNames?: boolean;
  /** Include cut guides */
  showCutGuides?: boolean;
  /** Quality level (affects image size) */
  quality?: 'draft' | 'normal' | 'high';
  /** Custom page title */
  title?: string;
  /** Include card count per page */
  showCount?: boolean;
}

export interface ProxySheet {
  cards: ProxyCard[];
  pageCount: number;
  totalCards: number;
}

// ==================== Proxy Generation ====================

/**
 * Expand deck entries to individual proxy cards.
 */
export function expandToProxies(entries: Array<{ name: string; qty: number; imageUrl?: string }>): ProxyCard[] {
  const proxies: ProxyCard[] = [];
  
  for (const entry of entries) {
    for (let i = 0; i < entry.qty; i++) {
      proxies.push({
        name: entry.name,
        qty: 1,
        imageUrl: entry.imageUrl,
      });
    }
  }
  
  return proxies;
}

/**
 * Group proxies into pages.
 */
export function groupIntoPages(proxies: ProxyCard[]): ProxyCard[][] {
  const pages: ProxyCard[][] = [];
  
  for (let i = 0; i < proxies.length; i += PAGE_LAYOUT.cardsPerPage) {
    pages.push(proxies.slice(i, i + PAGE_LAYOUT.cardsPerPage));
  }
  
  return pages;
}

/**

// ==================== Export Helpers ====================

/**
 * Generate print-friendly HTML for proxy sheet.
 */
export function generatePrintHTML(
  entries: Array<{ name: string; qty: number; imageUrl?: string }>,
  options: ProxySheetOptions = {}
): string {
  const proxies = expandToProxies(entries);
  const pages = groupIntoPages(proxies);
  
  const cardHTML = (card: ProxyCard) => {
    if (card.imageUrl) {
      return `
        <div class="proxy-card">
          <img class="proxy-card__image" src="${escapeHtml(card.imageUrl)}" alt="${escapeHtml(card.name)}" />
          ${options.showNames ? `<div class="proxy-card__name">${escapeHtml(card.name)}</div>` : ''}
        </div>
      `;
    }
    return `
      <div class="proxy-card">
        <div class="proxy-card__placeholder">
          <span class="proxy-card__placeholder-name">${escapeHtml(card.name)}</span>
        </div>
      </div>
    `;
  };
  
  const pageHTML = (cards: ProxyCard[], pageNum: number) => `
    <div class="proxy-page">
      ${options.showCount ? `<div class="proxy-page__header"><span class="proxy-page__count">Page ${pageNum}/${pages.length}</span></div>` : ''}
      <div class="proxy-grid">
        ${cards.map(cardHTML).join('')}
      </div>
    </div>
  `;
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>${options.title ? escapeHtml(options.title) : 'Proxy Sheet'}</title>
      <style>${PROXY_PRINT_STYLES}</style>
    </head>
    <body>
      <div class="proxy-sheet">
        ${pages.map((cards, i) => pageHTML(cards, i + 1)).join('')}
      </div>
    </body>
    </html>
  `;
}

// ==================== CSS ====================

const PROXY_STYLES = `
/* Proxy Sheet Container */
.proxy-sheet {
  background: var(--bg-1, #1a1a1f);
  padding: 1rem;
}

.proxy-sheet__print-header,
.proxy-sheet__print-footer {
  display: none;
}

/* Proxy Page */
.proxy-page {
  background: white;
  padding: 10mm;
  margin-bottom: 1rem;
  position: relative;
  border-radius: var(--radius-sm, 8px);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}

.proxy-page__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px dashed #ccc;
}

.proxy-page__title {
  font-weight: 600;
  color: #333;
}

.proxy-page__count {
  font-size: 0.75rem;
  color: #666;
}

/* Proxy Grid */
.proxy-grid {
  display: grid;
  grid-template-columns: repeat(3, 63mm);
  grid-template-rows: repeat(3, 88mm);
  gap: 2mm;
  justify-content: center;
}

/* Proxy Card */
.proxy-card {
  width: 63mm;
  height: 88mm;
  background: #f0f0f0;
  border: 1px solid #ccc;
  border-radius: 3mm;
  overflow: hidden;
  position: relative;
}

.proxy-card__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.proxy-card__placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5mm;
  background: linear-gradient(135deg, #e0e0e0 0%, #f5f5f5 100%);
  text-align: center;
}

.proxy-card__placeholder-name {
  font-size: 10pt;
  font-weight: 600;
  color: #333;
  word-break: break-word;
}

.proxy-card__name {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0,0,0,0.7);
  color: white;
  padding: 2mm;
  font-size: 8pt;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Cut Guides */
.proxy-page__cut-guides {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.cut-guide {
  position: absolute;
  background: #ccc;
}

.cut-guide--h {
  left: 5mm;
  right: 5mm;
  height: 1px;
}

.cut-guide--h1 { top: calc(10mm + 88mm + 1mm); }
.cut-guide--h2 { top: calc(10mm + 176mm + 3mm); }

.cut-guide--v {
  top: 5mm;
  bottom: 5mm;
  width: 1px;
}

.cut-guide--v1 { left: calc(10mm + 63mm + 1mm); }
.cut-guide--v2 { left: calc(10mm + 126mm + 3mm); }

/* Quality Variants */
.proxy-sheet--draft .proxy-card__image {
  image-rendering: pixelated;
}

.proxy-sheet--high .proxy-card__image {
  image-rendering: high-quality;
}

/* Print Styles */
@media print {
  body {
    margin: 0;
    padding: 0;
    background: white;
  }
  
  .proxy-sheet {
    background: white;
    padding: 0;
  }
  
  .proxy-sheet__print-header,
  .proxy-sheet__print-footer {
    display: block;
    text-align: center;
    color: #666;
    font-size: 10pt;
  }
  
  .proxy-sheet__print-header {
    margin-bottom: 5mm;
  }
  
  .proxy-sheet__print-footer {
    margin-top: 5mm;
    page-break-after: avoid;
  }
  
  .proxy-page {
    box-shadow: none;
    border-radius: 0;
    margin-bottom: 0;
    page-break-after: always;
    page-break-inside: avoid;
  }
  
  .proxy-page:last-child {
    page-break-after: avoid;
  }
  
  .proxy-page__header {
    border-bottom-style: solid;
  }
  
  .cut-guide {
    background: #999;
  }
}

@page {
  size: A4;
  margin: 10mm;
}
`;

const PROXY_PRINT_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; }
  
  .proxy-sheet { background: white; }
  
  .proxy-page {
    page-break-after: always;
    padding: 10mm;
  }
  
  .proxy-page:last-child { page-break-after: avoid; }
  
  .proxy-page__header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 5mm;
    font-size: 10pt;
    color: #666;
  }
  
  .proxy-grid {
    display: grid;
    grid-template-columns: repeat(3, 63mm);
    grid-template-rows: repeat(3, 88mm);
    gap: 2mm;
    justify-content: center;
  }
  
  .proxy-card {
    width: 63mm;
    height: 88mm;
    border: 1px solid #ccc;
    border-radius: 3mm;
    overflow: hidden;
  }
  
  .proxy-card__image {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  
  .proxy-card__placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 5mm;
    background: #f0f0f0;
    text-align: center;
  }
  
  .proxy-card__placeholder-name {
    font-size: 10pt;
    font-weight: bold;
  }
  
  .proxy-card__name {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(0,0,0,0.7);
    color: white;
    padding: 2mm;
    font-size: 8pt;
    text-align: center;
  }
  
  @page { size: A4; margin: 10mm; }
`;

// Inject styles once
let _stylesInjected = false;
export function injectProxyStyles(): void {
  if (_stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = PROXY_STYLES;
  document.head.appendChild(style);
  _stylesInjected = true;
}

// Auto-inject on module load
if (typeof document !== 'undefined') {
  injectProxyStyles();
}
