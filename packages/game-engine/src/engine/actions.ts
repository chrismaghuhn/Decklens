import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import type { PlayerState } from '../types/player.ts';
import type { ManaPayment } from '../types/mana.ts';
import { cardToPermanent } from '../types/permanent.ts';
import { validateAction } from './validation.ts';
import { retainPriorityAfterAction } from '../rules/priority.ts';
import { addSpellToStack, addAbilityToStack } from '../rules/stack.ts';
import { payCost, parseManaCost, canPayCost, autoTapLandsForCost, autoPayCost, addMana, emptyPool } from '../rules/mana.ts';
import { getManaProduction, parseAbilities } from '../rules/abilities.ts';
import type { Permanent } from '../types/permanent.ts';
import { drawCards } from './zone-manager.ts';
import { generateCardId } from './factory.ts';
import { keepHand, performLondonMulligan, startMulligan } from './factory.ts';
import { passPriority } from '../rules/priority.ts';
import { applyStepEffects } from './turn-manager.ts';
import { attachEquipment, getEquipCost } from '../rules/equipment.ts';
import { parseLoyaltyCost } from '../rules/abilities.ts';
import { checkAttackTriggers, checkCastTriggers, checkETBTriggers } from '../rules/triggers.ts';
import { handleCommanderDeath, handleCommanderExile } from '../rules/commander.ts';
import { validateDamageAssignment, applyDamageAssignment, hasKeyword, processAnnihilator } from '../rules/combat.ts';
import { parseCost as parseCostFromString, canPayAbilityCost, payAbilityCost } from '../rules/cost-parser.ts';

/**
 * Execute a game action and return the new state.
 * Validates the action first, then applies it.
 * Returns unchanged state if action is invalid.
 */
export function executeAction(
  state: GameState,
  action: GameAction
): GameState {
  const error = validateAction(state, action);
  if (error !== null) return state;

  let newState: GameState;

  switch (action.type) {
    case 'pass':
      if (state.mulliganPhase) {
        // Treat pass as 'keep hand' during mulligan phase
        newState = keepHand(state, action.player);
        
        // Check if both kept (copied from mulligan case)
        const keepCount = newState.log.filter(e => e.message && e.message.includes('keeps their hand')).length;
        if (keepCount >= 2) {
             newState = {
              ...newState,
              mulliganPhase: false,
              step: 'draw',
              priorityPlayer: newState.activePlayer,
              bothPlayersPassed: false,
            };
            newState = applyStepEffects(newState);
        }
        return newState;
      }

      // Pass is handled by priority system, just record it
      return {
        ...state,
        actionHistory: [...state.actionHistory, action],
      };

    case 'play-land':
      newState = executePlayLand(state, action);
      break;

    case 'cast-spell':
      newState = executeCastSpell(state, action);
      break;

    case 'activate-ability':
      newState = executeActivateAbility(state, action);
      break;

    case 'activate-loyalty':
      newState = executeActivateLoyalty(state, action);
      break;

    case 'declare-attackers':
      newState = executeDeclareAttackers(state, action);
      break;

    case 'declare-blockers':
      newState = executeDeclareBlockers(state, action);
      break;

    case 'mulligan':
      // Handle London Mulligan: keep hand or put cards on bottom
      
      // Sentinel value to trigger a new mulligan (shuffle & draw)
      if (action.toBottom.length === 1 && action.toBottom[0] === 'MULLIGAN') {
         newState = startMulligan(state, action.player);
         break; // startMulligan handles state update and log
      }

      if (action.toBottom.length === 0) {
        // Player keeps their hand
        newState = keepHand(state, action.player);
      } else {
        // Player puts cards on bottom (London mulligan)
        newState = performLondonMulligan(state, action.player, action.toBottom);
      }
      
      // Check if both players have kept their hands - if so, exit mulligan phase
      const bothPlayersKept = newState.log.some(
        entry => entry.message && entry.message.includes('keeps their hand')
      );
      // Count how many "keeps their hand" messages exist
      const keepCount = newState.log.filter(
        entry => entry.message && entry.message.includes('keeps their hand')
      ).length;
      
      // If both players have kept, exit mulligan phase and advance to draw step
      if (keepCount >= 2) {
        newState = {
          ...newState,
          mulliganPhase: false,
          // Move from untap to draw step (skip priority in untap)
          step: 'draw',
          // Active player gets priority in draw step
          priorityPlayer: newState.activePlayer,
          bothPlayersPassed: false,
        };
        // Apply draw step effects (draw a card for active player)
        newState = applyStepEffects(newState);
      }
      
      break;

    case 'concede':
      newState = executeConcede(state, action);
      break;

    case 'tap-for-mana':
      newState = executeTapForMana(state, action);
      break;

    case 'manual-move':
      newState = executeManualMove(state, action);
      break;

    case 'manual-life':
      newState = executeManualLife(state, action);
      break;

    case 'manual-counter':
      newState = executeManualCounter(state, action);
      break;

    case 'manual-pt':
      newState = executeManualPT(state, action);
      break;

    case 'manual-token':
      newState = executeManualToken(state, action);
      break;

    case 'manual-draw':
      newState = executeManualDraw(state, action);
      break;

    case 'manual-damage':
      newState = executeManualDamage(state, action);
      break;

    case 'manual-done':
      // Manual resolution complete — just log it
      newState = {
        ...state,
        log: [...state.log, {
          timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
          player: action.player, message: 'Manual resolution completed.', actionType: 'manual-done',
        }],
      };
      break;

    case 'equip':
      newState = executeEquip(state, action);
      break;

    case 'discard':
      newState = executeDiscard(state, action);
      break;

    case 'legend-choice':
      newState = executeLegendChoice(state, action);
      break;

    case 'commander-zone-choice':
      newState = executeCommanderZoneChoice(state, action);
      break;

    case 'assign-damage':
      newState = executeAssignDamage(state, action);
      break;

    case 'turn-face-up':
      newState = executeTurnFaceUp(state, action);
      break;

    case 'cycle':
      newState = executeCycle(state, action);
      break;

    default:
      return state;
  }

  // Record action in history
  newState = {
    ...newState,
    actionHistory: [...newState.actionHistory, action],
  };

  // Non-pass, non-concede actions: retain priority for the acting player
  if (action.type !== 'concede') {
    newState = retainPriorityAfterAction(newState);
  }

  return newState;
}

