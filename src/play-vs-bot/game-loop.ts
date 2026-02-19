/**
 * Game Loop — Connects Engine + Bot + UI.
 *
 * Handles the turn-by-turn loop:
 * - Human has priority → wait for UI input
 * - Bot has priority → query bot, show thinking, execute
 * - Phase changes → log and re-render
 * - Game over → show result screen
 */

import type { GameState, GameAction, Card, Permanent, Target, Ability, ManaPool, TargetFilter } from '@mtg/game-engine';
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
  totalMana,
  emptyPool,
  addMana,
  isCreature,
  isInstant,
  hasFlash,
  parseCost,
  canPayAbilityCost,
  resolveModalChoices,
  checkMultiBlockerAssignment,
  validateDamageAssignment,
  applyDamageAssignment,
  parseTargetFilter,
  getValidTargets,
} from '@mtg/game-engine';
import { HeuristicBot, evaluateBoardPosition, shouldKeepHand, explainMulliganDecision } from '@mtg/bot-core';
import { renderBoard, clearDomCache, type BoardCallbacks } from './board-renderer.ts';
import { logAction, logPhaseChange, logGameOver, logMessage } from './game-log.ts';
import { generateCoachTips, getSuggestedPlays, type CoachTip } from './ai-coach.ts';
import { analyzeGame, renderAnalysisOverlay, type GameAnalysis } from './post-game-analysis.ts';

/** Common interface for any bot (Heuristic, ML, etc.) */
export interface BotInterface {
  readonly player: 0 | 1;
  chooseAction(state: GameState): GameAction;
}

export type ActionResolver = (action: GameAction) => void;

