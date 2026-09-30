// ==================== Playmat Drawers ====================
// Floating action buttons (Analyse · Goldfish · Teilen · Import) plus the
// sortbar HUD. Reuses the deckbuilder analyse/export/import libraries;
// only the small curve/color tally lives here.

import { iconSvg } from '../shared/icons.js';
import { showToast } from '../deckbuilder/toast.js';
import { renderHealthScore, calculateDeckHealth } from '../deckbuilder/health-score.js';
import { renderSynergyMap } from '../deckbuilder/synergy-map.js';
import { renderDrawProbability } from '../deckbuilder/draw-probability.js';
import { evaluateEdhRules } from '../deckbuilder/edh-rules.js';
import { getFormatRules } from '../deckbuilder/live-validation.js';
import { classifyRole, ROLE_PROB_KEYS } from '../deckbuilder/role-classifier.js';
import { openGoldfishPlaytest } from '../deckbuilder/goldfish.js';
import { serializeDeckForExport, type DeckExportFormat } from '../shared/deck-export.js';
import { generateShareUrl } from '../shared/deck-sharing.js';
import { generatePrintHTML } from '../shared/features/print-proxy.js';
import { downloadDeckImage } from '../deckbuilder/deck-image.js';
import {
  parseDeckbuilderImportText,
  resolveParsedImportLines,
  toBoardsFromResolvedImport,
  mergeBoards,
  type ImportResolvedLine,
} from '../deckbuilder/import-resolver.js';
import { resolveDeckbuilderCards, fetchDeckbuilderAutocomplete } from '../shared/scryfall-client.js';
import type { DeckbuilderImportUnresolved } from '../deckbuilder/types.js';
import type { DeckEntry } from '../shared/types.js';
import {
  EV_DECK_CHANGED, EV_CARDS_RESOLVED, EV_SORT_CHANGED, mutateDeck, resolveMissing,
  normalizeNameKey, isTypingContext, type PlaymatState,
} from './state.js';
import { isDragging } from './drag.js';
import { listVersions, saveVersion, deleteVersion, diffBoards, type DeckVersion } from './versions.js';
import { simulateHands, type SimCard } from './handstats.js';
import { showPromptModal, showConfirmModal } from '../deckbuilder/confirm-modal.js';

type DrawerKind = 'analyse' | 'share' | 'import' | 'history';

let stateRef: PlaymatState;
let drawerEl: HTMLElement;
let openDrawer: DrawerKind | null = null;
let unresolvedRows: DeckbuilderImportUnresolved[] = [];
let importDraft = '';

// ── small local tallies ──

const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'] as const;
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'] as const;
const COLOR_HEX: Record<string, string> = {
  W: '#e8e2c8', U: '#5a8fc0', B: '#8a7a96', R: '#d06a4a', G: '#6a9a6a',
};

function curveTally(state: PlaymatState): number[] {
  const buckets = new Array(CURVE_BUCKETS.length).fill(0);
  for (const entry of state.deck.boards.mainboard) {
    const card = state.cardByName[normalizeNameKey(entry.name)];
    if (!card || (card.type_line || '').toLowerCase().includes('land')) continue;
    const slot = Math.min(Math.max(Math.round(card.cmc), 0), 7);
    buckets[slot] += entry.qty;
  }
  return buckets;
}

function colorTally(state: PlaymatState): Record<string, number> {
  const counts: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const entry of state.deck.boards.mainboard) {
    const card = state.cardByName[normalizeNameKey(entry.name)];
    for (const c of card?.color_identity || []) {
      if (c in counts) counts[c] += entry.qty;
    }
  }
  return counts;
}

function deckStats(state: PlaymatState): { total: number; avgMv: number; lands: number } {
  let total = 0;
  let lands = 0;
  let mvSum = 0;
  let mvCount = 0;
  for (const entry of state.deck.boards.mainboard) {
    total += entry.qty;
    const card = state.cardByName[normalizeNameKey(entry.name)];
    if (!card) continue;
    if ((card.type_line || '').toLowerCase().includes('land')) {
      lands += entry.qty;
    } else {
      mvSum += card.cmc * entry.qty;
      mvCount += entry.qty;
    }
  }
  return { total, avgMv: mvCount > 0 ? mvSum / mvCount : 0, lands };
}