/** Play a land from hand to battlefield. Does NOT use the stack. */
function executePlayLand(
  state: GameState,
  action: Extract<GameAction, { type: 'play-land' }>
): GameState {
  const player = state.players[action.player];
  const cardIndex = player.hand.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) return state;

  const card = player.hand[cardIndex];
  const permanent = cardToPermanent(card, action.player, state.turn);
  permanent.summoningSick = false; // Lands don't have summoning sickness

  const updatedPlayer: PlayerState = {
    ...player,
    hand: [...player.hand.slice(0, cardIndex), ...player.hand.slice(cardIndex + 1)],
    battlefield: [...player.battlefield, permanent],
    landPlayedThisTurn: true,
    landsPlayedThisTurn: player.landsPlayedThisTurn + 1,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  let newState: GameState = {
    ...state,
    players,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: `${player.name} plays ${card.name}.`,
        cardName: card.name,
        actionType: 'play-land' as const,
      },
    ],
  };

  // Check for landfall/ETB triggers
  newState = checkETBTriggers(newState, permanent, { fromZone: 'hand' });

  return newState;
}

/** Parse flashback cost from oracle text */
function getFlashbackCost(card: { oracleText?: string }): string | null {
  const match = card.oracleText?.match(/flashback\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  return match ? match[1] : null;
}

/** Parse kicker cost from oracle text */
function getKickerCost(card: { oracleText?: string }): string | null {
  const match = card.oracleText?.match(/kicker\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  return match ? match[1] : null;
}

/** Cast a spell: pay mana, put on stack.
 *  Supports: flashback, kicker, convoke, delve, adventure. */
function executeCastSpell(
  state: GameState,
  action: Extract<GameAction, { type: 'cast-spell' }>
): GameState {
  let player = state.players[action.player];

  // ─── Find the card (hand, graveyard for flashback/escape/jump-start, exile for adventure/foretell) ───
  let card: import('../types/card.ts').Card | undefined;
  let castFromExile = false;
  if (action.castWithFlashback || action.escapePaid || action.jumpStartPaid) {
    card = player.graveyard.find((c) => c.id === action.cardId);
  } else if (action.foretellCast) {
    card = player.exile.find((c) => c.id === action.cardId);
    if (card) castFromExile = true;
  } else {
    card = player.hand.find((c) => c.id === action.cardId);
    // Also check exile for adventure creatures
    if (!card) {
      card = player.exile.find((c) => c.id === action.cardId && c.onAdventure);
      if (card) castFromExile = true;
    }
  }
  if (!card) return state;

  // ─── Calculate total mana cost ───
  const xValue = action.xValue ?? 0;
  let manaCostStr: string;

  if (action.castWithFlashback) {
    // Flashback uses flashback cost instead of normal cost
    manaCostStr = getFlashbackCost(card) || card.manaCost;
  } else if (action.castAsAdventure) {
    // Adventure uses adventure cost
    manaCostStr = card.adventureCost || card.manaCost;
  } else if (action.castBackFace && card.backFace) {
    // MDFC: use back face mana cost (CR 712)
    manaCostStr = card.backFace.manaCost;
  } else if (action.castFaceDown) {
    // Morph: cast face-down for {3} (CR 702.36)
    manaCostStr = '{3}';
  } else if (action.castWithMadness) {
    // Madness: use madness cost (CR 702.34)
    const madnessMatch = card.oracleText?.match(/madness\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    manaCostStr = madnessMatch ? madnessMatch[1] : card.manaCost;
  } else if (action.evokePaid) {
    // Evoke: use evoke cost (CR 702.73)
    const evokeMatch = card.oracleText?.match(/evoke\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    manaCostStr = evokeMatch ? evokeMatch[1] : card.manaCost;
  } else if (action.dashPaid) {
    // Dash: use dash cost (CR 702.108)
    const dashMatch = card.oracleText?.match(/dash\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    manaCostStr = dashMatch ? dashMatch[1] : card.manaCost;
  } else if (action.blitzPaid) {
    // Blitz: use blitz cost instead of normal mana cost (CR 702.152)
    const blitzMatch = card.oracleText?.match(/blitz\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    manaCostStr = blitzMatch ? blitzMatch[1] : card.manaCost;
  } else if (action.escapePaid) {
    // Escape: use escape mana cost (CR 702.137)
    const escapeMatch = card.oracleText?.match(/escape[—\-]\s*(\{[^}]+\}(?:\{[^}]+\})*)/i);
    manaCostStr = escapeMatch ? escapeMatch[1] : card.manaCost;
  } else if (action.jumpStartPaid) {
    // Jump-start: use normal mana cost (CR 702.132)
    manaCostStr = card.manaCost;
  } else if (action.foretellCast) {
    // Foretell: use foretell cost (CR 702.142)
    const foretellMatch = card.oracleText?.match(/foretell\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    manaCostStr = foretellMatch ? foretellMatch[1] : card.manaCost;
  } else {
    manaCostStr = card.manaCost;
  }

  if (manaCostStr.includes('{X}')) {
    manaCostStr = manaCostStr.replace(/\{X\}/g, xValue > 0 ? `{${xValue}}` : '');
  }

  // Kicker: add kicker cost to total (CR 702.32)
  if (action.kickerPaid) {
    const kickerCostStr = getKickerCost(card);
    if (kickerCostStr) manaCostStr += kickerCostStr;
  }

  // Buyback: add buyback cost to total (CR 702.26)
  if (action.buybackPaid) {
    const buybackMatch = card.oracleText?.match(/buyback\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    if (buybackMatch) manaCostStr += buybackMatch[1];
  }

  let cost = parseManaCost(manaCostStr);

  // Convoke: reduce cost by tapped creatures (CR 702.50)
  if (action.convokeCreatures && action.convokeCreatures.length > 0) {
    cost = { ...cost, generic: Math.max(0, cost.generic - action.convokeCreatures.length) };
  }

  // Delve: reduce generic cost by exiled GY cards (CR 702.65)
  if (action.delveCards && action.delveCards.length > 0) {
    cost = { ...cost, generic: Math.max(0, cost.generic - action.delveCards.length) };
  }

  // Affinity for artifacts: automatic cost reduction (CR 702.40)
  if (action.affinityReduction && action.affinityReduction > 0) {
    cost = { ...cost, generic: Math.max(0, cost.generic - action.affinityReduction) };
  }

  // Improvise: reduce cost by tapped artifacts (CR 702.125)
  if (action.improviseArtifacts && action.improviseArtifacts.length > 0) {
    cost = { ...cost, generic: Math.max(0, cost.generic - action.improviseArtifacts.length) };
  }

  // ─── Pay mana ───
  let payment = action.manaPayment;
  if (!canPayCost(player.manaPool, cost, player.life)) {
    const tapResult = autoTapLandsForCost(player, cost);
    if (tapResult) {
      player = tapResult.updatedPlayer;
      payment = tapResult.payment;
    }
  }

  const newPool = payCost(player.manaPool, cost, payment);
  let updatedPlayer = { ...player, manaPool: newPool };

  // ─── Convoke: tap the chosen creatures ───
  if (action.convokeCreatures && action.convokeCreatures.length > 0) {
    const updatedBf = updatedPlayer.battlefield.map(p =>
      action.convokeCreatures!.includes(p.id) ? { ...p, tapped: true } : p
    );
    updatedPlayer = { ...updatedPlayer, battlefield: updatedBf };
  }

  // ─── Improvise: tap the chosen artifacts ───
  if (action.improviseArtifacts && action.improviseArtifacts.length > 0) {
    const updatedBf = updatedPlayer.battlefield.map(p =>
      action.improviseArtifacts!.includes(p.id) ? { ...p, tapped: true } : p
    );
    updatedPlayer = { ...updatedPlayer, battlefield: updatedBf };
  }

  // ─── Delve: exile cards from graveyard ───
  if (action.delveCards && action.delveCards.length > 0) {
    const delveSet = new Set(action.delveCards);
    const exiledCards = updatedPlayer.graveyard.filter(c => delveSet.has(c.id));
    updatedPlayer = {
      ...updatedPlayer,
      graveyard: updatedPlayer.graveyard.filter(c => !delveSet.has(c.id)),
      exile: [...updatedPlayer.exile, ...exiledCards],
    };
  }

  // ─── Escape: exile N other cards from graveyard as additional cost (CR 702.137) ───
  if (action.escapePaid) {
    const escapeMatch = card.oracleText?.match(/escape[—\-]\s*\{[^}]+\}(?:\{[^}]+\})*,?\s*exile\s+(\d+)\s+other/i);
    const escapeN = escapeMatch ? parseInt(escapeMatch[1]) : 0;
    if (escapeN > 0) {
      const otherGY = updatedPlayer.graveyard.filter(c => c.id !== card.id);
      const toExile = otherGY.slice(0, escapeN);
      const exileIds = new Set(toExile.map(c => c.id));
      updatedPlayer = {
        ...updatedPlayer,
        graveyard: updatedPlayer.graveyard.filter(c => c.id !== card.id && !exileIds.has(c.id)),
        exile: [...updatedPlayer.exile, ...toExile],
      };
    }
  }

  // ─── Jump-start: discard a card as additional cost (CR 702.132) ───
  if (action.jumpStartPaid && updatedPlayer.hand.length > 0) {
    const discarded = updatedPlayer.hand[updatedPlayer.hand.length - 1]; // discard last card
    updatedPlayer = {
      ...updatedPlayer,
      hand: updatedPlayer.hand.slice(0, -1),
      graveyard: [...updatedPlayer.graveyard.filter(c => c.id !== card.id), discarded],
    };
  }

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  let newState: GameState = { ...state, players };

  // ─── Add to stack with alternative cost flags ───
  newState = addSpellToStack(
    newState, action.cardId, action.player, action.targets, action.manaPayment, xValue,
    {
      isFlashback: action.castWithFlashback,
      isKicked: action.kickerPaid,
      isAdventure: action.castAsAdventure,
      isFaceDown: action.castFaceDown,
      isEvoked: action.evokePaid,
      isDashed: action.dashPaid,
      isBlitzed: action.blitzPaid,
      isOverloaded: action.overloadPaid,
      isBuyback: action.buybackPaid,
      isEscape: action.escapePaid,
      isJumpStart: action.jumpStartPaid,
      isForetold: action.foretellCast,
      isMutate: action.mutatePaid,
      mutateTargetId: action.mutateTargetId,
      mutateOnTop: action.mutateOnTop,
      // MDFC: pass back face oracle text so effects resolve from back face
      oracleTextOverride: action.castBackFace && card.backFace ? card.backFace.oracleText : undefined,
    }
  );

  // If cast from command zone, increment commander tax (CR 903.8)
  if (action.castFromCommandZone) {
    const updPlayers = [...newState.players] as [PlayerState, PlayerState];
    updPlayers[action.player] = {
      ...updPlayers[action.player],
      commanderTax: updPlayers[action.player].commanderTax + 1,
    };
    newState = { ...newState, players: updPlayers };
  }

  // Check for cast triggers ("whenever you cast a spell", "whenever you cast a creature spell")
  newState = checkCastTriggers(newState, card, action.player);

  return newState;
}

/** Activate an ability: pay costs, then put on stack. */
function executeActivateAbility(
  state: GameState,
  action: Extract<GameAction, { type: 'activate-ability' }>
): GameState {
  const player = state.players[action.player];
  const source = player.battlefield.find((p) => p.id === action.sourceId);
  if (!source) return state;

  const ability = source.abilities[action.abilityIndex];
  if (!ability) return state;

  // Use universal cost parser for ALL cost types (mana, tap, sacrifice, life, discard, etc.)
  const cost = parseCostFromString(ability.cost || '');
  if (!canPayAbilityCost(state, action.player, action.sourceId, cost)) return state;
  const newState = payAbilityCost(state, action.player, action.sourceId, cost);

  return addAbilityToStack(newState, action.sourceId, action.abilityIndex, action.player, action.targets);
}

/** Declare attackers: mark creatures as attacking and tap them.
 *  CRITICAL FIX: Creatures with vigilance don't tap when attacking
 */
function executeDeclareAttackers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-attackers' }>
): GameState {
  const player = state.players[action.player];
  const defaultDefenderId: 0 | 1 = action.player === 0 ? 1 : 0;

  const updatedBattlefield = player.battlefield.map((perm) => {
    if (action.attackers.includes(perm.id)) {
      // Check for vigilance keyword (use hasKeyword to avoid false positives
      // from oracle text like "target creature loses vigilance")
      const hasVigilance = hasKeyword(perm, 'vigilance');
      return {
        ...perm,
        attacking: true,
        tapped: !hasVigilance  // Don't tap if has vigilance
      };
    }
    return perm;
  });

  const updatedPlayer = { ...player, battlefield: updatedBattlefield };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  const attackers = action.attackers.map((id) => ({
    permanentId: id,
    defenderId: action.defenderMap?.[id] ?? defaultDefenderId,
  }));
  const combat = {
    ...(state.combat || { blockers: [], currentStep: 'declare-attackers' as const }),
    attackers,
    currentStep: 'declare-attackers' as const,
  };

  const attackerNames = action.attackers
    .map((id) => player.battlefield.find((p) => p.id === id)?.name || id)
    .join(', ');

  let result: GameState = {
    ...state,
    players,
    combat,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: `${player.name} attacks with ${attackerNames}.`,
        actionType: 'declare-attackers',
      },
    ],
  };

  // Check for attack triggers ("whenever ~ attacks", "whenever a creature you control attacks")
  const attackingPerms = action.attackers
    .map((id) => updatedBattlefield.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => p != null);
  if (attackingPerms.length > 0) {
    result = checkAttackTriggers(result, attackingPerms, action.player);
  }

  // Annihilator (CR 702.85): when creature with annihilator attacks, defending player sacrifices permanents
  // Only applies when attacking a player, not a planeswalker
  for (const atkPerm of attackingPerms) {
    const atkDefender = action.defenderMap?.[atkPerm.id] ?? defaultDefenderId;
    if (typeof atkDefender === 'number') {
      result = processAnnihilator(result, atkPerm, atkDefender);
    }
  }

  return result;
}

/** Declare blockers: assign blocking creatures. */
function executeDeclareBlockers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-blockers' }>
): GameState {
  if (!state.combat) return state;

  const player = state.players[action.player];

  const updatedBattlefield = player.battlefield.map((perm) => {
    const block = action.blocks.find((b) => b.blocker === perm.id);
    if (block) return { ...perm, blocking: block.attacker };
    return perm;
  });

  const updatedPlayer = { ...player, battlefield: updatedBattlefield };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  const blockers = action.blocks.map((b) => ({ permanentId: b.blocker, blockingId: b.attacker }));
  const combat = { ...state.combat, blockers, currentStep: 'declare-blockers' as const };

  const blockDescriptions = action.blocks
    .map((b) => player.battlefield.find((p) => p.id === b.blocker)?.name || b.blocker)
    .join(', ');

  return {
    ...state,
    players,
    combat,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: blockDescriptions
          ? `${player.name} blocks with ${blockDescriptions}.`
          : `${player.name} declares no blockers.`,
        actionType: 'declare-blockers',
      },
    ],
  };
}

