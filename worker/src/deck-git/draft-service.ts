// ============================================================
// Draft Service — Collaborative Draft/Sealed sessions
// ============================================================
// Manages draft and sealed deck-building sessions.
// In production, uses Durable Objects for real-time state;
// here we use D1 for persistence with API-based picking.
// ============================================================

import type { DraftSession } from './types.js';
import { generateId, now } from './types.js';

// ==================== Types ====================

export interface DraftSettings {
  packSize: number;          // cards per pack (default 15)
  packCount: number;         // packs per player (default 3)
  pickTimeSeconds: number;   // seconds per pick (default 60)
  playerCount: number;       // max players (default 8)
  setFilter?: string;        // filter packs to specific set
}

export interface SealedSettings {
  poolSize: number;          // total cards in sealed pool (default 90)
  packCount: number;         // number of packs (default 6)
  deckMinSize: number;       // minimum deck size (default 40)
}

export interface DraftPack {
  cards: DraftCard[];
  round: number;
  pickNumber: number;
}

export interface DraftCard {
  name: string;
  set: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'mythic';
  imageUrl?: string;
}

export interface DraftParticipant {
  userId: string;
  seatNumber: number;
  pool: DraftCard[];         // picked cards
  currentPack: DraftPack | null;
  deckBuilt: boolean;
}

export interface DraftState {
  session: DraftSession;
  participants: DraftParticipant[];
  currentRound: number;
  currentPick: number;
  direction: 'left' | 'right';  // alternates each round
  packs: DraftPack[][];     // packs[round][seat]
}

// ==================== Service ====================

export class DraftServiceImpl {
  constructor(private db: D1Database) {}

  /**
   * Create a new draft or sealed session.
   */
  async createSession(
    hostId: string,
    format: 'draft' | 'sealed',
    settings: DraftSettings | SealedSettings
  ): Promise<DraftSession> {
    const id = generateId();
    const session: DraftSession = {
      id,
      format,
      hostId,
      status: 'waiting',
      settingsJson: settings,
      createdAt: now(),
    };

    await this.db.prepare(
      'INSERT INTO draft_sessions (id, format, host_id, status, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, format, hostId, 'waiting', JSON.stringify(settings), session.createdAt).run();

    // Host auto-joins as seat 0
    await this.db.prepare(
      'INSERT INTO draft_participants (session_id, user_id, seat_number, pool_json) VALUES (?, ?, 0, ?)'
    ).bind(id, hostId, '[]').run();

    return session;
  }

  /**
   * Join an existing session.
   */
  async joinSession(sessionId: string, userId: string): Promise<{ seatNumber: number }> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'waiting') throw new Error('Session already started');

    // Get current participant count
    const count = await this.db.prepare(
      'SELECT COUNT(*) as count FROM draft_participants WHERE session_id = ?'
    ).bind(sessionId).first<{ count: number }>();

    const settings = session.settingsJson as DraftSettings | SealedSettings;
    const maxPlayers = (settings as DraftSettings).playerCount || 8;

    if ((count?.count || 0) >= maxPlayers) {
      throw new Error('Session is full');
    }

    // Check if already joined
    const existing = await this.db.prepare(
      'SELECT seat_number FROM draft_participants WHERE session_id = ? AND user_id = ?'
    ).bind(sessionId, userId).first<{ seat_number: number }>();

    if (existing) {
      return { seatNumber: existing.seat_number };
    }

    const seatNumber = count?.count || 0;
    await this.db.prepare(
      'INSERT INTO draft_participants (session_id, user_id, seat_number, pool_json) VALUES (?, ?, ?, ?)'
    ).bind(sessionId, userId, seatNumber, '[]').run();

