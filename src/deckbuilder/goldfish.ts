import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { showHoverPreview, hideHoverPreview } from './card-preview.js';
import { broadcastGoldfishStart, broadcastGoldfishAction, broadcastGoldfishEnd } from './collab-goldfish.js';
import { initCoach, onCoachStateChange, savePrefs as saveCoachPrefs, type DeckCoach } from './goldfish-coach.js';
import { renderCoachPanel, getRoleBadge, initCoachLines, updateCoachLines, destroyCoachLines } from './goldfish-coach-ui.js';
import { renderCoachWidget } from './goldfish-coach-widget.js';

type Phase = 'untap' | 'upkeep' | 'draw' | 'main1' | 'combat' | 'main2' | 'end';
type GfZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'commandZone';

const PHASES: Phase[] = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'main2', 'end'];
const PHASE_LABELS: Record<Phase, string> = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw',
  main1: 'Main 1', combat: 'Combat', main2: 'Main 2', end: 'End',
};
const MAX_UNDO = 30;

// ─── Token Image Cache (Scryfall) ───
const tokenImageCache = new Map<string, string>(); // name → imgUrl
const tokenImagePending = new Set<string>(); // names currently being fetched

async function fetchTokenImage(name: string): Promise<string> {
  if (tokenImageCache.has(name)) return tokenImageCache.get(name)!;
  if (tokenImagePending.has(name)) return '';
  tokenImagePending.add(name);
  try {
    // Try exact name match first (works for named tokens like Treasure, Food)
    const q = `!"${name}" t:token`;
    const resp = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc`);
    if (resp.ok) {
      const data = await resp.json() as { data?: Array<{ image_uris?: { small?: string; normal?: string }; card_faces?: Array<{ image_uris?: { small?: string; normal?: string } }> }> };
      const card = data.data?.[0];
      const img = card?.image_uris?.normal || card?.image_uris?.small
        || card?.card_faces?.[0]?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.small || '';
      if (img) {
        tokenImageCache.set(name, img);
        tokenImagePending.delete(name);
        return img;
      }
    }
    // Fallback: broader name search
    const q2 = `t:token name:"${name}"`;
    const resp2 = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q2)}&unique=prints&order=released&dir=desc`);
    if (resp2.ok) {
      const data2 = await resp2.json() as { data?: Array<{ image_uris?: { small?: string; normal?: string }; card_faces?: Array<{ image_uris?: { small?: string; normal?: string } }> }> };
      const card2 = data2.data?.[0];
      const img2 = card2?.image_uris?.normal || card2?.image_uris?.small
        || card2?.card_faces?.[0]?.image_uris?.normal || card2?.card_faces?.[0]?.image_uris?.small || '';
      tokenImageCache.set(name, img2);
      tokenImagePending.delete(name);
      return img2;
    }
    tokenImageCache.set(name, '');
    tokenImagePending.delete(name);
    return '';
  } catch {
    tokenImagePending.delete(name);
    return '';
  }
}

// ─── Oracle Text Token Detection ───

interface DetectedToken {
  name: string;
  power?: string;
  toughness?: string;
  colors: string;
  typeLine: string;
  abilities: string;
}

const PREDEFINED_TOKENS = ['Treasure', 'Food', 'Clue', 'Blood', 'Map', 'Powerstone', 'Incubator', 'Shard', 'Junk', 'Gold', 'Walker'];

function extractTokensFromOracle(oracleText: string): DetectedToken[] {
  const tokens: DetectedToken[] = [];
  const seen = new Set<string>();

  // Pattern 1: Creature tokens with P/T — "create a 1/1 white Soldier creature token with flying"
  const creatureRe = /[Cc]reates?\s+(?:a\s+|an\s+|two\s+|three\s+|four\s+|five\s+|\d+\s+)?(\d+|\*)\/(\d+|\*)\s+([\w\s,]+?)\s+creature\s+tokens?(?:\s+with\s+([\w\s,]+?))?(?:\.|,|$)/g;
  let m: RegExpExecArray | null;
  while ((m = creatureRe.exec(oracleText)) !== null) {
    const power = m[1];
    const toughness = m[2];
    const descriptor = m[3].trim(); // e.g. "white Soldier" or "green and white Elf Warrior"
    const abilities = (m[4] || '').trim();

    // Extract color words and creature type from descriptor
    const colorWords = ['white', 'blue', 'black', 'red', 'green', 'colorless'];
    const parts = descriptor.split(/\s+/);
    const colors: string[] = [];
    const typeWords: string[] = [];
    for (const w of parts) {
      if (colorWords.includes(w.toLowerCase())) colors.push(w);
      else if (w.toLowerCase() !== 'and') typeWords.push(w);
    }
    const name = typeWords.join(' ') || 'Token';
    const key = `${name}-${power}/${toughness}`;
    if (seen.has(key)) continue;
    seen.add(key);

    tokens.push({
      name,
      power,
      toughness,
      colors: colors.join(' '),
      typeLine: `Creature — ${name}`,
      abilities,
    });
  }

  // Pattern 2: Predefined artifact tokens (Treasure, Food, Clue, etc.)
  for (const tName of PREDEFINED_TOKENS) {
    const re = new RegExp(`[Cc]reates?\\s+(?:a\\s+|an\\s+|two\\s+|three\\s+|\\d+\\s+)?${tName}\\s+tokens?`, 'g');
    if (re.test(oracleText) && !seen.has(tName)) {
      seen.add(tName);
      tokens.push({
        name: tName,
        colors: '',
        typeLine: `Token — ${tName}`,
        abilities: '',
      });
    }
  }

  return tokens;
}

interface GoldfishPermanent {
  id: string;
  name: string;
  tapped: boolean;
  isLand: boolean;
  isCreature: boolean;
  isToken: boolean;
  typeLine: string;
  imgUrl: string;
  counters: Record<string, number>;
  power?: string;
  toughness?: string;
  x: number; // percentage 0-100 relative to battlefield width
  y: number; // percentage 0-100 relative to battlefield height
}

interface GoldfishState {
  library: string[];
  hand: string[];
  battlefield: GoldfishPermanent[];
  graveyard: string[];
  exile: string[];
  commandZone: string[];
  commanderTax: number;
  poisonCounters: number;
  lifeTotal: number;
  turn: number;
  phase: Phase;
  landPlayedThisTurn: boolean;
  log: string[];
  undoStack: string[];
  nextPermanentId: number;
}

interface GfDragPayload {
  zone: GfZone;
  index: number;
  cardName: string;
}

interface GfCtxItem {
  label: string;
  action: () => void;
  danger?: boolean;
  divider?: boolean;
}