/** Tap a permanent for mana. Mana abilities don't use the stack. */
function executeTapForMana(
  state: GameState,
  action: Extract<GameAction, { type: 'tap-for-mana' }>
): GameState {
  const player = state.players[action.player];
  const permIndex = player.battlefield.findIndex((p) => p.id === action.permanentId);
  if (permIndex === -1) return state;

  const perm = player.battlefield[permIndex];
  const ability = perm.abilities[action.abilityIndex];
  if (!ability || ability.type !== 'mana') return state;

  // Tap the permanent
  const tappedPerm = { ...perm, tapped: true };
  let updatedBattlefield = [...player.battlefield];
  updatedBattlefield[permIndex] = tappedPerm;

  // Check if ability cost includes sacrifice (e.g., Treasure tokens, Lotus Petal)
  const abilityText = (ability.cost || ability.text || '').toLowerCase();
  const requiresSacrifice = abilityText.includes('sacrifice');

  let updatedPlayer: PlayerState = { ...player, battlefield: updatedBattlefield };

  if (requiresSacrifice) {
    // Remove permanent from battlefield and add to graveyard
    const updatedBf = updatedPlayer.battlefield.filter(p => p.id !== perm.id);
    const cardForGy: import('../types/card.ts').Card = {
      id: perm.id, oracleId: perm.oracleId, name: perm.name, manaCost: perm.manaCost,
      cmc: perm.cmc, typeLine: perm.typeLine, oracleText: perm.oracleText,
      power: perm.power, toughness: perm.toughness, loyalty: perm.loyalty,
      colors: perm.colors, colorIdentity: perm.colorIdentity, rarity: perm.rarity,
      tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
    };
    updatedPlayer = {
      ...updatedPlayer,
      battlefield: updatedBf,
      graveyard: [...updatedPlayer.graveyard, cardForGy],
    };
  }

  // Determine mana produced
  const manaColors = getManaProduction({ ...perm });
  let updatedPool = { ...updatedPlayer.manaPool };

  if (manaColors.length === 0) {
    // Fallback: try to parse from ability text
    const colorMatch = ability.text.match(/\{([WUBRGC])\}/i);
    if (colorMatch) {
      const c = colorMatch[1].toUpperCase() as keyof typeof updatedPool;
      if (c in updatedPool) updatedPool[c]++;
    }
  } else if (manaColors.length === 1) {
    // Single color production
    const c = manaColors[0] as keyof typeof updatedPool;
    if (c in updatedPool) updatedPool[c]++;
  } else if (action.chosenColor) {
    // Multi-color (choice) — use the chosen color
    const c = action.chosenColor as keyof typeof updatedPool;
    if (c in updatedPool) updatedPool[c]++;
  } else {
    // Default: first available color
    const c = manaColors[0] as keyof typeof updatedPool;
    if (c in updatedPool) updatedPool[c]++;
  }

  // Handle multi-mana abilities like Sol Ring ({T}: Add {C}{C})
  const multiMatch = ability.text.match(/add\s+((?:\{[wubrgc]\}){2,})/i);
  if (multiMatch) {
    // Reset pool change — recalculate from the full match
    updatedPool = { ...updatedPlayer.manaPool };
    const symbols = multiMatch[1].match(/\{([wubrgc])\}/gi) || [];
    for (const sym of symbols) {
      const c = sym.replace(/[{}]/g, '').toUpperCase() as keyof typeof updatedPool;
      if (c in updatedPool) updatedPool[c]++;
    }
  }

  updatedPlayer = {
    ...updatedPlayer,
    manaPool: updatedPool,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  return {
    ...state,
    players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: requiresSacrifice
        ? `${player.name} sacrifices ${perm.name} for mana.`
        : `${player.name} taps ${perm.name} for mana.`,
      cardName: perm.name, actionType: 'tap-for-mana',
    }],
  };
}

