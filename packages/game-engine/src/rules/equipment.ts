/**
 * Equipment & Aura System
 *
 * Handles:
 * - Equipment attachment/detachment
 * - Aura attachment (auto-attach on ETB)
 * - Stat bonuses from equipment/auras
 * - Cleanup when equipped/enchanted creature leaves the battlefield
 *
 * MTG Rules:
 * - Equipment stays on battlefield when creature leaves (becomes unattached)
 * - Auras go to graveyard when enchanted permanent leaves
 * - Equip is a sorcery-speed activated ability (costs mana)
 * - Equipment can only be attached to creatures you control
 */

import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import { hasProtectionFrom, hasProtectionFromPermanent } from './combat.ts';

// ─── Type Helpers ───

export function isEquipment(perm: Permanent | Card): boolean {
  const tl = perm.typeLine.toLowerCase();
  return tl.includes('equipment');
}

export function isAura(perm: Permanent | Card): boolean {
  const tl = perm.typeLine.toLowerCase();
  return tl.includes('aura');
}

/** Parse equip cost from oracle text. Returns the mana cost string or null. */
export function getEquipCost(perm: Permanent): string | null {
  const match = perm.oracleText?.match(/equip\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
  if (match) return match[1];
  // Also check for "Equip {N}" pattern (generic mana)
  const genericMatch = perm.oracleText?.match(/equip\s+\{(\d+)\}/i);
  if (genericMatch) return `{${genericMatch[1]}}`;
  return null;
}

/** Parse equipment P/T bonuses from oracle text */
export function getEquipmentBonuses(perm: Permanent): { power: number; toughness: number } {
  // Match "equipped creature gets +X/+Y"
  const match = perm.oracleText?.match(/equipped\s+creature\s+gets?\s+([+-]\d+)\/([+-]\d+)/i);
  if (match) {
    return { power: parseInt(match[1]), toughness: parseInt(match[2]) };
  }
  return { power: 0, toughness: 0 };
}

/** Get keywords that equipment grants to the equipped creature */
export function getEquipmentKeywords(perm: Permanent): string[] {
  const keywords: string[] = [];
  const text = perm.oracleText?.toLowerCase() || '';

  // Match "equipped creature has/gains [keyword]"
  const keywordList = [
    'flying', 'first strike', 'double strike', 'trample', 'lifelink',
    'deathtouch', 'vigilance', 'haste', 'hexproof', 'indestructible',
    'menace', 'reach', 'protection',
  ];

  for (const kw of keywordList) {
    if (text.includes(`equipped creature has ${kw}`) ||
        text.includes(`equipped creature gains ${kw}`)) {
      keywords.push(kw);
    }
  }

  return keywords;
}

/** Parse aura P/T bonuses from oracle text */
export function getAuraBonuses(perm: Permanent): { power: number; toughness: number } {
  // Match "enchanted creature gets +X/+Y"
  const match = perm.oracleText?.match(/enchanted\s+creature\s+gets?\s+([+-]\d+)\/([+-]\d+)/i);
  if (match) {
    return { power: parseInt(match[1]), toughness: parseInt(match[2]) };
  }
  return { power: 0, toughness: 0 };
}

/** Get keywords that aura grants to the enchanted creature */
export function getAuraKeywords(perm: Permanent): string[] {
  const keywords: string[] = [];
  const text = perm.oracleText?.toLowerCase() || '';

  const keywordList = [
    'flying', 'first strike', 'double strike', 'trample', 'lifelink',
    'deathtouch', 'vigilance', 'haste', 'hexproof', 'indestructible',
    'menace', 'reach',
  ];

  for (const kw of keywordList) {
    if (text.includes(`enchanted creature has ${kw}`) ||
        text.includes(`enchanted creature gains ${kw}`)) {
      keywords.push(kw);
    }
  }

  return keywords;
}

// ─── Core Operations ───

/**
 * Attach an equipment to a target creature.
 * - Detaches from previous creature if already attached
 * - Applies stat bonuses to the new creature
 */
export function attachEquipment(
  state: GameState,
  equipmentId: string,
  targetCreatureId: string,
  player: number
): GameState {
  const playerState = state.players[player];

  const eqIdx = playerState.battlefield.findIndex(p => p.id === equipmentId);
  const crIdx = playerState.battlefield.findIndex(p => p.id === targetCreatureId);
  if (eqIdx === -1 || crIdx === -1) return state;

  const equipment = playerState.battlefield[eqIdx];
  const creature = playerState.battlefield[crIdx];

  // Verify it's actually equipment and target is a creature
  if (!isEquipment(equipment)) return state;
  if (creature.currentPower === undefined) return state;

  // Protection: creature has protection from equipment (color or type) → can't equip (DEBT: E)
  if (hasProtectionFromPermanent(creature, equipment)) {
    return state;
  }

  let updatedBf = [...playerState.battlefield];

  // If equipment was already attached to something, detach it first
  if (equipment.attachedTo) {
    const oldCreatureIdx = updatedBf.findIndex(p => p.id === equipment.attachedTo);
    if (oldCreatureIdx !== -1) {
      const oldCreature = updatedBf[oldCreatureIdx];
      const bonuses = getEquipmentBonuses(equipment);
      updatedBf[oldCreatureIdx] = {
        ...oldCreature,
        attachments: oldCreature.attachments.filter(id => id !== equipmentId),
        currentPower: (oldCreature.currentPower ?? 0) - bonuses.power,
        currentToughness: (oldCreature.currentToughness ?? 0) - bonuses.toughness,
      };
    }
  }

  // Attach to new creature
  const bonuses = getEquipmentBonuses(equipment);

  // Update equipment — find its current index since bf may have changed
  const currentEqIdx = updatedBf.findIndex(p => p.id === equipmentId);
  updatedBf[currentEqIdx] = {
    ...updatedBf[currentEqIdx],
    attachedTo: targetCreatureId,
  };

  // Update creature
  const currentCrIdx = updatedBf.findIndex(p => p.id === targetCreatureId);
  updatedBf[currentCrIdx] = {
    ...updatedBf[currentCrIdx],
    attachments: [...updatedBf[currentCrIdx].attachments, equipmentId],
    currentPower: (updatedBf[currentCrIdx].currentPower ?? 0) + bonuses.power,
    currentToughness: (updatedBf[currentCrIdx].currentToughness ?? 0) + bonuses.toughness,
  };

  const updatedPlayer = { ...playerState, battlefield: updatedBf };
  const players = [...state.players];
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
      message: `${equipment.name} is attached to ${creature.name}.`,
      cardName: equipment.name,
      actionType: 'effect',
    }],
  };
}

