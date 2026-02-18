import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import { executeAction } from './actions.ts';
import { validateAction } from './validation.ts';
import { passPriority } from '../rules/priority.ts';
import { resolveTopOfStack, isStackEmpty } from '../rules/stack.ts';
import { resolveCombatDamage, hasFirstStrikeCombatants, endCombat } from '../rules/combat.ts';
import { checkStateBasedActions, checkCommanderDamageLoss } from '../rules/state-based.ts';
import { trackCommanderDamage, processCommanderZoneReplacements } from '../rules/commander.ts';
import { applyContinuousEffects } from '../rules/continuous.ts';
import { UndoManager } from './undo-manager.ts';

/**
 * The Game class ties together all engine systems:
 * - Action execution
 * - Priority management
 * - Stack resolution
 * - Combat resolution
 * - State-based actions
 * - Commander rules
 * - Undo/Replay
 *
 * This is the main interface for the UI and bots.
 */
export class Game {
  private state: GameState;
  private undoManager: UndoManager;

  constructor(initialState: GameState) {
    this.state = initialState;
    this.undoManager = new UndoManager(100);
  }

  /** Get a read-only copy of the current state */
  getState(): GameState {
    return this.state;
  }

  /** Check if the game is over */
  isOver(): boolean {
    return this.state.gameOver;
  }

  /**
   * Auto-pass for steps where no actions are possible (untap, cleanup).
   * Returns true if auto-pass was performed.
   */
  autoPassIfNeeded(): boolean {
    if (this.state.gameOver) return false;
    if (this.state.mulliganPhase) return false;
    
    // In untap and cleanup, no player actions are possible - auto pass
    // Exception: don't auto-pass cleanup if a player needs to discard
    if (this.state.step === 'untap' || (this.state.step === 'cleanup' && this.state.pendingDiscard == null)) {
      // Keep passing until we leave this step
      let safety = 0;
      while ((this.state.step === 'untap' || (this.state.step === 'cleanup' && this.state.pendingDiscard == null)) && safety < 10) {
        this.submitAction({ type: 'pass', player: this.state.priorityPlayer });
        safety++;
      }
      return true;
    }
    return false;
  }

  /** Get the winner (null if not over) */
  getWinner(): 0 | 1 | null {
    return this.state.winner;
  }

  /**
   * Submit an action from a player.
   *
   * This is the primary entry point for all player actions.
   * Handles the full flow:
   * 1. Validate the action
   * 2. Save undo snapshot
   * 3. Execute the action
   * 4. If pass: run priority/stack resolution logic
   * 5. Run state-based actions
   * 6. Return whether the action was accepted
   */
  submitAction(action: GameAction): boolean {
    if (this.state.gameOver) return false;

    // Validate the action first
    const error = validateAction(this.state, action);
    if (error !== null) return false;

    // Save snapshot before action
    this.undoManager.saveSnapshot(this.state, action);

    if (action.type === 'pass') {
      // Pass goes through priority system
      const beforeStack = this.state.stack.length;
      this.state = passPriority(this.state);

      // Record pass in action history
      this.state = {
        ...this.state,
        actionHistory: [...this.state.actionHistory, action],
      };

      // Check if both players passed and stack needs resolution
      // CRITICAL FIX: Check if bothPlayersPassed is TRUE (not false)
      // The logic was inverted - both players must have passed to resolve
      if (
        this.state.bothPlayersPassed &&
        beforeStack > 0 &&
        this.state.stack.length === beforeStack
      ) {
        // Both passed with stack → resolve top
        this.state = resolveTopOfStack(this.state);
        // Run SBAs after resolution
        this.runStateBasedActions();
      }

      // Check SBAs after phase advancement too
      this.runStateBasedActions();

      return true;
    }

    // Non-pass actions go through executeAction
    const before = this.state;
    this.state = executeAction(this.state, action);

    // If state didn't change, action was rejected
    if (this.state === before) {
      this.undoManager.undo(); // Roll back snapshot
      return false;
    }

    // Run SBAs after action
    this.runStateBasedActions();

    return true;
  }

  /**
   * Resolve combat damage for the current combat.
   * Called by the UI/bot when the combat-damage step is reached.
   */
  resolveCombat(): void {
    if (!this.state.combat || this.state.gameOver) return;

    this.undoManager.saveSnapshot(this.state, { type: 'pass', player: this.state.activePlayer });

    // First strike damage (if applicable)
    if (hasFirstStrikeCombatants(this.state)) {
      const firstStrike = resolveCombatDamage(this.state, true);
      this.state = firstStrike.state;
      this.applyCommanderDamage(firstStrike.commanderDamageDealt);
      this.runStateBasedActions();
    }

    // Normal combat damage
    const normal = resolveCombatDamage(this.state, false);
    this.state = normal.state;
    this.applyCommanderDamage(normal.commanderDamageDealt);
    this.runStateBasedActions();
  }

