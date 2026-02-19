import type { GameState, GameAction, Permanent } from '@mtg/game-engine';
import { hasKeyword } from '@mtg/game-engine';
import { evaluateBoardPosition, getOpponentTotalPower } from '../evaluators/board-evaluator.ts';

/**
 * Combat Policy — Decides attack and block strategies.
 *
 * Handles:
 * - Which creatures to attack with
 * - Which creatures to block with
 * - Favorable vs unfavorable attacks
 * - Token-aware decisions (tokens are expendable)
 */

// ─── Token Detection ───

/**
 * Check if a permanent is a token.
 * Tokens have IDs starting with 'token-' or oracleIds starting with 'token_'.
 */
function isToken(perm: Permanent): boolean {
  return (perm.id?.startsWith('token-') || perm.oracleId?.startsWith('token_')
    || (perm.typeLine ?? '').toLowerCase().startsWith('token'));
}

/**
 * Get the "intrinsic value" of a creature for combat trading decisions.
 * Tokens have near-zero value, making them ideal for expendable combat roles.
 * Utility creatures (with tap abilities) are valued higher.
 */
function creatureValue(perm: Permanent): number {
  if (isToken(perm)) return 0.5; // Tokens are nearly free

  let value = 2; // Base value for a real card
  const power = perm.currentPower ?? 0;
  const toughness = perm.currentToughness ?? 0;

  value += power + toughness * 0.5;

  // Utility creatures are more valuable to keep alive
  const textLower = (perm.oracleText || '').toLowerCase();
  if (textLower.includes('{t}:')) value += 2; // Has tap abilities

  // Commander is very valuable (don't throw away)
  const typeLine = (perm.typeLine ?? '').toLowerCase();
  if (typeLine.includes('legendary') && typeLine.includes('creature')) value += 5;

  // Equipped/enchanted creatures are more valuable
  value += (perm.attachments?.length || 0) * 2;

  return value;
}

/**
 * Calculate block priority: higher value = should block first (as a blocker).
 * Tokens should block first since they're expendable.
 * Among real creatures, prefer blocking with the weakest ones.
 */
export function blockPriority(creature: Permanent): number {
  if (isToken(creature)) return 100; // Tokens should block first (expendable)

  // Among real creatures, weakest first (least valuable to lose)
  const power = creature.currentPower ?? 0;
  const toughness = creature.currentToughness ?? 0;

  // Lower-value creatures should block first
  let priority = 20 - (power + toughness);

  // Utility creatures should block last (they're more useful untapped)
  const textLower = (creature.oracleText || '').toLowerCase();
  if (textLower.includes('{t}:')) priority -= 10;

  // Commander should almost never block (too valuable)
  const typeLine = (creature.typeLine ?? '').toLowerCase();
  if (typeLine.includes('legendary') && typeLine.includes('creature')) priority -= 15;

  return priority;
}

/** Attack plan for a single creature */
interface AttackPlan {
  permanentId: string;
  name: string;
  power: number;
  toughness: number;
  /** Score for attacking (higher = more should attack) */
  attackScore: number;
  /** Whether this is a token creature */
  isToken: boolean;
}

/**
 * Get eligible attackers (untapped, no summoning sickness).
 */
function getEligibleAttackers(state: GameState, player: 0 | 1): Permanent[] {
  return state.players[player].battlefield.filter(
    (p) => p.currentPower !== undefined && !p.tapped && !p.summoningSick
  );
}

/**
 * Get eligible blockers (untapped creatures).
 */
function getEligibleBlockers(state: GameState, player: 0 | 1): Permanent[] {
  return state.players[player].battlefield.filter(
    (p) => p.currentPower !== undefined && !p.tapped
  );
}

/**
 * Score how profitable it is to attack with a creature.
 * Token-aware: tokens are expendable, so they attack more aggressively.
 */
