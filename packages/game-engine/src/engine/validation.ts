import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import { isLand, isInstant, hasFlash } from '../types/card.ts';
import { canPayCost, parseManaCost, autoTapLandsForCost } from '../rules/mana.ts';
import { canPlayerAct } from '../rules/priority.ts';
import { hasKeyword, canBlock } from '../rules/combat.ts';
import { isEquipment, getEquipCost } from '../rules/equipment.ts';
import { parseLoyaltyCost } from '../rules/abilities.ts';
import { hasProtectionFrom } from '../rules/combat.ts';

/**
 * Validate whether a game action is legal in the current state.
 * Returns an error message if illegal, or null if legal.
 */
export function validateAction(
  state: GameState,
  action: GameAction
): string | null {
  if (state.gameOver) return 'Game is over.';

  // Concede is always valid
  if (action.type === 'concede') return null;

  // Mulligan is only valid during mulligan phase
  if (action.type === 'mulligan') {
    if (!state.mulliganPhase) return 'Not in mulligan phase.';
    return null;
  }

  // Pass is always valid when you have priority (even during untap/cleanup)
  if (action.type === 'pass') {
    if (state.priorityPlayer !== action.player) return 'Not your priority.';
    return null;
  }

  // Priority check (blocks non-pass actions during untap/cleanup)
  if (!canPlayerAct(state, action.player)) {
    return 'Not your priority.';
  }

  // CR 702.61: Split Second — while a spell with split second is on the stack,
  // players can't cast spells or activate non-mana abilities.
  if (state.stack.length > 0 && action.type !== 'tap-for-mana') {
    const hasSplitSecond = state.stack.some(
      (obj) => obj.card?.oracleText?.toLowerCase().includes('split second') ||
               obj.text?.toLowerCase().includes('split second')
    );
    if (hasSplitSecond && (
      action.type === 'cast-spell' ||
      action.type === 'activate-ability' ||
      action.type === 'activate-loyalty' ||
      action.type === 'equip'
    )) {
      return 'Cannot cast spells or activate abilities while a spell with split second is on the stack.';
    }
  }

  switch (action.type) {
    case 'play-land':
      return validatePlayLand(state, action);
    case 'cast-spell':
      return validateCastSpell(state, action);
    case 'activate-ability':
      return validateActivateAbility(state, action);
    case 'declare-attackers':
      return validateDeclareAttackers(state, action);
    case 'declare-blockers':
      return validateDeclareBlockers(state, action);
    case 'tap-for-mana':
      return validateTapForMana(state, action);
    case 'equip':
      return validateEquip(state, action);
    case 'activate-loyalty':
      return validateActivateLoyalty(state, action);
    // Manual resolution actions are always valid for the priority player
    case 'manual-move':
    case 'manual-life':
    case 'manual-counter':
    case 'manual-pt':
    case 'manual-token':
    case 'manual-draw':
    case 'manual-damage':
    case 'manual-done':
      return null;
    case 'discard':
      return validateDiscard(state, action);
    case 'legend-choice':
      return validateLegendChoice(state, action);
    case 'commander-zone-choice':
      return validateCommanderZoneChoice(state, action);
    case 'turn-face-up':
      return validateTurnFaceUp(state, action);
    case 'cycle':
      return validateCycle(state, action);
    case 'assign-damage':
      if (!state.pendingDamageAssignment) return 'No pending damage assignment.';
      if (state.pendingDamageAssignment.player !== action.player) return 'Not your damage assignment.';
      return null;
    default:
      return 'Unknown action type.';
  }
}

/** Check if an action is legal (boolean shorthand) */
export function isLegalAction(state: GameState, action: GameAction): boolean {
  return validateAction(state, action) === null;
}

/**
 * Get all legal action types for the current priority player.
 */
export function getLegalActionTypes(state: GameState): GameAction['type'][] {
  const player = state.priorityPlayer;
  const types: GameAction['type'][] = [];

  if (state.gameOver) return [];
  
  // During mulligan phase, only mulligan is legal (plus concede)
  if (state.mulliganPhase) {
    types.push('mulligan', 'concede');
    return types;
  }

  // In untap/cleanup, only pass and concede are legal (no other actions)
  if (!canPlayerAct(state, player)) {
    types.push('pass', 'concede');
    return types;
  }

  // If a player needs to discard, that's the only legal action (besides concede)
  if (state.pendingDiscard === player) {
    types.push('discard', 'concede');
    return types;
  }

  // If there's a pending legend rule choice for this player, that's the only action
  if (state.pendingLegendChoice && state.pendingLegendChoice.player === player) {
    types.push('legend-choice', 'concede');
    return types;
  }

  // If there's a pending commander zone choice for this player, that's the only action
  if (state.pendingCommanderChoice && state.pendingCommanderChoice.player === player) {
    types.push('commander-zone-choice', 'concede');
    return types;
  }

  // If there's a pending damage assignment for this player, that's the only action
  if (state.pendingDamageAssignment && state.pendingDamageAssignment.player === player) {
    types.push('assign-damage', 'concede');
    return types;
  }

  types.push('pass', 'concede');

  // CR 702.61: Split Second blocks spells and non-mana abilities
  const hasSplitSecond = state.stack.some(
    (obj) => obj.card?.oracleText?.toLowerCase().includes('split second') ||
             obj.text?.toLowerCase().includes('split second')
  );
  if (hasSplitSecond) {
    // Only mana abilities allowed during split second
    if (canTapAnyForMana(state, player)) types.push('tap-for-mana');
    return types;
  }

  if (canPlayLand(state, player)) types.push('play-land');
  if (canCastAnySpell(state, player)) types.push('cast-spell');
  if (canCycleAny(state, player)) types.push('cycle');
  if (canActivateAnyAbility(state, player)) types.push('activate-ability');
  if (canTapAnyForMana(state, player)) types.push('tap-for-mana');
  if (canEquipAny(state, player)) types.push('equip');
  if (canActivateAnyLoyalty(state, player)) types.push('activate-loyalty');

  if (
    state.step === 'declare-attackers' &&
    state.activePlayer === player &&
    hasUntappedCreatures(state, player)
  ) {
    types.push('declare-attackers');
  }

  if (
    state.step === 'declare-blockers' &&
    state.activePlayer !== player &&
    state.combat &&
    state.combat.attackers.length > 0
  ) {
    types.push('declare-blockers');
  }

  return types;
}

