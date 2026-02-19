import type { GameState, Phase, Step } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import { PHASES, PHASE_STEPS } from '../types/game-state.ts';
import { emptyManaPool } from '../types/player.ts';
import { checkUpkeepTriggers, checkEndStepTriggers, checkBeginCombatTriggers } from '../rules/triggers.ts';
import { addSpellToStack } from '../rules/stack.ts';


/**
 * Get the next step within the current phase.
 * Returns null if we're at the last step of the phase.
 */
export function getNextStep(phase: Phase, currentStep: Step): Step | null {
  const steps = PHASE_STEPS[phase];
  const idx = steps.indexOf(currentStep);
  if (idx === -1 || idx >= steps.length - 1) return null;
  return steps[idx + 1];
}

/**
 * Get the next phase after the current one.
 * Returns null if we're at the ending phase (need new turn).
 */
export function getNextPhase(currentPhase: Phase): Phase | null {
  const idx = PHASES.indexOf(currentPhase);
  if (idx === -1 || idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

/**
 * Advance to the next step within the current phase.
 * If at end of phase, advances to next phase's first step.
 * If at end of turn, starts a new turn.
 */
export function advanceStep(state: GameState): GameState {
  const nextStep = getNextStep(state.phase, state.step);

  if (nextStep !== null) {
    // CR 106.4: Empty mana pools when moving between steps
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], manaPool: emptyManaPool() };
    players[1] = { ...players[1], manaPool: emptyManaPool() };

    // Stay in same phase, move to next step
    return applyStepEffects({
      ...state,
      players,
      step: nextStep,
      bothPlayersPassed: false,
    });
  }

  // End of phase -> advance to next phase
  return advancePhase(state);
}

/**
 * Advance to the next phase (first step of that phase).
 * If at ending phase, starts a new turn.
 * Extra combats (CR 506.1): after combat phase, if extraCombats > 0,
 * decrements the counter and returns to another combat phase instead of postcombat-main.
 */
export function advancePhase(state: GameState): GameState {
  // Extra combat phases: if leaving combat and extra combats remain,
  // go back to another combat phase instead of advancing normally
  if (state.phase === 'combat' && (state.extraCombats ?? 0) > 0) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], manaPool: emptyManaPool() };
    players[1] = { ...players[1], manaPool: emptyManaPool() };

    const firstStep = PHASE_STEPS['combat'][0];
    return applyStepEffects({
      ...state,
      players,
      phase: 'combat',
      step: firstStep,
      bothPlayersPassed: false,
      extraCombats: (state.extraCombats ?? 0) - 1,
      combat: {
        attackers: [],
        blockers: [],
        currentStep: 'begin',
      },
    });
  }

  const nextPhase = getNextPhase(state.phase);

  if (nextPhase !== null) {
    // CR 106.4: Empty mana pools when moving between phases
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], manaPool: emptyManaPool() };
    players[1] = { ...players[1], manaPool: emptyManaPool() };

    const firstStep = PHASE_STEPS[nextPhase][0];
    return applyStepEffects({
      ...state,
      players,
      phase: nextPhase,
      step: firstStep,
      bothPlayersPassed: false,
      combat: nextPhase === 'combat' ? {
        attackers: [],
        blockers: [],
        currentStep: 'begin',
      } : state.combat,
    });
  }

  // End of turn -> start new turn
  return startNewTurn(state);
}

/**
 * Start a new turn for the next player.
 * Handles: untap, reset turn state, mana pool empty, draw.
 * Extra turns (CR 500.7): if extraTurns queue is non-empty, the next turn
 * is taken by the player at the front of the queue instead of alternating.
 */