function scoreAttack(
  attacker: Permanent,
  opponentCreatures: Permanent[],
  opponentLife: number,
  boardAdvantage: number,
): number {
  const power = attacker.currentPower ?? 0;
  const toughness = attacker.currentToughness ?? 0;
  const textLower = (attacker.oracleText || '').toLowerCase();
  const attackerIsToken = isToken(attacker);

  let score = 0;

  // ── Token aggression bonus ──
  // Tokens are expendable — they should attack aggressively.
  // Even trading a token for a real creature is great value.
  if (attackerIsToken) {
    score += 3; // Base bonus: tokens want to attack

    // If opponent has no untapped blockers, tokens always attack
    const untappedBlockers = opponentCreatures.filter(b => !b.tapped);
    if (untappedBlockers.length === 0) score += 5;

    // Token trading with a real creature is advantageous
    const canTradeWithReal = opponentCreatures.some(
      (b) => !b.tapped && (b.currentToughness ?? 0) <= power && !isToken(b)
    );
    if (canTradeWithReal) score += 2;
  }

  // Evasion creatures should almost always attack (using hasKeyword)
  if (hasKeyword(attacker, 'flying')) score += 5;
  if (hasKeyword(attacker, "can't be blocked")) score += 8;
  if (hasKeyword(attacker, 'menace')) score += 3;
  if (hasKeyword(attacker, 'trample')) score += 2;

  // First/Double strike are combat advantages
  if (hasKeyword(attacker, 'first strike')) score += 3;
  if (hasKeyword(attacker, 'double strike')) score += 5;

  // Deathtouch — excellent when attacking into bigger creatures
  if (hasKeyword(attacker, 'deathtouch')) score += 3;

  // Trample overflow: calculate potential overflow damage past smallest blocker
  if (hasKeyword(attacker, 'trample') && opponentCreatures.length > 0) {
    const untappedBlockers = opponentCreatures.filter(b => !b.tapped);
    if (untappedBlockers.length > 0) {
      const minToughness = Math.min(...untappedBlockers.map(b => b.currentToughness ?? 0));
      const overflow = Math.max(0, power - minToughness);
      score += overflow * 0.5;
    }
  }

  // Power-to-life ratio (more value when opponent is low)
  if (opponentLife > 0) {
    score += (power / opponentLife) * 10;
  }

  // Lifelink — always good to attack
  if (hasKeyword(attacker, 'lifelink')) score += 3;

  // Infect — extremely valuable attacks
  if (hasKeyword(attacker, 'infect')) score += 8;

  // If we're ahead on board, be aggressive
  if (boardAdvantage > 5) score += 3;

  // Don't attack with small NON-TOKEN creatures into bigger blockers (unless evasion)
  // Tokens are expendable, so this penalty is reduced for them
  if (score < 5 && !attackerIsToken) {
    const canBeBlocked = opponentCreatures.some(
      (b) => (b.currentToughness ?? 0) > power && (b.currentPower ?? 0) >= toughness
    );
    if (canBeBlocked) score -= 4;
  }

  // Don't attack with utility creatures we want to keep (tokens don't have useful tap abilities)
  if (textLower.includes('{t}:') && !textLower.includes('attacks') && !attackerIsToken) {
    score -= 2; // Tap ability creatures are better untapped
  }

  return score;
}

/**
 * Choose which creatures to declare as attackers.
 */
export function chooseAttackers(state: GameState, player: 0 | 1): GameAction {
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  const eligible = getEligibleAttackers(state, player);
  const opponentCreatures = state.players[opponent].battlefield.filter(
    (p) => p.currentPower !== undefined
  );
  const opponentLife = state.players[opponent].life;
  const boardAdvantage = evaluateBoardPosition(state, player);

  // Score each potential attacker
  const plans: AttackPlan[] = eligible.map((perm) => ({
    permanentId: perm.id,
    name: perm.name,
    power: perm.currentPower ?? 0,
    toughness: perm.currentToughness ?? 0,
    attackScore: scoreAttack(perm, opponentCreatures, opponentLife, boardAdvantage),
    isToken: isToken(perm),
  }));

  // Force-include goaded creatures (must attack if able, CR 701.38)
  const goadedIds = eligible
    .filter(p => (p as any).goaded)
    .map(p => p.id);

  // Monarch bonus: if opponent is monarch, be more aggressive to steal it
  if ((state as any).monarch === opponent) {
    for (const plan of plans) {
      plan.attackScore += 3;
    }
  }

  // Attack with creatures that score positively + forced goaded creatures
  const attackers = [
    ...plans.filter((p) => p.attackScore > 0).map((p) => p.permanentId),
    ...goadedIds.filter(id => !plans.some(p => p.permanentId === id && p.attackScore > 0)),
  ];

  // Special: if total attacking power >= opponent life, alpha strike
  const totalAttackPower = plans
    .filter((p) => p.attackScore > 0)
    .reduce((sum, p) => sum + p.power, 0);

  if (totalAttackPower >= opponentLife && eligible.length > 0) {
    // Go all in — can kill
    return {
      type: 'declare-attackers',
      player,
      attackers: eligible.map((p) => p.id),
    };
  }

  return {
    type: 'declare-attackers',
    player,
    attackers,
  };
}

