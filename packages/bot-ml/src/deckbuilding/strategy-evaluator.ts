import { Card } from '@mtg/game-engine';

export type DeckArchetype = 'aggro' | 'control' | 'midrange' | 'combo' | 'ramp' | 'tempo';

export interface DeckAnalysis {
  archetype: DeckArchetype;
  averageCmc: number;
  creatureCount: number;
  landCount: number;
  spellCount: number;
  curve: number[]; // Count of cards at CMC 0, 1, 2, 3, 4, 5, 6+
  colors: string[];
  aggressionScore: number; // 0-10, higher is faster
  controlScore: number; // 0-10, higher is more reactive
}

/**
 * Evaluates deck strategy and characteristics.
 * Helps the bot understand "Who am I?" in a match.
 */
export class DeckStrategyEvaluator {
  
  /**
   * Analyze a deck list to determine its strategy.
   */
  static analyzeDeck(deck: Card[]): DeckAnalysis {
    const nonLands = deck.filter(c => !c.typeLine.toLowerCase().includes('land'));
    const lands = deck.filter(c => c.typeLine.toLowerCase().includes('land'));
    
    // 1. Basic Counts
    const creatureCount = deck.filter(c => c.typeLine.toLowerCase().includes('creature')).length;
    const landCount = lands.length;
    const spellCount = deck.length - creatureCount - landCount;
    
    // 2. Curve Analysis
    const curve = [0, 0, 0, 0, 0, 0, 0];
    let totalCmc = 0;
    
    for (const c of nonLands) {
        let cost = c.cmc || 0;
        if (cost > 6) cost = 6;
        curve[cost]++;
        totalCmc += (c.cmc || 0);
    }
    
    const averageCmc = nonLands.length > 0 ? totalCmc / nonLands.length : 0;
    
    // 3. Archetype Scores
    // Aggression: Cheap creatures, hasty creatures, burn
    let aggroPoints = 0;
    // Control: Counterspells, removal, board wipes, card draw, high CMC finishers
    let controlPoints = 0;
    // Ramp: Ramp spells, high CMC
    let rampPoints = 0;
    
    for (const c of nonLands) {
        const text = (c.oracleText || '').toLowerCase();
        const type = c.typeLine.toLowerCase();
        const cmc = c.cmc || 0;
        
        // Aggro Signals
        if (type.includes('creature')) {
            if (cmc <= 2) aggroPoints += 2;
            if (cmc === 3) aggroPoints += 1;
            if (text.includes('haste')) aggroPoints += 2;
            if (text.includes('attacks each combat')) aggroPoints += 2;
        }
        if (text.includes('deal') && text.includes('damage') && (text.includes('any target') || text.includes('player'))) {
             aggroPoints += 1; // Burn
        }
        
        // Control Signals
        if (text.includes('counter target spell')) controlPoints += 3;
        if (text.includes('destroy all creatures')) controlPoints += 5; // Board wipe
        if (text.includes('draw') && text.includes('cards')) controlPoints += 1;
        if (type.includes('planeswalker')) controlPoints += 2;
        if (cmc >= 6) {
            controlPoints += 2; // Finisher
            rampPoints += 1;
        }
        
        // Removal is control-ish but also midrange
        if (c.tags?.includes('removal')) controlPoints += 1;
        
        // Ramp Signals
        if (text.includes('search your library') && text.includes('land')) rampPoints += 3;
        if (text.includes('add') && text.includes('mana')) rampPoints += 2;
    }
    
    // Normalize scores (heuristic)
    const aggressionScore = Math.min(10, aggroPoints / 3);
    const controlScore = Math.min(10, controlPoints / 3);
    
    // 4. Determine Archetype
    let archetype: DeckArchetype = 'midrange';
    
    if (aggressionScore > 7 && averageCmc < 3.0) {
        archetype = 'aggro';
    } else if (controlScore > 7 && averageCmc > 3.5) {
        archetype = 'control';
    } else if (rampPoints > 8) {
        archetype = 'ramp';
    } else if (controlScore > 5 && aggressionScore > 5) {
        archetype = 'midrange';
    } else {
        // Fallback checks
        if (creatureCount > 24) archetype = 'aggro'; // Stompy?
        else if (spellCount > 20) archetype = 'control'; // Spellslinger?
    }
    
    // Detect Colors
    const colorSet = new Set<string>();
    deck.forEach(c => {
        if (c.colors) c.colors.forEach(col => colorSet.add(col));
    });
    const colors = Array.from(colorSet);

    return {
      archetype,
      averageCmc,
      creatureCount,
      landCount,
      spellCount,
      curve,
      colors,
      aggressionScore,
      controlScore
    };
  }
}
