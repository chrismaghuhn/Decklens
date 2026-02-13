import { Card } from '@mtg/game-engine';

export class SynergyCalculator {

  /**
   * Calculate a synergy score between two cards.
   * Returns a value between 0 (no synergy) and 1 (perfect synergy).
   */
  static calculatePairSynergy(cardA: Card, cardB: Card): number {
    let score = 0;
    
    const textA = (cardA.oracleText || '').toLowerCase();
    const textB = (cardB.oracleText || '').toLowerCase();
    const typeA = cardA.typeLine.toLowerCase();
    const typeB = cardB.typeLine.toLowerCase();
    
    // 1. Tribal Synergy
    // If A buffs type X and B is type X
    // Basic heuristic: check for shared creature types if one cares about them.
    // (This requires a list of creature types or parsing "choose a creature type")
    // Simplified: "Other _____ you control get +1/+1"
    
    // Check if A is a lord
    if (textA.includes('other') && (textA.includes('get +') || textA.includes('gets +'))) {
        // Try to extract the type
        // "Other Zombies you control..."
        // Heuristic: check if B has words present in A's buff text?
        // Too complex for regex without dedicated parser.
        // Simple check: Do they share a subtype?
        if (this.shareCreatureType(cardA, cardB)) {
             // And A buffs that type?
             // Assume lords buff their own type usually
             score += 0.3;
        }
    }
    
    // 2. Mechanical Synergy
    // +1/+1 Counters
    if (textA.includes('+1/+1 counter') && textB.includes('+1/+1 counter')) {
        score += 0.2; // Both care about counters
        if (textA.includes('places a +1/+1 counter') && textB.includes('whenever a +1/+1 counter is placed')) {
            score += 0.4; // Producer + Consumer
        }
    }
    
    // Lifegain
    if ((textA.includes('gain life') || textA.includes('lifelink')) && textB.includes('whenever you gain life')) {
        score += 0.5;
    }
    
    // Spells / Prowess
    if ((typeA.includes('instant') || typeA.includes('sorcery')) && (textB.includes('magecraft') || textB.includes('prowess') || textB.includes('whenever you cast an instant or sorcery'))) {
        score += 0.4;
    }
    
    // Sacrifice
    if (textA.includes('sacrifice a creature') && (textB.includes('when this creature dies') || textB.includes('create') && textB.includes('token'))) {
        score += 0.4; // Outlet + Fodder
    }
    
    return Math.min(1.0, score);
  }
  
  /**
   * Calculate total synergy density of a deck.
   */
  static evaluateDeckSynergy(deck: Card[]): number {
     if (deck.length < 2) return 0;
     
     let totalScore = 0;
     let pairs = 0;
     
     // Sample random pairs to estimate? Or optimized O(N^2) if N is small (40-60).
     // 60 cards -> 1800 pairs. Fast enough.
     
     for (let i = 0; i < deck.length; i++) {
         for (let j = i + 1; j < deck.length; j++) {
             // Skip lands for synergy mostly, unless specific land synergies
             if (deck[i].typeLine.includes('Land') && deck[j].typeLine.includes('Land')) continue;
             
             totalScore += this.calculatePairSynergy(deck[i], deck[j]);
             pairs++;
         }
     }
     
     return pairs > 0 ? totalScore / pairs : 0;
  }
  
  private static shareCreatureType(a: Card, b: Card): boolean {
      // Very basic check.
      // Need list of types.
      // Or just check if type line words overlap (excluding "Creature", "Legendary", "Artifact");
      const ignore = ['creature', 'legendary', 'artifact', 'enchantment', '—', '//'];
      const typesA = a.typeLine.toLowerCase().split(' ').filter(w => !ignore.includes(w));
      const typesB = b.typeLine.toLowerCase().split(' ').filter(w => !ignore.includes(w));
      
      return typesA.some(t => typesB.includes(t));
  }
}
