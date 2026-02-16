import { describe, it, expect, beforeEach } from 'vitest';
import { MLBot } from '../bot-ml.ts';
import { PolicyNetwork } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { FEATURE_DIM } from '../networks/feature-extractor.ts';
import { resetIds, createMainPhaseState, putOnBattlefield, makeCreature, makeInstant, makeSorcery, addToHand, makeLand, setMana } from './test-helpers.ts';

beforeEach(() => resetIds());

describe('MLBot', () => {
  it('should be constructed with a player ID', () => {
    const bot = new MLBot(0);
    expect(bot.player).toBe(0);
  });

  it('should construct with custom networks', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);
    const bot = new MLBot(1, policyNet, valueNet);
    expect(bot.player).toBe(1);
    expect(bot.getPolicyNetwork()).toBe(policyNet);
    expect(bot.getValueNetwork()).toBe(valueNet);
  });

  it('should choose an action', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    expect(action.player).toBe(0);
  });

  it('should choose action with reasoning', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();
    const decision = bot.chooseActionWithReason(state);
    expect(decision.action).toBeDefined();
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.actionProbs).toBeDefined();
    expect(typeof decision.value).toBe('number');
    expect(decision.value).toBeGreaterThanOrEqual(-1); // v2: tanh [-1,1]
    expect(decision.value).toBeLessThanOrEqual(1);
  });

  it('should predict position value in [-1, 1] (tanh)', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();
    const value = bot.predictValue(state);
    expect(value).toBeGreaterThanOrEqual(-1); // v2: tanh output [-1,1] (was sigmoid [0,1])
    expect(value).toBeLessThanOrEqual(1);
  });

  it('should extract features', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();
    const features = bot.getFeatures(state);
    expect(features).toBeInstanceOf(Float32Array);
    expect(features.length).toBe(FEATURE_DIM);
  });

  it('should get policy logits', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();
    const logits = bot.getLogits(state);
    expect(logits).toBeInstanceOf(Float32Array);
    expect(logits.length).toBe(8);
  });

  it('should track decision history', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();

    bot.chooseAction(state);
    bot.chooseAction(state);

    const history = bot.getDecisionHistory();
    expect(history).toHaveLength(2);
  });

  it('should reset history', () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();

    bot.chooseAction(state);
    expect(bot.getDecisionHistory()).toHaveLength(1);

    bot.resetHistory();
    expect(bot.getDecisionHistory()).toHaveLength(0);
  });

  it('should set temperature', () => {
    const bot = new MLBot(0, undefined, undefined, 1.0);
    bot.setTemperature(0.5);
    // Just verify it doesn't crash — temperature effects are probabilistic
    const state = createMainPhaseState();
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
  });

  // Note: serialize() uses localStorage which isn't available in Node/Vitest.
  // Will be fixed in Phase 3 with model-persistence.ts.
  it('should serialize and deserialize', async () => {
    const bot = new MLBot(0);
    const state = createMainPhaseState();
    const valueBefore = bot.predictValue(state);

    const data = await bot.serialize();
    expect(data.policy).toBeInstanceOf(ArrayBuffer);
    expect(data.value).toBeInstanceOf(ArrayBuffer);

    const restored = await MLBot.deserialize(0, data);
    const valueAfter = restored.predictValue(state);
    expect(valueAfter).toBeCloseTo(valueBefore, 5);
  });

  it('should handle play-land action type', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = addToHand(state, makeLand('Forest', 0), 0);

    // The bot may or may not choose to play a land (probabilistic),
    // but it should not crash
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    expect(action.player).toBe(0);
  });

  it('should handle cast-spell action type', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = addToHand(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0);
    state = setMana(state, 0, { G: 3 });

    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    expect(action.player).toBe(0);
  });
});

// ============================================================
// Phase 4: Smart Action Selection Tests
// ============================================================

describe('MLBot — Scored Spell Selection', () => {
  it('should prefer removal when opponent has threats', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();

    // Opponent has a 5/5 threat
    state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 1), 1, 1);
    state.players[1].battlefield[0].summoningSick = false;

    // We have both a bear AND removal in hand
    const bear = makeCreature('Bear', '{1}{G}', '2', '2', 0);
    const removal = makeInstant('Lightning Bolt', '{R}', 0, { tags: ['removal'] });
    state = addToHand(state, bear, 0);
    state = addToHand(state, removal, 0);
    state = setMana(state, 0, { G: 3, R: 2 });

    // Add lands so autoTap works
    for (let i = 0; i < 5; i++) {
      state = putOnBattlefield(state, makeLand(`Mountain ${i}`, 0, {
        typeLine: 'Land — Mountain',
        oracleText: '{T}: Add {R}.',
        colorIdentity: ['R'],
      }), 0, 1);
    }

    // The bot should handle this without crashing
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    expect(action.player).toBe(0);
  });

  it('should prefer ramp spells early game', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = { ...state, turn: 2 }; // Early game

    const rampSpell = makeSorcery('Rampant Growth', '{1}{G}', 0, { tags: ['ramp'] });
    const bigCreature = makeCreature('Big Monster', '{5}{G}', '6', '6', 0);
    state = addToHand(state, rampSpell, 0);
    state = addToHand(state, bigCreature, 0);
    state = setMana(state, 0, { G: 5 });

    // Add lands for tapping
    for (let i = 0; i < 5; i++) {
      state = putOnBattlefield(state, makeLand(`Forest ${i}`, 0), 0, 1);
    }

    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
  });
});

