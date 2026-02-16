/**
 * Archetype Detection Web Worker
 * Runs archetype detection in background thread
 */

import type { Deck } from '../shared/types.js';
import type { ArchetypeId } from '../mtg/engine/archetype-catalog.js';

// Worker message types
export interface DetectArchetypesMessage {
  type: 'detect-archetypes';
  payload: {
    deck: Deck;
    cardData: Record<string, {
      name: string;
      type_line?: string;
      oracle_text?: string;
      color_identity?: string[];
    }>;
  };
  id: string;
}

export interface ArchetypeDetectionResult {
  type: 'archetype-detection-result';
  payload: {
    primaryArchetype: ArchetypeId | null;
    secondaryArchetypes: Array<{ id: ArchetypeId; confidence: number }>;
    allScores: Array<{ id: ArchetypeId; score: number; confidence: number }>;
    detectedCards: Partial<Record<ArchetypeId, string[]>>;
    counterCards: string[];
    hybridArchetype: boolean;
  };
  id: string;
}

export interface ErrorResult {
  type: 'error';
  payload: {
    error: string;
  };
  id: string;
}

// Simplified archetype signatures for worker
const ARCHETYPE_SIGNATURES: Record<string, {
  id: ArchetypeId;
  keyCards: string[];
  signatureCards: string[];
  weightMultiplier: number;
}> = {
  reanimator: {
    id: 'reanimator',
    keyCards: ['reanimate', 'animate dead', 'entomb', 'buried alive'],
    signatureCards: ['grief', 'archon of cruelty', 'griselbrand', 'jin-gitaxias'],
    weightMultiplier: 2.0,
  },
  storm: {
    id: 'storm',
    keyCards: ['brain freeze', 'high tide', 'underworld breach'],
    signatureCards: ['lion\'s eye diamond', 'wheel of fortune', 'aetherflux reservoir'],
    weightMultiplier: 2.5,
  },
  'food-chain': {
    id: 'food-chain',
    keyCards: ['food chain', 'eternal scourge', 'misthollow griffin'],
    signatureCards: ['squee, the immortal', 'walking ballista', 'korvold'],
    weightMultiplier: 3.0,
  },
  stax: {
    id: 'stax',
    keyCards: ['winter orb', 'static orb', 'trinisphere'],
    signatureCards: ['sphere of resistance', 'thorn of amethyst', 'rule of law'],
    weightMultiplier: 1.8,
  },
  'artifact-combo': {
    id: 'artifact-combo',
    keyCards: ['grim monolith', 'basalt monolith', 'power artifact'],
    signatureCards: ['rings of brighthearth', 'sensei\'s divining top', 'mystic forge'],
    weightMultiplier: 2.0,
  },
  'tribal-elves': {
    id: 'tribal-elves',
    keyCards: ['priest of titania', 'elvish archdruid', 'craterhoof behemoth'],
    signatureCards: ['llanowar elves', 'fyndhorn elves', 'heritage druid'],
    weightMultiplier: 1.5,
  },
  lifegain: {
    id: 'lifegain',
    keyCards: ['soul warden', 'serra ascendant', 'felidar sovereign'],
    signatureCards: ['soul\'s attendant', 'ajani\'s pridemate', 'rhox faithmender'],
    weightMultiplier: 1.3,
  },
  tokens: {
    id: 'tokens',
    keyCards: ['anointed procession', 'parallel lives', 'craterhoof behemoth'],
    signatureCards: ['doubling season', 'divine visitation', 'cathars\' crusade'],
    weightMultiplier: 1.3,
  },
};

function normalizeCardName(name: string): string {
  return name.toLowerCase().trim();
}

