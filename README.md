# MTG Deckbuilder & Collection Manager

## Features

- **Smart Scanner:** Scan physical cards using OCR (Tesseract.js) or search manually.
- **Collection Management:** Track your cards, quantity, and foil status.
- **Unified Search:** Search for any Magic card using Scryfall data.
- **Mobile-First:** PWA-ready design with bottom navigation and camera integration.

## Tech Stack

- **Frontend:** Next.js 14, Tailwind CSS, shadcn/ui, TanStack Query.
- **Backend:** NestJS, Drizzle ORM, PostgreSQL, Redis.
- **Infrastructure:** Docker Compose.

## Getting Started

### 1. Prerequisites

- Docker & Docker Compose
- Node.js 20+
- pnpm

### 2. Setup

```bash
# Install dependencies
pnpm install

# Start Infrastructure (DB & Redis)
docker-compose up -d

# Generate Database Schema & Migrations
pnpm db:generate
pnpm db:migrate

# Seed Initial Data (Test User)
# (Automatically runs on API startup if user missing)
```

### 3. Running the App

```bash
# Start both Frontend and Backend
pnpm dev
```

- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:3001

### 4. Initial Data Sync

To populate the card database, trigger the sync endpoint:

```bash
curl -X POST http://localhost:3001/scryfall/sync
```

_Note: This downloads ~400MB of data and may take a few minutes._

## Project Structure

- `apps/web`: Next.js Frontend
- `apps/api`: NestJS Backend
- `packages/db`: Drizzle ORM Schema & Config

## 🤖 MTG Bot & Deckbuilder (New!)

### Features

- **Heuristic Bot:** Rule-based AI for testing.
- **ML Bot (PPO):** Reinforcement Learning agent (v4) with 384 feature dimensions.
- **Deckbuilder Engine:** Automated deck construction using synergy and curve analysis.
- **Draft Simulator:** Simulate booster drafts with AI opponents.

### 🧠 Training the Bot

**Phase 1: Imitation Learning (vs Heuristic Bot)**

```bash
npx tsx scripts/train-bot-cli.ts --version v4 --games 1000 --mode vs-simple
```

**Phase 2: Self-Play (Reinforcement Learning)**

```bash
npx tsx scripts/train-bot-cli.ts --version v4 --games 5000 --mode self-play
```

### 🃏 Running the Draft Simulator

```bash
npx tsx packages/bot-ml/src/scripts/simulate-draft.ts
```