// --- Validators ---

function validatePlayLand(
  state: GameState,
  action: Extract<GameAction, { type: 'play-land' }>
): string | null {
  const player = state.players[action.player];

  if (state.step !== 'main') return 'Can only play lands during main phase.';
  if (state.activePlayer !== action.player) return 'Only active player can play lands.';
  if (player.landsPlayedThisTurn >= player.maxLandPlays) return 'Already played maximum lands this turn.';
  if (state.stack.length > 0) return 'Cannot play lands while stack is not empty.';

  const card = player.hand.find((c) => c.id === action.cardId);
  if (!card) return 'Card not in hand.';
  if (!isLand(card)) return 'Card is not a land.';

  return null;
}

/** Parse flashback cost from oracle text */
function getFlashbackCost(card: Card): string | null {
  const match = card.oracleText?.match(/flashback\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  return match ? match[1] : null;
}

/** Parse kicker cost from oracle text */
function getKickerCost(card: Card): string | null {
  const match = card.oracleText?.match(/kicker\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  return match ? match[1] : null;
}

function validateCastSpell(
  state: GameState,
  action: Extract<GameAction, { type: 'cast-spell' }>
): string | null {
  const player = state.players[action.player];

  // ─── Flashback: card comes from graveyard ───
  if (action.castWithFlashback) {
    const card = player.graveyard.find((c) => c.id === action.cardId);
    if (!card) return 'Card not in graveyard.';
    const fbCost = getFlashbackCost(card);
    if (!fbCost) return 'Card does not have flashback.';
    // Validate flashback cost instead of normal cost
    const cost = parseManaCost(fbCost);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to pay flashback cost.';
    }
    // Timing: flashback instants at any time, sorceries at sorcery speed
    if (!isInstant(card) && !hasFlash(card)) {
      if (state.step !== 'main') return 'Can only flashback sorcery-speed spells during main phase.';
      if (state.activePlayer !== action.player) return 'Can only flashback sorcery-speed spells on your turn.';
      if (state.stack.length > 0) return 'Cannot flashback sorcery-speed spells while stack is not empty.';
    }
    return validateTargetLegality(state, action.player, action.targets, card);
  }

  // ─── Adventure: cast adventure half from hand ───
  if (action.castAsAdventure) {
    const card = player.hand.find((c) => c.id === action.cardId);
    if (!card) return 'Card not in hand.';
    if (!card.adventureCost) return 'Card does not have an adventure.';
    const cost = parseManaCost(card.adventureCost);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to cast adventure.';
    }
    // Adventure timing based on adventure type line
    const advTypeLine = (card.adventureTypeLine || '').toLowerCase();
    if (!advTypeLine.includes('instant')) {
      if (state.step !== 'main') return 'Can only cast sorcery-speed adventures during main phase.';
      if (state.activePlayer !== action.player) return 'Can only cast sorcery-speed adventures on your turn.';
      if (state.stack.length > 0) return 'Cannot cast sorcery-speed adventures while stack is not empty.';
    }
    return validateTargetLegality(state, action.player, action.targets, card);
  }

  // ─── MDFC: cast back face (CR 712) ───
  if (action.castBackFace) {
    const card = player.hand.find((c) => c.id === action.cardId);
    if (!card) return 'Card not in hand.';
    if (card.layout !== 'modal_dfc' || !card.backFace) return 'Card is not a modal DFC.';
    const bf = card.backFace;
    // If back face is a land, validate as land play
    if (bf.typeLine.toLowerCase().includes('land')) {
      if (state.step !== 'main') return 'Can only play lands during main phase.';
      if (state.activePlayer !== action.player) return 'Only active player can play lands.';
      if (state.stack.length > 0) return 'Cannot play lands while stack is not empty.';
      if (player.landsPlayedThisTurn >= player.maxLandPlays) return 'Already played maximum lands this turn.';
      return null;
    }
    // Back face is a spell — use its mana cost
    const cost = parseManaCost(bf.manaCost);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to cast back face.';
    }
    // Timing based on back face type
    const bfType = bf.typeLine.toLowerCase();
    if (!bfType.includes('instant')) {
      if (state.step !== 'main') return 'Can only cast sorcery-speed back face during main phase.';
      if (state.activePlayer !== action.player) return 'Can only cast back face on your turn.';
      if (state.stack.length > 0) return 'Cannot cast sorcery-speed back face while stack is not empty.';
    }
    return validateTargetLegality(state, action.player, action.targets, card);
  }

  // ─── Cast adventure creature from exile (CR 715.4) ───
  const exileAdventure = player.exile.find(c => c.id === action.cardId && c.onAdventure);
  if (exileAdventure) {
    // Cast the creature side from exile
    if (state.step !== 'main' && !hasFlash(exileAdventure)) {
      return 'Can only cast creature from exile during main phase.';
    }
    if (!hasFlash(exileAdventure)) {
      if (state.activePlayer !== action.player) return 'Can only cast from exile on your turn.';
      if (state.stack.length > 0) return 'Cannot cast from exile while stack is not empty.';
    }
    const cost = parseManaCost(exileAdventure.manaCost);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to cast creature from exile.';
    }
    return validateTargetLegality(state, action.player, action.targets, exileAdventure);
  }

  // ─── Morph: cast face-down for {3} (CR 702.36) ───
  if (action.castFaceDown) {
    const morphCard = player.hand.find((c) => c.id === action.cardId);
    if (!morphCard) return 'Card not in hand.';
    if (!morphCard.oracleText?.toLowerCase().includes('morph')) return 'Card does not have morph.';
    // Morph is sorcery speed
    if (state.step !== 'main') return 'Can only cast face-down during main phase.';
    if (state.activePlayer !== action.player) return 'Can only cast face-down on your turn.';
    if (state.stack.length > 0) return 'Cannot cast face-down while stack is not empty.';
    // Cost is always {3}
    const cost = parseManaCost('{3}');
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to cast face-down ({3}).';
    }
    return null;
  }

  // ─── Madness: cast from exile for madness cost (CR 702.34) ───
  if (action.castWithMadness) {
    const madnessCard = player.exile.find((c) => c.id === action.cardId && (c as any).madnessExile);
    if (!madnessCard) return 'Card not in exile with madness.';
    const madnessMatch = madnessCard.oracleText?.match(/madness\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    if (!madnessMatch) return 'Card does not have madness.';
    const cost = parseManaCost(madnessMatch[1]);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to cast for madness cost.';
    }
    // Madness can be cast at instant speed (CR 702.34b)
    return validateTargetLegality(state, action.player, action.targets, madnessCard);
  }

  // ─── Evoke: alternative cost (CR 702.73) ───
  if (action.evokePaid) {
    const evokeCard = player.hand.find((c) => c.id === action.cardId);
    if (!evokeCard) return 'Card not in hand.';
    const evokeMatch = evokeCard.oracleText?.match(/evoke\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    if (!evokeMatch) return 'Card does not have evoke.';
    const cost = parseManaCost(evokeMatch[1]);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to pay evoke cost.';
    }
    // Evoke is sorcery speed (creature)
    if (state.step !== 'main') return 'Can only evoke during main phase.';
    if (state.activePlayer !== action.player) return 'Can only evoke on your turn.';
    if (state.stack.length > 0) return 'Cannot evoke while stack is not empty.';
    return null;
  }

  // ─── Dash: alternative cost (CR 702.108) ───
  if (action.dashPaid) {
    const dashCard = player.hand.find((c) => c.id === action.cardId);
    if (!dashCard) return 'Card not in hand.';
    const dashMatch = dashCard.oracleText?.match(/dash\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    if (!dashMatch) return 'Card does not have dash.';
    const cost = parseManaCost(dashMatch[1]);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to pay dash cost.';
    }
    // Dash is sorcery speed
    if (state.step !== 'main') return 'Can only dash during main phase.';
    if (state.activePlayer !== action.player) return 'Can only dash on your turn.';
    if (state.stack.length > 0) return 'Cannot dash while stack is not empty.';
    return null;
  }

  // ─── Normal cast from hand ───
  const card = player.hand.find((c) => c.id === action.cardId);
  if (!card) return 'Card not in hand.';
  if (isLand(card)) return 'Lands are played, not cast.';

  // Non-main phase: only instants and flash
  if (state.step !== 'main') {
    if (!isInstant(card) && !hasFlash(card)) {
      return 'Can only cast instants or flash spells outside main phase.';
    }
  }

  // Sorcery-speed: only during main phase with empty stack, active player
  if (!isInstant(card) && !hasFlash(card)) {
    if (state.activePlayer !== action.player) return 'Can only cast sorcery-speed spells on your turn.';
    if (state.stack.length > 0) return 'Cannot cast sorcery-speed spells while stack is not empty.';
  }

  // Handle X-cost spells: replace {X} with the actual X value
  const xValue = action.xValue ?? 0;
  let manaCostStr = card.manaCost;
  if (manaCostStr.includes('{X}')) {
    manaCostStr = manaCostStr.replace(/\{X\}/g, xValue > 0 ? `{${xValue}}` : '');
  }

  // Kicker: add kicker cost to total if paid (CR 702.32)
  if (action.kickerPaid) {
    const kickerCostStr = getKickerCost(card);
    if (kickerCostStr) {
      manaCostStr += kickerCostStr;
    }
  }

  // Convoke: reduce cost by tapped creatures' colors (CR 702.50)
  let convokeReduction = 0;
  if (action.convokeCreatures && action.convokeCreatures.length > 0) {
    if (!card.oracleText?.toLowerCase().includes('convoke')) {
      return 'Card does not have convoke.';
    }
    convokeReduction = action.convokeCreatures.length;
  }

  // Delve: reduce generic cost by exiled GY cards (CR 702.65)
  let delveReduction = 0;
  if (action.delveCards && action.delveCards.length > 0) {
    if (!card.oracleText?.toLowerCase().includes('delve')) {
      return 'Card does not have delve.';
    }
    delveReduction = action.delveCards.length;
  }

  let cost = parseManaCost(manaCostStr);

  // Apply convoke/delve reductions to generic mana
  if (convokeReduction > 0 || delveReduction > 0) {
    const totalReduction = convokeReduction + delveReduction;
    cost = { ...cost, generic: Math.max(0, cost.generic - totalReduction) };
  }

  // Check if we can pay with existing pool OR by auto-tapping lands
  if (!canPayCost(player.manaPool, cost, player.life)) {
    const tapResult = autoTapLandsForCost(player, cost);
    if (!tapResult) {
      return 'Not enough mana to cast this spell.';
    }
  }

  // ─── Hexproof / Shroud / Protection targeting checks ───
  const targetError = validateTargetLegality(state, action.player, action.targets, card);
  if (targetError) return targetError;

  // CR 702.21: Ward — targeting a permanent with ward requires paying an additional cost.
  // Ward cost is added to the total spell cost. If unpayable, casting is blocked.
  let totalWardCost = 0;
  for (const target of action.targets) {
    if (target.type !== 'permanent') continue;
    for (let pi = 0; pi < 2; pi++) {
      const targetPerm = state.players[pi as 0 | 1].battlefield.find(p => p.id === target.id);
      if (!targetPerm) continue;
      if (targetPerm.controller === action.player) continue;
      const wardMatch = (targetPerm.oracleText || '').toLowerCase().match(/ward[\s—]+\{(\d+)\}/);
      if (wardMatch) {
        totalWardCost += parseInt(wardMatch[1], 10);
      }
    }
  }
  if (totalWardCost > 0) {
    // Re-check affordability with ward added to generic cost
    const wardAugmented = { ...cost, generic: cost.generic + totalWardCost };
    if (!canPayCost(player.manaPool, wardAugmented, player.life)) {
      const tapResult = autoTapLandsForCost(player, wardAugmented);
      if (!tapResult) {
        return `Not enough mana to pay ward cost ({${totalWardCost}} additional).`;
      }
    }
  }

  return null;
}

