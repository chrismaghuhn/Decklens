import type { Deck, DeckEntry } from '../shared/types.js';

export type RecommendationApplyMode = 'add' | 'swap';

export interface AppliedRecommendationMutation {
  addedCardName: string;
  removedCutName: string | null;
}

export interface RecommendationApplyAction {
  actionId: string;
  recommendationId: string;
  mode: RecommendationApplyMode;
  mutation: AppliedRecommendationMutation;
  deckBefore: Deck;
  deckBeforeSignature: string;
  deckAfterSignature: string;
  mainCountBefore: number;
  mainCountAfter: number;
  createdAt: number;
}

export interface ApplyRecommendationInput {
  deck: Deck;
  recommendationId: string;
  recommendationCardName: string;
  suggestedCutName: string | null;
  mode: RecommendationApplyMode;
  now?: () => number;
}

export type ApplyRecommendationErrorCode =
  | 'invalid_recommendation'
  | 'missing_cut_suggestion'
  | 'suggested_cut_not_found'
  | 'apply_invariant_failed';

export type ApplyRecommendationResult =
  | {
      ok: true;
      deck: Deck;
      mutation: AppliedRecommendationMutation;
      action: RecommendationApplyAction;
      deckSignatureBefore: string;
      deckSignatureAfter: string;
      mainCountBefore: number;
      mainCountAfter: number;
    }
  | {
      ok: false;
      code: ApplyRecommendationErrorCode;
      message: string;
    };

export type UndoRecommendationErrorCode = 'no_action' | 'deck_state_mismatch';

export type UndoRecommendationResult =
  | {
      ok: true;
      deck: Deck;
      action: RecommendationApplyAction;
    }
  | {
      ok: false;
      code: UndoRecommendationErrorCode;
      message: string;
    };

function normalizeCardName(name: string): string {
  return name.trim().toLowerCase();
}

function cloneDeckEntries(entries: DeckEntry[]): DeckEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function cloneDeckState(deck: Deck): Deck {
  return {
    main: cloneDeckEntries(deck.main),
    sideboard: cloneDeckEntries(deck.sideboard),
    commander: cloneDeckEntries(deck.commander),
  };
}

function findMainDeckEntryIndex(mainDeck: DeckEntry[], cardName: string): number {
  const target = normalizeCardName(cardName);
  return mainDeck.findIndex((entry) => normalizeCardName(entry.name) === target);
}

function addCardCopyToMainDeck(mainDeck: DeckEntry[], cardName: string): string {
  const resolvedName = cardName.trim();
  const idx = findMainDeckEntryIndex(mainDeck, resolvedName);
  if (idx >= 0) {
    mainDeck[idx].qty += 1;
    return mainDeck[idx].name;
  }
  mainDeck.push({ name: resolvedName, qty: 1 });
  return resolvedName;
}

function removeCardCopyFromMainDeck(mainDeck: DeckEntry[], cardName: string): string | null {
  const idx = findMainDeckEntryIndex(mainDeck, cardName);
  if (idx < 0) return null;

  const entry = mainDeck[idx];
  entry.qty -= 1;
  const entryName = entry.name;
  if (entry.qty <= 0) {
    mainDeck.splice(idx, 1);
  }
  return entryName;
}

function mainDeckCount(deck: Deck): number {
  return deck.main.reduce((sum, entry) => sum + entry.qty, 0);
}

function createActionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `rec_apply_${crypto.randomUUID()}`;
  }
  return `rec_apply_${Math.random().toString(36).slice(2, 12)}`;
}

export function deckStateSignature(deck: Deck): string {
  const rows: string[] = [];
  for (const entry of deck.main) {
    rows.push(`main:${entry.qty}:${normalizeCardName(entry.name)}`);
  }
  for (const entry of deck.sideboard) {
    rows.push(`sideboard:${entry.qty}:${normalizeCardName(entry.name)}`);
  }
  for (const entry of deck.commander) {
    rows.push(`commander:${entry.qty}:${normalizeCardName(entry.name)}`);
  }
  rows.sort();
  return rows.join('|');
}

export function applyRecommendationAtomically(input: ApplyRecommendationInput): ApplyRecommendationResult {
  const recommendationId = input.recommendationId.trim();
  const recommendationCardName = input.recommendationCardName.trim();
  if (!recommendationId || !recommendationCardName) {
    return {
      ok: false,
      code: 'invalid_recommendation',
      message: 'Recommendation payload is incomplete.',
    };
  }

  if (input.mode === 'swap') {
    const suggestedCut = input.suggestedCutName?.trim() || '';
    if (!suggestedCut) {
      return {
        ok: false,
        code: 'missing_cut_suggestion',
        message: 'Swap mode requires a suggested cut card.',
      };
    }

    const cutExists = findMainDeckEntryIndex(input.deck.main, suggestedCut) >= 0;
    if (!cutExists) {
      return {
        ok: false,
        code: 'suggested_cut_not_found',
        message: `Suggested cut card not found in main deck: ${suggestedCut}`,
      };
    }
  }

  const deckBefore = cloneDeckState(input.deck);
  const workingDeck = cloneDeckState(input.deck);
  const deckSignatureBefore = deckStateSignature(deckBefore);
  const mainCountBefore = mainDeckCount(deckBefore);

  const addedCardName = addCardCopyToMainDeck(workingDeck.main, recommendationCardName);
  const removedCutName = input.mode === 'swap'
    ? removeCardCopyFromMainDeck(workingDeck.main, input.suggestedCutName || '')
    : null;

  if (input.mode === 'swap' && removedCutName === null) {
    return {
      ok: false,
      code: 'apply_invariant_failed',
      message: 'Swap apply failed because the suggested cut could not be removed.',
    };
  }

  const deckSignatureAfter = deckStateSignature(workingDeck);
  const mainCountAfter = mainDeckCount(workingDeck);
  const now = input.now || (() => Date.now());

  const mutation: AppliedRecommendationMutation = {
    addedCardName,
    removedCutName,
  };

  const action: RecommendationApplyAction = {
    actionId: createActionId(),
    recommendationId,
    mode: input.mode,
    mutation,
    deckBefore,
    deckBeforeSignature: deckSignatureBefore,
    deckAfterSignature: deckSignatureAfter,
    mainCountBefore,
    mainCountAfter,
    createdAt: now(),
  };

  return {
    ok: true,
    deck: workingDeck,
    mutation,
    action,
    deckSignatureBefore,
    deckSignatureAfter,
    mainCountBefore,
    mainCountAfter,
  };
}

export function undoRecommendationApply(
  deck: Deck,
  action: RecommendationApplyAction | null,
): UndoRecommendationResult {
  if (!action) {
    return {
      ok: false,
      code: 'no_action',
      message: 'No apply action available to undo.',
    };
  }

  const currentSignature = deckStateSignature(deck);
  if (currentSignature !== action.deckAfterSignature) {
    return {
      ok: false,
      code: 'deck_state_mismatch',
      message: 'Deck state changed after apply; undo is no longer safe.',
    };
  }

  return {
    ok: true,
    deck: cloneDeckState(action.deckBefore),
    action,
  };
}
