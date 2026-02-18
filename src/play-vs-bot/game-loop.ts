/**
 * Game Loop — Connects Engine + Bot + UI.
 *
 * Handles the turn-by-turn loop:
 * - Human has priority → wait for UI input
 * - Bot has priority → query bot, show thinking, execute
 * - Phase changes → log and re-render
 * - Game over → show result screen
 */

import type { GameState, GameAction, Card, Permanent, Target, Ability } from '@mtg/game-engine';
import {
  Game,
  createInitialGameState,
  createPlayerState,
  setupNewGame,
  getLegalActionTypes,
  drawOpeningHand,
  autoPayCost,
  autoTapLandsForCost,
  parseManaCost,
  isCreature,
  parseCost,
  canPayAbilityCost,
} from '@mtg/game-engine';
import { HeuristicBot } from '@mtg/bot-core';
import { renderBoard, clearDomCache, type BoardCallbacks } from './board-renderer.ts';
import { logAction, logPhaseChange, logGameOver, logMessage } from './game-log.ts';

/** Common interface for any bot (Heuristic, ML, etc.) */
export interface BotInterface {
  readonly player: 0 | 1;
  chooseAction(state: GameState): GameAction;
}

export type ActionResolver = (action: GameAction) => void;

export class GameLoop {
  private game: Game;
  private bot: BotInterface;
  private humanPlayer: 0 | 1 = 0;
  private botPlayer: 0 | 1 = 1;
  private actionResolver: ActionResolver | null = null;
  private running = false;
  private lastPhase = '';
  private lastStep = '';
  private selectedHandCard: { card: Card; index: number } | null = null;
  private attackerSelection: string[] = [];
  private blockerAssignment: Map<string, string> = new Map(); // blockerId → attackerId
  private pendingBlocker: string | null = null; // blocker waiting for attacker assignment
  private inCombatSelection = false;
  private targetingMode = false;
  private targetingCard: Card | null = null;

  constructor(playerDeck: Card[], botDeck: Card[], playerCommander: Card, botCommander: Card, bot?: BotInterface) {
    const playerState = createPlayerState(0, 'You', playerDeck, playerCommander);
    const botState = createPlayerState(1, 'Bot', botDeck, botCommander);
    const initial = createInitialGameState(playerState, botState);
    this.game = new Game(initial);
    this.bot = bot ?? new HeuristicBot(this.botPlayer);
  }

  /** Get the current game state */
  getState(): GameState {
    return this.game.getState();
  }

  /** Start the main game loop */
  async start(): Promise<void> {
    this.running = true;
    clearDomCache();

    // Show the game board
    const container = document.getElementById('game-container');
    if (container) container.style.display = '';

    logMessage('Game started!');
    this.render();

    // Main loop
    await this.loop();
  }

  /** The core async game loop */
  private async loop(): Promise<void> {
    let iterations = 0;
    const MAX_ITERATIONS = 10000; // Safety limit to prevent infinite loops
    
    while (this.running && !this.game.isOver() && iterations < MAX_ITERATIONS) {
      iterations++;
      const state = this.game.getState();

      // Log phase changes
      const phaseKey = `${state.phase}:${state.step}`;
      if (phaseKey !== this.lastPhase) {
        this.lastPhase = phaseKey;
        logPhaseChange(state.turn, state.phase, state.step);
      }

      // Auto-pass non-interactive steps for BOTH players
      if (this.shouldAutoPass(state)) {
        this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
        continue;
      }

      this.render();

      if (state.priorityPlayer === this.humanPlayer) {
        // Human turn — wait for UI action
        const action = await this.waitForPlayerAction();
        this.executeAction(action);
      } else {
        // Bot turn
        await this.botTurn();
      }
    }

    // Safety check: if we hit iteration limit, stop the game
    if (iterations >= MAX_ITERATIONS) {
      console.error('Game loop hit iteration limit - possible infinite loop');
      this.running = false;
      logMessage('<span style="color:var(--warning)">Game stopped: iteration limit reached</span>');
    }

    // Game over
    if (this.game.isOver()) {
      this.render();
      logGameOver(this.game.getWinner(), this.humanPlayer);
      this.showGameOver();
    }
  }

  /**
   * Should we auto-pass this step?
   * We STOP and wait for input only during:
   * - Main phases (play lands, cast spells)
   * - Declare-attackers (active player picks attackers)
   * - Declare-blockers (defending player picks blockers)
   * Everything else auto-passes to keep the game flowing.
   */
  private shouldAutoPass(state: GameState): boolean {
    const { step, activePlayer, priorityPlayer } = state;

    // Main phases — always stop
    if (step === 'main') return false;

    // Declare attackers — stop for the active player
    if (step === 'declare-attackers' && activePlayer === priorityPlayer) return false;

    // Declare blockers — stop for the defending player
    if (step === 'declare-blockers' && activePlayer !== priorityPlayer) return false;

    // Everything else auto-passes: untap, upkeep, draw, begin-combat,
    // first-strike-damage, combat-damage, end-combat, end, cleanup
    return true;
  }

