import type { GameState } from '../types/game-state.ts';
import type { StackObject, Target } from '../types/action.ts';
import type { Card } from '../types/card.ts';
import type { Permanent } from '../types/permanent.ts';
import type { ManaPayment } from '../types/mana.ts';
import type { PlayerState } from '../types/player.ts';
import { giveActivePlayerPriority } from './priority.ts';
import { resolveEffect } from './effects.ts';
import { parseAbilities } from './abilities.ts';
import { checkETBTriggers } from './triggers.ts';

let nextStackId = 0;

/** Reset stack ID counter (for tests) */
export function resetStackIdCounter(): void {
  nextStackId = 0;
}

/** Generate a unique stack object ID */
function generateStackId(): string {
  return `stack_${++nextStackId}_${Date.now().toString(36)}`;
}

/**
 * Add a spell to the stack.
 * The card is removed from hand and tracked in the StackObject.
 */
export function addSpellToStack(
  state: GameState,
  cardId: string,
  player: 0 | 1,
  targets: Target[],
  _manaPayment: ManaPayment,
  xValue?: number,
  opts?: { isFlashback?: boolean; isKicked?: boolean; isAdventure?: boolean; isFaceDown?: boolean; isEvoked?: boolean; isDashed?: boolean; oracleTextOverride?: string }
): GameState {
  const playerState = state.players[player];

  // Flashback: card comes from graveyard instead of hand
  let card: Card | undefined;
  let updatedPlayer: PlayerState;

  if (opts?.isFlashback) {
    // Flashback: card from graveyard
    const gyIndex = playerState.graveyard.findIndex((c) => c.id === cardId);
    if (gyIndex === -1) return state;
    card = playerState.graveyard[gyIndex];
    updatedPlayer = {
      ...playerState,
      graveyard: [
        ...playerState.graveyard.slice(0, gyIndex),
        ...playerState.graveyard.slice(gyIndex + 1),
      ],
    };
  } else {
    // Try hand first
    const cardIndex = playerState.hand.findIndex((c) => c.id === cardId);
    if (cardIndex !== -1) {
      card = playerState.hand[cardIndex];
      updatedPlayer = {
        ...playerState,
        hand: [
          ...playerState.hand.slice(0, cardIndex),
          ...playerState.hand.slice(cardIndex + 1),
        ],
      };
    } else {
      // Try exile (adventure creatures returning from exile, CR 715.4)
      const exileIndex = playerState.exile.findIndex((c) => c.id === cardId);
      if (exileIndex === -1) return state;
      card = { ...playerState.exile[exileIndex], onAdventure: undefined };
      updatedPlayer = {
        ...playerState,
        exile: [
          ...playerState.exile.slice(0, exileIndex),
          ...playerState.exile.slice(exileIndex + 1),
        ],
      };
    }
  }

  const stackObject: StackObject = {
    id: generateStackId(),
    type: 'spell',
    card,
    controller: player,
    targets,
    text: card.name,
    xValue,
    oracleText: opts?.oracleTextOverride,
    isFlashback: opts?.isFlashback,
    isKicked: opts?.isKicked,
    isAdventure: opts?.isAdventure,
    isFaceDown: opts?.isFaceDown,
    isEvoked: opts?.isEvoked,
    isDashed: opts?.isDashed,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[player] = updatedPlayer;

  let castMessage = `${playerState.name} casts ${card.name}`;
  if (opts?.isFlashback) castMessage += ' (flashback)';
  if (opts?.isKicked) castMessage += ' (kicked)';
  if (opts?.isAdventure) castMessage += ` (adventure: ${card.adventureName || card.name})`;
  if (opts?.isEvoked) castMessage += ' (evoked)';
  if (opts?.isDashed) castMessage += ' (dashed)';
  if (xValue !== undefined && xValue > 0) castMessage += ` (X=${xValue})`;
  castMessage += '.';

  return {
    ...state,
    players,
    stack: [...state.stack, stackObject],
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: castMessage,
        cardName: card.name,
        actionType: 'cast-spell',
      },
    ],
  };
}

/**
 * Add an activated ability to the stack.
 */
