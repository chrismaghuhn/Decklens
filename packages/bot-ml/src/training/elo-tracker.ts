/**
 * Elo Rating Tracker
 * Tracks skill ratings for bots and snapshots to enable intelligent matchmaking.
 */

export class EloTracker {
  private ratings: Map<string, number> = new Map();
  private kFactor: number = 32;
  private defaultRating: number = 1200;

  constructor(initialRatings?: Record<string, number>) {
    if (initialRatings) {
      for (const [id, rating] of Object.entries(initialRatings)) {
        this.ratings.set(id, rating);
      }
    }
  }

  /**
   * Get rating for a bot ID (or default)
   */
  getRating(id: string): number {
    return this.ratings.get(id) ?? this.defaultRating;
  }

  /**
   * Update ratings after a game
   * @param winnerId ID of the winning bot
   * @param loserId ID of the losing bot
   * @param draw If true, result is a draw (0.5 score)
   */
  updateRating(winnerId: string, loserId: string, draw: boolean = false): void {
    const rw = this.getRating(winnerId);
    const rl = this.getRating(loserId);

    const expectedW = 1 / (1 + Math.pow(10, (rl - rw) / 400));
    const expectedL = 1 / (1 + Math.pow(10, (rw - rl) / 400));

    const actualW = draw ? 0.5 : 1;
    const actualL = draw ? 0.5 : 0;

    const newRw = rw + this.kFactor * (actualW - expectedW);
    const newRl = rl + this.kFactor * (actualL - expectedL);

    this.ratings.set(winnerId, newRw);
    this.ratings.set(loserId, newRl);
  }

  /**
   * Select an opponent close to the target rating
   * @param targetRating The rating of the bot looking for an opponent
   * @param candidates List of opponent IDs available
   * @param diversityFactor Randomness factor (higher = wider range)
   */
  selectOpponent(targetRating: number, candidates: string[], diversityFactor: number = 100): string | null {
    if (candidates.length === 0) return null;

    // Weight candidates by closeness to rating
    const weighted = candidates.map(id => {
      const r = this.getRating(id);
      const diff = Math.abs(r - targetRating);
      // Bell curve weight: e^(-diff^2 / 2sigma^2)
      // diversityFactor is sigma
      const weight = Math.exp(-(diff * diff) / (2 * diversityFactor * diversityFactor));
      return { id, weight };
    });

    // Weighted random selection
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const item of weighted) {
      random -= item.weight;
      if (random <= 0) return item.id;
    }
    
    return weighted[weighted.length - 1].id;
  }

  /**
   * Export ratings as JSON object
   */
  export(): Record<string, number> {
    return Object.fromEntries(this.ratings);
  }
}