export function startNewTurn(state: GameState): GameState {
  let nextActivePlayer: 0 | 1;
  let updatedExtraTurns = state.extraTurns ? [...state.extraTurns] : [];

  if (updatedExtraTurns.length > 0) {
    // Extra turn: use the player from the front of the queue
    const extraTurn = updatedExtraTurns.shift()!;
    nextActivePlayer = extraTurn.player;
  } else {
    // Normal alternation
    nextActivePlayer = state.activePlayer === 0 ? 1 : 0;
  }

  const newTurn = state.activePlayer === 1 ? state.turn + 1 : state.turn;

  // Reset active player's turn state
  const players = [...state.players] as [PlayerState, PlayerState];

  // CR 702.26d: Phasing — During the untap step, BEFORE untapping,
  // all phased-out permanents controlled by the active player phase back in.
  // Phased-in permanents with phasing would phase out here, but we only
  // handle phase-in since phase-out is triggered by effects (not automatic phasing keyword).
  players[nextActivePlayer] = {
    ...players[nextActivePlayer],
    battlefield: players[nextActivePlayer].battlefield.map((p) => {
      if (p.phasedOut) {
        return { ...p, phasedOut: false };
      }
      return p;
    }),
  };

  // Untap all permanents for the new active player (after phasing)
  players[nextActivePlayer] = {
    ...players[nextActivePlayer],
    battlefield: players[nextActivePlayer].battlefield.map((p) => ({
      ...p,
      tapped: p.skipNextUntap ? p.tapped : false,  // CR 702.26: skipNextUntap prevents untapping
      skipNextUntap: false,  // Always reset the flag after checking
      summoningSick:
        p.enteredBattlefieldTurn === newTurn ? true : false,
      attacking: false,
      blocking: null,
      loyaltyUsedThisTurn: false, // Reset planeswalker loyalty usage
    })),
    landPlayedThisTurn: false,
    landsPlayedThisTurn: 0,
    maxLandPlays: 1,
    manaPool: emptyManaPool(),
  };

  // Empty the other player's mana pool too
  const otherPlayer: 0 | 1 = nextActivePlayer === 0 ? 1 : 0;
  players[otherPlayer] = {
    ...players[otherPlayer],
    manaPool: emptyManaPool(),
  };

  const newState: GameState = {
    ...state,
    players,
    activePlayer: nextActivePlayer,
    priorityPlayer: nextActivePlayer,
    turn: newTurn,
    phase: 'beginning',
    step: 'untap',
    stack: [],
    combat: null,
    bothPlayersPassed: false,
    mulliganPhase: false, // Ensure mulligan phase is over for new turns
    extraTurns: updatedExtraTurns.length > 0 ? updatedExtraTurns : undefined,
    extraCombats: 0, // Reset extra combats for the new turn
  };

  return applyStepEffects(newState);
}

/**
 * Grant an extra turn to a player (CR 500.7).
 * Extra turns are queued in LIFO order: the most recently created extra turn
 * is taken first. Push to the front of the queue.
 */
export function grantExtraTurn(state: GameState, player: 0 | 1): GameState {
  const extraTurns = state.extraTurns ? [...state.extraTurns] : [];
  // Most recently granted extra turn is taken first (LIFO), so unshift to front
  extraTurns.unshift({ player });
  return {
    ...state,
    extraTurns,
    log: [...state.log, {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player,
      message: `${state.players[player].name} will take an extra turn.`,
    }],
  };
}

/**
 * Grant an extra combat phase this turn (CR 506.1).
 * After the current combat phase ends, an additional combat phase will occur
 * before the postcombat main phase.
 */
export function grantExtraCombat(state: GameState): GameState {
  return {
    ...state,
    extraCombats: (state.extraCombats ?? 0) + 1,
    log: [...state.log, {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player: state.activePlayer,
      message: `${state.players[state.activePlayer].name} gets an additional combat phase.`,
    }],
  };
}

/**
 * Apply automatic effects when entering a step.
 * Untap step: untap is already handled in startNewTurn.
 * Draw step: draw a card (skip for first player's first turn).
 */
