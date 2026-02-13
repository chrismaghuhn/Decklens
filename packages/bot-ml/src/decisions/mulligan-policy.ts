import { Card } from '@mtg/game-engine';

/**
 * Heuristics for Mulligan Decisions.
 * Ensures the bot starts with a playable hand.
 */
export class MulliganPolicy {

  /**
   * Decide whether to mulligan the current hand.
   * @param hand Current hand.
   * @param mulliganCount Number of times already mulliganed (0 initially).
   * @param isOnPlay True if bot plays first (skips first draw).
   */
  static shouldMulligan(hand: Card[], mulliganCount: number, isOnPlay: boolean): boolean {
    const handSize = hand.length;
    // Don't mulligan to oblivion
    if (handSize <= 4) return false;

    const landCount = hand.filter(c => c.typeLine.toLowerCase().includes('land')).length;
    
    // 0 or 1 lands: almost always mulligan (unless mono-red aggro with 1 land?)
    if (landCount <= 1) return true;
    
    // Too many lands
    if (landCount >= 6) return true;
    if (landCount === 5 && handSize === 7) return true; // 5 lands in 7 is bad usually
    
    // Check for early plays (CMC 1-3)
    // We want at least something to do in first 3 turns
    const earlyPlays = hand.filter(c => 
        !c.typeLine.toLowerCase().includes('land') && 
        c.cmc <= 3
    ).length;
    
    if (earlyPlays === 0 && landCount >= 4) return true; // Flooded with expensive stuff
    
    // Color Screw check?
    // Hard to check without deck context, but we can check if we have spells we can cast with lands present?
    // For now, simple heuristics are better than nothing.
    
    return false;
  }

  /**
   * Select cards to put on the bottom of the library (for London Mulligan).
   * @param hand Current hand.
   * @param countToBottom Number of cards to return.
   * @returns Array of card IDs.
   */
  static getCardsToBottom(hand: Card[], countToBottom: number): string[] {
      if (countToBottom <= 0) return [];
      
      // We need to keep the best heuristic hand of size (hand.length - countToBottom)
      // Sort cards by "keep value"
      
      const scoredHand = hand.map(c => {
          let score = 0;
          const isLand = c.typeLine.toLowerCase().includes('land');
          
          if (isLand) {
              score = 10; // Lands are crucial, but we don't want too many
              // We'll handle land balance later
          } else {
              // Spells: prefer cheap spells
              if (c.cmc <= 2) score = 8;
              else if (c.cmc === 3) score = 7;
              else if (c.cmc === 4) score = 6;
              else score = 5 - (c.cmc - 5); // Penalize expensive
              
              if (c.tags.includes('removal')) score += 2;
              if (c.tags.includes('draw')) score += 1;
              if (c.tags.includes('ramp')) score += 2;
          }
          return { card: c, score };
      });
      
      // Algorithm:
      // We want to keep 3-4 lands ideally.
      // Filter out excess lands first?
      // Or just sort by score?
      
      // Let's perform a smart selection
      // Sort by basic score first
      scoredHand.sort((a,b) => a.score - b.score); // Ascending (worst first)
      
      const toBottom: string[] = [];
      const lands = hand.filter(c => c.typeLine.toLowerCase().includes('land'));
      const spells = hand.filter(c => !c.typeLine.toLowerCase().includes('land'));
      
      let currentLands = lands.length;
      let currentSpells = spells.length;
      
      // Select cards to remove
      // 1. Remove excess lands (>4)
      for (const c of lands) {
          if (toBottom.length >= countToBottom) break;
          if (currentLands > 4) {
              toBottom.push(c.id);
              currentLands--;
          }
      }
      
      // 2. Remove expensive spells (CMC > 5)
      spells.sort((a,b) => b.cmc - a.cmc); // Descending CMC
      for (const c of spells) {
          if (toBottom.length >= countToBottom) break;
          if (c.cmc >= 6) {
              toBottom.push(c.id);
              currentSpells--;
          }
      }
      
      // 3. Remove excess spells if we have too few lands (keep lands!)
      // Wait, if we have few lands, we should keep them.
      // The logic above removed EXCESS lands.
      
      // If we still need to remove cards, remove worst spells (by score)
      if (toBottom.length < countToBottom) {
          const remainingSpells = spells.filter(c => !toBottom.includes(c.id));
          // Recalculate basic scores for remaining
           // ... simpler: just pick strictly worst score from remaining hand
           
           const remaining = hand.filter(c => !toBottom.includes(c.id));
           // Sort so that worst are at start (lowest score)
           // Re-score based on curve
           const reScored = remaining.map(c => {
               let s = 0;
               if (c.typeLine.toLowerCase().includes('land')) return { c, s: 100 }; // Keep lands if we are down to core
               s = 10 - c.cmc; // Prefer low CMC
               return { c, s };
           });
           reScored.sort((a,b) => a.s - b.s); // worst first
           
           for (const item of reScored) {
               if (toBottom.length >= countToBottom) break;
               toBottom.push(item.c.id);
           }
      }
      
      return toBottom;
  }
}
