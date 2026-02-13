import { GameState, Permanent, PlayerState } from '@mtg/game-engine';
import { parseManaCost, canPayCost } from '@mtg/game-engine';

/**
 * Evaluates activated abilities of permanents.
 * Helps the bot decide which abilities to activate and when.
 */
export class AbilityEvaluator {
  
  /**
   * Evaluate if an ability is worth activating in the current state.
   * @param source The permanent with the ability.
   * @param abilityIndex The index of the ability on the permanent.
   * @param state Current game state.
   * @param botPlayer Bot's player index.
   * @returns A score representing the value of activating this ability (0 = don't activate).
   */
  static evaluateAbility(
    source: Permanent,
    abilityIndex: number,
    state: GameState,
    botPlayer: 0 | 1
  ): number {
    if (!source.abilities || !source.abilities[abilityIndex]) return 0;
    
    const ability = source.abilities[abilityIndex];
    const text = (ability.text || '').toLowerCase();
    const me = state.players[botPlayer];
    
    // 1. Cost Check
    // We assume the bot engine filters for legal actions, but we should double check affordability
    // specifically if it requires tapping and we are tapped, or mana we don't have?
    // The engine's getLegalActions handles the hard constraints. 
    // We just need to check if it's "worth" the cost (e.g. paying life).
    
    // 2. Identify Ability Type & Value
    let score = 0;
    
    // Draw Cards
    if (text.includes('draw a card')) {
        score += 3.0; // Drawing is good
        // If we have full hand, less valuable? No, more cards always good.
    }
    
    // Manual Mana Fixing / Ramp (e.g. "Add {G}")
    if (text.includes('add') && (text.includes('{') || text.includes('mana'))) {
        // Mana abilities are usually handled by the engine's auto-payment for spells.
        // But if we have excess mana at end of turn, maybe?
        // Generally we shouldn't manually activate mana abilities unless we have a mana sink.
        return 0.1; // Very low score, prefer casting spells
    }
    
    // Token Generation
    if (text.includes('create') && text.includes('token')) {
        score += 2.5; 
        // If instant speed and end of opponent turn?
        if (state.activePlayer !== botPlayer && state.phase === 'ending') {
            score += 1.0; // Hold up mana for end step
        }
    }
    
    // Pump / Buff
    if (text.includes('+') && text.includes('/+')) {
        // Only good during combat
        if (state.phase === 'combat') {
            // If we are attacking or blocking with this creature?
            if (source.attacking || source.blocking) score += 2.0;
            // Or target? (TargetingSolver handles targets)
            else score += 1.0; 
        } else {
            score -= 10.0; // Don't pump outside combat usually
        }
    }
    
    // Damage / Removal
    if (text.includes('damage') || text.includes('destroy')) {
        score += 4.0;
        // Prioritize killing things
    }
    
    // 3. Penalty for "Sacrifice this creature"
    if (text.includes('sacrifice') && text.includes('source')) {
        score -= 3.0; // Only do it if really necessary
        if (text.includes('draw a card') && source.currentPower === 1) { // Heuristic: weak creature
            score += 4.0; // Sac chump blocker for draw is good
        }
    }
    
    return Math.max(0, score);
  }
}