/**
 * Handle cleanup when a creature with attachments leaves the battlefield.
 * - Equipment stays on battlefield (becomes unattached)
 * - Auras go to graveyard
 *
 * This should be called by state-based actions or zone-change logic.
 */
export function handleAttachmentCleanup(state: GameState): GameState {
  let changed = false;
  const players = [...state.players];
  const logs: string[] = [];

  for (let i = 0; i < 2; i++) {
    const player = players[i];
    let bf = [...player.battlefield];
    const dyingAuras: Card[] = [];
    let playerChanged = false;

    // Find all attachments that point to non-existent permanents OR violate protection
    const bfIds = new Set(bf.map(p => p.id));

    for (let j = 0; j < bf.length; j++) {
      const perm = bf[j];

      // Check for protection violations: aura/equipment attached to creature that has protection from its colors
      if (perm.attachedTo && bfIds.has(perm.attachedTo)) {
        const attachedCreature = bf.find(p => p.id === perm.attachedTo);
        if (attachedCreature && isAura(perm) && hasProtectionFromPermanent(attachedCreature, perm)) {
          // Remove from creature's attachments list
          const crIdx = bf.findIndex(p => p.id === perm.attachedTo);
          if (crIdx !== -1) {
            bf[crIdx] = {
              ...bf[crIdx],
              attachments: bf[crIdx].attachments.filter(id => id !== perm.id),
            };
          }
          // CR 702.102c: Bestow Aura becomes a creature instead of going to graveyard
          if (perm.bestowed) {
            const basePower = perm.power ? parseInt(perm.power, 10) || 0 : undefined;
            const baseToughness = perm.toughness ? parseInt(perm.toughness, 10) || 0 : undefined;
            bf[j] = {
              ...perm,
              attachedTo: undefined,
              bestowed: false,
              currentPower: basePower,
              currentToughness: baseToughness,
              basePower,
              baseToughness,
            };
            logs.push(`${perm.name} becomes a creature — ${attachedCreature.name} has protection from its color (bestow).`);
          } else {
            // Normal Aura falls off due to protection — goes to graveyard
            dyingAuras.push({
              id: perm.id, oracleId: perm.oracleId, name: perm.name,
              manaCost: perm.manaCost, cmc: perm.cmc, typeLine: perm.typeLine,
              oracleText: perm.oracleText, power: perm.power, toughness: perm.toughness,
              loyalty: perm.loyalty, colors: perm.colors, colorIdentity: perm.colorIdentity,
              rarity: perm.rarity, tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
            });
            logs.push(`${perm.name} falls off — ${attachedCreature.name} has protection from its color.`);
            bf[j] = null as unknown as Permanent;
          }
          playerChanged = true;
          continue;
        }
        if (attachedCreature && isEquipment(perm) && hasProtectionFromPermanent(attachedCreature, perm)) {
          // Equipment falls off due to protection — stays on battlefield, becomes unattached
          bf[j] = { ...perm, attachedTo: undefined };
          logs.push(`${perm.name} detaches — ${attachedCreature.name} has protection from its color.`);
          const crIdx = bf.findIndex(p => p.id === perm.attachedTo);
          if (crIdx !== -1) {
            bf[crIdx] = {
              ...bf[crIdx],
              attachments: bf[crIdx].attachments.filter(id => id !== perm.id),
            };
          }
          playerChanged = true;
          continue;
        }
      }

      if (perm.attachedTo && !bfIds.has(perm.attachedTo)) {
        // The thing we were attached to is gone
        if (isAura(perm)) {
          // CR 702.102c: Bestow Aura — becomes a creature instead of going to graveyard
          if (perm.bestowed) {
            const basePower = perm.power ? parseInt(perm.power, 10) || 0 : undefined;
            const baseToughness = perm.toughness ? parseInt(perm.toughness, 10) || 0 : undefined;
            bf[j] = {
              ...perm,
              attachedTo: undefined,
              bestowed: false,
              currentPower: basePower,
              currentToughness: baseToughness,
              basePower,
              baseToughness,
            };
            logs.push(`${perm.name} becomes a creature (bestow — enchanted creature left).`);
            playerChanged = true;
          } else {
            // Normal Aura goes to graveyard
            dyingAuras.push({
              id: perm.id, oracleId: perm.oracleId, name: perm.name,
              manaCost: perm.manaCost, cmc: perm.cmc, typeLine: perm.typeLine,
              oracleText: perm.oracleText, power: perm.power, toughness: perm.toughness,
              loyalty: perm.loyalty, colors: perm.colors, colorIdentity: perm.colorIdentity,
              rarity: perm.rarity, tags: perm.tags, imageUrl: perm.imageUrl, owner: perm.owner,
            });
            logs.push(`${perm.name} goes to graveyard (enchanted permanent left).`);
            bf[j] = null as unknown as Permanent; // mark for removal
            playerChanged = true;
          }
        } else if (isEquipment(perm)) {
          // Equipment stays, becomes unattached
          bf[j] = { ...perm, attachedTo: undefined };
          logs.push(`${perm.name} becomes unattached.`);
          playerChanged = true;
        }
      }
    }

    if (playerChanged) {
      changed = true;
      // Remove null entries (dead auras)
      bf = bf.filter(p => p !== null);
      players[i] = {
        ...player,
        battlefield: bf,
        graveyard: [...player.graveyard, ...dyingAuras],
      };
    }
  }

  if (!changed) return state;

  const logEntries = logs.map((message) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: null | null,
    message,
  }));

  return { ...state, players, log: [...state.log, ...logEntries] };
}