    return { seatNumber };
  }

  /**
   * Start the draft/sealed session (host only).
   */
  async startSession(sessionId: string, hostId: string): Promise<DraftState> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.hostId !== hostId) throw new Error('Only host can start');
    if (session.status !== 'waiting') throw new Error('Session already started');

    await this.db.prepare(
      'UPDATE draft_sessions SET status = ? WHERE id = ?'
    ).bind('active', sessionId).run();

    const participants = await this.getParticipants(sessionId);

    if (session.format === 'sealed') {
      return this.initSealed(session, participants);
    } else {
      return this.initDraft(session, participants);
    }
  }

  /**
   * Make a draft pick.
   */
  async makePick(
    sessionId: string,
    userId: string,
    cardName: string
  ): Promise<{ nextPack: DraftPack | null }> {
    const participant = await this.db.prepare(
      'SELECT seat_number, pool_json FROM draft_participants WHERE session_id = ? AND user_id = ?'
    ).bind(sessionId, userId).first<{ seat_number: number; pool_json: string }>();

    if (!participant) throw new Error('Not in this session');

    const pool: DraftCard[] = JSON.parse(participant.pool_json);

    // For now, add card to pool (in a real implementation, we'd track packs)
    pool.push({
      name: cardName,
      set: 'unknown',
      rarity: 'common',
    });

    await this.db.prepare(
      'UPDATE draft_participants SET pool_json = ? WHERE session_id = ? AND user_id = ?'
    ).bind(JSON.stringify(pool), sessionId, userId).run();

    return { nextPack: null }; // Would contain next pack in real implementation
  }

  /**
   * Get a player's current pool.
   */
  async getPool(sessionId: string, userId: string): Promise<DraftCard[]> {
    const participant = await this.db.prepare(
      'SELECT pool_json FROM draft_participants WHERE session_id = ? AND user_id = ?'
    ).bind(sessionId, userId).first<{ pool_json: string }>();

    if (!participant) throw new Error('Not in this session');
    return JSON.parse(participant.pool_json);
  }

  /**
   * Build deck from pool and save to a new repo.
   */
  async buildDeck(
    sessionId: string,
    userId: string,
    deckState: { mainboard: string[]; sideboard: string[] }
  ): Promise<{ repoId: string }> {
    const pool = await this.getPool(sessionId, userId);
    const poolNames = new Set(pool.map(c => c.name));

    // Validate all mainboard/sideboard cards are in pool
    for (const card of [...deckState.mainboard, ...deckState.sideboard]) {
      if (!poolNames.has(card)) {
        throw new Error(`Card "${card}" is not in your pool`);
      }
    }

    // Create a new repo for the deck
    const repoId = generateId();
    const session = await this.getSession(sessionId);
    const deckName = `${session?.format === 'draft' ? 'Draft' : 'Sealed'} Deck — ${new Date().toLocaleDateString()}`;

    await this.db.prepare(
      `INSERT INTO deck_repos (id, name, description, owner_id, visibility, format, default_branch, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      repoId, deckName,
      `Built from ${session?.format} session ${sessionId}`,
      userId, 'private', 'commander', 'main', '{}', now(), now()
    ).run();

    // Mark participant as having built deck
    await this.db.prepare(
      'UPDATE draft_participants SET pool_json = ? WHERE session_id = ? AND user_id = ?'
    ).bind(JSON.stringify(pool), sessionId, userId).run();

    return { repoId };
  }

  /**
   * Complete session (host).
   */
  async completeSession(sessionId: string, hostId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.hostId !== hostId) throw new Error('Only host can complete');

    await this.db.prepare(
      'UPDATE draft_sessions SET status = ?, completed_at = ? WHERE id = ?'
    ).bind('completed', now(), sessionId).run();
  }

  // ==================== Private Helpers ====================

  private async getSession(sessionId: string): Promise<DraftSession | null> {
    const row = await this.db.prepare(
      'SELECT id, format, host_id, status, settings_json, created_at, completed_at FROM draft_sessions WHERE id = ?'
    ).bind(sessionId).first();

    if (!row) return null;

    return {
      id: row.id as string,
      format: row.format as 'draft' | 'sealed',
      hostId: row.host_id as string,
      status: row.status as 'waiting' | 'active' | 'completed',
      settingsJson: JSON.parse((row.settings_json as string) || '{}'),
      createdAt: row.created_at as string,
    };
  }

  private async getParticipants(sessionId: string): Promise<DraftParticipant[]> {
    const rows = await this.db.prepare(
      'SELECT user_id, seat_number, pool_json FROM draft_participants WHERE session_id = ? ORDER BY seat_number'
    ).bind(sessionId).all();

    return (rows.results || []).map(r => ({
      userId: r.user_id as string,
      seatNumber: r.seat_number as number,
      pool: JSON.parse((r.pool_json as string) || '[]'),
      currentPack: null,
      deckBuilt: false,
    }));
  }

  private async initDraft(session: DraftSession, participants: DraftParticipant[]): Promise<DraftState> {
    const settings = session.settingsJson as DraftSettings;
    const packs: DraftPack[][] = [];

    // Generate packs for each round
    for (let round = 0; round < (settings.packCount || 3); round++) {
      const roundPacks: DraftPack[] = [];
      for (let seat = 0; seat < participants.length; seat++) {
        roundPacks.push({
          cards: generatePackCards(settings.packSize || 15),
          round,
          pickNumber: 0,
        });
      }
      packs.push(roundPacks);
    }

    return {
      session: { ...session, status: 'active' },
      participants,
      currentRound: 0,
      currentPick: 0,
      direction: 'left',
      packs,
    };
  }

  private async initSealed(session: DraftSession, participants: DraftParticipant[]): Promise<DraftState> {
    const settings = session.settingsJson as SealedSettings;
    const poolSize = settings.poolSize || 90;

    // Give each player their sealed pool
    for (const p of participants) {
      p.pool = generatePackCards(poolSize);
      await this.db.prepare(
        'UPDATE draft_participants SET pool_json = ? WHERE session_id = ? AND user_id = ?'
      ).bind(JSON.stringify(p.pool), session.id, p.userId).run();
    }

    return {
      session: { ...session, status: 'active' },
      participants,
      currentRound: 0,
      currentPick: 0,
      direction: 'left',
      packs: [],
    };
  }
}

// ==================== Pack Generation ====================

/**
 * Generate simulated pack cards.
 * In production, this would use real card data from a cube or set.
 */
function generatePackCards(count: number): DraftCard[] {
  const cards: DraftCard[] = [];
  const rarityDist = [
    { rarity: 'common' as const, weight: 10 },
    { rarity: 'uncommon' as const, weight: 3 },
    { rarity: 'rare' as const, weight: 1.1 },
    { rarity: 'mythic' as const, weight: 0.125 },
  ];

  for (let i = 0; i < count; i++) {
    const roll = Math.random() * 14.225;
    let rarity: DraftCard['rarity'] = 'common';
    let cumulative = 0;
    for (const r of rarityDist) {
      cumulative += r.weight;
      if (roll < cumulative) {
        rarity = r.rarity;
        break;
      }
    }

    cards.push({
      name: `Draft Card ${i + 1}`,
      set: 'DRF',
      rarity,
    });
  }

  return cards;
}
