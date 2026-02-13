/**
 * Reward Calculator — Computes per-action rewards from state transitions.
 *
 * Combines base rewards from 11 categories with temporal scaling
 * and archetype modifiers for the final reward signal.
 *
 * Formula: finalReward = clamp(baseReward * temporalScale * archetypeMod * penaltyScale) * scaleFactor
 */

import type { GameState, GameAction, Permanent } from '@mtg/game-engine';
import { isCreature, isArtifact, isEnchantment, totalMana } from '@mtg/game-engine';
import {
  OUTCOME_REWARDS,
  RESOURCE_REWARDS,
  BOARD_REWARDS,
  COMBAT_REWARDS,
  COMBO_REWARDS,
  COMMANDER_REWARDS,
  MULLIGAN_REWARDS,
  MISPLAY_PENALTIES,
  DEFAULT_REWARD_CONFIG,
  type RewardConfig,
} from './reward-config.ts';
import { getTemporalScale, type RewardCategory } from './temporal-scaling.ts';
import { getArchetypeModifier, type ArchetypeName } from './archetype-modifiers.ts';

/** Breakdown of reward components for debugging/logging */
export interface RewardBreakdown {
  outcome: number;
  resources: number;
  board: number;
  combat: number;
  combo: number;
  commander: number;
  mulligan: number;
  misplay: number;
  raw: number;
  scaled: number;
}

/** Calculate the total reward for a state transition (optimized — no object allocation) */
export function calculateReward(
  prevState: GameState,
  action: GameAction,
  nextState: GameState,
  player: 0 | 1,
  archetype?: ArchetypeName,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): number {
  return calculateRewardFast(prevState, action, nextState, player, archetype, config);
}

