import { Card } from '@mtg/game-engine';
import { DeckStrategyEvaluator, DeckAnalysis } from './strategy-evaluator';
import { SynergyCalculator } from './synergy-calculator';

export interface DraftState {
  pickedCards: Card[];
  currentPack: Card[];
  packNumber: number; // 1, 2, 3
  pickNumber: number; // 1-15
}

export interface PickDecision {
  cardId: string;
  score: number;
  reason: string;
}

export class DraftPickPolicy {
  
  /**
   * Choose the best card from the pack.
   */
  static pickCard(state: DraftState): PickDecision {
    const { pickedCards, currentPack } = state;
    
    // Analyze current deck state
    const currentAnalysis = DeckStrategyEvaluator.analyzeDeck(pickedCards);
    
    // Determine committed colors
    const colors = this.determineColors(pickedCards, currentAnalysis);
    
    let bestPick: PickDecision | null = null;
    
    for (const card of currentPack) {
        const score = this.evaluateCardForDeck(card, pickedCards, currentAnalysis, colors, state.packNumber);
        
        if (!bestPick || score > bestPick.score) {
            bestPick = {
                cardId: card.id,
                score,
                reason: `Score: ${score.toFixed(2)}`
            };
        }
    }
    
    // Fallback?
    if (!bestPick && currentPack.length > 0) {
        return { cardId: currentPack[0].id, score: 0, reason: 'Fallback' };
    }
    
    return bestPick!;
  }
  
  private static evaluateCardForDeck(
      card: Card, 
      picked: Card[], 
      analysis: DeckAnalysis,
      colors: string[],
      packNum: number
  ): number {
      let score = 0;
      
      // 1. Raw Power (BREAD - Bombs, Removal)
      // We don't have a static "rating" for cards yet.
      // Heuristic based on rarity/cmc/text?
      if (card.rarity === 'mythic') score += 4;
      if (card.rarity === 'rare') score += 3;
      if (card.rarity === 'uncommon') score += 1; // Uncommons usually better than commons
      
      const isRemoval = card.tags?.includes('removal') || card.oracleText?.toLowerCase().includes('destroy');
      if (isRemoval) score += 3; // Removal is premium
      
      const isEvasive = card.oracleText?.toLowerCase().includes('flying');
      if (isEvasive) score += 1;
      
      // 2. Color Compatibility
      // Pack 1 early picks: Flexible.
      // Pack 2/3: Strict.
      
      const cardColors = card.colors || [];
      const isColorless = cardColors.length === 0;
      
      if (isColorless) {
          score += 2; // Flexible
      } else {
          // Check match
          const matches = cardColors.filter(c => colors.includes(c)).length;
          
          if (packNum === 1 && picked.length < 5) {
              // Early pack 1: Speculate
              if (matches > 0) score += 2; // On color
          } else {
              // Later: strict adherence
              if (matches === cardColors.length) {
                   score += 3; // Perfect match
              } else if (matches > 0) {
                   score += 0.5; // Splash?
                   if (cardColors.length > 1) score -= 1; // Gold card off-color is hard
              } else {
                   score -= 10; // Off color (unless pivoting)
              }
          }
      }
      
      // 3. Curve Considerations
      // If we desperately need 2-drops
      if (picked.length > 10) {
           const curve = analysis.curve;
           const cmc = Math.min(6, card.cmc || 0);
           
           if (cmc <= 3 && curve[cmc] < 3) score += 2; // Fill early curve
           if (cmc >= 5 && curve[cmc] > 4) score -= 1; // Too many expensive cards
      }
      
      // 4. Synergy
      // Check synergy with existing picks
      // We can't check against ALL picks efficiently if pool is large?
      // Just check recent picks or average?
      // SynergyCalculator is pairwise.
      
      // Sample last 5 picks + 5 random others?
      // Or just compute average synergy with top cards.
      let synergySum = 0;
      let checks = 0;
      const sample = picked.slice(0, 10); // Check against first 10 (usually best?)
      // Actually `picked` is order of pick?
      // Better to check against "Playables".
      
      for (const p of sample) {
          synergySum += SynergyCalculator.calculatePairSynergy(card, p);
          checks++;
      }
      if (checks > 0) {
          score += (synergySum / checks) * 5; // Weight synergy
      }
      
      return score;
  }
  
  private static determineColors(picked: Card[], analysis: DeckAnalysis): string[] {
      // Simple logic: most frequent colors
      const colorCounts: Record<string, number> = { 'W': 0, 'U': 0, 'B': 0, 'R': 0, 'G': 0 };
      
      picked.forEach(c => {
          c.colors?.forEach(col => {
              if (colorCounts[col] !== undefined) colorCounts[col]++;
          });
      });
      
      // Sort
      const sorted = Object.entries(colorCounts).sort((a,b) => b[1] - a[1]);
      
      // Pick top 2
      const top2 = sorted.slice(0, 2).filter(e => e[1] > 2); // Threshold
      return top2.map(e => e[0]);
  }
}
