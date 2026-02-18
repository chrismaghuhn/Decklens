/**
 * Simulator Loop — The core game loop for the MTG Rules Engine.
 *
 * Unlike play-vs-bot which auto-passes most steps, this loop gives
 * explicit priority at every step (EDOPro-style). Features:
 *
 * - Full priority at every step (no auto-pass by default)
 * - Manual mana tapping via click
 * - Auto-tap toggle (F2) for convenience
 * - Stack response windows
 * - Hotseat mode with pass-screen
 * - Manual resolution fallback for unknown effects
 */

import type { GameState, GameAction, Card, Permanent, Target, Phase, Step } from '@mtg/game-engine';
import {
  Game,
  createInitialGameState,
  createPlayerState,
  getLegalActionTypes,
  drawOpeningHand,
  autoTapLandsForCost,
  parseManaCost,
  isCreature,
  isLand,
  isInstant,
  hasManaAbility,
  canAutoResolve,
  hasKeyword,
  hasProtectionFrom,
} from '@mtg/game-engine';
import { renderBoard, clearDomCache, addHoverPreview } from './simulator-board.ts';
import type { SimBoardCallbacks } from './simulator-board.ts';

// ─── Types ───

export interface BotInterface {
  readonly player: 0 | 1;
  chooseAction(state: GameState): GameAction;
}

export interface SimulatorConfig {
  p1Deck: Card[];
  p1Commander: Card;
  p2Deck: Card[];
  p2Commander: Card;
  p1Name: string;
  p2Name: string;
  mode: 'vs-bot' | 'hotseat';
  bot?: BotInterface;
}

// ─── Phase Display ───

const STEP_LABELS: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main: 'Main',
  'begin-combat': 'Begin Combat',
  'declare-attackers': 'Attackers',
  'declare-blockers': 'Blockers',
  'first-strike-damage': '1st Strike',
  'combat-damage': 'Damage',
  'end-combat': 'End Combat',
  end: 'End Step',
  cleanup: 'Cleanup',
};

const ALL_STEPS: Step[] = [
  'untap', 'upkeep', 'draw', 'main',
  'begin-combat', 'declare-attackers', 'declare-blockers',
  'first-strike-damage', 'combat-damage', 'end-combat',
  'end', 'cleanup',
];

// ─── Simulator Loop ───

export class SimulatorLoop {
  private game!: Game;
  private config: SimulatorConfig;
  private actionResolver: ((action: GameAction) => void) | null = null;
  private running = false;

  // Player tracking
  private currentViewPlayer: 0 | 1 = 0; // Which player's perspective we show
  private humanPlayers: (0 | 1)[] = [0]; // Which players are human

  // Selection state
  private selectedHandCard: { card: Card; index: number } | null = null;
  private attackerSelection: string[] = [];
  private blockerAssignment: Map<string, string> = new Map();
  private pendingBlocker: string | null = null;
  private targetingMode = false;
  private targetingCard: Card | null = null;

  // Activated ability targeting state
  private targetingAbility: { source: Permanent; abilityIndex: number } | null = null;

  // X-cost pending value (stored while targeting)
  private pendingXValue: number | undefined;

  // Mana payment pending (stored while in targeting mode so targeted spells record correct payment)
  private pendingManaPayment: Record<string, number> | undefined;

  // Auto-pass (F2 toggle)
  private autoPassEnabled = false;

  // Phase tracking
  private lastPhaseKey = '';

  // Manual resolution
  private inManualResolution = false;

  // Priority prompt state
  private priorityPromptVisible = false;
  private lastStackSize = 0;
  private respondMode = false; // true when player clicked "Respond" — opens hand for instants

  // Zone browser state
  private zoneBrowserOpen = false;

  // Render throttle — schedule renders via rAF to avoid redundant paints
  private _renderScheduled = false;

  constructor(config: SimulatorConfig) {
    this.config = config;

    if (config.mode === 'hotseat') {
      this.humanPlayers = [0, 1];
    } else {
      this.humanPlayers = [0];
    }
  }

  /** Initialize game and start */
  async init(): Promise<void> {
    const p1State = createPlayerState(0, this.config.p1Name, this.config.p1Deck, this.config.p1Commander);
    const p2State = createPlayerState(1, this.config.p2Name, this.config.p2Deck, this.config.p2Commander);
    const initial = createInitialGameState(p1State, p2State);
    this.game = new Game(initial);

    // Show game board
    const container = document.getElementById('game-container');
    if (container) container.classList.add('active');

    // Build phase timeline
    this.buildPhaseTimeline();

    // Wire up new Phase 4 UI elements
    this.wireKeyboardShortcuts();
    this.wireZoneBrowser();
    this.wirePriorityPrompt();
    this.wireAutoPassBadge();
    this.wireManualDialogs();
    this.showShortcutBar();

    // Mulligan phase
    await this.handleMulligan(0);
    if (this.config.mode === 'hotseat') {
      await this.showHotseatPassScreen(1);
      await this.handleMulligan(1);
    } else {
      // Bot auto-keeps
      this.game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
      this.addLog('Bot kept hand.');
    }

    this.game.endMulliganPhase();

    this.addLog('Game started!');
    this.currentViewPlayer = 0;
    this.running = true;
    this.render();
    await this.loop();
  }

  // ==================== Main Loop ====================

  private async loop(): Promise<void> {
    let iterations = 0;
    const MAX_ITERATIONS = 50000;

    while (this.running && !this.game.isOver() && iterations < MAX_ITERATIONS) {
      iterations++;
      const state = this.game.getState();

      // Log phase changes
      const phaseKey = `${state.turn}:${state.phase}:${state.step}`;
      if (phaseKey !== this.lastPhaseKey) {
        this.lastPhaseKey = phaseKey;
        this.addLog(`--- Turn ${state.turn} — ${STEP_LABELS[state.step]} ---`, 'phase-change');
      }

      // Auto-pass for untap (no player interaction possible)
      if (state.step === 'untap') {
        this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
        continue;
      }

      // Cleanup step: handle hand size discard or auto-pass
      if (state.step === 'cleanup') {
        if (state.pendingDiscard != null) {
          // A player needs to discard — show discard UI
          const discardPlayer = state.pendingDiscard;
          const isHumanDiscard = this.humanPlayers.includes(discardPlayer);

          if (isHumanDiscard) {
            // Hotseat: switch view if needed
            if (this.config.mode === 'hotseat' && discardPlayer !== this.currentViewPlayer) {
              await this.showHotseatPassScreen(discardPlayer);
              this.currentViewPlayer = discardPlayer;
            }
            this.render();
            await this.handleDiscardPhase(state);
          } else {
            // Bot discards — pick cards with lowest cost
            this.botDiscard(state);
          }
          continue;
        }
        // No pending discard — auto-pass cleanup
        this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
        continue;
      }

      // Check if current priority player is human
      const isHuman = this.humanPlayers.includes(state.priorityPlayer);

      if (!isHuman) {
        // Bot turn
        await this.botTurn();
        continue;
      }

      // Hotseat: switch view if needed
      if (this.config.mode === 'hotseat' && state.priorityPlayer !== this.currentViewPlayer) {
        await this.showHotseatPassScreen(state.priorityPlayer);
        this.currentViewPlayer = state.priorityPlayer;
      }

      // Check manual resolution
      if (state.needsManualResolution && !this.inManualResolution) {
        this.showManualResolutionPanel(state);
      }

      // Check pending damage assignment
      if (state.pendingDamageAssignment && state.pendingDamageAssignment.player === state.priorityPlayer && this.humanPlayers.includes(state.priorityPlayer)) {
        await this.showDamageAssignmentDialog(state);
        continue;
      }

      // Check pending legend choice
      if (state.pendingLegendChoice && state.pendingLegendChoice.player === state.priorityPlayer && this.humanPlayers.includes(state.priorityPlayer)) {
        await this.showLegendChoiceDialog(state);
        continue;
      }

      // Check pending commander choice
      if (state.pendingCommanderChoice && state.pendingCommanderChoice.player === state.priorityPlayer && this.humanPlayers.includes(state.priorityPlayer)) {
        await this.showCommanderChoiceDialog(state);
        continue;
      }

      // Auto-pass check (F2)
      if (this.autoPassEnabled && this.shouldAutoPass(state)) {
        this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
        this.hidePriorityPrompt();
        continue;
      }

      // Smart auto-skip: always on — skip phases with no legal actions
      // Never skip main phases (player may want to play lands/cast spells even if not yet tapped)
      // Never skip during respond mode (opponent might be responding)
      if (this.hasOnlyPassActions(state) && !this.respondMode && state.step !== 'main') {
        this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
        this.hidePriorityPrompt();
        continue;
      }

      // Priority prompt: show when stack has new items for human to respond to
      if (state.stack.length > 0 && state.stack.length > this.lastStackSize && !this.respondMode) {
        const topStack = state.stack[state.stack.length - 1];
        // Only show prompt if the top item was cast by opponent (not by us)
        if (topStack.controller !== state.priorityPlayer) {
          this.showPriorityPrompt(state);
          this.render();
          const promptAction = await this.waitForPriorityPromptOrAction();
          if (promptAction) {
            this.executeAction(promptAction);
          }
          continue;
        }
      }
      this.lastStackSize = state.stack.length;
      this.hidePriorityPrompt();

      // Render and wait for human input
      this.render();
      const action = await this.waitForPlayerAction();
      this.executeAction(action);
    }

    if (iterations >= MAX_ITERATIONS) {
      this.addLog('Game stopped: iteration limit reached.', 'error');
      this.running = false;
    }

    if (this.game.isOver()) {
      this.render();
      this.showGameOver();
    }
  }

  /** Should auto-pass this step? (Only when F2 is on) */
  private shouldAutoPass(state: GameState): boolean {
    const { step, activePlayer, priorityPlayer, stack } = state;

    // Never auto-pass if stack has items (player might want to respond)
    if (stack.length > 0) return false;

    // Never auto-pass main phases
    if (step === 'main') return false;

    // Never auto-pass declare-attackers for active player
    if (step === 'declare-attackers' && activePlayer === priorityPlayer) return false;

    // Never auto-pass declare-blockers for defending player
    if (step === 'declare-blockers' && activePlayer !== priorityPlayer) return false;

    // Check if player has any instant-speed actions available
    const legalTypes = getLegalActionTypes(state);
    const hasInstantActions = legalTypes.some(t =>
      t === 'cast-spell' || t === 'activate-ability' || t === 'tap-for-mana'
    );
    if (hasInstantActions) return false;

    return true;
  }

  /**
   * Check if the only legal actions are pass/concede (nothing meaningful to do).
   * Used for smart auto-skip: always on, skips phases where player has no choices.
   */
  private hasOnlyPassActions(state: GameState): boolean {
    const legalTypes = getLegalActionTypes(state);
    return legalTypes.every(t => t === 'pass' || t === 'concede');
  }

  // ==================== Actions ====================

  private waitForPlayerAction(): Promise<GameAction> {
    return new Promise<GameAction>((resolve) => {
      this.actionResolver = resolve;
      this.updateActionButtons();
    });
  }

  private executeAction(action: GameAction): void {
    const accepted = this.game.submitAction(action);
    if (accepted) {
      this.logAction(action);
      // Track stack size after action for prompt detection
      this.lastStackSize = this.game.getState().stack.length;
      this.respondMode = false;
    }
  }

  /** Submit action from UI */
  private submitAction(action: GameAction): void {
    if (this.actionResolver) {
      const resolver = this.actionResolver;
      this.actionResolver = null;
      this.selectedHandCard = null;
      this.attackerSelection = [];
      this.blockerAssignment.clear();
      this.pendingBlocker = null;
      this.cancelTargeting();
      resolver(action);
    }
  }

  // ==================== Public API ====================

  pass(): void {
    const state = this.game.getState();
    this.submitAction({ type: 'pass', player: state.priorityPlayer });
  }

  undo(): void {
    if (this.game.undo()) {
      this.render();
      this.addLog('Action undone.', 'warning');
    }
  }

  concede(): void {
    const state = this.game.getState();
    const player = this.currentViewPlayer;
    this.submitAction({ type: 'concede', player });
  }

  cancelCurrentAction(): void {
    if (this.targetingMode) {
      this.cancelTargeting();
      this.selectedHandCard = null;
      this.render();
    }
    if (this.pendingBlocker) {
      this.pendingBlocker = null;
      this.render();
    }
  }

  toggleAutoPass(): void {
    this.autoPassEnabled = !this.autoPassEnabled;
    this.addLog(this.autoPassEnabled ? 'Auto-pass enabled (F2)' : 'Auto-pass disabled', 'info');
    this.updateAutoPassBadge();
  }

  // ==================== Bot ====================