/**
 * Validate that all permanent targets are legally targetable.
 * Checks hexproof, shroud, and protection from colors.
 */
function validateTargetLegality(
  state: GameState,
  caster: 0 | 1,
  targets: import('../types/action.ts').Target[],
  sourceCard?: import('../types/card.ts').Card,
): string | null {
  for (const target of targets) {
    if (target.type !== 'permanent') continue;

    // Find the targeted permanent
    for (let pi = 0; pi < 2; pi++) {
      const player = state.players[pi as 0 | 1];
      const perm = player.battlefield.find(p => p.id === target.id);
      if (!perm) continue;

      // Shroud: can't be targeted by ANY player (including controller)
      if (hasKeyword(perm, 'shroud')) {
        return `${perm.name} has shroud and cannot be targeted.`;
      }

      // Hexproof: can't be targeted by OPPONENTS (controller can still target)
      if (hasKeyword(perm, 'hexproof') && perm.controller !== caster) {
        return `${perm.name} has hexproof and cannot be targeted by opponents.`;
      }

      // Ward: opponent targeting this permanent must pay an additional cost.
      // Check for ward keyword in oracle text
      const wardMatch = (perm.oracleText || '').toLowerCase().match(/ward[\s—]+\{(\d+)\}/);
      if (wardMatch && perm.controller !== caster) {
        // Ward detected — in a full implementation this would require payment.
        // For now we allow targeting but log a warning.
        // The UI can use this info to prompt the player.
      }

      // Protection from [color]: can't be targeted by spells/abilities of that color (DEBT: Targeting)
      const oracleText = (perm.oracleText || '').toLowerCase();
      if (sourceCard && sourceCard.colors.length > 0) {
        const colorMap: Record<string, string> = {
          W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green'
        };
        for (const color of sourceCard.colors) {
          const colorName = colorMap[color];
          if (colorName && oracleText.includes(`protection from ${colorName}`)) {
            return `${perm.name} has protection from ${colorName} and cannot be targeted.`;
          }
        }
        // Protection from all colors
        if (oracleText.includes('protection from all colors')) {
          return `${perm.name} has protection from all colors and cannot be targeted.`;
        }
        // Protection from multicolored
        if (oracleText.includes('protection from multicolored') && sourceCard.colors.length > 1) {
          return `${perm.name} has protection from multicolored and cannot be targeted.`;
        }
      }
      // Protection from everything (blocks ALL targeting regardless of source)
      if (oracleText.includes('protection from everything')) {
        return `${perm.name} has protection from everything and cannot be targeted.`;
      }
      // Protection from creature types (e.g., "protection from Goblins")
      if (sourceCard) {
        const protMatch = oracleText.match(/protection from (\w+)s?\b/gi);
        if (protMatch) {
          const sourceType = (sourceCard.typeLine || '').toLowerCase();
          for (const prot of protMatch) {
            const protType = prot.replace(/protection from /i, '').replace(/s$/, '').toLowerCase();
            // Skip color-based protection (already handled above)
            if (['white','blue','black','red','green','all','multicolored','everything','each'].includes(protType)) continue;
            if (sourceType.includes(protType)) {
              return `${perm.name} has ${prot} and cannot be targeted.`;
            }
          }
        }
      }
    }
  }

  return null;
}

