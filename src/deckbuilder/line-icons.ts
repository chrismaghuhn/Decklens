/**
 * Swiss Data-Lab line icons.
 *
 * Geometric stroke icons (24×24 viewBox, `fill:none`, `stroke:currentColor`,
 * `stroke-width:1.5`) matching the inline SVG icon language of the landing
 * page. Replaces all emoji iconography in the deck editor.
 */

const ICON_PATHS: Record<string, string> = {
  // ── Layout presets ──
  compact: '<rect x="5" y="5" width="14" height="14"/>',
  analytics: '<path d="M4 20h16"/><path d="M6 16v-5"/><path d="M10 16V7"/><path d="M14 16v-8"/><path d="M18 16V9"/>',
  goldfish: '<path d="M8 5l10 7-10 7z"/>',
  minimal: '<path d="M4 12h16"/>',
  full: '<rect x="4" y="4" width="16" height="16"/><path d="M12 4v16"/><path d="M4 12h16"/>',

  // ── Widgets ──
  cards: '<rect x="4" y="7" width="11" height="14"/><path d="M9 3h11v14"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="M15 15l6 6"/>',
  'commander-stats': '<path d="M4 17h16"/><path d="M4 17L3 8l5 4 4-6 4 6 5-4-1 9"/>',
  'mana-curve': '<path d="M4 20h16"/><path d="M7 20v-6"/><path d="M12 20V8"/><path d="M17 20v-9"/>',
  'color-pie': '<circle cx="12" cy="12" r="8"/><path d="M12 12V4"/><path d="M12 12l6 6"/>',
  'type-dist': '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  'power-bracket': '<path d="M13 2L5 13h6l-1 9 9-12h-7l1-8z"/>',
  'health-score': '<rect x="4" y="4" width="16" height="16"/><path d="M12 8v8"/><path d="M8 12h8"/>',
  'official-bracket': '<path d="M7 4h10v5a5 5 0 01-10 0V4z"/><path d="M7 5H4v2a3 3 0 003 3"/><path d="M17 5h3v2a3 3 0 01-3 3"/><path d="M12 14v4"/><path d="M8 20h8"/>',
  fingerprint: '<path d="M6 18a8 8 0 1112 0"/><path d="M9 15a4.5 4.5 0 017 0"/><path d="M11.2 11.2h1.6v1.6h-1.6z"/>',
  'mana-calc': '<rect x="5" y="3" width="14" height="18"/><path d="M8 7h8"/><path d="M9 12h2"/><path d="M13 12h2"/><path d="M9 16h2"/><path d="M13 16h2"/>',
  'synergy-map': '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="10" cy="18" r="2"/><path d="M8 6.3l8 1.4"/><path d="M6.7 8l2.6 8"/><path d="M16.8 9.9l-5.2 6.4"/>',
  combos: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
  'draw-probability': '<rect x="4" y="4" width="16" height="16"/><path d="M11.4 8.6h1.2v1.2h-1.2z" fill="currentColor" stroke="none"/><path d="M11.4 14.2h1.2v1.2h-1.2z" fill="currentColor" stroke="none"/><path d="M8.6 11.4h1.2v1.2H8.6z" fill="currentColor" stroke="none"/><path d="M14.2 11.4h1.2v1.2h-1.2z" fill="currentColor" stroke="none"/>',
  'deck-tips': '<path d="M12 3a6 6 0 00-3 11v2h6v-2a6 6 0 00-3-11z"/><path d="M9 18h6"/><path d="M10 21h4"/>',
  'land-split': '<path d="M3 20h18"/><path d="M3 20L10 6l3 7 3-5 5 12"/>',
  tags: '<path d="M4 4h7l9 9-7 7-9-9V4z"/><path d="M8.5 8.5h.01"/>',
  'summary-bar': '<path d="M4 20h16"/><path d="M4 16l5-5 4 4 7-8"/><path d="M16 7h4v4"/>',
  'price-summary': '<rect x="3" y="7" width="18" height="10"/><circle cx="12" cy="12" r="2.5"/>',
  collection: '<path d="M4 8h16v12H4z"/><path d="M4 8l2-4h12l2 4"/><path d="M10 12h4"/>',
  budget: '<circle cx="12" cy="12" r="8"/><path d="M15 9.5a4 4 0 100 5"/><path d="M12 6v1"/><path d="M12 17v1"/>',
  export: '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 13v8h14v-8"/>',
  import: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 13v8h14v-8"/>',
  'version-history': '<path d="M6 4h12v16H6z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/>',
  matchups: '<path d="M5 5l14 14"/><path d="M19 5L5 19"/><path d="M4 8l4-4"/><path d="M20 8l-4-4"/>',
  'smart-recs': '<path d="M12 4v16"/><path d="M4 12h16"/><path d="M6.3 6.3l11.4 11.4"/><path d="M17.7 6.3L6.3 17.7"/>',
  'rec-history': '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l4 3"/>',
  edhrec: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M11.4 11.4h1.2v1.2h-1.2z" fill="currentColor" stroke="none"/>',
  repo: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10"/><path d="M18 10a6 6 0 01-6 6H8"/>',
  coach: '<path d="M3 10l9-5 9 5-9 5z"/><path d="M7 12v5c0 1.6 10 1.6 10 0v-5"/>',
  'matchup-strategy': '<path d="M5 5l14 14"/><path d="M19 5L5 19"/><path d="M4 8l4-4"/><path d="M20 8l-4-4"/><path d="M4 16l4 4"/><path d="M20 16l-4 4"/>',
  'deck-solver': '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16"/><path d="M12 4v8"/>',
  'cut-suggestions': '<path d="M6 6l12 12"/><path d="M18 6L6 18"/><circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/>',
  simulation: '<path d="M7 5l12 7-12 7z"/>',

  // ── Header / misc ──
  notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 10h6"/><path d="M9 14h6"/><path d="M9 18h4"/>',
  doctor: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/>',
  compare: '<rect x="4" y="5" width="6" height="14"/><rect x="14" y="5" width="6" height="14"/>',
  decks: '<rect x="4" y="4" width="5" height="16"/><rect x="11" y="4" width="5" height="16"/><path d="M19.5 5l2 14"/>',
  browse: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><ellipse cx="12" cy="12" rx="4" ry="9"/>',
  collab: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15 15.2c.7-.3 1.3-.4 2-.4 2.6 0 4 1.4 4 4.2"/>',
  warning: '<path d="M12 4L2 20h20z"/><path d="M12 10v5"/><path d="M12 17.4v.01"/>',
  classic: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
};

/** Raw inline-SVG markup for `innerHTML` contexts. */
export function svgMarkup(name: string): string {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.grid;
  return (
    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="square" aria-hidden="true">${paths}</svg>`
  );
}

/** Ready-made icon span for DOM-building contexts (h(), appendChild). */
export function lineIcon(name: string, className = 'line-icon'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = svgMarkup(name);
  return span;
}