// ─── Manual Resolution Actions ───

function executeManualMove(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-move' }>
): GameState {
  // Move a card from one zone to another
  const player = state.players[action.player];
  const fromZone = action.from;
  const toZone = action.to;

  // Find the card in the source zone
  const zoneKey = fromZone === 'commandZone' ? 'commandZone' : fromZone;
  const zoneArr = (player as unknown as Record<string, unknown>)[zoneKey] as unknown[];
  if (!Array.isArray(zoneArr)) return state;

  const cardIndex = zoneArr.findIndex((c: unknown) => (c as { id: string }).id === action.cardId);
  if (cardIndex === -1) return state;

  const card = zoneArr[cardIndex];
  const updatedFrom = [...zoneArr];
  updatedFrom.splice(cardIndex, 1);

  const toKey = toZone === 'commandZone' ? 'commandZone' : toZone;
  const toArr = [...((player as unknown as Record<string, unknown>)[toKey] as unknown[] || [])];

  // If moving to battlefield, convert to permanent
  if (toZone === 'battlefield') {
    const perm = cardToPermanent(card as import('../types/card.ts').Card, action.player, state.turn);
    toArr.push(perm);
  } else {
    toArr.push(card);
  }

  const updatedPlayer = { ...player, [zoneKey]: updatedFrom, [toKey]: toArr };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  return {
    ...state, players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player, message: `[Manual] Moved card from ${fromZone} to ${toZone}.`, actionType: 'manual-move',
    }],
  };
}