export function applyStepEffects(state: GameState): GameState {

  // Upkeep: check for "at the beginning of your upkeep" triggers
  if (state.step === 'upkeep' && !state.mulliganPhase) {
    state = checkUpkeepTriggers(state);

    // ─── Rebound (CR 702.87): Cast exiled rebound spells at upkeep for free ───
    const ap = state.activePlayer;
    const reboundCards = state.players[ap].exile.filter(c => (c as any).reboundExile);
    if (reboundCards.length > 0) {
      const players = [...state.players] as [PlayerState, PlayerState];
      const remainingExile = players[ap].exile.filter(c => !(c as any).reboundExile);
      players[ap] = { ...players[ap], exile: remainingExile };
      state = { ...state, players };

      for (const card of reboundCards) {
        // Remove the reboundExile marker
        const cleanCard = { ...card };
        delete (cleanCard as any).reboundExile;

        // Put on stack without paying cost (free rebound cast)
        state = addSpellToStack(state, cleanCard, ap, {});
        state = {
          ...state,
          log: [...state.log, {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: ap,
            message: `${card.name} cast from exile (rebound).`,
            cardName: card.name,
          }],
        };
      }
    }
  }

  // Begin combat (CR 507.1): fire "at the beginning of combat" triggers
  if (state.step === 'begin-combat' && !state.mulliganPhase) {
    state = checkBeginCombatTriggers(state);
  }

  if (state.step === 'draw') {
    const activePlayer = state.players[state.activePlayer];

    // First player skips their first draw
    if (state.turn === 1 && state.activePlayer === 0 && !activePlayer.hasDrawnThisGame) {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[state.activePlayer] = {
        ...players[state.activePlayer],
        hasDrawnThisGame: true,
      };
      return {
        ...state,
        players,
        log: [
          ...state.log,
          {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: state.activePlayer,
            message: `${activePlayer.name} skips first draw.`,
          },
        ],
      };
    }

    // Normal draw
    if (activePlayer.library.length > 0) {
      const drawnCard = activePlayer.library[0];
      const players = [...state.players] as [PlayerState, PlayerState];
      players[state.activePlayer] = {
        ...players[state.activePlayer],
        library: players[state.activePlayer].library.slice(1),
        hand: [...players[state.activePlayer].hand, drawnCard],
        hasDrawnThisGame: true,
      };
      return {
        ...state,
        players,
        log: [
          ...state.log,
          {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: state.activePlayer,
            message: `${activePlayer.name} draws a card.`,
            cardName: drawnCard.name,
          },
        ],
      };
    }

    // Empty library = lose (handled by state-based actions in Week 3)
    return state;
  }

  // Saga lore counters: add a lore counter to all sagas the active player controls
  // after the draw step (CR 714.3b: put a lore counter on this Saga as your precombat
  // main phase begins). We trigger on draw step exit → main phase entry.
  if (state.step === 'main' && state.phase === 'precombat-main' && !state.mulliganPhase) {
    const ap = state.activePlayer;
    const playerState = state.players[ap];
    const sagaBf = playerState.battlefield;
    let sagaChanged = false;
    const sagaTriggers: Array<{ saga: Permanent; chapter: number }> = [];
    const updatedBf = sagaBf.map(perm => {
      if (perm.typeLine.toLowerCase().includes('saga')) {
        sagaChanged = true;
        const lore = (perm.counters['lore'] || 0) + 1;
        sagaTriggers.push({ saga: perm, chapter: lore });
        return {
          ...perm,
          counters: { ...perm.counters, lore },
        };
      }
      return perm;
    });
    if (sagaChanged) {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ap] = { ...players[ap], battlefield: updatedBf };
      state = { ...state, players };

      // Queue chapter triggers on the stack
      for (const { saga, chapter } of sagaTriggers) {
        const chapterText = parseSagaChapter(saga.oracleText || '', chapter);
        if (chapterText) {
          const stackObj: import('../types/action.ts').StackObject = {
            id: `saga_${saga.id}_ch${chapter}_${Date.now().toString(36)}`,
            type: 'ability',
            source: saga as import('../types/permanent.ts').Permanent,
            controller: ap,
            targets: [],
            text: `${saga.name} — Chapter ${chapter}`,
            oracleText: chapterText,
          };
          state = {
            ...state,
            stack: [...state.stack, stackObj],
            log: [...state.log, {
              timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
              player: ap,
              message: `${saga.name} — Chapter ${toRoman(chapter)} triggers.`,
              cardName: saga.name,
            }],
          };
        }
      }
    }
  }

  // End step: check "at the beginning of your end step" triggers
  if (state.step === 'end' && !state.mulliganPhase) {
    state = checkEndStepTriggers(state);

    const ap = state.activePlayer;
    const players = [...state.players] as [PlayerState, PlayerState];
    const endLogs: string[] = [];

    // ─── Monarch (CR 721): Monarch draws an extra card at end step ───
    if (state.monarch === ap) {
      const lib = players[ap].library;
      if (lib.length > 0) {
        const drawnCard = lib[0];
        players[ap] = {
          ...players[ap],
          library: lib.slice(1),
          hand: [...players[ap].hand, drawnCard],
        };
        endLogs.push(`${players[ap].name} draws a card (monarch).`);
      }
    }

    // ─── Dash (CR 702.108): Return dashed creatures to hand at end step ───
    const dashedPerms = players[ap].battlefield.filter(p => p.dashedThisTurn);
    if (dashedPerms.length > 0) {
      const remainingBf = players[ap].battlefield.filter(p => !p.dashedThisTurn);
      const returnedCards = dashedPerms.map(p => ({
        id: p.id,
        oracleId: p.oracleId,
        name: p.name,
        manaCost: p.manaCost,
        cmc: p.cmc,
        typeLine: p.typeLine,
        oracleText: p.oracleText,
        power: p.power,
        toughness: p.toughness,
        loyalty: p.loyalty,
        colors: p.colors,
        colorIdentity: p.colorIdentity,
        rarity: p.rarity,
        tags: p.tags,
        imageUrl: p.imageUrl,
        owner: p.owner,
      }));
      players[ap] = {
        ...players[ap],
        battlefield: remainingBf,
        hand: [...players[ap].hand, ...returnedCards],
      };
      for (const p of dashedPerms) {
        endLogs.push(`${p.name} returns to hand (dash).`);
      }
    }

    // ─── Blitz (CR 702.152): Sacrifice blitzed creatures at end step, draw for each ───
    const blitzedPerms = players[ap].battlefield.filter(p => p.blitzed);
    if (blitzedPerms.length > 0) {
      const remainingBf = players[ap].battlefield.filter(p => !p.blitzed);
      // Move blitzed creatures to graveyard
      const blitzCards = blitzedPerms.map(p => ({
        id: p.id, oracleId: p.oracleId, name: p.name, manaCost: p.manaCost,
        cmc: p.cmc, typeLine: p.typeLine, oracleText: p.oracleText,
        power: p.power, toughness: p.toughness, loyalty: p.loyalty,
        colors: p.colors, colorIdentity: p.colorIdentity, rarity: p.rarity,
        tags: p.tags, imageUrl: p.imageUrl, owner: p.owner,
      }));
      players[ap] = {
        ...players[ap],
        battlefield: remainingBf,
        graveyard: [...players[ap].graveyard, ...blitzCards],
      };
      // Draw a card for each blitzed creature that dies
      const drawCount = blitzedPerms.length;
      const blitzLib = players[ap].library;
      const drawnCards = blitzLib.slice(0, drawCount);
      if (drawnCards.length > 0) {
        players[ap] = {
          ...players[ap],
          library: blitzLib.slice(drawCount),
          hand: [...players[ap].hand, ...drawnCards],
        };
      }
      for (const p of blitzedPerms) {
        endLogs.push(`${p.name} is sacrificed (blitz) — draw a card.`);
      }
    }

    if (endLogs.length > 0) {
      const logEntries = endLogs.map(message => ({
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: ap as 0 | 1 | null,
        message,
      }));
      state = { ...state, players, log: [...state.log, ...logEntries] };
    }
  }

  // Combat Damage Steps: Damage is resolved by Game.resolveCombat() called by UI/bot
  // NOT automatically here to avoid double resolution
  // CRITICAL FIX: Removed duplicate combat damage resolution
  // The damage is resolved in Game.resolveCombat() which is called explicitly

  // Cleanup step: remove damage, expire "until end of turn" effects
  // CR 514.3a: If state-based actions are performed or triggered abilities are put
  // on the stack during cleanup, players receive priority and another cleanup step
  // occurs afterward. The Game class handles this via its game loop: after advancing
  // to cleanup, runStateBasedActions() is called. If SBAs or triggers fire during
  // cleanup, the priority system will give players a chance to act, and the step
  // won't advance until both players pass. If pending discard exists, priority is
  // likewise retained. A subsequent cleanup step will then follow naturally as the
  // turn progresses.
  if (state.step === 'cleanup') {
    const players = [...state.players] as [PlayerState, PlayerState];
    const logs: string[] = [];

    // ── Phase 1: Return temporarily stolen permanents ──
    // Collect all permanents that need to move back to their original controller
    const stealsToReturn: { perm: (typeof players)[0]['battlefield'][0]; fromPlayer: 0 | 1 }[] = [];

    for (let i = 0; i < 2; i++) {
      const player = players[i as 0 | 1];
      const keeping: typeof player.battlefield = [];

      for (const perm of player.battlefield) {
        if (perm.temporaryControlChange) {
          stealsToReturn.push({ perm, fromPlayer: i as 0 | 1 });
          logs.push(`${perm.name} returns to ${state.players[perm.temporaryControlChange.originalController].name}'s control.`);
        } else {
          keeping.push(perm);
        }
      }

      if (keeping.length !== player.battlefield.length) {
        players[i as 0 | 1] = { ...player, battlefield: keeping };
      }
    }

    // Move stolen permanents back to their original controllers
    for (const { perm } of stealsToReturn) {
      const origController = perm.temporaryControlChange!.originalController;
      const returnedPerm = {
        ...perm,
        controller: origController,
        temporaryControlChange: undefined,
        tapped: true, // Returns tapped
      };
      players[origController] = {
        ...players[origController],
        battlefield: [...players[origController].battlefield, returnedPerm],
      };
    }

    // ── Phase 2: Clean up per-permanent temporary effects ──
    for (let i = 0; i < 2; i++) {
      const player = players[i as 0 | 1];
      players[i as 0 | 1] = {
        ...player,
        battlefield: player.battlefield.map((p) => {
          let updated = { ...p, damage: 0 };
          // Clear deathtouched flag
          delete (updated as any).deathtouched;

          // Remove temporary P/T modifications
          const mods = updated.temporaryPtMods || [];
          if (mods.length > 0) {
            let powerRemoved = 0;
            let toughRemoved = 0;
            for (const mod of mods) {
              powerRemoved += mod.power;
              toughRemoved += mod.toughness;
            }
            if (updated.currentPower !== undefined) {
              updated.currentPower -= powerRemoved;
            }
            if (updated.currentToughness !== undefined) {
              updated.currentToughness -= toughRemoved;
            }
            updated.temporaryPtMods = [];
            if (powerRemoved !== 0 || toughRemoved !== 0) {
              logs.push(`${p.name}: temporary ${powerRemoved >= 0 ? '+' : ''}${powerRemoved}/${toughRemoved >= 0 ? '+' : ''}${toughRemoved} expires.`);
            }
          }

          // Remove temporary keywords ("gains flying until end of turn")
          if (updated.temporaryKeywords && updated.temporaryKeywords.length > 0) {
            const keywords = updated.temporaryKeywords.map(k => k.keyword).join(', ');
            logs.push(`${p.name}: temporary ${keywords} expires.`);
            updated.temporaryKeywords = [];
          }

          // ─── Goad (CR 701.38): Clear goaded status at end of turn ───
          if (updated.goaded) {
            logs.push(`${p.name} is no longer goaded.`);
            updated = { ...updated, goaded: false };
          }

          // ─── Dash: Clear dashed flag (already returned to hand in end step) ───
          if (updated.dashedThisTurn) {
            updated = { ...updated, dashedThisTurn: false };
          }

          // ─── Clear temporary protection/indestructible until EOT ───
          if ((updated as any).temporaryIndestructible) {
            logs.push(`${p.name} is no longer indestructible.`);
            updated = { ...updated };
            delete (updated as any).temporaryIndestructible;
          }
          if ((updated as any).temporaryHexproof) {
            logs.push(`${p.name} no longer has hexproof.`);
            updated = { ...updated };
            delete (updated as any).temporaryHexproof;
          }

          // ─── Clear Layer 4 type changes (until end of turn) ───
          if (updated.typeChanges && updated.typeChanges.length > 0) {
            updated = { ...updated, typeChanges: [] };
          }

          // ─── Clear Layer 5 color changes (until end of turn) ───
          if (updated.colorChanges && updated.colorChanges.length > 0) {
            updated = { ...updated, colorChanges: [] };
          }

          // ─── Clear Layer 1 copy effects (until end of turn) ───
          // Note: Permanent copies (Clone) that entered as a copy retain copyEffect always.
          // Only temporary copy effects from spells like "becomes a copy until EOT" expire.
          // We clear copyEffect only if it has a turn-based source (source contains 'eot' or 'until-eot').
          // For now, clear all copyEffects that were not set as the creature's ETB identity.
          // (Clone's copyEffect is part of its static identity, not a temp effect.)
          // Simple heuristic: keep copyEffect if it was applied at the same turn as ETB
          if (updated.copyEffect && updated.enteredBattlefieldTurn !== updated.copyEffect.timestamp) {
            // Don't clear — copyEffect on Clone should persist
            // Only targeted temporary "becomes a copy until EOT" should clear
            // For now, leave copyEffect intact (permanent copy effects don't expire)
          }

          // ─── Restore oracle text after lostAllAbilities expires (targeted spells only) ───
          // Static lostAllAbilities (from other permanents like Humility) is re-applied by continuous.ts
          // and does NOT need to be cleared here — it will re-blank oracleText each frame.
          // However, targeted "loses all abilities until EOT" spells set lostAllAbilities without
          // a static source. We need to restore these at cleanup.
          // Heuristic: if lostAllAbilities is set AND no static source is currently active, restore.
          // Simple approach: clear lostAllAbilities and restore originalOracleText at cleanup.
          // continuous.ts will re-apply if a static source (Humility) is still on the battlefield.
          if (updated.lostAllAbilities) {
            if (updated.originalOracleText !== undefined) {
              logs.push(`${p.name} regains its abilities.`);
              updated = {
                ...updated,
                lostAllAbilities: undefined,
                oracleText: updated.originalOracleText,
                originalOracleText: undefined,
              };
            } else {
              updated = { ...updated, lostAllAbilities: undefined };
            }
          }

          return updated;
        }),
      };
    }

    const logEntries = logs.map((message) => ({
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player: null as 0 | 1 | null,
      message,
    }));

    let cleanupState: GameState = { ...state, players, log: [...state.log, ...logEntries] };

    // Remove end-of-turn damage prevention shields (CR 615.7)
    if (cleanupState.damageShields?.length) {
      const remainingShields = cleanupState.damageShields.filter(s => !s.untilEndOfTurn);
      cleanupState = { ...cleanupState, damageShields: remainingShields.length > 0 ? remainingShields : undefined };
    }

    // Hand size enforcement: active player must discard to 7
    const MAX_HAND_SIZE = 7;
    const activePlayer = cleanupState.players[cleanupState.activePlayer];
    if (activePlayer.hand.length > MAX_HAND_SIZE) {
      const discardCount = activePlayer.hand.length - MAX_HAND_SIZE;
      cleanupState = {
        ...cleanupState,
        pendingDiscard: cleanupState.activePlayer,
        pendingDiscardCount: discardCount,
        log: [...cleanupState.log, {
          timestamp: Date.now(),
          turn: cleanupState.turn,
          phase: cleanupState.phase,
          step: cleanupState.step,
          player: cleanupState.activePlayer,
          message: `${activePlayer.name} has ${activePlayer.hand.length} cards and must discard ${discardCount}.`,
        }],
      };
    }

    // Clear first draw flag for Miracle tracking
    if (cleanupState.firstDrawThisTurn) {
      cleanupState = { ...cleanupState, firstDrawThisTurn: false };
    }

    return cleanupState;
  }

  return state;
}

