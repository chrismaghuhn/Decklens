import { describe, it, expect, beforeEach } from 'vitest';
import { MLBot } from '../../bot-ml';
import { resetIds, createMainPhaseState, putOnBattlefield, makeCreature, makeInstant, addToHand, setMana, makeLand } from '../test-helpers';
import { TargetingSolver } from '../../targeting/targeting-solver';

beforeEach(() => resetIds());

describe('Integration — Targeting & Abilities', () => {
    
    it('should target high-threat enemy creature with removal', () => {
        const bot = new MLBot(0);
        let state = createMainPhaseState(); // Bot is player 1 in this helper usually? No, helper makes p0=Human, p1=Bot.
        // Let's assume we are testing logic from perspective of Player 0 for simplicity, or just pass the ID.
        
        // Setup: Opponent (p1) has a threatening Dragon (5/5 Flying)
        state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 1, { oracleText: 'Flying' }), 1);
        // And a weak bear (2/2)
        state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 1), 1);
        
        // We (p0) cast Doom Blade
        const doomBlade = makeInstant('Doom Blade', '{1}{B}', 0, { 
            oracleText: 'Destroy target nonblack creature.',
            tags: ['removal']
        });
        
        // Solve targets
        const targets = TargetingSolver.solve(doomBlade, state, 0);
        
        expect(targets).toBeDefined();
        expect(targets?.length).toBe(1);
        if (targets && targets[0]) {
            // Should target the Dragon (id ends with bigger number usually if created later? or check ID matches)
            const dragon = state.players[1].battlefield.find(c => c.name === 'Dragon');
            expect(targets[0].id).toBe(dragon?.id);
        }
    });

    it('should target own best creature with pump spell', () => {
        let state = createMainPhaseState();
        
        // We (p0) have a 1/1 Elf and a 5/5 Trampler
        state = putOnBattlefield(state, makeCreature('Elf', '{G}', '1', '1', 0), 0);
        state = putOnBattlefield(state, makeCreature('Colossus', '{G}{G}', '5', '5', 0, { oracleText: 'Trample' }), 0);
        
        const giantGrowth = makeInstant('Giant Growth', '{G}', 0, {
            oracleText: 'Target creature gets +3/+3 until end of turn.',
            tags: ['pump' as any]
        });
        
        const targets = TargetingSolver.solve(giantGrowth, state, 0);
        
        expect(targets).toBeDefined();
        if (targets && targets[0]) {
            const colossus = state.players[0].battlefield.find(c => c.name === 'Colossus');
            expect(targets[0].id).toBe(colossus?.id);
        }
    });

    it('should target opponent face with burn if no creatures or lethal', () => {
        let state = createMainPhaseState();
        
        const bolt = makeInstant('Lightning Bolt', '{R}', 0, {
            oracleText: 'Deal 3 damage to any target.',
            tags: ['removal'] // burn often tagged removal
        });
        
        // Case 1: Empty board -> Face
        const targets1 = TargetingSolver.solve(bolt, state, 0);
        expect(targets1?.[0].type).toBe('player');
        expect(targets1?.[0].id).toBe(String(state.players[1].id));
        
        // Case 2: Opponent has creature, but we prioritize face?
        // Current logic prioritizes creatures for removal-tagged spells usually.
        // Unless it's explicitly "Any target" and we have heuristic?
        // TargetingSolver implementation prioritizes creatures for Removal.
        
        state = putOnBattlefield(state, makeCreature('Target Dummy', '{1}', '1', '1', 1), 1);
        const targets2 = TargetingSolver.solve(bolt, state, 0);
        expect(targets2?.[0].type).toBe('permanent'); 
    });
});
