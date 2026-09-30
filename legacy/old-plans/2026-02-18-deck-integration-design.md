# Phase 7: Deck Integration — Design Document

**Date**: 2026-02-18
**Goal**: Connect deckbuilder storage to game engine with real Scryfall card data + localStorage cache
**Impact**: Cards get correct oracleText, manaCost, colors, P/T, imageUrl → effects resolve, bot evaluates, images show

---

## Architecture

### Data Flow

```
[Deckbuilder localStorage] → card names + qty
        ↓
[localStorage Card Cache] → check cache first (key: card name → CardData)
        ↓ (cache miss)
[Scryfall Collection API] → POST /cards/collection (75/request)
        ↓
[scryfallToCard() transformer] → Scryfall JSON → Engine Card
        ↓
[Cache write] → store resolved cards in localStorage
        ↓
[Game Engine] → complete Card objects with all fields populated
```

### Components

#### 1. Card Resolver (`src/play-vs-bot/card-resolver.ts`, NEW)

```typescript
// Cache key in localStorage
const CARD_CACHE_KEY = 'decklens_card_cache_v1';

// Resolve card names to full Card objects
export async function resolveCardNames(
  names: string[],
  owner: 0 | 1
): Promise<Card[]>

// Transform Scryfall JSON → Engine Card
export function scryfallToCard(
  scryfallData: ScryfallCard,
  owner: 0 | 1
): Card

// Validate EDH deck (100 cards, singleton, color identity)
export function validateEDHDeck(
  cards: Card[],
  commander: Card
): { valid: boolean; warnings: string[] }

// Cache management
export function getCachedCard(name: string): Card | null
export function cacheCards(cards: Card[]): void
export function clearCardCache(): void
```

**Cache Strategy**:
- Key: `decklens_card_cache_v1`
- Format: `Record<string, { card: ScryfallCardData, cachedAt: number }>`
- TTL: 7 days (Scryfall data rarely changes)
- Max size: ~2000 cards (~2MB in localStorage)
- LRU eviction when full

**Scryfall API**:
- Endpoint: `POST https://api.scryfall.com/cards/collection`
- Body: `{ identifiers: [{ name: "Sol Ring" }, { name: "Command Tower" }, ...] }`
- Max 75 identifiers per request
- Rate limit: 100ms delay between requests (Scryfall policy)
- Handles `not_found` gracefully → falls back to createSimpleCard()

#### 2. Updated main.ts

- `deckbuilderToCards()` becomes async
- Calls `resolveCardNames()` instead of heuristic guessing
- Shows loading progress UI during fetch
- Fallback: if API fails entirely, use existing heuristic as backup

#### 3. Loading UI

- Progress bar during card resolution
- "Resolving card data... (45/100)" counter
- Arcane Forge styled (gold gradient, cinzel font)
- Error handling: "3 cards not found, using defaults"

#### 4. EDH Validation (non-blocking warnings)

- 100 cards (99 + commander)
- Singleton rule (except basic lands)
- All cards within commander's color identity
- Commander must be Legendary Creature or have "can be your commander"

---

## Files

| File | Action | Description |
|------|--------|-------------|
| `src/play-vs-bot/card-resolver.ts` | NEW | Scryfall resolver + cache + validator |
| `src/play-vs-bot/main.ts` | MODIFY | Async deckbuilderToCards, loading UI |
| `play-vs-bot.html` | MODIFY | Loading overlay styles |

## Not Changed
- Deckbuilder storage format (still name + qty)
- Game engine Card type (already complete)
- Bot logic (automatically benefits from better data)
- Deck selector UI (stays the same)