export function addAbilityToStack(
  state: GameState,
  sourceId: string,
  abilityIndex: number,
  player: 0 | 1,
  targets: Target[]
): GameState {
  const playerState = state.players[player];
  const source = playerState.battlefield.find((p) => p.id === sourceId);
  if (!source) return state;

  const ability = source.abilities[abilityIndex];
  if (!ability) return state;

  // Extract effect text from ability text (format: "cost: effect")
  // For activated abilities, strip the cost prefix to get just the effect
  let effectText = ability.text;
  if (ability.type === 'activated' && ability.cost) {
    // The text format is "{cost}: {effect}" — extract just the effect part
    const colonIdx = effectText.indexOf(':');
    if (colonIdx !== -1) {
      effectText = effectText.substring(colonIdx + 1).trim();
    }
  }

  const stackObject: StackObject = {
    id: generateStackId(),
    type: 'ability',
    source,
    controller: player,
    targets,
    text: `${source.name}: ${ability.text}`,
    oracleText: effectText,  // Set effect text for pattern matching
  };

  return {
    ...state,
    stack: [...state.stack, stackObject],
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${playerState.name} activates ${source.name}'s ability.`,
        cardName: source.name,
        actionType: 'activate-ability',
      },
    ],
  };
}

/**
 * Resolve the top object on the stack (LIFO).
 *
 * Spells: permanent types go to battlefield, instants/sorceries go to graveyard.
 * Abilities: effect is logged (actual effect execution is future work).
 *
 * After resolution, active player gets priority.
 */
