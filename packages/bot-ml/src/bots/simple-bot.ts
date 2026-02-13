import {
  type GameState, type GameAction,
  getLegalActionTypes, parseManaCost, autoTapLandsForCost
} from '@mtg/game-engine';

/**
 * Heuristic bot with basic gameplay logic.
 * Used as a baseline opponent for training and evaluation.
 */
export class SimpleBot {
  constructor(
      public readonly player: 0 | 1,
      public benchmarkMode: boolean = false
  ) {}
  
  chooseAction(state: GameState): GameAction {
    const me = state.players[this.player];
    const isMyTurn = state.activePlayer === this.player;
    const isMainPhase = state.step === 'main';
    const legalTypes = getLegalActionTypes(state);
    
    // Benchmark Mode: Pick random action for maximum speed test
    if (this.benchmarkMode) {
      return this.getRandomAction(state);
    }
    
    // 1. Play land if in main phase and have land in hand
    if (isMyTurn && isMainPhase && legalTypes.includes('play-land')) {
        const land = me.hand.find(c => c.typeLine.toLowerCase().includes('land'));
        if (land) {
            return { type: 'play-land', player: this.player, cardId: land.id };
        }
    }
    
    // 2. Cast spells in main phase (Iterate to find affordable one)
    if (isMyTurn && isMainPhase && state.stack.length === 0 && legalTypes.includes('cast-spell')) {
      const affordableSpell = me.hand.find(c => {
        if (c.typeLine.toLowerCase().includes('land')) return false;
        if (c.oracleText?.toLowerCase().includes('target')) return false; // Avoid targeted spells for simplicity
        const cost = parseManaCost(c.manaCost);
        return autoTapLandsForCost(me, cost) !== null;
      });

      if (affordableSpell) {
        const cost = parseManaCost(affordableSpell.manaCost);
        const tapResult = autoTapLandsForCost(me, cost);
        if (tapResult) {
          return {
            type: 'cast-spell',
            player: this.player,
            cardId: affordableSpell.id,
            targets: [],
            manaPayment: tapResult.payment
          };
        }
      }
    }
    
    // 3. Declare attackers (simple: all non-summoning sick creatures)
    if (state.step === 'declare-attackers' && isMyTurn && legalTypes.includes('declare-attackers')) {
      const attackers = me.battlefield
        .filter(p => 
          p.typeLine.toLowerCase().includes('creature') &&
          !p.summoningSick &&
          !p.tapped
        )
        .map(p => p.id);
      
      // If we already have attackers declared, we must PASS to proceed to blockers
      if (state.combat?.attackers && state.combat.attackers.length > 0) {
          // Intentionally fall through to default pass
      } else if (attackers.length > 0) {
        return { type: 'declare-attackers', player: this.player, attackers };
      }
    }
    
    // 4. Declare blockers
    if (state.step === 'declare-blockers' && !isMyTurn && legalTypes.includes('declare-blockers')) {
      const myCreatures = me.battlefield.filter(p =>
        p.typeLine.toLowerCase().includes('creature') && !p.tapped
      );
      
      // Simple logic: block first attacker with first available creature
      if (myCreatures.length > 0 && state.combat?.attackers && state.combat.attackers.length > 0) {
         const blockerId = myCreatures[0].id;
         const attackerId = state.combat.attackers[0].permanentId;
         
         // Check if already blocking
         const isAlreadyBlocking = state.combat.blockers.some(b => 
           b.permanentId === blockerId && b.blockingId === attackerId
         );
         
         if (!isAlreadyBlocking) {
             return {
              type: 'declare-blockers',
              player: this.player,
              blocks: [{
                blocker: blockerId,
                attacker: attackerId
              }]
            };
         }
      }
    }
    
    // Default: pass
    return { type: 'pass', player: this.player };
  }

  private getRandomAction(state: GameState): GameAction {
    const legal = getLegalActionTypes(state);
    // Prefer playing lands if legal
    if (legal.includes('play-land')) {
       const land = state.players[this.player].hand.find(c => c.typeLine.toLowerCase().includes('land'));
       if (land) return { type: 'play-land', player: this.player, cardId: land.id };
    }
    return { type: 'pass', player: this.player };
  }
}