  /** Wait for the human player to submit an action via UI */
  private waitForPlayerAction(): Promise<GameAction> {
    return new Promise<GameAction>((resolve) => {
      this.actionResolver = resolve;
      this.updateActionButtons();
    });
  }

  /** Submit a player action from the UI */
  submitAction(action: GameAction): void {
    if (this.actionResolver) {
      const resolver = this.actionResolver;
      this.actionResolver = null;
      this.selectedHandCard = null;
      this.attackerSelection = [];
      this.blockerAssignment.clear();
      this.pendingBlocker = null;
      this.inCombatSelection = false;
      this.cancelTargeting();
      resolver(action);
    }
  }

  /** Execute an action and log it */
  private executeAction(action: GameAction): void {
    const state = this.game.getState();
    const accepted = this.game.submitAction(action);
    if (accepted) {
      logAction(state, action, this.humanPlayer);
    }
  }

  /** Bot takes its turn */
  private async botTurn(): Promise<void> {
    this.showBotThinking(true);
    // Small delay for UX
    await sleep(200 + Math.random() * 300);

    let state = this.game.getState();

    // If no legal actions, just pass
    const legalTypes = getLegalActionTypes(state);
    if (legalTypes.length === 0) {
      this.game.submitAction({ type: 'pass', player: this.botPlayer });
      this.showBotThinking(false);
      return;
    }

    // Auto-tap all bot's untapped lands to fill mana pool before decision
    state = this.autoTapAllLands(state, this.botPlayer);
    this.game.setState(state);

    try {
      const action = this.bot.chooseAction(state);
      this.executeAction(action);
    } catch (error) {
      console.error('Bot decision error:', error);
      // Fallback to pass if bot encounters unexpected state
      this.game.submitAction({ type: 'pass', player: this.botPlayer });
    }

    this.showBotThinking(false);
  }

  /** Auto-tap all untapped lands for a player and add mana to their pool */
  private autoTapAllLands(state: GameState, player: 0 | 1): GameState {
    const ps = state.players[player];
    let pool = { ...ps.manaPool };
    const newBattlefield = ps.battlefield.map(perm => {
      if (perm.tapped) return perm;
      const typeLine = perm.typeLine.toLowerCase();
      const oracleText = (perm.oracleText ?? '').toLowerCase();
      const isManaSource = typeLine.includes('land') || oracleText.includes('{t}: add');
      if (!isManaSource) return perm;

      // Determine mana color
      if (typeLine.includes('forest') || oracleText.includes('add {g}')) { pool.G++; return { ...perm, tapped: true }; }
      if (typeLine.includes('island') || oracleText.includes('add {u}')) { pool.U++; return { ...perm, tapped: true }; }
      if (typeLine.includes('plains') || oracleText.includes('add {w}')) { pool.W++; return { ...perm, tapped: true }; }
      if (typeLine.includes('swamp') || oracleText.includes('add {b}')) { pool.B++; return { ...perm, tapped: true }; }
      if (typeLine.includes('mountain') || oracleText.includes('add {r}')) { pool.R++; return { ...perm, tapped: true }; }
      if (oracleText.includes('add {c}{c}')) { pool.C += 2; return { ...perm, tapped: true }; } // Sol Ring
      if (oracleText.includes('add {c}')) { pool.C++; return { ...perm, tapped: true }; }
      if (oracleText.includes('any color')) { pool.generic++; return { ...perm, tapped: true }; }
      return perm;
    });

    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    players[player] = { ...ps, battlefield: newBattlefield, manaPool: pool };
    return { ...state, players };
  }

  /** Render the full board */
  render(): void {
    const state = this.game.getState();
    renderBoard(state, this.humanPlayer, this.getCallbacks());
  }

  /** Get board interaction callbacks */
  private getCallbacks(): BoardCallbacks {
    return {
      onHandCardClick: (card, index) => this.onHandCardClick(card, index),
      onBattlefieldCardClick: (perm, controller) => this.onBattlefieldClick(perm, controller),
      canUndo: () => this.game.canUndo(),
      selectedHandCardId: this.selectedHandCard?.card.id ?? null,
      targetingMode: this.targetingMode,
      legalTargetIds: this.targetingMode ? this.getLegalTargetIds() : [],
      attackerIds: this.attackerSelection,
      blockerAssignment: this.blockerAssignment,
      pendingBlockerId: this.pendingBlocker,
    };
  }

  // ==================== Targeting System ====================

  /** Enter targeting mode for a spell */
  private enterTargetingMode(card: Card): void {
    this.targetingMode = true;
    this.targetingCard = card;
    this.selectedHandCard = { card, index: 0 };
    this.render();
    logMessage(`<span style="color:var(--gold)">Select a target for ${card.name}</span>`);
  }