  /** Clean up after combat phase ends */
  cleanupCombat(): void {
    this.state = endCombat(this.state);
  }

  /**
   * Undo the last action.
   * Returns true if undo was successful.
   */
  undo(): boolean {
    const previousState = this.undoManager.undo();
    if (previousState) {
      this.state = previousState;
      return true;
    }
    return false;
  }

  /** Check if undo is available */
  canUndo(): boolean {
    return this.undoManager.canUndo;
  }

  /** Get replay data for the entire game */
  getReplayData() {
    return this.undoManager.getReplayData();
  }

  /** Get the current priority player */
  getPriorityPlayer(): 0 | 1 {
    return this.state.priorityPlayer;
  }

  /** Get the active (turn) player */
  getActivePlayer(): 0 | 1 {
    return this.state.activePlayer;
  }

  /** Get the game log */
  getLog() {
    return this.state.log;
  }

  /** Get the current turn number */
  getTurn(): number {
    return this.state.turn;
  }

  /** Check if we're in mulligan phase */
  isInMulliganPhase(): boolean {
    return this.state.mulliganPhase;
  }

  /** Exit mulligan phase and start the game */
  endMulliganPhase(): void {
    this.state = {
      ...this.state,
      mulliganPhase: false,
    };
  }

  /** Force set state (for testing or special scenarios) */
  setState(state: GameState): void {
    this.state = state;
  }

  // --- Private helpers ---

  /**
   * Run state-based actions with proper SBA→Trigger cascade (CR 117.5).
   *
   * Per the Comprehensive Rules, whenever a player would receive priority:
   * 1. Check SBAs — execute all simultaneously
   * 2. Check for triggered abilities from SBA results — put on stack
   * 3. If any SBAs were performed OR any triggers were added, repeat from 1
   * 4. Only grant priority once the state is stable (no new SBAs, no new triggers)
   *
   * Death triggers are already fired inside checkStateBasedActions() via
   * checkCreatureDeath() → checkDeathTriggers(). The cascade loop here ensures
   * that triggers created by SBAs (e.g., a creature dying from 0 toughness after
   * a lord leaves) are properly re-checked.
   */
  private runStateBasedActions(): void {
    if (this.state.gameOver) return;

    let safety = 0;
    const MAX_CASCADE = 50; // Prevent infinite loops from buggy state

    while (safety < MAX_CASCADE) {
      safety++;
      const stackBefore = this.state.stack.length;
      const stateBefore = this.state;

      // Step 1: Check and apply all SBAs (loops internally until no more SBAs)
      this.state = checkStateBasedActions(this.state);
      if (this.state.gameOver) return;

      // Recalculate continuous effects after SBAs may have changed the board
      this.state = applyContinuousEffects(this.state);
      if (this.state.gameOver) return;

      // Commander zone replacements (commander → graveyard goes to command zone)
      this.state = processCommanderZoneReplacements(this.state);

      // Commander damage loss check
      const cmdResult = checkCommanderDamageLoss(this.state);
      if (cmdResult.changed) {
        this.state = cmdResult.state;
        if (this.state.gameOver) return;
      }

      // Step 2: Check if SBAs caused new triggers to be added to the stack
      // (Death triggers are already added inside checkCreatureDeath → checkDeathTriggers)
      const stackAfter = this.state.stack.length;
      const sbasChangedState = this.state !== stateBefore;
      const newTriggersAdded = stackAfter > stackBefore;

      // Step 3: If no SBAs changed state AND no new triggers were added, we're stable
      if (!sbasChangedState && !newTriggersAdded) break;

      // Otherwise, loop again — new triggers may have caused state changes
      // that require another round of SBAs (e.g., a death trigger creates a token
      // that triggers another SBA)
    }
  }

  /** Apply commander damage tracking from combat results */
  private applyCommanderDamage(
    damages: { commanderId: string; damage: number; defenderId: 0 | 1 }[]
  ): void {
    for (const { commanderId, damage, defenderId } of damages) {
      this.state = trackCommanderDamage(this.state, commanderId, damage, defenderId);
    }
  }
}