function validateActivateAbility(
  state: GameState,
  action: Extract<GameAction, { type: 'activate-ability' }>
): string | null {
  const player = state.players[action.player];
  const source = player.battlefield.find((p) => p.id === action.sourceId);
  if (!source) return 'Permanent not on battlefield.';

  const ability = source.abilities[action.abilityIndex];
  if (!ability) return 'Ability not found on permanent.';
  if (ability.type === 'mana') return 'Use tap-for-mana action for mana abilities.';

  if (!ability.instantSpeed) {
    if (state.step !== 'main') return 'Can only activate this ability during main phase.';
    if (state.stack.length > 0) return 'Cannot activate sorcery-speed ability while stack is not empty.';
  }

  // {T} cost: permanent must be untapped
  if (ability.cost && ability.cost.toLowerCase().includes('{t}')) {
    if (source.tapped) return `${source.name} is already tapped.`;
    // Creatures with summoning sickness can't use tap abilities
    if (source.summoningSick && source.currentPower !== undefined && !hasKeyword(source, 'haste')) {
      return `${source.name} has summoning sickness and cannot activate tap abilities.`;
    }
  }

  // Check hexproof/shroud/protection for ability targets
  const targetError = validateTargetLegality(state, action.player, action.targets);
  if (targetError) return targetError;

  return null;
}