/** Fast reward calculation — returns scalar directly without breakdown object */
function calculateRewardFast(
  prevState: GameState,
  action: GameAction,
  nextState: GameState,
  player: 0 | 1,
  archetype?: ArchetypeName,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): number {
  const turn = prevState.turn;
  const mod = getArchetypeModifier(archetype);

  let reward = 0;

  const prev = prevState.players[player];
  const next = nextState.players[player];
  const opponent = player === 0 ? 1 : 0;
  const prevOpp = prevState.players[opponent];
  const nextOpp = nextState.players[opponent];

  // === 1. Game Outcome ===
  let outcomeReward = 0;
  if (nextState.gameOver && !prevState.gameOver) {
    if (nextState.winner === player) {
      outcomeReward += OUTCOME_REWARDS.baseWin;
      if (nextState.turn <= 7) outcomeReward += OUTCOME_REWARDS.fastWinBonus;
      if (prev.life < 10) outcomeReward += OUTCOME_REWARDS.comebackWinBonus;
    } else if (nextState.winner !== null) {
      outcomeReward += OUTCOME_REWARDS.baseLoss;
      if (action.type === 'concede' && prevState.turn < 5) {
        outcomeReward += OUTCOME_REWARDS.earlyScoopPenalty;
      }
    }
  }

  // === 2. Resource Management ===
  if (action.type === 'pass' && prevState.step === 'end') {
    const manaAvailable = totalMana(prev.manaPool);
    const manaLeft = totalMana(next.manaPool);
    
    // Check if holding mana was valid (have Instants/Flash)
    const hasInstantSpeed = prev.hand.some(c => 
      c.typeLine.toLowerCase().includes('instant') || 
      (c.oracleText || '').toLowerCase().includes('flash')
    );

    if (manaAvailable > 0) {
      if (manaLeft === 0) {
        reward += scale(RESOURCE_REWARDS.perfectManaUsage, turn, 'default', mod.ramp, config);
      } else if (manaLeft / manaAvailable <= 0.1) {
        reward += scale(RESOURCE_REWARDS.goodManaUsage, turn, 'default', mod.ramp, config);
      } else if (!hasInstantSpeed) {
        // Only penalize if we couldn't possibly use it
        if (manaLeft >= 5) {
          reward += scalePenalty(RESOURCE_REWARDS.wasted5Mana, config);
        } else if (manaLeft >= 3) {
          reward += scalePenalty(RESOURCE_REWARDS.wasted3Mana, config);
        }
      }
    }
    const handSize = next.hand.length;
    if (handSize >= 5 && handSize <= 7) {
      reward += scale(RESOURCE_REWARDS.goodHandSize, turn, 'default', mod.cardDraw, config);
    } else if (handSize === 0) {
      reward += scalePenalty(RESOURCE_REWARDS.hellbent, config);
    } else if (handSize >= 8) {
      reward += scalePenalty(RESOURCE_REWARDS.overdraw, config);
    }
  }

  // Card Draw (Generic, not just cast-spell)
  const handDelta = next.hand.length - prev.hand.length;
  // If cast-spell, we spent a card, so +1 to delta to get net drawn
  // If ability/land, we spent nothing (usually)
  const netDrawn = handDelta + (action.type === 'cast-spell' ? 1 : 0);
  if (netDrawn > 0 && action.type !== 'mulligan') {
    reward += scale(RESOURCE_REWARDS.drewExtraCard * netDrawn, turn, 'cardDraw', mod.cardDraw, config);
  }

  // === 3. Board Development ===
  if (action.type === 'play-land') {
    const card = prev.hand.find(c => c.id === action.cardId);
    if (card) {
      if (card.tags.includes('ramp')) reward += scale(BOARD_REWARDS.playedRamp, turn, 'ramp', mod.ramp, config);
      if (card.tags.includes('land-fetch')) reward += scale(BOARD_REWARDS.fixedMana, turn, 'ramp', mod.ramp, config);
    }
  }

  if (action.type === 'cast-spell') {
    const card = prev.hand.find(c => c.id === action.cardId);
    if (card) {
      if (isCreature(card)) reward += scale(BOARD_REWARDS.playedCreature, turn, 'creatures', mod.creatureCasts, config);
      if (card.tags.includes('ramp') || card.tags.includes('fast-mana')) reward += scale(BOARD_REWARDS.playedRamp, turn, 'ramp', mod.ramp, config);
      if (card.tags.includes('draw') || card.tags.includes('engine')) reward += scale(BOARD_REWARDS.playedEngine, turn, 'engines', mod.cardDraw, config);
      if (card.tags.includes('win-condition') || card.tags.includes('finisher')) reward += scale(BOARD_REWARDS.playedPayoff, turn, 'winConditions', mod.bigSpells, config);
    }
  }

  const permLost = prev.battlefield.length - next.battlefield.length;
  if (permLost >= 3) reward += scalePenalty(BOARD_REWARDS.boardWiped, config);

  if (turn <= 4 && action.type === 'pass' && prevState.phase === 'precombat-main') {
    if (!prev.landPlayedThisTurn) reward += scale(BOARD_REWARDS.missedLandDrop, turn, 'missedLandDrop', 1, config);
  }

  // === 4. Combat Rewards ===
  if (action.type === 'declare-attackers' && action.attackers.length > 0) {
    const lifeDelta = prevOpp.life - nextOpp.life;
    if (lifeDelta > 0) {
      const dmgReward = Math.min(lifeDelta * COMBAT_REWARDS.dealtCombatDamage, 10);
      reward += scale(dmgReward, turn, 'combat', mod.combatDamage, config);
    }
    if (nextOpp.life <= 10 && prevOpp.life > 10) reward += scale(COMBAT_REWARDS.reducedOppTo10Life, turn, 'combat', mod.combatDamage, config);
    if (nextState.gameOver && nextState.winner === player) reward += COMBAT_REWARDS.lethalAttack;
  }

  if (action.type === 'declare-blockers' && action.blocks && action.blocks.length > 0) {
    for (const block of action.blocks) {
      const blocker = prev.battlefield.find(p => p.id === block.blocker);
      // Attacker is in opponent's battlefield (or was attacking)
      const attacker = prevOpp.battlefield.find(p => p.id === block.attacker);
      
      if (blocker && attacker) {
        const bPow = blocker.currentPower ?? 0;
        const bTough = blocker.currentToughness ?? 0;
        const aPow = attacker.currentPower ?? 0;
        const aTough = attacker.currentToughness ?? 0;
        
        // Did we prevent lethal?
        if (aPow >= prev.life) {
           reward += COMBAT_REWARDS.blockedLethal;
        }
        
        const blockerDies = aPow >= bTough;
        const attackerDies = bPow >= aTough;
        
        if (!blockerDies && attackerDies) {
           // Profitable block (eat attacker)
           reward += scale(COMBAT_REWARDS.profitableBlock, turn, 'combat', mod.combatDamage, config);
        } else if (blockerDies && attackerDies) {
           // Trade - good if attacker is bigger/more expensive
           if (attacker.cmc > blocker.cmc || aPow > bPow) {
              reward += scale(COMBAT_REWARDS.tradeBlock, turn, 'combat', mod.combatDamage, config);
           }
        } else if (blockerDies && !attackerDies) {
           // Chump block - bad unless preventing lethal or huge damage
           // If we didn't block lethal (handled above), penalize chumping small things
           if (aPow < 5 && prev.life > 10) {
              reward += scalePenalty(COMBAT_REWARDS.chumBlock, config);
           }
        }
      }
    }
  }

  const myLifeLost = prev.life - next.life;
  if (myLifeLost >= 5) reward += scalePenalty(COMBAT_REWARDS.lostLife5Plus, config);
  if (next.life < 20 && prev.life >= 20) reward += scalePenalty(COMBAT_REWARDS.droppedBelow20, config);
  if (next.life < 10 && prev.life >= 10) reward += scalePenalty(COMBAT_REWARDS.droppedBelow10, config);
  if (next.life <= 5 && prev.life > 5) reward += scalePenalty(COMBAT_REWARDS.droppedTo5OrLess, config);

  // === 5. Combo Progress ===
  const prevComboCount = countComboPieces(prev.battlefield);
  const nextComboCount = countComboPieces(next.battlefield);
  if (nextComboCount > prevComboCount) {
    reward += scale(COMBO_REWARDS.assembled1of3 * (nextComboCount - prevComboCount), turn, 'comboRewards', mod.comboProgress, config);
  }

  if (action.type === 'cast-spell' && turn >= 3 && turn <= 5) {
    const card = prev.hand.find(c => c.id === action.cardId);
    if (card && prev.commandZone.some(cc => cc.name === card.name)) {
      reward += scale(COMBO_REWARDS.commanderOutOnCurve, turn, 'default', 1, config);
    }
  }

  // === 6. Commander Rewards ===
  if (next.commanderTax > 6 && prev.commanderTax <= 6) reward += scalePenalty(COMMANDER_REWARDS.commanderTaxOver6, config);
  if (next.commandZone.length > prev.commandZone.length) reward += scalePenalty(COMMANDER_REWARDS.commanderKilled, config);

  // === 7. Mulligan ===
  if (action.type === 'mulligan') {
    const mulliganNum = (prevState.mulliganCount?.[player] ?? 0) + 1;
    reward += mulliganNum === 1 ? MULLIGAN_REWARDS.mulliganTo6 : MULLIGAN_REWARDS.mulliganTo5OrLess;
  }

  if (action.type === 'mulligan' && action.toBottom.length === 0) {
    const landCount = next.hand.filter(c => c.typeLine.toLowerCase().includes('land')).length;
    if (landCount >= 2 && landCount <= 4) reward += MULLIGAN_REWARDS.keptGoodHand;
    else if (landCount <= 1 || landCount >= 6) reward += scalePenalty(MULLIGAN_REWARDS.keptRiskyHand, config);
  }

  // === 8. Misplay Detection ===
  if (action.type === 'pass' && prevState.phase === 'combat' && prevState.step === 'declare-attackers' && prevState.activePlayer === player) {
    const totalPower = prev.battlefield
      .filter(p => isCreature(p) && !p.summoningSick && !p.tapped)
      .reduce((sum, p) => sum + (p.currentPower ?? 0), 0);
    if (totalPower >= prevOpp.life) reward += scalePenalty(MISPLAY_PENALTIES.missedLethal, config);
  }

  // === Final scaling ===
  const clamped = Math.max(config.minStepReward, Math.min(config.maxStepReward, reward));
  return outcomeReward !== 0 ? (reward + outcomeReward) * config.scaleFactor : clamped * config.scaleFactor;
}