  private async botTurn(): Promise<void> {
    await sleep(150 + Math.random() * 200);
    const state = this.game.getState();

    // Handle pending states for bot automatically
    if (state.pendingDamageAssignment && state.pendingDamageAssignment.player === state.priorityPlayer) {
      // Bot auto-assigns damage equally among blockers
      const pending = state.pendingDamageAssignment;
      const assignments: Record<string, number> = {};
      const perBlocker = Math.floor(pending.totalDamage / pending.blockerIds.length);
      let remaining = pending.totalDamage;
      for (const id of pending.blockerIds) {
        const assign = id === pending.blockerIds[pending.blockerIds.length - 1] ? remaining : perBlocker;
        assignments[id] = assign;
        remaining -= assign;
      }
      this.game.submitAction({ type: 'assign-damage', player: pending.player, assignments, trampleDamage: 0 });
      this.addLog('Bot assigned combat damage.', 'combat');
      return;
    }

    if (state.pendingLegendChoice && state.pendingLegendChoice.player === state.priorityPlayer) {
      // Bot keeps the first (newest) legendary permanent
      const pending = state.pendingLegendChoice;
      this.game.submitAction({ type: 'legend-choice', player: pending.player, keepPermanentId: pending.permanentIds[0] });
      this.addLog('Bot resolved legend rule.', 'info');
      return;
    }

    if (state.pendingCommanderChoice && state.pendingCommanderChoice.player === state.priorityPlayer) {
      // Bot always moves commander to command zone
      const pending = state.pendingCommanderChoice;
      this.game.submitAction({ type: 'commander-zone-choice', player: pending.player, moveToCommandZone: true });
      this.addLog('Bot moved commander to command zone.', 'info');
      return;
    }

    const legalTypes = getLegalActionTypes(state);

    if (legalTypes.length === 0) {
      this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
      this.lastStackSize = this.game.getState().stack.length;
      return;
    }

    if (this.config.bot) {
      try {
        // Auto-tap lands for bot before decision
        const botState = this.autoTapAllLands(state, state.priorityPlayer);
        this.game.setState(botState);
        const action = this.config.bot.chooseAction(this.game.getState());
        this.executeAction(action);
      } catch {
        this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
      }
    } else {
      this.game.submitAction({ type: 'pass', player: state.priorityPlayer });
    }
    // Track stack size after bot action so priority prompt shows for new items
    this.lastStackSize = this.game.getState().stack.length;
  }

  // Cache for mana ability classification per permanent ID (avoids repeated toLowerCase)
  private _manaAbilityCache = new Map<string, string | null>();

  private autoTapAllLands(state: GameState, player: 0 | 1): GameState {
    // Prune stale cache entries periodically (IDs of permanents no longer on any battlefield)
    if (this._manaAbilityCache.size > 200) {
      const activeIds = new Set<string>();
      for (const p of state.players) for (const perm of p.battlefield) activeIds.add(perm.id);
      for (const id of this._manaAbilityCache.keys()) {
        if (!activeIds.has(id)) this._manaAbilityCache.delete(id);
      }
    }

    const ps = state.players[player];
    const pool = { ...ps.manaPool };
    const newBattlefield = ps.battlefield.map(perm => {
      if (perm.tapped) return perm;

      // Cache mana ability detection per permanent ID
      let manaType = this._manaAbilityCache.get(perm.id);
      if (manaType === undefined) {
        const typeLine = perm.typeLine.toLowerCase();
        const oracleText = (perm.oracleText ?? '').toLowerCase();
        const isManaSource = typeLine.includes('land') || oracleText.includes('{t}: add');
        if (!isManaSource) {
          this._manaAbilityCache.set(perm.id, null);
          return perm;
        }
        if (typeLine.includes('forest') || oracleText.includes('add {g}')) manaType = 'G';
        else if (typeLine.includes('island') || oracleText.includes('add {u}')) manaType = 'U';
        else if (typeLine.includes('plains') || oracleText.includes('add {w}')) manaType = 'W';
        else if (typeLine.includes('swamp') || oracleText.includes('add {b}')) manaType = 'B';
        else if (typeLine.includes('mountain') || oracleText.includes('add {r}')) manaType = 'R';
        else if (oracleText.includes('add {c}{c}')) manaType = 'CC';
        else if (oracleText.includes('add {c}')) manaType = 'C';
        else manaType = null;
        this._manaAbilityCache.set(perm.id, manaType);
      }

      if (manaType === null) return perm;
      if (manaType === 'CC') { pool.C += 2; return { ...perm, tapped: true }; }
      pool[manaType as 'W' | 'U' | 'B' | 'R' | 'G' | 'C']++;
      return { ...perm, tapped: true };
    });

    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    players[player] = { ...ps, battlefield: newBattlefield, manaPool: pool };
    return { ...state, players };
  }

  // ==================== UI Interaction Handlers ====================

  private async onHandCardClick(card: Card, _index: number): Promise<void> {
    // Discard phase override
    if (this.overrideHandCardClick) {
      this.overrideHandCardClick(card, _index);
      return;
    }
    if (!this.actionResolver) return;
    const state = this.game.getState();
    const player = state.priorityPlayer;
    if (!this.humanPlayers.includes(player)) return;

    // Cancel targeting if clicking hand while targeting
    if (this.targetingMode) {
      this.cancelTargeting();
      this.selectedHandCard = null;
      this.render();
      return;
    }

    const legalTypes = getLegalActionTypes(state);
    const isMainPhase = state.step === 'main' && state.activePlayer === player;
    const isLandCard = isLand(card);

    // Land
    if (isLandCard && legalTypes.includes('play-land')) {
      this.submitAction({ type: 'play-land', player, cardId: card.id });
      return;
    }
    if (isLandCard) {
      this.addLog("Can't play a land right now.", 'warning');
      return;
    }

    // Respond mode: filter to instants/flash only
    if (this.respondMode && !isInstant(card) && !(card.oracleText ?? '').toLowerCase().includes('flash')) {
      this.addLog(`Can only cast instants or flash spells in response.`, 'warning');
      return;
    }

    // Spell
    const me = state.players[player];
    const isInstantSpeed = isInstant(card) || (card.oracleText ?? '').toLowerCase().includes('flash');

    // Timing check
    if (!isInstantSpeed && (!isMainPhase || state.stack.length > 0)) {
      this.addLog(`Can only cast ${card.name} during your main phase with empty stack.`, 'warning');
      return;
    }

    // X-cost detection — prompt for X value before mana check
    const hasXCost = card.manaCost.includes('{X}');
    let xValue: number | undefined;

    if (hasXCost) {
      const xInput = await this.showXCostDialog(card);
      if (xInput === null) {
        // User cancelled
        return;
      }
      xValue = xInput;
    }

    // Build mana cost (substitute X if needed)
    let manaCostStr = card.manaCost;
    if (hasXCost && xValue !== undefined) {
      manaCostStr = manaCostStr.replace(/\{X\}/g, xValue > 0 ? `{${xValue}}` : '');
    }

    // Mana check + auto-tap
    const cost = parseManaCost(manaCostStr);
    const tapResult = autoTapLandsForCost(me, cost);
    if (!tapResult) {
      this.addLog(`Not enough mana to cast ${card.name}${hasXCost ? ` (X=${xValue})` : ''}.`, 'warning');
      return;
    }

    // Update state with tapped lands
    const updatedState = {
      ...state,
      players: state.players.map((p, i) =>
        i === player ? tapResult.updatedPlayer : p,
      ) as [typeof state.players[0], typeof state.players[1]],
    };
    this.game.setState(updatedState);

    // Aura/Equipment spells auto-enter targeting mode via spellNeedsTarget()
    // since they contain "target" in their oracle text (e.g. "Enchant creature")
    // This ensures the player chooses a legal target before the aura enters the battlefield

    // Check if spell needs targeting
    if (this.spellNeedsTarget(card)) {
      this.targetingMode = true;
      this.targetingCard = card;
      this.selectedHandCard = { card, index: _index };
      this.pendingXValue = xValue;
      this.pendingManaPayment = tapResult.payment;
      this.render();
      this.addLog(`Select a target for ${card.name}.`, 'info');
      return;
    }

    // Cast without targets
    this.submitAction({
      type: 'cast-spell',
      player,
      cardId: card.id,
      targets: [],
      manaPayment: tapResult.payment,
      xValue,
    });
  }

  private onBattlefieldClick(perm: Permanent, controller: 0 | 1): void {
    // Manual dialog click handler (counter, PT, damage-to-permanent)
    if (this.manualDialogBfClickHandler) {
      this.manualDialogBfClickHandler(perm, controller);
      return;
    }

    if (!this.actionResolver) return;
    const state = this.game.getState();
    const player = state.priorityPlayer;

    // Targeting mode — select target for spell or ability
    if (this.targetingMode && (this.targetingCard || this.targetingAbility)) {
      const legalIds = this.getLegalTargetIds();
      if (legalIds.includes(perm.id)) {
        const target: Target = { type: 'permanent', id: perm.id };

        if (this.targetingCard) {
          // Cast spell with target — use stored mana payment from auto-tap
          this.submitAction({
            type: 'cast-spell',
            player,
            cardId: this.targetingCard.id,
            targets: [target],
            manaPayment: this.pendingManaPayment || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: 0 },
            xValue: this.pendingXValue,
          });
          this.pendingXValue = undefined;
          this.pendingManaPayment = undefined;
        } else if (this.targetingAbility) {
          // Activate ability with target
          this.submitAction({
            type: 'activate-ability',
            player,
            sourceId: this.targetingAbility.source.id,
            abilityIndex: this.targetingAbility.abilityIndex,
            targets: [target],
          });
          this.targetingAbility = null;
        }
      } else {
        // Explain why the target is illegal
        const spellOrSource = this.targetingCard;
        if (hasKeyword(perm, 'shroud')) {
          this.addLog(`${perm.name} has shroud — cannot be targeted.`, 'warning');
        } else if (hasKeyword(perm, 'hexproof') && perm.controller !== player) {
          this.addLog(`${perm.name} has hexproof — cannot be targeted by opponents.`, 'warning');
        } else if (spellOrSource?.colors?.length && hasProtectionFrom(perm, spellOrSource.colors)) {
          this.addLog(`${perm.name} has protection from this spell's colors.`, 'warning');
        } else {
          this.addLog(`${perm.name} is not a legal target.`, 'warning');
        }
      }
      return;
    }

    // Tap for mana — click your own untapped land/mana source
    if (controller === player && !perm.tapped && hasManaAbility(perm.abilities)) {
      const manaAbilityIdx = perm.abilities.findIndex(a => a.type === 'mana');
      if (manaAbilityIdx >= 0) {
        this.submitAction({
          type: 'tap-for-mana',
          player,
          permanentId: perm.id,
          abilityIndex: manaAbilityIdx,
        });
        return;
      }
    }

    // Activated abilities — click your own permanent with non-mana activated abilities
    if (controller === player && !this.pendingBlocker) {
      const activatableAbilities = perm.abilities
        .map((a, idx) => ({ ability: a, index: idx }))
        .filter(({ ability }) => {
          if (ability.type === 'mana' || ability.type === 'static' || ability.type === 'triggered') return false;
          // Check timing
          if (!ability.instantSpeed && state.step !== 'main') return false;
          if (!ability.instantSpeed && state.stack.length > 0) return false;
          // Check {T} cost requirements
          if (ability.cost && ability.cost.toLowerCase().includes('{t}')) {
            if (perm.tapped) return false;
            if (perm.summoningSick && perm.currentPower !== undefined && !hasKeyword(perm, 'haste')) return false;
          }
          return true;
        });

      if (activatableAbilities.length > 0 && (!hasManaAbility(perm.abilities) || perm.tapped)) {
        // Show ability picker if there are activatable abilities (and no mana ability, or permanent is tapped so mana ability is unavailable)
        this.showAbilityPicker(perm, activatableAbilities, player);
        return;
      }

      // Planeswalker loyalty abilities
      const isPlaneswalker = perm.typeLine.toLowerCase().includes('planeswalker');
      if (isPlaneswalker && controller === player && !perm.tapped) {
        // Parse loyalty abilities from oracle text
        const loyaltyAbilities = this.parsePlaneswalkerAbilities(perm);
        if (loyaltyAbilities.length > 0) {
          this.showPlaneswalkerAbilityPicker(perm, loyaltyAbilities, player);
          return;
        }
      }
    }

    // Declare attackers — click your creatures to toggle
    if (
      state.step === 'declare-attackers' &&
      state.activePlayer === player &&
      controller === player &&
      isCreature(perm) &&
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
      return;
    }