/**
 * Score how good a block assignment is.
 * Token-aware: tokens are preferred blockers since they're expendable.
 */
function scoreBlock(
  blocker: Permanent,
  attacker: Permanent,
): number {
  const bPower = blocker.currentPower ?? 0;
  const bToughness = blocker.currentToughness ?? 0;
  const aPower = attacker.currentPower ?? 0;
  const aToughness = attacker.currentToughness ?? 0;
  const blockerIsToken = isToken(blocker);
  const attackerIsToken = isToken(attacker);

  let score = 0;

  // ── Token blocking preference ──
  // Tokens should be preferred as blockers over real creatures.
  // A token blocking a real creature (even as a chump) is value.
  if (blockerIsToken) {
    score += 4; // Tokens are expendable blockers

    // Token chump-blocking a big real creature = excellent trade
    if (!attackerIsToken && aPower >= 3) {
      score += 2; // Great value: absorb damage, save life
    }
  }

  // Can we kill the attacker?
  if (bPower >= aToughness) score += 5;

  // Will we survive?
  if (bToughness > aPower) score += 4;

  // Deathtouch blocker — always kills the attacker regardless of power
  if (hasKeyword(blocker, 'deathtouch')) score += 4;

  // First strike blocker — may kill before taking damage
  if (hasKeyword(blocker, 'first strike') || hasKeyword(blocker, 'double strike')) score += 3;

  // Trample attacker — blocking is less effective (damage spills over)
  if (hasKeyword(attacker, 'trample')) score -= 2;

  // Deathtouch attacker — our blocker WILL die, reduce willingness for non-tokens
  if (hasKeyword(attacker, 'deathtouch')) {
    if (blockerIsToken) {
      score -= 1; // Token dying to deathtouch is fine
    } else {
      score -= 3; // Real creature dying is worse
    }
  }

  // First strike attacker — may kill our blocker before it deals damage
  if (hasKeyword(attacker, 'first strike') || hasKeyword(attacker, 'double strike')) {
    if (aPower >= bToughness) score -= 3; // Will die before dealing damage
  }

  // Trade evaluation — adjust based on whether creatures are tokens
  if (bPower >= aToughness && aPower >= bToughness) {
    if (blockerIsToken && !attackerIsToken) {
      score += 5; // Token-for-real-creature trade is EXCELLENT
    } else if (!blockerIsToken && attackerIsToken) {
      score -= 2; // Real creature for token is bad
    } else {
      score += (aPower - bPower) * 0.5;
    }
  }

  // Block lethal damage to protect life total
  score += aPower * 0.3; // Value of damage prevented

  // Don't chump-block small creatures with REAL creatures
  // But tokens are fine to chump-block with (they're expendable)
  if (bPower < aToughness && aPower >= bToughness && aPower <= 2) {
    if (blockerIsToken) {
      score -= 1; // Slight penalty even for tokens on tiny attackers
    } else {
      score -= 3; // Not worth losing a real creature for 2 damage
    }
  }

  return score;
}

/**
 * Choose blocking assignments.
 */