  /** Cancel targeting mode */
  private cancelTargeting(): void {
    this.targetingMode = false;
    this.targetingCard = null;
  }

  /** Get IDs of legal targets for current targeting card */
  private getLegalTargetIds(): string[] {
    if (!this.targetingCard) return [];
    const state = this.game.getState();
    const targets: string[] = [];

    // Any creature on the battlefield is a legal target (simplified)
    for (const p of state.players) {
      for (const perm of p.battlefield) {
        if (isCreature(perm)) {
          targets.push(perm.id);
        }
      }
    }
    // Players are also targets
    targets.push('player-0', 'player-1');
    return targets;
  }

  /** Get alternative casting options for a card */
  private getAlternativeCastOptions(card: Card, playerState: any, state: GameState): { label: string; action: () => void }[] {
    const options: { label: string; action: () => void }[] = [];
    const oracle = (card.oracleText ?? '').toLowerCase();
    const cost = parseManaCost(card.manaCost);
    const tapResult = autoTapLandsForCost(playerState, cost);

    // Normal cast
    if (tapResult) {
      options.push({
        label: `Cast (${card.manaCost})`,
        action: () => {
          const updatedState = {
            ...state,
            players: state.players.map((p, i) =>
              i === this.humanPlayer ? tapResult.updatedPlayer : p,
            ) as [typeof state.players[0], typeof state.players[1]],
          };
          this.game.setState(updatedState);
          if (this.spellNeedsTarget(card)) { this.enterTargetingMode(card); return; }
          this.submitAction({ type: 'cast-spell', player: this.humanPlayer, cardId: card.id, targets: [], manaPayment: tapResult.payment });
        },
      });
    }

    // Evoke
    const evokeMatch = oracle.match(/evoke\s+(\{[^}]+\})/i);
    if (evokeMatch) {
      const evokeCost = parseManaCost(evokeMatch[1]);
      const evokeTap = autoTapLandsForCost(playerState, evokeCost);
      if (evokeTap) {
        options.push({
          label: `Evoke (${evokeMatch[1]})`,
          action: () => {
            const updatedState = {
              ...state,
              players: state.players.map((p, i) =>
                i === this.humanPlayer ? evokeTap.updatedPlayer : p,
              ) as [typeof state.players[0], typeof state.players[1]],
            };
            this.game.setState(updatedState);
            this.submitAction({ type: 'cast-spell', player: this.humanPlayer, cardId: card.id, targets: [], manaPayment: evokeTap.payment, evokePaid: true } as any);
          },
        });
      }
    }