function roleTagTally(state: PlaymatState): Record<string, number> {
  const tags: Record<string, number> = {};
  for (const entry of state.deck.boards.mainboard) {
    const card = state.cardByName[normalizeNameKey(entry.name)];
    if (!card) continue;
    const label = ROLE_PROB_KEYS[classifyRole(card)];
    tags[label] = (tags[label] || 0) + entry.qty;
  }
  return tags;
}

function toExportEntries(entries: Array<{ name: string; qty: number; set?: string | null; collectorNumber?: string | null }>): DeckEntry[] {
  return entries.map((e) => ({ name: e.name, qty: e.qty, set: e.set ?? null, num: e.collectorNumber ?? null }));
}

// ── drawer shell ──

function closeDrawer(): void {
  openDrawer = null;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  drawerEl.textContent = '';
  document.querySelectorAll('.pm-action-btn.active').forEach((b) => b.classList.remove('active'));
}

function openDrawerPanel(kind: DrawerKind): void {
  if (openDrawer === kind) { closeDrawer(); return; }
  closeDrawer();
  openDrawer = kind;
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  document.querySelector(`.pm-action-btn[data-drawer="${kind}"]`)?.classList.add('active');

  const titles: Record<DrawerKind, string> = { analyse: 'Analytics', share: 'Share & Export', import: 'Import', history: 'Versions' };
  const head = document.createElement('div');
  head.className = 'pm-drawer-head';
  head.innerHTML = `<h2>${titles[kind]}</h2>`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pm-drawer-close';
  close.innerHTML = iconSvg('x');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeDrawer);
  head.appendChild(close);

  const body = document.createElement('div');
  body.className = 'pm-drawer-body';
  drawerEl.append(head, body);

  if (kind === 'analyse') renderAnalyse(body);
  else if (kind === 'share') renderShare(body);
  else if (kind === 'history') renderHistory(body);
  else renderImport(body);
}

// ── Analyse ──

