import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import type { Deck } from '../shared/types.js';
import {
  buildMatchupGuide,
  type BuildMatchupGuideInput,
  type MatchupGuide,
  type MatchupPlan,
  type MatchupMetaMode,
} from '../mtg/engine/matchup-guide.js';

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function deckbuilderToSharedDeck(deck: DeckbuilderDeck): Deck {
  return {
    main: deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty })),
    sideboard: deck.boards.sideboard.map((e) => ({ name: e.name, qty: e.qty })),
    commander: deck.boards.commander.map((e) => ({ name: e.name, qty: e.qty })),
  };
}

let cachedGuide: MatchupGuide | null = null;
let cacheKey = '';

function buildGuide(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  metaMode: MatchupMetaMode,
): MatchupGuide {
  const key = `${deck.id}-${JSON.stringify(deck.boards.mainboard.map(e => e.name + e.qty))}-${metaMode}`;
  if (cachedGuide && cacheKey === key) return cachedGuide;

  const sharedDeck = deckbuilderToSharedDeck(deck);
  const input: BuildMatchupGuideInput = {
    deck: sharedDeck,
    resolveCard: (name: string) => {
      const card = cardByName[normalizeKey(name)];
      if (!card) return null;
      return {
        name: card.name,
        cmc: card.cmc,
        type_line: card.type_line,
        oracle_text: card.oracle_text,
        color_identity: card.color_identity,
      };
    },
    metaMode,
  };

  cachedGuide = buildMatchupGuide(input);
  cacheKey = key;
  return cachedGuide;
}

function relevanceColor(score: number): string {
  if (score >= 0.7) return '#34d399';
  if (score >= 0.4) return '#e8c84a';
  return '#ef4444';
}

function createPhaseTimeline(plan: MatchupPlan): HTMLElement {
  const timeline = document.createElement('div');
  timeline.className = 'matchup-timeline';

  const phases = [
    { label: 'Early', items: plan.corePlan.early },
    { label: 'Mid', items: plan.corePlan.mid },
    { label: 'Late', items: plan.corePlan.late },
  ];

  for (const phase of phases) {
    if (phase.items.length === 0) continue;
    const phaseEl = document.createElement('div');
    phaseEl.className = 'matchup-phase';

    const header = document.createElement('div');
    header.className = 'matchup-phase-label';
    header.textContent = phase.label;
    phaseEl.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'matchup-phase-list';
    for (const item of phase.items) {
      const li = document.createElement('li');
      li.textContent = item;
      list.appendChild(li);
    }
    phaseEl.appendChild(list);
    timeline.appendChild(phaseEl);
  }

  return timeline;
}

function createSideboardSection(plan: MatchupPlan): HTMLElement {
  const section = document.createElement('div');
  section.className = 'matchup-sideboard';

  if (!plan.sideboard.available || (plan.sideboard.in.length === 0 && plan.sideboard.out.length === 0)) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '0.72rem';
    empty.textContent = 'No sideboard changes recommended.';
    section.appendChild(empty);
    return section;
  }

  if (plan.sideboard.in.length > 0) {
    const inHeader = document.createElement('div');
    inHeader.className = 'sb-label sb-in';
    inHeader.textContent = 'IN';
    section.appendChild(inHeader);
    for (const move of plan.sideboard.in) {
      const row = document.createElement('div');
      row.className = 'sb-move sb-move-in';
      row.textContent = `+${move.qty} ${move.card}`;
      const reason = document.createElement('span');
      reason.className = 'sb-reason';
      reason.textContent = move.reason;
      row.appendChild(reason);
      section.appendChild(row);
    }
  }

  if (plan.sideboard.out.length > 0) {
    const outHeader = document.createElement('div');
    outHeader.className = 'sb-label sb-out';
    outHeader.textContent = 'OUT';
    section.appendChild(outHeader);
    for (const move of plan.sideboard.out) {
      const row = document.createElement('div');
      row.className = 'sb-move sb-move-out';
      row.textContent = `-${move.qty} ${move.card}`;
      const reason = document.createElement('span');
      reason.className = 'sb-reason';
      reason.textContent = move.reason;
      row.appendChild(reason);
      section.appendChild(row);
    }
  }

  return section;
}