function executeManualLife(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-life' }>
): GameState {
  const player = state.players[action.targetPlayer];
  const updatedPlayer = { ...player, life: player.life + action.delta };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.targetPlayer] = updatedPlayer;

  const word = action.delta >= 0 ? 'gains' : 'loses';
  return {
    ...state, players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `[Manual] ${player.name} ${word} ${Math.abs(action.delta)} life (${updatedPlayer.life}).`,
      actionType: 'manual-life',
    }],
  };
}

function executeManualCounter(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-counter' }>
): GameState {
  const player = state.players[action.player];
  const permIndex = player.battlefield.findIndex((p) => p.id === action.permanentId);
  if (permIndex === -1) return state;

  const perm = player.battlefield[permIndex];
  const newCounters = { ...perm.counters };
  newCounters[action.counterType] = (newCounters[action.counterType] || 0) + action.delta;
  if (newCounters[action.counterType] <= 0) delete newCounters[action.counterType];

  const updatedPerm = { ...perm, counters: newCounters };
  const updatedBf = [...player.battlefield];
  updatedBf[permIndex] = updatedPerm;

  const updatedPlayer = { ...player, battlefield: updatedBf };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  return {
    ...state, players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `[Manual] ${action.delta > 0 ? '+' : ''}${action.delta} ${action.counterType} counter on ${perm.name}.`,
      actionType: 'manual-counter',
    }],
  };
}