    // Dash
    const dashMatch = oracle.match(/dash\s+(\{[^}]+\})/i);
    if (dashMatch) {
      const dashCost = parseManaCost(dashMatch[1]);
      const dashTap = autoTapLandsForCost(playerState, dashCost);
      if (dashTap) {
        options.push({
          label: `Dash (${dashMatch[1]})`,
          action: () => {
            const updatedState = {
              ...state,
              players: state.players.map((p, i) =>
                i === this.humanPlayer ? dashTap.updatedPlayer : p,
              ) as [typeof state.players[0], typeof state.players[1]],
            };
            this.game.setState(updatedState);
            this.submitAction({ type: 'cast-spell', player: this.humanPlayer, cardId: card.id, targets: [], manaPayment: dashTap.payment, dashPaid: true } as any);
          },
        });
      }
    }

    // Cycling (always available, not a cast)
    const cycleMatch = oracle.match(/cycling\s+(\{[^}]+\})/i);
    if (cycleMatch) {
      const cycleCost = parseManaCost(cycleMatch[1]);
      const cycleTap = autoTapLandsForCost(playerState, cycleCost);
      if (cycleTap) {
        options.push({
          label: `Cycle (${cycleMatch[1]})`,
          action: () => {
            const updatedState = {
              ...state,
              players: state.players.map((p, i) =>
                i === this.humanPlayer ? cycleTap.updatedPlayer : p,
              ) as [typeof state.players[0], typeof state.players[1]],
            };
            this.game.setState(updatedState);
            this.submitAction({ type: 'cycle', player: this.humanPlayer, cardId: card.id } as any);
          },
        });
      }
    }

    return options;
  }

  /** Show a modal for choosing between cast options */
  private showCostModal(card: Card, options: { label: string; action: () => void }[], _state: GameState): void {
    // Remove existing modal
    const existing = document.getElementById('cost-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'cost-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--obsidian,#1a1f2e);border:1px solid var(--gold,#c9a84c);border-radius:12px;padding:20px;min-width:280px;text-align:center;';

    const title = document.createElement('h3');
    title.textContent = `Cast ${card.name}`;
    title.style.cssText = 'color:var(--gold,#c9a84c);margin:0 0 16px 0;font-family:Cinzel,serif;';
    modal.appendChild(title);

    for (const opt of options) {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.style.cssText = 'display:block;width:100%;padding:10px 16px;margin:8px 0;background:var(--abyss,#0f1623);color:var(--text,#e2e8f0);border:1px solid var(--border,#2d3748);border-radius:8px;cursor:pointer;font-size:14px;font-family:Outfit,sans-serif;';
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--gold,#c9a84c)'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'var(--border,#2d3748)'; });
      btn.addEventListener('click', () => { overlay.remove(); opt.action(); });
      modal.appendChild(btn);
    }

    // Cancel button
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'display:block;width:100%;padding:8px;margin-top:12px;background:transparent;color:#888;border:none;cursor:pointer;font-size:13px;';
    cancel.addEventListener('click', () => overlay.remove());
    modal.appendChild(cancel);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /** Check if a spell needs targeting (heuristic based on oracle text) */
  private spellNeedsTarget(card: Card): boolean {
    const text = (card.oracleText ?? '').toLowerCase();
    return text.includes('target') && !card.typeLine.toLowerCase().includes('enchantment — aura');
  }

  /** Handle hand card click — cast spell or play land */
  private onHandCardClick(card: Card, index: number): void {
    if (!this.actionResolver) return;

    const state = this.game.getState();
    if (state.priorityPlayer !== this.humanPlayer) return;

    // If in targeting mode and clicking a hand card, cancel targeting
    if (this.targetingMode) {
      this.cancelTargeting();
      this.selectedHandCard = null;
      this.render();
      return;
    }

    const legalTypes = getLegalActionTypes(state);
    const isMainPhase = state.step === 'main' && state.activePlayer === this.humanPlayer;
    const isLandCard = card.typeLine.toLowerCase().includes('land');

    // Land
    if (isLandCard && legalTypes.includes('play-land')) {
      this.submitAction({ type: 'play-land', player: this.humanPlayer, cardId: card.id });
      return;
    }

    if (isLandCard && !legalTypes.includes('play-land')) {
      logMessage(`<span style="color:var(--warning)">Can't play a land right now</span>`);
      return;
    }

    // Spell — bypass getLegalActionTypes for mana check, do our own validation
    if (!isLandCard) {
      const me = state.players[this.humanPlayer];
      const typeLower = card.typeLine.toLowerCase();
      const oracleLower = (card.oracleText ?? '').toLowerCase();
      const isInstantOrFlash = typeLower.includes('instant') || oracleLower.includes('flash');

      // Check for alternative casting options
      const altOptions = this.getAlternativeCastOptions(card, me, state);

      // If there are alternative options, show a modal to choose
      if (altOptions.length > 1) {
        this.showCostModal(card, altOptions, state);
        return;
      }

      // Check for cycling (can be done anytime, doesn't need main phase)
      const cycleMatch = oracleLower.match(/cycling\s+(\{[^}]+\})/i);
      if (cycleMatch && legalTypes.includes('cycle' as any)) {
        const cycleCost = parseManaCost(cycleMatch[1]);
        const cycleTap = autoTapLandsForCost(me, cycleCost);
        if (cycleTap) {
          const updatedState = {
            ...state,
            players: state.players.map((p, i) =>
              i === this.humanPlayer ? cycleTap.updatedPlayer : p,
            ) as [typeof state.players[0], typeof state.players[1]],
          };
          this.game.setState(updatedState);
          this.submitAction({ type: 'cycle', player: this.humanPlayer, cardId: card.id } as any);
          return;
        }
      }

      // Timing check: sorcery-speed only during main phase with empty stack on your turn
      if (!isInstantOrFlash && (!isMainPhase || state.stack.length > 0)) {
        logMessage(`<span style="color:var(--warning)">Can only cast ${card.name} during your main phase</span>`);
        return;
      }

      const cost = parseManaCost(card.manaCost);

      // Try auto-tapping lands to generate mana
      const tapResult = autoTapLandsForCost(me, cost);
      if (tapResult) {
        // Update game state with tapped lands + mana pool
        const updatedState = {
          ...state,
          players: state.players.map((p, i) =>
            i === this.humanPlayer ? tapResult.updatedPlayer : p,
          ) as [typeof state.players[0], typeof state.players[1]],
        };
        this.game.setState(updatedState);

        // Check if spell needs targeting
        if (this.spellNeedsTarget(card)) {
          this.enterTargetingMode(card);
          return;
        }
        // Cast without targets
        this.submitAction({
          type: 'cast-spell',
          player: this.humanPlayer,
          cardId: card.id,
          targets: [],
          manaPayment: tapResult.payment,
        });
      } else {
        logMessage(`<span style="color:var(--warning)">Not enough mana to cast ${card.name}</span>`);
      }
    }
  }

  /** Handle battlefield card click — targeting, combat selection, blocking */
  private onBattlefieldClick(perm: Permanent, controller: 0 | 1): void {
    if (!this.actionResolver) return;
    const state = this.game.getState();

    // Targeting mode — select target for spell
    if (this.targetingMode && this.targetingCard) {
      const legalIds = this.getLegalTargetIds();
      if (legalIds.includes(perm.id)) {
        const me = state.players[this.humanPlayer];
        const cost = parseManaCost(this.targetingCard.manaCost);
        const tapResult = autoTapLandsForCost(me, cost);
        if (tapResult) {
          // Update game state with tapped lands
          const updatedState = {
            ...state,
            players: state.players.map((p, i) =>
              i === this.humanPlayer ? tapResult.updatedPlayer : p,
            ) as [typeof state.players[0], typeof state.players[1]],
          };
          this.game.setState(updatedState);

          const target: Target = { type: 'permanent', id: perm.id };
          this.submitAction({
            type: 'cast-spell',
            player: this.humanPlayer,
            cardId: this.targetingCard.id,
            targets: [target],
            manaPayment: tapResult.payment,
          });
        }
      }
      return;
    }

    // Declare attackers — click your creatures to toggle
    if (
      state.step === 'declare-attackers' &&
      state.activePlayer === this.humanPlayer &&
      controller === this.humanPlayer &&
      perm.typeLine.toLowerCase().includes('creature') &&
      !perm.summoningSick &&
      !perm.tapped
    ) {
      const idx = this.attackerSelection.indexOf(perm.id);
      if (idx >= 0) {
        this.attackerSelection.splice(idx, 1);
      } else {
        this.attackerSelection.push(perm.id);
      }
      this.render();
      this.updateCombatOverlay();
      return;
    }

    // Declare blockers — two-click: first select your creature, then click attacker
    if (
      state.step === 'declare-blockers' &&
      state.activePlayer !== this.humanPlayer &&
      state.combat &&
      state.combat.attackers.length > 0
    ) {
      if (this.pendingBlocker) {
        // Second click: assign this attacker
        if (controller !== this.humanPlayer && state.combat.attackers.some(a => a.permanentId === perm.id)) {
          this.blockerAssignment.set(this.pendingBlocker, perm.id);
          logMessage(`<span style="color:var(--accent)">Blocking ${perm.name} with selected creature</span>`);
          this.pendingBlocker = null;
          this.render();
          this.updateCombatOverlay();
        } else {
          // Clicked own creature again — switch blocker or cancel
          if (controller === this.humanPlayer && perm.typeLine.toLowerCase().includes('creature') && !perm.tapped) {
            this.pendingBlocker = perm.id;
            this.render();
          } else {
            this.pendingBlocker = null;
            this.render();
          }
        }
      } else {
        // First click: select your creature as blocker
        if (
          controller === this.humanPlayer &&
          perm.typeLine.toLowerCase().includes('creature') &&
          !perm.tapped
        ) {
          // Toggle — if already assigned, remove assignment
          if (this.blockerAssignment.has(perm.id)) {
            this.blockerAssignment.delete(perm.id);
            this.render();
            this.updateCombatOverlay();
          } else {
            this.pendingBlocker = perm.id;
            logMessage(`<span style="color:var(--accent)">Select an attacking creature to block</span>`);
            this.render();
          }
        }
      }
      return;
    }

    // Ability activation — click your own permanent to activate abilities
    if (controller === this.humanPlayer) {
      this.onBattlefieldCardClick(perm.id);
    }
  }

  /** Handle battlefield card click for ability activation */
  private onBattlefieldCardClick(permanentId: string): void {
    const state = this.game.getState();
    if (!state || state.gameOver) return;
    if (state.priorityPlayer !== this.humanPlayer) return;

    const player = state.players[this.humanPlayer];
    const perm = player.battlefield.find(p => p.id === permanentId);
    if (!perm) return;

    // Filter to abilities we can actually activate right now
    const activatable = perm.abilities
      .map((ability, index) => ({ ability, index }))
      .filter(({ ability }) => {
        if (ability.type === 'static' || ability.type === 'triggered') return false;
        // Mana abilities — can only tap if untapped
        if (ability.type === 'mana') {
          return !perm.tapped;
        }
        // Activated abilities — check if we can pay the cost
        const cost = parseCost(ability.cost || '');
        return canPayAbilityCost(state, this.humanPlayer, perm.id, cost);
      });

    if (activatable.length === 0) return;

    // If only one ability, activate directly (skip modal)
    if (activatable.length === 1) {
      const { ability, index } = activatable[0];
      if (ability.type === 'mana') {
        this.submitAction({ type: 'tap-for-mana', player: this.humanPlayer, permanentId: perm.id, abilityIndex: index });
      } else {
        this.submitAction({ type: 'activate-ability', player: this.humanPlayer, sourceId: perm.id, abilityIndex: index, targets: [] });
      }
      return;
    }

    // Multiple abilities — show picker modal
    this.showAbilityPicker(perm, activatable);
  }

  /** Show a modal for choosing between activatable abilities on a permanent */
  private showAbilityPicker(
    perm: Permanent,
    abilities: { ability: Ability; index: number }[]
  ): void {
    // Remove any existing modal
    document.getElementById('ability-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ability-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--abyss,#0f1623);border:1px solid var(--gold,#c9a84c);border-radius:16px;padding:24px;max-width:420px;width:90%;';

    const title = document.createElement('h3');
    title.textContent = perm.name;
    title.style.cssText = 'font-family:Cinzel,serif;color:var(--gold,#c9a84c);margin:0 0 16px;font-size:18px;text-align:center;';
    panel.appendChild(title);

    for (const { ability, index } of abilities) {
      const btn = document.createElement('button');
      btn.style.cssText = 'display:block;width:100%;padding:12px 16px;margin-bottom:8px;background:var(--obsidian,#1a1f2e);border:1px solid var(--border,#2d3748);border-radius:10px;color:var(--text,#e2e8f0);cursor:pointer;text-align:left;font-family:Outfit,sans-serif;font-size:14px;transition:border-color 0.2s;';
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--gold,#c9a84c)'; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'var(--border,#2d3748)'; });

      // Show cost in gold, effect text in white
      const costSpan = document.createElement('span');
      costSpan.textContent = ability.cost ? `${ability.cost}: ` : '';
      costSpan.style.cssText = 'color:var(--gold,#c9a84c);font-family:JetBrains Mono,monospace;font-size:13px;';

      // Remove cost prefix from display text if present
      const effectText = ability.text.replace(/^.*?:\s*/, '');
      const effectSpan = document.createElement('span');
      effectSpan.textContent = effectText;

      btn.appendChild(costSpan);
      btn.appendChild(effectSpan);

      btn.addEventListener('click', () => {
        overlay.remove();
        if (ability.type === 'mana') {
          this.submitAction({ type: 'tap-for-mana', player: this.humanPlayer, permanentId: perm.id, abilityIndex: index });
        } else {
          this.submitAction({ type: 'activate-ability', player: this.humanPlayer, sourceId: perm.id, abilityIndex: index, targets: [] });
        }
      });

      panel.appendChild(btn);
    }

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'display:block;width:100%;padding:10px;margin-top:8px;background:transparent;border:1px solid var(--border,#2d3748);border-radius:10px;color:#888;cursor:pointer;font-family:Outfit,sans-serif;font-size:13px;';
    cancelBtn.addEventListener('click', () => overlay.remove());
    panel.appendChild(cancelBtn);

    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /** Highlight selected attackers */
  private highlightAttackers(): void {
    const container = document.getElementById('bf-you');
    if (!container) return;
    container.querySelectorAll('.pvb-card').forEach((el) => {
      const id = (el as HTMLElement).dataset.permanentId;
      el.classList.toggle('attacking', id != null && this.attackerSelection.includes(id));
    });
  }

  /** Update which action buttons are enabled */
  private updateActionButtons(): void {
    const state = this.game.getState();
    const legalTypes = getLegalActionTypes(state);
    const isMyPriority = state.priorityPlayer === this.humanPlayer;

    setButtonEnabled('btn-pass', isMyPriority);
    setButtonEnabled('btn-end-turn', isMyPriority);
    setButtonEnabled('btn-concede', true);

    // Show combat overlay if in declare-attackers step
    if (state.step === 'declare-attackers' && state.activePlayer === this.humanPlayer && isMyPriority) {
      this.showCombatOverlay(true, 'Declare Attackers');
    } else if (state.step === 'declare-blockers' && state.activePlayer !== this.humanPlayer && isMyPriority) {
      this.showCombatOverlay(true, 'Declare Blockers');
    } else {
      this.showCombatOverlay(false);
    }
  }

  /** Update the combat overlay button counts */
  private updateCombatOverlay(): void {
    const state = this.game.getState();
    if (state.step === 'declare-attackers') {
      this.showCombatOverlay(true, 'Declare Attackers');
    } else if (state.step === 'declare-blockers') {
      this.showCombatOverlay(true, 'Declare Blockers');
    }
  }

  /** Show/hide combat overlay */
  private showCombatOverlay(show: boolean, title?: string): void {
    const overlay = document.getElementById('combat-overlay');
    const titleEl = document.getElementById('combat-title');
    const actionsEl = document.getElementById('combat-actions');
    if (!overlay) return;

    overlay.classList.toggle('hidden', !show);
    if (titleEl && title) titleEl.textContent = title;

    if (actionsEl && show) {
      actionsEl.innerHTML = '';

      const state = this.game.getState();
      if (state.step === 'declare-attackers') {
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'pvb-btn primary';
        confirmBtn.textContent = `Attack (${this.attackerSelection.length})`;
        confirmBtn.addEventListener('click', () => {
          this.submitAction({
            type: 'declare-attackers',
            player: this.humanPlayer,
            attackers: this.attackerSelection,
          });
        });
        actionsEl.appendChild(confirmBtn);

        const noAttackBtn = document.createElement('button');
        noAttackBtn.className = 'pvb-btn';
        noAttackBtn.textContent = 'No Attackers';
        noAttackBtn.addEventListener('click', () => {
          this.submitAction({
            type: 'declare-attackers',
            player: this.humanPlayer,
            attackers: [],
          });
        });
        actionsEl.appendChild(noAttackBtn);
      } else if (state.step === 'declare-blockers') {
        const blocks = Array.from(this.blockerAssignment.entries()).map(([blocker, attacker]) => ({
          blocker,
          attacker,
        }));

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'pvb-btn primary';
        confirmBtn.textContent = `Confirm Blockers (${blocks.length})`;
        confirmBtn.addEventListener('click', () => {
          this.submitAction({
            type: 'declare-blockers',
            player: this.humanPlayer,
            blocks,
          });
        });
        actionsEl.appendChild(confirmBtn);

        const noBlockBtn = document.createElement('button');
        noBlockBtn.className = 'pvb-btn';
        noBlockBtn.textContent = 'No Blockers';
        noBlockBtn.addEventListener('click', () => {
          this.submitAction({
            type: 'declare-blockers',
            player: this.humanPlayer,
            blocks: [],
          });
        });
        actionsEl.appendChild(noBlockBtn);
      }
    }
  }

  /** Pass priority */
  pass(): void {
    this.submitAction({ type: 'pass', player: this.humanPlayer });
  }

  /** End turn (rapid pass) */
  endTurn(): void {
    this.submitAction({ type: 'pass', player: this.humanPlayer });
  }

  /** Undo last action */
  undo(): void {
    if (this.game.undo()) {
      this.render();
      logMessage('<span style="color:var(--warning)">Action undone</span>');
    }
  }

  /** Concede the game */
  concede(): void {
    this.submitAction({ type: 'concede', player: this.humanPlayer });
  }

  /** Show bot thinking indicator */
  private showBotThinking(show: boolean): void {
    const el = document.getElementById('bot-thinking');
    if (el) el.classList.toggle('hidden', !show);
  }

  /** Show game over screen */
  private showGameOver(): void {
    const overlay = document.getElementById('gameover-overlay');
    const panel = document.getElementById('gameover-panel');
    if (!overlay || !panel) return;

    overlay.classList.remove('hidden');
    const won = this.game.getWinner() === this.humanPlayer;
    const state = this.game.getState();

    panel.className = `pvb-gameover ${won ? 'win' : 'loss'}`;
    panel.innerHTML = `
      <h2>${won ? 'Victory!' : 'Defeat'}</h2>
      <div class="pvb-gameover-stats">
        Game lasted ${state.turn} turns<br>
        Your life: ${state.players[this.humanPlayer].life} | Bot life: ${state.players[this.botPlayer].life}
      </div>
      <div class="pvb-gameover-actions">
        <button class="pvb-btn primary" onclick="location.reload()">Play Again</button>
        <button class="pvb-btn" onclick="location.href='/'">Home</button>
      </div>
    `;
  }

  /** Handle mulligan phase */
  async handleMulligan(): Promise<void> {
    const overlay = document.getElementById('mulligan-overlay');
    if (!overlay) return;

    // Draw opening hands
    let state = this.game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    this.game.setState(state);

    // Show mulligan UI for human player
    overlay.classList.remove('hidden');
    await this.showMulliganUI();
    overlay.classList.add('hidden');

    // Bot mulligan (auto-keep)
    const botState = this.game.getState();
    const botHand = botState.players[this.botPlayer].hand;
    const landCount = botHand.filter(c => c.typeLine.toLowerCase().includes('land')).length;
    if (landCount < 2 || landCount > 5) {
      logMessage('<span class="pvb-log-bot">Bot mulliganed</span>');
    } else {
      logMessage('<span class="pvb-log-bot">Bot kept hand</span>');
    }
    // Submit bot mulligan action (keep hand)
    this.game.submitAction({ type: 'mulligan', player: this.botPlayer, toBottom: [] });

    // End mulligan phase
    this.game.endMulliganPhase();
  }

  /** Show mulligan UI and wait for keep/mulligan decision */
  private showMulliganUI(): Promise<void> {
    return new Promise<void>((resolve) => {
      const state = this.game.getState();
      const hand = state.players[this.humanPlayer].hand;
      const mulliganCount = state.mulliganCount[this.humanPlayer];

      const titleEl = document.getElementById('mulligan-title');
      const handEl = document.getElementById('mulligan-hand');
      const statsEl = document.getElementById('mulligan-stats');
      const actionsEl = document.getElementById('mulligan-actions');
      if (!titleEl || !handEl || !statsEl || !actionsEl) { resolve(); return; }

      // Track which cards the player selected to put on bottom
      const bottomSelection = new Set<string>();
      const needBottom = mulliganCount; // London: put X cards on bottom

      titleEl.textContent = mulliganCount > 0
        ? `Mulligan — Select ${needBottom} card${needBottom > 1 ? 's' : ''} to put on bottom`
        : 'Opening Hand (7 cards)';

      const renderMulliganHand = () => {
        handEl.innerHTML = '';
        for (const card of hand) {
          const el = document.createElement('div');
          el.className = 'pvb-card';
          if (bottomSelection.has(card.id)) el.classList.add('bottom-select');

          const img = document.createElement('img');
          img.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
          img.alt = card.name;
          img.loading = 'lazy';
          el.appendChild(img);

          // Click to toggle bottom selection (only if mulliganCount > 0)
          if (mulliganCount > 0) {
            el.style.cursor = 'pointer';
            el.addEventListener('click', () => {
              if (bottomSelection.has(card.id)) {
                bottomSelection.delete(card.id);
              } else if (bottomSelection.size < needBottom) {
                bottomSelection.add(card.id);
              }
              renderMulliganHand();
              updateActions();
            });
          }

          handEl.appendChild(el);
        }

        // Stats
        const selected = hand.filter(c => !bottomSelection.has(c.id));
        const landCount = selected.filter(c => c.typeLine.toLowerCase().includes('land')).length;
        const spellCount = selected.length - landCount;
        statsEl.textContent = `Keeping: Lands: ${landCount} | Spells: ${spellCount} | Cards: ${selected.length}`;
      };

      const updateActions = () => {
        actionsEl.innerHTML = '';

        if (mulliganCount > 0) {
          // Keep button — only enabled when enough cards selected for bottom
          const keepBtn = document.createElement('button');
          keepBtn.className = 'pvb-btn primary';
          keepBtn.textContent = bottomSelection.size === needBottom
            ? `Keep ${hand.length - needBottom} cards`
            : `Select ${needBottom - bottomSelection.size} more to bottom`;
          keepBtn.disabled = bottomSelection.size !== needBottom;
          keepBtn.addEventListener('click', () => {
            const toBottom = Array.from(bottomSelection);
            this.game.submitAction({ type: 'mulligan', player: this.humanPlayer, toBottom });
            logMessage(`<span class="pvb-log-you">You kept ${hand.length - needBottom} cards</span>`);
            resolve();
          });
          actionsEl.appendChild(keepBtn);

          // Mulligan again button
          if (hand.length > 1) {
            const mullBtn = document.createElement('button');
            mullBtn.className = 'pvb-btn';
            mullBtn.textContent = `Mulligan to ${hand.length - 1}`;
            mullBtn.addEventListener('click', () => {
              const toBottom = hand.slice(-1).map(c => c.id);
              this.game.submitAction({ type: 'mulligan', player: this.humanPlayer, toBottom });
              logMessage(`<span class="pvb-log-you">You mulliganed to ${hand.length - 1}</span>`);
              this.showMulliganUI().then(resolve);
            });
            actionsEl.appendChild(mullBtn);
          }
        } else {
          // First hand — just keep or mulligan
          const keepBtn = document.createElement('button');
          keepBtn.className = 'pvb-btn primary';
          keepBtn.textContent = 'Keep Hand';
          keepBtn.addEventListener('click', () => {
            this.game.submitAction({ type: 'mulligan', player: this.humanPlayer, toBottom: [] });
            logMessage('<span class="pvb-log-you">You kept your hand</span>');
            resolve();
          });
          actionsEl.appendChild(keepBtn);

          if (hand.length > 1) {
            const mullBtn = document.createElement('button');
            mullBtn.className = 'pvb-btn';
            mullBtn.textContent = `Mulligan to ${hand.length - 1}`;
            mullBtn.addEventListener('click', () => {
              const toBottom = hand.slice(-1).map(c => c.id);
              this.game.submitAction({ type: 'mulligan', player: this.humanPlayer, toBottom });
              logMessage(`<span class="pvb-log-you">You mulliganed to ${hand.length - 1}</span>`);
              this.showMulliganUI().then(resolve);
            });
            actionsEl.appendChild(mullBtn);
          }
        }
      };

      renderMulliganHand();
      updateActions();
    });
  }

  /** Stop the game loop */
  stop(): void {
    this.running = false;
    if (this.actionResolver) {
      this.actionResolver({ type: 'concede', player: this.humanPlayer });
      this.actionResolver = null;
    }
  }
}

function setButtonEnabled(id: string, enabled: boolean): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