function renderAnalyse(body: HTMLElement): void {
  const stats = deckStats(stateRef);

  const cards = document.createElement('div');
  cards.className = 'pm-stat-cards';
  const statCard = (label: string, value: string): string =>
    `<div class="pm-stat-card"><span class="pm-stat-value">${value}</span><span class="pm-stat-label">${label}</span></div>`;
  cards.innerHTML =
    statCard('Cards', String(stats.total)) +
    statCard('Avg Mana Value', stats.avgMv.toFixed(1)) +
    statCard('Lands', String(stats.lands));
  body.appendChild(cards);

  // Curve
  const curve = curveTally(stateRef);
  const maxCurve = Math.max(...curve, 1);
  const curveBox = document.createElement('div');
  curveBox.className = 'pm-analyse-section';
  curveBox.innerHTML = '<h3>Mana Curve</h3>';
  const bars = document.createElement('div');
  bars.className = 'pm-curve';
  curve.forEach((count, i) => {
    const col = document.createElement('div');
    col.className = 'pm-curve-col';
    col.innerHTML = `
      <span class="pm-curve-count">${count || ''}</span>
      <div class="pm-curve-bar" style="height:${Math.round((count / maxCurve) * 72)}px"></div>
      <span class="pm-curve-mv">${CURVE_BUCKETS[i]}</span>`;
    bars.appendChild(col);
  });
  curveBox.appendChild(bars);
  body.appendChild(curveBox);

  // Colors
  const colors = colorTally(stateRef);
  const colorTotal = COLOR_ORDER.reduce((s, c) => s + colors[c], 0);
  const colorBox = document.createElement('div');
  colorBox.className = 'pm-analyse-section';
  colorBox.innerHTML = '<h3>Colors</h3>';
  const dots = document.createElement('div');
  dots.className = 'pm-colors';
  for (const c of COLOR_ORDER) {
    if (colors[c] === 0) continue;
    const pct = colorTotal > 0 ? Math.round((colors[c] / colorTotal) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'pm-color-row';
    row.innerHTML = `
      <span class="pm-color-dot" style="background:${COLOR_HEX[c]}"></span>
      <span class="pm-color-name">${c}</span>
      <div class="pm-color-track"><div class="pm-color-fill" style="width:${pct}%;background:${COLOR_HEX[c]}"></div></div>
      <span class="pm-color-pct">${pct}%</span>`;
    dots.appendChild(row);
  }
  if (colorTotal === 0) dots.innerHTML = '<span class="pm-muted">No color data yet.</span>';
  colorBox.appendChild(dots);
  body.appendChild(colorBox);

  // Health
  const healthBox = document.createElement('div');
  healthBox.className = 'pm-analyse-section';
  healthBox.innerHTML = '<h3>Deck Health</h3>';
  const healthHost = document.createElement('div');
  renderHealthScore(healthHost, stateRef.deck, stateRef.cardByName);
  healthBox.appendChild(healthHost);
  body.appendChild(healthBox);

  // Bracket / Game Changers (commander decks)
  if ((stateRef.deck.format || 'commander') === 'commander') {
    body.appendChild(bracketSection());
  }

  // Opening hand simulation
  const handsBox = document.createElement('div');
  handsBox.className = 'pm-analyse-section';
  handsBox.innerHTML = '<h3>Opening Hands</h3>';
  const handsHost = document.createElement('div');
  const simBtn = document.createElement('button');
  simBtn.type = 'button';
  simBtn.className = 'pm-btn';
  simBtn.innerHTML = `${iconSvg('dice')} Simulate 1,000 hands`;
  simBtn.addEventListener('click', () => {
    const library: SimCard[] = [];
    for (const entry of stateRef.deck.boards.mainboard) {
      const card = stateRef.cardByName[normalizeNameKey(entry.name)];
      const isLand = (card?.type_line || '').toLowerCase().includes('land');
      for (let i = 0; i < entry.qty; i++) library.push({ isLand, mv: card?.cmc ?? 0 });
    }
    const stats = simulateHands(library, 1000);
    if (stats.hands === 0) {
      handsHost.innerHTML = '<span class="pm-muted">Deck needs at least 7 mainboard cards.</span>';
      return;
    }
    const maxH = Math.max(...stats.landHist, 1);
    handsHost.innerHTML = `
      <div class="pm-handstats-row"><span>2–4 lands</span><strong>${stats.pct2to4}%</strong>
        <span>Avg lands</span><strong>${stats.avgLands}</strong>
        <span>Avg MV</span><strong>${stats.avgMv}</strong></div>
      <div class="pm-curve">${stats.landHist.map((count, lands) => `
        <div class="pm-curve-col">
          <span class="pm-curve-count">${count ? Math.round((count / stats.hands) * 100) + '%' : ''}</span>
          <div class="pm-curve-bar" style="height:${Math.round((count / maxH) * 60)}px"></div>
          <span class="pm-curve-mv">${lands}</span>
        </div>`).join('')}</div>
      <div class="pm-muted" style="font-size:0.66rem">Lands per 7-card opening hand, ${stats.hands} shuffles.</div>`;
  });
  handsBox.append(simBtn, handsHost);
  body.appendChild(handsBox);

  // Mehr: synergy map + draw probability
  const more = document.createElement('details');
  more.className = 'pm-analyse-more';
  more.innerHTML = '<summary>More analytics</summary>';
  const moreBody = document.createElement('div');
  more.appendChild(moreBody);
  let moreRendered = false;
  more.addEventListener('toggle', () => {
    if (!more.open || moreRendered) return;
    moreRendered = true;
    const syn = document.createElement('div');
    syn.className = 'pm-analyse-section';
    syn.innerHTML = '<h3>Synergies</h3>';
    const synHost = document.createElement('div');
    renderSynergyMap(synHost, stateRef.deck, stateRef.cardByName);
    syn.appendChild(synHost);
    const draw = document.createElement('div');
    draw.className = 'pm-analyse-section';
    draw.innerHTML = '<h3>Draw Probability</h3>';
    const drawHost = document.createElement('div');
    renderDrawProbability(drawHost, roleTagTally(stateRef), deckStats(stateRef).total, stateRef.deck.boards.mainboard);
    draw.appendChild(drawHost);
    moreBody.append(syn, draw);
  });
  body.appendChild(more);
}

// ── Bracket / Game Changers ──

function bracketOverrideKey(): string {
  return `dl_pm_bracket_${stateRef.deck.id}`;
}

function bracketSection(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'pm-analyse-section';
  box.innerHTML = '<h3>Commander Bracket</h3>';

  // sideboard/maybeboard deliberately ignored per bracket rules
  const gameChangers: Array<{ name: string; qty: number }> = [];
  for (const entry of [...stateRef.deck.boards.commander, ...stateRef.deck.boards.mainboard]) {
    const card = stateRef.cardByName[normalizeNameKey(entry.name)];
    if (card?.game_changer) gameChangers.push({ name: entry.name, qty: entry.qty });
  }
  const gcCount = gameChangers.reduce((s, e) => s + e.qty, 0);

  const estimate = gcCount === 0 ? '1–2' : gcCount <= 3 ? '3' : '4–5';
  const reason = gcCount === 0
    ? 'No Game Changers in commander or mainboard.'
    : `${gcCount} Game Changer${gcCount === 1 ? '' : 's'} (bracket 3 allows up to 3, brackets 1–2 none).`;

  const override = localStorage.getItem(bracketOverrideKey()) || '';

  const row = document.createElement('div');
  row.className = 'pm-bracket-row';
  row.innerHTML = `
    <span class="pm-bracket-num">${override || estimate}</span>
    <span class="pm-bracket-why">${override ? `Manually set (auto estimate: ${estimate}).` : reason}
      <em>Brackets measure intent too — treat this as a starting point.</em></span>`;
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Bracket override');
  select.innerHTML = '<option value="">Auto</option>' +
    [1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${override === String(n) ? 'selected' : ''}>${n}</option>`).join('');
  select.addEventListener('change', () => {
    if (select.value) localStorage.setItem(bracketOverrideKey(), select.value);
    else localStorage.removeItem(bracketOverrideKey());
    const body = drawerEl.querySelector<HTMLElement>('.pm-drawer-body');
    if (body) { body.textContent = ''; renderAnalyse(body); }
  });
  row.appendChild(select);
  box.appendChild(row);

  if (gameChangers.length > 0) {
    const list = document.createElement('div');
    list.className = 'pm-gc-list';
    list.innerHTML = gameChangers
      .map((e) => `<span class="pm-gc-chip">${iconSvg('bolt')} ${e.qty > 1 ? `${e.qty}× ` : ''}${e.name.replace(/</g, '&lt;')}</span>`)
      .join('');
    box.appendChild(list);
  }
  return box;
}

// ── Teilen ──

function currentExportText(format: DeckExportFormat): string {
  const b = stateRef.deck.boards;
  return serializeDeckForExport(
    { main: toExportEntries(b.mainboard), sideboard: toExportEntries(b.sideboard), commander: toExportEntries(b.commander) },
    { format, deckName: stateRef.deck.name },
  );
}

async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ message: okMessage, type: 'success', duration: 1800 });
  } catch {
    showToast({ message: 'Copy failed — please select the text manually.', type: 'error' });
  }
}

function renderShare(body: HTMLElement): void {
  body.innerHTML = `
    <div class="pm-share-row">
      <label for="pmExportFormat">Format</label>
      <select id="pmExportFormat">
        <option value="text">Text</option>
        <option value="arena">Arena</option>
        <option value="mtgo">MTGO</option>
        <option value="moxfield">Moxfield</option>
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
      </select>
    </div>
    <textarea id="pmExportText" class="pm-export-text" readonly rows="14" aria-label="Deck export"></textarea>
    <div class="pm-share-actions">
      <button type="button" id="pmCopyExport" class="pm-btn">${iconSvg('clipboard')} Copy</button>
      <button type="button" id="pmShareLink" class="pm-btn">${iconSvg('link')} Share link</button>
      <button type="button" id="pmDeckImage" class="pm-btn">${iconSvg('image')} Image (PNG)</button>
      <button type="button" id="pmPrintProxies" class="pm-btn">${iconSvg('printer')} Print proxies</button>
      <button type="button" id="pmPrintList" class="pm-btn">${iconSvg('list')} Print list</button>
    </div>`;

  const select = body.querySelector<HTMLSelectElement>('#pmExportFormat')!;
  const textarea = body.querySelector<HTMLTextAreaElement>('#pmExportText')!;
  const refresh = (): void => { textarea.value = currentExportText(select.value as DeckExportFormat); };
  select.addEventListener('change', refresh);
  refresh();

  body.querySelector('#pmCopyExport')!.addEventListener('click', () => {
    void copyText(textarea.value, 'Deck list copied.');
  });

  body.querySelector('#pmShareLink')!.addEventListener('click', () => {
    const b = stateRef.deck.boards;
    try {
      const result = generateShareUrl({
        name: stateRef.deck.name,
        main: toExportEntries(b.mainboard),
        sideboard: toExportEntries(b.sideboard),
        commander: toExportEntries(b.commander),
      }, 'mtg');
      void copyText(result.url, 'Share link copied.');
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'Could not create share link.', type: 'error' });
    }
  });

  body.querySelector('#pmDeckImage')!.addEventListener('click', () => {
    showToast({ message: 'Creating image …', type: 'info', duration: 1500 });
    downloadDeckImage(stateRef.deck, stateRef.cardByName).catch((err) => {
      showToast({ message: err instanceof Error ? err.message : 'Image export failed.', type: 'error' });
    });
  });

  body.querySelector('#pmPrintList')!.addEventListener('click', () => {
    const win = window.open('', '_blank');
    if (!win) {
      showToast({ message: 'Popup blocked — please allow popups.', type: 'error' });
      return;
    }
    win.document.write(printableListHTML());
    win.document.close();
  });

  body.querySelector('#pmPrintProxies')!.addEventListener('click', () => {
    const b = stateRef.deck.boards;
    const entries = [...b.commander, ...b.mainboard].map((e) => ({
      name: e.name,
      qty: e.qty,
      imageUrl: stateRef.cardByName[normalizeNameKey(e.name)]?.image_uris?.normal,
    }));
    if (entries.length === 0) {
      showToast({ message: 'No cards to print.', type: 'info' });
      return;
    }
    const win = window.open('', '_blank');
    if (!win) {
      showToast({ message: 'Popup blocked — please allow popups.', type: 'error' });
      return;
    }
    win.document.write(generatePrintHTML(entries, { showNames: true }));
    win.document.close();
  });
}

function printableListHTML(): string {
  const b = stateRef.deck.boards;
  const typeOf = (name: string): string => {
    const t = (stateRef.cardByName[normalizeNameKey(name)]?.type_line || '').toLowerCase();
    for (const [key, label] of [
      ['land', 'Lands'], ['creature', 'Creatures'], ['planeswalker', 'Planeswalkers'],
      ['instant', 'Instants'], ['sorcery', 'Sorceries'], ['enchantment', 'Enchantments'],
      ['artifact', 'Artifacts'], ['battle', 'Battles'],
    ] as const) {
      if (t.includes(key)) return label;
    }
    return 'Other';
  };
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const line = (e: { name: string; qty: number; set?: string | null; collectorNumber?: string | null }): string => {
    const card = stateRef.cardByName[normalizeNameKey(e.name)];
    const set = e.set || card?.set;
    const num = e.collectorNumber || card?.collector_number;
    return `<li><span class="box"></span>${e.qty} ${esc(e.name)}${set ? ` <em>${set.toUpperCase()}${num ? ` #${num}` : ''}</em>` : ''}</li>`;
  };
  const section = (title: string, entries: typeof b.mainboard): string => {
    if (entries.length === 0) return '';
    return `<h2>${title} (${entries.reduce((s, e) => s + e.qty, 0)})</h2><ul>${entries.map(line).join('')}</ul>`;
  };
  const groups = new Map<string, typeof b.mainboard>();
  for (const e of [...b.mainboard].sort((x, y) => x.name.localeCompare(y.name))) {
    const g = typeOf(e.name);
    groups.set(g, [...(groups.get(g) || []), e]);
  }
  const order = ['Creatures', 'Planeswalkers', 'Instants', 'Sorceries', 'Enchantments', 'Artifacts', 'Battles', 'Other', 'Lands'];
  const mainSections = order.filter((g) => groups.has(g)).map((g) => section(g, groups.get(g)!)).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(stateRef.deck.name)} — deck list</title>
    <style>
      body { font: 13px/1.5 Georgia, serif; color: #111; margin: 32px; }
      h1 { font-size: 20px; margin: 0 0 2px; } .sub { color: #666; font-size: 11px; margin-bottom: 18px; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #bbb; padding-bottom: 3px; margin: 16px 0 6px; }
      ul { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 32px; }
      li { break-inside: avoid; padding: 1px 0; }
      .box { display: inline-block; width: 9px; height: 9px; border: 1px solid #888; margin-right: 7px; }
      em { color: #777; font-style: normal; font-size: 11px; }
      @media print { body { margin: 12mm; } }
    </style></head><body>
    <h1>${esc(stateRef.deck.name)}</h1>
    <div class="sub">${(stateRef.deck.format || 'commander').toUpperCase()} · ${new Date().toLocaleDateString()} · checkboxes for assembling the paper deck</div>
    ${section('Commander', b.commander)}
    ${mainSections}
    ${section('Sideboard', b.sideboard)}
    ${section('Maybeboard', b.maybeboard)}
    </body></html>`;
}

// ── Import ──

function renderImport(body: HTMLElement): void {
  body.innerHTML = `
    <p class="pm-muted">One card per line, e.g. <code>1 Sol Ring</code>. Section headers like <code>Commander:</code> or <code>Sideboard:</code> are recognized.</p>
    <textarea id="pmImportText" class="pm-import-text" rows="12" placeholder="4 Lightning Bolt&#10;1 Sol Ring&#10;Sideboard:&#10;2 Negate"></textarea>
    <div class="pm-share-actions">
      <label class="pm-btn pm-file-btn">${iconSvg('file')} Load file
        <input type="file" id="pmImportFile" accept=".txt,.dec,.dek,.csv" hidden>
      </label>
      <button type="button" id="pmImportRun" class="pm-btn pm-btn-primary">${iconSvg('import')} Import</button>
    </div>
    <div id="pmImportUnresolved" class="pm-import-unresolved"></div>`;

  const textarea = body.querySelector<HTMLTextAreaElement>('#pmImportText')!;
  const fileInput = body.querySelector<HTMLInputElement>('#pmImportFile')!;

  // keep the typed list across drawer closes
  textarea.value = importDraft;
  textarea.addEventListener('input', () => { importDraft = textarea.value; });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => { textarea.value = text; importDraft = text; });
  });
  textarea.addEventListener('dragover', (e) => e.preventDefault());
  textarea.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    void file.text().then((text) => { textarea.value = text; importDraft = text; });
  });

  body.querySelector('#pmImportRun')!.addEventListener('click', () => {
    void runImport(textarea.value);
  });
}

async function runImport(raw: string): Promise<void> {
  const parsed = parseDeckbuilderImportText(raw);
  if (parsed.errors.length > 0) {
    showToast({ message: parsed.errors.slice(0, 3).join(' | '), type: 'error' });
  }
  if (parsed.lines.length === 0) {
    showToast({ message: 'No import lines found.', type: 'info' });
    return;
  }

  const names = Array.from(new Set(parsed.lines.map((line) => line.name)));
  let resolvedResponse: Awaited<ReturnType<typeof resolveDeckbuilderCards>>;
  try {
    resolvedResponse = await resolveDeckbuilderCards(names);
  } catch (error) {
    showToast({
      message: error instanceof Error ? error.message : 'Could not load card data.',
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const suggestionsByName: Record<string, string[]> = {};
  for (const missing of resolvedResponse.missing.slice(0, 20)) {
    try {
      const suggestions = await fetchDeckbuilderAutocomplete(missing);
      suggestionsByName[normalizeNameKey(missing)] = suggestions.slice(0, 8);
    } catch {
      suggestionsByName[normalizeNameKey(missing)] = [];
    }
  }

  const resolution = resolveParsedImportLines({
    lines: parsed.lines,
    resolvedByName: resolvedResponse.resolved,
    suggestionsByName,
  });

  for (const [apiKey, value] of Object.entries(resolvedResponse.resolved)) {
    stateRef.cardByName[normalizeNameKey(apiKey)] = value;
  }

  if (resolution.resolved.length > 0) {
    mutateDeck(stateRef, (d) => {
      d.boards = mergeBoards(d.boards, toBoardsFromResolvedImport(resolution.resolved));
    });
    void resolveMissing(stateRef);
  }

  unresolvedRows = resolution.unresolved;
  renderUnresolvedRows();
  showToast({
    message: `${resolution.resolved.length} lines imported${resolution.unresolved.length > 0 ? `, ${resolution.unresolved.length} unresolved` : ''}.`,
    type: resolution.unresolved.length > 0 ? 'info' : 'success',
  });
}

function renderUnresolvedRows(): void {
  const container = document.getElementById('pmImportUnresolved');
  if (!container) return;
  container.textContent = '';
  if (unresolvedRows.length === 0) return;

  const head = document.createElement('h3');
  head.textContent = `Unresolved (${unresolvedRows.length})`;
  container.appendChild(head);

  for (const row of unresolvedRows) {
    const box = document.createElement('div');
    box.className = 'pm-unresolved-row';
    const label = document.createElement('span');
    label.textContent = `${row.qty}× ${row.name}`;
    const select = document.createElement('select');
    select.dataset.lineNumber = String(row.lineNumber);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = row.reason === 'missing' ? 'No match' : 'Choose a card';
    select.appendChild(empty);
    for (const candidate of row.candidates) {
      const option = document.createElement('option');
      option.value = candidate;
      option.textContent = candidate;
      select.appendChild(option);
    }
    box.append(label, select);
    container.appendChild(box);
  }

  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'pm-btn pm-btn-primary';
  apply.textContent = 'Apply selection';
  apply.addEventListener('click', applyUnresolvedSelection);
  container.appendChild(apply);
}

function applyUnresolvedSelection(): void {
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('#pmImportUnresolved select[data-line-number]'));
  const chosen: ImportResolvedLine[] = [];
  const remaining: DeckbuilderImportUnresolved[] = [];

  for (const row of unresolvedRows) {
    const select = selects.find((item) => item.dataset.lineNumber === String(row.lineNumber));
    const selected = select?.value.trim() || '';
    if (!selected) {
      remaining.push(row);
      continue;
    }
    chosen.push({
      lineNumber: row.lineNumber,
      board: row.board,
      qty: row.qty,
      originalName: row.name,
      resolvedName: selected,
    });
  }

  if (chosen.length > 0) {
    mutateDeck(stateRef, (d) => {
      d.boards = mergeBoards(d.boards, toBoardsFromResolvedImport(chosen));
    });
    void resolveMissing(stateRef);
  }
  unresolvedRows = remaining;
  renderUnresolvedRows();
}

// ── Versions ──

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function diffList(entries: Array<{ name: string; qty: number; board: string }>, sign: string, cls: string): string {
  return entries.map((e) =>
    `<div class="pm-ver-diffrow ${cls}">${sign}${e.qty} ${e.name.replace(/</g, '&lt;')}${e.board !== 'mainboard' ? ` <em>(${e.board})</em>` : ''}</div>`,
  ).join('');
}

function renderHistory(body: HTMLElement): void {
  body.innerHTML = '';

  const saveRow = document.createElement('div');
  saveRow.className = 'pm-share-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'pm-btn pm-btn-primary';
  saveBtn.innerHTML = `${iconSvg('save')} Save version`;
  saveBtn.addEventListener('click', async () => {
    const label = await showPromptModal({
      title: 'Save version',
      message: 'Label for this version:',
      placeholder: 'e.g. Before ramp rework',
    });
    if (label === null) return;
    const saved = saveVersion(stateRef.deck, label || 'Snapshot');
    showToast(saved
      ? { message: `Version "${saved.label}" saved.`, type: 'success' }
      : { message: 'No changes since the newest version.', type: 'info' });
    renderHistory(body);
  });
  saveRow.appendChild(saveBtn);
  body.appendChild(saveRow);

  const versions = listVersions(stateRef.deck.id);
  if (versions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pm-muted';
    empty.textContent = 'No versions yet. One is saved automatically with your first change each session — or save one manually above.';
    body.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'pm-ver-list';
  for (const version of versions) {
    list.appendChild(versionRow(version, body));
  }
  body.appendChild(list);
}

function versionRow(version: DeckVersion, drawerBody: HTMLElement): HTMLElement {
  const diff = diffBoards(version.boards, stateRef.deck.boards);
  const changes = diff.added.length + diff.removed.length;

  const row = document.createElement('details');
  row.className = 'pm-ver';
  const addedN = diff.added.reduce((s, e) => s + e.qty, 0);
  const removedN = diff.removed.reduce((s, e) => s + e.qty, 0);
  row.innerHTML = `
    <summary>
      <span class="pm-ver-label">${version.label.replace(/</g, '&lt;')}</span>
      <span class="pm-ver-meta">${fmtTime(version.ts)} · ${version.total} cards</span>
      <span class="pm-ver-delta">${changes === 0 ? '= current' : `+${addedN} / −${removedN}`}</span>
    </summary>`;

  const detail = document.createElement('div');
  detail.className = 'pm-ver-detail';
  if (changes === 0) {
    detail.innerHTML = '<span class="pm-muted">Identical to the current deck.</span>';
  } else {
    detail.innerHTML = `
      <div class="pm-ver-diffhead">To get from this version to the current deck:</div>
      ${diffList(diff.added, '+', 'add')}
      ${diffList(diff.removed, '−', 'rem')}`;
  }

  const actions = document.createElement('div');
  actions.className = 'pm-share-actions';
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'pm-btn';
  restore.textContent = 'Restore';
  restore.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Restore version?',
      message: `The deck will be set back to "${version.label}" (${fmtTime(version.ts)}). The current state is saved as a version first.`,
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    saveVersion(stateRef.deck, 'Before restore');
    mutateDeck(stateRef, (d) => {
      d.boards = JSON.parse(JSON.stringify(version.boards));
    });
    void resolveMissing(stateRef);
    showToast({ message: `Restored "${version.label}".`, type: 'success' });
    renderHistory(drawerBody);
  });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'pm-btn';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    const ok = await showConfirmModal({
      title: 'Delete version?',
      message: `"${version.label}" (${fmtTime(version.ts)}) will be removed permanently.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    deleteVersion(stateRef.deck.id, version.id);
    renderHistory(drawerBody);
  });
  actions.append(restore, del);
  detail.appendChild(actions);
  row.appendChild(detail);
  return row;
}

// ── HUD ──

function renderHud(): void {
  const hud = document.getElementById('pmHud');
  if (!hud) return;
  const stats = deckStats(stateRef);
  const health = calculateDeckHealth(stateRef.deck, stateRef.cardByName);

  let legalityText: string;
  let legalityOk: boolean;
  const format = stateRef.deck.format || 'commander';
  if (format === 'commander') {
    const result = evaluateEdhRules(stateRef.deck, stateRef.cardByName);
    const errors = result.issues.filter((i) => i.severity === 'error');
    legalityOk = errors.length === 0;
    legalityText = legalityOk ? 'Legal' : `${errors.length} rule issue${errors.length === 1 ? '' : 's'}`;
  } else if (format !== 'none') {
    const rules = getFormatRules(format);
    legalityOk = stats.total >= rules.minDeckSize;
    legalityText = legalityOk ? 'Legal' : `Min. ${rules.minDeckSize} cards`;
  } else {
    legalityOk = true;
    legalityText = 'Open';
  }

  hud.innerHTML = `
    <span class="pm-hud-item">Health <strong>${health.total}</strong></span>
    <span class="pm-hud-item">Avg MV <strong>${stats.avgMv.toFixed(1)}</strong></span>
    <span class="pm-hud-item">Lands <strong>${stats.lands}</strong></span>
    <span class="pm-hud-item ${legalityOk ? 'pm-hud-ok' : 'pm-hud-warn'}">${legalityOk ? iconSvg('check') : iconSvg('warn')} ${legalityText}</span>`;
  hud.title = 'Click to open analytics';
}

// ── init ──

export function initDrawers(state: PlaymatState): void {
  stateRef = state;
  drawerEl = document.getElementById('pmDrawer')!;

  const actions = document.getElementById('pmActions')!;
  actions.textContent = '';
  const actionBtn = (kind: string, icon: string, label: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pm-action-btn';
    btn.dataset.drawer = kind;
    btn.innerHTML = `${iconSvg(icon)}<span>${label}</span>`;
    return btn;
  };

  const analyseBtn = actionBtn('analyse', 'chart', 'Analytics');
  analyseBtn.addEventListener('click', () => openDrawerPanel('analyse'));
  const goldfishBtn = actionBtn('goldfish', 'dice', 'Goldfish');
  goldfishBtn.addEventListener('click', () => openGoldfishPlaytest(state.deck, state.cardByName));
  const shareBtn = actionBtn('share', 'export', 'Share');
  shareBtn.addEventListener('click', () => openDrawerPanel('share'));
  const importBtn = actionBtn('import', 'import', 'Import');
  importBtn.addEventListener('click', () => openDrawerPanel('import'));
  const historyBtn = actionBtn('history', 'save', 'Versions');
  historyBtn.addEventListener('click', () => openDrawerPanel('history'));
  actions.append(analyseBtn, goldfishBtn, historyBtn, shareBtn, importBtn);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openDrawer) return;
    if (isDragging()) return; // the drag controller owns this Escape
    if (isTypingContext(e.target)) {
      (e.target as HTMLElement).blur(); // first Escape leaves the field
      return;
    }
    closeDrawer();
  });

  // #pmHud is re-created by every sortbar render — delegate the click.
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest?.('#pmHud')) openDrawerPanel('analyse');
  });

  const refresh = (): void => {
    renderHud();
    if (openDrawer === 'analyse') {
      const body = drawerEl.querySelector<HTMLElement>('.pm-drawer-body');
      if (body) { body.textContent = ''; renderAnalyse(body); }
    }
  };
  document.addEventListener(EV_DECK_CHANGED, refresh);
  document.addEventListener(EV_CARDS_RESOLVED, refresh);
  document.addEventListener(EV_SORT_CHANGED, refresh);
  renderHud();
}