    // Declare blockers
    if (
      state.step === 'declare-blockers' &&
      state.activePlayer !== player &&
      state.combat &&
      state.combat.attackers.length > 0
    ) {
      if (this.pendingBlocker) {
        if (controller !== player && state.combat.attackers.some(a => a.permanentId === perm.id)) {
          this.blockerAssignment.set(this.pendingBlocker, perm.id);
          this.pendingBlocker = null;
          this.render();
        } else if (controller === player && isCreature(perm) && !perm.tapped) {
          this.pendingBlocker = perm.id;
          this.render();
        } else {
          this.pendingBlocker = null;
          this.render();
        }
      } else {
        if (controller === player && isCreature(perm) && !perm.tapped) {
          if (this.blockerAssignment.has(perm.id)) {
            this.blockerAssignment.delete(perm.id);
            this.render();
          } else {
            this.pendingBlocker = perm.id;
            this.addLog('Select an attacking creature to block.', 'info');
            this.render();
          }
        }
      }
    }
  }

  private onPlayerClick(playerIdx: 0 | 1): void {
    if (!this.actionResolver) return;
    const state = this.game.getState();

    // Targeting mode — target a player
    if (this.targetingMode && (this.targetingCard || this.targetingAbility)) {
      const target: Target = { type: 'player', id: String(playerIdx) };

      if (this.targetingCard) {
        this.submitAction({
          type: 'cast-spell',
          player: state.priorityPlayer,
          cardId: this.targetingCard.id,
          targets: [target],
          manaPayment: this.pendingManaPayment || { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: 0 },
          xValue: this.pendingXValue,
        });
        this.pendingXValue = undefined;
        this.pendingManaPayment = undefined;
      } else if (this.targetingAbility) {
        this.submitAction({
          type: 'activate-ability',
          player: state.priorityPlayer,
          sourceId: this.targetingAbility.source.id,
          abilityIndex: this.targetingAbility.abilityIndex,
          targets: [target],
        });
        this.targetingAbility = null;
      }
    }
  }

  // ==================== Targeting ====================

  private spellNeedsTarget(card: Card): boolean {
    const text = (card.oracleText ?? '').toLowerCase();
    const typeLine = (card.typeLine ?? '').toLowerCase();
    // Auras always need a target even though they say "Enchant X" not "target X"
    if (typeLine.includes('aura') || text.includes('enchant creature') || text.includes('enchant permanent') || text.includes('enchant land') || text.includes('enchant artifact') || text.includes('enchant player')) {
      return true;
    }
    return text.includes('target');
  }

  private cancelTargeting(): void {
    this.targetingMode = false;
    this.targetingCard = null;
    this.targetingAbility = null;
    this.pendingXValue = undefined;
    this.pendingManaPayment = undefined;
  }

  private getLegalTargetIds(): string[] {
    if (!this.targetingCard && !this.targetingAbility) return [];
    const state = this.game.getState();
    const caster = state.priorityPlayer;

    // Determine oracle text and colors from either spell or ability
    let oracleText: string;
    let spellColors: string[];

    if (this.targetingCard) {
      oracleText = (this.targetingCard.oracleText ?? '').toLowerCase();
      spellColors = this.targetingCard.colors || [];
    } else if (this.targetingAbility) {
      const ability = this.targetingAbility.source.abilities[this.targetingAbility.abilityIndex];
      // Extract effect text (after colon for activated abilities)
      let abilityText = ability?.text || '';
      const colonIdx = abilityText.indexOf(':');
      if (colonIdx !== -1) abilityText = abilityText.substring(colonIdx + 1);
      oracleText = abilityText.toLowerCase();
      spellColors = this.targetingAbility.source.colors || [];
    } else {
      return [];
    }
    const targets: string[] = [];

    // Determine what kind of targets the spell can hit
    // Also handle Aura "Enchant X" keywords which implicitly target
    const canTargetCreatures = oracleText.includes('target creature') || oracleText.includes('any target') || oracleText.includes('target permanent') || oracleText.includes('enchant creature');
    const canTargetPlayers = oracleText.includes('target player') || oracleText.includes('any target') || oracleText.includes('target opponent') || oracleText.includes('enchant player');
    const canTargetPermanents = oracleText.includes('target permanent') || oracleText.includes('any target') || oracleText.includes('enchant permanent');
    const canTargetArtifacts = oracleText.includes('target artifact') || oracleText.includes('enchant artifact');
    const canTargetEnchantments = oracleText.includes('target enchantment') || oracleText.includes('enchant enchantment');
    const canTargetPlaneswalkers = oracleText.includes('target planeswalker') || oracleText.includes('any target');
    const canTargetLands = oracleText.includes('target land') || oracleText.includes('enchant land');

    // If the spell says "target" but we can't determine specifics, allow all
    const isGenericTarget = !canTargetCreatures && !canTargetPlayers && !canTargetPermanents && !canTargetArtifacts && !canTargetEnchantments && !canTargetPlaneswalkers && !canTargetLands;

    for (let pi = 0; pi < 2; pi++) {
      const p = state.players[pi];
      for (const perm of p.battlefield) {
        // Check type restrictions
        if (!isGenericTarget) {
          const typeLower = perm.typeLine.toLowerCase();
          const isCreaturePerm = typeLower.includes('creature');
          const isArtifactPerm = typeLower.includes('artifact');
          const isEnchantmentPerm = typeLower.includes('enchantment');
          const isPlaneswalkerPerm = typeLower.includes('planeswalker');
          const isLandPerm = typeLower.includes('land');

          let typeMatch = false;
          if (canTargetPermanents) typeMatch = true;
          if (canTargetCreatures && isCreaturePerm) typeMatch = true;
          if (canTargetArtifacts && isArtifactPerm) typeMatch = true;
          if (canTargetEnchantments && isEnchantmentPerm) typeMatch = true;
          if (canTargetPlaneswalkers && isPlaneswalkerPerm) typeMatch = true;
          if (canTargetLands && isLandPerm) typeMatch = true;

          if (!typeMatch) continue;
        }

        // Shroud: can't be targeted by any player
        if (hasKeyword(perm, 'shroud')) continue;

        // Hexproof: can't be targeted by opponents
        if (hasKeyword(perm, 'hexproof') && perm.controller !== caster) continue;

        // Protection from spell's colors
        if (spellColors.length > 0 && hasProtectionFrom(perm, spellColors)) continue;

        targets.push(perm.id);
      }
    }

    // Add player targets
    if (canTargetPlayers || isGenericTarget) {
      targets.push('player-0', 'player-1');
    }

    return targets;
  }

  // ==================== X-Cost Dialog ====================

  private showXCostDialog(card: Card): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      // Create overlay dialog
      let overlay = document.getElementById('xcost-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'xcost-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:200; display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(overlay);
      }

      overlay.innerHTML = `
        <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:24px 32px; min-width:280px; text-align:center; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4);">
          <div style="font-family:Cinzel,serif; font-size:1.1rem; color:var(--gold,#c9a84c); margin-bottom:4px;">${card.name}</div>
          <div style="font-size:0.8rem; color:var(--text-dim,#888); margin-bottom:16px;">Choose value for X</div>
          <div style="display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:16px;">
            <button id="xcost-minus" style="width:36px; height:36px; border-radius:50%; border:1px solid var(--border,#333); background:var(--bg-2,#141924); color:var(--text,#e4e4e4); font-size:1.2rem; cursor:pointer;">−</button>
            <span id="xcost-value" style="font-size:2rem; font-weight:700; color:var(--gold,#c9a84c); min-width:40px;">0</span>
            <button id="xcost-plus" style="width:36px; height:36px; border-radius:50%; border:1px solid var(--border,#333); background:var(--bg-2,#141924); color:var(--text,#e4e4e4); font-size:1.2rem; cursor:pointer;">+</button>
          </div>
          <div style="display:flex; gap:8px; justify-content:center;">
            <button id="xcost-confirm" class="re-action-btn primary" style="padding:8px 20px;">Cast (X=<span id="xcost-confirm-val">0</span>)</button>
            <button id="xcost-cancel" class="re-action-btn" style="padding:8px 16px;">Cancel</button>
          </div>
        </div>
      `;
      overlay.style.display = 'flex';

      let value = 0;
      const valueEl = document.getElementById('xcost-value')!;
      const confirmValEl = document.getElementById('xcost-confirm-val')!;

      const updateDisplay = () => {
        valueEl.textContent = String(value);
        confirmValEl.textContent = String(value);
      };

      document.getElementById('xcost-minus')!.addEventListener('click', () => {
        if (value > 0) { value--; updateDisplay(); }
      });
      document.getElementById('xcost-plus')!.addEventListener('click', () => {
        value++; updateDisplay();
      });
      document.getElementById('xcost-confirm')!.addEventListener('click', () => {
        overlay!.style.display = 'none';
        resolve(value);
      });
      document.getElementById('xcost-cancel')!.addEventListener('click', () => {
        overlay!.style.display = 'none';
        resolve(null);
      });
    });
  }

  // ==================== Activated Ability Picker ====================

  private showAbilityPicker(
    perm: Permanent,
    abilities: { ability: { text: string; cost?: string; instantSpeed?: boolean }; index: number }[],
    player: 0 | 1,
  ): void {
    // Remove any existing picker
    document.getElementById('ability-picker')?.remove();

    const picker = document.createElement('div');
    picker.id = 'ability-picker';
    picker.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:200; display:flex; align-items:center; justify-content:center;';

    let abilitiesHtml = '';
    for (const { ability, index } of abilities) {
      const costText = ability.cost ? `<span style="color:var(--gold,#c9a84c);">${ability.cost}</span>: ` : '';
      const effectText = ability.text.includes(':') ? ability.text.split(':').slice(1).join(':').trim() : ability.text;
      abilitiesHtml += `
        <button class="ability-pick-btn" data-idx="${index}" style="display:block; width:100%; text-align:left; padding:10px 14px; border:1px solid var(--border,#333); border-radius:10px; background:var(--bg-2,#141924); color:var(--text,#e4e4e4); cursor:pointer; font-size:0.82rem; font-family:Outfit,sans-serif; margin-bottom:6px; transition:border-color 0.15s;">
          ${costText}<span style="color:var(--text,#e4e4e4);">${effectText}</span>
        </button>
      `;
    }

    picker.innerHTML = `
      <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:20px 24px; min-width:300px; max-width:420px; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4);">
        <div style="font-family:Cinzel,serif; font-size:1rem; color:var(--gold,#c9a84c); margin-bottom:4px;">${perm.name}</div>
        <div style="font-size:0.75rem; color:var(--text-dim,#888); margin-bottom:12px;">Activate an ability</div>
        ${abilitiesHtml}
        <button id="ability-pick-cancel" class="re-action-btn" style="width:100%; margin-top:4px; padding:8px;">Cancel</button>
      </div>
    `;

    document.body.appendChild(picker);

    // Wire ability buttons
    picker.querySelectorAll('.ability-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
        picker.remove();
        this.activateAbility(perm, idx, player);
      });
      // Hover effect
      (btn as HTMLElement).addEventListener('mouseenter', () => {
        (btn as HTMLElement).style.borderColor = 'var(--gold,#c9a84c)';
      });
      (btn as HTMLElement).addEventListener('mouseleave', () => {
        (btn as HTMLElement).style.borderColor = 'var(--border,#333)';
      });
    });

    // Cancel
    document.getElementById('ability-pick-cancel')!.addEventListener('click', () => picker.remove());
    // Click outside
    picker.addEventListener('click', (e) => {
      if (e.target === picker) picker.remove();
    });
  }

  private activateAbility(perm: Permanent, abilityIndex: number, player: 0 | 1): void {
    const ability = perm.abilities[abilityIndex];
    if (!ability) return;

    // Parse mana cost from ability cost string
    const costStr = ability.cost || '';
    const state = this.game.getState();
    const me = state.players[player];

    // Check for mana in cost (e.g. "{2}{B}", "{1}", etc.)
    const manaMatch = costStr.match(/\{[WUBRGC0-9X]+\}/g);
    if (manaMatch && manaMatch.length > 0) {
      const manaCostStr = manaMatch.join('');
      const cost = parseManaCost(manaCostStr);
      const tapResult = autoTapLandsForCost(me, cost);
      if (!tapResult) {
        this.addLog(`Not enough mana to activate ${perm.name}'s ability (${costStr}).`, 'warning');
        return;
      }
      // Update state with tapped lands
      const updatedState = {
        ...state,
        players: state.players.map((p, i) =>
          i === player ? tapResult.updatedPlayer : p,
        ) as [typeof state.players[0], typeof state.players[1]],
      };
      this.game.setState(updatedState);
    }

    // Extract effect text to check if targeting is needed
    let effectText = ability.text;
    const colonIdx = effectText.indexOf(':');
    if (colonIdx !== -1) effectText = effectText.substring(colonIdx + 1).trim();

    const needsTarget = effectText.toLowerCase().includes('target');

    if (needsTarget) {
      this.targetingMode = true;
      this.targetingAbility = { source: perm, abilityIndex };
      this.targetingCard = null;
      this.render();
      this.addLog(`Select a target for ${perm.name}'s ability.`, 'info');
    } else {
      this.submitAction({
        type: 'activate-ability',
        player,
        sourceId: perm.id,
        abilityIndex,
        targets: [],
      });
    }
  }

  // ==================== Combat Overlays ====================

  private updateActionButtons(): void {
    const state = this.game.getState();
    const player = state.priorityPlayer;
    const isMyPriority = this.humanPlayers.includes(player);

    setButtonEnabled('btn-pass', isMyPriority);
    setButtonEnabled('btn-undo', this.game.canUndo());
    setButtonEnabled('btn-concede', true);

    // Combat overlays
    const actionBtns = document.getElementById('action-buttons');
    if (!actionBtns) return;

    // Remove any existing combat buttons
    actionBtns.querySelectorAll('.re-combat-btn').forEach(el => el.remove());

    if (state.step === 'declare-attackers' && state.activePlayer === player && isMyPriority) {
      const atkBtn = document.createElement('button');
      atkBtn.className = 're-action-btn primary re-combat-btn';
      atkBtn.textContent = `Confirm Attack (${this.attackerSelection.length})`;
      atkBtn.addEventListener('click', () => {
        this.submitAction({ type: 'declare-attackers', player, attackers: this.attackerSelection });
      });
      actionBtns.appendChild(atkBtn);

      const noAtkBtn = document.createElement('button');
      noAtkBtn.className = 're-action-btn re-combat-btn';
      noAtkBtn.textContent = 'No Attack';
      noAtkBtn.addEventListener('click', () => {
        this.submitAction({ type: 'declare-attackers', player, attackers: [] });
      });
      actionBtns.appendChild(noAtkBtn);
    }

    if (state.step === 'declare-blockers' && state.activePlayer !== player && isMyPriority) {
      const blocks = Array.from(this.blockerAssignment.entries()).map(([blocker, attacker]) => ({ blocker, attacker }));

      const blkBtn = document.createElement('button');
      blkBtn.className = 're-action-btn primary re-combat-btn';
      blkBtn.textContent = `Confirm Blocks (${blocks.length})`;
      blkBtn.addEventListener('click', () => {
        this.submitAction({ type: 'declare-blockers', player, blocks });
      });
      actionBtns.appendChild(blkBtn);

      const noBlkBtn = document.createElement('button');
      noBlkBtn.className = 're-action-btn re-combat-btn';
      noBlkBtn.textContent = 'No Blocks';
      noBlkBtn.addEventListener('click', () => {
        this.submitAction({ type: 'declare-blockers', player, blocks: [] });
      });
      actionBtns.appendChild(noBlkBtn);
    }

    // Stack response indicator (compact, since priority prompt handles the main UX)
    if (state.stack.length > 0 && isMyPriority && this.respondMode) {
      const respondInfo = document.createElement('div');
      respondInfo.className = 're-combat-btn';
      respondInfo.style.cssText = 'font-size: 0.72rem; color: var(--gold); padding: 4px 8px; background: rgba(201,168,76,0.08); border-radius: 8px;';
      const topStack = state.stack[state.stack.length - 1];
      respondInfo.textContent = `Stack: ${topStack.text}`;
      actionBtns.appendChild(respondInfo);
    }
  }

  // ==================== Rendering ====================

  /**
   * Schedule a render on the next animation frame.
   * Multiple calls between frames are coalesced into a single paint.
   */
  scheduleRender(): void {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.render();
    });
  }

  render(): void {
    const state = this.game.getState();
    renderBoard(state, this.currentViewPlayer, this.getCallbacks());
    this.updatePhaseTimeline(state);
    this.updateManaPool(state);
    this.updateAutoPassBadge();
  }

  private getCallbacks(): SimBoardCallbacks {
    return {
      onHandCardClick: (card, index) => this.onHandCardClick(card, index),
      onBattlefieldCardClick: (perm, controller) => this.onBattlefieldClick(perm, controller),
      onPlayerClick: (playerIdx) => this.onPlayerClick(playerIdx),
      canUndo: () => this.game.canUndo(),
      selectedHandCardId: this.selectedHandCard?.card.id ?? null,
      targetingMode: this.targetingMode,
      legalTargetIds: this.targetingMode ? this.getLegalTargetIds() : [],
      attackerIds: this.attackerSelection,
      blockerAssignment: this.blockerAssignment,
      pendingBlockerId: this.pendingBlocker,
      viewPlayer: this.currentViewPlayer,
      playerNames: [this.config.p1Name, this.config.p2Name],
    };
  }

  // ==================== Phase Timeline ====================

  private buildPhaseTimeline(): void {
    const container = document.getElementById('phase-timeline');
    if (!container) return;
    container.innerHTML = '';

    for (const step of ALL_STEPS) {
      const pip = document.createElement('div');
      pip.className = 're-phase-pip';
      pip.dataset.step = step;
      pip.textContent = STEP_LABELS[step];
      container.appendChild(pip);
    }
  }

  private updatePhaseTimeline(state: GameState): void {
    const container = document.getElementById('phase-timeline');
    if (!container) return;

    const currentIdx = ALL_STEPS.indexOf(state.step);
    const legalTypes = getLegalActionTypes(state);
    const hasActions = legalTypes.some(t => t !== 'pass' && t !== 'concede');

    container.querySelectorAll('.re-phase-pip').forEach((pip, i) => {
      pip.classList.remove('active', 'passed', 'no-actions');
      if (i === currentIdx) {
        pip.classList.add('active');
        if (!hasActions) pip.classList.add('no-actions');
      } else if (i < currentIdx) {
        pip.classList.add('passed');
      }
    });
  }

  // ==================== Mana Pool ====================

  private updateManaPool(state: GameState): void {
    const player = this.currentViewPlayer;
    const pool = state.players[player].manaPool;
    const colors: ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[] = ['W', 'U', 'B', 'R', 'G', 'C'];

    for (const color of colors) {
      const pip = document.querySelector(`.re-mana-pip[data-color="${color}"]`);
      if (pip) {
        const val = pool[color] || 0;
        pip.textContent = String(val);
        pip.classList.toggle('has-mana', val > 0);
      }
    }
  }

  // ==================== Mulligan ====================

  private async handleMulligan(player: 0 | 1): Promise<void> {
    let state = this.game.getState();
    state = drawOpeningHand(state, player);
    this.game.setState(state);

    const overlay = document.getElementById('mulligan-overlay');
    if (!overlay) return;

    overlay.classList.remove('hidden');
    await this.showMulliganUI(player);
    overlay.classList.add('hidden');
  }

  private showMulliganUI(player: 0 | 1): Promise<void> {
    return new Promise<void>((resolve) => {
      const state = this.game.getState();
      const hand = state.players[player].hand;
      const mulliganCount = state.mulliganCount[player];
      const playerName = player === 0 ? this.config.p1Name : this.config.p2Name;

      const titleEl = document.getElementById('mulligan-title');
      const handEl = document.getElementById('mulligan-hand');
      const infoEl = document.getElementById('mulligan-info');
      if (!titleEl || !handEl || !infoEl) { resolve(); return; }

      const bottomSelection = new Set<string>();
      const needBottom = mulliganCount;

      titleEl.textContent = mulliganCount > 0
        ? `${playerName}: Select ${needBottom} card(s) to put on bottom`
        : `${playerName}: Opening Hand (${hand.length} cards)`;

      const renderCards = () => {
        handEl.innerHTML = '';
        for (const card of hand) {
          const img = document.createElement('img');
          img.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
          img.alt = card.name;
          img.loading = 'lazy';
          if (bottomSelection.has(card.id)) img.classList.add('mulligan-selected');
          if (mulliganCount > 0) {
            img.addEventListener('click', () => {
              if (bottomSelection.has(card.id)) bottomSelection.delete(card.id);
              else if (bottomSelection.size < needBottom) bottomSelection.add(card.id);
              renderCards();
            });
          }
          handEl.appendChild(img);
        }

        const landCount = hand.filter(c => !bottomSelection.has(c.id) && c.typeLine.toLowerCase().includes('land')).length;
        const keeping = hand.length - bottomSelection.size;
        infoEl.textContent = `Keeping ${keeping} cards (${landCount} lands)`;
      };

      renderCards();

      // Wire buttons
      const keepBtn = document.getElementById('btn-keep');
      const mullBtn = document.getElementById('btn-mulligan');

      const keepHandler = () => {
        if (mulliganCount > 0 && bottomSelection.size !== needBottom) return;
        this.game.submitAction({ type: 'mulligan', player, toBottom: Array.from(bottomSelection) });
        this.addLog(`${playerName} kept ${hand.length - bottomSelection.size} cards.`);
        keepBtn?.removeEventListener('click', keepHandler);
        mullBtn?.removeEventListener('click', mullHandler);
        resolve();
      };

      const mullHandler = () => {
        const toBottom = hand.slice(-1).map(c => c.id);
        this.game.submitAction({ type: 'mulligan', player, toBottom });
        this.addLog(`${playerName} mulliganed to ${hand.length - 1}.`);
        keepBtn?.removeEventListener('click', keepHandler);
        mullBtn?.removeEventListener('click', mullHandler);
        this.showMulliganUI(player).then(resolve);
      };

      keepBtn?.addEventListener('click', keepHandler);
      mullBtn?.addEventListener('click', mullHandler);
    });
  }

  // ==================== Hotseat ====================

  private showHotseatPassScreen(nextPlayer: 0 | 1): Promise<void> {
    return new Promise<void>((resolve) => {
      const overlay = document.getElementById('hotseat-pass');
      const title = document.getElementById('hotseat-pass-title');
      const btn = document.getElementById('btn-hotseat-ready');
      if (!overlay || !btn) { resolve(); return; }

      const name = nextPlayer === 0 ? this.config.p1Name : this.config.p2Name;
      if (title) title.textContent = `Pass to ${name}`;
      overlay.classList.remove('hidden');

      const handler = () => {
        overlay.classList.add('hidden');
        this.currentViewPlayer = nextPlayer;
        btn.removeEventListener('click', handler);
        resolve();
      };
      btn.addEventListener('click', handler);
    });
  }

  // ==================== Hand Size Discard ====================

  private async handleDiscardPhase(state: GameState): Promise<void> {
    const player = state.pendingDiscard!;
    const discardCount = state.pendingDiscardCount ?? 0;
    const hand = state.players[player].hand;

    this.addLog(`Select ${discardCount} card(s) to discard.`, 'warning');

    const selectedCards = new Set<string>();

    return new Promise<void>((resolve) => {
      // Override hand card click to toggle selection for discard
      const discardClickHandler = (card: Card, _index: number) => {
        if (selectedCards.has(card.id)) {
          selectedCards.delete(card.id);
        } else if (selectedCards.size < discardCount) {
          selectedCards.add(card.id);
        }

        // Update visual selection
        const handContainer = document.getElementById('player-hand');
        if (handContainer) {
          handContainer.querySelectorAll('.re-card').forEach((el) => {
            const cardId = (el as HTMLElement).dataset.cardId;
            if (cardId && selectedCards.has(cardId)) {
              el.classList.add('selected');
            } else {
              el.classList.remove('selected');
            }
          });
        }

        // Update discard info
        const info = document.getElementById('discard-info');
        if (info) {
          info.textContent = `Selected ${selectedCards.size} / ${discardCount} to discard`;
        }

        // Enable confirm button when enough selected
        const confirmBtn = document.getElementById('btn-confirm-discard');
        if (confirmBtn) {
          (confirmBtn as HTMLButtonElement).disabled = selectedCards.size !== discardCount;
        }
      };

      // Show discard UI overlay
      this.showDiscardOverlay(discardCount, hand.length);

      // Wire up hand clicks for discard selection
      this.overrideHandCardClick = discardClickHandler;

      // Confirm button
      const confirmBtn = document.getElementById('btn-confirm-discard');
      const confirmHandler = () => {
        if (selectedCards.size !== discardCount) return;
        this.game.submitAction({ type: 'discard', player, cardIds: Array.from(selectedCards) });
        this.hideDiscardOverlay();
        this.overrideHandCardClick = null;
        confirmBtn?.removeEventListener('click', confirmHandler);
        this.addLog(`Discarded ${discardCount} card(s).`);
        resolve();
      };
      confirmBtn?.addEventListener('click', confirmHandler);
    });
  }

  private botDiscard(state: GameState): void {
    const player = state.pendingDiscard!;
    const discardCount = state.pendingDiscardCount ?? 0;
    const hand = [...state.players[player].hand];

    // Bot strategy: discard highest-cost non-land cards first
    hand.sort((a, b) => {
      // Lands have 0 CMC but are valuable — keep them
      const aIsLand = isLand(a);
      const bIsLand = isLand(b);
      if (aIsLand && !bIsLand) return 1; // keep land
      if (!aIsLand && bIsLand) return -1; // discard non-land
      return b.cmc - a.cmc; // discard highest CMC first
    });

    const toDiscard = hand.slice(0, discardCount).map((c) => c.id);
    this.game.submitAction({ type: 'discard', player, cardIds: toDiscard });
    this.addLog(`Bot discarded ${discardCount} card(s).`);
  }

  private showDiscardOverlay(discardCount: number, handSize: number): void {
    // Create a simple discard info bar above the hand
    let overlay = document.getElementById('discard-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'discard-overlay';
      overlay.style.cssText = 'position:fixed; bottom:140px; left:50%; transform:translateX(-50%); background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:12px; padding:12px 24px; z-index:100; display:flex; align-items:center; gap:16px; color:var(--text,#e4e4e4); font-family:Outfit,sans-serif;';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <span style="font-weight:600;">Hand Size: ${handSize}/7</span>
      <span id="discard-info" style="color:var(--gold,#c9a84c);">Selected 0 / ${discardCount} to discard</span>
      <button id="btn-confirm-discard" disabled style="background:var(--gold,#c9a84c); color:#000; border:none; border-radius:8px; padding:8px 16px; cursor:pointer; font-weight:600;">Confirm Discard</button>
    `;
    overlay.style.display = 'flex';
  }

  private hideDiscardOverlay(): void {
    const overlay = document.getElementById('discard-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  // Override for hand card click during discard phase
  private overrideHandCardClick: ((card: Card, index: number) => void) | null = null;

  // ==================== Manual Resolution ====================

  // Dialog state for counter/PT picking
  private manualDialogActive: 'counter' | 'token' | 'move' | 'pt' | null = null;
  private manualDialogBfClickHandler: ((perm: Permanent, controller: 0 | 1) => void) | null = null;

  // Move card dialog state
  private moveSourceZone: string | null = null;
  private moveSelectedCardId: string | null = null;
  private moveDestZone: string | null = null;

  private showManualResolutionPanel(state: GameState): void {
    const panel = document.getElementById('manual-panel');
    const cardName = document.getElementById('manual-card-name');
    const oracle = document.getElementById('manual-oracle');
    const btns = document.getElementById('manual-btns');
    if (!panel || !cardName || !oracle || !btns) return;

    const card = state.manualResolutionCard;
    if (!card) return;

    this.inManualResolution = true;
    cardName.textContent = card.name;
    oracle.textContent = card.oracleText || 'No oracle text.';
    panel.classList.remove('hidden');

    btns.innerHTML = '';
    const actions: { label: string; action: () => void }[] = [
      { label: '⚡ Deal Damage', action: () => this.manualDamage(state) },
      { label: '🃏 Draw Cards', action: () => this.manualDraw(state) },
      { label: '💚 Gain Life', action: () => this.manualLife(state, 1) },
      { label: '💔 Lose Life', action: () => this.manualLife(state, -1) },
      { label: '📦 Move Card', action: () => this.openMoveDialog(state) },
      { label: '🔢 Add Counter', action: () => this.openCounterDialog(state) },
      { label: '🎭 Create Token', action: () => this.openTokenDialog(state) },
      { label: '⚔️ Modify P/T', action: () => this.openPTDialog(state) },
      {
        label: '✅ Done', action: () => {
          panel.classList.add('hidden');
          this.inManualResolution = false;
          // Clear manual resolution flag
          const current = this.game.getState();
          this.game.setState({
            ...current,
            needsManualResolution: false,
            manualResolutionCard: undefined,
            manualResolutionController: undefined,
          });
        },
      },
    ];

    for (const { label, action } of actions) {
      const btn = document.createElement('button');
      btn.className = 're-action-btn' + (label.includes('Done') ? ' primary' : '');
      btn.textContent = label;
      btn.addEventListener('click', action);
      btns.appendChild(btn);
    }
  }

  private showDialogBackdrop(): void {
    const backdrop = document.getElementById('manual-dialog-backdrop');
    if (backdrop) backdrop.classList.remove('hidden');
  }

  private hideDialogBackdrop(): void {
    const backdrop = document.getElementById('manual-dialog-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
  }

  private closeAllDialogs(): void {
    document.getElementById('counter-dialog')?.classList.add('hidden');
    document.getElementById('token-dialog')?.classList.add('hidden');
    document.getElementById('move-dialog')?.classList.add('hidden');
    document.getElementById('pt-dialog')?.classList.add('hidden');
    this.hideDialogBackdrop();
    this.manualDialogActive = null;
    this.manualDialogBfClickHandler = null;
  }

  private wireManualDialogs(): void {
    // Backdrop click closes all dialogs
    document.getElementById('manual-dialog-backdrop')?.addEventListener('click', () => this.closeAllDialogs());
  }

  // ─── Deal Damage (enhanced — supports targeting permanents) ───

  private manualDamage(state: GameState): void {
    const amount = parseInt(prompt('Damage amount:') || '0');
    if (!amount) return;

    // Ask: player or permanent?
    const targetChoice = prompt('Target type? "p" = player, "c" = creature/permanent (default: p):') || 'p';
    const controller = state.manualResolutionController ?? 0;

    if (targetChoice === 'c') {
      // Enable click-to-target mode
      this.addLog('Click a permanent to deal damage to it.', 'info');
      this.manualDialogBfClickHandler = (perm: Permanent, permController: 0 | 1) => {
        this.game.submitAction({
          type: 'manual-damage',
          player: controller,
          targetId: perm.id,
          targetType: 'permanent',
          amount,
        });
        this.addLog(`Manual: ${amount} damage to ${perm.name}.`);
        this.manualDialogBfClickHandler = null;
        this.render();
      };
    } else {
      const targetStr = prompt('Target player (0=you, 1=opponent):') || '1';
      const target = parseInt(targetStr) as 0 | 1;
      this.game.submitAction({
        type: 'manual-damage',
        player: controller,
        targetId: `player-${target}`,
        targetType: 'player',
        amount,
      });
      this.addLog(`Manual: ${amount} damage to ${state.players[target].name}.`);
      this.render();
    }
  }

  // ─── Draw Cards ───

  private manualDraw(state: GameState): void {
    const count = parseInt(prompt('How many cards to draw?') || '0');
    if (!count) return;
    const controller = state.manualResolutionController ?? 0;

    // Ask which player draws
    const targetStr = prompt(`Which player draws? (0=${state.players[0].name}, 1=${state.players[1].name}):`) || String(controller);
    const target = parseInt(targetStr) as 0 | 1;

    this.game.submitAction({
      type: 'manual-draw',
      player: controller,
      targetPlayer: target,
      count,
    });
    this.addLog(`Manual: ${state.players[target].name} drew ${count} card(s).`);
    this.render();
  }

  // ─── Life Gain/Loss ───

  private manualLife(state: GameState, sign: 1 | -1): void {
    const amount = parseInt(prompt(`${sign > 0 ? 'Gain' : 'Lose'} how much life?`) || '0');
    if (!amount) return;
    const controller = state.manualResolutionController ?? 0;

    // Ask which player
    const targetStr = prompt(`Which player? (0=${state.players[0].name}, 1=${state.players[1].name}):`) || String(controller);
    const target = parseInt(targetStr) as 0 | 1;

    this.game.submitAction({
      type: 'manual-life',
      player: controller,
      targetPlayer: target,
      delta: sign * amount,
    });
    this.addLog(`Manual: ${state.players[target].name} ${sign > 0 ? 'gained' : 'lost'} ${amount} life.`);
    this.render();
  }

  // ─── Counter Dialog ───

  private openCounterDialog(_state: GameState): void {
    this.manualDialogActive = 'counter';
    this.showDialogBackdrop();
    const dialog = document.getElementById('counter-dialog');
    if (!dialog) return;
    dialog.classList.remove('hidden');

    // Reset fields
    (document.getElementById('counter-amount') as HTMLInputElement).value = '1';
    (document.getElementById('counter-target') as HTMLInputElement).value = '';
    (document.getElementById('counter-target-id') as HTMLInputElement).value = '';
    (document.getElementById('counter-target-owner') as HTMLInputElement).value = '';
    const customInput = document.getElementById('counter-custom-type') as HTMLInputElement;
    customInput.style.display = 'none';
    customInput.value = '';

    // Reset preset buttons
    dialog.querySelectorAll('.counter-preset').forEach(b => b.classList.remove('active'));
    dialog.querySelector('.counter-preset[data-type="+1/+1"]')?.classList.add('active');

    // Wire preset buttons
    dialog.querySelectorAll('.counter-preset').forEach(btn => {
      const handler = () => {
        dialog.querySelectorAll('.counter-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const type = (btn as HTMLElement).dataset.type;
        customInput.style.display = type === 'custom' ? '' : 'none';
      };
      btn.replaceWith(btn.cloneNode(true));
    });
    // Re-wire after cloning
    dialog.querySelectorAll('.counter-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        dialog.querySelectorAll('.counter-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const type = (btn as HTMLElement).dataset.type;
        customInput.style.display = type === 'custom' ? '' : 'none';
      });
    });

    // Enable battlefield click to select target
    this.manualDialogBfClickHandler = (perm: Permanent, controller: 0 | 1) => {
      (document.getElementById('counter-target') as HTMLInputElement).value = perm.name;
      (document.getElementById('counter-target-id') as HTMLInputElement).value = perm.id;
      (document.getElementById('counter-target-owner') as HTMLInputElement).value = String(controller);
      this.addLog(`Selected: ${perm.name}`, 'info');
    };

    // Wire Apply button
    const applyBtn = document.getElementById('counter-apply');
    const cancelBtn = document.getElementById('counter-cancel');
    const onApply = () => {
      const targetId = (document.getElementById('counter-target-id') as HTMLInputElement).value;
      const targetOwner = parseInt((document.getElementById('counter-target-owner') as HTMLInputElement).value || '0') as 0 | 1;
      const amount = parseInt((document.getElementById('counter-amount') as HTMLInputElement).value || '1');

      if (!targetId) {
        this.addLog('Select a permanent first!', 'warning');
        return;
      }

      // Determine counter type
      const activePreset = dialog.querySelector('.counter-preset.active') as HTMLElement;
      let counterType = activePreset?.dataset.type || '+1/+1';
      if (counterType === 'custom') {
        counterType = customInput.value.trim() || 'custom';
      }

      const state = this.game.getState();
      const controller = state.manualResolutionController ?? 0;

      this.game.submitAction({
        type: 'manual-counter',
        player: controller,
        permanentId: targetId,
        counterType,
        delta: amount,
      });

      const permName = (document.getElementById('counter-target') as HTMLInputElement).value;
      this.addLog(`Manual: ${amount > 0 ? '+' : ''}${amount} ${counterType} counter on ${permName}.`);
      this.closeAllDialogs();
      this.render();

      applyBtn?.removeEventListener('click', onApply);
      cancelBtn?.removeEventListener('click', onCancel);
    };
    const onCancel = () => {
      this.closeAllDialogs();
      applyBtn?.removeEventListener('click', onApply);
      cancelBtn?.removeEventListener('click', onCancel);
    };

    applyBtn?.addEventListener('click', onApply);
    cancelBtn?.addEventListener('click', onCancel);
  }

  // ─── Token Dialog ───

  private openTokenDialog(_state: GameState): void {
    this.manualDialogActive = 'token';
    this.showDialogBackdrop();
    const dialog = document.getElementById('token-dialog');
    if (!dialog) return;
    dialog.classList.remove('hidden');

    // Reset fields
    (document.getElementById('token-name') as HTMLInputElement).value = 'Token';
    (document.getElementById('token-qty') as HTMLInputElement).value = '1';
    (document.getElementById('token-power') as HTMLInputElement).value = '1';
    (document.getElementById('token-toughness') as HTMLInputElement).value = '1';
    (document.getElementById('token-type') as HTMLInputElement).value = 'Token Creature';

    const createBtn = document.getElementById('token-create');
    const cancelBtn = document.getElementById('token-cancel');

    const onCreate = () => {
      const state = this.game.getState();
      const controller = state.manualResolutionController ?? 0;

      const name = (document.getElementById('token-name') as HTMLInputElement).value.trim() || 'Token';
      const qty = parseInt((document.getElementById('token-qty') as HTMLInputElement).value || '1');
      const power = parseInt((document.getElementById('token-power') as HTMLInputElement).value || '1');
      const toughness = parseInt((document.getElementById('token-toughness') as HTMLInputElement).value || '1');
      const typeLine = (document.getElementById('token-type') as HTMLInputElement).value.trim() || 'Token Creature';

      this.game.submitAction({
        type: 'manual-token',
        player: controller,
        name,
        power,
        toughness,
        typeLine,
        qty,
      });

      this.addLog(`Manual: Created ${qty} ${power}/${toughness} ${name} token(s).`);
      this.closeAllDialogs();
      this.render();

      createBtn?.removeEventListener('click', onCreate);
      cancelBtn?.removeEventListener('click', onCancel);
    };
    const onCancel = () => {
      this.closeAllDialogs();
      createBtn?.removeEventListener('click', onCreate);
      cancelBtn?.removeEventListener('click', onCancel);
    };

    createBtn?.addEventListener('click', onCreate);
    cancelBtn?.addEventListener('click', onCancel);
  }

  // ─── Move Card Dialog ───

  private openMoveDialog(_state: GameState): void {
    this.manualDialogActive = 'move';
    this.showDialogBackdrop();
    const dialog = document.getElementById('move-dialog');
    if (!dialog) return;
    dialog.classList.remove('hidden');

    this.moveSourceZone = null;
    this.moveSelectedCardId = null;
    this.moveDestZone = null;

    const cardPick = document.getElementById('move-card-pick');
    if (cardPick) { cardPick.innerHTML = ''; cardPick.style.display = 'none'; }

    // Reset selected states
    dialog.querySelectorAll('.zone-pick-btn').forEach(b => b.classList.remove('selected'));

    // Wire source zone buttons
    const sourceGrid = document.getElementById('move-source-grid');
    if (sourceGrid) {
      sourceGrid.querySelectorAll('.zone-pick-btn').forEach(btn => {
        const clone = btn.cloneNode(true) as HTMLElement;
        btn.replaceWith(clone);
        clone.addEventListener('click', () => {
          sourceGrid.querySelectorAll('.zone-pick-btn').forEach(b => b.classList.remove('selected'));
          clone.classList.add('selected');
          this.moveSourceZone = clone.dataset.zone || null;
          this.moveSelectedCardId = null;
          this.populateMoveCardList();
        });
      });
    }

    // Wire dest zone buttons
    const destGrid = document.getElementById('move-dest-grid');
    if (destGrid) {
      destGrid.querySelectorAll('.zone-pick-btn').forEach(btn => {
        const clone = btn.cloneNode(true) as HTMLElement;
        btn.replaceWith(clone);
        clone.addEventListener('click', () => {
          destGrid.querySelectorAll('.zone-pick-btn').forEach(b => b.classList.remove('selected'));
          clone.classList.add('selected');
          this.moveDestZone = clone.dataset.zone || null;
        });
      });
    }

    const applyBtn = document.getElementById('move-apply');
    const cancelBtn = document.getElementById('move-cancel');

    const onApply = () => {
      if (!this.moveSourceZone || !this.moveSelectedCardId || !this.moveDestZone) {
        this.addLog('Select source zone, card, and destination zone.', 'warning');
        return;
      }
      if (this.moveSourceZone === this.moveDestZone) {
        this.addLog('Source and destination must be different.', 'warning');
        return;
      }

      const state = this.game.getState();
      const controller = state.manualResolutionController ?? this.currentViewPlayer;

      this.game.submitAction({
        type: 'manual-move',
        player: controller,
        cardId: this.moveSelectedCardId,
        from: this.moveSourceZone as 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'commandZone',
        to: this.moveDestZone as 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'commandZone',
      });

      this.addLog(`Manual: Moved card from ${this.moveSourceZone} to ${this.moveDestZone}.`);
      this.closeAllDialogs();
      this.render();

      applyBtn?.removeEventListener('click', onApply);
      cancelBtn?.removeEventListener('click', onCancel);
    };
    const onCancel = () => {
      this.closeAllDialogs();
      applyBtn?.removeEventListener('click', onApply);
      cancelBtn?.removeEventListener('click', onCancel);
    };

    applyBtn?.addEventListener('click', onApply);
    cancelBtn?.addEventListener('click', onCancel);
  }

  private populateMoveCardList(): void {
    const cardPick = document.getElementById('move-card-pick');
    if (!cardPick || !this.moveSourceZone) return;
    cardPick.innerHTML = '';
    cardPick.style.display = '';

    const state = this.game.getState();
    const controller = state.manualResolutionController ?? this.currentViewPlayer;
    const player = state.players[controller];

    type CardLike = { id: string; name: string };
    let cards: CardLike[] = [];

    switch (this.moveSourceZone) {
      case 'hand': cards = player.hand; break;
      case 'graveyard': cards = player.graveyard; break;
      case 'exile': cards = player.exile; break;
      case 'library': cards = player.library.slice(0, 10); break; // Show top 10 only
      case 'battlefield': cards = player.battlefield; break;
      case 'commandZone': cards = player.commandZone; break;
      default: break;
    }

    if (cards.length === 0) {
      cardPick.innerHTML = '<div style="font-size:0.75rem; color:var(--text-dim); padding:6px;">No cards in this zone.</div>';
      return;
    }

    for (const card of cards) {
      const btn = document.createElement('button');
      btn.className = 'zone-pick-btn';
      btn.style.cssText = 'padding:6px 10px; font-size:0.75rem; text-align:left;';
      btn.textContent = card.name;
      btn.dataset.cardId = card.id;

      if (this.moveSelectedCardId === card.id) btn.classList.add('selected');

      btn.addEventListener('click', () => {
        cardPick.querySelectorAll('.zone-pick-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.moveSelectedCardId = card.id;
      });
      cardPick.appendChild(btn);
    }
  }

  // ─── P/T Modifier Dialog ───

  private openPTDialog(_state: GameState): void {
    this.manualDialogActive = 'pt';
    this.showDialogBackdrop();
    const dialog = document.getElementById('pt-dialog');
    if (!dialog) return;
    dialog.classList.remove('hidden');

    // Reset fields
    (document.getElementById('pt-power') as HTMLInputElement).value = '0';
    (document.getElementById('pt-toughness') as HTMLInputElement).value = '0';
    (document.getElementById('pt-target') as HTMLInputElement).value = '';
    (document.getElementById('pt-target-id') as HTMLInputElement).value = '';
    (document.getElementById('pt-target-owner') as HTMLInputElement).value = '';

    // Enable battlefield click to select target
    this.manualDialogBfClickHandler = (perm: Permanent, controller: 0 | 1) => {
      (document.getElementById('pt-target') as HTMLInputElement).value = perm.name;
      (document.getElementById('pt-target-id') as HTMLInputElement).value = perm.id;
      (document.getElementById('pt-target-owner') as HTMLInputElement).value = String(controller);
      this.addLog(`Selected: ${perm.name}`, 'info');
    };

    const applyBtn = document.getElementById('pt-apply');
    const cancelBtn = document.getElementById('pt-cancel');

    const onApply = () => {
      const targetId = (document.getElementById('pt-target-id') as HTMLInputElement).value;
      const targetOwner = parseInt((document.getElementById('pt-target-owner') as HTMLInputElement).value || '0') as 0 | 1;

      if (!targetId) {
        this.addLog('Select a creature first!', 'warning');
        return;
      }

      const powerDelta = parseInt((document.getElementById('pt-power') as HTMLInputElement).value || '0');
      const toughnessDelta = parseInt((document.getElementById('pt-toughness') as HTMLInputElement).value || '0');

      if (powerDelta === 0 && toughnessDelta === 0) {
        this.addLog('Set a non-zero P/T change.', 'warning');
        return;
      }

      const state = this.game.getState();
      const controller = state.manualResolutionController ?? 0;

      this.game.submitAction({
        type: 'manual-pt',
        player: controller,
        permanentId: targetId,
        powerDelta,
        toughnessDelta,
      });

      const permName = (document.getElementById('pt-target') as HTMLInputElement).value;
      this.addLog(`Manual: ${permName} gets ${powerDelta >= 0 ? '+' : ''}${powerDelta}/${toughnessDelta >= 0 ? '+' : ''}${toughnessDelta}.`);
      this.closeAllDialogs();
      this.render();

      applyBtn?.removeEventListener('click', onApply);
      cancelBtn?.removeEventListener('click', onCancel);
    };
    const onCancel = () => {
      this.closeAllDialogs();
      applyBtn?.removeEventListener('click', onApply);
      cancelBtn?.removeEventListener('click', onCancel);
    };

    applyBtn?.addEventListener('click', onApply);
    cancelBtn?.addEventListener('click', onCancel);
  }

  // ==================== Priority Prompt ====================

  private showPriorityPrompt(state: GameState): void {
    const prompt = document.getElementById('priority-prompt');
    if (!prompt) return;

    const topStack = state.stack[state.stack.length - 1];
    const controllerName = state.players[topStack.controller]?.name || 'Opponent';

    const titleEl = document.getElementById('prompt-title');
    const descEl = document.getElementById('prompt-desc');
    const imgEl = document.getElementById('prompt-card-img') as HTMLImageElement;

    if (titleEl) titleEl.textContent = 'Respond?';
    if (descEl) descEl.textContent = `${controllerName} — ${topStack.text}`;
    if (imgEl && topStack.card) {
      imgEl.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(topStack.card.name)}&format=image&version=art_crop`;
      imgEl.alt = topStack.card.name;
    } else if (imgEl) {
      imgEl.src = '';
      imgEl.alt = '';
    }

    prompt.classList.remove('hidden');
    this.priorityPromptVisible = true;
  }

  private hidePriorityPrompt(): void {
    const prompt = document.getElementById('priority-prompt');
    if (prompt) prompt.classList.add('hidden');
    this.priorityPromptVisible = false;
    // NOTE: Do NOT reset respondMode here — the respond button sets it true
    // then hides the prompt. Resetting here would negate the flag immediately.
  }

  private wirePriorityPrompt(): void {
    const respondBtn = document.getElementById('btn-prompt-respond');
    const passBtn = document.getElementById('btn-prompt-pass');

    respondBtn?.addEventListener('click', () => {
      this.hidePriorityPrompt();
      this.respondMode = true; // Set AFTER hiding prompt so it isn't cleared
      this.addLog('Responding — select an instant or ability.', 'info');
      this.render();
      // The loop will fall through to normal waitForPlayerAction since respondMode = true
      // We need to resolve the pending prompt promise
      if (this.promptResolver) {
        const resolver = this.promptResolver;
        this.promptResolver = null;
        resolver(null); // null = don't auto-pass, let player pick action
      }
    });

    passBtn?.addEventListener('click', () => {
      this.hidePriorityPrompt();
      this.respondMode = false; // Explicitly clear respond mode on pass
      const state = this.game.getState();
      if (this.promptResolver) {
        const resolver = this.promptResolver;
        this.promptResolver = null;
        resolver({ type: 'pass', player: state.priorityPlayer });
      }
    });
  }

  private promptResolver: ((action: GameAction | null) => void) | null = null;

  private waitForPriorityPromptOrAction(): Promise<GameAction | null> {
    return new Promise<GameAction | null>((resolve) => {
      this.promptResolver = resolve;
      // Also set up action resolver so if player clicks something (like hand card), it works
      this.actionResolver = (action: GameAction) => {
        this.hidePriorityPrompt();
        this.promptResolver = null;
        resolve(action);
      };
      this.updateActionButtons();
    });
  }

  // ==================== Zone Browser ====================

  openZoneBrowser(zoneName: string, playerIdx: 0 | 1): void {
    const state = this.game.getState();
    const player = state.players[playerIdx];
    let cards: Card[] = [];
    let title = '';

    const isOwn = playerIdx === this.currentViewPlayer;
    const playerLabel = isOwn ? 'Your' : "Opponent's";

    switch (zoneName) {
      case 'graveyard':
        cards = player.graveyard;
        title = `${playerLabel} Graveyard (${cards.length})`;
        break;
      case 'exile':
        cards = player.exile;
        title = `${playerLabel} Exile (${cards.length})`;
        break;
      case 'library':
        // Only show own library (for debugging/visibility)
        if (isOwn) {
          title = `${playerLabel} Library (${player.library.length}) — Top to Bottom`;
          cards = player.library;
        } else {
          this.addLog("Can't browse opponent's library.", 'warning');
          return;
        }
        break;
      default: return;
    }

    const modal = document.getElementById('zone-browser');
    const titleEl = document.getElementById('zone-browser-title');
    const cardsEl = document.getElementById('zone-browser-cards');
    if (!modal || !titleEl || !cardsEl) return;

    titleEl.textContent = title;
    cardsEl.innerHTML = '';

    if (cards.length === 0) {
      cardsEl.innerHTML = '<div class="re-zone-empty">No cards in this zone.</div>';
    } else {
      for (const card of cards) {
        const div = document.createElement('div');
        div.className = 're-card';
        div.dataset.cardId = card.id;

        const img = document.createElement('img');
        img.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
        img.alt = card.name;
        img.loading = 'lazy';
        img.onerror = () => {
          img.remove();
          const fallback = document.createElement('div');
          fallback.className = 're-card-name-fallback';
          fallback.textContent = card.name;
          div.appendChild(fallback);
        };
        div.appendChild(img);

        // Add mana cost label under the card
        if (card.manaCost) {
          const cost = document.createElement('div');
          cost.style.cssText = 'font-size:0.6rem; color:var(--text-dim); text-align:center; margin-top:2px;';
          cost.textContent = card.manaCost;
          div.appendChild(cost);
        }

        // Hover preview — reuse shared implementation from simulator-board
        addHoverPreview(div, card.name);

        cardsEl.appendChild(div);
      }
    }

    modal.classList.remove('hidden');
    this.zoneBrowserOpen = true;
  }

  closeZoneBrowser(): void {
    const modal = document.getElementById('zone-browser');
    if (modal) modal.classList.add('hidden');
    this.zoneBrowserOpen = false;
  }

  private wireZoneBrowser(): void {
    // Close button
    document.getElementById('zone-browser-close')?.addEventListener('click', () => this.closeZoneBrowser());

    // Click outside modal to close
    document.getElementById('zone-browser')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'zone-browser') this.closeZoneBrowser();
    });

    // Zone count clicks
    document.getElementById('zone-your-gy')?.addEventListener('click', () => this.openZoneBrowser('graveyard', this.currentViewPlayer));
    document.getElementById('zone-opp-gy')?.addEventListener('click', () => {
      const opp = this.currentViewPlayer === 0 ? 1 : 0;
      this.openZoneBrowser('graveyard', opp as 0 | 1);
    });
    document.getElementById('zone-your-exile')?.addEventListener('click', () => this.openZoneBrowser('exile', this.currentViewPlayer));
    document.getElementById('zone-opp-exile')?.addEventListener('click', () => {
      const opp = this.currentViewPlayer === 0 ? 1 : 0;
      this.openZoneBrowser('exile', opp as 0 | 1);
    });
    document.getElementById('zone-your-lib')?.addEventListener('click', () => this.openZoneBrowser('library', this.currentViewPlayer));
    document.getElementById('zone-opp-lib')?.addEventListener('click', () => {
      const opp = this.currentViewPlayer === 0 ? 1 : 0;
      this.openZoneBrowser('library', opp as 0 | 1);
    });
  }

  // ==================== Keyboard Shortcuts ====================

  private wireKeyboardShortcuts(): void {
    document.addEventListener('keydown', (e) => {
      if (!this.running) return;

      // Don't capture when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          // If priority prompt is visible, it's a Pass
          if (this.priorityPromptVisible && this.promptResolver) {
            const state = this.game.getState();
            const resolver = this.promptResolver;
            this.promptResolver = null;
            this.hidePriorityPrompt();
            this.respondMode = false; // Clear respond mode when passing via keyboard
            resolver({ type: 'pass', player: state.priorityPlayer });
          } else {
            this.pass();
          }
          break;

        case 'F2':
          e.preventDefault();
          this.toggleAutoPass();
          break;

        case 'Escape':
          e.preventDefault();
          if (this.manualDialogActive) {
            this.closeAllDialogs();
          } else if (this.zoneBrowserOpen) {
            this.closeZoneBrowser();
          } else {
            this.cancelCurrentAction();
          }
          break;

        case 'KeyZ':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.undo();
          }
          break;

        case 'KeyR':
          // Respond to priority prompt
          if (this.priorityPromptVisible && this.promptResolver) {
            e.preventDefault();
            this.hidePriorityPrompt();
            this.respondMode = true; // Set AFTER hiding prompt (consistent with button handler)
            this.addLog('Responding — select an instant or ability.', 'info');
            this.render();
            const resolver = this.promptResolver;
            this.promptResolver = null;
            resolver(null);
          }
          break;

        case 'KeyG':
          // Open own graveyard
          if (!this.zoneBrowserOpen) {
            e.preventDefault();
            this.openZoneBrowser('graveyard', this.currentViewPlayer);
          }
          break;

        case 'KeyE':
          // Open own exile
          if (!this.zoneBrowserOpen) {
            e.preventDefault();
            this.openZoneBrowser('exile', this.currentViewPlayer);
          }
          break;

        case 'Enter':
          e.preventDefault();
          // Confirm combat if in attacker/blocker step
          this.confirmCombat();
          break;
      }
    });
  }

  private confirmCombat(): void {
    const state = this.game.getState();
    const player = state.priorityPlayer;
    if (!this.humanPlayers.includes(player)) return;

    if (state.step === 'declare-attackers' && state.activePlayer === player) {
      this.submitAction({ type: 'declare-attackers', player, attackers: this.attackerSelection });
    } else if (state.step === 'declare-blockers' && state.activePlayer !== player && state.combat) {
      const blocks = Array.from(this.blockerAssignment.entries()).map(([blocker, attacker]) => ({ blocker, attacker }));
      this.submitAction({ type: 'declare-blockers', player, blocks });
    }
  }

  // ==================== Auto-Pass Badge ====================

  private wireAutoPassBadge(): void {
    const badge = document.getElementById('autopass-badge');
    if (badge) {
      badge.addEventListener('click', () => this.toggleAutoPass());
      this.updateAutoPassBadge();
    }
  }

  private updateAutoPassBadge(): void {
    const badge = document.getElementById('autopass-badge');
    if (badge) {
      badge.classList.toggle('active', this.autoPassEnabled);
      badge.textContent = this.autoPassEnabled ? 'F2 Auto ✓' : 'F2 Auto';
    }
  }

  // ==================== Shortcut Bar ====================

  private showShortcutBar(): void {
    const bar = document.getElementById('shortcut-bar');
    if (bar) bar.style.display = 'flex';
  }

  // ==================== Game Over ====================

  private showGameOver(): void {
    const overlay = document.getElementById('gameover-overlay');
    const title = document.getElementById('gameover-title');
    const msg = document.getElementById('gameover-msg');
    if (!overlay || !title || !msg) return;

    overlay.classList.remove('hidden');
    const winner = this.game.getWinner();
    const state = this.game.getState();

    if (winner !== null) {
      const winnerName = winner === 0 ? this.config.p1Name : this.config.p2Name;
      title.textContent = `${winnerName} Wins!`;
      msg.textContent = `Game lasted ${state.turn} turns. ${state.players[0].name}: ${state.players[0].life} life | ${state.players[1].name}: ${state.players[1].life} life`;
    } else {
      title.textContent = 'Draw';
      msg.textContent = `Game lasted ${state.turn} turns.`;
    }
  }

  // ==================== Logging ====================

  private addLog(message: string, type: string = ''): void {
    const logEl = document.getElementById('game-log');
    if (!logEl) return;

    const entry = document.createElement('div');
    entry.className = `re-log-entry ${type}`;
    entry.textContent = message; // Use textContent to prevent XSS from card names
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  private logAction(action: GameAction): void {
    const state = this.game.getState();
    switch (action.type) {
      case 'play-land':
        this.addLog(`${state.players[action.player].name} plays a land.`);
        break;
      case 'cast-spell': {
        const xSuffix = action.xValue !== undefined && action.xValue > 0 ? ` (X=${action.xValue})` : '';
        this.addLog(`${state.players[action.player].name} casts a spell${xSuffix}.`);
        break;
      }
      case 'activate-ability':
        this.addLog(`${state.players[action.player].name} activates an ability.`);
        break;
      case 'tap-for-mana':
        // Quiet — just update mana pool display
        break;
      case 'declare-attackers':
        this.addLog(`${state.players[action.player].name} declares ${action.attackers.length} attacker(s).`, 'combat');
        break;
      case 'declare-blockers':
        this.addLog(`${state.players[action.player].name} declares ${action.blocks.length} blocker(s).`, 'combat');
        break;
      case 'concede':
        this.addLog(`${state.players[action.player].name} concedes.`, 'combat');
        break;
      case 'pass':
        // Quiet
        break;
    }
  }

  // ==================== Combat Damage Assignment ====================

  private showDamageAssignmentDialog(state: GameState): Promise<void> {
    return new Promise<void>((resolve) => {
      const pending = state.pendingDamageAssignment!;
      const attacker = state.players[pending.player].battlefield.find(p => p.id === pending.attackerId);
      const attackerName = attacker?.name || 'Attacker';
      const assignments: Record<string, number> = {};
      pending.blockerIds.forEach((id: string) => assignments[id] = 0);

      let overlay = document.getElementById('damage-assign-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'damage-assign-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:200; display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(overlay);
      }

      const renderDialog = () => {
        const totalAssigned = Object.values(assignments).reduce((s, v) => s + v, 0);
        const remaining = pending.totalDamage - totalAssigned;

        let blockersHtml = '';
        for (const blockerId of pending.blockerIds) {
          const allPerms = [...state.players[0].battlefield, ...state.players[1].battlefield];
          const blocker = allPerms.find(p => p.id === blockerId);
          const blockerName = blocker?.name || 'Blocker';
          const toughness = blocker?.currentToughness ?? parseInt(blocker?.toughness || '1');
          const lethal = pending.hasDeathtouch ? 1 : Math.max(1, toughness - (blocker?.damage || 0));
          const assigned = assignments[blockerId];

          blockersHtml += `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border:1px solid var(--border,#333); border-radius:10px; margin-bottom:6px; background:var(--bg-2,#141924);">
              <div>
                <div style="font-weight:600; color:var(--text,#e4e4e4);">${blockerName}</div>
                <div style="font-size:0.7rem; color:var(--text-dim,#888);">Lethal: ${lethal} dmg | Toughness: ${toughness}</div>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                <button class="dmg-minus" data-id="${blockerId}" style="width:28px; height:28px; border-radius:50%; border:1px solid var(--border,#333); background:var(--bg-2,#141924); color:var(--text,#e4e4e4); cursor:pointer; font-size:1rem;">−</button>
                <span style="font-size:1.2rem; font-weight:700; color:var(--gold,#c9a84c); min-width:24px; text-align:center;">${assigned}</span>
                <button class="dmg-plus" data-id="${blockerId}" style="width:28px; height:28px; border-radius:50%; border:1px solid var(--border,#333); background:var(--bg-2,#141924); color:var(--text,#e4e4e4); cursor:pointer; font-size:1rem;">+</button>
              </div>
            </div>
          `;
        }

        overlay!.innerHTML = `
          <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:24px 28px; min-width:340px; max-width:480px; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4);">
            <div style="font-family:Cinzel,serif; font-size:1.1rem; color:var(--gold,#c9a84c); margin-bottom:2px;">Assign Combat Damage</div>
            <div style="font-size:0.8rem; color:var(--text-dim,#888); margin-bottom:14px;">${attackerName} (${pending.totalDamage} damage to distribute) — Remaining: <span style="color:${remaining > 0 ? 'var(--gold)' : '#34d399'};">${remaining}</span></div>
            ${blockersHtml}
            <div style="display:flex; gap:8px; margin-top:12px; justify-content:flex-end;">
              <button id="dmg-assign-confirm" class="re-action-btn primary" style="padding:8px 20px;" ${remaining !== 0 ? 'disabled' : ''}>Confirm</button>
            </div>
          </div>
        `;
        overlay!.style.display = 'flex';

        // Wire buttons
        overlay!.querySelectorAll('.dmg-minus').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.id!;
            if (assignments[id] > 0) { assignments[id]--; renderDialog(); }
          });
        });
        overlay!.querySelectorAll('.dmg-plus').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = (btn as HTMLElement).dataset.id!;
            const totalAssigned = Object.values(assignments).reduce((s, v) => s + v, 0);
            if (totalAssigned < pending.totalDamage) { assignments[id]++; renderDialog(); }
          });
        });
        document.getElementById('dmg-assign-confirm')?.addEventListener('click', () => {
          const totalAssigned = Object.values(assignments).reduce((s, v) => s + v, 0);
          if (totalAssigned !== pending.totalDamage) return;
          overlay!.style.display = 'none';
          this.game.submitAction({
            type: 'assign-damage',
            player: pending.player,
            assignments,
            trampleDamage: 0,
          });
          this.addLog(`Assigned ${pending.totalDamage} combat damage among blockers.`, 'combat');
          resolve();
        });
      };
      renderDialog();
    });
  }

  // ==================== Legend Rule Choice ====================

  private showLegendChoiceDialog(state: GameState): Promise<void> {
    return new Promise<void>((resolve) => {
      const pending = state.pendingLegendChoice!;
      const permanents = state.players[pending.player].battlefield.filter(p => pending.permanentIds.includes(p.id));

      let overlay = document.getElementById('legend-choice-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'legend-choice-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:200; display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(overlay);
      }

      let cardsHtml = '';
      for (const perm of permanents) {
        const imgUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(perm.name)}&format=image&version=normal`;
        cardsHtml += `
          <div class="legend-pick" data-id="${perm.id}" style="cursor:pointer; text-align:center; transition:transform 0.15s, box-shadow 0.15s;">
            <img src="${imgUrl}" alt="${perm.name}" style="width:140px; border-radius:10px; border:2px solid var(--border,#333);" />
            <div style="font-size:0.75rem; color:var(--text,#e4e4e4); margin-top:4px;">${perm.name}</div>
          </div>
        `;
      }

      overlay.innerHTML = `
        <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:24px 28px; min-width:340px; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4); text-align:center;">
          <div style="font-family:Cinzel,serif; font-size:1.1rem; color:var(--gold,#c9a84c); margin-bottom:4px;">Legend Rule</div>
          <div style="font-size:0.8rem; color:var(--text-dim,#888); margin-bottom:16px;">Multiple "${pending.legendName}" — choose one to keep</div>
          <div style="display:flex; gap:16px; justify-content:center; flex-wrap:wrap;">
            ${cardsHtml}
          </div>
        </div>
      `;
      overlay.style.display = 'flex';

      overlay.querySelectorAll('.legend-pick').forEach(el => {
        (el as HTMLElement).addEventListener('mouseenter', () => {
          (el as HTMLElement).style.transform = 'scale(1.05)';
          (el as HTMLElement).querySelector('img')!.style.borderColor = 'var(--gold,#c9a84c)';
        });
        (el as HTMLElement).addEventListener('mouseleave', () => {
          (el as HTMLElement).style.transform = '';
          (el as HTMLElement).querySelector('img')!.style.borderColor = 'var(--border,#333)';
        });
        el.addEventListener('click', () => {
          const keepId = (el as HTMLElement).dataset.id!;
          overlay!.style.display = 'none';
          this.game.submitAction({ type: 'legend-choice', player: pending.player, keepPermanentId: keepId });
          this.addLog(`Kept one "${pending.legendName}" (Legend Rule).`);
          resolve();
        });
      });
    });
  }

  // ==================== Commander Zone Choice ====================

  private showCommanderChoiceDialog(state: GameState): Promise<void> {
    return new Promise<void>((resolve) => {
      const pending = state.pendingCommanderChoice!;
      const imgUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(pending.commanderName)}&format=image&version=normal`;

      let overlay = document.getElementById('commander-choice-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'commander-choice-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:200; display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(overlay);
      }

      overlay.innerHTML = `
        <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:24px 28px; min-width:340px; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4); text-align:center;">
          <div style="font-family:Cinzel,serif; font-size:1.1rem; color:var(--gold,#c9a84c); margin-bottom:4px;">Commander Zone Replacement</div>
          <div style="font-size:0.8rem; color:var(--text-dim,#888); margin-bottom:16px;">${pending.commanderName} went to ${pending.currentZone}</div>
          <img src="${imgUrl}" alt="${pending.commanderName}" style="width:180px; border-radius:10px; border:2px solid var(--gold,#c9a84c); margin-bottom:16px;" />
          <div style="display:flex; gap:10px; justify-content:center;">
            <button id="cmdr-to-zone" class="re-action-btn primary" style="padding:10px 20px;">Return to Command Zone</button>
            <button id="cmdr-stay" class="re-action-btn" style="padding:10px 20px;">Leave in ${pending.currentZone}</button>
          </div>
        </div>
      `;
      overlay.style.display = 'flex';

      document.getElementById('cmdr-to-zone')!.addEventListener('click', () => {
        overlay!.style.display = 'none';
        this.game.submitAction({ type: 'commander-zone-choice', player: pending.player, moveToCommandZone: true });
        this.addLog(`${pending.commanderName} returned to command zone.`);
        resolve();
      });
      document.getElementById('cmdr-stay')!.addEventListener('click', () => {
        overlay!.style.display = 'none';
        this.game.submitAction({ type: 'commander-zone-choice', player: pending.player, moveToCommandZone: false });
        this.addLog(`${pending.commanderName} stays in ${pending.currentZone}.`);
        resolve();
      });
    });
  }

  // ==================== Triggered Ability Ordering ====================
  // NOTE: Full trigger ordering requires engine support for pendingTriggerOrder.
  // Currently, triggers are auto-ordered. When multiple triggers fire simultaneously
  // for the same player, the engine places them on the stack automatically.
  // A future enhancement would let the player choose the order (APNAP rule).

  // ==================== Replacement Effect Choice ====================
  // NOTE: When multiple replacement effects apply to the same event,
  // the affected player chooses which one to apply first (CR 614.5).
  // Currently, replacement effects are auto-applied by priority order.
  // A future enhancement would show a choice dialog.

  // ==================== Sacrifice Choice ====================

  showSacrificeChoiceDialog(player: 0 | 1, count: number, filter?: (perm: Permanent) => boolean): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      const state = this.game.getState();
      const candidates = state.players[player].battlefield.filter(p => !filter || filter(p));
      const selected = new Set<string>();

      let overlay = document.getElementById('sacrifice-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'sacrifice-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:200; display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(overlay);
      }

      const renderSacDialog = () => {
        let cardsHtml = '';
        for (const perm of candidates) {
          const isSelected = selected.has(perm.id);
          const imgUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(perm.name)}&format=image&version=normal`;
          cardsHtml += `
            <div class="sac-pick" data-id="${perm.id}" style="cursor:pointer; text-align:center; opacity:${isSelected ? '1' : '0.7'};">
              <img src="${imgUrl}" alt="${perm.name}" style="width:100px; border-radius:8px; border:2px solid ${isSelected ? 'var(--banned,#e53e3e)' : 'var(--border,#333)'};" />
              <div style="font-size:0.65rem; color:var(--text,#e4e4e4); margin-top:2px;">${perm.name}</div>
            </div>
          `;
        }

        overlay!.innerHTML = `
          <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--banned,#e53e3e); border-radius:16px; padding:24px 28px; min-width:340px; max-width:600px; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4); text-align:center;">
            <div style="font-family:Cinzel,serif; font-size:1.1rem; color:var(--banned,#e53e3e); margin-bottom:4px;">Sacrifice</div>
            <div style="font-size:0.8rem; color:var(--text-dim,#888); margin-bottom:14px;">Choose ${count} permanent(s) to sacrifice (${selected.size}/${count})</div>
            <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap; max-height:300px; overflow-y:auto;">
              ${cardsHtml}
            </div>
            <div style="display:flex; gap:8px; margin-top:14px; justify-content:center;">
              <button id="sac-confirm" class="re-action-btn primary" style="padding:8px 20px;" ${selected.size !== count ? 'disabled' : ''}>Confirm Sacrifice</button>
            </div>
          </div>
        `;
        overlay!.style.display = 'flex';

        overlay!.querySelectorAll('.sac-pick').forEach(el => {
          el.addEventListener('click', () => {
            const id = (el as HTMLElement).dataset.id!;
            if (selected.has(id)) selected.delete(id);
            else if (selected.size < count) selected.add(id);
            renderSacDialog();
          });
        });

        document.getElementById('sac-confirm')?.addEventListener('click', () => {
          if (selected.size !== count) return;
          overlay!.style.display = 'none';
          resolve(Array.from(selected));
        });
      };
      renderSacDialog();
    });
  }

  // ==================== Search Library ====================

  showSearchLibraryDialog(player: 0 | 1, filter?: (card: Card) => boolean, count: number = 1): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      const state = this.game.getState();
      const library = state.players[player].library;
      const candidates = filter ? library.filter(filter) : library;
      const selected = new Set<string>();

      let overlay = document.getElementById('search-library-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'search-library-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:200; display:flex; align-items:center; justify-content:center;';
        document.body.appendChild(overlay);
      }

      // Sort candidates alphabetically
      const sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));

      const renderSearchDialog = () => {
        let cardsHtml = '';
        for (const card of sorted) {
          const isSelected = selected.has(card.id);
          const imgUrl = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(card.name)}&format=image&version=normal`;
          cardsHtml += `
            <div class="search-pick" data-id="${card.id}" style="cursor:pointer; text-align:center; opacity:${isSelected ? '1' : '0.7'};">
              <img src="${imgUrl}" alt="${card.name}" style="width:90px; border-radius:8px; border:2px solid ${isSelected ? 'var(--gold,#c9a84c)' : 'var(--border,#333)'};" loading="lazy" />
              <div style="font-size:0.6rem; color:var(--text,#e4e4e4); margin-top:2px; max-width:90px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${card.name}</div>
            </div>
          `;
        }

        overlay!.innerHTML = `
          <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:24px 28px; min-width:400px; max-width:700px; max-height:80vh; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4); text-align:center; display:flex; flex-direction:column;">
            <div style="font-family:Cinzel,serif; font-size:1.1rem; color:var(--gold,#c9a84c); margin-bottom:4px;">Search Library</div>
            <div style="font-size:0.8rem; color:var(--text-dim,#888); margin-bottom:14px;">Choose ${count} card(s) (${selected.size}/${count}) — ${sorted.length} cards available</div>
            <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap; overflow-y:auto; flex:1; max-height:50vh; padding:4px;">
              ${cardsHtml}
            </div>
            <div style="display:flex; gap:8px; margin-top:14px; justify-content:center;">
              <button id="search-confirm" class="re-action-btn primary" style="padding:8px 20px;" ${selected.size !== count ? 'disabled' : ''}>Select</button>
              <button id="search-cancel" class="re-action-btn" style="padding:8px 16px;">Cancel</button>
            </div>
          </div>
        `;
        overlay!.style.display = 'flex';

        overlay!.querySelectorAll('.search-pick').forEach(el => {
          el.addEventListener('click', () => {
            const id = (el as HTMLElement).dataset.id!;
            if (selected.has(id)) selected.delete(id);
            else if (selected.size < count) selected.add(id);
            renderSearchDialog();
          });
        });

        document.getElementById('search-confirm')?.addEventListener('click', () => {
          if (selected.size < 1) return;
          overlay!.style.display = 'none';
          resolve(Array.from(selected));
        });
        document.getElementById('search-cancel')?.addEventListener('click', () => {
          overlay!.style.display = 'none';
          resolve([]);
        });
      };
      renderSearchDialog();
    });
  }

  // ==================== Planeswalker Loyalty Abilities ====================

  private parsePlaneswalkerAbilities(perm: Permanent): { cost: number; text: string }[] {
    const oracle = perm.oracleText || '';
    const abilities: { cost: number; text: string }[] = [];

    // Match patterns like "+1: ..." or "−2: ..." or "0: ..."
    const regex = /([+\u2212\-]?\d+):\s*([^\n]+)/g;
    let match;
    while ((match = regex.exec(oracle)) !== null) {
      const costStr = match[1].replace('\u2212', '-');
      const cost = parseInt(costStr);
      abilities.push({ cost, text: match[2].trim() });
    }
    return abilities;
  }

  private showPlaneswalkerAbilityPicker(
    perm: Permanent,
    abilities: { cost: number; text: string }[],
    player: 0 | 1,
  ): void {
    document.getElementById('pw-picker')?.remove();

    const picker = document.createElement('div');
    picker.id = 'pw-picker';
    picker.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:200; display:flex; align-items:center; justify-content:center;';

    const loyalty = perm.currentLoyalty ?? 0;
    let abilitiesHtml = '';
    for (let i = 0; i < abilities.length; i++) {
      const { cost, text } = abilities[i];
      const canActivate = loyalty + cost >= 0; // Can't go below 0 loyalty
      const costLabel = cost >= 0 ? `+${cost}` : String(cost);
      const costColor = cost >= 0 ? '#34d399' : '#e53e3e';
      abilitiesHtml += `
        <button class="pw-ability-btn" data-idx="${i}" ${!canActivate ? 'disabled' : ''} style="display:block; width:100%; text-align:left; padding:10px 14px; border:1px solid var(--border,#333); border-radius:10px; background:var(--bg-2,#141924); color:${canActivate ? 'var(--text,#e4e4e4)' : '#555'}; cursor:${canActivate ? 'pointer' : 'not-allowed'}; font-size:0.8rem; font-family:Outfit,sans-serif; margin-bottom:6px; transition:border-color 0.15s;">
          <span style="color:${costColor}; font-weight:700; margin-right:6px;">[${costLabel}]</span>${text}
        </button>
      `;
    }

    picker.innerHTML = `
      <div style="background:var(--obsidian,#1a1f2e); border:2px solid var(--gold,#c9a84c); border-radius:16px; padding:20px 24px; min-width:320px; max-width:480px; font-family:Outfit,sans-serif; color:var(--text,#e4e4e4);">
        <div style="font-family:Cinzel,serif; font-size:1rem; color:var(--gold,#c9a84c); margin-bottom:2px;">${perm.name}</div>
        <div style="font-size:0.75rem; color:var(--text-dim,#888); margin-bottom:12px;">Loyalty: ${loyalty} — Choose an ability</div>
        ${abilitiesHtml}
        <button id="pw-pick-cancel" class="re-action-btn" style="width:100%; margin-top:4px; padding:8px;">Cancel</button>
      </div>
    `;

    document.body.appendChild(picker);

    picker.querySelectorAll('.pw-ability-btn').forEach(btn => {
      if ((btn as HTMLButtonElement).disabled) return;
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
        const ability = abilities[idx];
        picker.remove();

        // Adjust loyalty via manual counter
        this.game.submitAction({
          type: 'manual-counter',
          player,
          permanentId: perm.id,
          counterType: 'loyalty',
          delta: ability.cost,
        });
        this.addLog(`${perm.name}: [${ability.cost >= 0 ? '+' : ''}${ability.cost}] ${ability.text}`, 'info');

        // Trigger manual resolution for the planeswalker ability effect
        if (ability.text.toLowerCase().includes('target')) {
          this.addLog('Select a target for this ability.', 'info');
        }
        const state = this.game.getState();
        this.game.setState({
          ...state,
          needsManualResolution: true,
          manualResolutionCard: { name: perm.name, oracleText: ability.text } as any,
          manualResolutionController: player,
        });
        this.showManualResolutionPanel(this.game.getState());
      });

      (btn as HTMLElement).addEventListener('mouseenter', () => {
        if (!(btn as HTMLButtonElement).disabled) (btn as HTMLElement).style.borderColor = 'var(--gold,#c9a84c)';
      });
      (btn as HTMLElement).addEventListener('mouseleave', () => {
        (btn as HTMLElement).style.borderColor = 'var(--border,#333)';
      });
    });

    document.getElementById('pw-pick-cancel')!.addEventListener('click', () => picker.remove());
    picker.addEventListener('click', (e) => { if (e.target === picker) picker.remove(); });
  }
}

// ─── Helpers ───

function setButtonEnabled(id: string, enabled: boolean): void {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (btn) btn.disabled = !enabled;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