export function resolveTopOfStack(state: GameState): GameState {
  if (state.stack.length === 0) return state;

  const stackCopy = [...state.stack];
  const resolving = stackCopy.pop()!;
  let newState: GameState = { ...state, stack: stackCopy };

  // ─── Fizzle Check ───
  // If the spell/ability has targets and ALL targets are now illegal,
  // the spell is countered by game rules (fizzles).
  if (checkSpellFizzle(newState, resolving)) {
    const fizzleName = resolving.card?.name ?? resolving.source?.name ?? resolving.text;

    if (resolving.type === 'spell' && resolving.card && !isPermanentType(resolving.card)) {
      // Instant/Sorcery spell fizzles → move card to graveyard without resolving effects
      const controller = resolving.controller;
      const players = [...newState.players] as [PlayerState, PlayerState];
      players[controller] = {
        ...players[controller],
        graveyard: [...players[controller].graveyard, resolving.card],
      };
      newState = { ...newState, players };
    }
    // For abilities (or permanent spells that somehow fizzle), just skip resolution.
    // Permanent spells with targets are unusual — they still enter the battlefield
    // per MTG rules, but we handle the rare edge case by not fizzling permanents.

    newState = {
      ...newState,
      log: [
        ...newState.log,
        {
          timestamp: Date.now(),
          turn: newState.turn,
          phase: newState.phase,
          step: newState.step,
          player: resolving.controller,
          message: `${fizzleName} fizzles (all targets became illegal).`,
          cardName: resolving.card?.name ?? resolving.source?.name,
        },
      ],
    };

    return giveActivePlayerPriority(newState);
  }

  if (resolving.type === 'spell' && resolving.card) {
    const card = resolving.card;
    const controller = resolving.controller;

    if (isPermanentType(card)) {
      // Permanent spell → battlefield
      let permanent = createPermanentFromCard(card, controller, newState.turn);
      // Morph: if cast face-down, enter as 2/2 colorless creature (CR 702.36)
      if (resolving.isFaceDown) {
        permanent = {
          ...permanent,
          faceDown: true,
          basePower: 2,
          baseToughness: 2,
          currentPower: 2,
          currentToughness: 2,
          abilities: [],
        };
      }
      // Evoke: mark for immediate sacrifice after ETB (CR 702.73)
      if (resolving.isEvoked) {
        permanent = { ...permanent, sacrificeOnETB: true };
      }
      // Dash: gains haste, returns to hand at end step (CR 702.108)
      if (resolving.isDashed) {
        permanent = {
          ...permanent,
          dashedThisTurn: true,
          temporaryKeywords: [...(permanent.temporaryKeywords || []), { keyword: 'haste', until: 'end-of-turn' }],
        };
      }
      const players = [...newState.players] as [PlayerState, PlayerState];
      players[controller] = {
        ...players[controller],
        battlefield: [...players[controller].battlefield, permanent],
      };
      newState = { ...newState, players };

      // Determine the zone the spell was cast from for conditional ETB triggers
      const fromZone = resolving.isFlashback ? 'graveyard' : resolving.isAdventure ? 'exile' : 'hand';
      // Check for ETB triggered abilities and queue them on the stack
      newState = checkETBTriggers(newState, permanent, { fromZone });

      // Try to resolve ETB effects from oracle text (e.g., "When ~ enters the battlefield, draw a card")
      // Direct effect resolution for simple patterns
      const effectResult = resolveEffect(newState, resolving);
      newState = effectResult.state;
      if (effectResult.resolved && effectResult.description) {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: `${card.name} resolves → ${effectResult.description}.`,
            cardName: card.name, actionType: 'effect',
          }],
        };
      } else {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: `${card.name} resolves.`,
            cardName: card.name,
          }],
        };
      }
    } else {
      // Instant/Sorcery → try to auto-resolve effects BEFORE moving to destination zone
      const effectResult = resolveEffect(newState, resolving);
      newState = effectResult.state;

      // Determine destination zone after resolution:
      // - Flashback: exile instead of graveyard (CR 702.34a)
      // - Adventure: exile with onAdventure flag (CR 715.4)
      // - Normal: graveyard
      const players = [...newState.players] as [PlayerState, PlayerState];
      if (resolving.isFlashback) {
        players[controller] = {
          ...players[controller],
          exile: [...players[controller].exile, card],
        };
      } else if (resolving.isAdventure) {
        const adventureCard = { ...card, onAdventure: true };
        players[controller] = {
          ...players[controller],
          exile: [...players[controller].exile, adventureCard],
        };
      } else if (!resolving.isFlashback && card.oracleText?.toLowerCase().includes('rebound')) {
        // Rebound (CR 702.87): exile instead of graveyard, cast again next upkeep
        const reboundCard = { ...card, reboundExile: true };
        players[controller] = {
          ...players[controller],
          exile: [...players[controller].exile, reboundCard],
        };
      } else {
        players[controller] = {
          ...players[controller],
          graveyard: [...players[controller].graveyard, card],
        };
      }
      newState = { ...newState, players };

      if (effectResult.resolved && effectResult.description) {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: `${card.name} resolves → ${effectResult.description}.`,
            cardName: card.name, actionType: 'effect',
          }],
          // Track whether manual resolution is needed
          needsManualResolution: false,
        };
      } else {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: effectResult.description
              ? `${card.name} resolves (manual: ${effectResult.description}).`
              : `${card.name} resolves.`,
            cardName: card.name,
          }],
          needsManualResolution: !effectResult.resolved,
          manualResolutionCard: !effectResult.resolved ? card : undefined,
          manualResolutionController: !effectResult.resolved ? controller : undefined,
        };
      }
    }
  } else if (resolving.type === 'ability') {
    // Try to auto-resolve ability effects
    const effectResult = resolveEffect(newState, resolving);
    newState = effectResult.state;

    if (effectResult.resolved && effectResult.description) {
      newState = {
        ...newState,
        log: [...newState.log, {
          timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
          player: resolving.controller,
          message: `Ability resolves → ${effectResult.description}.`,
          actionType: 'effect',
        }],
      };
    } else {
      newState = {
        ...newState,
        log: [...newState.log, {
          timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
          player: resolving.controller,
          message: effectResult.description
            ? `Ability resolves (manual: ${effectResult.description}).`
            : `Ability resolves: ${resolving.text}`,
        }],
        needsManualResolution: !effectResult.resolved,
        manualResolutionCard: !effectResult.resolved ? (resolving.source || resolving.card) : undefined,
        manualResolutionController: !effectResult.resolved ? resolving.controller : undefined,
      };
    }
  }

  return giveActivePlayerPriority(newState);
}

/**
 * Check if a spell or ability should fizzle (be countered by game rules).
 *
 * A spell/ability fizzles if it has targets AND none of those targets are
 * still legal at resolution time:
 *  - 'permanent' target: the permanent must still exist on some player's battlefield
 *  - 'player' target: the player must still be alive (life > 0 and game not over for them)
 *  - 'card-in-zone' target: the card must still exist in the specified zone
 *
 * If the spell has no targets, it never fizzles.
 * If at least one target is still legal, the spell does NOT fizzle.
 */