/**
 * Get the actions that are generally allowed in the current step.
 * This is a high-level list; actual legality depends on game state.
 *
 * CR 116.1: Instant-speed spells (instants and cards with flash) can be
 * cast whenever a player has priority, including during other players' turns
 * and while spells/abilities are on the stack.
 */
export function getCurrentStepActions(state: GameState): string[] {
  // CR 502.1: No player gets priority during the untap step (unless in mulligan phase)
  if (state.step === 'untap') {
    if (state.mulliganPhase) {
      return ['pass', 'mulligan'];
    }
    return [];
  }

  const actions: string[] = ['pass'];

  switch (state.step) {

    case 'upkeep':
      if (state.mulliganPhase) actions.push('mulligan');
      // Flash (CR 702.8): cards with flash can be cast any time you have priority
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'draw':
      if (state.mulliganPhase) actions.push('mulligan');
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'main':
      // Active player with empty stack: full sorcery-speed actions
      if (state.activePlayer === state.priorityPlayer && state.stack.length === 0) {
        actions.push(
          'play-land',
          'cast-spell',
          'activate-ability'
        );
      } else {
        // Non-active player during main, or stack is non-empty:
        // instant-speed spells and abilities only. cast-spell is included
        // because validation.ts enforces instant-only timing constraints.
        actions.push('cast-instant', 'cast-spell', 'activate-ability');
      }
      break;

    case 'begin-combat':
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'declare-attackers':
      if (state.activePlayer === state.priorityPlayer) {
        actions.push('declare-attackers');
      }
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'declare-blockers':
      if (state.activePlayer !== state.priorityPlayer) {
        actions.push('declare-blockers');
      }
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'first-strike-damage':
    case 'combat-damage':
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'end-combat':
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'end':
      actions.push('cast-instant', 'cast-spell', 'activate-ability');
      break;

    case 'cleanup':
      // Normally no actions during cleanup
      return [];
  }

  return actions;
}

