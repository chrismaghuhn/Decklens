# MTG Deckbuilder Frontend

This is the Next.js frontend for the deckbuilder application.

## Key Features

- **Deck Editor:** `/deck/[id]` - Edit decks, analyze power levels, view mana curves.
- **Collection Manager:** `/collection` - View your owned cards.
- **Scanner:** `/scanner` - Scan physical cards using OCR.
- **Search:** Home page global search.

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS + shadcn/ui
- **State/Fetching:** TanStack Query (React Query)
- **Logic:** Custom deck analysis logic in `src/lib/deck-logic` (ported from legacy code).

## Development

```bash
pnpm dev
```

## Folder Structure

- `src/app`: Routes and pages.
- `src/components`: UI components (shared and feature-specific).
- `src/lib/deck-logic`: Core business logic (Power Level, Analyzers).
- `src/hooks`: React Query hooks for data fetching.
