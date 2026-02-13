
import { DeckStrategyEvaluator } from '../deckbuilding/strategy-evaluator.ts';
import { DraftPickPolicy, DraftState } from '../deckbuilding/draft-policy.ts';
import { Card, createSimpleCard } from '@mtg/game-engine';

// Mock Card Database generator
function generateRandomPack(): Card[] {
    const colors = ['W', 'U', 'B', 'R', 'G'];
    const pack: Card[] = [];
    
    // 1 Rare
    pack.push(createSimpleCard(`Rare ${Math.random()}`, 'Creature', '{3}{W}', 0, { rarity: 'rare', colors: [colors[Math.floor(Math.random()*5)] as any], cmc: 4 }));
    
    // 3 Uncommons
    for(let i=0; i<3; i++) {
        pack.push(createSimpleCard(`Uncommon ${i}`, 'Instant', '{1}{U}', 0, { rarity: 'uncommon', colors: [colors[Math.floor(Math.random()*5)] as any], cmc: 2 }));
    }
    
    // 10 Commons
    for(let i=0; i<10; i++) {
        const col = colors[Math.floor(Math.random()*5)] as any;
        pack.push(createSimpleCard(`Common ${i}`, 'Creature', '{2}{G}', 0, { rarity: 'common', colors: [col], cmc: Math.floor(Math.random()*6)+1 }));
    }
    
    return pack;
}

async function runDraft() {
    console.log('Starting Draft Simulation...');
    
    const pickedCards: Card[] = [];
    
    // Simulate 3 packs
    for (let packNum = 1; packNum <= 3; packNum++) {
        console.log(`\n--- Pack ${packNum} ---`);
        
        // In a real draft, packs rotate. Here we just generate fresh packs 15 times for simplicity 
        // (Simulating "seeing" a pack, picking, and passing the rest away).
        // Actually, to simulate a draft seat, we should receive 15 packs of decreasing size?
        // Let's just do 15 picks from 15 fresh packs for a "League" style simulation test.
        
        for (let pickNum = 1; pickNum <= 15; pickNum++) {
            const pack = generateRandomPack();
            
            const state: DraftState = {
                pickedCards,
                currentPack: pack,
                packNumber: packNum,
                pickNumber: pickNum
            };
            
            const decision = DraftPickPolicy.pickCard(state);
            const card = pack.find(c => c.id === decision.cardId)!;
            
            pickedCards.push(card);
            
            console.log(`Pick ${pickNum}: ${card.name} (${card.colors?.join('/') || 'C'}) - Score: ${decision.score.toFixed(1)}`);
        }
    }
    
    console.log('\n--- Draft Complete ---');
    console.log(`Total Cards: ${pickedCards.length}`);
    
    const analysis = DeckStrategyEvaluator.analyzeDeck(pickedCards);
    console.log('\n--- Deck Analysis ---');
    console.log(`Archetype: ${analysis.archetype}`);
    console.log(`Colors: ${analysis.colors.join(', ')}`);
    console.log(`Curve: ${analysis.curve.join('-')}`);
    console.log(`Aggro Score: ${analysis.aggressionScore.toFixed(1)}`);
    console.log(`Control Score: ${analysis.controlScore.toFixed(1)}`);
}

runDraft().catch(console.error);