/** Calculate reward with full breakdown */
export function calculateRewardBreakdown(
  prevState: GameState,
  action: GameAction,
  nextState: GameState,
  player: 0 | 1,
  archetype?: ArchetypeName,
  config: RewardConfig = DEFAULT_REWARD_CONFIG,
): RewardBreakdown {
  const turn = prevState.turn;
  const mod = getArchetypeModifier(archetype);

  let outcome = 0;
  let resources = 0;
  let board = 0;
  let combat = 0;
  let combo = 0;
  let commander = 0;
  let mulligan = 0;
  let misplay = 0;

  const prev = prevState.players[player];
  const next = nextState.players[player];
  const opponent = player === 0 ? 1 : 0;
  const prevOpp = prevState.players[opponent];
  const nextOpp = nextState.players[opponent];

  // === 1. Game Outcome ===
  if (nextState.gameOver && !prevState.gameOver) {
    if (nextState.winner === player) {
      outcome += OUTCOME_REWARDS.baseWin;
      if (nextState.turn <= 7) outcome += OUTCOME_REWARDS.fastWinBonus;
      if (prev.life < 10) outcome += OUTCOME_REWARDS.comebackWinBonus;
    } else if (nextState.winner !== null) {
      outcome += OUTCOME_REWARDS.baseLoss;
      if (action.type === 'concede' && prevState.turn < 5) {
        outcome += OUTCOME_REWARDS.earlyScoopPenalty;
      }
    }
  }

  // === 2. Resource Management ===
  if (action.type === 'pass' && prevState.step === 'end') {
    // End of turn — check mana usage
    const manaAvailable = totalMana(prev.manaPool);
    const manaLeft = totalMana(next.manaPool);
    if (manaAvailable > 0) {
      if (manaLeft === 0) {
        resources += scale(RESOURCE_REWARDS.perfectManaUsage, turn, 'default', mod.ramp, config);
      } else if (manaLeft / manaAvailable <= 0.1) {
        resources += scale(RESOURCE_REWARDS.goodManaUsage, turn, 'default', mod.ramp, config);
      } else if (manaLeft >= 5) {
        resources += scalePenalty(RESOURCE_REWARDS.wasted5Mana, config);
      } else if (manaLeft >= 3) {
        resources += scalePenalty(RESOURCE_REWARDS.wasted3Mana, config);
      }
    }

    // Hand size at end step
    const handSize = next.hand.length;
    if (handSize >= 5 && handSize <= 7) {
      resources += scale(RESOURCE_REWARDS.goodHandSize, turn, 'default', mod.cardDraw, config);
    } else if (handSize === 0) {
      resources += scalePenalty(RESOURCE_REWARDS.hellbent, config);
    } else if (handSize >= 8) {
      resources += scalePenalty(RESOURCE_REWARDS.overdraw, config);
    }
  }

  // Card draw — gained cards beyond mandatory
  const handDelta = next.hand.length - prev.hand.length;
  if (action.type === 'cast-spell' && handDelta > 0) {
    resources += scale(
      RESOURCE_REWARDS.drewExtraCard * handDelta,
      turn, 'cardDraw', mod.cardDraw, config,
    );
  }

  // === 3. Board Development ===
  if (action.type === 'play-land') {
    // Check if it's a ramp land (enters with additional effect)
    const card = prev.hand.find(c => c.id === action.cardId);
    if (card && card.tags.includes('ramp')) {
      board += scale(BOARD_REWARDS.playedRamp, turn, 'ramp', mod.ramp, config);
    }
    if (card && card.tags.includes('land-fetch')) {
      board += scale(BOARD_REWARDS.fixedMana, turn, 'ramp', mod.ramp, config);
    }
  }

  if (action.type === 'cast-spell') {
    const card = prev.hand.find(c => c.id === action.cardId);
    if (card) {
      if (isCreature(card)) {
        board += scale(BOARD_REWARDS.playedCreature, turn, 'creatures', mod.creatureCasts, config);
      }
      if (card.tags.includes('ramp') || card.tags.includes('fast-mana')) {
        board += scale(BOARD_REWARDS.playedRamp, turn, 'ramp', mod.ramp, config);
      }
      if (card.tags.includes('draw') || card.tags.includes('engine')) {
        board += scale(BOARD_REWARDS.playedEngine, turn, 'engines', mod.cardDraw, config);
      }
      if (card.tags.includes('win-condition') || card.tags.includes('finisher')) {
        board += scale(BOARD_REWARDS.playedPayoff, turn, 'winConditions', mod.bigSpells, config);
      }
    }
  }

  // Board wipe detection — lost 3+ permanents this action
  const permLost = prev.battlefield.length - next.battlefield.length;
  if (permLost >= 3) {
    board += scalePenalty(BOARD_REWARDS.boardWiped, config);
  }

  // Missed land drop (turns 1-4, check at end of first main phase)
  if (turn <= 4 && action.type === 'pass' && prevState.phase === 'precombat-main') {
    if (!prev.landPlayedThisTurn) {
      board += scale(BOARD_REWARDS.missedLandDrop, turn, 'missedLandDrop', 1, config);
    }
  }

  // === 4. Combat Rewards ===
  if (action.type === 'declare-attackers' && action.attackers.length > 0) {
    const lifeDelta = prevOpp.life - nextOpp.life;
    if (lifeDelta > 0) {
      const dmgReward = Math.min(lifeDelta * COMBAT_REWARDS.dealtCombatDamage, 10);
      combat += scale(dmgReward, turn, 'combat', mod.combatDamage, config);
    }
    if (nextOpp.life <= 10 && prevOpp.life > 10) {
      combat += scale(COMBAT_REWARDS.reducedOppTo10Life, turn, 'combat', mod.combatDamage, config);
    }
    if (nextState.gameOver && nextState.winner === player) {
      combat += COMBAT_REWARDS.lethalAttack;
    }
  }

  // Life loss tracking
  const myLifeLost = prev.life - next.life;
  if (myLifeLost >= 5) {
    combat += scalePenalty(COMBAT_REWARDS.lostLife5Plus, config);
  }
  if (next.life < 20 && prev.life >= 20) {
    combat += scalePenalty(COMBAT_REWARDS.droppedBelow20, config);
  }
  if (next.life < 10 && prev.life >= 10) {
    combat += scalePenalty(COMBAT_REWARDS.droppedBelow10, config);
  }
  if (next.life <= 5 && prev.life > 5) {
    combat += scalePenalty(COMBAT_REWARDS.droppedTo5OrLess, config);
  }

  // === 5. Combo Progress ===
  const prevComboCount = countComboPieces(prev.battlefield);
  const nextComboCount = countComboPieces(next.battlefield);
  if (nextComboCount > prevComboCount) {
    const diff = nextComboCount - prevComboCount;
    combo += scale(
      COMBO_REWARDS.assembled1of3 * diff,
      turn, 'comboRewards', mod.comboProgress, config,
    );
  }

  // Commander on curve (turns 3-5)
  if (action.type === 'cast-spell' && turn >= 3 && turn <= 5) {
    const card = prev.hand.find(c => c.id === action.cardId);
    if (card && prev.commandZone.some(cc => cc.name === card.name)) {
      combo += scale(COMBO_REWARDS.commanderOutOnCurve, turn, 'default', 1, config);
    }
  }

  // === 6. Commander Rewards ===
  // Commander tax penalty
  if (next.commanderTax > 6 && prev.commanderTax <= 6) {
    commander += scalePenalty(COMMANDER_REWARDS.commanderTaxOver6, config);
  }

  // Commander died
  if (next.commandZone.length > prev.commandZone.length) {
    commander += scalePenalty(COMMANDER_REWARDS.commanderKilled, config);
  }

  // === 7. Mulligan ===
  if (action.type === 'mulligan') {
    const mulliganNum = (prevState.mulliganCount?.[player] ?? 0) + 1;
    if (mulliganNum === 1) {
      mulligan += MULLIGAN_REWARDS.mulliganTo6;
    } else {
      mulligan += MULLIGAN_REWARDS.mulliganTo5OrLess;
    }
  }

  // Kept hand — assess quality
  if (action.type === 'mulligan' && action.toBottom.length === 0) {
    // Keeping hand (0 cards to bottom = keeping)
    const landCount = next.hand.filter(c => c.typeLine.toLowerCase().includes('land')).length;
    if (landCount >= 2 && landCount <= 4) {
      mulligan += MULLIGAN_REWARDS.keptGoodHand;
    } else if (landCount <= 1 || landCount >= 6) {
      mulligan += scalePenalty(MULLIGAN_REWARDS.keptRiskyHand, config);
    }
  }

  // === 8. Misplay Detection ===
  // Missed lethal — had enough power but didn't attack
  if (
    action.type === 'pass' &&
    prevState.phase === 'combat' &&
    prevState.step === 'declare-attackers' &&
    prevState.activePlayer === player
  ) {
    const totalPower = prev.battlefield
      .filter(p => isCreature(p) && !p.summoningSick && !p.tapped)
      .reduce((sum, p) => sum + (p.currentPower ?? 0), 0);
    if (totalPower >= prevOpp.life) {
      misplay += scalePenalty(MISPLAY_PENALTIES.missedLethal, config);
    }
  }

  // === Aggregate ===
  const raw = outcome + resources + board + combat + combo + commander + mulligan + misplay;
  const clamped = Math.max(config.minStepReward, Math.min(config.maxStepReward, raw));
  // Outcome rewards bypass clamping (they are terminal)
  const final = outcome !== 0 ? raw * config.scaleFactor : clamped * config.scaleFactor;

  return {
    outcome,
    resources,
    board,
    combat,
    combo,
    commander,
    mulligan,
    misplay,
    raw,
    scaled: final,
  };
}

/** Apply temporal + archetype scaling to a positive reward */
function scale(
  base: number,
  turn: number,
  category: RewardCategory,
  archetypeMod: number,
  config: RewardConfig,
): number {
  const temporal = getTemporalScale(turn, category);
  return base * temporal * archetypeMod;
}

/** Scale a penalty (negative reward) with penalty dampening */
function scalePenalty(base: number, config: RewardConfig): number {
  return base < 0 ? base * config.penaltyScale : base;
}

/** Count permanents with combo-related tags on the battlefield */
function countComboPieces(battlefield: Permanent[]): number {
  return battlefield.filter(p => p.tags.includes('combo-piece')).length;
}
