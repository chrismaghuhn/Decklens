import type { GameState, Permanent, Card, StackObject } from '@mtg/game-engine';

/**
 * Threat Evaluator — Identifies and prioritizes opponent threats.
 *
 * Used by the decision tree to determine if the bot must answer
 * a threat immediately or can continue developing.
 */

/** Threat severity levels */
export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low';

/** A detected threat on the board or stack */
export interface Threat {
  /** What kind of threat */
  type: 'permanent' | 'stack-spell';
  /** The threatening permanent or stack object */
  sourceId: string;
  /** Name for display/logging */
  name: string;
  /** How urgent is the response */
  level: ThreatLevel;
  /** Heuristic score (higher = more dangerous) */
  score: number;
}

/**
 * Evaluate how threatening a single permanent is.
 */
export function evaluatePermanentThreat(perm: Permanent): Threat | null {
  const typeLower = perm.typeLine.toLowerCase();
  const textLower = (perm.oracleText || '').toLowerCase();
  let score = 0;
  let level: ThreatLevel = 'low';

  const isCreature = perm.currentPower !== undefined;
  const isPlaneswalker = perm.currentLoyalty !== undefined;

  if (isCreature) {
    const power = perm.currentPower ?? 0;
    const toughness = perm.currentToughness ?? 0;

    // Big creatures are threatening
    score += power * 1.5;
    score += toughness * 0.5;

    // Commander damage potential (big commanders)
    if (typeLower.includes('legendary')) {
      score += power * 0.5; // Extra weight for commanders
    }

    // Evasion keywords make creatures more dangerous
    if (textLower.includes('flying')) score += 2;
    if (textLower.includes('trample')) score += 1.5;
    if (textLower.includes('double strike')) score += power; // Doubles effective power
    if (textLower.includes('infect')) score += 5; // Poison is very threatening
    if (textLower.includes('hexproof')) score += 2; // Hard to remove
    if (textLower.includes('indestructible')) score += 3;
    if (textLower.includes('unblockable') || textLower.includes("can't be blocked")) score += 3;

    // Lifelink mitigates attacks against us
    if (textLower.includes('lifelink')) score += 1;
  }

  if (isPlaneswalker) {
    score += 6; // Planeswalkers are always high value
    score += (perm.currentLoyalty ?? 0) * 0.5;
  }

  // Engine-type permanents that generate value each turn
  if (textLower.includes('whenever') && textLower.includes('draw')) score += 5;
  if (textLower.includes('at the beginning') && textLower.includes('draw')) score += 4;
  if (textLower.includes('whenever') && textLower.includes('create')) score += 3;

  // Must-answer effects
  if (textLower.includes('you win the game')) { score += 15; level = 'critical'; }
  if (textLower.includes('extra turn')) { score += 10; level = 'critical'; }
  if (textLower.includes('each opponent loses')) { score += 8; level = 'high'; }

  // Skip low-value permanents
  if (score < 2) return null;

  // Assign threat level
  if (level === 'low') {
    if (score >= 12) level = 'critical';
    else if (score >= 8) level = 'high';
    else if (score >= 4) level = 'medium';
  }

  return {
    type: 'permanent',
    sourceId: perm.id,
    name: perm.name,
    level,
    score,
  };
}

/**
 * Evaluate a stack spell as a threat.
 */
export function evaluateStackThreat(obj: StackObject, botPlayer: 0 | 1): Threat | null {
  // Only care about opponent's spells
  if (obj.controller === botPlayer) return null;

  const textLower = obj.text.toLowerCase();
  const name = obj.card?.name || 'Ability';
  let score = 3; // Base score for any opponent spell

  // Board wipes are critical
  if (textLower.includes('destroy all') || textLower.includes('exile all')) {
    score += 10;
  }

  // Targeted removal aimed at our stuff
  if (textLower.includes('destroy target') || textLower.includes('exile target')) {
    score += 5;
  }

  // Extra turns
  if (textLower.includes('extra turn')) score += 10;

  // Win conditions
  if (textLower.includes('you win') || textLower.includes('each opponent loses')) score += 15;

  if (score <= 3) return null;

  const level: ThreatLevel = score >= 12 ? 'critical' : score >= 8 ? 'high' : 'medium';

  return {
    type: 'stack-spell',
    sourceId: obj.id,
    name,
    level,
    score,
  };
}

/**
 * Detect if a permanent is a "lord" or "anthem" effect that buffs other creatures.
 * Lords/anthems make wide boards (many tokens) exponentially more dangerous.
 */