function validateDeclareAttackers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-attackers' }>
): string | null {
  if (state.step !== 'declare-attackers') return 'Not the declare attackers step.';
  if (state.activePlayer !== action.player) return 'Only active player can declare attackers.';

  const player = state.players[action.player];
  const opponentIdx: 0 | 1 = action.player === 0 ? 1 : 0;

  for (const attackerId of action.attackers) {
    const creature = player.battlefield.find((p) => p.id === attackerId);
    if (!creature) return `Creature ${attackerId} not on battlefield.`;
    if (creature.currentPower === undefined) return `${creature.name} is not a creature.`;
    if (creature.tapped) return `${creature.name} is tapped.`;
    if (creature.summoningSick && !hasKeyword(creature, 'haste')) return `${creature.name} has summoning sickness.`;
    if (hasKeyword(creature, 'defender')) return `${creature.name} has defender and cannot attack.`;

    // Validate planeswalker targets from defenderMap
    if (action.defenderMap) {
      const defenderId = action.defenderMap[attackerId];
      if (typeof defenderId === 'string') {
        // String defenderId = attacking a planeswalker
        const opponentBf = state.players[opponentIdx].battlefield;
        const pw = opponentBf.find(p => p.id === defenderId);
        if (!pw) return `Planeswalker target ${defenderId} not on opponent's battlefield.`;
        if (!pw.typeLine.toLowerCase().includes('planeswalker')) {
          return `${pw.name} is not a planeswalker.`;
        }
      }
    }
  }

  return null;
}

