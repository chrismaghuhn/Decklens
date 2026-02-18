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
  isInstant,
  hasFlash,
  parseCost,
  canPayAbilityCost,
  resolveModalChoices,
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

      // ─── Modal Choice Pending ───
      // If a modal spell is waiting for mode selection, show the modal UI
      if (state.pendingModalChoice && state.pendingModalChoice.controller === this.humanPlayer) {
        const chosenModes = await this.showModalChoicePrompt(state);
        // Find the stack object and resolve chosen modes
        const stackObj = state.stack.find(s => s.id === state.pendingModalChoice!.stackObjectId);
        if (stackObj) {
          // Pop the modal spell off the stack
          const stackWithout = state.stack.filter(s => s.id !== stackObj.id);
          let resolvedState: GameState = { ...state, stack: stackWithout, pendingModalChoice: null };
          resolvedState = resolveModalChoices(resolvedState, stackObj, chosenModes);

          // Move instant/sorcery to graveyard after resolution
          const card = stackObj.card;
          if (card && !card.typeLine.toLowerCase().match(/creature|artifact|enchantment|planeswalker|battle/)) {
            const ctrl = stackObj.controller;
            const players = [...resolvedState.players] as [typeof resolvedState.players[0], typeof resolvedState.players[1]];
            if (stackObj.isFlashback) {
              players[ctrl] = { ...players[ctrl], exile: [...players[ctrl].exile, card] };
            } else {
              players[ctrl] = { ...players[ctrl], graveyard: [...players[ctrl].graveyard, card] };
            }
            resolvedState = { ...resolvedState, players };
          }

          const modeTexts = chosenModes.map(i => state.pendingModalChoice!.modes.find(m => m.index === i)?.text ?? String(i));
          resolvedState = {
            ...resolvedState,
            log: [
              ...resolvedState.log,
              {
                timestamp: Date.now(),
                turn: resolvedState.turn,
                phase: resolvedState.phase,
                step: resolvedState.step,
                player: stackObj.controller,
                message: `${state.pendingModalChoice!.cardName ?? 'Modal spell'} resolves (chose: ${modeTexts.join(', ')}).`,
                cardName: stackObj.card?.name,
                actionType: 'effect',
              },
            ],
          };
          this.game.setState(resolvedState);
          logMessage(`<span style="color:var(--gold)">${state.pendingModalChoice!.cardName}: ${modeTexts.join(', ')}</span>`);
        }
        continue;
      }

      if (state.priorityPlayer === this.humanPlayer) {
        // If the stack has items and we're not in a main phase, show response prompt
        if (state.stack.length > 0 && state.step !== 'main') {
          const action = await this.showResponsePrompt(state);
          this.executeAction(action);
        } else {
          // Human turn — wait for UI action
          const action = await this.waitForPlayerAction();
          this.executeAction(action);
        }
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
   * - When the stack is non-empty and the human has priority (response window)
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

    // Stack is non-empty and human has priority — show response window
    // so the player can cast instants/flash spells in response
    if (state.stack.length > 0 && priorityPlayer === this.humanPlayer) {
      // Check if human has any instant-speed cards they could cast
      const hand = state.players[this.humanPlayer].hand;
      const hasResponse = hand.some(card => {
        if (!isInstant(card) && !hasFlash(card)) return false;
        const cost = parseManaCost(card.manaCost);
        return autoTapLandsForCost(state.players[this.humanPlayer], cost) !== null;
      });
      if (hasResponse) return false; // Stop to show response prompt
    }

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

  // ==================== Response Prompt ====================

  /** Inject response prompt CSS into document head (once) */
  private static responseStylesInjected = false;
  private injectResponseStyles(): void {
    if (GameLoop.responseStylesInjected) return;
    GameLoop.responseStylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes responsePromptFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .response-prompt {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(10, 14, 23, 0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 1000;
        animation: responsePromptFadeIn 0.2s ease;
      }
      .response-prompt-content {
        background: linear-gradient(135deg, #1a1f2e, #0f1623);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 16px;
        padding: 24px;
        max-width: 400px;
        width: 90%;
        text-align: center;
        font-family: 'Outfit', sans-serif;
        color: #e2e8f0;
      }
      .response-prompt-content h3 {
        color: #c9a84c;
        font-family: 'Cinzel', serif;
        margin: 0 0 12px 0;
        font-size: 18px;
      }
      .response-prompt-content p {
        color: #94a3b8;
        margin: 0 0 16px 0;
        font-size: 14px;
      }
      .response-card-btn {
        display: block; width: 100%;
        background: rgba(201, 168, 76, 0.15);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 10px;
        color: #c9a84c;
        padding: 10px 16px;
        margin: 6px 0;
        cursor: pointer;
        font-family: 'Outfit', sans-serif;
        font-size: 14px;
        transition: all 0.2s;
      }
      .response-card-btn:hover {
        background: rgba(201, 168, 76, 0.3);
        border-color: #c9a84c;
      }
      .response-pass-btn {
        background: rgba(100, 116, 139, 0.2);
        border: 1px solid rgba(100, 116, 139, 0.3);
        border-radius: 50px;
        color: #94a3b8;
        padding: 10px 24px;
        margin-top: 12px;
        cursor: pointer;
        font-family: 'Outfit', sans-serif;
        font-size: 14px;
      }
      .response-pass-btn:hover {
        background: rgba(100, 116, 139, 0.3);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Show a response prompt overlay when the stack is non-empty and
   * the human has priority. Lists instant-speed cards from hand that
   * can be cast, plus a "Pass" button.
   *
   * Returns the chosen GameAction (cast-spell or pass).
   */
  private showResponsePrompt(state: GameState): Promise<GameAction> {
    this.injectResponseStyles();

    return new Promise<GameAction>((resolve) => {
      const hand = state.players[this.humanPlayer].hand;
      const playerState = state.players[this.humanPlayer];

      // Find instant-speed cards that can be afforded
      const instantSpeedCards = hand.filter(card => {
        if (!isInstant(card) && !hasFlash(card)) return false;
        const cost = parseManaCost(card.manaCost);
        return autoTapLandsForCost(playerState, cost) !== null;
      });

      // Describe what we're responding to
      const topSpell = state.stack[state.stack.length - 1];
      const spellDescription = topSpell?.card?.name || topSpell?.text || 'a spell';

      // If no instant-speed cards available, auto-pass after brief delay
      if (instantSpeedCards.length === 0) {
        logMessage(`<span style="color:#94a3b8">No responses available — passing</span>`);
        setTimeout(() => {
          resolve({ type: 'pass', player: this.humanPlayer });
        }, 400);
        return;
      }

      // Remove any existing response prompt
      document.getElementById('response-prompt')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'response-prompt';
      overlay.className = 'response-prompt';

      const content = document.createElement('div');
      content.className = 'response-prompt-content';

      const title = document.createElement('h3');
      title.textContent = 'Respond?';
      content.appendChild(title);

      const desc = document.createElement('p');
      desc.textContent = `Opponent cast: ${spellDescription}`;
      content.appendChild(desc);

      // Card buttons
      const cardContainer = document.createElement('div');
      for (const card of instantSpeedCards) {
        const btn = document.createElement('button');
        btn.className = 'response-card-btn';
        btn.textContent = `${card.name} (${card.manaCost})`;
        btn.addEventListener('click', () => {
          overlay.remove();

          // If the spell needs a target, enter targeting mode
          const needsTarget = this.spellNeedsTarget(card);
          if (needsTarget) {
            // Enter targeting mode and resolve once target is picked
            this.targetingMode = true;
            this.targetingCard = card;
            this.selectedHandCard = { card, index: 0 };
            this.render();
            logMessage(`<span style="color:var(--gold)">Select a target for ${card.name}</span>`);

            // Set up action resolver for targeting
            this.actionResolver = (action: GameAction) => {
              resolve(action);
            };
            this.updateActionButtons();
            return;
          }

          // Cast without targets — auto-tap lands for mana
          const cost = parseManaCost(card.manaCost);
          const tapResult = autoTapLandsForCost(playerState, cost);
          if (tapResult) {
            // Update game state with tapped lands
            const updatedState = {
              ...state,
              players: state.players.map((p, i) =>
                i === this.humanPlayer ? tapResult.updatedPlayer : p,
              ) as [typeof state.players[0], typeof state.players[1]],
            };
            this.game.setState(updatedState);

            resolve({
              type: 'cast-spell',
              player: this.humanPlayer,
              cardId: card.id,
              targets: [],
              manaPayment: tapResult.payment,
            });
          } else {
            resolve({ type: 'pass', player: this.humanPlayer });
          }
        });
        cardContainer.appendChild(btn);
      }
      content.appendChild(cardContainer);

      // Pass button
      const passBtn = document.createElement('button');
      passBtn.className = 'response-pass-btn';
      passBtn.textContent = 'Pass (No Response)';
      passBtn.addEventListener('click', () => {
        overlay.remove();
        resolve({ type: 'pass', player: this.humanPlayer });
      });
      content.appendChild(passBtn);

      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
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

  // ==================== Modal Choice UI ====================

  /** Inject modal choice CSS into document head (once) */
  private static modalStylesInjected = false;
  private injectModalStyles(): void {
    if (GameLoop.modalStylesInjected) return;
    GameLoop.modalStylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes modalChoiceFadeIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
      .modal-choice-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(10, 14, 23, 0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 1000;
        animation: modalChoiceFadeIn 0.2s ease;
      }
      .modal-choice-content {
        background: linear-gradient(135deg, #1a1f2e, #0f1623);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 16px;
        padding: 24px;
        max-width: 420px;
        width: 90%;
        color: #e2e8f0;
        font-family: 'Outfit', sans-serif;
      }
      .modal-choice-content h3 {
        color: #c9a84c;
        font-family: 'Cinzel', serif;
        margin: 0 0 8px 0;
        font-size: 18px;
      }
      .modal-choice-content .modal-subtitle {
        color: #94a3b8;
        font-size: 13px;
        margin: 0 0 16px 0;
      }
      .modal-mode-option {
        display: flex; align-items: center; gap: 10px;
        background: rgba(201, 168, 76, 0.1);
        border: 1px solid rgba(201, 168, 76, 0.2);
        border-radius: 10px;
        padding: 10px 14px;
        margin: 6px 0;
        cursor: pointer;
        transition: all 0.2s;
        font-size: 14px;
      }
      .modal-mode-option:hover {
        background: rgba(201, 168, 76, 0.2);
        border-color: rgba(201, 168, 76, 0.5);
      }
      .modal-mode-option.selected {
        background: rgba(201, 168, 76, 0.25);
        border-color: #c9a84c;
      }
      .modal-mode-option input[type="radio"],
      .modal-mode-option input[type="checkbox"] {
        accent-color: #c9a84c;
        width: 16px; height: 16px;
      }
      .modal-confirm-btn {
        background: linear-gradient(135deg, #c9a84c, #b8963f);
        border: none; border-radius: 50px;
        color: #0a0e17; font-weight: 600;
        padding: 10px 24px; margin-top: 14px;
        cursor: pointer; width: 100%;
        font-family: 'Outfit', sans-serif;
        font-size: 14px;
        transition: opacity 0.2s;
      }
      .modal-confirm-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .modal-confirm-btn:not(:disabled):hover {
        opacity: 0.9;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Show modal choice prompt for a modal spell.
   * Returns the chosen mode indices.
   */
  private showModalChoicePrompt(state: GameState): Promise<number[]> {
    this.injectModalStyles();
    const pending = state.pendingModalChoice!;

    return new Promise<number[]>((resolve) => {
      // Remove any existing modal
      document.getElementById('modal-choice-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'modal-choice-overlay';
      overlay.className = 'modal-choice-overlay';

      const content = document.createElement('div');
      content.className = 'modal-choice-content';

      const title = document.createElement('h3');
      title.textContent = pending.cardName ?? 'Modal Spell';
      content.appendChild(title);

      const subtitle = document.createElement('p');
      subtitle.className = 'modal-subtitle';
      if (pending.minChoices === pending.maxChoices) {
        subtitle.textContent = `Choose ${pending.minChoices === 1 ? 'one' : pending.minChoices === 2 ? 'two' : String(pending.minChoices)}:`;
      } else if (pending.maxChoices >= pending.modes.length) {
        subtitle.textContent = 'Choose one or more:';
      } else {
        subtitle.textContent = `Choose ${pending.minChoices} to ${pending.maxChoices}:`;
      }
      content.appendChild(subtitle);

      const selected = new Set<number>();
      const isRadio = pending.maxChoices === 1;

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'modal-confirm-btn';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.disabled = true;

      const updateConfirm = () => {
        confirmBtn.disabled = selected.size < pending.minChoices;
      };

      // Mode options
      const optionsContainer = document.createElement('div');
      for (const mode of pending.modes) {
        const option = document.createElement('label');
        option.className = 'modal-mode-option';

        const input = document.createElement('input');
        input.type = isRadio ? 'radio' : 'checkbox';
        input.name = 'modal-mode';
        input.value = String(mode.index);

        input.addEventListener('change', () => {
          if (isRadio) {
            selected.clear();
            selected.add(mode.index);
            // Update visual selection
            optionsContainer.querySelectorAll('.modal-mode-option').forEach(el => el.classList.remove('selected'));
            option.classList.add('selected');
          } else {
            if (input.checked) {
              if (selected.size < pending.maxChoices) {
                selected.add(mode.index);
                option.classList.add('selected');
              } else {
                input.checked = false; // Enforce max
              }
            } else {
              selected.delete(mode.index);
              option.classList.remove('selected');
            }
          }
          updateConfirm();
        });

        const label = document.createElement('span');
        label.textContent = mode.text;

        option.appendChild(input);
        option.appendChild(label);
        optionsContainer.appendChild(option);
      }
      content.appendChild(optionsContainer);

      confirmBtn.addEventListener('click', () => {
        if (selected.size >= pending.minChoices) {
          overlay.remove();
          resolve(Array.from(selected).sort((a, b) => a - b));
        }
      });
      content.appendChild(confirmBtn);

      overlay.appendChild(content);
      document.body.appendChild(overlay);
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