function isAnthemOrLord(perm: Permanent): boolean {
  const oracle = (perm.oracleText || '').toLowerCase();
  // Common anthem patterns: "other creatures you control get +X/+X"
  if (oracle.includes('creatures you control get +')) return true;
  // Tribal lords: "other Goblins get +1/+1"
  if (/other\s+\w+\s+(?:you control\s+)?get\s+\+/.test(oracle)) return true;
  // Static pumps
  if (oracle.includes('creatures you control have')) return true;
  return false;
}

/**
 * Evaluate "wide board" threat from many creatures (especially tokens).
 * A board with 5+ creatures is dangerous; with anthems it's critical.
 */
function evaluateWideBoardThreat(
  creatures: Permanent[],
  allPermanents: Permanent[],
): Threat | null {
  if (creatures.length < 3) return null; // Need at least 3 creatures for "wide board"

  let score = 0;
  const totalPower = creatures.reduce((sum, c) => sum + (c.currentPower ?? 0), 0);

  // Base threat: total power of all creatures
  score += totalPower * 0.5;

  // Width bonus: more creatures = exponentially more dangerous
  // (board wipes become critical, alpha strikes become lethal)
  if (creatures.length >= 3) score += 2;
  if (creatures.length >= 5) score += 3;
  if (creatures.length >= 8) score += 5;
  if (creatures.length >= 10) score += 7;

  // Anthem/lord multiplier: wide board + anthem = very dangerous
  const anthemCount = allPermanents.filter(p => isAnthemOrLord(p)).length;
  if (anthemCount > 0) {
    // Each anthem makes the wide board significantly more dangerous
    score += anthemCount * creatures.length * 0.5;
  }

  // Token swarm bonus: if most creatures are tokens, they can all attack freely
  const tokenCount = creatures.filter(c =>
    c.id?.startsWith('token-') || c.oracleId?.startsWith('token_')
    || (c.typeLine ?? '').toLowerCase().startsWith('token')
  ).length;
  if (tokenCount >= 3) {
    score += tokenCount * 0.3; // Token armies are expendable attackers
  }

  if (score < 3) return null;

  const level: ThreatLevel = score >= 12 ? 'critical'
    : score >= 8 ? 'high'
    : score >= 4 ? 'medium'
    : 'low';

  return {
    type: 'permanent',
    sourceId: 'wide-board',
    name: `Wide board (${creatures.length} creatures, ${totalPower} total power${anthemCount > 0 ? `, ${anthemCount} anthem(s)` : ''})`,
    level,
    score,
  };
}

/**
 * Scan the entire board for threats from the opponent.
 * Returns threats sorted by severity (most dangerous first).
 */
export function identifyThreats(state: GameState, botPlayer: 0 | 1): Threat[] {
  const opponent = (botPlayer === 0 ? 1 : 0) as 0 | 1;
  const threats: Threat[] = [];
  const opponentField = state.players[opponent].battlefield;

  // Board threats (individual permanents)
  for (const perm of opponentField) {
    const threat = evaluatePermanentThreat(perm);
    if (threat) threats.push(threat);
  }

  // Stack threats
  for (const obj of state.stack) {
    const threat = evaluateStackThreat(obj, botPlayer);
    if (threat) threats.push(threat);
  }

  // Wide board threat: many creatures (especially tokens) are collectively dangerous
  const opponentCreatures = opponentField.filter(p => p.currentPower !== undefined);
  const wideboardThreat = evaluateWideBoardThreat(opponentCreatures, opponentField);
  if (wideboardThreat) threats.push(wideboardThreat);

  // Monarch awareness: if opponent is monarch, consider it a medium threat
  // (they draw an extra card each end step)
  if ((state as any).monarch === opponent) {
    threats.push({
      type: 'permanent' as const,
      sourceId: 'monarch',
      name: 'Opponent is Monarch',
      level: 'medium' as ThreatLevel,
      score: 5,
    });
  }

  // Sort by score descending
  threats.sort((a, b) => b.score - a.score);

  return threats;
}

/**
 * Check if there's a must-answer threat (critical or high severity).
 */
export function hasMustAnswerThreat(state: GameState, botPlayer: 0 | 1): boolean {
  const threats = identifyThreats(state, botPlayer);
  return threats.some((t) => t.level === 'critical' || t.level === 'high');
}

/**
 * Get the single most dangerous threat.
 */
export function getTopThreat(state: GameState, botPlayer: 0 | 1): Threat | null {
  const threats = identifyThreats(state, botPlayer);
  return threats.length > 0 ? threats[0] : null;
}