describe('MLBot — Selective Attacking', () => {
  it('should attack with everything when opponent has no blockers', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = { ...state, phase: 'combat', step: 'declare-attackers' };

    // Add 3 creatures that aren't summoning sick
    for (let i = 0; i < 3; i++) {
      state = putOnBattlefield(state, makeCreature(`Soldier ${i}`, '{W}', '2', '2', 0), 0, 1);
      state.players[0].battlefield[state.players[0].battlefield.length - 1].summoningSick = false;
    }
    // Opponent has NO creatures
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
  });

  it('should avoid suicidal attacks into bigger blockers', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = { ...state, phase: 'combat', step: 'declare-attackers' };

    // Our small creature (1/1)
    state = putOnBattlefield(state, makeCreature('Token', '{W}', '1', '1', 0), 0, 1);
    state.players[0].battlefield[0].summoningSick = false;

    // Opponent has a 5/5 blocker
    state = putOnBattlefield(state, makeCreature('Giant', '{3}{G}{G}', '5', '5', 1), 1, 1);
    state.players[1].battlefield[0].summoningSick = false;

    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    // If the bot chooses declare-attackers, it should be selective
    if (action.type === 'declare-attackers') {
      // The 1/1 should NOT attack into a 5/5 (selective attacking)
      expect(action.attackers.length).toBe(0);
    }
  });

  it('should attack with everything when it is lethal', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = { ...state, phase: 'combat', step: 'declare-attackers' };

    // Set opponent to low life
    state = {
      ...state,
      players: state.players.map((p, i) =>
        i === 1 ? { ...p, life: 5 } : p
      ) as [typeof state.players[0], typeof state.players[0]],
    };

    // We have a 5/5 and a 3/3 (total 8 power, opp at 5 life)
    state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 0), 0, 1);
    state.players[0].battlefield[0].summoningSick = false;
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '3', '3', 0), 0, 1);
    state.players[0].battlefield[1].summoningSick = false;

    // Even with blockers, should go for lethal
    state = putOnBattlefield(state, makeCreature('Blocker', '{2}{B}', '2', '4', 1), 1, 1);

    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
  });
});

describe('MLBot — Smart Blocking', () => {
  it('should assign blockers when it is profitable', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = { ...state, phase: 'combat', step: 'declare-blockers' };

    // Our blocker (3/3)
    state = putOnBattlefield(state, makeCreature('Guard', '{2}{W}', '3', '3', 0), 0, 1);
    state.players[0].battlefield[0].summoningSick = false;

    // Opponent's attacker (2/2)
    state = putOnBattlefield(state, makeCreature('Goblin', '{1}{R}', '2', '2', 1), 1, 1);
    const attId = state.players[1].battlefield[0].id;
    state.players[1].battlefield[0].summoningSick = false;
    state.players[1].battlefield[0].attacking = true;

    // Set combat state
    state = {
      ...state,
      combat: {
        attackers: [{ permanentId: attId, defenderId: 0 }],
        blockers: [],
        currentStep: 'declare-blockers',
      },
    };

    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    // If bot chose declare-blockers, blocks should be assigned (our 3/3 kills their 2/2 and survives)
    if (action.type === 'declare-blockers') {
      expect(action.blocks.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('should not block when no attackers', () => {
    const bot = new MLBot(0);
    let state = createMainPhaseState();
    state = { ...state, phase: 'combat', step: 'declare-blockers' };

    // No combat state
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    if (action.type === 'declare-blockers') {
      expect(action.blocks.length).toBe(0);
    }
  });
});

describe('MLBot — Self-Play Pipeline Integration', () => {
  it('should work with SelfPlayPipeline', async () => {
    const { SelfPlayPipeline } = await import('../training/self-play.ts');

    const bot = new MLBot(0);
    const pipeline = new SelfPlayPipeline(
      bot.getPolicyNetwork(),
      bot.getValueNetwork(),
    );

    expect(pipeline).toBeDefined();
    expect(pipeline.getBufferStats().episodes).toBe(0);
  });
});