function validateDeclareBlockers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-blockers' }>
): string | null {
  if (state.step !== 'declare-blockers') return 'Not the declare blockers step.';
  if (state.activePlayer === action.player) return 'Active player cannot declare blockers.';
  if (!state.combat) return 'No combat in progress.';

  const player = state.players[action.player];
  const attackingPlayer = state.players[state.activePlayer];

  // Track how many blockers each attacker has (for menace check)
  const blockerCountPerAttacker = new Map<string, number>();

  for (const block of action.blocks) {
    const blocker = player.battlefield.find((p) => p.id === block.blocker);
    if (!blocker) return `Blocker ${block.blocker} not on battlefield.`;
    if (blocker.tapped) return `${blocker.name} is tapped and cannot block.`;

    const attackerEntry = state.combat.attackers.find((a) => a.permanentId === block.attacker);
    if (!attackerEntry) return `Attacker ${block.attacker} not found.`;

    // Find the attacker permanent for evasion checks
    const attackerPerm = attackingPlayer.battlefield.find((p) => p.id === block.attacker);
    if (attackerPerm) {
      if (!canBlock(blocker, attackerPerm, player.battlefield)) {
        // Flying check
        if (hasKeyword(attackerPerm, 'flying') && !hasKeyword(blocker, 'flying') && !hasKeyword(blocker, 'reach')) {
          return `${blocker.name} cannot block ${attackerPerm.name} (flying).`;
        }
        return `${blocker.name} cannot block ${attackerPerm.name}.`;
      }
    }

    // Count blockers per attacker for menace
    blockerCountPerAttacker.set(block.attacker, (blockerCountPerAttacker.get(block.attacker) || 0) + 1);
  }

  // Menace check: if an attacker with menace is blocked, it must be blocked by 2+
  // Generalized: "can't be blocked except by N or more creatures"
  for (const [attackerId, count] of blockerCountPerAttacker) {
    const attackerPerm = attackingPlayer.battlefield.find((p) => p.id === attackerId);
    if (!attackerPerm) continue;

    // Check menace (requires 2+ blockers)
    if (hasKeyword(attackerPerm, 'menace') && count < 2) {
      return `${attackerPerm.name} has menace and must be blocked by at least two creatures.`;
    }

    // Check generalized "can't be blocked except by N or more creatures"
    const nOrMore = attackerPerm.oracleText?.match(/can't\s+be\s+blocked\s+except\s+by\s+(\w+)\s+or\s+more\s+creatures/i);
    if (nOrMore) {
      const numWords: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
      const required = numWords[nOrMore[1].toLowerCase()] || parseInt(nOrMore[1], 10) || 2;
      if (count < required) {
        return `${attackerPerm.name} can only be blocked by ${required} or more creatures.`;
      }
    }
  }

  return null;
}

// --- Helpers ---

function canPlayLand(state: GameState, player: 0 | 1): boolean {
  if (state.step !== 'main' || state.activePlayer !== player || state.stack.length > 0) return false;
  const ps = state.players[player];
  return ps.landsPlayedThisTurn < ps.maxLandPlays && ps.hand.some((c) => isLand(c));
}

function canCastAnySpell(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];

  // Check hand for castable spells
  for (const card of ps.hand) {
    if (isLand(card)) continue;
    if (state.step !== 'main' && !isInstant(card) && !hasFlash(card)) continue;
    if (!isInstant(card) && !hasFlash(card)) {
      if (state.activePlayer !== player || state.stack.length > 0) continue;
    }
    const cost = parseManaCost(card.manaCost);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }

  // Check hand for MDFC back-face casting (CR 712)
  for (const card of ps.hand) {
    if (card.layout !== 'modal_dfc' || !card.backFace) continue;
    const bf = card.backFace;
    // Skip if back face is a land (handled by land play)
    if (bf.typeLine.toLowerCase().includes('land')) {
      // MDFC land side: can play as land during main phase
      if (state.step === 'main' && state.activePlayer === player && state.stack.length === 0 &&
          ps.landsPlayedThisTurn < ps.maxLandPlays) return true;
      continue;
    }
    // Back face is a spell
    const bfType = bf.typeLine.toLowerCase();
    if (state.step !== 'main' && !bfType.includes('instant')) continue;
    if (!bfType.includes('instant') && (state.activePlayer !== player || state.stack.length > 0)) continue;
    const cost = parseManaCost(bf.manaCost);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }

  // Check graveyard for flashback spells (CR 702.34)
  for (const card of ps.graveyard) {
    const fbCost = getFlashbackCost(card);
    if (!fbCost) continue;
    // Check timing
    if (!isInstant(card) && !hasFlash(card)) {
      if (state.step !== 'main' || state.activePlayer !== player || state.stack.length > 0) continue;
    }
    const cost = parseManaCost(fbCost);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }

  // Check exile for adventure creatures (CR 715.4)
  for (const card of ps.exile) {
    if (!card.onAdventure) continue;
    // Can cast the creature side from exile
    if (state.step !== 'main' || state.activePlayer !== player || state.stack.length > 0) {
      if (!hasFlash(card)) continue;
    }
    const cost = parseManaCost(card.manaCost);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }

  return false;
}

function canActivateAnyAbility(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];
  for (const perm of ps.battlefield) {
    for (const ability of perm.abilities) {
      // Skip mana abilities — they use 'tap-for-mana' action, not 'activate-ability'
      if (ability.type === 'mana') continue;
      // Skip static keyword abilities (not activatable)
      if (ability.type === 'static') continue;
      // Sorcery-speed abilities: only during main phase with empty stack
      if (!ability.instantSpeed && state.step !== 'main') continue;
      if (!ability.instantSpeed && state.stack.length > 0) continue;
      // {T} cost: check if permanent is untapped
      if (ability.cost && ability.cost.toLowerCase().includes('{t}') && perm.tapped) continue;
      // Creatures with summoning sickness can't use tap abilities
      if (ability.cost && ability.cost.toLowerCase().includes('{t}') &&
          perm.summoningSick && perm.currentPower !== undefined &&
          !hasKeyword(perm, 'haste')) continue;
      return true;
    }
  }
  return false;
}

function hasUntappedCreatures(state: GameState, player: 0 | 1): boolean {
  return state.players[player].battlefield.some(
    (p) => p.currentPower !== undefined && !p.tapped &&
           (!p.summoningSick || hasKeyword(p, 'haste')) &&
           !hasKeyword(p, 'defender')
  );
}