/**
 * Recalculate a creature's power/toughness based on its attachments.
 * Call this when attachments change to ensure correct stats.
 */
export function recalculateCreatureStats(
  state: GameState,
  creatureId: string,
  playerIdx: number
): GameState {
  const player = state.players[playerIdx];
  const crIdx = player.battlefield.findIndex(p => p.id === creatureId);
  if (crIdx === -1) return state;

  const creature = player.battlefield[crIdx];
  if (creature.basePower === undefined) return state;

  let totalPowerBonus = 0;
  let totalToughnessBonus = 0;

  // Sum bonuses from all attachments
  for (const attachId of creature.attachments) {
    const attach = player.battlefield.find(p => p.id === attachId);
    if (!attach) continue;

    if (isEquipment(attach)) {
      const bonuses = getEquipmentBonuses(attach);
      totalPowerBonus += bonuses.power;
      totalToughnessBonus += bonuses.toughness;
    } else if (isAura(attach)) {
      const bonuses = getAuraBonuses(attach);
      totalPowerBonus += bonuses.power;
      totalToughnessBonus += bonuses.toughness;
    }
  }

  // Add counter bonuses
  const plusCounters = creature.counters['+1/+1'] || 0;
  const minusCounters = creature.counters['-1/-1'] || 0;

  // Add temporary P/T mods
  let tempPower = 0;
  let tempToughness = 0;
  for (const mod of creature.temporaryPtMods) {
    tempPower += mod.power;
    tempToughness += mod.toughness;
  }

  const newPower = creature.basePower + totalPowerBonus + plusCounters - minusCounters + tempPower;
  const newToughness = (creature.baseToughness ?? 0) + totalToughnessBonus + plusCounters - minusCounters + tempToughness;

  const updatedCreature = {
    ...creature,
    currentPower: newPower,
    currentToughness: newToughness,
  };

  const updatedBf = [...player.battlefield];
  updatedBf[crIdx] = updatedCreature;
  const updatedPlayer = { ...player, battlefield: updatedBf };
  const players = [...state.players];
  players[playerIdx] = updatedPlayer;

  return { ...state, players };
}
