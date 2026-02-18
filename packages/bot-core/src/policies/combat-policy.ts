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
 */

/** Attack plan for a single creature */
interface AttackPlan {
  permanentId: string;
  name: string;
  power: number;
  toughness: number;
  /** Score for attacking (higher = more should attack) */
  attackScore: number;
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

  let score = 0;

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

  // Don't attack with small creatures into bigger blockers (unless evasion)
  if (score < 5) {
    const canBeBlocked = opponentCreatures.some(
      (b) => (b.currentToughness ?? 0) > power && (b.currentPower ?? 0) >= toughness
    );
    if (canBeBlocked) score -= 4;
  }

  // Don't attack with utility creatures we want to keep
  if (textLower.includes('{t}:') && !textLower.includes('attacks')) {
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
 */
function scoreBlock(
  blocker: Permanent,
  attacker: Permanent,
): number {
  const bPower = blocker.currentPower ?? 0;
  const bToughness = blocker.currentToughness ?? 0;
  const aPower = attacker.currentPower ?? 0;
  const aToughness = attacker.currentToughness ?? 0;

  let score = 0;

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

  // Deathtouch attacker — our blocker WILL die, reduce willingness
  if (hasKeyword(attacker, 'deathtouch')) score -= 3;

  // First strike attacker — may kill our blocker before it deals damage
  if (hasKeyword(attacker, 'first strike') || hasKeyword(attacker, 'double strike')) {
    if (aPower >= bToughness) score -= 3; // Will die before dealing damage
  }

  // Trade (we kill them, they kill us) — worth it if attacker is bigger
  if (bPower >= aToughness && aPower >= bToughness) {
    score += (aPower - bPower) * 0.5;
  }

  // Block lethal damage to protect life total
  score += aPower * 0.3; // Value of damage prevented

  // Don't chump-block small creatures
  if (bPower < aToughness && aPower >= bToughness && aPower <= 2) {
    score -= 3; // Not worth losing a creature for 2 damage
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
  }

  const options: BlockOption[] = [];

  for (const blocker of eligible) {
    for (const atk of state.combat.attackers) {
      const attacker = opponentField.find((p) => p.id === atk.permanentId);
      if (!attacker) continue;

      let score = scoreBlock(blocker, attacker);

      // Increase block priority if damage is lethal
      if (isLethal) score += 5;

      options.push({
        blockerId: blocker.id,
        attackerId: atk.permanentId,
        score,
      });
    }
  }

  // Sort by score descending
  options.sort((a, b) => b.score - a.score);

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
