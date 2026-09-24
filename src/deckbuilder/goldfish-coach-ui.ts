/**
 * Deck Coach UI — Panel rendering + SVG combo lines overlay + role badges.
 *
 * Renders the coach panel inside the Goldfish side panel,
 * draws Bezier curves between related cards across zones,
 * and provides role badge elements for battlefield cards.
 */

import type {
  DeckCoach, CoachHint, CoachGameState, CardRole, RelEdge, FlowStepStatus, CardFlowStatus, ComboPiece,
} from './goldfish-coach.js';
import { getPrimaryRole, savePrefs, onCoachStateChange, computeFlowStatus } from './goldfish-coach.js';
import { submitComboSuggestion } from './combo-client.js';
import { showSuggestComboModal } from './combo-suggest.js';
import { openComboTree } from './combo-tree.js';

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const ROLE_DISPLAY: Record<CardRole, { label: string; cls: string }> = {
  'combo-piece': { label: 'COMBO', cls: 'gf-role-combo' },
  'payoff': { label: 'WIN', cls: 'gf-role-payoff' },
  'engine': { label: 'ENGINE', cls: 'gf-role-engine' },
  'setup': { label: 'TUTOR', cls: 'gf-role-setup' },
  'ramp': { label: 'RAMP', cls: 'gf-role-ramp' },
  'draw': { label: 'DRAW', cls: 'gf-role-draw' },
  'removal': { label: 'REMOVE', cls: 'gf-role-removal' },
  'protection': { label: 'SHIELD', cls: 'gf-role-protect' },
  'land': { label: 'LAND', cls: '' },
};

const HINT_MAX_VISIBLE = 3;
const MAX_LINES = 12;
const HOVER_DEBOUNCE = 80;

// ── Combo Source Badges ──

const SOURCE_BADGE: Record<string, { label: string; cls: string; title: string }> = {
  spellbook: { label: 'CS', cls: 'gf-badge-spellbook', title: 'Commander Spellbook' },
  catalog: { label: 'DL', cls: 'gf-badge-catalog', title: 'DeckLens Catalog' },
  community: { label: 'COM', cls: 'gf-badge-community', title: 'Community Contributed' },
};

function createSourceBadge(source?: string): HTMLElement | null {
  const cfg = source ? SOURCE_BADGE[source] : null;
  if (!cfg) return null;
  const badge = document.createElement('span');
  badge.className = `gf-combo-badge ${cfg.cls}`;
  badge.textContent = cfg.label;
  badge.title = cfg.title;
  return badge;
}

function createMatchLevelBadge(matchLevel?: string): HTMLElement | null {
  if (matchLevel === 'near-miss') {
    const badge = document.createElement('span');
    badge.className = 'gf-combo-badge gf-badge-near-miss';
    badge.textContent = '1 AWAY';
    badge.title = 'One card away from completing this combo';
    return badge;
  }
  return null;
}

function createTemplateReqBadge(hasTemplateReqs?: boolean): HTMLElement | null {
  if (!hasTemplateReqs) return null;
  const badge = document.createElement('span');
  badge.className = 'gf-combo-badge gf-badge-template-req';
 badge.textContent = ' + template';
  badge.title = 'All named cards present, but combo requires additional template card(s)';
  return badge;
}

function createResultTagPills(resultTags?: string[]): HTMLElement | null {
  if (!resultTags || resultTags.length === 0) return null;
  const container = document.createElement('div');
  container.className = 'gf-combo-result-tags';
  for (const tag of resultTags.slice(0, 4)) {
    const pill = document.createElement('span');
    pill.className = 'gf-combo-tag-pill';
    pill.textContent = tag.replace(/-/g, ' ');
    container.appendChild(pill);
  }
  return container;
}

function createSpellbookLink(url?: string): HTMLElement | null {
  if (!url) return null;
  const link = document.createElement('a');
  link.className = 'gf-combo-spellbook-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
 link.textContent = '∞ Spellbook';
  link.title = 'View on Commander Spellbook';
  return link;
}