function executeManualPT(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-pt' }>
): GameState {
  const player = state.players[action.player];
  const permIndex = player.battlefield.findIndex((p) => p.id === action.permanentId);
  if (permIndex === -1) return state;

  const perm = player.battlefield[permIndex];
  const updatedPerm = {
    ...perm,
    currentPower: (perm.currentPower ?? 0) + action.powerDelta,
    currentToughness: (perm.currentToughness ?? 0) + action.toughnessDelta,
  };
  const updatedBf = [...player.battlefield];
  updatedBf[permIndex] = updatedPerm;

  const updatedPlayer = { ...player, battlefield: updatedBf };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  return {
    ...state, players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `[Manual] ${perm.name} gets ${action.powerDelta >= 0 ? '+' : ''}${action.powerDelta}/${action.toughnessDelta >= 0 ? '+' : ''}${action.toughnessDelta}.`,
      actionType: 'manual-pt',
    }],
  };
}

function executeManualToken(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-token' }>
): GameState {
  const player = state.players[action.player];
  const tokens: import('../types/permanent.ts').Permanent[] = [];

  for (let i = 0; i < action.qty; i++) {
    const tokenCard: import('../types/card.ts').Card = {
      id: generateCardId(),
      oracleId: `token_${action.name}`,
      name: action.name,
      manaCost: '',
      cmc: 0,
      typeLine: action.typeLine || `Token Creature — ${action.name}`,
      oracleText: '',
      power: String(action.power),
      toughness: String(action.toughness),
      colors: [],
      colorIdentity: [],
      rarity: 'common',
      tags: [],
      imageUrl: '',
      owner: action.player,
    };
    const perm = cardToPermanent(tokenCard, action.player, state.turn);
    perm.summoningSick = true;
    tokens.push(perm);
  }

  const updatedPlayer = { ...player, battlefield: [...player.battlefield, ...tokens] };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  return {
    ...state, players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `[Manual] Creates ${action.qty} ${action.power}/${action.toughness} ${action.name} token(s).`,
      actionType: 'manual-token',
    }],
  };
}

function executeManualDraw(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-draw' }>
): GameState {
  let newState = state;
  for (let i = 0; i < action.count; i++) {
    newState = drawCards(newState, action.targetPlayer, 1);
  }
  return {
    ...newState,
    log: [...newState.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `[Manual] ${state.players[action.targetPlayer].name} draws ${action.count} card(s).`,
      actionType: 'manual-draw',
    }],
  };
}

function executeManualDamage(
  state: GameState,
  action: Extract<GameAction, { type: 'manual-damage' }>
): GameState {
  if (action.targetType === 'player') {
    // UI sends targetId as "player-0" or "player-1" — extract the numeric index
    const parsed = parseInt(action.targetId.replace('player-', ''));
    if (isNaN(parsed) || (parsed !== 0 && parsed !== 1)) return state;
    const targetIdx = parsed as 0 | 1;
    const player = state.players[targetIdx];
    const updatedPlayer = { ...player, life: player.life - action.amount };
    const players = [...state.players] as [PlayerState, PlayerState];
    players[targetIdx] = updatedPlayer;
    return {
      ...state, players,
      log: [...state.log, {
        timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
        player: action.player,
        message: `[Manual] ${action.amount} damage to ${player.name} (${updatedPlayer.life} life).`,
        actionType: 'manual-damage',
      }],
    };
  } else {
    // Damage to permanent
    for (let pi = 0; pi < 2; pi++) {
      const player = state.players[pi as 0 | 1];
      const permIndex = player.battlefield.findIndex((p) => p.id === action.targetId);
      if (permIndex !== -1) {
        const perm = player.battlefield[permIndex];
        const updatedPerm = { ...perm, damage: perm.damage + action.amount };
        const updatedBf = [...player.battlefield];
        updatedBf[permIndex] = updatedPerm;
        const updatedPlayer = { ...player, battlefield: updatedBf };
        const players = [...state.players] as [PlayerState, PlayerState];
        players[pi as 0 | 1] = updatedPlayer;
        return {
          ...state, players,
          log: [...state.log, {
            timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
            player: action.player,
            message: `[Manual] ${action.amount} damage to ${perm.name}.`,
            actionType: 'manual-damage',
          }],
        };
      }
    }
    return state;
  }
}