function validateTapForMana(
  state: GameState,
  action: Extract<GameAction, { type: 'tap-for-mana' }>
): string | null {
  const player = state.players[action.player];
  const perm = player.battlefield.find((p) => p.id === action.permanentId);
  if (!perm) return 'Permanent not on battlefield.';

  const ability = perm.abilities[action.abilityIndex];
  if (!ability) return 'Ability not found on permanent.';
  if (ability.type !== 'mana') return 'Not a mana ability.';

  // Check if this is a sacrifice-cost mana ability (e.g., Treasure tokens)
  const abilityText = (ability.cost || ability.text || '').toLowerCase();
  const requiresSacrifice = abilityText.includes('sacrifice');

  // Tapped check: still required even for sacrifice abilities (they tap AND sacrifice)
  if (perm.tapped) return 'Permanent is already tapped.';

  // Summoning sickness: only blocks creature tap abilities, not artifact sacrifice abilities
  // Artifacts like Treasure tokens can be sacrificed even with summoning sickness
  if (perm.summoningSick && perm.currentPower !== undefined) {
    // If it's an artifact with a sacrifice-cost mana ability, allow it
    const isArtifact = perm.typeLine.toLowerCase().includes('artifact');
    if (!(requiresSacrifice && isArtifact)) {
      return 'Cannot activate tap abilities of a creature with summoning sickness.';
    }
  }

  return null;
}

function canTapAnyForMana(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];
  for (const perm of ps.battlefield) {
    if (perm.tapped) continue;
    for (const ability of perm.abilities) {
      if (ability.type !== 'mana') continue;
      // Summoning sickness check: only blocks creatures, not artifact sacrifice abilities
      if (perm.summoningSick && perm.currentPower !== undefined) {
        const abilityText = (ability.cost || ability.text || '').toLowerCase();
        const requiresSacrifice = abilityText.includes('sacrifice');
        const isArtifact = perm.typeLine.toLowerCase().includes('artifact');
        if (!(requiresSacrifice && isArtifact)) continue;
      }
      return true;
    }
  }
  return false;
}

function validateActivateLoyalty(
  state: GameState,
  action: Extract<GameAction, { type: 'activate-loyalty' }>
): string | null {
  // Loyalty abilities are sorcery speed
  if (state.step !== 'main') return 'Can only activate loyalty abilities during main phase.';
  if (state.activePlayer !== action.player) return 'Can only activate loyalty abilities on your turn.';
  if (state.stack.length > 0) return 'Cannot activate loyalty abilities while stack is not empty.';

  const player = state.players[action.player];
  const perm = player.battlefield.find(p => p.id === action.permanentId);
  if (!perm) return 'Planeswalker not on battlefield.';
  if (perm.currentLoyalty === undefined) return 'Not a planeswalker.';

  // Only one loyalty ability per planeswalker per turn
  if (perm.loyaltyUsedThisTurn) return 'Already activated a loyalty ability this turn.';

  // Check ability exists
  const ability = perm.abilities[action.abilityIndex];
  if (!ability) return 'Ability not found.';

  // Parse loyalty cost
  const loyaltyCost = parseLoyaltyCost(ability.cost || '');
  if (loyaltyCost === null) return 'Not a loyalty ability.';

  // For minus abilities, must have enough loyalty
  if (loyaltyCost < 0 && perm.currentLoyalty < Math.abs(loyaltyCost)) {
    return `Not enough loyalty (have ${perm.currentLoyalty}, need ${Math.abs(loyaltyCost)}).`;
  }

  // Check targets legality
  const targetError = validateTargetLegality(state, action.player, action.targets);
  if (targetError) return targetError;

  return null;
}

/** Check if the player can activate any planeswalker loyalty ability */
function canActivateAnyLoyalty(state: GameState, player: 0 | 1): boolean {
  if (state.step !== 'main' || state.activePlayer !== player || state.stack.length > 0) return false;

  const ps = state.players[player];
  for (const perm of ps.battlefield) {
    if (perm.currentLoyalty === undefined) continue;
    if (perm.loyaltyUsedThisTurn) continue;

    for (const ability of perm.abilities) {
      const loyaltyCost = parseLoyaltyCost(ability.cost || '');
      if (loyaltyCost === null) continue;

      // Can afford the loyalty cost?
      if (loyaltyCost < 0 && perm.currentLoyalty < Math.abs(loyaltyCost)) continue;

      return true;
    }
  }
  return false;
}