export function chooseBlockers(state: GameState, player: 0 | 1): GameAction {
  if (!state.combat) {
    return { type: 'declare-blockers', player, blocks: [] };
  }

  const eligible = getEligibleBlockers(state, player);
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  const opponentField = state.players[opponent].battlefield;
  const myLife = state.players[player].life;

  const blocks: { blocker: string; attacker: string }[] = [];
  const assignedBlockers = new Set<string>();
  const assignedAttackers = new Set<string>();

  // Calculate total incoming damage
  let totalIncoming = 0;
  for (const atk of state.combat.attackers) {
    const perm = opponentField.find((p) => p.id === atk.permanentId);
    if (perm) totalIncoming += perm.currentPower ?? 0;
  }

  // If incoming damage is lethal, block as much as possible
  const isLethal = totalIncoming >= myLife;

  // Score all possible block assignments
  interface BlockOption {
    blockerId: string;
    attackerId: string;
    score: number;
    /** Higher = blocker should be preferred (tokens get priority) */
    blockerPriority: number;
  }

  const options: BlockOption[] = [];

  // Sort eligible blockers so tokens appear first (preferred blockers)
  const sortedEligible = [...eligible].sort((a, b) => blockPriority(b) - blockPriority(a));

  for (const blocker of sortedEligible) {
    for (const atk of state.combat.attackers) {
      const attacker = opponentField.find((p) => p.id === atk.permanentId);
      if (!attacker) continue;

      let score = scoreBlock(blocker, attacker);

      // Increase block priority if damage is lethal
      if (isLethal) score += 5;

      // Tiebreaker: prefer token blockers over real creature blockers
      const bPriority = blockPriority(blocker);

      options.push({
        blockerId: blocker.id,
        attackerId: atk.permanentId,
        score,
        blockerPriority: bPriority,
      });
    }
  }

  // Sort by score descending, then by blocker priority (tokens first) for tiebreaking
  options.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.blockerPriority - a.blockerPriority;
  });

  // Greedily assign blocks (each blocker/attacker used at most once)
  for (const opt of options) {
    if (assignedBlockers.has(opt.blockerId) || assignedAttackers.has(opt.attackerId)) continue;
    if (opt.score <= 0 && !isLethal) continue; // Skip unfavorable blocks unless lethal

    blocks.push({ blocker: opt.blockerId, attacker: opt.attackerId });
    assignedBlockers.add(opt.blockerId);
    assignedAttackers.add(opt.attackerId);
  }

  // Menace post-processing: menace attackers need 2+ blockers or 0
  for (const atk of state.combat.attackers) {
    const attackerPerm = opponentField.find(p => p.id === atk.permanentId);
    if (!attackerPerm || !hasKeyword(attackerPerm, 'menace')) continue;

    const blocksForThis = blocks.filter(b => b.attacker === atk.permanentId);
    if (blocksForThis.length === 1) {
      // Need a second blocker or remove the single one
      const freeBlockers = eligible.filter(b => !assignedBlockers.has(b.id));
      const secondBlocker = freeBlockers.find(b => {
        const s = scoreBlock(b, attackerPerm);
        return s > -2; // Only add if not terrible
      });
      if (secondBlocker) {
        blocks.push({ blocker: secondBlocker.id, attacker: atk.permanentId });
        assignedBlockers.add(secondBlocker.id);
      } else {
        // Remove the single blocker (can't legally block menace alone)
        const idx = blocks.findIndex(b => b.attacker === atk.permanentId);
        if (idx !== -1) {
          assignedBlockers.delete(blocks[idx].blocker);
          blocks.splice(idx, 1);
        }
      }
    }
  }

  return {
    type: 'declare-blockers',
    player,
    blocks,
  };
}

/**
 * Decide if we should attack at all this turn.
 */
export function shouldAttack(state: GameState, player: 0 | 1): boolean {
  const eligible = getEligibleAttackers(state, player);
  if (eligible.length === 0) return false;

  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  const opponentCreatures = state.players[opponent].battlefield.filter(
    (p) => p.currentPower !== undefined
  );
  const boardAdv = evaluateBoardPosition(state, player);

  // Always attack if we have evasive creatures
  const hasEvasion = eligible.some((p) => {
    const text = (p.oracleText || '').toLowerCase();
    return text.includes('flying') || text.includes("can't be blocked");
  });
  if (hasEvasion) return true;

  // Attack if we're ahead on board
  if (boardAdv > 3) return true;

  // Attack if opponent has no blockers
  const opponentBlockers = opponentCreatures.filter((p) => !p.tapped);
  if (opponentBlockers.length === 0) return true;

  return false;
}
