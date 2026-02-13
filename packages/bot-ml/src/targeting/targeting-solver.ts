import { GameState, Card, Permanent, Target } from '@mtg/game-engine';
import { identifyThreats, Threat } from '../../../bot-core/src/evaluators/threat-evaluator';

/**
 * Solves targeting requirements for spells and abilities.
 * Replaces the heuristic-based `resolveTargets` in bot-ml.ts.
 */
export class TargetingSolver {
  
  /**
   * Determine the best targets for a given card/ability.
   * @param card The card being cast or ability source.
   * @param state Current game state.
   * @param botPlayer The bot's player index (0 or 1).
   * @returns Array of targets, or null if no valid targets found but are required.
   */
  static solve(card: Card, state: GameState, botPlayer: 0 | 1): Target[] | null {
    const text = (card.oracleText || '').toLowerCase();
    
    // 1. Identify Target Requirements
    const reqs = this.parseRequirements(text);
    if (!reqs.needsTarget) return []; // No targets needed
    
    // 2. Select Targets based on Strategy
    
    // CASE A: Removal / Negative Effects
    if (this.isRemoval(text, card.tags)) {
      return this.solveRemovalTargets(reqs, state, botPlayer);
    }
    
    // CASE B: Pump / Positive Effects
    if (this.isBuff(text, card.tags)) {
        return this.solveBuffTargets(reqs, state, botPlayer);
    }
    
    // CASE C: Counterspells
    if (text.includes('counter target spell')) {
        return this.solveCounterTargets(state, botPlayer);
    }

    // Default: If we can't determine strategy, try to just pick a valid target to avoid illegal action.
    const opp = state.players[(1 - botPlayer) as 0 | 1];

    // For "any target", heuristic default to opponent face.
    if (reqs.canTargetPlayer && reqs.canTargetOpponent) {
        return [{ type: 'player', id: String(opp.id) }];
    }
    
    // Fallback: Pick "best" opponent creature if it's a creature target
    if (reqs.canTargetCreature) {
        const threats = identifyThreats(state, botPlayer);
        const creatureThreats = threats.filter(t => t.type === 'permanent');

        if (creatureThreats.length > 0) {
            return [{ type: 'permanent', id: creatureThreats[0].sourceId }];
        }
        // Just pick any opponent creature
        const oppCreature = opp.battlefield.find(p => p.typeLine.toLowerCase().includes('creature'));
        if (oppCreature) return [{ type: 'permanent', id: oppCreature.id }];
    }

    // If targets required but none found/selected
    return null;
  }
  
  // ------------------------------------------------------------------------
  // Parsing Logic
  // ------------------------------------------------------------------------
  
  private static parseRequirements(text: string) {
    const needsTarget = text.includes('target') || text.includes('enchant') || text.includes('equip');
    
    return {
      needsTarget,
      canTargetCreature: /target\s+([a-z\s]*\s)?creature/.test(text) || text.includes('any target') || text.includes('destroy target permanent'),
      canTargetPlayer: /target\s+([a-z\s]*\s)?(player|opponent)/.test(text) || text.includes('any target'),
      canTargetOpponent: !text.includes('target player you control'),
      canTargetOwn: !text.includes('target opponent'),
      isAnyTarget: text.includes('any target'),
      count: 1 
    };
  }
  
  private static isRemoval(text: string, tags: string[] = []): boolean {
      if (tags.includes('removal')) return true;
      if (text.includes('destroy') && !text.includes('you control')) return true;
      if (text.includes('exile') && !text.includes('you control')) return true;
      if (text.includes('deal') && text.includes('damage')) return true; // Burn
      if (text.includes('-') && text.includes('/-')) return true; // -X/-X
      if (text.includes('return') && text.includes('owner\'s hand') && text.includes('target permanent')) return true; // Bounce
      return false;
  }
  
  private static isBuff(text: string, tags: string[] = []): boolean {
      if (tags.includes('pump')) return true;
      if (text.includes('gets +') && !text.includes('gets -')) return true;
      if (text.includes('counter') && text.includes('+1/+1')) return true;
      if (text.includes('gain') && (text.includes('flying') || text.includes('haste') || text.includes('trample'))) return true;
      if (text.includes('enchant target creature')) return true; // Auras usually buffs
      return false;
  }

  // ------------------------------------------------------------------------
  // Solvers
  // ------------------------------------------------------------------------

  private static solveRemovalTargets(reqs: any, state: GameState, botPlayer: 0 | 1): Target[] | null {
    const opp = state.players[(1 - botPlayer) as 0 | 1];
    
    // Priority 1: Kill Threatening Creatures
    if (reqs.canTargetCreature) {
        const threats = identifyThreats(state, botPlayer);
        const creatureThreats = threats.filter(t => t.type === 'permanent');
        
        if (creatureThreats.length > 0) {
            // Pick top threat
            return [{ type: 'permanent', id: creatureThreats[0].sourceId }];
        }
        
        // If no high-priority threats but opponent has creatures, pick largest power
        const oppCreatures = opp.battlefield.filter(p => p.typeLine.toLowerCase().includes('creature'));
        if (oppCreatures.length > 0) {
            oppCreatures.sort((a,b) => (b.currentPower||0) - (a.currentPower||0));
            return [{ type: 'permanent', id: oppCreatures[0].id }];
        }
    }
    
    // Priority 2: Burn Face (if removal is also burn for 'any target')
    if (reqs.isAnyTarget || reqs.canTargetPlayer) {
        // If opponent is low on life, prioritize face?
        // For now, always face if no creatures
        return [{ type: 'player', id: String(opp.id) }];
    }
    
    return null;
  }

  private static solveBuffTargets(reqs: any, state: GameState, botPlayer: 0 | 1): Target[] | null {
      const me = state.players[botPlayer];
      
      if (!reqs.canTargetCreature) return null;
      
      const myCreatures = me.battlefield.filter(p => p.typeLine.toLowerCase().includes('creature'));
      if (myCreatures.length === 0) return null;
      
      // Heuristic:
      // 1. Prefer unblocked attackers (during combat) or evasive creatures
      // 2. Prefer largest creature (win-more)
      
      // Filter for evasive
      const evasive = myCreatures.filter(c => {
          const txt = (c.oracleText || '').toLowerCase();
          return txt.includes('flying') || txt.includes('trample') || txt.includes('unblockable');
      });
      
      if (evasive.length > 0) {
          evasive.sort((a,b) => (b.currentPower||0) - (a.currentPower||0));
          return [{ type: 'permanent', id: evasive[0].id }];
      }
      
      // Default: biggest creature
      myCreatures.sort((a,b) => (b.currentPower||0) - (a.currentPower||0));
      return [{ type: 'permanent', id: myCreatures[0].id }];
  }

  private static solveCounterTargets(state: GameState, botPlayer: 0 | 1): Target[] | null {
      // Look at stack
      if (state.stack.length === 0) return null;
      
      const opp = (1 - botPlayer) as 0 | 1;
      
      // Must target something controlled by opponent ideally
      // Iterate stack from top down
      for (let i = state.stack.length - 1; i >= 0; i--) {
          const item = state.stack[i];
          if (item.controller === opp) {
              return [{ type: 'card-in-zone', id: item.id, zone: 'stack' }];
          }
      }
      
      return null;
  }
}