export function checkSpellFizzle(state: GameState, stackObj: StackObject): boolean {
  // No targets → never fizzles
  if (!stackObj.targets || stackObj.targets.length === 0) {
    return false;
  }

  // Check each target for legality — if ANY target is still legal, no fizzle
  for (const target of stackObj.targets) {
    if (isTargetLegal(state, target)) {
      return false;
    }
  }

  // All targets are illegal → fizzle
  return true;
}

/** Check if a single target is still legal given the current game state */
function isTargetLegal(state: GameState, target: Target): boolean {
  switch (target.type) {
    case 'permanent': {
      // The permanent must exist on some player's battlefield
      for (const player of state.players) {
        if (player.battlefield.some((p) => p.id === target.id)) {
          return true;
        }
      }
      return false;
    }

    case 'player': {
      // The player must still be alive
      const playerIndex = parseInt(target.id, 10);
      if (playerIndex !== 0 && playerIndex !== 1) return false;
      const playerState = state.players[playerIndex];
      // A player is alive if life > 0 and the game isn't over
      // (or the game is over but they aren't the loser)
      if (state.gameOver) return false;
      return playerState.life > 0;
    }

    case 'card-in-zone': {
      if (!target.zone) return false;
      // The card must still exist in the specified zone for some player
      for (const player of state.players) {
        const zoneCards = getZoneCards(player, target.zone);
        if (zoneCards && zoneCards.some((c) => c.id === target.id)) {
          return true;
        }
      }
      return false;
    }

    default:
      return false;
  }
}

/** Get the card array for a given zone from a player's state */
function getZoneCards(player: PlayerState, zone: string): Card[] | null {
  switch (zone) {
    case 'library': return player.library;
    case 'hand': return player.hand;
    case 'graveyard': return player.graveyard;
    case 'exile': return player.exile;
    case 'commandZone': return player.commandZone;
    default: return null;
  }
}

/** Check if a card type represents a permanent */
function isPermanentType(card: Card): boolean {
  const tl = card.typeLine.toLowerCase();
  return (
    tl.includes('creature') ||
    tl.includes('artifact') ||
    tl.includes('enchantment') ||
    tl.includes('planeswalker') ||
    tl.includes('battle')
  );
}

/** Create a Permanent from a Card (inline to avoid circular import with permanent.ts) */
function createPermanentFromCard(
  card: Card,
  controller: 0 | 1,
  turn: number
): Permanent {
  const basePower = card.power ? parseInt(card.power, 10) || 0 : undefined;
  const baseToughness = card.toughness ? parseInt(card.toughness, 10) || 0 : undefined;

  return {
    ...card,
    controller,
    tapped: false,
    flipped: false,
    faceDown: false,
    currentPower: basePower,
    currentToughness: baseToughness,
    basePower,
    baseToughness,
    temporaryPtMods: [],
    damage: 0,
    currentLoyalty: card.loyalty ? parseInt(card.loyalty, 10) || 0 : undefined,
    counters: {},
    summoningSick: true,
    attacking: false,
    blocking: null,
    abilities: parseAbilities(card),
    x: 0,
    y: 0,
    enteredBattlefieldTurn: turn,
    attachments: [],
  };
}

/** Get the number of objects on the stack */
export function getStackSize(state: GameState): number {
  return state.stack.length;
}

/** Check if the stack is empty */
export function isStackEmpty(state: GameState): boolean {
  return state.stack.length === 0;
}

/** Peek at the top of the stack without removing */
export function peekStack(state: GameState): StackObject | null {
  if (state.stack.length === 0) return null;
  return state.stack[state.stack.length - 1];
}

/**
 * Copy a stack object (for Fork, Twincast, etc.).
 * Creates a new StackObject with the same properties but a new ID and controller.
 */
export function copyStackObject(
  original: StackObject,
  newController: 0 | 1,
  newTargets?: Target[]
): StackObject {
  return {
    ...original,
    id: `copy_${original.id}_${Date.now().toString(36)}`,
    controller: newController,
    targets: newTargets || [...original.targets],
    text: `Copy of ${original.text}`,
  };
}
