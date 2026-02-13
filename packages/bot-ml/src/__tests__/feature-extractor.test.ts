import { describe, it, expect, beforeEach } from 'vitest';
import { extractFeatures, extractFeaturesV2, FEATURE_DIM, FEATURE_DIM_V2 } from '../networks/feature-extractor.ts';
import { resetIds, createMainPhaseState, putOnBattlefield, makeCreature, addToHand, makeLand, setMana } from './test-helpers.ts';

beforeEach(() => resetIds());

describe('extractFeatures', () => {
  it('should return a Float32Array of size FEATURE_DIM', () => {
    const state = createMainPhaseState();
    const features = extractFeatures(state, 0);
    expect(features).toBeInstanceOf(Float32Array);
    expect(features.length).toBe(FEATURE_DIM);
  });

  it('should return 200-dimensional vector', () => {
    expect(FEATURE_DIM).toBe(200);
  });

  it('should have values in [0, 1] range for normalized features', () => {
    const state = createMainPhaseState();
    const features = extractFeatures(state, 0);
    // Most features should be in [0,1] (some advantage signals can be slightly outside)
    let outOfRange = 0;
    for (let i = 0; i < features.length; i++) {
      if (features[i] < -1.5 || features[i] > 1.5) outOfRange++;
    }
    expect(outOfRange).toBe(0);
  });

  it('should encode life total correctly', () => {
    const state = createMainPhaseState();
    const features = extractFeatures(state, 0);
    // Feature 0 = life normalized to 40: 40/40 = 1.0
    expect(features[0]).toBe(1.0);
  });

  it('should encode different features for different players', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);

    const features0 = extractFeatures(state, 0);
    const features1 = extractFeatures(state, 1);

    // Should not be identical (different perspectives)
    let identical = true;
    for (let i = 0; i < FEATURE_DIM; i++) {
      if (features0[i] !== features1[i]) { identical = false; break; }
    }
    expect(identical).toBe(false);
  });

  it('should reflect creatures on battlefield', () => {
    let state = createMainPhaseState();
    const featuresBefore = extractFeatures(state, 0);

    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);
    const featuresAfter = extractFeatures(state, 0);

    // Battlefield permanent count feature should change (index 6)
    expect(featuresAfter[6]).toBeGreaterThan(featuresBefore[6]);
  });

  it('should reflect mana pool', () => {
    let state = createMainPhaseState();
    state = setMana(state, 0, { G: 5 });
    const features = extractFeatures(state, 0);
    // Feature 1 = total mana normalized to 20: 5/20 = 0.25
    expect(features[1]).toBeCloseTo(0.25, 2);
  });

  it('should reflect hand size', () => {
    let state = createMainPhaseState();
    // Add cards to hand
    for (let i = 0; i < 5; i++) {
      state = addToHand(state, makeLand(`Extra Land ${i}`, 0), 0);
    }
    const features = extractFeatures(state, 0);
    // Feature 2 = hand size / 15
    expect(features[2]).toBeGreaterThan(0);
  });
});

// ============================================================
// v2 Feature Extractor Tests (256 dims)
// ============================================================

describe('extractFeaturesV2', () => {
  it('should return 256-dimensional vector', () => {
    expect(FEATURE_DIM_V2).toBe(256);
    const state = createMainPhaseState();
    const features = extractFeaturesV2(state, 0);
    expect(features).toBeInstanceOf(Float32Array);
    expect(features.length).toBe(256);
  });

  it('should have first 200 features identical to v1', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);
    state = addToHand(state, makeLand('Forest', 0), 0);

    const v1 = extractFeatures(state, 0);
    const v2 = extractFeaturesV2(state, 0);

    for (let i = 0; i < 200; i++) {
      expect(v2[i]).toBeCloseTo(v1[i], 5);
    }
  });

  it('should have all values in [-1.5, 1.5] range', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 0), 0, 1);
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 1), 1, 1);

    const features = extractFeaturesV2(state, 0);
    for (let i = 0; i < features.length; i++) {
      expect(features[i]).toBeGreaterThanOrEqual(-1.5);
      expect(features[i]).toBeLessThanOrEqual(1.5);
    }
  });

  it('should have graveyard features at 0 when graveyard is empty', () => {
    const state = createMainPhaseState();
    const features = extractFeaturesV2(state, 0);

    // Graveyard features are [200-209]
    for (let i = 200; i < 210; i++) {
      expect(features[i]).toBe(0);
    }
  });

  it('should have combat threat features at 0 when no creatures', () => {
    const state = createMainPhaseState();
    const features = extractFeaturesV2(state, 0);

    // Attackable power [210], opp attackable power [211] should be 0
    expect(features[210]).toBe(0);
    expect(features[211]).toBe(0);
  });

  it('should detect attackable creatures', () => {
    let state = createMainPhaseState();
    // Add creature that's NOT summoning sick (turn 1 means it entered turn 1)
    const creature = makeCreature('Soldier', '{W}', '2', '2', 0);
    state = putOnBattlefield(state, creature, 0, 1);
    // Make it not summoning sick
    state.players[0].battlefield[0].summoningSick = false;

    const features = extractFeaturesV2(state, 0);
    // Attackable power [210] should be > 0
    expect(features[210]).toBeGreaterThan(0);
  });

  it('should encode board quality metrics', () => {
    let state = createMainPhaseState();
    // Add a big creature
    state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 0), 0, 1);

    const features = extractFeaturesV2(state, 0);
    // Average creature quality [240] should be > 0 (power*toughness = 25, /1 creature = 25)
    expect(features[240]).toBeGreaterThan(0);
  });

  it('should have reserved padding as zeros [250-255]', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);

    const features = extractFeaturesV2(state, 0);
    for (let i = 250; i < 256; i++) {
      expect(features[i]).toBe(0);
    }
  });

  it('should work for both players with different perspectives', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('My Bear', '{1}{G}', '3', '3', 0), 0, 1);
    state = putOnBattlefield(state, makeCreature('Opp Bear', '{1}{G}', '2', '2', 1), 1, 1);

    const f0 = extractFeaturesV2(state, 0);
    const f1 = extractFeaturesV2(state, 1);

    // The attackable powers should swap perspectives
    // Player 0 sees their creature as theirs, Player 1 sees it as opponent's
    let different = false;
    for (let i = 200; i < 256; i++) {
      if (f0[i] !== f1[i]) { different = true; break; }
    }
    expect(different).toBe(true);
  });
});