function calculateArchetypeScore(
  deckCardNames: Set<string>,
  archetype: typeof ARCHETYPE_SIGNATURES[string]
): { score: number; confidence: number; detectedCards: string[] } {
  const detectedCards: string[] = [];
  let keyCardCount = 0;
  let signatureCardCount = 0;

  // Check for key cards
  for (const cardName of archetype.keyCards) {
    if (deckCardNames.has(normalizeCardName(cardName))) {
      keyCardCount++;
      detectedCards.push(cardName);
    }
  }

  // Check for signature cards
  for (const cardName of archetype.signatureCards) {
    if (deckCardNames.has(normalizeCardName(cardName))) {
      signatureCardCount++;
      if (!detectedCards.includes(cardName)) {
        detectedCards.push(cardName);
      }
    }
  }

  // Calculate score
  const keyScore = keyCardCount * 3;
  const signatureScore = signatureCardCount * 2;
  const rawScore = (keyScore + signatureScore) * archetype.weightMultiplier;

  // Calculate confidence
  let confidence = 0;
  if (keyCardCount >= 2 && signatureCardCount >= 2) {
    confidence = Math.min(1, rawScore / 20);
  } else if (keyCardCount >= 2 || signatureCardCount >= 2) {
    confidence = Math.min(0.7, rawScore / 20);
  } else {
    confidence = Math.min(0.4, rawScore / 30);
  }

  return { score: rawScore, confidence, detectedCards };
}

function detectArchetypes(
  deck: Deck,
  cardData: Record<string, { name: string; type_line?: string; oracle_text?: string; color_identity?: string[] }>
): ArchetypeDetectionResult['payload'] {
  const deckCardNames = new Set([
    ...deck.main.map(e => normalizeCardName(e.name)),
    ...deck.sideboard.map(e => normalizeCardName(e.name)),
    ...deck.commander.map(e => normalizeCardName(e.name)),
  ]);

  const scores: Array<{ id: ArchetypeId; score: number; confidence: number; detectedCards: string[] }> = [];

  // Calculate score for each archetype
  for (const archetype of Object.values(ARCHETYPE_SIGNATURES)) {
    const result = calculateArchetypeScore(deckCardNames, archetype);
    scores.push({
      id: archetype.id,
      score: result.score,
      confidence: result.confidence,
      detectedCards: result.detectedCards,
    });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  // Determine primary archetype
  const primaryArchetype = scores[0]?.confidence >= 0.4 ? scores[0].id : null;

  // Determine secondary archetypes
  const secondaryArchetypes: Array<{ id: ArchetypeId; confidence: number }> = [];
  for (let i = 1; i < scores.length && secondaryArchetypes.length < 2; i++) {
    if (scores[i].confidence >= 0.25) {
      secondaryArchetypes.push({
        id: scores[i].id,
        confidence: scores[i].confidence,
      });
    }
  }

  // Build detected cards map
  const detectedCards: Partial<Record<ArchetypeId, string[]>> = {};
  for (const score of scores) {
    if (score.detectedCards.length > 0) {
      detectedCards[score.id] = score.detectedCards;
    }
  }

  // Get counter cards for detected archetypes
  const counterCards: string[] = [];
  if (primaryArchetype) {
    // Add counter cards logic here
    if (primaryArchetype === 'reanimator') {
      counterCards.push('Rest in Peace', 'Grafdigger\'s Cage', 'Leyline of the Void');
    } else if (primaryArchetype === 'storm') {
      counterCards.push('Rule of Law', 'Ethersworn Canonist', 'Trinisphere');
    }
  }

  // Check if hybrid (multiple archetypes with similar scores)
  const hybridArchetype = secondaryArchetypes.length > 0 &&
    scores[0].confidence - (scores[1]?.confidence || 0) < 0.2;

  return {
    primaryArchetype,
    secondaryArchetypes,
    allScores: scores.map(s => ({ id: s.id, score: s.score, confidence: s.confidence })),
    detectedCards,
    counterCards,
    hybridArchetype,
  };
}

// Worker message handler
self.onmessage = function(event: MessageEvent<DetectArchetypesMessage>) {
  const { type, payload, id } = event.data;

  if (type === 'detect-archetypes') {
    try {
      const result = detectArchetypes(payload.deck, payload.cardData);
      
      const response: ArchetypeDetectionResult = {
        type: 'archetype-detection-result',
        payload: result,
        id,
      };
      
      self.postMessage(response);
    } catch (error) {
      const errorResponse: ErrorResult = {
        type: 'error',
        payload: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        id,
      };
      self.postMessage(errorResponse);
    }
  }
};

export {};