// ─── Helpers ───

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shuffle(arr: string[]): string[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getCard(name: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): DeckbuilderSearchCard | undefined {
  return cardByName[normalizeKey(name)];
}

function getImgUrl(name: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): string {
  const card = getCard(name, cardByName);
  return card?.image_uris?.small || card?.image_uris?.normal || '';
}

function classifyCard(name: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): { isLand: boolean; isCreature: boolean; typeLine: string } {
  const card = getCard(name, cardByName);
  const tl = (card?.type_line || '').toLowerCase();
  return {
    isLand: tl.includes('land'),
    isCreature: tl.includes('creature'),
    typeLine: card?.type_line || '',
  };
}

function initState(deck: DeckbuilderDeck): GoldfishState {
  const allCards: string[] = [];
  for (const entry of deck.boards.mainboard) {
    for (let i = 0; i < entry.qty; i++) allCards.push(entry.name);
  }
  const library = shuffle(allCards);
  const hand = library.splice(0, 7);

  // Load commanders into command zone
  const commandZone: string[] = [];
  if (deck.boards.commander) {
    for (const entry of deck.boards.commander) {
      for (let i = 0; i < entry.qty; i++) commandZone.push(entry.name);
    }
  }

  return {
    library, hand,
    battlefield: [], graveyard: [], exile: [],
    commandZone, commanderTax: 0, poisonCounters: 0,
    lifeTotal: 40, turn: 1, phase: 'main1',
    landPlayedThisTurn: false,
    log: ['Game started. Opening hand drawn.'],
    undoStack: [],
    nextPermanentId: 1,
  };
}

// ─── Main ───

export function openGoldfishPlaytest(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  let state = initState(deck);
  let ctxMenuEl: HTMLElement | null = null;
  let zoneModalEl: HTMLElement | null = null;

  // Deck Coach (optional — fails gracefully)
  let coach: DeckCoach | null = null;
  try { coach = initCoach(deck, cardByName); } catch { /* coach is optional */ }

  const overlay = document.createElement('div');
  overlay.className = 'goldfish-overlay';

  // Raise card preview above overlay
  const previewEl = document.querySelector<HTMLElement>('.card-hover-preview');
  const origPreviewZ = previewEl?.style.zIndex || '';
  if (previewEl) previewEl.style.zIndex = '10000';

  function cleanup(): void {
    broadcastGoldfishEnd('completed', state.turn);
    destroyCoachLines();
    if (previewEl) previewEl.style.zIndex = origPreviewZ;
    hideHoverPreview();
    overlay.remove();
  }

  // ─── Undo ───

  function snapshotForUndo(): string {
    const { undoStack: _, ...rest } = state;
    return JSON.stringify(rest);
  }

  function pushUndo(): void {
    state.undoStack.push(snapshotForUndo());
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  }

  function performUndo(): void {
    if (state.undoStack.length === 0) return;
    const snap = state.undoStack.pop()!;
    const restored = JSON.parse(snap) as Omit<GoldfishState, 'undoStack'>;
    const stack = state.undoStack;
    Object.assign(state, restored);
    state.undoStack = stack;
    render();
  }

  // ─── Context Menu ───

  function hideCtxMenu(): void {
    if (ctxMenuEl) ctxMenuEl.classList.remove('visible');
  }

  function showCtxMenu(event: MouseEvent, items: GfCtxItem[]): void {
    hideCtxMenu();
    if (!ctxMenuEl) {
      ctxMenuEl = document.createElement('div');
      ctxMenuEl.className = 'gf-context-menu';
      overlay.appendChild(ctxMenuEl);
    }
    ctxMenuEl.textContent = '';

    for (const item of items) {
      if (item.divider) {
        const div = document.createElement('div');
        div.className = 'gf-ctx-divider';
        ctxMenuEl.appendChild(div);
      }
      const btn = document.createElement('button');
      btn.className = `gf-ctx-item${item.danger ? ' gf-ctx-danger' : ''}`;
      btn.textContent = item.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideCtxMenu();
        item.action();
      });
      ctxMenuEl.appendChild(btn);
    }

    // Position with viewport clamping
    ctxMenuEl.style.left = '0px';
    ctxMenuEl.style.top = '0px';
    ctxMenuEl.classList.add('visible');

    const menuW = 200;
    const menuH = ctxMenuEl.offsetHeight;
    let left = event.clientX;
    let top = event.clientY;
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
    if (top + menuH > window.innerHeight) top = window.innerHeight - menuH - 8;
    if (left < 0) left = 8;
    if (top < 0) top = 8;

    ctxMenuEl.style.left = `${left}px`;
    ctxMenuEl.style.top = `${top}px`;
  }

  // ─── Zone Modal ───

  function hideZoneModal(): void {
    if (zoneModalEl) { zoneModalEl.remove(); zoneModalEl = null; }
  }

  function showZoneModal(title: string, cards: string[], zone: GfZone): void {
    hideZoneModal();
    zoneModalEl = document.createElement('div');
    zoneModalEl.className = 'gf-zone-modal-overlay';
    zoneModalEl.addEventListener('click', (e) => {
      if (e.target === zoneModalEl) hideZoneModal();
    });

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal';

    const titleEl = document.createElement('div');
    titleEl.className = 'gf-zone-modal-title';
    titleEl.textContent = `${title} (${cards.length})`;
    modal.appendChild(titleEl);

    const grid = document.createElement('div');
    grid.className = 'gf-zone-modal-grid';

    for (let i = 0; i < cards.length; i++) {
      const name = cards[i];
      const cardEl = document.createElement('div');
      cardEl.className = 'gf-zone-modal-card';
      cardEl.title = name;

      const imgUrl = getImgUrl(name, cardByName);
      if (imgUrl) {
        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = name;
        img.loading = 'lazy';
        cardEl.appendChild(img);
      } else {
        cardEl.textContent = name;
        cardEl.style.cssText = 'font-size:0.72rem;color:#94a3b8;padding:8px;background:rgba(255,255,255,0.04);min-height:60px;display:flex;align-items:center;justify-content:center;';
      }

      // Hover preview
      attachPreview(cardEl, name);

      // Context menu for zone modal cards
      cardEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const idx = i;
        const ctxItems: GfCtxItem[] = [];

        if (zone === 'graveyard') {
          ctxItems.push({ label: '→ Hand', action: () => { pushUndo(); const n = state.graveyard.splice(idx, 1)[0]; state.hand.push(n); addLog(`${n} → Hand (from Graveyard)`); hideZoneModal(); render(); } });
          ctxItems.push({ label: '→ Battlefield', action: () => { pushUndo(); const n = state.graveyard.splice(idx, 1)[0]; addToBattlefield(n); addLog(`${n} → Battlefield (from Graveyard)`); hideZoneModal(); render(); } });
          ctxItems.push({ label: '→ Exile', action: () => { pushUndo(); const n = state.graveyard.splice(idx, 1)[0]; state.exile.push(n); addLog(`${n} → Exile (from Graveyard)`); hideZoneModal(); render(); } });
        } else if (zone === 'exile') {
          ctxItems.push({ label: '→ Hand', action: () => { pushUndo(); const n = state.exile.splice(idx, 1)[0]; state.hand.push(n); addLog(`${n} → Hand (from Exile)`); hideZoneModal(); render(); } });
          ctxItems.push({ label: '→ Battlefield', action: () => { pushUndo(); const n = state.exile.splice(idx, 1)[0]; addToBattlefield(n); addLog(`${n} → Battlefield (from Exile)`); hideZoneModal(); render(); } });
        }
        if (ctxItems.length > 0) showCtxMenu(e, ctxItems);
      });

      grid.appendChild(cardEl);
    }

    modal.appendChild(grid);
    zoneModalEl.appendChild(modal);
    overlay.appendChild(zoneModalEl);
  }

  // ─── Hover Preview ───

  function attachPreview(el: HTMLElement, cardName: string): void {
    const card = getCard(cardName, cardByName);
    if (!card) return;
    el.addEventListener('mouseenter', (e) => {
      showHoverPreview(card as any, e);
    });
    el.addEventListener('mouseleave', () => hideHoverPreview());
  }

  // ─── Drag-and-Drop ───

  function setupDrag(el: HTMLElement, payload: GfDragPayload): void {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      hideCtxMenu();
      el.classList.add('gf-dragging');
      e.dataTransfer!.setData('application/x-goldfish', JSON.stringify(payload));
      e.dataTransfer!.effectAllowed = 'move';
      // Custom drag image
      const img = el.querySelector('img');
      if (img && e.dataTransfer) {
        const ghost = document.createElement('img');
        ghost.src = img.src;
        ghost.style.cssText = 'width:80px;position:absolute;top:-9999px;';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 40, 56);
        requestAnimationFrame(() => ghost.remove());
      }
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('gf-dragging');
    });
  }

  function setupDropZone(el: HTMLElement, onDrop: (payload: GfDragPayload, e: DragEvent) => void): void {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      el.classList.add('gf-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (el.contains(e.relatedTarget as Node)) return;
      el.classList.remove('gf-drop-target');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('gf-drop-target');
      const raw = e.dataTransfer?.getData('application/x-goldfish');
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as GfDragPayload;
        onDrop(payload, e);
      } catch { /* ignore bad payload */ }
    });
  }

  // ─── Card Actions ───

  function addLog(msg: string): void {
    state.log.push(`T${state.turn} ${PHASE_LABELS[state.phase]}: ${msg}`);
    broadcastGoldfishAction(msg, `T${state.turn} ${PHASE_LABELS[state.phase]}: ${msg}`, state.turn);
    if (coach) onCoachStateChange(coach, state);
  }

  function nextId(): string {
    return `gf-${state.nextPermanentId++}`;
  }

  function autoPosition(isLand: boolean, isCreature: boolean): { x: number; y: number } {
    // Count existing cards of the same type to spread them
    let sameTypeCount = 0;
    for (const p of state.battlefield) {
      if (isCreature && p.isCreature) sameTypeCount++;
      else if (isLand && !isCreature && p.isLand && !p.isCreature) sameTypeCount++;
      else if (!isLand && !isCreature && !p.isLand && !p.isCreature) sameTypeCount++;
    }
    const col = sameTypeCount % 8;
    const row = Math.floor(sameTypeCount / 8);
    const x = 2 + col * 11; // spread across x: 2%, 13%, 24%, ...
    let yBase: number;
    if (isCreature) yBase = 25 + row * 18;
    else if (isLand) yBase = 68 + row * 15;
    else yBase = 3 + row * 18;
    return { x: Math.min(x, 88), y: Math.min(yBase, 85) };
  }

  function addToBattlefield(name: string, posX?: number, posY?: number): void {
    const cls = classifyCard(name, cardByName);
    const card = getCard(name, cardByName);
    const pos = posX != null && posY != null ? { x: posX, y: posY } : autoPosition(cls.isLand, cls.isCreature);
    state.battlefield.push({
      id: nextId(), name,
      tapped: false,
      isLand: cls.isLand,
      isCreature: cls.isCreature,
      isToken: false,
      typeLine: cls.typeLine,
      imgUrl: getImgUrl(name, cardByName),
      counters: {},
      power: card?.power || undefined,
      toughness: card?.toughness || undefined,
      x: pos.x, y: pos.y,
    });
  }

  function drawCard(): void {
    if (state.library.length === 0) { addLog('Library is empty!'); return; }
    const card = state.library.shift()!;
    state.hand.push(card);
    addLog(`Drew ${card}`);
  }

  function nextPhase(): void {
    pushUndo();
    const idx = PHASES.indexOf(state.phase);
    if (idx === PHASES.length - 1) {
      state.turn++;
      state.phase = 'untap';
      state.landPlayedThisTurn = false;
      for (const p of state.battlefield) p.tapped = false;
      addLog('New turn begins. Untapped all permanents.');
      state.phase = 'draw';
      if (state.turn > 1) drawCard();
      state.phase = 'main1';
    } else {
      state.phase = PHASES[idx + 1];
      if (state.phase === 'draw' && state.turn > 1) {
        drawCard();
        state.phase = 'main1';
      }
    }
    render();
  }

  function playFromHand(idx: number): void {
    pushUndo();
    const name = state.hand[idx];
    const cls = classifyCard(name, cardByName);

    if (cls.isLand) {
      state.landPlayedThisTurn = true;
    }

    state.hand.splice(idx, 1);
    const card = getCard(name, cardByName);
    const pos = autoPosition(cls.isLand, cls.isCreature);
    state.battlefield.push({
      id: nextId(), name,
      tapped: false,
      isLand: cls.isLand,
      isCreature: cls.isCreature,
      isToken: false,
      typeLine: cls.typeLine,
      imgUrl: getImgUrl(name, cardByName),
      counters: {},
      power: card?.power || undefined,
      toughness: card?.toughness || undefined,
      x: pos.x, y: pos.y,
    });
    addLog(`Played ${name}`);
    render();
  }

  function tapPermanent(bfIdx: number): void {
    pushUndo();
    const p = state.battlefield[bfIdx];
    p.tapped = !p.tapped;
    addLog(`${p.tapped ? 'Tapped' : 'Untapped'} ${p.name}`);
    render();
  }

  function bfToGraveyard(bfIdx: number): void {
    pushUndo();
    const p = state.battlefield.splice(bfIdx, 1)[0];
    if (isCommander(p.name)) {
      state.commandZone.push(p.name);
      addLog(`${p.name} died → returned to Command Zone`);
    } else {
      state.graveyard.push(p.name);
      addLog(`${p.name} → Graveyard`);
    }
    render();
  }

  function bfToExile(bfIdx: number): void {
    pushUndo();
    const p = state.battlefield.splice(bfIdx, 1)[0];
    if (isCommander(p.name)) {
      state.commandZone.push(p.name);
      addLog(`${p.name} exiled → returned to Command Zone`);
    } else {
      state.exile.push(p.name);
      addLog(`${p.name} → Exile`);
    }
    render();
  }

  function bfToHand(bfIdx: number): void {
    pushUndo();
    const p = state.battlefield.splice(bfIdx, 1)[0];
    state.hand.push(p.name);
    addLog(`${p.name} → Hand (Bounce)`);
    render();
  }

  function bfToLibrary(bfIdx: number): void {
    pushUndo();
    const p = state.battlefield.splice(bfIdx, 1)[0];
    state.library.unshift(p.name);
    addLog(`${p.name} → Top of Library`);
    render();
  }

  function handToGraveyard(handIdx: number): void {
    pushUndo();
    const name = state.hand.splice(handIdx, 1)[0];
    state.graveyard.push(name);
    addLog(`Discarded ${name}`);
    render();
  }

  function handToExile(handIdx: number): void {
    pushUndo();
    const name = state.hand.splice(handIdx, 1)[0];
    state.exile.push(name);
    addLog(`${name} → Exile (from Hand)`);
    render();
  }

  function handToLibrary(handIdx: number): void {
    pushUndo();
    const name = state.hand.splice(handIdx, 1)[0];
    state.library.unshift(name);
    addLog(`${name} → Top of Library`);
    render();
  }

  function adjustCounter(bfIdx: number, delta: number, type: string = '+1/+1'): void {
    pushUndo();
    const p = state.battlefield[bfIdx];
    const current = p.counters[type] || 0;
    const newVal = current + delta;
    if (newVal <= 0) {
      delete p.counters[type];
    } else {
      p.counters[type] = newVal;
    }
    const total = Object.values(p.counters).reduce((a, b) => a + b, 0);
    addLog(`${p.name}: ${type} → ${newVal <= 0 ? 0 : newVal} (${total} total counters)`);
    render();
  }

  function untapAll(): void {
    pushUndo();
    for (const p of state.battlefield) p.tapped = false;
    addLog('Untap all permanents');
    render();
  }

  // ─── Commander helpers ───

  function isCommander(name: string): boolean {
    if (!deck.boards.commander) return false;
    return deck.boards.commander.some((e) => e.name === name);
  }

  function castCommander(cmdIdx: number): void {
    pushUndo();
    const name = state.commandZone.splice(cmdIdx, 1)[0];
    const taxPaid = state.commanderTax;
    state.commanderTax += 2;
    addToBattlefield(name);
    addLog(`Cast ${name} from Command Zone (tax paid: ${taxPaid})`);
    render();
  }

  function bfToCommandZone(bfIdx: number): void {
    pushUndo();
    const p = state.battlefield.splice(bfIdx, 1)[0];
    state.commandZone.push(p.name);
    addLog(`${p.name} → Command Zone`);
    render();
  }

  function duplicateToken(bfIdx: number, count: number = 1): void {
    const original = state.battlefield[bfIdx];
    if (!original) return;
    pushUndo();
    for (let i = 0; i < count; i++) {
      const pos = autoPosition(original.isLand, original.isCreature);
      state.battlefield.push({
        id: nextId(),
        name: original.name,
        tapped: false,
        isLand: original.isLand,
        isCreature: original.isCreature,
        isToken: original.isToken,
        typeLine: original.typeLine,
        imgUrl: original.imgUrl,
        counters: {},
        power: original.power,
        toughness: original.toughness,
        x: pos.x,
        y: pos.y,
      });
    }
    addLog(`Created ${count}x copy of ${original.name}`);
    render();
  }

  function shuffleLibrary(): void {
    pushUndo();
    state.library = shuffle(state.library);
    addLog('Library shuffled');
    render();
  }

  // ─── Token Creation Modal ───

  function createTokensFromTemplate(template: { name: string; power?: string; toughness?: string; typeLine: string; imgUrl: string }, qty: number): void {
    pushUndo();
    for (let i = 0; i < qty; i++) {
      const pos = autoPosition(false, !!template.power);
      state.battlefield.push({
        id: nextId(),
        name: template.name,
        tapped: false,
        isLand: false,
        isCreature: !!template.power,
        isToken: true,
        typeLine: template.typeLine,
        imgUrl: template.imgUrl,
        counters: {},
        power: template.power,
        toughness: template.toughness,
        x: pos.x,
        y: pos.y,
      });
    }
    addLog(`Created ${qty}x ${template.name}${template.power && template.toughness ? ` ${template.power}/${template.toughness}` : ''} token${qty > 1 ? 's' : ''}`);
    render();
  }

  function showTokenCreationModal(): void {
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) modalOverlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-token-modal';
    modal.style.maxWidth = '560px';

    const title = document.createElement('div');
    title.className = 'gf-zone-modal-title';
 title.textContent = 'Create Token';
    modal.appendChild(title);

    // ── Collect ALL available tokens: from deck oracle text + battlefield ──
    const allTokens = new Map<string, { name: string; power?: string; toughness?: string; typeLine: string; imgUrl: string; source: string }>();

    // 1) Scan entire deck for token-producing cards
    const allDeckEntries = [...(deck.boards.mainboard || []), ...(deck.boards.commander || []), ...(deck.boards.sideboard || [])];
    for (const entry of allDeckEntries) {
      const c = getCard(entry.name, cardByName);
      if (c?.oracle_text) {
        const detected = extractTokensFromOracle(c.oracle_text);
        for (const dt of detected) {
          const key = dt.power ? `${dt.name}-${dt.power}/${dt.toughness}` : dt.name;
          if (!allTokens.has(key)) {
            allTokens.set(key, {
              name: dt.name,
              power: dt.power,
              toughness: dt.toughness,
              typeLine: dt.typeLine,
              imgUrl: tokenImageCache.get(dt.name) || '',
              source: entry.name,
            });
          }
        }
      }
    }

    // 2) Also include tokens already on the battlefield (in case user created custom ones)
    for (const p of state.battlefield) {
      if (p.isToken) {
        const key = p.power ? `${p.name}-${p.power}/${p.toughness}` : p.name;
        if (!allTokens.has(key)) {
          allTokens.set(key, { name: p.name, power: p.power, toughness: p.toughness, typeLine: p.typeLine, imgUrl: p.imgUrl, source: 'Battlefield' });
        }
      }
    }

    // ── Render token grid ──
    if (allTokens.size > 0) {
      const gridLabel = document.createElement('div');
      gridLabel.className = 'gf-quick-pick-label';
      gridLabel.textContent = `Tokens in your deck (${allTokens.size}) — click to create, shift+click for 5:`;
      modal.appendChild(gridLabel);

      const tokenGrid = document.createElement('div');
      tokenGrid.className = 'gf-token-grid';

      for (const [, tmpl] of allTokens) {
        const tokenCard = document.createElement('div');
        tokenCard.className = 'gf-token-grid-card';
        tokenCard.title = `${tmpl.name}${tmpl.power ? ` ${tmpl.power}/${tmpl.toughness}` : ''} — from ${tmpl.source}\nClick = 1, Shift+Click = 5`;

        if (tmpl.imgUrl) {
          const img = document.createElement('img');
          img.src = tmpl.imgUrl;
          img.alt = tmpl.name;
          img.loading = 'lazy';
          tokenCard.appendChild(img);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'gf-token-grid-placeholder';
          placeholder.textContent = tmpl.name;
          tokenCard.appendChild(placeholder);
        }

        // Label below image
        const label = document.createElement('div');
        label.className = 'gf-token-grid-label';
        label.textContent = tmpl.power ? `${tmpl.name} ${tmpl.power}/${tmpl.toughness}` : tmpl.name;
        tokenCard.appendChild(label);

        tokenCard.addEventListener('click', (e) => {
          const count = e.shiftKey ? 5 : 1;
          const imgUrl = tokenImageCache.get(tmpl.name) || tmpl.imgUrl;
          createTokensFromTemplate({ name: tmpl.name, power: tmpl.power, toughness: tmpl.toughness, typeLine: tmpl.typeLine, imgUrl }, count);
          // Async fetch if no image
          if (!imgUrl) {
            fetchTokenImage(tmpl.name).then(url => {
              if (url) {
                for (const bf of state.battlefield) {
                  if (bf.isToken && bf.name === tmpl.name && !bf.imgUrl) bf.imgUrl = url;
                }
                render();
              }
            });
          }
          modalOverlay.remove();
        });

        tokenGrid.appendChild(tokenCard);
      }

      modal.appendChild(tokenGrid);
    } else {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'color:#94a3b8;font-size:0.82rem;padding:12px 0;text-align:center;';
      emptyMsg.textContent = 'No token-producing cards detected in this deck.';
      modal.appendChild(emptyMsg);
    }

    // ── Custom Token (collapsible) ──
    const customToggle = document.createElement('button');
    customToggle.className = 'btn gf-btn';
    customToggle.style.cssText = 'margin-top:12px;width:100%;font-size:0.78rem;';
    customToggle.textContent = '+ Custom Token';
    const customSection = document.createElement('div');
    customSection.style.display = 'none';
    customToggle.addEventListener('click', () => {
      customSection.style.display = customSection.style.display === 'none' ? 'block' : 'none';
      customToggle.textContent = customSection.style.display === 'none' ? '+ Custom Token' : '− Custom Token';
      if (customSection.style.display !== 'none') {
        setTimeout(() => (document.getElementById('_tkName') as HTMLInputElement)?.focus(), 50);
      }
    });
    modal.appendChild(customToggle);

    const fields: { label: string; id: string; type: string; placeholder: string }[] = [
      { label: 'Name', id: '_tkName', type: 'text', placeholder: 'e.g. Soldier, Treasure' },
      { label: 'Power', id: '_tkPower', type: 'text', placeholder: 'e.g. 1, *' },
      { label: 'Toughness', id: '_tkToughness', type: 'text', placeholder: 'e.g. 1, *' },
      { label: 'Creature Type', id: '_tkType', type: 'text', placeholder: 'e.g. Creature — Soldier' },
      { label: 'Quantity', id: '_tkQty', type: 'number', placeholder: '1' },
    ];

    for (const f of fields) {
      const lbl = document.createElement('label');
      lbl.className = 'gf-token-label';
      lbl.textContent = f.label;
      customSection.appendChild(lbl);
      const inp = document.createElement('input');
      inp.type = f.type;
      inp.id = f.id;
      inp.className = 'gf-token-input';
      inp.placeholder = f.placeholder;
      if (f.id === '_tkQty') { inp.min = '1'; inp.max = '20'; inp.value = '1'; }
      customSection.appendChild(inp);
    }

    const customActions = document.createElement('div');
    customActions.className = 'gf-token-actions';
    const customCreateBtn = document.createElement('button');
    customCreateBtn.className = 'btn gf-btn';
    customCreateBtn.style.background = 'var(--cobalt, #c9a84c)';
    customCreateBtn.style.color = '#000';
    customCreateBtn.textContent = 'Create Custom';
    customCreateBtn.addEventListener('click', () => {
      const name = (document.getElementById('_tkName') as HTMLInputElement)?.value?.trim() || 'Token';
      const power = (document.getElementById('_tkPower') as HTMLInputElement)?.value?.trim() || undefined;
      const toughness = (document.getElementById('_tkToughness') as HTMLInputElement)?.value?.trim() || undefined;
      const typeLine = (document.getElementById('_tkType') as HTMLInputElement)?.value?.trim() || (power ? 'Creature — Token' : 'Token');
      const qty = Math.max(1, Math.min(20, parseInt((document.getElementById('_tkQty') as HTMLInputElement)?.value || '1', 10) || 1));
      const cachedImg = tokenImageCache.get(name) || '';
      createTokensFromTemplate({ name, power, toughness, typeLine, imgUrl: cachedImg }, qty);
      if (!cachedImg) {
        fetchTokenImage(name).then(url => {
          if (url) {
            for (const bf of state.battlefield) {
              if (bf.isToken && bf.name === name && !bf.imgUrl) bf.imgUrl = url;
            }
            render();
          }
        });
      }
      modalOverlay.remove();
    });
    customActions.appendChild(customCreateBtn);
    customSection.appendChild(customActions);
    modal.appendChild(customSection);

    // ── Close button ──
    const closeActions = document.createElement('div');
    closeActions.className = 'gf-token-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn gf-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => modalOverlay.remove());
    closeActions.appendChild(closeBtn);
    modal.appendChild(closeActions);

    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
  }

  function createToken(): void {
    showTokenCreationModal();
  }

  // ─── Library Search ───

  function showLibrarySearch(): void {
    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) modalOverlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-search-modal';

    const titleEl = document.createElement('div');
    titleEl.className = 'gf-zone-modal-title';
    titleEl.textContent = `Search Library (${state.library.length} cards)`;
    modal.appendChild(titleEl);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'gf-search-input';
    searchInput.placeholder = 'Type to filter cards...';
    modal.appendChild(searchInput);

    const grid = document.createElement('div');
    grid.className = 'gf-zone-modal-grid';
    modal.appendChild(grid);

    function renderSearchResults(filter: string): void {
      grid.textContent = '';
      const indexed = state.library.map((name, idx) => ({ name, idx }));
      const filtered = filter
        ? indexed.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
        : indexed;

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#94a3b8;padding:16px;text-align:center;grid-column:1/-1;';
        empty.textContent = filter ? 'No cards match.' : 'Library is empty.';
        grid.appendChild(empty);
        return;
      }

      for (const { name, idx } of filtered) {
        const cardEl = document.createElement('div');
        cardEl.className = 'gf-zone-modal-card';
        cardEl.title = `Left-click: → Hand | Right-click: more options`;

        const imgUrl = getImgUrl(name, cardByName);
        if (imgUrl) {
          const img = document.createElement('img');
          img.src = imgUrl;
          img.alt = name;
          img.loading = 'lazy';
          cardEl.appendChild(img);
        } else {
          cardEl.textContent = name;
          cardEl.style.cssText = 'font-size:0.72rem;color:#94a3b8;padding:8px;background:rgba(255,255,255,0.04);min-height:60px;display:flex;align-items:center;justify-content:center;';
        }

        attachPreview(cardEl, name);

        // Left-click → Hand (default) + auto-shuffle
        cardEl.addEventListener('click', () => {
          pushUndo();
          state.library.splice(idx, 1);
          state.hand.push(name);
          state.library = shuffle(state.library);
          addLog(`Searched: ${name} → Hand (library shuffled)`);
          modalOverlay.remove();
          render();
        });

        // Right-click → context menu with destinations
        cardEl.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          showCtxMenu(ev, [
            { label: '→ Hand (shuffle)', action: () => {
              pushUndo();
              state.library.splice(idx, 1);
              state.hand.push(name);
              state.library = shuffle(state.library);
              addLog(`Searched: ${name} → Hand (library shuffled)`);
              modalOverlay.remove();
              render();
            }},
            { label: '→ Battlefield (shuffle)', action: () => {
              pushUndo();
              state.library.splice(idx, 1);
              addToBattlefield(name);
              state.library = shuffle(state.library);
              addLog(`Searched: ${name} → Battlefield (library shuffled)`);
              modalOverlay.remove();
              render();
            }},
            { label: '→ Graveyard (shuffle)', action: () => {
              pushUndo();
              state.library.splice(idx, 1);
              state.graveyard.push(name);
              state.library = shuffle(state.library);
              addLog(`Searched: ${name} → Graveyard (library shuffled)`);
              modalOverlay.remove();
              render();
            }},
            { label: '→ Top of Library (no shuffle)', action: () => {
              pushUndo();
              state.library.splice(idx, 1);
              state.library.unshift(name);
              addLog(`Searched: ${name} → Top of Library`);
              modalOverlay.remove();
              render();
            }},
          ]);
        });

        grid.appendChild(cardEl);
      }
    }

    searchInput.addEventListener('input', () => {
      renderSearchResults(searchInput.value);
    });

    renderSearchResults('');

    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
    setTimeout(() => searchInput.focus(), 50);
  }

  // ─── Library Top N ───

  function showTopNModal(): void {
    // Phase 1: Ask how many cards to look at
    const phase1Overlay = document.createElement('div');
    phase1Overlay.className = 'gf-zone-modal-overlay';
    phase1Overlay.addEventListener('click', (e) => {
      if (e.target === phase1Overlay) phase1Overlay.remove();
    });

    const phase1Modal = document.createElement('div');
    phase1Modal.className = 'gf-zone-modal gf-topn-modal';

    const p1Title = document.createElement('div');
    p1Title.className = 'gf-zone-modal-title';
    p1Title.textContent = 'Look at Top N Cards';
    phase1Modal.appendChild(p1Title);

    const p1Label = document.createElement('label');
    p1Label.className = 'gf-token-label';
    p1Label.textContent = `How many? (1-${Math.min(10, state.library.length)})`;
    phase1Modal.appendChild(p1Label);

    const p1Input = document.createElement('input');
    p1Input.type = 'number';
    p1Input.className = 'gf-token-input';
    p1Input.min = '1';
    p1Input.max = String(Math.min(10, state.library.length));
    p1Input.value = String(Math.min(3, state.library.length));
    phase1Modal.appendChild(p1Input);

    const p1Actions = document.createElement('div');
    p1Actions.className = 'gf-token-actions';

    const p1Cancel = document.createElement('button');
    p1Cancel.className = 'btn gf-btn';
    p1Cancel.textContent = 'Cancel';
    p1Cancel.addEventListener('click', () => phase1Overlay.remove());

    const p1Look = document.createElement('button');
    p1Look.className = 'btn gf-btn';
    p1Look.style.background = 'var(--cobalt, #c9a84c)';
    p1Look.style.color = '#000';
    p1Look.textContent = 'Look';
    p1Look.addEventListener('click', () => {
      const n = Math.max(1, Math.min(Math.min(10, state.library.length), parseInt(p1Input.value, 10) || 1));
      phase1Overlay.remove();
      showTopNPhase2(n);
    });

    p1Actions.appendChild(p1Cancel);
    p1Actions.appendChild(p1Look);
    phase1Modal.appendChild(p1Actions);

    phase1Overlay.appendChild(phase1Modal);
    overlay.appendChild(phase1Overlay);
    setTimeout(() => { p1Input.focus(); p1Input.select(); }, 50);
  }

  function showTopNPhase2(n: number): void {
    // Take top N cards from library
    const topCards = state.library.slice(0, n);
    // Track each card's order and destination
    const cardStates: { name: string; dest: 'top' | 'bottom' | 'graveyard' }[] =
      topCards.map((name) => ({ name, dest: 'top' }));

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'gf-zone-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'gf-zone-modal gf-topn-modal';
    modal.style.maxWidth = '520px';

    const titleEl = document.createElement('div');
    titleEl.className = 'gf-zone-modal-title';
    titleEl.textContent = `Top ${n} Cards — Reorder & Place`;
    modal.appendChild(titleEl);

    const listEl = document.createElement('div');
    listEl.className = 'gf-topn-list';
    modal.appendChild(listEl);

    function renderTopNList(): void {
      listEl.textContent = '';
      for (let i = 0; i < cardStates.length; i++) {
        const cs = cardStates[i];
        const row = document.createElement('div');
        row.className = 'gf-topn-row';

        // Card image thumbnail
        const thumb = document.createElement('div');
        thumb.className = 'gf-topn-thumb';
        const imgUrl = getImgUrl(cs.name, cardByName);
        if (imgUrl) {
          const img = document.createElement('img');
          img.src = imgUrl;
          img.alt = cs.name;
          thumb.appendChild(img);
        } else {
          thumb.textContent = cs.name.slice(0, 10);
        }
        attachPreview(thumb, cs.name);
        row.appendChild(thumb);

        // Name
        const nameEl = document.createElement('span');
        nameEl.className = 'gf-topn-name';
        nameEl.textContent = cs.name;
        row.appendChild(nameEl);

        // Up/Down reorder
        const reorder = document.createElement('div');
        reorder.className = 'gf-topn-reorder';
        if (i > 0) {
          const upBtn = document.createElement('button');
          upBtn.className = 'btn gf-btn-sm';
          upBtn.textContent = '▲';
          upBtn.title = 'Move up';
          upBtn.addEventListener('click', () => {
            [cardStates[i - 1], cardStates[i]] = [cardStates[i], cardStates[i - 1]];
            renderTopNList();
          });
          reorder.appendChild(upBtn);
        }
        if (i < cardStates.length - 1) {
          const downBtn = document.createElement('button');
          downBtn.className = 'btn gf-btn-sm';
          downBtn.textContent = '▼';
          downBtn.title = 'Move down';
          downBtn.addEventListener('click', () => {
            [cardStates[i], cardStates[i + 1]] = [cardStates[i + 1], cardStates[i]];
            renderTopNList();
          });
          reorder.appendChild(downBtn);
        }
        row.appendChild(reorder);

        // Destination radio buttons
        const destEl = document.createElement('div');
        destEl.className = 'gf-topn-dest';
        for (const d of ['top', 'bottom', 'graveyard'] as const) {
          const label = document.createElement('label');
          label.className = `gf-topn-dest-label${cs.dest === d ? ' active' : ''}`;
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = `topn-dest-${i}`;
          radio.value = d;
          radio.checked = cs.dest === d;
          radio.addEventListener('change', () => { cs.dest = d; renderTopNList(); });
          label.appendChild(radio);
          label.appendChild(document.createTextNode(d === 'top' ? 'Top' : d === 'bottom' ? 'Bottom' : 'Graveyard'));
          destEl.appendChild(label);
        }
        row.appendChild(destEl);

        listEl.appendChild(row);
      }
    }

    renderTopNList();

    const actions = document.createElement('div');
    actions.className = 'gf-token-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn gf-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => modalOverlay.remove());

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn gf-btn';
    confirmBtn.style.background = 'var(--cobalt, #c9a84c)';
    confirmBtn.style.color = '#000';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => {
      pushUndo();
      // Remove top N from library
      state.library.splice(0, n);
      // Process destinations in order
      const toTop: string[] = [];
      const toBottom: string[] = [];
      for (const cs of cardStates) {
        if (cs.dest === 'top') {
          toTop.push(cs.name);
        } else if (cs.dest === 'bottom') {
          toBottom.push(cs.name);
        } else {
          state.graveyard.push(cs.name);
        }
      }
      // Put "top" cards on top in shown order
      state.library.unshift(...toTop);
      // Put "bottom" cards on bottom
      state.library.push(...toBottom);

      const summary = cardStates.map((cs) => `${cs.name} → ${cs.dest}`).join(', ');
      addLog(`Top ${n}: ${summary}`);
      modalOverlay.remove();
      render();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    modalOverlay.appendChild(modal);
    overlay.appendChild(modalOverlay);
  }

  function showKeybindsHelp(): void {
    const bindings: [string, string][] = [
      ['Space', 'Next Phase'],
      ['D', 'Draw a Card'],
      ['U', 'Untap All Permanents'],
      ['T', 'Create Token (Custom)'],
      ['S', 'Search Library'],
      ['L', 'Look at Top N Cards'],
      ['Z', 'Undo Last Action'],
      ['Ctrl+Z', 'Undo Last Action'],
      ['G', 'Open Graveyard'],
      ['X', 'Open Exile'],
      ['Esc', 'Close / Exit'],
      ['?', 'Show This Help'],
    ];
    const tips: string[] = [
      'Click a card in hand to play it',
      'Click a permanent to tap/untap',
      'Right-click cards for more options (counters, move)',
      'Drag cards between zones',
      'Drag permanents to reposition on battlefield',
      'Click the life total to type a custom value',
      'Commanders auto-return to Command Zone when killed/exiled',
      'Commander tax increases by 2 each time you cast from Command Zone',
      'Search (S) auto-shuffles after picking a card',
      'Typed counters: +1/+1, -1/-1, loyalty, charge, shield, lore',
    ];

    const helpOverlay = document.createElement('div');
    helpOverlay.className = 'gf-help-overlay';
    helpOverlay.addEventListener('click', (e) => {
      if (e.target === helpOverlay) helpOverlay.remove();
    });

    const modal = document.createElement('div');
    modal.className = 'gf-help-modal';

    const title = document.createElement('h2');
    title.className = 'gf-help-title';
    title.textContent = 'Keyboard Shortcuts';
    modal.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'gf-help-grid';
    for (const [key, desc] of bindings) {
      const keyEl = document.createElement('kbd');
      keyEl.className = 'gf-help-key';
      keyEl.textContent = key;
      const descEl = document.createElement('span');
      descEl.className = 'gf-help-desc';
      descEl.textContent = desc;
      grid.appendChild(keyEl);
      grid.appendChild(descEl);
    }
    modal.appendChild(grid);

    const tipsTitle = document.createElement('h3');
    tipsTitle.className = 'gf-help-subtitle';
    tipsTitle.textContent = 'Tips';
    modal.appendChild(tipsTitle);

    const tipList = document.createElement('ul');
    tipList.className = 'gf-help-tips';
    for (const tip of tips) {
      const li = document.createElement('li');
      li.textContent = tip;
      tipList.appendChild(li);
    }
    modal.appendChild(tipList);

    const closeBtn2 = document.createElement('button');
    closeBtn2.className = 'btn gf-btn';
    closeBtn2.textContent = 'Close';
    closeBtn2.style.marginTop = '12px';
    closeBtn2.addEventListener('click', () => helpOverlay.remove());
    modal.appendChild(closeBtn2);

    helpOverlay.appendChild(modal);
    overlay.appendChild(helpOverlay);
  }

  function mulliganHand(): void {
    pushUndo();
    // Gather all non-commander cards back into library
    const all = [...state.library, ...state.hand];
    state.library = shuffle(all);
    state.hand = state.library.splice(0, 7);
    state.log = ['Mulligan taken. New hand drawn.'];
    state.turn = 1;
    state.phase = 'main1';
    state.battlefield = [];
    state.graveyard = [];
    state.exile = [];
    state.landPlayedThisTurn = false;
    state.lifeTotal = 40;
    state.commanderTax = 0;
    state.poisonCounters = 0;
    // Restore commanders to command zone
    const commanderNames: string[] = [];
    if (deck.boards.commander) {
      for (const entry of deck.boards.commander) {
        for (let i = 0; i < entry.qty; i++) commanderNames.push(entry.name);
      }
    }
    state.commandZone = commanderNames;
    render();
  }

  function resetGame(): void {
    const undoStack = state.undoStack;
    state = initState(deck);
    state.undoStack = undoStack;
    render();
  }

  // ─── Drag Drop Handlers ───

  let bfElement: HTMLElement | null = null; // battlefield element reference for coordinate calculation

  function handleDrop(targetZone: GfZone, payload: GfDragPayload, dropEvent?: DragEvent): void {
    if (payload.zone === targetZone) return; // no-op same zone
    pushUndo();

    const name = payload.cardName;

    // Remove from source
    if (payload.zone === 'hand') {
      state.hand.splice(payload.index, 1);
    } else if (payload.zone === 'battlefield') {
      state.battlefield.splice(payload.index, 1);
    } else if (payload.zone === 'graveyard') {
      state.graveyard.splice(payload.index, 1);
    } else if (payload.zone === 'exile') {
      state.exile.splice(payload.index, 1);
    } else if (payload.zone === 'commandZone') {
      state.commandZone.splice(payload.index, 1);
    }

    // Add to target
    if (targetZone === 'battlefield') {
      // Check land limit if from hand
      if (payload.zone === 'hand') {
        const cls = classifyCard(name, cardByName);
        if (cls.isLand) state.landPlayedThisTurn = true;
      }
      // Calculate position from drop coordinates if available
      let posX: number | undefined;
      let posY: number | undefined;
      if (dropEvent && bfElement) {
        const rect = bfElement.getBoundingClientRect();
        posX = Math.max(0, Math.min(88, ((dropEvent.clientX - rect.left) / rect.width) * 100));
        posY = Math.max(0, Math.min(85, ((dropEvent.clientY - rect.top) / rect.height) * 100));
      }
      addToBattlefield(name, posX, posY);
    } else if (targetZone === 'hand') {
      state.hand.push(name);
    } else if (targetZone === 'graveyard') {
      state.graveyard.push(name);
    } else if (targetZone === 'exile') {
      state.exile.push(name);
    } else if (targetZone === 'library') {
      state.library.unshift(name);
    } else if (targetZone === 'commandZone') {
      state.commandZone.push(name);
    }

    addLog(`${name}: ${payload.zone} → ${targetZone}`);
    render();
  }

  // ─── Free-Form Battlefield Card Rendering ───

  function renderBfCard(p: GoldfishPermanent, bfIdx: number, bfContainer: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = `gf-bf-card${p.tapped ? ' gf-bf-tapped' : ''}`;
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;
    el.setAttribute('data-card-name', p.name);

    const card = document.createElement('div');
    card.className = `gf-card${p.isToken ? ' gf-token' : ''}`;
    card.title = p.name;

    if (p.imgUrl) {
      const img = document.createElement('img');
      img.src = p.imgUrl;
      img.alt = p.name;
      img.loading = 'lazy';
      card.appendChild(img);
    } else {
      card.textContent = p.isToken ? 'Token' : p.name.slice(0, 12);
    }

    // Counter badges — positioned around the card edges
    const counterKeys = Object.keys(p.counters);
    if (counterKeys.length > 0) {
      // Positions cycle around the card: top, right, bottom, left, then repeat with offset
      const positions = [
        'gf-cbpos-top', 'gf-cbpos-right', 'gf-cbpos-bottom', 'gf-cbpos-left',
        'gf-cbpos-top2', 'gf-cbpos-right2', 'gf-cbpos-bottom2', 'gf-cbpos-left2',
      ];
      for (let ci = 0; ci < counterKeys.length; ci++) {
        const cType = counterKeys[ci];
        const badge = document.createElement('span');
        const posClass = positions[ci % positions.length];
        const cssType = cType.replace(/\+/g, 'p').replace(/-/g, 'm').replace(/[^a-zA-Z0-9]/g, '');
        badge.className = `gf-counter-badge gf-counter-${cssType} ${posClass}`;
        badge.textContent = `${p.counters[cType]} ${cType}`;
        badge.title = `${p.counters[cType]} ${cType} counter${p.counters[cType] !== 1 ? 's' : ''}`;
        el.appendChild(badge);
      }
    }

    // Coach role badge
    if (coach?.enabled) {
      const roleBadge = getRoleBadge(p.name, coach);
      if (roleBadge) el.appendChild(roleBadge);
    }

    // P/T badge for tokens
    if (p.isToken && p.power != null && p.toughness != null) {
      const ptBadge = document.createElement('span');
      ptBadge.className = 'gf-pt-badge';
      ptBadge.textContent = `${p.power}/${p.toughness}`;
      card.appendChild(ptBadge);
    }

    // Right-click = context menu
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items: GfCtxItem[] = [
        { label: p.tapped ? 'Untap' : 'Tap', action: () => tapPermanent(bfIdx) },
      ];
      // Add Counter submenu
      const counterTypes = ['+1/+1', '-1/-1', 'loyalty', 'charge', 'shield', 'lore'];
      items.push({ label: '⊕ Add Counter...', action: () => {}, divider: true });
      for (const ct of counterTypes) {
        items.push({ label: `  + ${ct}`, action: () => adjustCounter(bfIdx, 1, ct) });
      }
      items.push({ label: '  + Custom...', action: () => {
        const name = prompt('Counter type name:');
        if (name?.trim()) adjustCounter(bfIdx, 1, name.trim());
      }});
      // Remove Counter for existing types
      const existingCounters = Object.keys(p.counters);
      if (existingCounters.length > 0) {
        items.push({ label: '⊖ Remove Counter...', action: () => {}, divider: true });
        for (const ct of existingCounters) {
          items.push({ label: `  - ${ct} (${p.counters[ct]})`, action: () => adjustCounter(bfIdx, -1, ct) });
        }
      }
      // Auto-detect tokens this card creates
      if (!p.isToken) {
        const cardData = getCard(p.name, cardByName);
        if (cardData?.oracle_text) {
          const detectedTokens = extractTokensFromOracle(cardData.oracle_text);
          if (detectedTokens.length > 0) {
 items.push({ label: 'Create Token...', action: () => {}, divider: true });
            for (const dt of detectedTokens) {
              const dtLabel = dt.power ? `  ${dt.name} ${dt.power}/${dt.toughness}` : `  ${dt.name}`;
              items.push({ label: dtLabel, action: () => {
                const imgUrl = tokenImageCache.get(dt.name) || '';
                createTokensFromTemplate({
                  name: dt.name,
                  power: dt.power,
                  toughness: dt.toughness,
                  typeLine: dt.typeLine,
                  imgUrl,
                }, 1);
                if (!imgUrl) {
                  fetchTokenImage(dt.name).then(url => {
                    if (url) {
                      for (const bf of state.battlefield) {
                        if (bf.isToken && bf.name === dt.name && !bf.imgUrl) bf.imgUrl = url;
                      }
                      render();
                    }
                  });
                }
              }});
            }
          }
        }
      }
      // Copy Token (tokens only)
      if (p.isToken) {
        items.push({ label: 'Copy Token', action: () => duplicateToken(bfIdx, 1), divider: true });
        items.push({ label: 'Copy x5', action: () => duplicateToken(bfIdx, 5) });
      }
      items.push({ label: '→ Graveyard', action: () => bfToGraveyard(bfIdx), divider: true, danger: true });
      items.push({ label: '→ Exile', action: () => bfToExile(bfIdx), danger: true });
      items.push({ label: '→ Hand (Bounce)', action: () => bfToHand(bfIdx) });
      items.push({ label: '→ Top of Library', action: () => bfToLibrary(bfIdx) });
      if (isCommander(p.name)) {
        items.push({ label: '→ Command Zone', action: () => bfToCommandZone(bfIdx) });
      }
      showCtxMenu(e, items);
    });

    attachPreview(card, p.name);

    // Free-form mouse drag to reposition
    let isDragging = false;
    let hasMoved = false;
    let offsetX = 0;
    let offsetY = 0;

    card.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // left-click only
      e.preventDefault();
      isDragging = true;
      hasMoved = false;
      el.classList.add('gf-moving');
      el.style.zIndex = '100';

      const rect = el.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      const onMouseMove = (me: MouseEvent) => {
        if (!isDragging) return;
        hasMoved = true;
        const bfRect = bfContainer.getBoundingClientRect();
        const newLeft = me.clientX - bfRect.left - offsetX;
        const newTop = me.clientY - bfRect.top - offsetY;
        el.style.left = `${newLeft}px`;
        el.style.top = `${newTop}px`;
      };

      const onMouseUp = (me: MouseEvent) => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (!isDragging) return;
        isDragging = false;
        el.classList.remove('gf-moving');
        el.style.zIndex = '';

        if (hasMoved) {
          // Commit position as percentage
          const bfRect = bfContainer.getBoundingClientRect();
          const finalLeft = me.clientX - bfRect.left - offsetX;
          const finalTop = me.clientY - bfRect.top - offsetY;
          const pctX = Math.max(0, Math.min(92, (finalLeft / bfRect.width) * 100));
          const pctY = Math.max(0, Math.min(90, (finalTop / bfRect.height) * 100));
          pushUndo();
          state.battlefield[bfIdx].x = pctX;
          state.battlefield[bfIdx].y = pctY;
          render();
        } else {
          // No movement — treat as tap/untap click
          tapPermanent(bfIdx);
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    el.appendChild(card);
    return el;
  }

  // ─── Main Render ───

  function render(): void {
    hideCtxMenu();
    hideHoverPreview();
    overlay.textContent = '';
    // Re-add context menu element to overlay
    if (ctxMenuEl) overlay.appendChild(ctxMenuEl);

    // ── Top bar ──
    const topBar = document.createElement('div');
    topBar.className = 'gf-topbar';

    const turnInfo = document.createElement('span');
    turnInfo.className = 'gf-turn';
    turnInfo.textContent = `Turn ${state.turn}`;

    const phaseInfo = document.createElement('span');
    phaseInfo.className = 'gf-phase';
    phaseInfo.textContent = PHASE_LABELS[state.phase];

    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn gf-btn';
    nextBtn.textContent = 'Next Phase';
    nextBtn.addEventListener('click', nextPhase);

    const drawBtn = document.createElement('button');
    drawBtn.className = 'btn gf-btn';
    drawBtn.textContent = 'Draw';
    drawBtn.addEventListener('click', () => { pushUndo(); drawCard(); render(); });

    const libDrop = document.createElement('span');
    libDrop.className = 'gf-info gf-lib-drop';
    libDrop.textContent = `Library: ${state.library.length}`;
    setupDropZone(libDrop, (payload, e) => handleDrop('library', payload, e));

    const lifeDisplay = document.createElement('span');
    lifeDisplay.className = 'gf-life';
    lifeDisplay.textContent = `Life: ${state.lifeTotal}`;
    lifeDisplay.title = 'Click to set life total';
    lifeDisplay.style.cursor = 'pointer';
    lifeDisplay.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'gf-life-input';
      input.value = String(state.lifeTotal);
      lifeDisplay.textContent = '';
      lifeDisplay.appendChild(input);
      input.focus();
      input.select();
      const commit = () => {
        const val = parseInt(input.value, 10);
        if (!isNaN(val)) {
          state.lifeTotal = val;
          addLog(`Life set to ${val}`);
        }
        render();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); render(); }
        e.stopPropagation();
      });
    });

    const lifeMinus = document.createElement('button');
    lifeMinus.className = 'btn gf-btn-sm';
    lifeMinus.textContent = '-1';
    lifeMinus.addEventListener('click', () => { state.lifeTotal--; render(); });

    const lifePlus = document.createElement('button');
    lifePlus.className = 'btn gf-btn-sm';
    lifePlus.textContent = '+1';
    lifePlus.addEventListener('click', () => { state.lifeTotal++; render(); });

    const undoBtn = document.createElement('button');
    undoBtn.className = 'btn gf-btn gf-btn-undo';
    undoBtn.textContent = 'Undo';
    undoBtn.disabled = state.undoStack.length === 0;
    undoBtn.addEventListener('click', performUndo);

    const untapBtn = document.createElement('button');
    untapBtn.className = 'btn gf-btn';
    untapBtn.textContent = 'Untap All';
    untapBtn.addEventListener('click', untapAll);

    const tokenBtn = document.createElement('button');
    tokenBtn.className = 'btn gf-btn';
    tokenBtn.textContent = 'Token';
    tokenBtn.title = 'Create Token (T)';
    tokenBtn.addEventListener('click', createToken);

    const searchBtn = document.createElement('button');
    searchBtn.className = 'btn gf-btn';
    searchBtn.textContent = 'Search';
    searchBtn.title = 'Search Library (S)';
    searchBtn.addEventListener('click', showLibrarySearch);

    const topNBtn = document.createElement('button');
    topNBtn.className = 'btn gf-btn';
    topNBtn.textContent = 'Top N';
    topNBtn.title = 'Look at Top N Cards (L)';
    topNBtn.addEventListener('click', () => { if (state.library.length > 0) showTopNModal(); });

    const shuffleBtn = document.createElement('button');
    shuffleBtn.className = 'btn gf-btn';
    shuffleBtn.textContent = 'Shuffle';
    shuffleBtn.title = 'Shuffle Library';
    shuffleBtn.addEventListener('click', shuffleLibrary);

    // Poison counter button
    const poisonBtn = document.createElement('button');
    poisonBtn.className = `btn gf-btn-sm gf-poison${state.poisonCounters >= 10 ? ' gf-poison-lethal' : ''}`;
    poisonBtn.textContent = state.poisonCounters > 0 ? `${state.poisonCounters}` : '+P';
    poisonBtn.title = `Poison counters: ${state.poisonCounters}`;
    poisonBtn.addEventListener('click', () => {
      pushUndo();
      state.poisonCounters++;
      if (state.poisonCounters >= 10) addLog(`Poison counters: ${state.poisonCounters} — LETHAL!`);
      else addLog(`Poison counters: ${state.poisonCounters}`);
      render();
    });
    poisonBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (state.poisonCounters > 0) {
        pushUndo();
        state.poisonCounters--;
        addLog(`Poison counters: ${state.poisonCounters}`);
        render();
      }
    });

    const mulliganBtn = document.createElement('button');
    mulliganBtn.className = 'btn gf-btn';
    mulliganBtn.textContent = 'Mulligan';
    mulliganBtn.addEventListener('click', mulliganHand);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn gf-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', resetGame);

    const helpBtn = document.createElement('button');
    helpBtn.className = 'btn gf-btn gf-btn-help';
    helpBtn.textContent = '?';
    helpBtn.title = 'Keyboard Shortcuts';
    helpBtn.addEventListener('click', showKeybindsHelp);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn gf-btn danger';
    closeBtn.textContent = 'Exit';
    closeBtn.addEventListener('click', cleanup);

    topBar.append(turnInfo, phaseInfo, nextBtn, drawBtn, libDrop, lifeDisplay, lifeMinus, lifePlus, poisonBtn, undoBtn, untapBtn, tokenBtn, searchBtn, topNBtn, shuffleBtn, mulliganBtn, resetBtn, helpBtn, closeBtn);

    // ── Main area ──
    const main = document.createElement('div');
    main.className = 'gf-main';

    // ── Battlefield (free-form canvas) ──
    const bfSection = document.createElement('div');
    bfSection.className = 'gf-zone gf-battlefield';
    bfElement = bfSection; // store reference for drop coordinate calculation

    const bfTitle = document.createElement('div');
    bfTitle.className = 'gf-zone-title gf-bf-title';
    bfTitle.textContent = `Battlefield (${state.battlefield.length})`;
    bfSection.appendChild(bfTitle);

    // Render each permanent as absolute-positioned card
    for (let i = 0; i < state.battlefield.length; i++) {
      bfSection.appendChild(renderBfCard(state.battlefield[i], i, bfSection));
    }

    // Battlefield is a drop zone for cards from other zones
    setupDropZone(bfSection, (payload, e) => handleDrop('battlefield', payload, e));

    main.appendChild(bfSection);

    // ── Hand ──
    const handSection = document.createElement('div');
    handSection.className = 'gf-zone gf-hand';
    setupDropZone(handSection, (payload, e) => handleDrop('hand', payload, e));

    const handTitle = document.createElement('div');
    handTitle.className = 'gf-zone-title';
    handTitle.textContent = `Hand (${state.hand.length})`;
    handSection.appendChild(handTitle);

    const handRow = document.createElement('div');
    handRow.className = 'gf-hand-row';

    for (let i = 0; i < state.hand.length; i++) {
      const name = state.hand[i];
      const card = document.createElement('div');
      card.className = 'gf-card gf-hand-card';
      card.title = `Click to play: ${name}`;
      card.setAttribute('data-card-name', name);

      const imgUrl = getImgUrl(name, cardByName);
      if (imgUrl) {
        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = name;
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        card.textContent = name.slice(0, 14);
      }

      card.addEventListener('click', () => playFromHand(i));
      card.addEventListener('contextmenu', ((idx: number, cardName: string) => (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const handItems: GfCtxItem[] = [
          { label: 'Play', action: () => playFromHand(idx) },
          { label: 'Discard', action: () => handToGraveyard(idx), divider: true },
          { label: '→ Exile', action: () => handToExile(idx) },
          { label: '→ Top of Library', action: () => handToLibrary(idx) },
        ];
        // Auto-detect tokens this card creates
        const handCardData = getCard(cardName, cardByName);
        if (handCardData?.oracle_text) {
          const handTokens = extractTokensFromOracle(handCardData.oracle_text);
          if (handTokens.length > 0) {
 handItems.push({ label: 'Create Token...', action: () => {}, divider: true });
            for (const dt of handTokens) {
              const dtLabel = dt.power ? `  ${dt.name} ${dt.power}/${dt.toughness}` : `  ${dt.name}`;
              handItems.push({ label: dtLabel, action: () => {
                const imgUrl = tokenImageCache.get(dt.name) || '';
                createTokensFromTemplate({
                  name: dt.name,
                  power: dt.power,
                  toughness: dt.toughness,
                  typeLine: dt.typeLine,
                  imgUrl,
                }, 1);
                if (!imgUrl) {
                  fetchTokenImage(dt.name).then(url => {
                    if (url) {
                      for (const bf of state.battlefield) {
                        if (bf.isToken && bf.name === dt.name && !bf.imgUrl) bf.imgUrl = url;
                      }
                      render();
                    }
                  });
                }
              }});
            }
          }
        }
        showCtxMenu(e, handItems);
      })(i, name));

      attachPreview(card, name);
      setupDrag(card, { zone: 'hand', index: i, cardName: name });
      handRow.appendChild(card);
    }

    handSection.appendChild(handRow);
    main.appendChild(handSection);

    // ── Side panel ──
    const sidePanel = document.createElement('div');
    sidePanel.className = 'gf-side';

    // Command Zone (only show if deck has commanders)
    if (state.commandZone.length > 0 || (deck.boards.commander && deck.boards.commander.length > 0)) {
      const czSection = document.createElement('div');
      czSection.className = 'gf-mini-zone gf-command-zone';
      setupDropZone(czSection, (payload, e) => handleDrop('commandZone', payload, e));

      const czTitle = document.createElement('div');
      czTitle.className = 'gf-zone-title';
 czTitle.textContent = ` Command Zone (${state.commandZone.length})`;
      if (state.commanderTax > 0) {
        const taxEl = document.createElement('span');
        taxEl.className = 'gf-commander-tax';
        taxEl.textContent = ` [Tax: +${state.commanderTax}]`;
        czTitle.appendChild(taxEl);
      }
      czSection.appendChild(czTitle);

      for (let i = 0; i < state.commandZone.length; i++) {
        const name = state.commandZone[i];
        const cmdCard = document.createElement('div');
        cmdCard.className = 'gf-commander-card';

        const imgUrl = getImgUrl(name, cardByName);
        if (imgUrl) {
          const img = document.createElement('img');
          img.src = imgUrl;
          img.alt = name;
          img.loading = 'lazy';
          img.style.cssText = 'width:100%;border-radius:4px;';
          cmdCard.appendChild(img);
        } else {
          cmdCard.textContent = name;
        }

        const taxLabel = document.createElement('div');
        taxLabel.className = 'gf-commander-tax-label';
        taxLabel.textContent = `Cast (tax: +${state.commanderTax})`;
        cmdCard.appendChild(taxLabel);

        attachPreview(cmdCard, name);
        setupDrag(cmdCard, { zone: 'commandZone', index: i, cardName: name });

        // Click to cast commander
        cmdCard.addEventListener('click', () => castCommander(i));

        // Right-click for context menu
        cmdCard.addEventListener('contextmenu', ((idx: number) => (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          showCtxMenu(e, [
            { label: `Cast (tax: +${state.commanderTax})`, action: () => castCommander(idx) },
            { label: '→ Graveyard', action: () => { pushUndo(); const n = state.commandZone.splice(idx, 1)[0]; state.graveyard.push(n); addLog(`${n} → Graveyard (from CZ)`); render(); }, divider: true },
            { label: '→ Exile', action: () => { pushUndo(); const n = state.commandZone.splice(idx, 1)[0]; state.exile.push(n); addLog(`${n} → Exile (from CZ)`); render(); } },
            { label: '→ Hand', action: () => { pushUndo(); const n = state.commandZone.splice(idx, 1)[0]; state.hand.push(n); addLog(`${n} → Hand (from CZ)`); render(); } },
          ]);
        })(i));

        czSection.appendChild(cmdCard);
      }

      sidePanel.appendChild(czSection);
    }

    // Library (physical pile)
    const libSection = document.createElement('div');
    libSection.className = 'gf-mini-zone gf-library-zone';
    setupDropZone(libSection, (payload, e) => handleDrop('library', payload, e));

    const libTitle = document.createElement('div');
    libTitle.className = 'gf-zone-title';
    libTitle.textContent = `Library (${state.library.length})`;
    libSection.appendChild(libTitle);

    // Visual card-back stack
    const libStack = document.createElement('div');
    libStack.className = 'gf-library-stack';
    // Show 3 stacked "card backs" if library has cards
    const stackCount = Math.min(3, state.library.length);
    for (let s = 0; s < stackCount; s++) {
      const cardBack = document.createElement('div');
      cardBack.className = 'gf-library-card-back';
      cardBack.style.transform = `translateY(${-s * 3}px) translateX(${s * 2}px)`;
      libStack.appendChild(cardBack);
    }
    if (state.library.length === 0) {
      const emptyLabel = document.createElement('div');
      emptyLabel.className = 'gf-library-empty';
      emptyLabel.textContent = 'Empty';
      libStack.appendChild(emptyLabel);
    }
    libSection.appendChild(libStack);

    // Right-click for Search, Top N, Shuffle
    libSection.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items: GfCtxItem[] = [
        { label: 'Search Library', action: () => showLibrarySearch() },
 { label: 'Look at Top N', action: () => { if (state.library.length > 0) showTopNModal(); } },
        { label: 'Shuffle', action: () => shuffleLibrary(), divider: true },
        { label: `Draw (${state.library.length} left)`, action: () => { pushUndo(); drawCard(); render(); } },
      ];
      showCtxMenu(e, items);
    });

    // Click to draw
    libSection.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.gf-zone-title')) return;
      pushUndo(); drawCard(); render();
    });

    sidePanel.appendChild(libSection);

    // Graveyard
    const gySection = document.createElement('div');
    gySection.className = 'gf-mini-zone';
    setupDropZone(gySection, (payload, e) => handleDrop('graveyard', payload, e));

    const gyTitle = document.createElement('div');
    gyTitle.className = 'gf-zone-title gf-expandable';
    gyTitle.textContent = `Graveyard (${state.graveyard.length})`;
    gyTitle.addEventListener('click', () => {
      if (state.graveyard.length > 0) showZoneModal('Graveyard', state.graveyard, 'graveyard');
    });
    gySection.appendChild(gyTitle);

    for (let i = Math.max(0, state.graveyard.length - 8); i < state.graveyard.length; i++) {
      const name = state.graveyard[i];
      const el = document.createElement('div');
      el.className = 'gf-mini-card';
      el.textContent = name;
      attachPreview(el, name);
      setupDrag(el, { zone: 'graveyard', index: i, cardName: name });
      el.addEventListener('contextmenu', ((idx: number) => (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e, [
          { label: '→ Hand', action: () => { pushUndo(); const n = state.graveyard.splice(idx, 1)[0]; state.hand.push(n); addLog(`${n} → Hand`); render(); } },
          { label: '→ Battlefield', action: () => { pushUndo(); const n = state.graveyard.splice(idx, 1)[0]; addToBattlefield(n); addLog(`${n} → Battlefield`); render(); } },
          { label: '→ Exile', action: () => { pushUndo(); const n = state.graveyard.splice(idx, 1)[0]; state.exile.push(n); addLog(`${n} → Exile`); render(); } },
        ]);
      })(i));
      gySection.appendChild(el);
    }

    if (state.graveyard.length > 8) {
      const more = document.createElement('div');
      more.className = 'muted';
      more.style.fontSize = '0.64rem';
      more.textContent = `... +${state.graveyard.length - 8} more`;
      gySection.appendChild(more);
    }
    sidePanel.appendChild(gySection);

    // Exile
    const exSection = document.createElement('div');
    exSection.className = 'gf-mini-zone';
    setupDropZone(exSection, (payload, e) => handleDrop('exile', payload, e));

    const exTitle = document.createElement('div');
    exTitle.className = 'gf-zone-title gf-expandable';
    exTitle.textContent = `Exile (${state.exile.length})`;
    exTitle.addEventListener('click', () => {
      if (state.exile.length > 0) showZoneModal('Exile', state.exile, 'exile');
    });
    exSection.appendChild(exTitle);

    for (let i = Math.max(0, state.exile.length - 5); i < state.exile.length; i++) {
      const name = state.exile[i];
      const el = document.createElement('div');
      el.className = 'gf-mini-card';
      el.textContent = name;
      attachPreview(el, name);
      setupDrag(el, { zone: 'exile', index: i, cardName: name });
      el.addEventListener('contextmenu', ((idx: number) => (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e, [
          { label: '→ Hand', action: () => { pushUndo(); const n = state.exile.splice(idx, 1)[0]; state.hand.push(n); addLog(`${n} → Hand`); render(); } },
          { label: '→ Battlefield', action: () => { pushUndo(); const n = state.exile.splice(idx, 1)[0]; addToBattlefield(n); addLog(`${n} → Battlefield`); render(); } },
        ]);
      })(i));
      exSection.appendChild(el);
    }
    sidePanel.appendChild(exSection);

    // Coach panel
    if (coach) renderCoachPanel(sidePanel, coach, state);

    // Log
    const logSection = document.createElement('div');
    logSection.className = 'gf-log';
    const logTitle = document.createElement('div');
    logTitle.className = 'gf-zone-title';
    logTitle.textContent = 'Game Log';
    logSection.appendChild(logTitle);

    const logScroll = document.createElement('div');
    logScroll.className = 'gf-log-scroll';
    for (const entry of state.log.slice(-30)) {
      const line = document.createElement('div');
      line.className = 'gf-log-entry';
      line.textContent = entry;
      logScroll.appendChild(line);
    }
    logSection.appendChild(logScroll);
    requestAnimationFrame(() => { logScroll.scrollTop = logScroll.scrollHeight; });
    sidePanel.appendChild(logSection);

    // Coach Widget (for panel-layout system)
    if (coach) {
      const coachWidgetContainer = document.createElement('div');
      coachWidgetContainer.id = 'goldfishCoachWidget';
      coachWidgetContainer.className = 'gf-coach-widget';
      renderCoachWidget(coachWidgetContainer, coach);
      sidePanel.appendChild(coachWidgetContainer);
    }

    main.appendChild(sidePanel);

    // Coach SVG lines overlay update
    if (coach) updateCoachLines(coach, state);

    overlay.appendChild(main);
    overlay.appendChild(topBar);
  }

  // ─── Keyboard Shortcuts ───
  overlay.tabIndex = 0;
  overlay.addEventListener('keydown', (e) => {
    // Ignore if context menu or modal open
    if (ctxMenuEl?.classList.contains('visible')) {
      if (e.key === 'Escape') { hideCtxMenu(); e.preventDefault(); }
      return;
    }
    if (zoneModalEl) {
      if (e.key === 'Escape') { hideZoneModal(); e.preventDefault(); }
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); nextPhase(); }
    if (e.key === 'Escape') cleanup();
    if (e.key === 'd' || e.key === 'D') { pushUndo(); drawCard(); render(); }
    if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); performUndo(); }
    if (e.key === 'z' || e.key === 'Z') { if (!e.ctrlKey && !e.metaKey) performUndo(); }
    if (e.key === 'u' || e.key === 'U') untapAll();
    if (e.key === 't' || e.key === 'T') createToken();
    if (e.key === 's' || e.key === 'S') showLibrarySearch();
    if (e.key === 'l' || e.key === 'L') { if (state.library.length > 0) showTopNModal(); }
    if (e.key === 'g' || e.key === 'G') { if (state.graveyard.length > 0) showZoneModal('Graveyard', state.graveyard, 'graveyard'); }
    if (e.key === 'x' || e.key === 'X') { if (state.exile.length > 0) showZoneModal('Exile', state.exile, 'exile'); }
    if (e.key === '?') showKeybindsHelp();
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
      if (coach) { coach.enabled = !coach.enabled; saveCoachPrefs(coach); render(); }
    }
  });

  // Close context menu on click outside
  overlay.addEventListener('click', () => { hideCtxMenu(); });

  document.body.appendChild(overlay);
  broadcastGoldfishStart(deck.name);
  overlay.focus();
  render();

  // Init SVG combo lines overlay (must run after first render so main element exists)
  if (coach) {
    const mainEl = overlay.querySelector('.gf-main') as HTMLElement | null;
    if (mainEl) initCoachLines(mainEl, coach);
  }

  // Pre-fetch token images for all token-producing cards in the deck
  const allDeckCards = [...(deck.boards.mainboard || []), ...(deck.boards.commander || [])];
  const prefetchTokenNames = new Set<string>();
  for (const entry of allDeckCards) {
    const c = getCard(entry.name, cardByName);
    if (c?.oracle_text) {
      const detected = extractTokensFromOracle(c.oracle_text);
      for (const dt of detected) prefetchTokenNames.add(dt.name);
    }
  }
  // Fire-and-forget fetches (rate limited by Scryfall, but fine for small sets)
  let delay = 0;
  for (const tName of prefetchTokenNames) {
    if (!tokenImageCache.has(tName)) {
      setTimeout(() => fetchTokenImage(tName), delay);
      delay += 100; // 100ms between requests to respect Scryfall rate limits
    }
  }
}