function validateEquip(
  state: GameState,
  action: Extract<GameAction, { type: 'equip' }>
): string | null {
  // Equip is sorcery speed
  if (state.step !== 'main') return 'Can only equip during main phase.';
  if (state.activePlayer !== action.player) return 'Can only equip on your turn.';
  if (state.stack.length > 0) return 'Cannot equip while stack is not empty.';

  const player = state.players[action.player];

  // Equipment must be on your battlefield
  const equipment = player.battlefield.find(p => p.id === action.equipmentId);
  if (!equipment) return 'Equipment not on your battlefield.';
  if (!isEquipment(equipment)) return 'That permanent is not an equipment.';

  // Target creature must be on your battlefield
  const creature = player.battlefield.find(p => p.id === action.targetCreatureId);
  if (!creature) return 'Target creature not on your battlefield.';
  if (creature.currentPower === undefined) return 'Target is not a creature.';

  // Protection: can't equip creature that has protection from equipment's colors
  if (hasProtectionFrom(creature, equipment.colors || [])) {
    return `${creature.name} has protection from ${equipment.name}'s color and cannot be equipped.`;
  }

  // Check equip cost
  const equipCostStr = getEquipCost(equipment);
  if (equipCostStr) {
    const cost = parseManaCost(equipCostStr);
    if (!canPayCost(player.manaPool, cost, player.life)) {
      const tapResult = autoTapLandsForCost(player, cost);
      if (!tapResult) return 'Not enough mana to pay equip cost.';
    }
  }

  return null;
}

/** Check if the player can equip any equipment to any creature */
function canEquipAny(state: GameState, player: 0 | 1): boolean {
  if (state.step !== 'main' || state.activePlayer !== player || state.stack.length > 0) return false;

  const ps = state.players[player];
  const equipments = ps.battlefield.filter(p => isEquipment(p));
  const creatures = ps.battlefield.filter(p => p.currentPower !== undefined);

  if (equipments.length === 0 || creatures.length === 0) return false;

  // Check if any equipment can be equipped (has equip cost and player can pay)
  for (const eq of equipments) {
    const costStr = getEquipCost(eq);
    if (!costStr) continue; // No equip cost found
    const cost = parseManaCost(costStr);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }

  return false;
}

function validateDiscard(
  state: GameState,
  action: Extract<GameAction, { type: 'discard' }>
): string | null {
  // Must be the player who needs to discard
  if (state.pendingDiscard !== action.player) {
    return 'You are not required to discard.';
  }

  const player = state.players[action.player];
  const requiredDiscard = state.pendingDiscardCount ?? 0;

  // Must discard exactly the right number of cards
  if (action.cardIds.length !== requiredDiscard) {
    return `Must discard exactly ${requiredDiscard} card(s), got ${action.cardIds.length}.`;
  }

  // All discarded cards must be in hand
  for (const cardId of action.cardIds) {
    if (!player.hand.some((c) => c.id === cardId)) {
      return `Card ${cardId} not in hand.`;
    }
  }

  return null;
}

function validateLegendChoice(
  state: GameState,
  action: Extract<GameAction, { type: 'legend-choice' }>
): string | null {
  if (!state.pendingLegendChoice) return 'No legend rule choice pending.';
  if (state.pendingLegendChoice.player !== action.player) return 'Not your legend rule choice.';
  if (!state.pendingLegendChoice.permanentIds.includes(action.keepPermanentId)) {
    return 'Invalid permanent ID for legend rule choice.';
  }
  return null;
}

function validateCommanderZoneChoice(
  state: GameState,
  action: Extract<GameAction, { type: 'commander-zone-choice' }>
): string | null {
  if (!state.pendingCommanderChoice) return 'No commander zone choice pending.';
  if (state.pendingCommanderChoice.player !== action.player) return 'Not your commander zone choice.';
  return null;
}

/** Validate turning a face-down creature face-up (morph, CR 702.36) */
function validateTurnFaceUp(
  state: GameState,
  action: Extract<GameAction, { type: 'turn-face-up' }>
): string | null {
  const player = state.players[action.player];
  const perm = player.battlefield.find(p => p.id === action.permanentId);
  if (!perm) return 'Permanent not on battlefield.';
  if (!perm.faceDown) return 'Permanent is not face-down.';
  // Parse morph cost from the card's original oracle text
  const morphMatch = perm.oracleText?.match(/morph\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  if (!morphMatch) return 'Permanent does not have a morph cost.';
  const cost = parseManaCost(morphMatch[1]);
  if (!canPayCost(player.manaPool, cost, player.life)) {
    const tapResult = autoTapLandsForCost(player, cost);
    if (!tapResult) return `Not enough mana to pay morph cost (${morphMatch[1]}).`;
  }
  return null;
}

/** Validate cycling a card from hand (CR 702.28) */
function validateCycle(
  state: GameState,
  action: Extract<GameAction, { type: 'cycle' }>
): string | null {
  const player = state.players[action.player];
  const card = player.hand.find(c => c.id === action.cardId);
  if (!card) return 'Card not in hand.';
  const cycleMatch = card.oracleText?.match(/cycling\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  if (!cycleMatch) return 'Card does not have cycling.';
  const cost = parseManaCost(cycleMatch[1]);
  if (!canPayCost(player.manaPool, cost, player.life)) {
    const tapResult = autoTapLandsForCost(player, cost);
    if (!tapResult) return `Not enough mana to pay cycling cost (${cycleMatch[1]}).`;
  }
  return null;
}

/** Check if the player can cycle any card in hand */
function canCycleAny(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];
  for (const card of ps.hand) {
    const cycleMatch = card.oracleText?.match(/cycling\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
    if (!cycleMatch) continue;
    const cost = parseManaCost(cycleMatch[1]);
    if (canPayCost(ps.manaPool, cost, ps.life)) return true;
    if (autoTapLandsForCost(ps, cost) !== null) return true;
  }
  return false;
}
