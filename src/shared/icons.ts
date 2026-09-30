// ==================== Inline SVG Icon Set ====================
// Replaces emoji icons across the app (editorial redesign).
// Stroke-based, 24px viewBox, 1em sizing, currentColor.

const P: Record<string, string> = {
  cards: '<rect x="3" y="5" width="11" height="15" rx="1.5"/><rect x="10" y="3" width="11" height="15" rx="1.5" transform="rotate(8 15.5 10.5)"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M21 21l-5-5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  'chart-line': '<path d="M3 17l5-6 4 3 6-8"/><path d="M3 21h18"/>',
  pie: '<circle cx="12" cy="12" r="8"/><path d="M12 4v8l6 5"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4M12 13v4m-4 4h8m-6 0v-4h4v4"/>',
  dna: '<path d="M7 3c0 6 10 6 10 9s-10 3-10 9M17 3c0 6-10 6-10 9s10 3 10 9"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/>',
  web: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="17" r="2"/><circle cx="19" cy="17" r="2"/><path d="M11 7 6.5 15m6.5-8 4.5 8M7 17h10"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01"/>',
  lamp: '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><path d="M8 9h.01"/>',
  gauge: '<path d="M4 14a8 8 0 0 1 16 0"/><path d="M12 14 15 9"/><path d="M4 14h0m16 0h0M6 9l.7.7M18 9l-.7.7M12 6v1"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8m-2.5-6.2c0-1 1-1.6 2.5-1.6s2.5.6 2.5 1.5c0 2.2-5 1.4-5 3.6 0 1 1 1.5 2.5 1.5s2.5-.6 2.5-1.5"/>',
  gem: '<path d="M7 4h10l4 5-9 11L3 9z"/><path d="M3 9h18M9.5 9 12 20 14.5 9"/>',
  scale: '<path d="M12 4v16m-7 0h14M12 6l-6 2 6 2 6-2zM4 14a3 3 0 0 0 4 0l-2-6zm12 0a3 3 0 0 0 4 0l-2-6z"/>',
  shield: '<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z"/><path d="M9 12l2 2 4-4"/>',
  book: '<path d="M5 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5z"/><path d="M19 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>',
  export: '<path d="M12 15V3m0 0 4 4m-4-4L8 7"/><path d="M4 13v4a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4"/>',
  import: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 15v2a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-2"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  printer: '<path d="M7 8V4h10v4"/><rect x="4" y="8" width="16" height="8" rx="1.5"/><path d="M7 14h10v6H7z"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 18 5-5 3 3 3-3 3 3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M19.1 4.9 17 7m-10 10-2.1 2.1"/>',
  tools: '<path d="M14 6a4 4 0 0 1 5-4l-3 3 1 2 2 1 3-3a4 4 0 0 1-4 5L8 20a2.4 2.4 0 0 1-4-4z"/>',
  eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
  hand: '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5m0-6a1.5 1.5 0 0 1 3 0v6m0-5a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2.4-4.2A1.5 1.5 0 0 1 7 11.5l1 1.2"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0M9 10h6M9 14h6"/>',
  note: '<path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4M8 9h8M8 13h5"/>',
  package: '<path d="m12 3 8 4v10l-8 4-8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18-3-3.5-3-14.5 0-18z"/>',
  warn: '<path d="M12 3 2 21h20z"/><path d="M12 9v5m0 3h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  x: '<path d="M5 5l14 14M19 5 5 19"/>',
  'thumbs-up': '<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a1.8 1.8 0 0 1 1.8 2.2l-1.2 6A2 2 0 0 1 17.6 20H7"/>',
  'thumbs-down': '<path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-2-2v-4H5a1.8 1.8 0 0 1-1.8-2.2l1.2-6A2 2 0 0 1 6.4 4H17"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  sword: '<path d="m4 20 4-1 11-11-3-3L5 16z"/><path d="M14 4l6 6M3 21l1-1"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5"/>',
  salt: '<path d="M9 8h6l2 13H7z"/><path d="M10 8V5a2 2 0 0 1 4 0v3M10.5 3h3M11 12h.01M13 15h.01M11.5 18h.01"/>',
  mask: '<path d="M4 5c3 1.5 13 1.5 16 0v7a8 8 0 0 1-16 0z"/><path d="M8.5 10h.01M15.5 10h.01M9 15a4 2.4 0 0 0 6 0"/>',
  flask: '<path d="M10 3h4m-3 0v6L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19L13 9V3"/><path d="M8 15h8"/>',
  infinity: '<path d="M8 12c-4 4.5-6-1-3.5-3S10 10 12 12s5 5 7.5 3S16 7.5 12 12c-1.5 1.6-2.7 2.7-4 0z" transform="translate(0 0)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

export type IconName = keyof typeof P & string;

export function iconSvg(name: string, cls = 'ui-ic'): string {
  const path = P[name] || P.sparkle;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/** Returns a <span> carrying the inline SVG (for h()/append use). */
export function iconEl(name: string, cls = 'ui-ic-wrap'): HTMLElement {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = iconSvg(name);
  return span;
}