function createPlanPanel(plan: MatchupPlan): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'matchup-panel';

  // Header (clickable to toggle)
  const header = document.createElement('div');
  header.className = 'matchup-header';

  const title = document.createElement('span');
  title.className = 'matchup-title';
  title.textContent = plan.title;

  const badge = document.createElement('span');
  badge.className = 'matchup-relevance';
  badge.style.color = relevanceColor(plan.relevanceScore);
  badge.textContent = `${Math.round(plan.relevanceScore * 100)}%`;

  const chevron = document.createElement('span');
  chevron.className = 'matchup-chevron';
  chevron.textContent = '▸';

  header.append(title, badge, chevron);
  panel.appendChild(header);

  // Body (hidden by default)
  const body = document.createElement('div');
  body.className = 'matchup-body';
  body.style.display = 'none';

  // Threats
  if (plan.threats.length > 0) {
    const threatsLabel = document.createElement('div');
    threatsLabel.className = 'matchup-section-label';
    threatsLabel.textContent = 'Key Threats';
    body.appendChild(threatsLabel);
    const threatsList = document.createElement('div');
    threatsList.className = 'matchup-tags';
    for (const t of plan.threats) {
      const tag = document.createElement('span');
      tag.className = 'matchup-tag threat';
      tag.textContent = t;
      threatsList.appendChild(tag);
    }
    body.appendChild(threatsList);
  }

  // Win conditions
  if (plan.wincons.length > 0) {
    const winconsLabel = document.createElement('div');
    winconsLabel.className = 'matchup-section-label';
    winconsLabel.textContent = 'Win Conditions';
    body.appendChild(winconsLabel);
    const winconsList = document.createElement('div');
    winconsList.className = 'matchup-tags';
    for (const w of plan.wincons) {
      const tag = document.createElement('span');
      tag.className = 'matchup-tag wincon';
      tag.textContent = w;
      winconsList.appendChild(tag);
    }
    body.appendChild(winconsList);
  }

  // Game plan timeline
  const timelineLabel = document.createElement('div');
  timelineLabel.className = 'matchup-section-label';
  timelineLabel.textContent = 'Game Plan';
  body.appendChild(timelineLabel);
  body.appendChild(createPhaseTimeline(plan));

  // Interaction priorities
  if (plan.interactionPriorities.length > 0) {
    const intLabel = document.createElement('div');
    intLabel.className = 'matchup-section-label';
    intLabel.textContent = 'Interaction Priorities';
    body.appendChild(intLabel);
    const intList = document.createElement('ol');
    intList.className = 'matchup-priorities';
    for (const p of plan.interactionPriorities) {
      const li = document.createElement('li');
      li.textContent = p;
      intList.appendChild(li);
    }
    body.appendChild(intList);
  }

  // Sideboard plan
  const sbLabel = document.createElement('div');
  sbLabel.className = 'matchup-section-label';
  sbLabel.textContent = 'Sideboard Plan';
  body.appendChild(sbLabel);
  body.appendChild(createSideboardSection(plan));

  panel.appendChild(body);

  // Toggle accordion
  header.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    chevron.textContent = isOpen ? '▸' : '▾';
    panel.classList.toggle('open', !isOpen);
  });

  return panel;
}

export function renderMatchupPanel(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  metaMode: MatchupMetaMode,
): void {
  container.textContent = '';

  if (deck.boards.mainboard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'Add cards to your mainboard to generate matchup strategies.';
    container.appendChild(empty);
    return;
  }

  const guide = buildGuide(deck, cardByName, metaMode);

  // Coverage info
  if (guide.cardDataCoverage < 0.5) {
    const warn = document.createElement('div');
    warn.className = 'matchup-coverage-warn';
    warn.textContent = `Card data coverage: ${Math.round(guide.cardDataCoverage * 100)}% — results may be less accurate.`;
    container.appendChild(warn);
  }

  // Rulebook summary
  if (guide.inOutRulebook.length > 0) {
    const rulebookEl = document.createElement('div');
    rulebookEl.className = 'matchup-rulebook';
    const rbTitle = document.createElement('div');
    rbTitle.className = 'matchup-section-label';
    rbTitle.textContent = 'General In/Out Rules';
    rulebookEl.appendChild(rbTitle);
    const rbList = document.createElement('ul');
    rbList.className = 'matchup-rb-list';
    for (const rule of guide.inOutRulebook) {
      const li = document.createElement('li');
      li.textContent = rule;
      rbList.appendChild(li);
    }
    rulebookEl.appendChild(rbList);
    container.appendChild(rulebookEl);
  }

  // Matchup plans (auto-expand first)
  for (let i = 0; i < guide.plans.length; i++) {
    const planEl = createPlanPanel(guide.plans[i]);
    if (i === 0) {
      // Auto-expand first plan
      const body = planEl.querySelector('.matchup-body') as HTMLElement;
      const chevron = planEl.querySelector('.matchup-chevron') as HTMLElement;
      if (body) body.style.display = 'block';
      if (chevron) chevron.textContent = '▾';
      planEl.classList.add('open');
    }
    container.appendChild(planEl);
  }

  // Fallback reasons
  if (guide.fallbackReasons.length > 0) {
    const fb = document.createElement('div');
    fb.className = 'muted';
    fb.style.cssText = 'font-size:0.68rem;margin-top:10px;';
    fb.textContent = guide.fallbackReasons.join(' • ');
    container.appendChild(fb);
  }
}

export function invalidateMatchupCache(): void {
  cachedGuide = null;
  cacheKey = '';
}