/** Activate a planeswalker loyalty ability: adjust loyalty, put effect on stack. */
function executeActivateLoyalty(
  state: GameState,
  action: Extract<GameAction, { type: 'activate-loyalty' }>
): GameState {
  const player = state.players[action.player];
  const permIndex = player.battlefield.findIndex(p => p.id === action.permanentId);
  if (permIndex === -1) return state;

  const perm = player.battlefield[permIndex];
  if (perm.currentLoyalty === undefined) return state;

  const ability = perm.abilities[action.abilityIndex];
  if (!ability) return state;

  const loyaltyCost = parseLoyaltyCost(ability.cost || '');
  if (loyaltyCost === null) return state;

  // Adjust loyalty (+ adds, - removes)
  const newLoyalty = perm.currentLoyalty + loyaltyCost;

  // Update permanent with new loyalty and mark as used
  const updatedPerm = {
    ...perm,
    currentLoyalty: newLoyalty,
    loyaltyUsedThisTurn: true,
  };
  const updatedBf = [...player.battlefield];
  updatedBf[permIndex] = updatedPerm;
  const updatedPlayer = { ...player, battlefield: updatedBf };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  let newState: GameState = { ...state, players };

  // Put the ability on the stack for resolution
  newState = addAbilityToStack(
    newState,
    action.permanentId,
    action.abilityIndex,
    action.player,
    action.targets
  );

  // Log the loyalty cost
  const costDisplay = loyaltyCost >= 0 ? `+${loyaltyCost}` : `${loyaltyCost}`;
  newState = {
    ...newState,
    log: [...newState.log, {
      timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
      player: action.player,
      message: `${perm.name} [${costDisplay}]: ${ability.text.replace(/^\[[^\]]+\]:\s*/, '')} (loyalty: ${newLoyalty})`,
      cardName: perm.name,
      actionType: 'activate-loyalty',
    }],
  };

  return newState;
}

/** Equip: attach an equipment to a target creature (pays equip cost, sorcery speed). */
function executeEquip(
  state: GameState,
  action: Extract<GameAction, { type: 'equip' }>
): GameState {
  const player = state.players[action.player];
  const equipment = player.battlefield.find(p => p.id === action.equipmentId);
  if (!equipment) return state;

  // Pay equip cost (auto-tap if needed)
  const equipCostStr = getEquipCost(equipment);
  if (equipCostStr) {
    const cost = parseManaCost(equipCostStr);
    let currentPlayer = player;

    if (!canPayCost(currentPlayer.manaPool, cost, currentPlayer.life)) {
      const tapResult = autoTapLandsForCost(currentPlayer, cost);
      if (tapResult) {
        currentPlayer = tapResult.updatedPlayer;
      } else {
        return state; // Can't pay
      }
    }

    const payment = autoPayCost(currentPlayer.manaPool, cost, currentPlayer.life);
    if (!payment) return state; // shouldn't happen since we already checked
    const newPool = payCost(currentPlayer.manaPool, cost, payment);
    const updatedPlayer = { ...currentPlayer, manaPool: newPool };
    const players = [...state.players] as [PlayerState, PlayerState];
    players[action.player] = updatedPlayer;
    state = { ...state, players };
  }

  // Attach equipment to creature
  return attachEquipment(state, action.equipmentId, action.targetCreatureId, action.player);
}

/** Concede the game. */
function executeConcede(
  state: GameState,
  action: Extract<GameAction, { type: 'concede' }>
): GameState {
  const winner: 0 | 1 = action.player === 0 ? 1 : 0;

  return {
    ...state,
    winner,
    gameOver: true,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: `${state.players[action.player].name} concedes. ${state.players[winner].name} wins!`,
        actionType: 'concede',
      },
    ],
  };
}

function executeDiscard(
  state: GameState,
  action: Extract<GameAction, { type: 'discard' }>
): GameState {
  const player = state.players[action.player];
  const discardSet = new Set(action.cardIds);
  const discarded = player.hand.filter((c) => discardSet.has(c.id));
  const remaining = player.hand.filter((c) => !discardSet.has(c.id));

  const updatedPlayer = {
    ...player,
    hand: remaining,
    graveyard: [...player.graveyard, ...discarded],
  };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  const cardNames = discarded.map((c) => c.name).join(', ');

  return {
    ...state,
    players,
    pendingDiscard: null,
    pendingDiscardCount: 0,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `${player.name} discards ${discarded.length} card(s): ${cardNames}.`,
      actionType: 'discard',
    }],
  };
}

/** Strip permanent-only fields to get a Card back (for graveyard/exile) */
function permanentToCard(perm: import('../types/permanent.ts').Permanent): import('../types/card.ts').Card {
  return {
    id: perm.id,
    oracleId: perm.oracleId,
    name: perm.name,
    manaCost: perm.manaCost,
    cmc: perm.cmc,
    typeLine: perm.typeLine,
    oracleText: perm.oracleText,
    power: perm.power,
    toughness: perm.toughness,
    loyalty: perm.loyalty,
    colors: perm.colors,
    colorIdentity: perm.colorIdentity,
    rarity: perm.rarity,
    tags: perm.tags,
    imageUrl: perm.imageUrl,
    owner: perm.owner,
  };
}

/** Execute a legend rule choice: keep one legendary permanent, sacrifice the rest. */
function executeLegendChoice(
  state: GameState,
  action: Extract<GameAction, { type: 'legend-choice' }>
): GameState {
  if (!state.pendingLegendChoice) return state;

  const { player, legendName, permanentIds } = state.pendingLegendChoice;
  const toRemove = permanentIds.filter(id => id !== action.keepPermanentId);

  const playerState = state.players[player];
  const dying = playerState.battlefield.filter(p => toRemove.includes(p.id));
  const surviving = playerState.battlefield.filter(p => !toRemove.includes(p.id));

  const players = [...state.players] as [PlayerState, PlayerState];
  players[player] = {
    ...playerState,
    battlefield: surviving,
  };

  // Move dying legends to owner's graveyard (CR 400.3)
  for (const perm of dying) {
    const ownerIdx: 0 | 1 = perm.owner ?? player;
    const card = permanentToCard(perm);
    players[ownerIdx] = {
      ...players[ownerIdx],
      graveyard: [...players[ownerIdx].graveyard, card],
    };
  }

  return {
    ...state,
    players,
    pendingLegendChoice: null,
    log: [...state.log, {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player,
      message: `${legendName}: kept chosen copy (legend rule).`,
      cardName: legendName,
    }],
  };
}