/** Enhanced targeting state for multi-target and zone-based targeting */
interface TargetingState {
  card: Card;
  requiredTargets: number;
  collectedTargets: Target[];
  filter?: TargetFilter | null;
  zone?: 'battlefield' | 'graveyard';
  onComplete: (targets: Target[]) => void;
  onCancel: () => void;
}

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
  private targetingState: TargetingState | null = null;
  private manualManaPool: ManaPool = emptyPool();
  private manuallyTappedIds: Set<string> = new Set();
  private manaTappingMode = false;
  private inManualResolution = false;

  // ─── AI Coach State ───
  private coachEnabled = false;
  private coachTips: CoachTip[] = [];
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSuggestTime = 0;

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
    this.injectCoachUI();
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

      // ─── Discard Pending (Human) ───
      if (state.pendingDiscard === this.humanPlayer && state.pendingDiscardCount && state.pendingDiscardCount > 0) {
        const cardIds = await this.showDiscardPicker(state.pendingDiscardCount);
        if (cardIds.length > 0) {
          // Move selected cards from hand to graveyard
          const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
          const p = players[this.humanPlayer];
          const discarded: Card[] = [];
          const remaining: Card[] = [];
          for (const c of p.hand) {
            if (cardIds.includes(c.id) && discarded.length < state.pendingDiscardCount!) {
              discarded.push(c);
            } else {
              remaining.push(c);
            }
          }
          players[this.humanPlayer] = {
            ...p,
            hand: remaining,
            graveyard: [...p.graveyard, ...discarded],
          };
          const newState: GameState = {
            ...state,
            players,
            pendingDiscard: null,
            pendingDiscardCount: 0,
            log: [...state.log, {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: this.humanPlayer,
              message: `Discarded ${discarded.map(c => c.name).join(', ')}.`,
              actionType: 'effect',
            }],
          };
          this.game.setState(newState);
          logMessage(`Discarded: ${discarded.map(c => `<span style="color:var(--gold)">${c.name}</span>`).join(', ')}`);
        }
        continue;
      }

      // ─── Discard Pending (Bot) ───
      if (state.pendingDiscard === this.botPlayer && state.pendingDiscardCount && state.pendingDiscardCount > 0) {
        // Bot auto-discards lowest-value cards
        const p = state.players[this.botPlayer];
        const sorted = [...p.hand].sort((a, b) => a.cmc - b.cmc); // Discard cheapest first
        const toDiscard = sorted.slice(0, state.pendingDiscardCount);
        const discardIds = new Set(toDiscard.map(c => c.id));
        const remainingHand = p.hand.filter(c => !discardIds.has(c.id));
        const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
        players[this.botPlayer] = { ...p, hand: remainingHand, graveyard: [...p.graveyard, ...toDiscard] };
        this.game.setState({
          ...state,
          players,
          pendingDiscard: null,
          pendingDiscardCount: 0,
          log: [...state.log, {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: this.botPlayer,
            message: `Bot discards ${toDiscard.map(c => c.name).join(', ')}.`,
            actionType: 'effect',
          }],
        });
        logMessage(`Bot discards ${toDiscard.length} card(s).`);
        continue;
      }

      // ─── Sacrifice Pending (Human) ───
      if (state.pendingSacrifice && state.pendingSacrifice.player === this.humanPlayer) {
        const { filter, count, sourceName } = state.pendingSacrifice;
        const permIds = await this.showSacrificePicker(filter, count);
        if (permIds.length > 0) {
          // Move permanents to graveyard
          const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
          const p = players[this.humanPlayer];
          const sacrificed: Permanent[] = [];
          const remainingBF = p.battlefield.filter(perm => {
            if (permIds.includes(perm.id) && sacrificed.length < count) {
              sacrificed.push(perm);
              return false;
            }
            return true;
          });
          players[this.humanPlayer] = {
            ...p,
            battlefield: remainingBF,
            graveyard: [...p.graveyard, ...sacrificed.map(perm => perm.card)],
          };
          this.game.setState({
            ...state,
            players,
            pendingSacrifice: null,
            log: [...state.log, {
              timestamp: Date.now(),
              turn: state.turn,
              phase: state.phase,
              step: state.step,
              player: this.humanPlayer,
              message: `Sacrificed ${sacrificed.map(s => s.name).join(', ')}${sourceName ? ` (${sourceName})` : ''}.`,
              actionType: 'effect',
            }],
          });
          logMessage(`Sacrificed: ${sacrificed.map(s => `<span style="color:#ef4444">${s.name}</span>`).join(', ')}`);
        } else {
          // No valid targets or empty selection — clear pending
          this.game.setState({ ...state, pendingSacrifice: null });
        }
        continue;
      }

      // ─── Sacrifice Pending (Bot) ───
      if (state.pendingSacrifice && state.pendingSacrifice.player === this.botPlayer) {
        const { filter, count } = state.pendingSacrifice;
        const p = state.players[this.botPlayer];
        const validPerms = p.battlefield.filter(perm => {
          const type = perm.card.typeLine.toLowerCase();
          if (filter === 'creature') return type.includes('creature');
          if (filter === 'artifact') return type.includes('artifact');
          if (filter === 'enchantment') return type.includes('enchantment');
          return true; // 'permanent' matches all
        });
        // Bot sacrifices weakest (lowest power+toughness or lowest CMC for non-creatures)
        const sorted = [...validPerms].sort((a, b) => {
          const aVal = (parseInt(a.card.power || '0') || 0) + (parseInt(a.card.toughness || '0') || 0) + a.card.cmc;
          const bVal = (parseInt(b.card.power || '0') || 0) + (parseInt(b.card.toughness || '0') || 0) + b.card.cmc;
          return aVal - bVal;
        });
        const toSacrifice = sorted.slice(0, count);
        const sacIds = new Set(toSacrifice.map(sp => sp.id));
        const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
        const pp = players[this.botPlayer];
        players[this.botPlayer] = {
          ...pp,
          battlefield: pp.battlefield.filter(perm => !sacIds.has(perm.id)),
          graveyard: [...pp.graveyard, ...toSacrifice.map(perm => perm.card)],
        };
        this.game.setState({
          ...state,
          players,
          pendingSacrifice: null,
          log: [...state.log, {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: this.botPlayer,
            message: `Bot sacrifices ${toSacrifice.map(s => s.name).join(', ')}.`,
            actionType: 'effect',
          }],
        });
        logMessage(`Bot sacrifices ${toSacrifice.map(s => s.name).join(', ')}.`);
        continue;
      }

      // ─── Library Search Pending (Human) ───
      if (state.pendingSearch && state.pendingSearch.player === this.humanPlayer) {
        const { filter, count, destination, sourceName } = state.pendingSearch;
        const cardIds = await this.showLibrarySearch(filter, count, destination);
        const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
        const p = players[this.humanPlayer];

        if (cardIds.length > 0) {
          const selected = cardIds.map(id => p.library.find(c => c.id === id)!).filter(Boolean);
          const remainingLib = p.library.filter(c => !cardIds.includes(c.id));

          // Shuffle remaining library
          for (let i = remainingLib.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [remainingLib[i], remainingLib[j]] = [remainingLib[j], remainingLib[i]];
          }

          if (destination === 'hand') {
            players[this.humanPlayer] = { ...p, library: remainingLib, hand: [...p.hand, ...selected] };
          } else if (destination === 'battlefield') {
            // For battlefield, need to create Permanents
            const newPerms = selected.map(card => ({
              id: card.id + '-perm',
              name: card.name,
              card,
              typeLine: card.typeLine,
              oracleText: card.oracleText ?? '',
              controller: this.humanPlayer as 0 | 1,
              tapped: false,
              summoningSick: !card.typeLine.toLowerCase().includes('land'),
              damage: 0,
              counters: {},
              attachedTo: null,
              attachments: [],
              temporaryEffects: [],
            }));
            players[this.humanPlayer] = {
              ...p,
              library: remainingLib,
              battlefield: [...p.battlefield, ...newPerms as any],
            };
          } else {
            // top-of-library
            players[this.humanPlayer] = { ...p, library: [...selected, ...remainingLib] };
          }

          this.game.setState({
            ...state, players, pendingSearch: null,
            log: [...state.log, {
              timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
              player: this.humanPlayer,
              message: `Searched library${sourceName ? ` (${sourceName})` : ''}, found ${selected.map(c => c.name).join(', ')}. Library shuffled.`,
              actionType: 'effect',
            }],
          });
          logMessage(`Found: ${selected.map(c => `<span style="color:var(--gold)">${c.name}</span>`).join(', ')}`);
        } else {
          // Failed to find / cancelled — just shuffle
          const shuffled = [...p.library];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          players[this.humanPlayer] = { ...p, library: shuffled };
          this.game.setState({ ...state, players, pendingSearch: null });
          logMessage('Search cancelled. Library shuffled.');
        }
        continue;
      }

      // ─── Library Search Pending (Bot) ───
      if (state.pendingSearch && state.pendingSearch.player === this.botPlayer) {
        const { filter, count, destination } = state.pendingSearch;
        const p = state.players[this.botPlayer];
        const filtered = filter
          ? p.library.filter(c => c.typeLine.toLowerCase().includes(filter.toLowerCase()))
          : p.library;
        // Bot picks highest CMC cards matching filter
        const sorted = [...filtered].sort((a, b) => b.cmc - a.cmc);
        const picked = sorted.slice(0, count);
        const pickedIds = new Set(picked.map(c => c.id));
        const remainingLib = p.library.filter(c => !pickedIds.has(c.id));

        // Shuffle
        for (let i = remainingLib.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [remainingLib[i], remainingLib[j]] = [remainingLib[j], remainingLib[i]];
        }

        const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
        if (destination === 'hand') {
          players[this.botPlayer] = { ...p, library: remainingLib, hand: [...p.hand, ...picked] };
        } else if (destination === 'battlefield') {
          const newPerms = picked.map(card => ({
            id: card.id + '-perm',
            name: card.name,
            card,
            typeLine: card.typeLine,
            oracleText: card.oracleText ?? '',
            controller: this.botPlayer as 0 | 1,
            tapped: false,
            summoningSick: !card.typeLine.toLowerCase().includes('land'),
            damage: 0,
            counters: {},
            attachedTo: null,
            attachments: [],
            temporaryEffects: [],
          }));
          players[this.botPlayer] = {
            ...p,
            library: remainingLib,
            battlefield: [...p.battlefield, ...newPerms as any],
          };
        } else {
          // top-of-library
          players[this.botPlayer] = { ...p, library: [...picked, ...remainingLib] };
        }

        this.game.setState({
          ...state, players, pendingSearch: null,
          log: [...state.log, {
            timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
            player: this.botPlayer,
            message: `Bot searches library.`,
            actionType: 'effect',
          }],
        });
        logMessage('Bot searches library.');
        continue;
      }

      // ─── Scry Pending (Human) ───
      if (state.pendingScry && state.pendingScry.player === this.humanPlayer) {
        const { count } = state.pendingScry;
        const result = await this.showScryUI(count);
        const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
        const p = players[this.humanPlayer];

        const topCards = result.top.map(id => p.library.find(c => c.id === id)!).filter(Boolean);
        const bottomCards = result.bottom.map(id => p.library.find(c => c.id === id)!).filter(Boolean);
        const allScryIds = new Set([...result.top, ...result.bottom]);
        const restOfLibrary = p.library.filter(c => !allScryIds.has(c.id));

        players[this.humanPlayer] = { ...p, library: [...topCards, ...restOfLibrary, ...bottomCards] };
        this.game.setState({
          ...state, players, pendingScry: null,
          log: [...state.log, {
            timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
            player: this.humanPlayer,
            message: `Scry ${count}: put ${topCards.length} on top, ${bottomCards.length} on bottom.`,
            actionType: 'effect',
          }],
        });
        logMessage(`Scry ${count}: ${topCards.length} on top, ${bottomCards.length} on bottom.`);
        continue;
      }

      // ─── Scry Pending (Bot) ───
      if (state.pendingScry && state.pendingScry.player === this.botPlayer) {
        const { count } = state.pendingScry;
        const p = state.players[this.botPlayer];
        const scryCards = p.library.slice(0, count);
        // Bot keeps lands if mana-poor, keeps spells if mana-rich
        const landCount = p.battlefield.filter(perm => perm.card.typeLine.toLowerCase().includes('land')).length;
        const top: typeof scryCards = [];
        const bottom: typeof scryCards = [];
        for (const c of scryCards) {
          const isLand = c.typeLine.toLowerCase().includes('land');
          if (isLand && landCount < 4) top.push(c);
          else if (!isLand && landCount >= 4) top.push(c);
          else if (c.cmc <= landCount + 1) top.push(c);
          else bottom.push(c);
        }
        const restLib = p.library.slice(count);
        const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
        players[this.botPlayer] = { ...p, library: [...top, ...restLib, ...bottom] };
        this.game.setState({ ...state, players, pendingScry: null });
        logMessage(`Bot scries ${count}.`);
        continue;
      }

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

      // ─── Manual Resolution (Smart Parser fallback) ───
      if (state.needsManualResolution) {
        if (state.manualResolutionController === this.humanPlayer) {
          // Human player: show manual resolution panel
          if (!this.inManualResolution) {
            this.inManualResolution = true;
            this.showManualResolutionPanel(state);
          }
          await sleep(100);
          continue;
        } else {
          // Bot: auto-pass (can't resolve manually, just clear the flag)
          this.game.setState({
            ...state,
            needsManualResolution: false,
            manualResolutionCard: undefined,
            manualResolutionController: undefined,
          });
          continue;
        }
      }

      // ─── Fix 5: Combat Damage Assignment Pending ───
      if (state.pendingDamageAssignment && state.pendingDamageAssignment.player === this.humanPlayer) {
        const pending = state.pendingDamageAssignment;
        const attackerPerm = state.players[state.activePlayer].battlefield.find(
          p => p.id === pending.attackerId
        );
        const defendingPlayer: 0 | 1 = state.activePlayer === 0 ? 1 : 0;
        const blockerPerms = pending.blockerIds
          .map(id => state.players[defendingPlayer].battlefield.find(p => p.id === id))
          .filter((p): p is Permanent => p !== undefined);

        if (attackerPerm && blockerPerms.length > 0) {
          const hasTrample = (attackerPerm.oracleText ?? '').toLowerCase().includes('trample') ||
            attackerPerm.abilities?.some(a => a.text.toLowerCase().includes('trample'));

          const result = await this.showDamageAssignmentModal(
            attackerPerm, blockerPerms, pending.totalDamage, pending.hasDeathtouch, !!hasTrample,
          );

          if (result) {
            // Validate and submit
            const error = validateDamageAssignment(state, result.assignments, result.trampleDamage);
            if (error) {
              logMessage(`<span style="color:var(--warning)">Invalid assignment: ${error}</span>`);
            } else {
              const newState = applyDamageAssignment(state, result.assignments, result.trampleDamage);
              this.game.setState(newState);
              this.executeAction({
                type: 'assign-damage',
                player: this.humanPlayer,
                assignments: result.assignments,
                trampleDamage: result.trampleDamage,
              });
            }
          } else {
            // Auto-assign: distribute lethal to each in DAO order
            const autoAssignments: Record<string, number> = {};
            let remaining = pending.totalDamage;
            for (const blocker of blockerPerms) {
              const lethal = pending.hasDeathtouch ? 1 : Math.max(0, (blocker.currentToughness ?? 1) - (blocker.damage || 0));
              const assign = Math.min(remaining, lethal);
              autoAssignments[blocker.id] = assign;
              remaining -= assign;
            }
            // Give any leftover to first blocker (or trample to player)
            if (remaining > 0 && blockerPerms.length > 0) {
              autoAssignments[blockerPerms[0].id] += remaining;
            }
            const newState = applyDamageAssignment(state, autoAssignments, 0);
            this.game.setState(newState);
            this.executeAction({
              type: 'assign-damage',
              player: this.humanPlayer,
              assignments: autoAssignments,
              trampleDamage: 0,
            });
          }
          continue;
        }
      }

      // Also check for multi-blocker assignment at combat-damage step
      if (state.step === 'combat-damage' && state.activePlayer === this.humanPlayer &&
          state.combat && state.combat.attackers.length > 0 && !state.pendingDamageAssignment) {
        const pending = checkMultiBlockerAssignment(state);
        if (pending) {
          // Set the pending state and re-loop
          this.game.setState({ ...state, pendingDamageAssignment: pending });
          continue;
        }
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

    // Never auto-pass when there's a pending discard, sacrifice, search, or scry choice
    if (state.pendingDiscard != null && state.pendingDiscardCount && state.pendingDiscardCount > 0) return false;
    if (state.pendingSacrifice) return false;
    if (state.pendingSearch) return false;
    if (state.pendingScry) return false;

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

    // Coach tips
    if (this.coachEnabled && state.priorityPlayer === this.humanPlayer && !state.gameOver) {
      this.coachTips = generateCoachTips(state, this.humanPlayer);
      this.renderCoachTips();
    } else {
      this.hideCoachTips();
    }

    // Power meter
    this.renderPowerMeter(state);

    // Suggest timer — if player hasn't acted in 8s, show suggested plays
    this.resetSuggestTimer();
  }

  /** Get board interaction callbacks */
  private getCallbacks(): BoardCallbacks {
    return {
      onHandCardClick: (card, index) => this.onHandCardClick(card, index),
      onBattlefieldCardClick: (perm, controller) => this.onBattlefieldClick(perm, controller),
      onExileClick: (_player) => this.showExileBrowser(),
      onGraveyardClick: (player) => this.showGraveyardViewer(player),
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

      // ─── Fix 1: X-Cost Handling ───
      const hasXCost = (card.manaCost ?? '').includes('{X}');

      if (hasXCost) {
        // Async X-cost flow — break out of sync callback
        this.handleXCostCast(card, me, state);
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

        // ─── Fix 4: Enhanced targeting ───
        if (this.spellNeedsTarget(card)) {
          const targetCount = this.parseTargetCount(card);
          const filter = this.parseTargetFilterFromCard(card);
          this.enterEnhancedTargetingMode(
            card,
            Math.max(1, targetCount),
            filter,
            (targets) => {
              this.submitAction({
                type: 'cast-spell',
                player: this.humanPlayer,
                cardId: card.id,
                targets,
                manaPayment: tapResult.payment,
              });
            },
            () => {
              // Cancel — undo the tap by restoring state
              this.game.setState(state);
              this.render();
            },
          );
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

  /**
   * Handle casting an X-cost spell asynchronously.
   * Shows the X-cost modal, then casts the spell with the chosen X value.
   */
  private async handleXCostCast(card: Card, me: typeof this.game extends Game ? never : any, state: GameState): Promise<void> {
    // Calculate max X the player can afford
    const baseCostStr = (card.manaCost ?? '').replace(/\{X\}/g, '');
    const baseCost = parseManaCost(baseCostStr);
    const baseTotal = baseCost.W + baseCost.U + baseCost.B + baseCost.R + baseCost.G + baseCost.C + baseCost.generic;

    // Count total mana from untapped sources
    let totalAvailable = 0;
    for (const perm of (state.players[this.humanPlayer] as any).battlefield) {
      if (perm.tapped) continue;
      const typeLine = (perm.typeLine ?? '').toLowerCase();
      const oracleText = (perm.oracleText ?? '').toLowerCase();
      const isManaSource = typeLine.includes('land') || oracleText.includes('{t}: add');
      if (isManaSource) totalAvailable++;
      // Sol Ring produces 2
      if (oracleText.includes('add {c}{c}')) totalAvailable++;
    }

    const maxX = Math.max(0, totalAvailable - baseTotal);

    if (maxX <= 0) {
      logMessage(`<span style="color:var(--warning)">Not enough mana to cast ${card.name} with X > 0</span>`);
      return;
    }

    const xValue = await this.showXCostModal(card, maxX);
    if (xValue === 0) return; // Cancelled

    // Build the full cost with X value added as generic
    const fullCost = parseManaCost(card.manaCost);
    fullCost.generic += xValue; // X is paid as generic mana
    fullCost.X = 0; // Clear X since we've converted it

    const currentState = this.game.getState();
    const currentMe = currentState.players[this.humanPlayer];
    const tapResult = autoTapLandsForCost(currentMe, fullCost);

    if (!tapResult) {
      logMessage(`<span style="color:var(--warning)">Not enough mana to cast ${card.name} for X=${xValue}</span>`);
      return;
    }

    // Update payment with X value
    tapResult.payment.xValue = xValue;

    const updatedState = {
      ...currentState,
      players: currentState.players.map((p, i) =>
        i === this.humanPlayer ? tapResult.updatedPlayer : p,
      ) as [typeof currentState.players[0], typeof currentState.players[1]],
    };
    this.game.setState(updatedState);

    // Check if spell needs targeting
    if (this.spellNeedsTarget(card)) {
      const targetCount = this.parseTargetCount(card);
      const filter = this.parseTargetFilterFromCard(card);
      this.enterEnhancedTargetingMode(
        card,
        Math.max(1, targetCount),
        filter,
        (targets) => {
          this.submitAction({
            type: 'cast-spell',
            player: this.humanPlayer,
            cardId: card.id,
            targets,
            manaPayment: tapResult.payment,
          });
        },
        () => {
          this.game.setState(currentState);
          this.render();
        },
      );
      return;
    }

    this.submitAction({
      type: 'cast-spell',
      player: this.humanPlayer,
      cardId: card.id,
      targets: [],
      manaPayment: tapResult.payment,
    });
  }

  /** Handle battlefield card click — targeting, combat selection, blocking */
  private onBattlefieldClick(perm: Permanent, controller: 0 | 1): void {
    if (!this.actionResolver) return;
    const state = this.game.getState();

    // ─── Fix 4: Enhanced targeting mode — add target to collection ───
    if (this.targetingMode && this.targetingState) {
      const legalIds = this.getLegalTargetIds();
      if (legalIds.includes(perm.id)) {
        this.addTargetToCollection({ type: 'permanent', id: perm.id });
      }
      return;
    }

    // Legacy targeting mode (fallback)
    if (this.targetingMode && this.targetingCard && !this.targetingState) {
      const legalIds = this.getLegalTargetIds();
      if (legalIds.includes(perm.id)) {
        const me = state.players[this.humanPlayer];
        const cost = parseManaCost(this.targetingCard.manaCost);
        const tapResult = autoTapLandsForCost(me, cost);
        if (tapResult) {
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

    // ─── Fix 2: Manual mana tapping — click your own lands to tap/untap ───
    if (controller === this.humanPlayer && state.step === 'main' && state.activePlayer === this.humanPlayer) {
      if (this.handleManualManaTap(perm, state)) {
        return;
      }
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

    // Planeswalker loyalty ability activation — takes priority over regular abilities
    if (perm.typeLine.toLowerCase().includes('planeswalker') && !perm.loyaltyUsedThisTurn) {
      const isMainPhase = state.phase === 'precombat-main' || state.phase === 'postcombat-main';
      if (isMainPhase && state.activePlayer === this.humanPlayer && state.stack.length === 0) {
        this.showPlaneswalkerAbilities(perm);
        return;
      }
    }

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

    // If no parsed abilities, check oracle text for Equip as fallback
    if (activatable.length === 0) {
      const oracleText = (perm.oracleText ?? '').toLowerCase();
      const equipFallback = oracleText.match(/equip\s*(\{[^}]+\})/i);
      if (equipFallback && perm.typeLine.toLowerCase().includes('equipment')) {
        const isMainPhase = state.phase === 'precombat-main' || state.phase === 'postcombat-main';
        if (isMainPhase && state.activePlayer === this.humanPlayer && state.stack.length === 0) {
          this.handleEquipAbility(perm, equipFallback[1]);
          return;
        }
      }
      return;
    }

    // If only one ability, activate directly (skip modal)
    if (activatable.length === 1) {
      const { ability, index } = activatable[0];
      if (ability.type === 'mana') {
        this.submitAction({ type: 'tap-for-mana', player: this.humanPlayer, permanentId: perm.id, abilityIndex: index });
      } else {
        // Check if this is a single equip ability — route to equip targeting UI
        const abilityText = ability.text.toLowerCase();
        const equipMatch = abilityText.match(/equip\s*(\{[^}]+\})/i);
        if (equipMatch && perm.typeLine.toLowerCase().includes('equipment')) {
          this.handleEquipAbility(perm, equipMatch[1]);
        } else {
          this.submitAction({ type: 'activate-ability', player: this.humanPlayer, sourceId: perm.id, abilityIndex: index, targets: [] });
        }
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
          // Check if this is an Equip ability — route to equip targeting UI
          const abilityText = ability.text.toLowerCase();
          const equipMatch = abilityText.match(/equip\s*(\{[^}]+\})/i);
          if (equipMatch && perm.typeLine.toLowerCase().includes('equipment')) {
            this.handleEquipAbility(perm, equipMatch[1]);
          } else {
            this.submitAction({ type: 'activate-ability', player: this.humanPlayer, sourceId: perm.id, abilityIndex: index, targets: [] });
          }
        }
      });

      panel.appendChild(btn);
    }

    // Also check if the permanent is an Equipment and add explicit Equip button from oracle text
    const oracleText = (perm.oracleText ?? '').toLowerCase();
    const equipOracleMatch = oracleText.match(/equip\s*(\{[^}]+\})/i);
    if (equipOracleMatch && perm.typeLine.toLowerCase().includes('equipment') &&
        !abilities.some(a => a.ability.text.toLowerCase().includes('equip'))) {
      const equipBtn = document.createElement('button');
      equipBtn.style.cssText = 'display:block;width:100%;padding:12px 16px;margin-bottom:8px;background:var(--obsidian,#1a1f2e);border:1px solid rgba(201,168,76,0.3);border-radius:10px;color:var(--text,#e2e8f0);cursor:pointer;text-align:left;font-family:Outfit,sans-serif;font-size:14px;transition:border-color 0.2s;';
      equipBtn.addEventListener('mouseenter', () => { equipBtn.style.borderColor = 'var(--gold,#c9a84c)'; });
      equipBtn.addEventListener('mouseleave', () => { equipBtn.style.borderColor = 'rgba(201,168,76,0.3)'; });

      const eqCostSpan = document.createElement('span');
      eqCostSpan.textContent = `Equip ${equipOracleMatch[1]}: `;
      eqCostSpan.style.cssText = 'color:var(--gold,#c9a84c);font-family:JetBrains Mono,monospace;font-size:13px;';
      const eqTextSpan = document.createElement('span');
      eqTextSpan.textContent = 'Attach to target creature you control';
      equipBtn.appendChild(eqCostSpan);
      equipBtn.appendChild(eqTextSpan);

      equipBtn.addEventListener('click', () => {
        overlay.remove();
        this.handleEquipAbility(perm, equipOracleMatch[1]);
      });
      panel.appendChild(equipBtn);
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

  // ==================== Phase 8 Styles (All 5 Fix Modals) ====================

  private static phase8StylesInjected = false;
  private injectPhase8Styles(): void {
    if (GameLoop.phase8StylesInjected) return;
    GameLoop.phase8StylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      /* ─── Shared Overlay Base ─── */
      .p8-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(10, 14, 23, 0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 1000;
        animation: p8FadeIn 0.2s ease;
      }
      @keyframes p8FadeIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
      .p8-content {
        background: linear-gradient(135deg, #1a1f2e, #0f1623);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 16px; padding: 24px;
        max-width: 440px; width: 90%;
        color: #e2e8f0; font-family: 'Outfit', sans-serif;
      }
      .p8-content h3 {
        color: #c9a84c; font-family: 'Cinzel', serif;
        margin: 0 0 12px 0; font-size: 18px; text-align: center;
      }
      .p8-content p { margin: 0 0 12px 0; font-size: 14px; text-align: center; color: #94a3b8; }
      .p8-btn-primary {
        background: linear-gradient(135deg, #c9a84c, #b8963f);
        border: none; border-radius: 50px;
        color: #0a0e17; font-weight: 600;
        padding: 10px 24px; cursor: pointer; width: 100%;
        font-family: 'Outfit', sans-serif; font-size: 14px;
        transition: opacity 0.2s;
      }
      .p8-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
      .p8-btn-primary:not(:disabled):hover { opacity: 0.9; }
      .p8-btn-cancel {
        display: block; width: 100%; padding: 8px; margin-top: 10px;
        background: transparent; color: #666; border: none; cursor: pointer;
        font-family: 'Outfit', sans-serif; font-size: 13px;
      }

      /* ─── Fix 1: X-Cost Modal ─── */
      .x-cost-card-name { color: #e2e8f0 !important; font-size: 16px !important; font-weight: 600; }
      .x-cost-slider {
        width: 100%; margin: 12px 0; accent-color: #c9a84c;
        -webkit-appearance: none; appearance: none; height: 6px;
        background: #2d3748; border-radius: 3px; outline: none;
      }
      .x-cost-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 20px; height: 20px; border-radius: 50%;
        background: linear-gradient(135deg, #c9a84c, #e8d48b);
        cursor: pointer; border: 2px solid #0a0e17;
      }
      .x-cost-value {
        text-align: center; font-size: 28px; font-weight: 700;
        color: #c9a84c; font-family: 'Cinzel', serif; margin: 8px 0 16px;
      }

      /* ─── Fix 2: Mana Pool Display ─── */
      .mana-pool-display {
        position: fixed; bottom: 120px; left: 50%; transform: translateX(-50%);
        background: linear-gradient(135deg, #1a1f2e, #0f1623);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 16px; padding: 10px 18px;
        display: flex; align-items: center; gap: 10px;
        z-index: 900; font-family: 'Outfit', sans-serif;
        color: #e2e8f0; font-size: 14px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      }
      .mana-pool-display.hidden { display: none; }
      .mana-pool-pip {
        display: inline-flex; align-items: center; gap: 3px;
        padding: 2px 8px; border-radius: 10px;
        font-weight: 600; font-size: 13px; min-width: 32px; justify-content: center;
      }
      .mana-pool-pip.mana-w { background: #f9faf4; color: #333; }
      .mana-pool-pip.mana-u { background: #0e68ab; color: #fff; }
      .mana-pool-pip.mana-b { background: #150b00; color: #ccc; border: 1px solid #333; }
      .mana-pool-pip.mana-r { background: #d3202a; color: #fff; }
      .mana-pool-pip.mana-g { background: #00733e; color: #fff; }
      .mana-pool-pip.mana-c { background: #94a3b8; color: #0a0e17; }
      .mana-pool-pip.mana-generic { background: #555; color: #e2e8f0; }
      .mana-pool-label { color: #94a3b8; font-size: 12px; margin-right: 4px; }
      .mana-pool-autopay {
        background: rgba(201, 168, 76, 0.2); border: 1px solid rgba(201, 168, 76, 0.4);
        border-radius: 50px; color: #c9a84c; padding: 4px 12px; cursor: pointer;
        font-size: 12px; font-family: 'Outfit', sans-serif; margin-left: 6px;
        transition: background 0.2s;
      }
      .mana-pool-autopay:hover { background: rgba(201, 168, 76, 0.4); }
      .mana-pool-clear {
        background: rgba(100, 116, 139, 0.2); border: 1px solid rgba(100, 116, 139, 0.3);
        border-radius: 50px; color: #94a3b8; padding: 4px 10px; cursor: pointer;
        font-size: 12px; font-family: 'Outfit', sans-serif;
        transition: background 0.2s;
      }
      .mana-pool-clear:hover { background: rgba(100, 116, 139, 0.4); }
      .manually-tapped { outline: 2px solid #c9a84c; outline-offset: 2px; }

      /* ─── Fix 3: Mana Color Choice ─── */
      .mana-color-buttons {
        display: flex; gap: 10px; justify-content: center; margin: 16px 0;
      }
      .mana-btn {
        width: 52px; height: 52px; border-radius: 50%; border: 2px solid transparent;
        font-size: 20px; font-weight: 700; cursor: pointer;
        font-family: 'Cinzel', serif; transition: all 0.2s;
        display: flex; align-items: center; justify-content: center;
      }
      .mana-btn:hover { transform: scale(1.15); box-shadow: 0 0 16px rgba(201,168,76,0.5); }
      .mana-btn.mana-w { background: #f9faf4; color: #333; border-color: #ddd; }
      .mana-btn.mana-u { background: #0e68ab; color: #fff; border-color: #1a7ec5; }
      .mana-btn.mana-b { background: #150b00; color: #ccc; border-color: #333; }
      .mana-btn.mana-r { background: #d3202a; color: #fff; border-color: #e84040; }
      .mana-btn.mana-g { background: #00733e; color: #fff; border-color: #009950; }

      /* ─── Fix 4: Targeting Banner ─── */
      .targeting-banner {
        position: fixed; top: 0; left: 0; right: 0;
        background: linear-gradient(135deg, rgba(201,168,76,0.15), rgba(201,168,76,0.05));
        border-bottom: 1px solid rgba(201,168,76,0.4);
        padding: 10px 20px; display: flex; align-items: center;
        justify-content: center; gap: 16px; z-index: 950;
        font-family: 'Outfit', sans-serif; color: #e2e8f0; font-size: 14px;
        animation: p8FadeIn 0.2s ease;
      }
      .targeting-banner span { color: #c9a84c; }
      .targeting-count { color: #94a3b8 !important; font-size: 13px; }
      .targeting-confirm, .targeting-cancel {
        padding: 6px 16px; border-radius: 50px; cursor: pointer;
        font-family: 'Outfit', sans-serif; font-size: 13px; border: none;
      }
      .targeting-confirm {
        background: linear-gradient(135deg, #c9a84c, #b8963f);
        color: #0a0e17; font-weight: 600;
      }
      .targeting-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
      .targeting-cancel {
        background: rgba(100,116,139,0.2); color: #94a3b8;
        border: 1px solid rgba(100,116,139,0.3);
      }
      .targeting-valid-glow {
        box-shadow: 0 0 12px rgba(52, 211, 153, 0.6), 0 0 4px rgba(52, 211, 153, 0.3);
        outline: 2px solid #34d399; outline-offset: 1px;
        cursor: crosshair !important;
      }
      .targeting-dimmed { opacity: 0.35; pointer-events: none; }
      .targeting-player-btn {
        padding: 8px 20px; border-radius: 10px; cursor: crosshair;
        border: 2px solid rgba(52,211,153,0.4); background: rgba(52,211,153,0.1);
        color: #34d399; font-family: 'Outfit', sans-serif; font-size: 14px;
        transition: all 0.2s;
      }
      .targeting-player-btn:hover {
        background: rgba(52,211,153,0.25); border-color: #34d399;
      }

      /* ─── Fix 4: Graveyard Browser ─── */
      .graveyard-browser {
        max-height: 300px; overflow-y: auto; margin: 12px 0;
        scrollbar-width: thin; scrollbar-color: #c9a84c #1a1f2e;
      }
      .graveyard-card-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 10px; margin: 4px 0;
        background: rgba(201,168,76,0.05); border: 1px solid rgba(201,168,76,0.1);
        cursor: pointer; transition: all 0.2s;
      }
      .graveyard-card-row:hover {
        background: rgba(201,168,76,0.15); border-color: rgba(201,168,76,0.4);
      }
      .graveyard-card-row.selected {
        background: rgba(52,211,153,0.15); border-color: #34d399;
      }
      .graveyard-card-name { color: #e2e8f0; font-weight: 500; flex: 1; }
      .graveyard-card-type { color: #94a3b8; font-size: 12px; }

      /* ─── Fix 5: Damage Assignment ─── */
      .damage-assign-blockers { margin: 16px 0; }
      .damage-blocker {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 14px; margin: 6px 0;
        background: rgba(201,168,76,0.08); border: 1px solid rgba(201,168,76,0.15);
        border-radius: 10px;
      }
      .damage-blocker-info { flex: 1; }
      .damage-blocker-name { color: #e2e8f0; font-weight: 500; }
      .damage-blocker-stats { color: #94a3b8; font-size: 12px; }
      .damage-input {
        width: 60px; padding: 6px 8px; text-align: center;
        background: #0a0e17; border: 1px solid rgba(201,168,76,0.3);
        border-radius: 8px; color: #c9a84c; font-size: 16px; font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
      }
      .damage-input:focus { outline: none; border-color: #c9a84c; }
      .damage-remaining {
        text-align: center; font-size: 14px; margin-top: 12px;
        padding: 8px; border-radius: 8px;
        background: rgba(201,168,76,0.08);
      }
      .damage-remaining.over-assigned { color: #d3202a !important; }
      .damage-remaining.valid { color: #34d399 !important; }

      /* ─── Discard Picker ─── */
      .discard-picker-list {
        max-height: 340px; overflow-y: auto; margin: 12px 0;
        scrollbar-width: thin; scrollbar-color: #c9a84c #1a1f2e;
      }
      .discard-card-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 10px; margin: 4px 0;
        background: rgba(201,168,76,0.05); border: 2px solid rgba(201,168,76,0.1);
        cursor: pointer; transition: all 0.2s; user-select: none;
      }
      .discard-card-row:hover {
        background: rgba(201,168,76,0.12); border-color: rgba(201,168,76,0.3);
      }
      .discard-card-row.selected {
        background: rgba(201,168,76,0.2); border-color: #c9a84c;
        box-shadow: 0 0 8px rgba(201,168,76,0.3);
      }
      .discard-card-name { color: #e2e8f0; font-weight: 500; flex: 1; }
      .discard-card-cost { color: #c9a84c; font-size: 13px; font-family: 'JetBrains Mono', monospace; }
      .discard-card-type { color: #94a3b8; font-size: 12px; }
      .discard-counter {
        text-align: center; font-size: 14px; margin: 8px 0 12px;
        color: #94a3b8; font-weight: 500;
      }
      .discard-counter .count-current { color: #c9a84c; font-weight: 700; }
      .discard-counter .count-ready { color: #34d399; }

      /* ─── Sacrifice Picker ─── */
      .sacrifice-picker-list {
        max-height: 340px; overflow-y: auto; margin: 12px 0;
        scrollbar-width: thin; scrollbar-color: #ef4444 #1a1f2e;
      }
      .sacrifice-card-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 10px; margin: 4px 0;
        background: rgba(239,68,68,0.05); border: 2px solid rgba(239,68,68,0.1);
        cursor: pointer; transition: all 0.2s; user-select: none;
      }
      .sacrifice-card-row:hover {
        background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.3);
      }
      .sacrifice-card-row.selected {
        background: rgba(239,68,68,0.2); border-color: #ef4444;
        box-shadow: 0 0 8px rgba(239,68,68,0.3);
      }
      .sacrifice-card-name { color: #e2e8f0; font-weight: 500; flex: 1; }
      .sacrifice-card-stats { color: #94a3b8; font-size: 12px; }
      .sacrifice-card-type { color: #94a3b8; font-size: 12px; }
      .sacrifice-counter {
        text-align: center; font-size: 14px; margin: 8px 0 12px;
        color: #94a3b8; font-weight: 500;
      }
      .sacrifice-counter .count-current { color: #ef4444; font-weight: 700; }
      .sacrifice-counter .count-ready { color: #ef4444; }
      .p8-btn-danger {
        background: linear-gradient(135deg, #ef4444, #dc2626);
        border: none; border-radius: 50px;
        color: #fff; font-weight: 600;
        padding: 10px 24px; cursor: pointer; width: 100%;
        font-family: 'Outfit', sans-serif; font-size: 14px;
        transition: opacity 0.2s;
      }
      .p8-btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
      .p8-btn-danger:not(:disabled):hover { opacity: 0.9; }

      /* ─── Library Search / Tutor UI ─── */
      .search-lib-search-box {
        width: 100%; padding: 8px 12px; margin-bottom: 10px;
        background: #0a0e17; border: 1px solid rgba(201,168,76,0.3);
        border-radius: 10px; color: #e2e8f0; font-size: 14px;
        font-family: 'Outfit', sans-serif; outline: none;
        transition: border-color 0.2s; box-sizing: border-box;
      }
      .search-lib-search-box::placeholder { color: #4a5568; }
      .search-lib-search-box:focus { border-color: #c9a84c; }
      .search-lib-list {
        max-height: 380px; overflow-y: auto; margin: 8px 0;
        scrollbar-width: thin; scrollbar-color: #c9a84c #1a1f2e;
      }
      .search-lib-card-row {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px; border-radius: 10px; margin: 4px 0;
        background: rgba(201,168,76,0.05); border: 2px solid rgba(201,168,76,0.1);
        cursor: pointer; transition: all 0.2s; user-select: none;
      }
      .search-lib-card-row:hover {
        background: rgba(201,168,76,0.12); border-color: rgba(201,168,76,0.3);
      }
      .search-lib-card-row.selected {
        background: rgba(201,168,76,0.2); border-color: #c9a84c;
        box-shadow: 0 0 8px rgba(201,168,76,0.3);
      }
      .search-lib-card-info { flex: 1; min-width: 0; }
      .search-lib-card-name { color: #e2e8f0; font-weight: 600; font-size: 14px; }
      .search-lib-card-type { color: #94a3b8; font-size: 12px; margin-top: 2px; }
      .search-lib-card-cost {
        color: #c9a84c; font-size: 13px; font-family: 'JetBrains Mono', monospace;
        white-space: nowrap;
      }
      .search-lib-cmc-badge {
        background: rgba(201,168,76,0.2); color: #c9a84c;
        font-size: 11px; font-weight: 700; font-family: 'JetBrains Mono', monospace;
        padding: 2px 7px; border-radius: 8px; min-width: 22px; text-align: center;
      }
      .search-lib-counter {
        text-align: center; font-size: 14px; margin: 8px 0 12px;
        color: #94a3b8; font-weight: 500;
      }
      .search-lib-counter .count-current { color: #c9a84c; font-weight: 700; }
      .search-lib-counter .count-ready { color: #34d399; }
      .search-lib-empty {
        text-align: center; color: #4a5568; padding: 24px;
        font-size: 14px; font-style: italic;
      }

      /* ─── Scry UI ─── */
      .scry-card-list { margin: 12px 0; }
      .scry-card-row {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border-radius: 10px; margin: 6px 0;
        background: rgba(201,168,76,0.05); border: 1px solid rgba(201,168,76,0.15);
        transition: all 0.2s; user-select: none;
      }
      .scry-card-info { flex: 1; min-width: 0; }
      .scry-card-name { color: #e2e8f0; font-weight: 600; font-size: 14px; }
      .scry-card-type { color: #94a3b8; font-size: 12px; margin-top: 2px; }
      .scry-card-cost {
        color: #c9a84c; font-size: 13px; font-family: 'JetBrains Mono', monospace;
        white-space: nowrap; margin-right: 6px;
      }
      .scry-toggle-group { display: flex; gap: 4px; }
      .scry-toggle-btn {
        padding: 5px 14px; border-radius: 50px; border: 1px solid transparent;
        font-size: 12px; font-weight: 600; cursor: pointer;
        font-family: 'Outfit', sans-serif; transition: all 0.2s;
      }
      .scry-toggle-btn.top-btn {
        background: rgba(201,168,76,0.15); color: #c9a84c;
        border-color: rgba(201,168,76,0.3);
      }
      .scry-toggle-btn.top-btn.active {
        background: linear-gradient(135deg, #c9a84c, #b8963f);
        color: #0a0e17; border-color: #c9a84c;
      }
      .scry-toggle-btn.bottom-btn {
        background: rgba(100,116,139,0.15); color: #94a3b8;
        border-color: rgba(100,116,139,0.3);
      }
      .scry-toggle-btn.bottom-btn.active {
        background: rgba(100,116,139,0.5); color: #e2e8f0;
        border-color: #94a3b8;
      }
      .scry-summary {
        text-align: center; font-size: 13px; margin: 10px 0;
        color: #94a3b8; font-weight: 500;
      }
      .scry-summary .scry-top-count { color: #c9a84c; font-weight: 700; }
      .scry-summary .scry-bottom-count { color: #94a3b8; font-weight: 700; }
    `;
    document.head.appendChild(style);
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
    const advantage = evaluateBoardPosition(state, this.humanPlayer);

    panel.className = `pvb-gameover ${won ? 'win' : 'loss'}`;
    panel.innerHTML = `
      <h2>${won ? 'Victory!' : 'Defeat'}</h2>
      <div class="pvb-gameover-stats">
        Game lasted ${state.turn} turns<br>
        Your life: ${state.players[this.humanPlayer].life} | Bot life: ${state.players[this.botPlayer].life}<br>
        Final board advantage: ${advantage > 0 ? '+' : ''}${advantage.toFixed(1)}
      </div>
      <div class="pvb-gameover-actions">
        <button class="pvb-btn gold" id="btn-analysis">📊 Game Analysis</button>
        <button class="pvb-btn primary" onclick="location.reload()">Play Again</button>
        <button class="pvb-btn" onclick="location.href='/'">Home</button>
      </div>
    `;

    // Bind analysis button
    const analysisBtn = document.getElementById('btn-analysis');
    if (analysisBtn) {
      analysisBtn.addEventListener('click', () => {
        const analysis = analyzeGame(state, this.humanPlayer);
        const analysisOverlay = renderAnalysisOverlay(analysis);
        document.body.appendChild(analysisOverlay);
      });
    }
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

        // ─── AI Mulligan Advisor Button ───
        const advisorBtn = document.createElement('button');
        advisorBtn.className = 'pvb-btn mulligan-advisor';
        advisorBtn.textContent = '🤖 Ask AI';
        advisorBtn.title = 'What would the AI do?';
        advisorBtn.addEventListener('click', () => {
          const currentState = this.game.getState();
          const explanation = explainMulliganDecision(currentState, this.humanPlayer);
          const shouldKeep = shouldKeepHand(currentState, this.humanPlayer);
          const adviceEl = document.getElementById('mulligan-ai-advice');
          if (adviceEl) {
            adviceEl.innerHTML = `
              <div class="mulligan-advice-bubble">
                <span class="mulligan-advice-icon">🤖</span>
                <div class="mulligan-advice-text">
                  <strong>AI recommends: ${shouldKeep ? 'KEEP' : 'MULLIGAN'}</strong><br>
                  ${explanation}
                </div>
              </div>
            `;
            adviceEl.classList.remove('hidden');
          } else {
            // Fallback: create the advice element
            const newAdvice = document.createElement('div');
            newAdvice.id = 'mulligan-ai-advice';
            newAdvice.innerHTML = `
              <div class="mulligan-advice-bubble">
                <span class="mulligan-advice-icon">🤖</span>
                <div class="mulligan-advice-text">
                  <strong>AI recommends: ${shouldKeep ? 'KEEP' : 'MULLIGAN'}</strong><br>
                  ${explanation}
                </div>
              </div>
            `;
            actionsEl.parentElement?.appendChild(newAdvice);
          }
        });
        actionsEl.appendChild(advisorBtn);
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

  // ==================== Fix 1: X-Spell Cost Input Modal ====================

  /**
   * Show a modal for choosing X value when casting X-cost spells.
   * Returns the chosen X value (1 to maxX).
   */
  private showXCostModal(card: Card, maxX: number): Promise<number> {
    this.injectPhase8Styles();
    return new Promise<number>((resolve) => {
      document.getElementById('x-cost-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'x-cost-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';

      content.innerHTML = `
        <h3>Choose X Value</h3>
        <p class="x-cost-card-name">${card.name}</p>
        <p>Available mana for X: ${maxX}</p>
        <input type="range" min="0" max="${maxX}" value="1" class="x-cost-slider">
        <div class="x-cost-value">X = <span>1</span></div>
        <button class="p8-btn-primary x-cost-confirm">Cast for X = 1</button>
        <button class="p8-btn-cancel">Cancel</button>
      `;

      const slider = content.querySelector('.x-cost-slider') as HTMLInputElement;
      const valueDisplay = content.querySelector('.x-cost-value span') as HTMLElement;
      const confirmBtn = content.querySelector('.x-cost-confirm') as HTMLButtonElement;
      const cancelBtn = content.querySelector('.p8-btn-cancel') as HTMLButtonElement;

      slider.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        valueDisplay.textContent = String(val);
        confirmBtn.textContent = `Cast for X = ${val}`;
      });

      confirmBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(parseInt(slider.value, 10));
      });

      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(0); // 0 means cancel
      });

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(0); }
      });

      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
  }

  // ==================== Fix 2: Manual Mana Tapping ====================

  /**
   * Toggle manual tapping of a land/mana source on the battlefield.
   * Returns true if the tap was handled (so caller can skip normal click handling).
   */
  private handleManualManaTap(perm: Permanent, state: GameState): boolean {
    const typeLine = perm.typeLine.toLowerCase();
    const oracleText = (perm.oracleText ?? '').toLowerCase();
    const isManaSource = typeLine.includes('land') || oracleText.includes('{t}: add');
    if (!isManaSource) return false;

    // Already manually tapped — untap it
    if (this.manuallyTappedIds.has(perm.id)) {
      this.manuallyTappedIds.delete(perm.id);
      // Remove the mana this land contributed
      const manaColor = this.getManaColorFromPerm(perm);
      if (manaColor) {
        if (manaColor === 'generic') {
          this.manualManaPool.generic = Math.max(0, this.manualManaPool.generic - 1);
        } else {
          this.manualManaPool[manaColor] = Math.max(0, this.manualManaPool[manaColor] - 1);
        }
      }
      // Untap the permanent in state
      const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
      const ps = players[this.humanPlayer];
      const newBf = ps.battlefield.map(p =>
        p.id === perm.id ? { ...p, tapped: false } : p
      );
      players[this.humanPlayer] = { ...ps, battlefield: newBf, manaPool: { ...this.manualManaPool } };
      this.game.setState({ ...state, players });
      this.renderManaPoolDisplay();
      this.render();
      return true;
    }

    // Not yet tapped — tap it
    if (perm.tapped) return false; // Already tapped by engine, can't manually tap

    // Check if it produces "any color" — need color choice
    if (oracleText.includes('any color')) {
      this.handleAnyColorTap(perm, state);
      return true;
    }

    const manaColor = this.getManaColorFromPerm(perm);
    if (!manaColor) return false;

    this.manuallyTappedIds.add(perm.id);
    if (manaColor === 'generic') {
      this.manualManaPool.generic++;
    } else {
      this.manualManaPool[manaColor]++;
    }

    // Tap the permanent in state
    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    const ps = players[this.humanPlayer];
    const newBf = ps.battlefield.map(p =>
      p.id === perm.id ? { ...p, tapped: true } : p
    );
    players[this.humanPlayer] = { ...ps, battlefield: newBf, manaPool: { ...this.manualManaPool } };
    this.game.setState({ ...state, players });
    this.renderManaPoolDisplay();
    this.render();
    return true;
  }

  /** Handle tapping a land that produces "any color" — shows color choice modal first */
  private async handleAnyColorTap(perm: Permanent, state: GameState): Promise<void> {
    const color = await this.showManaColorChoice();
    if (!color) return;

    this.manuallyTappedIds.add(perm.id);
    this.manualManaPool[color]++;

    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    const ps = players[this.humanPlayer];
    const newBf = ps.battlefield.map(p =>
      p.id === perm.id ? { ...p, tapped: true } : p
    );
    players[this.humanPlayer] = { ...ps, battlefield: newBf, manaPool: { ...this.manualManaPool } };
    this.game.setState({ ...state, players });
    this.renderManaPoolDisplay();
    this.render();
  }

  /** Determine what color of mana a permanent produces */
  private getManaColorFromPerm(perm: Permanent): 'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'generic' | null {
    const text = (perm.oracleText ?? '').toLowerCase();
    const typeLine = perm.typeLine.toLowerCase();

    if (typeLine.includes('forest') || text.includes('add {g}')) return 'G';
    if (typeLine.includes('island') || text.includes('add {u}')) return 'U';
    if (typeLine.includes('plains') || text.includes('add {w}')) return 'W';
    if (typeLine.includes('swamp') || text.includes('add {b}')) return 'B';
    if (typeLine.includes('mountain') || text.includes('add {r}')) return 'R';
    if (text.includes('add {c}{c}')) return 'C'; // Sol Ring, etc.
    if (text.includes('add {c}')) return 'C';
    if (text.includes('any color')) return 'generic'; // handled by color choice modal
    return null;
  }

  /** Render the floating mana pool display */
  private renderManaPoolDisplay(): void {
    this.injectPhase8Styles();
    let el = document.getElementById('mana-pool-display');

    const total = totalMana(this.manualManaPool);
    if (total === 0 && !this.manaTappingMode) {
      if (el) el.classList.add('hidden');
      return;
    }

    if (!el) {
      el = document.createElement('div');
      el.id = 'mana-pool-display';
      el.className = 'mana-pool-display';
      document.body.appendChild(el);
    }

    el.classList.remove('hidden');

    const pips: string[] = [];
    pips.push('<span class="mana-pool-label">Mana:</span>');
    const colorMap: [keyof ManaPool, string, string][] = [
      ['W', 'mana-w', 'W'],
      ['U', 'mana-u', 'U'],
      ['B', 'mana-b', 'B'],
      ['R', 'mana-r', 'R'],
      ['G', 'mana-g', 'G'],
      ['C', 'mana-c', 'C'],
      ['generic', 'mana-generic', '?'],
    ];

    for (const [key, cls, label] of colorMap) {
      const count = this.manualManaPool[key];
      if (count > 0) {
        pips.push(`<span class="mana-pool-pip ${cls}">${label}:${count}</span>`);
      }
    }

    if (total === 0) {
      pips.push('<span style="color:#666">Empty</span>');
    }

    pips.push('<button class="mana-pool-clear" id="mana-pool-clear-btn">Clear</button>');

    el.innerHTML = pips.join('');

    // Re-attach clear button handler
    const clearBtn = document.getElementById('mana-pool-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.clearManualMana();
      });
    }
  }

  /** Clear all manual mana tapping */
  private clearManualMana(): void {
    if (this.manuallyTappedIds.size === 0) return;

    const state = this.game.getState();
    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    const ps = players[this.humanPlayer];
    const newBf = ps.battlefield.map(p =>
      this.manuallyTappedIds.has(p.id) ? { ...p, tapped: false } : p
    );
    this.manuallyTappedIds.clear();
    this.manualManaPool = emptyPool();
    players[this.humanPlayer] = { ...ps, battlefield: newBf, manaPool: emptyPool() };
    this.game.setState({ ...state, players });
    this.renderManaPoolDisplay();
    this.render();
  }

  // ==================== Fix 3: Mana Color Choice Modal ====================

  /**
   * Show a modal for choosing mana color when tapping an "any color" source.
   * Returns the chosen color, or null if cancelled.
   */
  private showManaColorChoice(): Promise<'W' | 'U' | 'B' | 'R' | 'G' | null> {
    this.injectPhase8Styles();
    return new Promise((resolve) => {
      document.getElementById('mana-color-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'mana-color-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';

      content.innerHTML = `
        <h3>Choose Mana Color</h3>
        <p>This source can produce any color of mana.</p>
        <div class="mana-color-buttons">
          <button data-color="W" class="mana-btn mana-w">W</button>
          <button data-color="U" class="mana-btn mana-u">U</button>
          <button data-color="B" class="mana-btn mana-b">B</button>
          <button data-color="R" class="mana-btn mana-r">R</button>
          <button data-color="G" class="mana-btn mana-g">G</button>
        </div>
        <button class="p8-btn-cancel">Cancel</button>
      `;

      content.querySelectorAll('.mana-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const color = (btn as HTMLElement).dataset.color as 'W' | 'U' | 'B' | 'R' | 'G';
          overlay.remove();
          resolve(color);
        });
      });

      content.querySelector('.p8-btn-cancel')?.addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(null); }
      });

      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
  }

  // ==================== Fix 4: Enhanced Target Selection System ====================

  /**
   * Enter enhanced targeting mode with multi-target and zone support.
   */
  private enterEnhancedTargetingMode(
    card: Card,
    requiredTargets: number,
    filter: TargetFilter | null,
    onComplete: (targets: Target[]) => void,
    onCancel: () => void,
  ): void {
    this.injectPhase8Styles();
    this.targetingMode = true;
    this.targetingCard = card;

    this.targetingState = {
      card,
      requiredTargets,
      collectedTargets: [],
      filter,
      zone: filter?.zone ?? 'battlefield',
      onComplete,
      onCancel,
    };

    // If targeting a graveyard, show graveyard browser
    if (filter?.zone === 'graveyard') {
      this.showGraveyardBrowser();
      return;
    }

    this.render();
    this.showTargetingBanner();
  }

  /** Show the targeting banner at the top of the screen */
  private showTargetingBanner(): void {
    document.getElementById('targeting-banner')?.remove();

    if (!this.targetingState) return;
    const ts = this.targetingState;

    const banner = document.createElement('div');
    banner.id = 'targeting-banner';
    banner.className = 'targeting-banner';

    banner.innerHTML = `
      <span>Select target for <strong>${ts.card.name}</strong></span>
      <span class="targeting-count">${ts.collectedTargets.length}/${ts.requiredTargets} targets</span>
      <button class="targeting-confirm" ${ts.collectedTargets.length < ts.requiredTargets ? 'disabled' : ''}>Confirm</button>
      <button class="targeting-cancel">Cancel</button>
    `;

    const confirmBtn = banner.querySelector('.targeting-confirm') as HTMLButtonElement;
    const cancelBtn = banner.querySelector('.targeting-cancel') as HTMLButtonElement;

    confirmBtn.addEventListener('click', () => {
      if (ts.collectedTargets.length >= ts.requiredTargets) {
        banner.remove();
        const targets = [...ts.collectedTargets];
        this.cancelTargeting();
        ts.onComplete(targets);
      }
    });

    cancelBtn.addEventListener('click', () => {
      banner.remove();
      this.cancelTargeting();
      ts.onCancel();
    });

    // Add player targeting buttons if no filter or filter allows players
    if (!ts.filter || !ts.filter.cardType) {
      const playerDiv = document.createElement('div');
      playerDiv.style.cssText = 'display:flex;gap:8px;margin-left:8px;';

      for (const pi of [0, 1] as const) {
        const label = pi === this.humanPlayer ? 'You' : 'Opponent';
        const btn = document.createElement('button');
        btn.className = 'targeting-player-btn';
        btn.textContent = `Target ${label}`;
        btn.addEventListener('click', () => {
          this.addTargetToCollection({ type: 'player', id: String(pi) });
        });
        playerDiv.appendChild(btn);
      }
      banner.appendChild(playerDiv);
    }

    document.body.appendChild(banner);
  }

  /** Add a target to the current targeting state collection */
  private addTargetToCollection(target: Target): void {
    if (!this.targetingState) return;
    const ts = this.targetingState;

    // Don't add duplicate targets
    if (ts.collectedTargets.some(t => t.id === target.id && t.type === target.type)) return;

    ts.collectedTargets.push(target);

    // Update banner
    this.showTargetingBanner();
    this.render();

    // If we have enough targets, auto-confirm for single-target spells
    if (ts.requiredTargets === 1 && ts.collectedTargets.length === 1) {
      document.getElementById('targeting-banner')?.remove();
      const targets = [...ts.collectedTargets];
      const onComplete = ts.onComplete;
      this.cancelTargeting();
      onComplete(targets);
    }
  }

  /** Show a graveyard browser for targeting cards in graveyards */
  private showGraveyardBrowser(): void {
    if (!this.targetingState) return;
    const ts = this.targetingState;
    const state = this.game.getState();

    document.getElementById('graveyard-browser-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'graveyard-browser-modal';
    overlay.className = 'p8-overlay';

    const content = document.createElement('div');
    content.className = 'p8-content';
    content.style.maxWidth = '500px';

    content.innerHTML = `<h3>Select Target in Graveyard</h3><p>Choose a card for ${ts.card.name}</p>`;

    const browser = document.createElement('div');
    browser.className = 'graveyard-browser';

    // Get valid targets from all graveyards
    const validTargets = ts.filter
      ? getValidTargets(state, this.humanPlayer, ts.filter)
      : [];

    if (validTargets.length === 0) {
      browser.innerHTML = '<p style="text-align:center;color:#666;padding:20px;">No valid targets in graveyards</p>';
    } else {
      for (const target of validTargets) {
        // Find the card
        let cardName = '';
        let cardType = '';
        for (const p of state.players) {
          const card = p.graveyard.find(c => c.id === target.id);
          if (card) { cardName = card.name; cardType = card.typeLine; break; }
        }

        const row = document.createElement('div');
        row.className = 'graveyard-card-row';
        row.innerHTML = `
          <span class="graveyard-card-name">${cardName}</span>
          <span class="graveyard-card-type">${cardType}</span>
        `;
        row.addEventListener('click', () => {
          overlay.remove();
          const targets = [target];
          const onComplete = ts.onComplete;
          this.cancelTargeting();
          onComplete(targets);
        });
        browser.appendChild(row);
      }
    }

    content.appendChild(browser);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p8-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      const onCancel = ts.onCancel;
      this.cancelTargeting();
      onCancel();
    });
    content.appendChild(cancelBtn);

    overlay.appendChild(content);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        const onCancel = ts.onCancel;
        this.cancelTargeting();
        onCancel();
      }
    });
    document.body.appendChild(overlay);
  }

  /** Parse oracle text to determine how many targets a spell needs */
  private parseTargetCount(card: Card): number {
    const text = (card.oracleText ?? '').toLowerCase();
    // Count "target" occurrences that reference different things
    const targetMatches = text.match(/target\s+\w+/g);
    if (!targetMatches) return 0;
    // Deduplicate: "target creature" appearing twice still means 2 targets for "destroy two target creatures"
    // But "target creature and target player" means 2 different targets
    // Simple heuristic: count distinct target phrases
    const distinctTargets = new Set(targetMatches);
    return distinctTargets.size;
  }

  /** Parse oracle text to get a target filter */
  private parseTargetFilterFromCard(card: Card): TargetFilter | null {
    const text = (card.oracleText ?? '').toLowerCase();
    // Find the first "target X" phrase
    const match = text.match(/target\s+([^.,:;]+)/);
    if (!match) return null;
    return parseTargetFilter(match[0]);
  }

  // ==================== Discard Picker ====================

  /**
   * Show a modal for choosing cards to discard from hand.
   * Returns Promise resolving with selected card IDs.
   */
  private showDiscardPicker(count: number): Promise<string[]> {
    this.injectPhase8Styles();

    return new Promise<string[]>((resolve) => {
      document.getElementById('discard-picker-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'discard-picker-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';
      content.style.maxWidth = '480px';

      const state = this.game.getState();
      const hand = state.players[this.humanPlayer].hand;
      const selected = new Set<string>();

      const renderPicker = () => {
        content.innerHTML = '';

        const title = document.createElement('h3');
        title.textContent = `Discard ${count} Card${count > 1 ? 's' : ''}`;
        content.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.textContent = `Choose ${count} card${count > 1 ? 's' : ''} from your hand to discard.`;
        content.appendChild(subtitle);

        // Counter
        const counter = document.createElement('div');
        counter.className = 'discard-counter';
        const isReady = selected.size === count;
        counter.innerHTML = `Selected: <span class="${isReady ? 'count-ready' : 'count-current'}">${selected.size}</span> / ${count}`;
        content.appendChild(counter);

        // Card list
        const list = document.createElement('div');
        list.className = 'discard-picker-list';

        for (const card of hand) {
          const row = document.createElement('div');
          row.className = `discard-card-row${selected.has(card.id) ? ' selected' : ''}`;

          const nameEl = document.createElement('span');
          nameEl.className = 'discard-card-name';
          nameEl.textContent = card.name;

          const costEl = document.createElement('span');
          costEl.className = 'discard-card-cost';
          costEl.textContent = card.manaCost || '';

          const typeEl = document.createElement('span');
          typeEl.className = 'discard-card-type';
          typeEl.textContent = card.typeLine;

          row.appendChild(nameEl);
          row.appendChild(costEl);
          row.appendChild(typeEl);

          row.addEventListener('click', () => {
            if (selected.has(card.id)) {
              selected.delete(card.id);
            } else if (selected.size < count) {
              selected.add(card.id);
            }
            renderPicker();
          });

          list.appendChild(row);
        }
        content.appendChild(list);

        // Confirm button
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'p8-btn-primary';
        confirmBtn.textContent = `Confirm Discard (${selected.size}/${count})`;
        confirmBtn.disabled = selected.size !== count;
        confirmBtn.addEventListener('click', () => {
          if (selected.size === count) {
            overlay.remove();
            resolve(Array.from(selected));
          }
        });
        content.appendChild(confirmBtn);
      };

      renderPicker();

      overlay.appendChild(content);
      overlay.addEventListener('click', (e) => {
        // Do not allow dismiss — player must discard
      });
      document.body.appendChild(overlay);
    });
  }

  // ==================== Sacrifice Picker ====================

  /**
   * Show a modal for choosing permanents to sacrifice from the battlefield.
   * Returns Promise resolving with selected permanent IDs.
   */
  private showSacrificePicker(filter: string, count: number): Promise<string[]> {
    this.injectPhase8Styles();

    return new Promise<string[]>((resolve) => {
      document.getElementById('sacrifice-picker-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'sacrifice-picker-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';
      content.style.maxWidth = '480px';

      const state = this.game.getState();
      const battlefield = state.players[this.humanPlayer].battlefield;

      // Filter permanents by type
      const validPerms = battlefield.filter(perm => {
        const type = perm.card.typeLine.toLowerCase();
        if (filter === 'creature') return type.includes('creature');
        if (filter === 'artifact') return type.includes('artifact');
        if (filter === 'enchantment') return type.includes('enchantment');
        return true; // 'permanent' matches all
      });

      const selected = new Set<string>();

      const renderPicker = () => {
        content.innerHTML = '';

        const title = document.createElement('h3');
        title.style.color = '#ef4444';
        title.textContent = `Sacrifice ${count} ${filter}${count > 1 ? 's' : ''}`;
        content.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.textContent = `Choose ${count} ${filter}${count > 1 ? 's' : ''} to sacrifice.`;
        content.appendChild(subtitle);

        // Counter
        const counter = document.createElement('div');
        counter.className = 'sacrifice-counter';
        const isReady = selected.size === count;
        counter.innerHTML = `Selected: <span class="${isReady ? 'count-ready' : 'count-current'}">${selected.size}</span> / ${count}`;
        content.appendChild(counter);

        // Permanent list
        const list = document.createElement('div');
        list.className = 'sacrifice-picker-list';

        if (validPerms.length === 0) {
          const empty = document.createElement('p');
          empty.style.cssText = 'color: #94a3b8; text-align: center; padding: 20px;';
          empty.textContent = `No valid ${filter}s to sacrifice.`;
          list.appendChild(empty);
        }

        for (const perm of validPerms) {
          const row = document.createElement('div');
          row.className = `sacrifice-card-row${selected.has(perm.id) ? ' selected' : ''}`;

          const nameEl = document.createElement('span');
          nameEl.className = 'sacrifice-card-name';
          nameEl.textContent = perm.name;

          const statsEl = document.createElement('span');
          statsEl.className = 'sacrifice-card-stats';
          if (perm.card.power !== undefined && perm.card.toughness !== undefined) {
            statsEl.textContent = `${perm.currentPower ?? perm.card.power}/${perm.currentToughness ?? perm.card.toughness}`;
          }

          const typeEl = document.createElement('span');
          typeEl.className = 'sacrifice-card-type';
          typeEl.textContent = perm.card.typeLine;

          row.appendChild(nameEl);
          row.appendChild(statsEl);
          row.appendChild(typeEl);

          row.addEventListener('click', () => {
            if (selected.has(perm.id)) {
              selected.delete(perm.id);
            } else if (selected.size < count) {
              selected.add(perm.id);
            }
            renderPicker();
          });

          list.appendChild(row);
        }
        content.appendChild(list);

        // Confirm button (red for sacrifice)
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'p8-btn-danger';
        confirmBtn.textContent = `Sacrifice (${selected.size}/${count})`;
        confirmBtn.disabled = selected.size !== count || validPerms.length === 0;
        confirmBtn.addEventListener('click', () => {
          if (selected.size === count) {
            overlay.remove();
            resolve(Array.from(selected));
          }
        });
        content.appendChild(confirmBtn);

        // If not enough valid permanents, allow partial sacrifice
        if (validPerms.length < count && validPerms.length > 0) {
          const partialBtn = document.createElement('button');
          partialBtn.className = 'p8-btn-cancel';
          partialBtn.textContent = `Sacrifice all ${validPerms.length} available`;
          partialBtn.addEventListener('click', () => {
            overlay.remove();
            resolve(validPerms.map(p => p.id));
          });
          content.appendChild(partialBtn);
        }

        // If no valid targets at all, allow closing
        if (validPerms.length === 0) {
          const closeBtn = document.createElement('button');
          closeBtn.className = 'p8-btn-cancel';
          closeBtn.textContent = 'Continue';
          closeBtn.addEventListener('click', () => {
            overlay.remove();
            resolve([]);
          });
          content.appendChild(closeBtn);
        }
      };

      renderPicker();

      overlay.appendChild(content);
      overlay.addEventListener('click', (e) => {
        // Do not allow dismiss — player must sacrifice
      });
      document.body.appendChild(overlay);
    });
  }

  // ==================== Library Search / Tutor UI ====================

  /**
   * Show a library search modal for tutor effects.
   * Player can browse their library (filtered by type), search by name,
   * and select up to `count` cards.
   * Returns array of selected card IDs (empty if cancelled).
   */
  private showLibrarySearch(filter: string, count: number, destination: string): Promise<string[]> {
    this.injectPhase8Styles();
    const state = this.game.getState();
    const library = state.players[this.humanPlayer].library;

    // Filter library by type
    const filtered = filter
      ? library.filter(c => c.typeLine.toLowerCase().includes(filter.toLowerCase()))
      : [...library];

    // Sort by CMC then name
    const sorted = [...filtered].sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name));

    return new Promise<string[]>((resolve) => {
      document.getElementById('search-lib-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'search-lib-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';
      content.style.maxWidth = '500px';

      // Header
      const title = document.createElement('h3');
      title.textContent = 'Search Your Library';
      content.appendChild(title);

      const subtitle = document.createElement('p');
      const destLabel = destination === 'hand' ? 'to your hand'
        : destination === 'battlefield' ? 'onto the battlefield'
        : 'on top of your library';
      const filterLabel = filter ? `for ${/^[aeiou]/i.test(filter) ? 'an' : 'a'} ${filter} card` : '';
      subtitle.textContent = `Search ${filterLabel} and put it ${destLabel}.`;
      content.appendChild(subtitle);

      // Text search input
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.className = 'search-lib-search-box';
      searchInput.placeholder = 'Type to filter by name...';
      content.appendChild(searchInput);

      // Counter
      const counter = document.createElement('div');
      counter.className = 'search-lib-counter';
      content.appendChild(counter);

      // Scrollable card list
      const listContainer = document.createElement('div');
      listContainer.className = 'search-lib-list';
      content.appendChild(listContainer);

      // Confirm / Cancel buttons
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'p8-btn-primary';
      confirmBtn.textContent = 'Confirm Selection';
      confirmBtn.disabled = true;
      content.appendChild(confirmBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'p8-btn-cancel';
      cancelBtn.textContent = 'Fail to Find';
      content.appendChild(cancelBtn);

      const selectedIds = new Set<string>();

      const updateCounter = () => {
        const ready = selectedIds.size === count;
        counter.innerHTML = `Selected: <span class="${ready ? 'count-ready' : 'count-current'}">${selectedIds.size}</span> / ${count}`;
        confirmBtn.disabled = selectedIds.size !== count;
      };

      const renderList = (query: string) => {
        listContainer.innerHTML = '';
        const q = query.toLowerCase().trim();
        const visible = q
          ? sorted.filter(c => c.name.toLowerCase().includes(q))
          : sorted;

        if (visible.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'search-lib-empty';
          empty.textContent = q ? 'No cards match your search.' : 'No matching cards in library.';
          listContainer.appendChild(empty);
          return;
        }

        for (const card of visible) {
          const row = document.createElement('div');
          row.className = 'search-lib-card-row';
          if (selectedIds.has(card.id)) row.classList.add('selected');

          const info = document.createElement('div');
          info.className = 'search-lib-card-info';

          const nameEl = document.createElement('div');
          nameEl.className = 'search-lib-card-name';
          nameEl.textContent = card.name;
          info.appendChild(nameEl);

          const typeEl = document.createElement('div');
          typeEl.className = 'search-lib-card-type';
          typeEl.textContent = card.typeLine;
          info.appendChild(typeEl);

          row.appendChild(info);

          if (card.manaCost) {
            const costEl = document.createElement('span');
            costEl.className = 'search-lib-card-cost';
            costEl.textContent = card.manaCost;
            row.appendChild(costEl);
          }

          const cmcBadge = document.createElement('span');
          cmcBadge.className = 'search-lib-cmc-badge';
          cmcBadge.textContent = String(card.cmc);
          row.appendChild(cmcBadge);

          row.addEventListener('click', () => {
            if (selectedIds.has(card.id)) {
              selectedIds.delete(card.id);
              row.classList.remove('selected');
            } else if (selectedIds.size < count) {
              selectedIds.add(card.id);
              row.classList.add('selected');
            }
            updateCounter();
          });

          listContainer.appendChild(row);
        }
      };

      searchInput.addEventListener('input', () => {
        renderList(searchInput.value);
      });

      confirmBtn.addEventListener('click', () => {
        if (selectedIds.size === count) {
          overlay.remove();
          resolve(Array.from(selectedIds));
        }
      });

      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve([]);
      });

      // Click outside to cancel
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve([]);
        }
      });

      // Initial render
      updateCounter();
      renderList('');

      overlay.appendChild(content);
      document.body.appendChild(overlay);

      // Focus search input
      requestAnimationFrame(() => searchInput.focus());
    });
  }

  // ==================== Scry UI ====================

  /**
   * Show the scry UI modal.
   * Player can toggle each revealed card to stay on top or go to bottom.
   * Returns { top: string[], bottom: string[] } with card IDs.
   */
  private showScryUI(count: number): Promise<{ top: string[]; bottom: string[] }> {
    this.injectPhase8Styles();
    const state = this.game.getState();
    const library = state.players[this.humanPlayer].library;
    const scryCards = library.slice(0, count);

    return new Promise<{ top: string[]; bottom: string[] }>((resolve) => {
      document.getElementById('scry-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'scry-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';
      content.style.maxWidth = '460px';

      // Header
      const title = document.createElement('h3');
      title.textContent = `Scry ${count}`;
      content.appendChild(title);

      const subtitle = document.createElement('p');
      subtitle.textContent = 'Choose which cards to keep on top or put on the bottom of your library.';
      content.appendChild(subtitle);

      // Track placement per card: default all to top
      const placement: Map<string, 'top' | 'bottom'> = new Map();
      for (const c of scryCards) {
        placement.set(c.id, 'top');
      }

      // Summary
      const summary = document.createElement('div');
      summary.className = 'scry-summary';
      content.appendChild(summary);

      // Card list
      const cardList = document.createElement('div');
      cardList.className = 'scry-card-list';
      content.appendChild(cardList);

      // Confirm button
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'p8-btn-primary';
      confirmBtn.textContent = 'Confirm';
      content.appendChild(confirmBtn);

      const updateSummary = () => {
        let topCount = 0;
        let bottomCount = 0;
        for (const v of placement.values()) {
          if (v === 'top') topCount++;
          else bottomCount++;
        }
        summary.innerHTML = `<span class="scry-top-count">${topCount}</span> on top, <span class="scry-bottom-count">${bottomCount}</span> on bottom`;
      };

      const renderCards = () => {
        cardList.innerHTML = '';
        for (const card of scryCards) {
          const row = document.createElement('div');
          row.className = 'scry-card-row';

          const info = document.createElement('div');
          info.className = 'scry-card-info';

          const nameEl = document.createElement('div');
          nameEl.className = 'scry-card-name';
          nameEl.textContent = card.name;
          info.appendChild(nameEl);

          const typeEl = document.createElement('div');
          typeEl.className = 'scry-card-type';
          typeEl.textContent = card.typeLine;
          info.appendChild(typeEl);

          row.appendChild(info);

          if (card.manaCost) {
            const costEl = document.createElement('span');
            costEl.className = 'scry-card-cost';
            costEl.textContent = card.manaCost;
            row.appendChild(costEl);
          }

          // Toggle buttons
          const toggleGroup = document.createElement('div');
          toggleGroup.className = 'scry-toggle-group';

          const topBtn = document.createElement('button');
          topBtn.className = 'scry-toggle-btn top-btn';
          topBtn.textContent = 'Top';
          if (placement.get(card.id) === 'top') topBtn.classList.add('active');

          const bottomBtn = document.createElement('button');
          bottomBtn.className = 'scry-toggle-btn bottom-btn';
          bottomBtn.textContent = 'Bottom';
          if (placement.get(card.id) === 'bottom') bottomBtn.classList.add('active');

          topBtn.addEventListener('click', () => {
            placement.set(card.id, 'top');
            renderCards();
            updateSummary();
          });

          bottomBtn.addEventListener('click', () => {
            placement.set(card.id, 'bottom');
            renderCards();
            updateSummary();
          });

          toggleGroup.appendChild(topBtn);
          toggleGroup.appendChild(bottomBtn);
          row.appendChild(toggleGroup);

          cardList.appendChild(row);
        }
      };

      confirmBtn.addEventListener('click', () => {
        const top: string[] = [];
        const bottom: string[] = [];
        for (const card of scryCards) {
          if (placement.get(card.id) === 'top') top.push(card.id);
          else bottom.push(card.id);
        }
        overlay.remove();
        resolve({ top, bottom });
      });

      // Initial render
      updateSummary();
      renderCards();

      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
  }

  // ==================== Manual Resolution Panel ====================

  /**
   * Show a panel for manually resolving a card effect that the engine
   * couldn't auto-resolve (Smart Parser fallback).
   */
  private showManualResolutionPanel(state: GameState): void {
    const card = state.manualResolutionCard;
    const controller = state.manualResolutionController!;
    if (!card) return;

    // Remove any existing panel
    document.querySelector('.manual-resolution-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'manual-resolution-overlay';

    overlay.innerHTML = `
      <div class="manual-resolution-panel">
        <h3 class="manual-res-title">\u26A0\uFE0F Manual Resolution</h3>
        <div class="manual-res-card-name">${card.name}</div>
        <div class="manual-res-type">${card.typeLine}</div>
        <div class="manual-res-oracle">${card.oracleText || 'No oracle text'}</div>
        <p class="manual-res-hint">This effect couldn't be auto-resolved. Use the buttons below to apply the effect manually, then click Done.</p>
        <div class="manual-res-actions">
          <button class="manual-res-btn" data-action="draw">\uD83C\uDCCF Draw Cards</button>
          <button class="manual-res-btn" data-action="damage">\u26A1 Deal Damage</button>
          <button class="manual-res-btn" data-action="life">\uD83D\uDC9A Gain Life</button>
          <button class="manual-res-btn" data-action="loselife">\uD83D\uDC80 Lose Life (Opponent)</button>
          <button class="manual-res-btn" data-action="token">\u2728 Create Token</button>
          <button class="manual-res-btn" data-action="counter">\uD83D\uDD22 Add Counter</button>
          <button class="manual-res-btn" data-action="destroy">\uD83D\uDDD1\uFE0F Destroy Permanent</button>
        </div>
        <div class="manual-res-log"></div>
        <button class="manual-res-done">\u2705 Done \u2014 Continue Game</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const logEl = overlay.querySelector('.manual-res-log') as HTMLElement;
    const addLogMsg = (msg: string) => {
      const p = document.createElement('div');
      p.className = 'manual-res-log-entry';
      p.textContent = `\u2713 ${msg}`;
      logEl.appendChild(p);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const getState = () => this.game.getState();
    const setState = (s: GameState) => this.game.setState(s);

    // Draw Cards
    overlay.querySelector('[data-action="draw"]')!.addEventListener('click', () => {
      const n = prompt('How many cards to draw?', '1');
      if (n) {
        const count = parseInt(n) || 1;
        const st = getState();
        const player = st.players[controller];
        const drawn = player.library.slice(0, count);
        const newLib = player.library.slice(count);
        const newHand = [...player.hand, ...drawn];
        const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
        players[controller] = { ...player, library: newLib, hand: newHand };
        setState({ ...st, players });
        addLogMsg(`Drew ${count} card(s)`);
      }
    });

    // Deal Damage
    overlay.querySelector('[data-action="damage"]')!.addEventListener('click', () => {
      const n = prompt('How much damage?', '3');
      const target = prompt('Target? (opponent / self)', 'opponent');
      if (n) {
        const amount = parseInt(n) || 0;
        const st = getState();
        const targetPlayer = target === 'self' ? controller : ((controller === 0 ? 1 : 0) as 0 | 1);
        const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
        players[targetPlayer] = { ...players[targetPlayer], life: players[targetPlayer].life - amount };
        setState({ ...st, players });
        addLogMsg(`Dealt ${amount} damage to ${st.players[targetPlayer].name}`);
      }
    });

    // Gain Life
    overlay.querySelector('[data-action="life"]')!.addEventListener('click', () => {
      const n = prompt('How much life to gain?', '3');
      if (n) {
        const amount = parseInt(n) || 0;
        const st = getState();
        const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
        players[controller] = { ...players[controller], life: players[controller].life + amount };
        setState({ ...st, players });
        addLogMsg(`Gained ${amount} life`);
      }
    });

    // Lose Life (Opponent)
    overlay.querySelector('[data-action="loselife"]')!.addEventListener('click', () => {
      const n = prompt('How much life does opponent lose?', '3');
      if (n) {
        const amount = parseInt(n) || 0;
        const st = getState();
        const opp = (controller === 0 ? 1 : 0) as 0 | 1;
        const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
        players[opp] = { ...players[opp], life: players[opp].life - amount };
        setState({ ...st, players });
        addLogMsg(`Opponent loses ${amount} life`);
      }
    });

    // Create Token
    overlay.querySelector('[data-action="token"]')!.addEventListener('click', () => {
      const name = prompt('Token name?', 'Soldier');
      const pt = prompt('Power/Toughness? (e.g. 1/1)', '1/1');
      if (name && pt) {
        const [pw, th] = pt.split('/').map(Number);
        const st = getState();
        const tokenId = `manual-token-${Date.now()}`;
        const tokenCard = {
          id: tokenId, oracleId: `token_${name.toLowerCase()}`, name,
          manaCost: '', cmc: 0, typeLine: `Token Creature \u2014 ${name}`,
          oracleText: '', power: String(pw || 0), toughness: String(th || 0),
          colors: [] as string[], colorIdentity: [] as string[], rarity: 'common' as const,
          tags: [] as string[], imageUrl: '', owner: controller as 0 | 1,
        };
        const perm = {
          ...tokenCard, card: tokenCard, controller, tapped: false, flipped: false, faceDown: false,
          currentPower: pw || 0, currentToughness: th || 0, basePower: pw || 0, baseToughness: th || 0,
          damage: 0, summoningSick: true, attacking: false, blocking: null,
          abilities: [], counters: {} as Record<string, number>, temporaryPtMods: [],
          temporaryKeywords: [], attachments: [] as string[], x: 0, y: 0,
          enteredBattlefieldTurn: st.turn,
        };
        const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
        players[controller] = { ...players[controller], battlefield: [...players[controller].battlefield, perm as any] };
        setState({ ...st, players });
        addLogMsg(`Created ${pw}/${th} ${name} token`);
      }
    });

    // Add Counter
    overlay.querySelector('[data-action="counter"]')!.addEventListener('click', () => {
      const type = prompt('Counter type? (+1/+1, -1/-1, loyalty)', '+1/+1');
      const n = prompt('How many?', '1');
      if (type && n) {
        const count = parseInt(n) || 1;
        const st = getState();
        const player = st.players[controller];
        const creature = player.battlefield.find(p => p.typeLine?.toLowerCase().includes('creature'));
        if (creature) {
          const updatedBf = player.battlefield.map(p => {
            if (p.id !== creature.id) return p;
            const counters = { ...p.counters, [type]: (p.counters[type] || 0) + count };
            const powerMod = type === '+1/+1' ? count : type === '-1/-1' ? -count : 0;
            return {
              ...p, counters,
              currentPower: (p.currentPower ?? 0) + powerMod,
              currentToughness: (p.currentToughness ?? 0) + powerMod,
            };
          });
          const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
          players[controller] = { ...player, battlefield: updatedBf };
          setState({ ...st, players });
          addLogMsg(`Put ${count} ${type} counter(s) on ${creature.name}`);
        } else {
          addLogMsg('No creature to put counters on');
        }
      }
    });

    // Destroy Permanent
    overlay.querySelector('[data-action="destroy"]')!.addEventListener('click', () => {
      const st = getState();
      const opp = (controller === 0 ? 1 : 0) as 0 | 1;
      const oppPerms = st.players[opp].battlefield;
      if (oppPerms.length === 0) {
        addLogMsg('No opponent permanents to destroy');
        return;
      }
      const names = oppPerms.map((p, i) => `${i}: ${p.name}`).join('\n');
      const choice = prompt(`Choose permanent to destroy:\n${names}`, '0');
      if (choice !== null) {
        const idx = parseInt(choice);
        if (idx >= 0 && idx < oppPerms.length) {
          const perm = oppPerms[idx];
          const updatedBf = oppPerms.filter((_, i) => i !== idx);
          const cardForGy = {
            id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
            cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
            power: perm.power, toughness: perm.toughness, colors: perm.colors,
            colorIdentity: perm.colorIdentity, rarity: perm.rarity, tags: perm.tags,
            imageUrl: perm.imageUrl, owner: perm.owner,
          };
          const players = [...st.players] as [typeof st.players[0], typeof st.players[1]];
          players[opp] = { ...players[opp], battlefield: updatedBf, graveyard: [...players[opp].graveyard, cardForGy as any] };
          setState({ ...st, players });
          addLogMsg(`Destroyed ${perm.name}`);
        }
      }
    });

    // Done button
    overlay.querySelector('.manual-res-done')!.addEventListener('click', () => {
      overlay.remove();
      this.inManualResolution = false;
      const currentState = getState();
      this.game.setState({
        ...currentState,
        needsManualResolution: false,
        manualResolutionCard: undefined,
        manualResolutionController: undefined,
      });
      this.render();
    });
  }

  // ==================== Fix 5: Combat Damage Assignment UI ====================

  /**
   * Show a modal for assigning combat damage from an attacker to multiple blockers.
   * Returns a map of blockerId -> damage amount.
   */
  private showDamageAssignmentModal(
    attackerPerm: Permanent,
    blockerPerms: Permanent[],
    totalDamage: number,
    hasDeathtouch: boolean,
    hasTrample: boolean,
  ): Promise<{ assignments: Record<string, number>; trampleDamage: number } | null> {
    this.injectPhase8Styles();

    return new Promise((resolve) => {
      document.getElementById('damage-assign-modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'damage-assign-modal';
      overlay.className = 'p8-overlay';

      const content = document.createElement('div');
      content.className = 'p8-content';
      content.style.maxWidth = '480px';

      const assignments: Record<string, number> = {};
      // Initialize: assign lethal to each blocker in order
      let remaining = totalDamage;
      for (const blocker of blockerPerms) {
        const lethal = hasDeathtouch ? 1 : Math.max(0, (blocker.currentToughness ?? 1) - (blocker.damage || 0));
        const assign = Math.min(remaining, lethal);
        assignments[blocker.id] = assign;
        remaining -= assign;
      }

      const renderModal = () => {
        const totalAssigned = Object.values(assignments).reduce((a, b) => a + b, 0);
        const leftover = totalDamage - totalAssigned;
        const isValid = leftover === 0 || (hasTrample && leftover >= 0);

        content.innerHTML = `
          <h3>Assign Combat Damage</h3>
          <p style="color:#e2e8f0 !important;font-size:15px;font-weight:500;">${attackerPerm.name} <span style="color:#c9a84c">(Power: ${totalDamage})</span></p>
          <div class="damage-assign-blockers" id="damage-blocker-list"></div>
          ${hasTrample ? `<div class="damage-remaining ${leftover < 0 ? 'over-assigned' : 'valid'}">Trample damage to player: ${Math.max(0, leftover)}</div>` : ''}
          <div class="damage-remaining ${totalAssigned === totalDamage ? 'valid' : totalAssigned > totalDamage ? 'over-assigned' : ''}">${totalAssigned}/${totalDamage} damage assigned</div>
          <button class="p8-btn-primary" id="damage-confirm-btn" ${(!hasTrample && totalAssigned !== totalDamage) || (hasTrample && totalAssigned > totalDamage) ? 'disabled' : ''}>Assign Damage</button>
          <button class="p8-btn-cancel" id="damage-cancel-btn">Auto-Assign</button>
        `;

        const list = content.querySelector('#damage-blocker-list')!;
        for (const blocker of blockerPerms) {
          const lethal = hasDeathtouch ? 1 : Math.max(0, (blocker.currentToughness ?? 1) - (blocker.damage || 0));
          const blockerEl = document.createElement('div');
          blockerEl.className = 'damage-blocker';
          blockerEl.innerHTML = `
            <div class="damage-blocker-info">
              <div class="damage-blocker-name">${blocker.name}</div>
              <div class="damage-blocker-stats">${blocker.currentPower ?? 0}/${blocker.currentToughness ?? 0} (lethal: ${lethal})</div>
            </div>
          `;

          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'damage-input';
          input.min = '0';
          input.max = String(totalDamage);
          input.value = String(assignments[blocker.id] || 0);
          input.addEventListener('input', () => {
            assignments[blocker.id] = Math.max(0, parseInt(input.value, 10) || 0);
            renderModal();
          });

          blockerEl.appendChild(input);
          list.appendChild(blockerEl);
        }

        content.querySelector('#damage-confirm-btn')?.addEventListener('click', () => {
          const totalAssignedFinal = Object.values(assignments).reduce((a, b) => a + b, 0);
          const trampleDmg = hasTrample ? Math.max(0, totalDamage - totalAssignedFinal) : 0;
          overlay.remove();
          resolve({ assignments, trampleDamage: trampleDmg });
        });

        content.querySelector('#damage-cancel-btn')?.addEventListener('click', () => {
          overlay.remove();
          resolve(null); // null = auto-assign
        });
      };

      renderModal();

      overlay.appendChild(content);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(null); }
      });
      document.body.appendChild(overlay);
    });
  }

  // ==================== Planeswalker Loyalty UI ====================

  /** Show modal for activating planeswalker loyalty abilities */
  private showPlaneswalkerAbilities(perm: Permanent): void {
    this.injectPhase8Styles();
    this.injectWave1Styles();

    // Remove any existing modal
    document.getElementById('planeswalker-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'planeswalker-modal';
    overlay.className = 'p8-overlay';

    const content = document.createElement('div');
    content.className = 'p8-content';
    content.style.maxWidth = '460px';

    const currentLoyalty = perm.currentLoyalty ?? (perm.loyalty ? parseInt(perm.loyalty, 10) : 0);

    // Title with loyalty display
    const title = document.createElement('h3');
    title.textContent = perm.name;
    content.appendChild(title);

    const loyaltyDisplay = document.createElement('div');
    loyaltyDisplay.className = 'pw-loyalty-display';
    loyaltyDisplay.innerHTML = `<span class="pw-loyalty-icon">&#x2666;</span> Loyalty: <strong>${currentLoyalty}</strong>`;
    content.appendChild(loyaltyDisplay);

    // Parse loyalty abilities from oracle text
    const oracleText = perm.oracleText ?? '';
    const abilities = this.parseLoyaltyAbilities(oracleText);

    if (abilities.length === 0) {
      const noAbilities = document.createElement('p');
      noAbilities.textContent = 'No loyalty abilities found.';
      noAbilities.style.cssText = 'text-align:center;color:#94a3b8;padding:12px 0;';
      content.appendChild(noAbilities);
    } else {
      const abilityList = document.createElement('div');
      abilityList.className = 'pw-ability-list';

      for (let i = 0; i < abilities.length; i++) {
        const ab = abilities[i];
        const costNum = ab.cost; // numeric cost (e.g., +1, -3, 0)
        const canActivate = costNum >= 0 || (currentLoyalty + costNum >= 0);

        const btn = document.createElement('button');
        btn.className = 'pw-ability-btn';
        btn.disabled = !canActivate;

        // Cost badge — color-coded
        const costBadge = document.createElement('span');
        costBadge.className = `pw-cost-badge ${costNum > 0 ? 'positive' : costNum < 0 ? 'negative' : 'neutral'}`;
        costBadge.textContent = costNum > 0 ? `+${costNum}` : String(costNum);

        // Effect text
        const effectSpan = document.createElement('span');
        effectSpan.className = 'pw-effect-text';
        effectSpan.textContent = ab.text;

        btn.appendChild(costBadge);
        btn.appendChild(effectSpan);

        if (canActivate) {
          btn.addEventListener('click', () => {
            overlay.remove();
            this.activateLoyaltyAbility(perm, i, costNum, ab.text);
          });
        }

        abilityList.appendChild(btn);
      }

      content.appendChild(abilityList);
    }

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p8-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());
    content.appendChild(cancelBtn);

    overlay.appendChild(content);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /** Parse loyalty abilities from oracle text. Returns array of { cost, text } */
  private parseLoyaltyAbilities(oracleText: string): { cost: number; text: string }[] {
    const results: { cost: number; text: string }[] = [];
    // Match patterns like "+1: Draw a card", "\u22123: Destroy target creature", "0: Create a token"
    // Unicode minus (U+2212) and regular hyphen both supported
    const regex = /([+\u2212\-]\d+|0):\s*(.+?)(?=\n[+\u2212\-]\d+:|\n0:|\s*$)/gs;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(oracleText)) !== null) {
      const costStr = match[1].replace('\u2212', '-');
      const cost = parseInt(costStr, 10);
      const text = match[2].trim();
      if (text.length > 0) {
        results.push({ cost, text });
      }
    }
    return results;
  }

  /** Activate a planeswalker loyalty ability */
  private activateLoyaltyAbility(perm: Permanent, abilityIndex: number, loyaltyCost: number, effectText: string): void {
    const state = this.game.getState();
    const currentLoyalty = perm.currentLoyalty ?? (perm.loyalty ? parseInt(perm.loyalty, 10) : 0);
    const newLoyalty = currentLoyalty + loyaltyCost;

    // Update permanent state: adjust loyalty and mark as used this turn
    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    const ps = players[this.humanPlayer];
    const newBf = ps.battlefield.map(p =>
      p.id === perm.id
        ? { ...p, currentLoyalty: newLoyalty, loyaltyUsedThisTurn: true }
        : p
    );
    players[this.humanPlayer] = { ...ps, battlefield: newBf };

    // Add to the game log
    const logEntry = {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player: this.humanPlayer as 0 | 1,
      message: `${perm.name} [${loyaltyCost > 0 ? '+' : ''}${loyaltyCost}]: ${effectText}`,
      cardName: perm.name,
      actionType: 'ability' as const,
    };
    const updatedState = { ...state, players, log: [...state.log, logEntry] };
    this.game.setState(updatedState);

    logMessage(`<span style="color:var(--gold)">${perm.name} [${loyaltyCost > 0 ? '+' : ''}${loyaltyCost}]: ${effectText}</span>`);

    // Submit the loyalty activation action
    this.submitAction({
      type: 'activate-loyalty',
      player: this.humanPlayer,
      permanentId: perm.id,
      abilityIndex,
      targets: [],
    });
  }

  // ==================== Exile Zone Browser ====================

  /** Show a browseable modal of all exiled cards for both players */
  private showExileBrowser(): void {
    this.injectPhase8Styles();
    this.injectWave1Styles();

    const state = this.game.getState();

    // Remove any existing modal
    document.getElementById('exile-browser-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'exile-browser-modal';
    overlay.className = 'p8-overlay';

    const content = document.createElement('div');
    content.className = 'p8-content';
    content.style.maxWidth = '500px';

    content.innerHTML = `<h3>Exile Zone</h3>`;

    const browser = document.createElement('div');
    browser.className = 'exile-browser';

    const me = state.players[this.humanPlayer];
    const opp = state.players[this.humanPlayer === 0 ? 1 : 0];

    // Your exile section
    const yourSection = document.createElement('div');
    yourSection.className = 'exile-section';
    const yourHeader = document.createElement('div');
    yourHeader.className = 'exile-section-header';
    yourHeader.textContent = `Your Exile (${me.exile.length})`;
    yourSection.appendChild(yourHeader);

    if (me.exile.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'exile-empty';
      empty.textContent = 'No cards in exile';
      yourSection.appendChild(empty);
    } else {
      for (const card of me.exile) {
        yourSection.appendChild(this.createExileCardRow(card));
      }
    }
    browser.appendChild(yourSection);

    // Opponent exile section
    const oppSection = document.createElement('div');
    oppSection.className = 'exile-section';
    const oppHeader = document.createElement('div');
    oppHeader.className = 'exile-section-header';
    oppHeader.textContent = `Opponent's Exile (${opp.exile.length})`;
    oppSection.appendChild(oppHeader);

    if (opp.exile.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'exile-empty';
      empty.textContent = 'No cards in exile';
      oppSection.appendChild(empty);
    } else {
      for (const card of opp.exile) {
        oppSection.appendChild(this.createExileCardRow(card));
      }
    }
    browser.appendChild(oppSection);

    content.appendChild(browser);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'p8-btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '12px';
    closeBtn.addEventListener('click', () => overlay.remove());
    content.appendChild(closeBtn);

    overlay.appendChild(content);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /** Show graveyard viewer for a player */
  private showGraveyardViewer(player: 0 | 1): void {
    this.injectPhase8Styles();
    const state = this.game.getState();
    document.getElementById('gy-viewer-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'gy-viewer-modal';
    overlay.className = 'p8-overlay';

    const content = document.createElement('div');
    content.className = 'p8-content';
    content.style.maxWidth = '500px';

    const isYou = player === this.humanPlayer;
    const ps = state.players[player];
    content.innerHTML = `<h3>${isYou ? 'Your' : "Bot's"} Graveyard (${ps.graveyard.length})</h3>`;

    const browser = document.createElement('div');
    browser.style.maxHeight = '400px';
    browser.style.overflowY = 'auto';

    if (ps.graveyard.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:#666;padding:20px;';
      empty.textContent = 'Graveyard is empty';
      browser.appendChild(empty);
    } else {
      for (const card of ps.graveyard) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #1a1f2e;';
        const name = document.createElement('span');
        name.style.cssText = 'color:#e5e7eb;font-size:14px;';
        name.textContent = card.name;
        const type = document.createElement('span');
        type.style.cssText = 'color:#6b7280;font-size:11px;';
        type.textContent = card.typeLine;
        row.appendChild(name);
        row.appendChild(type);

        // Flashback badge
        if (card.oracleText?.match(/flashback/i)) {
          const badge = document.createElement('span');
          badge.style.cssText = 'color:#c9a84c;font-size:10px;margin-left:8px;padding:2px 6px;border:1px solid #c9a84c;border-radius:50px;';
          badge.textContent = 'Flashback';
          row.appendChild(badge);
        }
        // Escape badge
        if (card.oracleText?.match(/escape/i)) {
          const badge = document.createElement('span');
          badge.style.cssText = 'color:#34d399;font-size:10px;margin-left:8px;padding:2px 6px;border:1px solid #34d399;border-radius:50px;';
          badge.textContent = 'Escape';
          row.appendChild(badge);
        }
        // Jump-start badge
        if (card.oracleText?.match(/jump-start/i)) {
          const badge = document.createElement('span');
          badge.style.cssText = 'color:#60a5fa;font-size:10px;margin-left:8px;padding:2px 6px;border:1px solid #60a5fa;border-radius:50px;';
          badge.textContent = 'Jump-start';
          row.appendChild(badge);
        }
        browser.appendChild(row);
      }
    }
    content.appendChild(browser);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'p8-btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '12px';
    closeBtn.addEventListener('click', () => overlay.remove());
    content.appendChild(closeBtn);

    overlay.appendChild(content);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  /** Create a card row element for the exile browser */
  private createExileCardRow(card: Card): HTMLElement {
    const row = document.createElement('div');
    row.className = 'exile-card-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'exile-card-name';
    nameSpan.textContent = card.name;
    row.appendChild(nameSpan);

    // Special exile badges
    if (card.onAdventure) {
      const badge = document.createElement('span');
      badge.className = 'exile-badge adventure';
      badge.textContent = 'Adventure';
      row.appendChild(badge);
    }
    if (card.madnessExile) {
      const badge = document.createElement('span');
      badge.className = 'exile-badge madness';
      badge.textContent = 'Madness';
      row.appendChild(badge);
    }
    if (card.reboundExile) {
      const badge = document.createElement('span');
      badge.className = 'exile-badge rebound';
      badge.textContent = 'Rebound';
      row.appendChild(badge);
    }

    const typeSpan = document.createElement('span');
    typeSpan.className = 'exile-card-type';
    typeSpan.textContent = card.typeLine;
    row.appendChild(typeSpan);

    return row;
  }

  // ==================== Equipment/Aura Attach UI ====================

  /** Handle equip ability from ability picker -- enter targeting mode for creature */
  private handleEquipAbility(equipmentPerm: Permanent, equipCost: string): void {
    const state = this.game.getState();

    // Try to auto-pay the equip cost
    const cost = parseManaCost(equipCost);
    const me = state.players[this.humanPlayer];
    const tapResult = autoTapLandsForCost(me, cost);

    if (!tapResult) {
      logMessage('<span style="color:var(--warning)">Cannot pay equip cost</span>');
      return;
    }

    // Pay the cost
    const updatedState = {
      ...state,
      players: state.players.map((p, i) =>
        i === this.humanPlayer ? tapResult.updatedPlayer : p,
      ) as [typeof state.players[0], typeof state.players[1]],
    };
    this.game.setState(updatedState);

    // Enter targeting mode for "creature you control"
    const dummyCard: Card = {
      id: `equip-target-${equipmentPerm.id}`,
      oracleId: '',
      name: `Equip ${equipmentPerm.name}`,
      manaCost: '',
      cmc: 0,
      typeLine: '',
      oracleText: 'target creature you control',
      colors: [],
      colorIdentity: [],
      rarity: 'common',
      tags: [],
      imageUrl: '',
      owner: this.humanPlayer,
    };

    this.injectPhase8Styles();

    this.targetingMode = true;
    this.targetingCard = dummyCard;

    this.targetingState = {
      card: dummyCard,
      requiredTargets: 1,
      collectedTargets: [],
      filter: { cardType: 'creature', controller: 'you' } as TargetFilter,
      zone: 'battlefield',
      onComplete: (targets) => {
        if (targets.length > 0 && targets[0].type === 'permanent') {
          this.submitAction({
            type: 'equip',
            player: this.humanPlayer,
            equipmentId: equipmentPerm.id,
            targetCreatureId: targets[0].id,
          });
        }
      },
      onCancel: () => {
        // Refund mana -- restore state
        this.game.setState(state);
        this.render();
      },
    };

    this.render();
    this.showTargetingBanner();
  }

  // ==================== Wave 1 Styles ====================

  private static wave1StylesInjected = false;
  private injectWave1Styles(): void {
    if (GameLoop.wave1StylesInjected) return;
    GameLoop.wave1StylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      /* ─── Planeswalker Loyalty Badge (Battlefield) ─── */
      .loyalty-badge {
        position: absolute;
        bottom: 4px;
        right: 4px;
        background: linear-gradient(135deg, #1a1f2e 0%, #2a2f3e 100%);
        border: 2px solid #c9a84c;
        color: #c9a84c;
        font-family: 'Cinzel', serif;
        font-size: 14px;
        font-weight: 700;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        z-index: 5;
        box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      }

      /* ─── Planeswalker Abilities Modal ─── */
      .pw-loyalty-display {
        text-align: center;
        font-size: 15px;
        color: #94a3b8;
        margin-bottom: 16px;
        padding: 8px;
        background: rgba(201,168,76,0.08);
        border-radius: 10px;
      }
      .pw-loyalty-display strong {
        color: #c9a84c;
        font-family: 'Cinzel', serif;
        font-size: 20px;
      }
      .pw-loyalty-icon {
        color: #c9a84c;
        margin-right: 6px;
      }
      .pw-ability-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin: 12px 0;
      }
      .pw-ability-btn {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        width: 100%;
        padding: 12px 14px;
        background: var(--obsidian, #1a1f2e);
        border: 1px solid var(--border, #2d3748);
        border-radius: 10px;
        color: var(--text, #e2e8f0);
        cursor: pointer;
        text-align: left;
        font-family: 'Outfit', sans-serif;
        font-size: 14px;
        transition: border-color 0.2s, background 0.2s;
      }
      .pw-ability-btn:not(:disabled):hover {
        border-color: var(--gold, #c9a84c);
        background: rgba(201,168,76,0.08);
      }
      .pw-ability-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .pw-cost-badge {
        flex-shrink: 0;
        width: 38px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 14px;
        font-weight: 700;
      }
      .pw-cost-badge.positive {
        background: rgba(52, 211, 153, 0.15);
        color: #34d399;
        border: 1px solid rgba(52, 211, 153, 0.3);
      }
      .pw-cost-badge.negative {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
        border: 1px solid rgba(239, 68, 68, 0.3);
      }
      .pw-cost-badge.neutral {
        background: rgba(148, 163, 184, 0.15);
        color: #94a3b8;
        border: 1px solid rgba(148, 163, 184, 0.3);
      }
      .pw-effect-text {
        flex: 1;
        line-height: 1.4;
      }

      /* ─── Exile Browser ─── */
      .exile-browser {
        max-height: 380px;
        overflow-y: auto;
        margin: 12px 0;
        scrollbar-width: thin;
        scrollbar-color: #c9a84c #1a1f2e;
      }
      .exile-section {
        margin-bottom: 16px;
      }
      .exile-section-header {
        font-family: 'Cinzel', serif;
        font-size: 14px;
        font-weight: 600;
        color: #c9a84c;
        padding: 6px 0;
        border-bottom: 1px solid rgba(201,168,76,0.2);
        margin-bottom: 8px;
      }
      .exile-empty {
        text-align: center;
        color: #64748b;
        font-size: 13px;
        padding: 12px 0;
        font-style: italic;
      }
      .exile-card-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 10px;
        margin: 4px 0;
        background: rgba(148,163,184,0.05);
        border: 1px solid rgba(148,163,184,0.1);
        transition: background 0.2s;
      }
      .exile-card-row:hover {
        background: rgba(148,163,184,0.12);
      }
      .exile-card-name {
        color: #e2e8f0;
        font-weight: 500;
        flex: 1;
      }
      .exile-card-type {
        color: #94a3b8;
        font-size: 12px;
        text-align: right;
      }
      .exile-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 50px;
        flex-shrink: 0;
      }
      .exile-badge.adventure {
        background: rgba(52, 211, 153, 0.15);
        color: #34d399;
        border: 1px solid rgba(52, 211, 153, 0.3);
      }
      .exile-badge.madness {
        background: rgba(168, 85, 247, 0.15);
        color: #a855f7;
        border: 1px solid rgba(168, 85, 247, 0.3);
      }
      .exile-badge.rebound {
        background: rgba(59, 130, 246, 0.15);
        color: #3b82f6;
        border: 1px solid rgba(59, 130, 246, 0.3);
      }

      /* ─── Equipment/Aura Attachment Badges (Battlefield) ─── */
      .attached-badge {
        position: absolute;
        top: 4px;
        left: 4px;
        font-size: 12px;
        z-index: 5;
        filter: grayscale(0.3);
      }
      .equipped-badge {
        position: absolute;
        top: 4px;
        right: 4px;
        background: linear-gradient(135deg, #c9a84c, #e8d48b);
        color: #0a0e17;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 50px;
        z-index: 5;
      }
    `;
    document.head.appendChild(style);
  }

  // ==================== AI Coach System ====================

  /** Inject the coach toggle UI into the game board */
  private injectCoachUI(): void {
    // Don't duplicate
    if (document.getElementById('coach-toggle-container')) return;

    const container = document.createElement('div');
    container.id = 'coach-toggle-container';
    container.innerHTML = `
      <label class="coach-toggle" title="AI Coach: Get real-time gameplay tips">
        <input type="checkbox" id="coach-toggle-checkbox" />
        <span class="coach-toggle-label">🤖 Coach</span>
      </label>
      <button class="pvb-btn coach-suggest-btn" id="btn-suggest-plays" title="Get AI suggested plays">
        💡 Suggest
      </button>
    `;

    // Insert near the game controls
    const gameControls = document.getElementById('game-controls') || document.getElementById('game-container');
    if (gameControls) {
      gameControls.appendChild(container);
    }

    // Coach toggle
    const checkbox = document.getElementById('coach-toggle-checkbox') as HTMLInputElement;
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        this.coachEnabled = checkbox.checked;
        if (!this.coachEnabled) this.hideCoachTips();
        else this.render();
      });
    }

    // Suggest plays button
    const suggestBtn = document.getElementById('btn-suggest-plays');
    if (suggestBtn) {
      suggestBtn.addEventListener('click', () => this.showSuggestedPlays());
    }

    // Inject coach styles
    this.injectCoachStyles();
  }

  /** Render coach tips as floating bubbles */
  private renderCoachTips(): void {
    let tipContainer = document.getElementById('coach-tips');
    if (!tipContainer) {
      tipContainer = document.createElement('div');
      tipContainer.id = 'coach-tips';
      document.getElementById('game-container')?.appendChild(tipContainer);
    }

    if (this.coachTips.length === 0) {
      tipContainer.innerHTML = '';
      return;
    }

    tipContainer.innerHTML = this.coachTips.map(tip => {
      const severityClass = `coach-tip-${tip.severity}`;
      return `
        <div class="coach-tip ${severityClass}">
          <span class="coach-tip-icon">${tip.icon}</span>
          <span class="coach-tip-text">${tip.message}</span>
        </div>
      `;
    }).join('');
  }

  /** Hide coach tip bubbles */
  private hideCoachTips(): void {
    const tipContainer = document.getElementById('coach-tips');
    if (tipContainer) tipContainer.innerHTML = '';
  }

  /** Show suggested plays overlay (triggered by button or inactivity) */
  private showSuggestedPlays(): void {
    const state = this.game.getState();
    if (state.priorityPlayer !== this.humanPlayer || state.gameOver) return;

    const suggestions = getSuggestedPlays(state, this.humanPlayer);
    if (suggestions.length === 0) return;

    let suggestEl = document.getElementById('suggest-plays-overlay');
    if (!suggestEl) {
      suggestEl = document.createElement('div');
      suggestEl.id = 'suggest-plays-overlay';
      document.getElementById('game-container')?.appendChild(suggestEl);
    }

    suggestEl.innerHTML = `
      <div class="suggest-plays-panel">
        <div class="suggest-plays-header">
          <span>💡 Suggested Plays</span>
          <button class="suggest-plays-close" onclick="document.getElementById('suggest-plays-overlay').innerHTML=''">✕</button>
        </div>
        ${suggestions.map((s, i) => `
          <div class="suggest-play-item suggest-play-${s.severity}">
            <span class="suggest-play-num">${i + 1}.</span>
            <span class="suggest-play-text">${s.message}</span>
          </div>
        `).join('')}
      </div>
    `;

    // Auto-hide after 10 seconds
    setTimeout(() => {
      if (suggestEl) suggestEl.innerHTML = '';
    }, 10000);
  }

  /** Reset the suggest timer (show suggestions after 8s inactivity) */
  private resetSuggestTimer(): void {
    if (this.suggestTimer) clearTimeout(this.suggestTimer);
    this.lastSuggestTime = Date.now();

    const state = this.game.getState();
    if (state.priorityPlayer !== this.humanPlayer || state.gameOver) return;

    this.suggestTimer = setTimeout(() => {
      // Only show if still human's priority and coach is enabled
      const current = this.game.getState();
      if (current.priorityPlayer === this.humanPlayer && !current.gameOver && this.coachEnabled) {
        // Show subtle "Need help?" link
        let helpEl = document.getElementById('need-help-link');
        if (!helpEl) {
          helpEl = document.createElement('div');
          helpEl.id = 'need-help-link';
          helpEl.className = 'need-help-link';
          helpEl.innerHTML = '<span class="need-help-text">Need help? 💡</span>';
          helpEl.addEventListener('click', () => {
            this.showSuggestedPlays();
            helpEl!.remove();
          });
          document.getElementById('game-container')?.appendChild(helpEl);
        }
      }
    }, 8000);
  }

  // ==================== Power Meter ====================

  /** Render the live power level meter */
  private renderPowerMeter(state: GameState): void {
    let meterEl = document.getElementById('power-meter');
    if (!meterEl) {
      meterEl = document.createElement('div');
      meterEl.id = 'power-meter';
      meterEl.innerHTML = `
        <div class="power-meter-bar">
          <div class="power-meter-fill" id="power-meter-fill"></div>
          <div class="power-meter-center"></div>
        </div>
        <div class="power-meter-labels">
          <span class="power-meter-label-bot">Bot</span>
          <span class="power-meter-label-you">You</span>
        </div>
      `;
      // Insert at top of game container
      const gameContainer = document.getElementById('game-container');
      if (gameContainer) {
        gameContainer.insertBefore(meterEl, gameContainer.firstChild);
      }
    }

    // Calculate advantage (-20 to +20 range, clamped)
    const advantage = evaluateBoardPosition(state, this.humanPlayer);
    const clamped = Math.max(-20, Math.min(20, advantage));
    const percent = ((clamped + 20) / 40) * 100; // 0% = bot dominates, 100% = human dominates

    const fill = document.getElementById('power-meter-fill');
    if (fill) {
      fill.style.width = `${percent}%`;
      // Color: red → yellow → green
      if (percent < 35) {
        fill.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
      } else if (percent < 65) {
        fill.style.background = 'linear-gradient(90deg, #f97316, #eab308)';
      } else {
        fill.style.background = 'linear-gradient(90deg, #eab308, #34d399)';
      }
    }
  }

  // ==================== Coach Styles ====================

  private static coachStylesInjected = false;
  private injectCoachStyles(): void {
    if (GameLoop.coachStylesInjected) return;
    GameLoop.coachStylesInjected = true;

    const style = document.createElement('style');
    style.textContent = `
      /* ─── Coach Toggle ─── */
      #coach-toggle-container {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 6px 0;
      }
      .coach-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        color: var(--text, #e2e8f0);
      }
      .coach-toggle input[type="checkbox"] {
        width: 16px; height: 16px;
        accent-color: #c9a84c;
        cursor: pointer;
      }
      .coach-suggest-btn {
        font-size: 12px !important;
        padding: 4px 10px !important;
        background: rgba(201, 168, 76, 0.1) !important;
        border: 1px solid rgba(201, 168, 76, 0.3) !important;
        color: #c9a84c !important;
      }
      .coach-suggest-btn:hover {
        background: rgba(201, 168, 76, 0.2) !important;
      }

      /* ─── Coach Tips ─── */
      #coach-tips {
        position: fixed;
        bottom: 200px;
        right: 16px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        z-index: 100;
        max-width: 360px;
        pointer-events: none;
      }
      .coach-tip {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 10px;
        font-family: 'Outfit', sans-serif;
        font-size: 12px;
        line-height: 1.4;
        backdrop-filter: blur(12px);
        animation: coachTipSlideIn 0.3s ease-out;
        pointer-events: auto;
      }
      @keyframes coachTipSlideIn {
        from { opacity: 0; transform: translateX(20px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .coach-tip-info {
        background: rgba(59, 130, 246, 0.15);
        border: 1px solid rgba(59, 130, 246, 0.3);
        color: #93c5fd;
      }
      .coach-tip-suggestion {
        background: rgba(201, 168, 76, 0.15);
        border: 1px solid rgba(201, 168, 76, 0.3);
        color: #e8d48b;
      }
      .coach-tip-warning {
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #fca5a5;
      }
      .coach-tip-icon { font-size: 16px; flex-shrink: 0; }
      .coach-tip-text { flex: 1; }

      /* ─── Suggested Plays ─── */
      #suggest-plays-overlay {
        position: fixed;
        bottom: 200px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 150;
      }
      .suggest-plays-panel {
        background: rgba(15, 22, 35, 0.95);
        border: 1px solid rgba(201, 168, 76, 0.4);
        border-radius: 12px;
        padding: 12px 16px;
        min-width: 380px;
        max-width: 500px;
        backdrop-filter: blur(16px);
        animation: suggestFadeIn 0.3s ease-out;
      }
      @keyframes suggestFadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .suggest-plays-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-family: 'Cinzel', serif;
        font-size: 14px;
        color: #c9a84c;
        margin-bottom: 8px;
      }
      .suggest-plays-close {
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        padding: 2px 6px;
      }
      .suggest-play-item {
        display: flex;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 8px;
        margin: 4px 0;
        font-family: 'Outfit', sans-serif;
        font-size: 12px;
        line-height: 1.4;
      }
      .suggest-play-suggestion { background: rgba(201, 168, 76, 0.1); color: #e8d48b; }
      .suggest-play-info { background: rgba(59, 130, 246, 0.1); color: #93c5fd; }
      .suggest-play-warning { background: rgba(239, 68, 68, 0.1); color: #fca5a5; }
      .suggest-play-num { font-weight: 700; color: #c9a84c; }

      /* ─── Need Help Link ─── */
      .need-help-link {
        position: fixed;
        bottom: 170px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 90;
        cursor: pointer;
        animation: needHelpPulse 2s ease-in-out infinite;
      }
      @keyframes needHelpPulse {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }
      .need-help-text {
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        color: #c9a84c;
        background: rgba(201, 168, 76, 0.1);
        border: 1px solid rgba(201, 168, 76, 0.25);
        border-radius: 50px;
        padding: 6px 16px;
        backdrop-filter: blur(8px);
      }

      /* ─── Power Meter ─── */
      #power-meter {
        padding: 4px 16px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .power-meter-bar {
        position: relative;
        height: 6px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 3px;
        overflow: hidden;
      }
      .power-meter-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.6s ease, background 0.6s ease;
        width: 50%;
        background: linear-gradient(90deg, #f97316, #eab308);
      }
      .power-meter-center {
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 2px;
        height: 100%;
        background: rgba(255, 255, 255, 0.3);
      }
      .power-meter-labels {
        display: flex;
        justify-content: space-between;
        font-family: 'JetBrains Mono', monospace;
        font-size: 9px;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 1px;
      }

      /* ─── Mulligan AI Advisor ─── */
      .mulligan-advisor {
        background: rgba(59, 130, 246, 0.1) !important;
        border: 1px solid rgba(59, 130, 246, 0.3) !important;
        color: #93c5fd !important;
        font-size: 13px !important;
      }
      .mulligan-advisor:hover {
        background: rgba(59, 130, 246, 0.2) !important;
      }
      .mulligan-advice-bubble {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        background: rgba(15, 22, 35, 0.95);
        border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 12px;
        padding: 12px 16px;
        margin-top: 12px;
        animation: coachTipSlideIn 0.3s ease-out;
      }
      .mulligan-advice-icon { font-size: 24px; }
      .mulligan-advice-text {
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        line-height: 1.5;
        color: #e2e8f0;
      }
      .mulligan-advice-text strong {
        color: #c9a84c;
      }

      /* ─── Game Over Analysis Button ─── */
      .pvb-btn.gold {
        background: linear-gradient(135deg, rgba(201, 168, 76, 0.2), rgba(201, 168, 76, 0.1)) !important;
        border: 1px solid rgba(201, 168, 76, 0.5) !important;
        color: #c9a84c !important;
      }
      .pvb-btn.gold:hover {
        background: linear-gradient(135deg, rgba(201, 168, 76, 0.3), rgba(201, 168, 76, 0.2)) !important;
      }

      /* ─── Analysis Overlay ─── */
      .analysis-overlay {
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(10, 14, 23, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
        animation: suggestFadeIn 0.3s ease-out;
      }
      .analysis-panel {
        background: linear-gradient(135deg, #0f1623, #1a1f2e);
        border: 1px solid rgba(201, 168, 76, 0.3);
        border-radius: 16px;
        padding: 24px;
        max-width: 600px;
        width: 90%;
        max-height: 80vh;
        overflow-y: auto;
        color: #e2e8f0;
      }
      .analysis-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }
      .analysis-header h2 {
        font-family: 'Cinzel', serif;
        font-size: 20px;
        color: #c9a84c;
        margin: 0;
      }
      .analysis-close {
        background: none;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 20px;
        padding: 4px 8px;
      }
      .analysis-score-ring {
        text-align: center;
        margin: 16px 0;
      }
      .analysis-score-value {
        font-family: 'Cinzel', serif;
        font-size: 48px;
        font-weight: 700;
      }
      .analysis-score-label {
        font-family: 'Outfit', sans-serif;
        font-size: 13px;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 2px;
      }
      .analysis-verdict {
        text-align: center;
        font-family: 'Outfit', sans-serif;
        font-size: 14px;
        color: #cbd5e1;
        margin: 12px 0 20px;
        line-height: 1.5;
      }
      .analysis-result {
        text-align: center;
        font-family: 'Cinzel', serif;
        font-size: 16px;
        padding: 8px;
        border-radius: 8px;
        margin-bottom: 16px;
      }
      .analysis-result.win { background: rgba(52, 211, 153, 0.1); color: #34d399; }
      .analysis-result.loss { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
      .analysis-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        margin-bottom: 20px;
      }
      .analysis-stat {
        background: rgba(255, 255, 255, 0.04);
        border-radius: 8px;
        padding: 10px;
        text-align: center;
      }
      .analysis-stat-label {
        display: block;
        font-family: 'Outfit', sans-serif;
        font-size: 10px;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 4px;
      }
      .analysis-stat-value {
        display: block;
        font-family: 'JetBrains Mono', monospace;
        font-size: 18px;
        font-weight: 700;
      }
      .analysis-section-title {
        font-family: 'Cinzel', serif;
        font-size: 14px;
        color: #c9a84c;
        margin: 16px 0 8px;
      }
      .analysis-timeline {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .analysis-moment {
        padding: 8px 12px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.03);
      }
      .analysis-moment-header {
        display: flex;
        justify-content: space-between;
        font-family: 'Outfit', sans-serif;
        font-size: 12px;
        margin-bottom: 4px;
      }
      .analysis-moment-action {
        color: #94a3b8;
        font-size: 11px;
      }
      .analysis-moment-explain {
        font-family: 'Outfit', sans-serif;
        font-size: 11px;
        color: #94a3b8;
        line-height: 1.4;
      }
      .analysis-footer {
        text-align: center;
        margin-top: 20px;
      }

      /* ─── Manual Resolution Panel ─── */
      .manual-resolution-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.8);
        display: flex; align-items: center; justify-content: center; z-index: 9999;
      }
      .manual-resolution-panel {
        background: #0a0e17; border: 2px solid #c9a84c; border-radius: 16px;
        padding: 24px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;
      }
      .manual-res-title {
        font-family: 'Cinzel', serif; color: #c9a84c; margin: 0 0 16px 0; font-size: 20px;
      }
      .manual-res-card-name {
        font-family: 'Cinzel', serif; color: #c9a84c; font-size: 18px; margin-bottom: 4px;
      }
      .manual-res-type { color: #9ca3af; font-size: 13px; margin-bottom: 8px; }
      .manual-res-oracle {
        color: #e5e7eb; font-size: 14px; line-height: 1.5; padding: 12px;
        background: #1a1f2e; border-radius: 8px; margin-bottom: 12px;
        white-space: pre-wrap;
      }
      .manual-res-hint { color: #9ca3af; font-size: 12px; margin-bottom: 16px; }
      .manual-res-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
      .manual-res-btn {
        background: #1a1f2e; border: 1px solid #c9a84c; color: #c9a84c;
        padding: 10px 16px; border-radius: 50px; cursor: pointer; font-size: 13px;
        transition: all 0.2s; font-family: 'Outfit', sans-serif;
      }
      .manual-res-btn:hover { background: #c9a84c; color: #0a0e17; }
      .manual-res-log {
        max-height: 120px; overflow-y: auto; margin-bottom: 16px; padding: 8px;
        background: #0f1623; border-radius: 8px;
      }
      .manual-res-log-entry { color: #34d399; font-size: 12px; padding: 2px 0; }
      .manual-res-done {
        width: 100%; padding: 14px; background: #c9a84c; color: #0a0e17;
        border: none; border-radius: 50px; font-size: 16px; font-weight: 600;
        cursor: pointer; font-family: 'Cinzel', serif; transition: all 0.2s;
      }
      .manual-res-done:hover { background: #d4b55a; }
    `;
    document.head.appendChild(style);
  }

  /** Stop the game loop */
  stop(): void {
    this.running = false;
    if (this.suggestTimer) clearTimeout(this.suggestTimer);
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