/**
 * Create the initial game state from two player states.
 */
export function createInitialGameState(
  player1: PlayerState,
  player2: PlayerState
): GameState {
  return {
    players: [player1, player2],
    activePlayer: 0,
    priorityPlayer: 0,
    turn: 1,
    phase: 'beginning',
    step: 'untap',
    stack: [],
    combat: null,
    winner: null,
    gameOver: false,
    log: [
      {
        timestamp: Date.now(),
        turn: 1,
        phase: 'beginning',
        step: 'untap',
        player: null,
        message: 'Game started!',
      },
    ],
    actionHistory: [],
    bothPlayersPassed: false,
    mulliganPhase: true,
    mulliganCount: [0, 0],
  };
}

// ─── Saga Helpers ───

/** Convert integer to roman numeral (1-6) */
function toRoman(n: number): string {
  const map: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI' };
  return map[n] || String(n);
}

/**
 * Parse a specific chapter's effect text from a Saga's oracle text.
 * e.g., for chapter 2, finds "II — Draw a card." and returns "Draw a card."
 */
function parseSagaChapter(oracleText: string, chapter: number): string | null {
  const roman = toRoman(chapter);
  // Match "I —" or "I, II —" (shared chapters) or just "II —"
  // We need to find lines where this chapter's roman numeral appears before the dash
  const lines = oracleText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match chapter marker: roman numerals before em-dash
    const chapterMatch = trimmed.match(/^((?:I{1,3}|IV|V|VI{0,3})(?:\s*,\s*(?:I{1,3}|IV|V|VI{0,3}))*)\s*[—–\-]\s*(.+)/);
    if (!chapterMatch) continue;
    const chapterNums = chapterMatch[1].split(',').map(s => s.trim());
    if (chapterNums.includes(roman)) {
      return chapterMatch[2].trim();
    }
  }
  return null;
}