/** Execute combat damage assignment for multi-blocker scenarios (CR 510.1). */
function executeAssignDamage(
  state: GameState,
  action: Extract<GameAction, { type: 'assign-damage' }>
): GameState {
  if (!state.pendingDamageAssignment) return state;

  // Validate the assignment
  const error = validateDamageAssignment(state, action.assignments, action.trampleDamage);
  if (error) {
    return {
      ...state,
      log: [...state.log, {
        timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
        player: action.player,
        message: `Invalid damage assignment: ${error}`,
      }],
    };
  }

  // Apply the assignment
  return applyDamageAssignment(state, action.assignments, action.trampleDamage);
}

/** Execute commander zone replacement choice (2020 rule change). */
function executeCommanderZoneChoice(
  state: GameState,
  action: Extract<GameAction, { type: 'commander-zone-choice' }>
): GameState {
  if (!state.pendingCommanderChoice) return state;

  const { player, commanderName, currentZone } = state.pendingCommanderChoice;

  if (action.moveToCommandZone) {
    // Move from graveyard/exile to command zone
    if (currentZone === 'graveyard') {
      return handleCommanderDeath({ ...state, pendingCommanderChoice: null }, commanderName, player);
    } else {
      return handleCommanderExile({ ...state, pendingCommanderChoice: null }, commanderName, player);
    }
  } else {
    // Player chose to leave commander where it is
    return {
      ...state,
      pendingCommanderChoice: null,
      log: [...state.log, {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${commanderName} stays in ${currentZone}.`,
        cardName: commanderName,
      }],
    };
  }
}

/**
 * Turn a face-down creature face-up (morph, CR 702.36).
 * This is a special action that doesn't use the stack.
 */
function executeTurnFaceUp(
  state: GameState,
  action: Extract<GameAction, { type: 'turn-face-up' }>
): GameState {
  const player = action.player;
  const ps = state.players[player];
  const idx = ps.battlefield.findIndex(p => p.id === action.permanentId);
  if (idx === -1) return state;

  const perm = ps.battlefield[idx];
  if (!perm.faceDown) return state;

  // Parse morph cost and pay it
  const morphMatch = perm.oracleText?.match(/morph\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  if (!morphMatch) return state;

  const cost = parseManaCost(morphMatch[1]);
  let updatedPlayer = ps;
  if (!canPayCost(updatedPlayer.manaPool, cost, updatedPlayer.life)) {
    const tapResult = autoTapLandsForCost(updatedPlayer, cost);
    if (!tapResult) return state;
    updatedPlayer = tapResult.updatedPlayer;
  }
  const payment = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const newPool = payCost(updatedPlayer.manaPool, cost, payment);
  updatedPlayer = { ...updatedPlayer, manaPool: newPool };

  // Flip face-up: restore original stats, re-parse abilities
  const basePower = perm.power ? parseInt(perm.power, 10) || 0 : undefined;
  const baseToughness = perm.toughness ? parseInt(perm.toughness, 10) || 0 : undefined;
  const flippedPerm: Permanent = {
    ...perm,
    faceDown: false,
    basePower,
    baseToughness,
    currentPower: basePower,
    currentToughness: baseToughness,
    abilities: parseAbilities(perm as unknown as import('../types/card.ts').Card),
  };

  const newBf = [...updatedPlayer.battlefield];
  newBf[idx] = flippedPerm;
  updatedPlayer = { ...updatedPlayer, battlefield: newBf };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[player] = updatedPlayer;

  return {
    ...state,
    players,
    log: [...state.log, {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player,
      message: `${perm.name} is turned face-up (morph cost: ${morphMatch[1]}).`,
      cardName: perm.name,
    }],
  };
}

/** Execute cycling a card from hand (CR 702.28) */
function executeCycle(
  state: GameState,
  action: Extract<GameAction, { type: 'cycle' }>
): GameState {
  let player = state.players[action.player];
  const cardIndex = player.hand.findIndex(c => c.id === action.cardId);
  if (cardIndex === -1) return state;
  const card = player.hand[cardIndex];

  // Parse cycling cost
  const cycleMatch = card.oracleText?.match(/cycling\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  if (!cycleMatch) return state;
  const cost = parseManaCost(cycleMatch[1]);

  // Pay cost
  let payment = {} as ManaPayment;
  if (!canPayCost(player.manaPool, cost, player.life)) {
    const tapResult = autoTapLandsForCost(player, cost);
    if (tapResult) {
      player = tapResult.updatedPlayer;
      payment = tapResult.payment;
    }
  }
  const newPool = payCost(player.manaPool, cost, payment);

  // Move card from hand to graveyard
  const updatedHand = [...player.hand.slice(0, cardIndex), ...player.hand.slice(cardIndex + 1)];

  // Draw a card
  const drawnCard = player.library[0];
  const updatedLibrary = player.library.slice(1);
  const finalHand = drawnCard ? [...updatedHand, drawnCard] : updatedHand;

  const updatedPlayer: PlayerState = {
    ...player,
    hand: finalHand,
    library: updatedLibrary,
    graveyard: [...player.graveyard, card],
    manaPool: newPool,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  return {
    ...state,
    players,
    log: [...state.log, {
      timestamp: Date.now(), turn: state.turn, phase: state.phase, step: state.step,
      player: action.player,
      message: `${card.name} cycled for ${cycleMatch[1]}.${drawnCard ? ` Drew a card.` : ''}`,
      cardName: card.name,
      actionType: 'cycle',
    }],
  };
}