/** Find the ComboPiece object for a given combo name */
function findComboPiece(coach: DeckCoach, comboName: string): ComboPiece | undefined {
  return coach.comboPieces.find((cp) => cp.comboName === comboName);
}

// ═══════════════════════════════════════════════════════
// SVG Lines State
// ═══════════════════════════════════════════════════════

let svgEl: SVGSVGElement | null = null;
let mainContainer: HTMLElement | null = null;
let tooltipEl: HTMLElement | null = null;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let currentRenderState: CoachGameState | null = null;

// ═══════════════════════════════════════════════════════
// Coach Panel Rendering
// ═══════════════════════════════════════════════════════

export function renderCoachPanel(
  container: HTMLElement,
  coach: DeckCoach,
  state: CoachGameState,
): void {
  // Remove previous coach panel if exists
  const prev = container.querySelector('.gf-coach-panel');
  if (prev) prev.remove();

  const panel = document.createElement('div');
  panel.className = 'gf-coach-panel';

  // ── Header ──
  const header = document.createElement('div');
  header.className = 'gf-coach-header';

  const title = document.createElement('span');
  title.className = 'gf-coach-title';
 title.textContent = '◆ Deck Coach';
  header.appendChild(title);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = `gf-coach-toggle${coach.enabled ? ' active' : ''}`;
  toggleBtn.textContent = coach.enabled ? 'ON' : 'OFF';
  toggleBtn.addEventListener('click', () => {
    coach.enabled = !coach.enabled;
    savePrefs(coach);
    onCoachStateChange(coach, state);
    renderCoachPanel(container, coach, state);
    if (svgEl) updateCoachLines(coach, state);
  });
  header.appendChild(toggleBtn);

  // Combo Tree button
  const treeBtn = document.createElement('button');
  treeBtn.className = 'gf-coach-tree-btn';
 treeBtn.textContent = '⑂';
  treeBtn.title = 'Open Combo Tree';
  treeBtn.addEventListener('click', () => openComboTree(coach));
  header.appendChild(treeBtn);

  panel.appendChild(header);

  if (!coach.enabled) {
    container.appendChild(panel);
    return;
  }

  // ── Gameplan (collapsible) ──
  const gpSection = document.createElement('div');
  gpSection.className = 'gf-coach-gameplan';

  const gpTitle = document.createElement('div');
  gpTitle.className = 'gf-coach-gameplan-title';
  gpTitle.textContent = `\u25B8 ${coach.gameplan.archetype} \u2014 ${coach.gameplan.dominantDNA}`;
  let gpOpen = state.turn <= 1;
  gpTitle.addEventListener('click', () => {
    gpOpen = !gpOpen;
    gpBody.style.display = gpOpen ? 'block' : 'none';
    gpTitle.textContent = `${gpOpen ? '\u25BE' : '\u25B8'} ${coach.gameplan.archetype} \u2014 ${coach.gameplan.dominantDNA}`;
  });
  gpSection.appendChild(gpTitle);

  const gpBody = document.createElement('div');
  gpBody.className = 'gf-coach-gameplan-body';
  gpBody.style.display = gpOpen ? 'block' : 'none';

  // Plan text
  const planText = document.createElement('div');
  planText.className = 'gf-coach-plan-text';
  planText.textContent = coach.gameplan.gamePlan;
  gpBody.appendChild(planText);

  // Win conditions
  if (coach.gameplan.winConditions.length > 0) {
    const winLabel = document.createElement('div');
    winLabel.className = 'gf-coach-section-label';
 winLabel.textContent = '◆ Win Conditions';
    gpBody.appendChild(winLabel);
    for (const wc of coach.gameplan.winConditions) {
      const item = document.createElement('div');
      item.className = 'gf-coach-win-item';
      item.textContent = wc;
      gpBody.appendChild(item);
    }
  }

  // Key engines
  if (coach.gameplan.keyEngines.length > 0) {
    const engLabel = document.createElement('div');
    engLabel.className = 'gf-coach-section-label';
 engLabel.textContent = ' Key Engines';
    gpBody.appendChild(engLabel);
    const engList = document.createElement('div');
    engList.className = 'gf-coach-card-list';
    engList.textContent = coach.gameplan.keyEngines.join(', ');
    gpBody.appendChild(engList);
  }

  // Interaction suite
  if (coach.gameplan.interactionSuite.length > 0) {
    const intLabel = document.createElement('div');
    intLabel.className = 'gf-coach-section-label';
 intLabel.textContent = '■ Interaction';
    gpBody.appendChild(intLabel);
    const intList = document.createElement('div');
    intList.className = 'gf-coach-card-list';
    intList.textContent = coach.gameplan.interactionSuite.join(', ');
    gpBody.appendChild(intList);
  }

  gpSection.appendChild(gpBody);
  panel.appendChild(gpSection);

  // ── Play Sequence Timeline ──
  if (coach.gameplan.playSequence.length > 0) {
    const seqSection = document.createElement('div');
    seqSection.className = 'gf-coach-sequence';

    const seqLabel = document.createElement('div');
    seqLabel.className = 'gf-coach-section-label';
 seqLabel.textContent = '▤ Play Sequence';
    seqSection.appendChild(seqLabel);

    const flowStatuses = computeFlowStatus(coach.gameplan.playSequence, state, coach.deckCardNames);

    for (const fs of flowStatuses) {
      const stepEl = document.createElement('div');
      stepEl.className = `gf-sequence-step${fs.stepStatus === 'active' ? ' active' : ''}${fs.stepStatus === 'done' ? ' done' : ''}`;

      // Header row: turns + phase + priority dot
      const headerRow = document.createElement('div');
      headerRow.className = 'gf-sequence-header';

      const turnsEl = document.createElement('span');
      turnsEl.className = 'gf-sequence-turns';
      turnsEl.textContent = `T${fs.step.turns}`;
      headerRow.appendChild(turnsEl);

      const phaseEl = document.createElement('span');
      phaseEl.className = 'gf-sequence-phase';
      phaseEl.textContent = fs.step.phase;
      headerRow.appendChild(phaseEl);

      const dotEl = document.createElement('span');
      dotEl.className = `gf-sequence-dot${fs.stepStatus === 'active' ? ' active' : ''}${fs.stepStatus === 'done' ? ' done' : ''}`;
 dotEl.textContent = fs.stepStatus === 'active' ? '\u25CF' : fs.stepStatus === 'done' ? '✓' : '\u25CB';
      headerRow.appendChild(dotEl);

      stepEl.appendChild(headerRow);

      // Goal text
      const goalEl = document.createElement('div');
      goalEl.className = 'gf-sequence-goal';
      goalEl.textContent = fs.step.goal;
      stepEl.appendChild(goalEl);

      // Card chips
      const cardsRow = document.createElement('div');
      cardsRow.className = 'gf-sequence-cards';

      for (const c of fs.cards) {
        // Skip cards not in deck
        if (c.status === 'not-in-deck') continue;

        const chip = document.createElement('span');
        chip.className = `gf-seq-card gf-seq-${statusToCls(c.status)}`;
        chip.textContent = `${statusToIcon(c.status)} ${c.name}`;
        chip.title = statusToTooltip(c.status, c.name);
        cardsRow.appendChild(chip);
      }

      stepEl.appendChild(cardsRow);
      seqSection.appendChild(stepEl);
    }

    panel.appendChild(seqSection);
  }

  // ── Combo Progress ──
  {
    const comboSection = document.createElement('div');
    comboSection.className = 'gf-coach-combo-section';

    const comboHeader = document.createElement('div');
    comboHeader.className = 'gf-coach-section-label';
    comboHeader.style.display = 'flex';
    comboHeader.style.justifyContent = 'space-between';
    comboHeader.style.alignItems = 'center';

    const comboLabel = document.createElement('span');
 comboLabel.textContent = ' Combo Progress';
    comboHeader.appendChild(comboLabel);

    // "Suggest Combo" button
    const suggestBtn = document.createElement('button');
    suggestBtn.className = 'gf-combo-suggest-btn';
 suggestBtn.textContent = '◆ Suggest';
    suggestBtn.title = 'Suggest a new combo';
    suggestBtn.addEventListener('click', () => {
      showSuggestComboModal((suggestion) => {
        submitComboSuggestion({
          name: suggestion.name,
          cards: suggestion.cards,
          description: suggestion.description,
          produces: suggestion.produces,
        }).then((result) => {
          if (result.ok) {
 suggestBtn.textContent = ' Sent!';
 setTimeout(() => { suggestBtn.textContent = '◆ Suggest'; }, 2000);
          }
        }).catch(() => { /* ignore */ });
      });
    });
    comboHeader.appendChild(suggestBtn);
    comboSection.appendChild(comboHeader);

    if (coach.comboProgress.size > 0) {
      // Sort combos: complete first, then near-miss, then partial
      const sortedEntries = [...coach.comboProgress.entries()].sort((a, b) => {
        const cpA = findComboPiece(coach, a[0]);
        const cpB = findComboPiece(coach, b[0]);
        const orderA = cpA?.matchLevel === 'complete' ? 0 : cpA?.matchLevel === 'near-miss' ? 1 : 2;
        const orderB = cpB?.matchLevel === 'complete' ? 0 : cpB?.matchLevel === 'near-miss' ? 1 : 2;
        if (orderA !== orderB) return orderA - orderB;
        return b[1].pct - a[1].pct;
      });

      // Cap: max 20 complete + 20 near-miss in UI
      let completeCount = 0;
      let nearMissCount = 0;

      for (const [comboName, progress] of sortedEntries) {
        if (progress.pct === 0) continue;

        const cp = findComboPiece(coach, comboName);

        // Apply caps
        if (cp?.matchLevel === 'complete' || progress.pct >= 1) {
          completeCount++;
          if (completeCount > 20) continue;
        } else if (cp?.matchLevel === 'near-miss') {
          nearMissCount++;
          if (nearMissCount > 20) continue;
        }

        const bar = document.createElement('div');
        bar.className = 'gf-coach-combo-bar';

        // Header row: name + badges
        const barHeader = document.createElement('div');
        barHeader.className = 'gf-coach-combo-name';

        // Name text
        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${comboName} \u2014 ${progress.have.length}/${progress.have.length + progress.need.length}`;
        barHeader.appendChild(nameSpan);

        // Source badge
        const srcBadge = createSourceBadge(cp?.source);
        if (srcBadge) barHeader.appendChild(srcBadge);

        // Match level badge (near-miss)
        const levelBadge = createMatchLevelBadge(cp?.matchLevel);
        if (levelBadge) barHeader.appendChild(levelBadge);

        // Template requirements badge
        const tplBadge = createTemplateReqBadge(cp?.hasTemplateReqs);
        if (tplBadge) barHeader.appendChild(tplBadge);

        bar.appendChild(barHeader);

        // Progress bar
        const track = document.createElement('div');
        track.className = 'gf-coach-combo-track';
        const fill = document.createElement('div');
        fill.className = `gf-coach-combo-fill${progress.pct >= 1 ? ' gf-coach-combo-ready' : ''}`;
        fill.style.width = `${Math.round(progress.pct * 100)}%`;
        track.appendChild(fill);
        bar.appendChild(track);

        // Card chips
        const chips = document.createElement('div');
        chips.className = 'gf-coach-combo-cards';
        for (const c of progress.have) {
          const chip = document.createElement('span');
          chip.className = 'gf-coach-have';
          chip.textContent = c;
          chips.appendChild(chip);
        }
        for (const c of progress.need) {
          const chip = document.createElement('span');
          chip.className = `gf-coach-need${progress.inGraveyard.includes(c) ? ' gf-coach-gy' : ''}`;
          chip.textContent = c;
          chip.title = progress.inGraveyard.includes(c) ? 'In graveyard \u2014 recoverable?' : 'Not yet found';
          chips.appendChild(chip);
        }
        bar.appendChild(chips);

        // Result tags pills
        const tagPills = createResultTagPills(cp?.resultTags);
        if (tagPills) bar.appendChild(tagPills);

        // Spellbook link
        const sbLink = createSpellbookLink(cp?.spellbookUrl);
        if (sbLink) bar.appendChild(sbLink);

        comboSection.appendChild(bar);
      }
    } else {
      const emptyNote = document.createElement('div');
      emptyNote.className = 'gf-coach-combo-empty';
      emptyNote.textContent = 'No combos detected yet. Import from Commander Spellbook or suggest one!';
      comboSection.appendChild(emptyNote);
    }

    panel.appendChild(comboSection);
  }

  // ── Active Hints ──
  if (coach.activeHints.length > 0) {
    const hintsSection = document.createElement('div');
    hintsSection.className = 'gf-coach-hints';

    for (const hint of coach.activeHints.slice(0, HINT_MAX_VISIBLE)) {
      const hintEl = document.createElement('div');
      hintEl.className = `gf-coach-hint gf-coach-hint-${hint.category}`;

      const shortLine = document.createElement('div');
      shortLine.className = 'gf-coach-hint-short';
      shortLine.textContent = `${hint.icon} ${hint.shortText}`;

      const expandLine = document.createElement('div');
      expandLine.className = 'gf-coach-hint-expand';
      expandLine.textContent = hint.expandedText;
      expandLine.style.display = 'none';

      shortLine.addEventListener('click', () => {
        const isOpen = expandLine.style.display !== 'none';
        expandLine.style.display = isOpen ? 'none' : 'block';
      });

      hintEl.appendChild(shortLine);
      hintEl.appendChild(expandLine);
      hintsSection.appendChild(hintEl);
    }

    panel.appendChild(hintsSection);
  }

  // ── Settings ──
  const settingsSection = document.createElement('div');
  settingsSection.className = 'gf-coach-settings';

  // Level toggle
  settingsSection.appendChild(createPillGroup('Level', [
    { label: 'Beginner', value: 'beginner' },
    { label: 'Advanced', value: 'advanced' },
  ], coach.level, (v) => {
    coach.level = v as 'beginner' | 'advanced';
    savePrefs(coach);
    onCoachStateChange(coach, state);
    renderCoachPanel(container, coach, state);
  }));

  // Filter toggle
  settingsSection.appendChild(createPillGroup('Show', [
    { label: 'All Tips', value: 'all' },
    { label: 'Combos Only', value: 'combos-only' },
  ], coach.filter, (v) => {
    coach.filter = v as 'all' | 'combos-only';
    savePrefs(coach);
    onCoachStateChange(coach, state);
    renderCoachPanel(container, coach, state);
  }));

  // Lines mode toggle
  settingsSection.appendChild(createPillGroup('Lines', [
    { label: 'Hover', value: 'hover' },
    { label: 'Locked', value: 'locked' },
    { label: 'Off', value: 'off' },
  ], coach.linesMode, (v) => {
    coach.linesMode = v as 'hover' | 'locked' | 'off';
    savePrefs(coach);
    if (svgEl) updateCoachLines(coach, state);
  }));

  panel.appendChild(settingsSection);

  container.appendChild(panel);
}

function createPillGroup(
  label: string,
  options: Array<{ label: string; value: string }>,
  activeValue: string,
  onChange: (value: string) => void,
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'gf-coach-pill-row';

  const lbl = document.createElement('span');
  lbl.className = 'gf-coach-pill-label';
  lbl.textContent = label;
  group.appendChild(lbl);

  const pills = document.createElement('div');
  pills.className = 'gf-coach-pill-group';

  for (const opt of options) {
    const pill = document.createElement('button');
    pill.className = `gf-coach-pill${opt.value === activeValue ? ' active' : ''}`;
    pill.textContent = opt.label;
    pill.addEventListener('click', () => onChange(opt.value));
    pills.appendChild(pill);
  }

  group.appendChild(pills);
  return group;
}

// ═══════════════════════════════════════════════════════
// Flow Status Helpers
// ═══════════════════════════════════════════════════════

function statusToIcon(status: CardFlowStatus): string {
  switch (status) {
 case 'done': return '✓';
 case 'in-hand': return '…';
 case 'in-graveyard': return '✕';
 case 'in-exile': return '⊘';
 case 'missing': return '✘';
    default: return '';
  }
}

function statusToCls(status: CardFlowStatus): string {
  switch (status) {
    case 'done': return 'done';
    case 'in-hand': return 'hand';
    case 'in-graveyard': return 'gy';
    case 'in-exile': return 'exile';
    case 'missing': return 'missing';
    default: return 'missing';
  }
}

function statusToTooltip(status: CardFlowStatus, name: string): string {
  switch (status) {
    case 'done': return `${name} — on battlefield`;
    case 'in-hand': return `${name} — in hand`;
    case 'in-graveyard': return `${name} — in graveyard`;
    case 'in-exile': return `${name} — in exile`;
    case 'missing': return `${name} — not yet drawn`;
    default: return name;
  }
}

// ═══════════════════════════════════════════════════════
// SVG Combo Lines Overlay
// ═══════════════════════════════════════════════════════

export function initCoachLines(main: HTMLElement, coach: DeckCoach): void {
  mainContainer = main;

  // Create SVG overlay
  svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('class', 'gf-lines-svg');
  svgEl.style.position = 'absolute';
  svgEl.style.inset = '0';
  svgEl.style.width = '100%';
  svgEl.style.height = '100%';
  svgEl.style.pointerEvents = 'none';
  svgEl.style.zIndex = '50';
  main.style.position = 'relative';
  main.appendChild(svgEl);

  // Create tooltip
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'gf-line-tooltip';
  tooltipEl.style.display = 'none';
  main.appendChild(tooltipEl);

  // Set up card hover listeners (event delegation)
  main.addEventListener('mouseenter', (e) => {
    const target = e.target as HTMLElement;
    const cardEl = target.closest('[data-card-name]') as HTMLElement | null;
    if (!cardEl || coach.linesMode === 'off') return;
    if (coach.linesMode === 'locked' && coach.lockedCard) return; // locked = don't change on hover

    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const cardName = cardEl.getAttribute('data-card-name') || '';
      if (cardName) {
        coach.hoveredCard = cardName;
        drawLinesForCard(coach, cardName);
      }
    }, HOVER_DEBOUNCE);
  }, true);

  main.addEventListener('mouseleave', (e) => {
    const target = e.target as HTMLElement;
    const cardEl = target.closest('[data-card-name]') as HTMLElement | null;
    if (!cardEl || coach.linesMode !== 'hover') return;

    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      coach.hoveredCard = null;
      clearLines();
    }, HOVER_DEBOUNCE);
  }, true);

  // Click for lock mode
  main.addEventListener('click', (e) => {
    if (coach.linesMode !== 'locked') return;
    const target = e.target as HTMLElement;
    const cardEl = target.closest('[data-card-name]') as HTMLElement | null;
    if (cardEl) {
      const cardName = cardEl.getAttribute('data-card-name') || '';
      if (coach.lockedCard === cardName) {
        coach.lockedCard = null;
        clearLines();
      } else {
        coach.lockedCard = cardName;
        drawLinesForCard(coach, cardName);
      }
    }
  });
}

export function updateCoachLines(coach: DeckCoach, state: CoachGameState): void {
  currentRenderState = state;
  if (!svgEl || !coach.enabled || coach.linesMode === 'off') {
    clearLines();
    return;
  }
  // Redraw for currently focused card
  const focusCard = coach.lockedCard || coach.hoveredCard;
  if (focusCard) {
    requestAnimationFrame(() => drawLinesForCard(coach, focusCard));
  }
}

export function destroyCoachLines(): void {
  if (svgEl) { svgEl.remove(); svgEl = null; }
  if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
  mainContainer = null;
  currentRenderState = null;
}

function clearLines(): void {
  if (svgEl) {
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  }
  if (tooltipEl) tooltipEl.style.display = 'none';
}

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function drawLinesForCard(coach: DeckCoach, cardName: string): void {
  if (!svgEl || !mainContainer) return;
  clearLines();

  const normalizedName = norm(cardName);

  // Find all edges involving this card
  let edges = coach.relEdges.filter(
    (e) => norm(e.a) === normalizedName || norm(e.b) === normalizedName,
  );

  // Sort by score descending, cap at MAX_LINES
  edges.sort((a, b) => b.score - a.score);
  edges = edges.slice(0, MAX_LINES);

  if (edges.length === 0) return;

  const containerRect = mainContainer.getBoundingClientRect();

  for (const edge of edges) {
    const otherName = norm(edge.a) === normalizedName ? edge.b : edge.a;

    // Find source element
    const sourceEl = findCardElement(cardName, mainContainer);
    const targetEl = findCardElement(otherName, mainContainer);

    if (!sourceEl || !targetEl) continue;

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const path = createBezierPath(sourceRect, targetRect, edge, containerRect);
    svgEl.appendChild(path);

    // Make path hoverable for tooltip
    path.style.pointerEvents = 'stroke';
    path.addEventListener('mouseenter', (ev) => {
      showLineTooltip(ev as MouseEvent, edge);
    });
    path.addEventListener('mouseleave', () => {
      if (tooltipEl) tooltipEl.style.display = 'none';
    });
  }
}

function findCardElement(cardName: string, container: HTMLElement): HTMLElement | null {
  // Try exact match first
  const el = container.querySelector(`[data-card-name="${CSS.escape(cardName)}"]`) as HTMLElement | null;
  if (el) return el;

  // Try case-insensitive by iterating
  const all = container.querySelectorAll<HTMLElement>('[data-card-name]');
  for (const node of all) {
    if (norm(node.getAttribute('data-card-name') || '') === norm(cardName)) return node;
  }

  // Try zone header fallback (graveyard/exile)
  // Cards in graveyard/exile may not have data-card-name, anchor to zone title
  return null;
}

function createBezierPath(
  from: DOMRect, to: DOMRect, edge: RelEdge, containerRect: DOMRect,
): SVGPathElement {
  const x1 = from.left + from.width / 2 - containerRect.left;
  const y1 = from.top + from.height / 2 - containerRect.top;
  const x2 = to.left + to.width / 2 - containerRect.left;
  const y2 = to.top + to.height / 2 - containerRect.top;

  // Control point: perpendicular offset for curve
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const bend = Math.min(dist * 0.25, 50);
  const mx = (x1 + x2) / 2 - (dist > 0 ? (dy / dist) * bend : 0);
  const my = (y1 + y2) / 2 + (dist > 0 ? (dx / dist) * bend : 0);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M${x1},${y1} Q${mx},${my} ${x2},${y2}`);
  path.setAttribute('class', `gf-line gf-line-${edge.type}`);
  path.setAttribute('fill', 'none');

  return path;
}

function showLineTooltip(ev: MouseEvent, edge: RelEdge): void {
  if (!tooltipEl || !mainContainer) return;
  const containerRect = mainContainer.getBoundingClientRect();

  tooltipEl.style.display = 'block';
  tooltipEl.innerHTML = '';

  const reason = document.createElement('div');
  reason.className = 'gf-line-tooltip-reason';
  reason.textContent = edge.explainShort;
  tooltipEl.appendChild(reason);

  if (edge.explainResult) {
    const result = document.createElement('div');
    result.className = 'gf-line-tooltip-result';
    result.textContent = `\u2192 ${edge.explainResult}`;
    tooltipEl.appendChild(result);
  }

  let left = ev.clientX - containerRect.left + 12;
  let top = ev.clientY - containerRect.top - 8;
  if (left + 200 > containerRect.width) left = ev.clientX - containerRect.left - 200;
  if (top < 0) top = 4;

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

// ═══════════════════════════════════════════════════════
// Role Badges
// ═══════════════════════════════════════════════════════

export function getRoleBadge(cardName: string, coach: DeckCoach): HTMLElement | null {
  if (!coach.enabled) return null;

  const role = getPrimaryRole(cardName, coach);
  if (!role || role === 'land') return null;

  const display = ROLE_DISPLAY[role];
  if (!display || !display.label) return null;

  const badge = document.createElement('span');
  badge.className = `gf-role-badge ${display.cls}`;
  badge.textContent = display.label;
  return badge;
}
