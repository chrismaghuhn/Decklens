// ============================================================
// HealthService — Deck health analysis
// ============================================================
// Analyzes deck states for health metrics like curve, mana base,
// card types, combos, etc.
// ============================================================

import {
  type DeckState,
  type DeckHealthMetrics,
  type DeckHealthSnapshot,
  generateId,
  now,
} from './types.js';

const CARD_TYPE_KEYWORDS: Record<string, string[]> = {
  creature: ['creature', 'tribal'],
  instant: ['instant'],
  sorcery: ['sorcery'],
  artifact: ['artifact', 'equipment', 'artifact creature'],
  enchantment: ['enchantment', 'enchantment creature'],
  planeswalker: ['planeswalker'],
};

const RAMP_KEYWORDS = [
  'ramp', 'mana crypt', 'sol ring', 'mana vault', 'chromatic lantern',
  'cultivate', 'kodama\'s reach', 'farseek', 'farseek', 'ruthless theft',
  'birds of paradise', 'llanowar elves', 'elvish mystic', 'fyndhorn elves',
  'dark ritual', 'ritual', 'cabal ritual', 'grief', 'defile', 'troll',
  'signet', 'clamp', 'prismatic omen', 'azusa', ' Exploration', 'strip mine',
  'temple of the false god', 'khalni heart expedition', '的考生',
];

const CARD_DRAW_KEYWORDS = [
  'draw', 'card advantage', 'scroll', 'preordain', 'brainstorm', 'ponder',
  'portent', 'anticipate', 'opt', 'growth spiral', 'expressive iteration',
  'chart a course', 'teferi\'s ageless insight', 'rhystic study', 'mystic remora',
  'phyrexian arena', 'underground sea', 'ancestral', 'timetwister', 'wheel',
  'g面前', 'necropotence', 'ad nauseam', 'principia', 'sylvan library',
  'blue sun\'s zenith', 'stroke of genius', 'mindbreak trap', 'enter the infinite',
];

const REMOVAL_KEYWORDS = [
  'destroy', 'exile', 'remove', 'kill', 'terminate', 'doom blade', 'path to exile',
  'swords to plowshares', 'lightning bolt', 'lightning helix', 'hero\'s downfall',
  'terminate', 'mausoleum wanderer', 'dreadbore', 'blasting station', 'genav',
  'gotten', 'gotten', 'wrath of god', 'day of judgment', ' Decree of Pain',
  'austere command', 'farewell', 'cosmic', 'final', 'farewell',
];

const WIN_CONDITION_KEYWORDS = [
  'win', 'damage', 'combat', 'damage', 'damage', 'infinite', 'enters the battlefield',
  'life gain', 'life drain', 'poison', 'infect', 'poison', 'mill', 'fateseal',
  'exile', 'triggered', 'laboratory', ' Jace, wielder of mysteries', 'archivist',
  'niv-mizzet', 'curiosity', 'olf', 'curiosity', 'niv-mizzet', 'parun',
  'approaches', 'exsanguinate', 'torment of hailstone', 'aetherflux',
];

export class HealthService {
  constructor(private db: D1Database) {}

  /**
   * Analyze a deck state and return health metrics.
   */
  analyze(state: DeckState): DeckHealthMetrics {
    const allCards = [
      ...state.boards.commander,
      ...state.boards.mainboard,
      ...state.boards.sideboard,
      ...state.boards.maybeboard,
    ];

    const totalCards = allCards.reduce((sum, c) => sum + c.qty, 0);

    // Calculate average CMC
    const cmcValues: number[] = [];
    for (const card of allCards) {
      if (card.tags.includes('land')) continue;
      const cmc = this.estimateCMC(card.name);
      for (let i = 0; i < card.qty; i++) {
        cmcValues.push(cmc);
      }
    }
    const avgCmc = cmcValues.length > 0
      ? cmcValues.reduce((a, b) => a + b, 0) / cmcValues.length
      : 0;

    // Calculate curve
    const curve: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    for (const card of allCards) {
      if (card.tags.includes('land')) continue;
      const cmc = Math.min(this.estimateCMC(card.name), 7);
      curve[cmc] = (curve[cmc] || 0) + card.qty;
    }

    // Calculate card types
    const cardTypes: DeckHealthMetrics['cardTypes'] = {
      creature: 0,
      instant: 0,
      sorcery: 0,
      artifact: 0,
      enchantment: 0,
      planeswalker: 0,
    };
    for (const card of allCards) {
      const types = this.detectCardTypes(card.name);
      for (const t of types) {
        if (t in cardTypes) {
          cardTypes[t as keyof typeof cardTypes]! += card.qty;
        }
      }
    }

    // Calculate mana base
    const lands = allCards.filter(c => c.tags.includes('land') || this.isLand(c.name));
    const colors = this.detectColors(allCards);
    let colorless = 0;
    for (const land of lands) {
      if (!this.producesColor(land.name, colors)) {
        colorless += land.qty;
      }
    }
    const avgLandCmc = lands.length > 0
      ? lands.reduce((sum, l) => sum + this.estimateCMC(l.name), 0) / lands.length
      : 0;

    // Count ramp, draw, removal, win conditions
    const rampCount = this.countByKeywords(allCards, RAMP_KEYWORDS);
    const cardDrawCount = this.countByKeywords(allCards, CARD_DRAW_KEYWORDS);
    const removalCount = this.countByKeywords(allCards, REMOVAL_KEYWORDS);
    const winConditionCount = this.countByKeywords(allCards, WIN_CONDITION_KEYWORDS);

    // Estimate combo count (simplified)
    const comboCount = this.estimateComboCount(allCards);

    return {
      totalCards,
      avgCmc: Math.round(avgCmc * 10) / 10,
      curve,
      manaBase: {
        colors,
        colorless,
        landCount: lands.length,
        avgLandCmc: Math.round(avgLandCmc * 10) / 10,
      },
      cardTypes,
      comboCount,
      winConditionCount,
      removalCount,
      cardDrawCount,
      rampCount,
    };
  }

  /**
   * Save a health snapshot.
   */
  async saveSnapshot(
    repoId: string,
    branchId: string,
    commitId: string,
    state: DeckState
  ): Promise<DeckHealthSnapshot> {
    const health = this.analyze(state);
    const id = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO deck_health_snapshots
        (id, repo_id, branch_id, commit_id, health_json, curve_json, mana_base_json, combo_count, avg_cmc, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        repoId,
        branchId,
        commitId,
        JSON.stringify(health),
        JSON.stringify(health.curve),
        JSON.stringify(health.manaBase),
        health.comboCount,
        health.avgCmc,
        createdAt
      )
      .run();

    return {
      id,
      repoId,
      branchId,
      commitId,
      health,
      curve: health.curve,
      manaBase: health.manaBase,
      comboCount: health.comboCount,
      avgCmc: health.avgCmc,
      createdAt,
    };
  }

  /**
   * Get latest health snapshot for a branch.
   */
  async getLatestSnapshot(branchId: string): Promise<DeckHealthSnapshot | null> {
    const row = await this.db
      .prepare(`
        SELECT * FROM deck_health_snapshots 
        WHERE branch_id = ? 
        ORDER BY created_at DESC 
        LIMIT 1
      `)
      .bind(branchId)
      .first<{
        id: string;
        repo_id: string;
        branch_id: string;
        commit_id: string;
        health_json: string;
        curve_json: string;
        mana_base_json: string;
        combo_count: number;
        avg_cmc: number;
        created_at: string;
      }>();

    if (!row) return null;

    const health = JSON.parse(row.health_json);

    return {
      id: row.id,
      repoId: row.repo_id,
      branchId: row.branch_id,
      commitId: row.commit_id,
      health,
      curve: JSON.parse(row.curve_json),
      manaBase: JSON.parse(row.mana_base_json),
      comboCount: row.combo_count,
      avgCmc: row.avg_cmc,
      createdAt: row.created_at,
    };
  }

  /**
   * Compare health between two snapshots.
   */
  async compareSnapshots(snapshotAId: string, snapshotBId: string): Promise<{
    changes: Record<string, { before: number; after: number; diff: number }>;
  }> {
    const snapshotA = await this.db
      .prepare('SELECT health_json FROM deck_health_snapshots WHERE id = ?')
      .bind(snapshotAId)
      .first<{ health_json: string }>();
    const snapshotB = await this.db
      .prepare('SELECT health_json FROM deck_health_snapshots WHERE id = ?')
      .bind(snapshotBId)
      .first<{ health_json: string }>();

    if (!snapshotA || !snapshotB) {
      throw new Error('Snapshot not found');
    }

    const healthA: DeckHealthMetrics = JSON.parse(snapshotA.health_json);
    const healthB: DeckHealthMetrics = JSON.parse(snapshotB.health_json);

    const changes: Record<string, { before: number; after: number; diff: number }> = {};

    const compare = (key: string, a: number, b: number) => {
      changes[key] = { before: a, after: b, diff: b - a };
    };

    compare('totalCards', healthA.totalCards, healthB.totalCards);
    compare('avgCmc', healthA.avgCmc, healthB.avgCmc);
    compare('rampCount', healthA.rampCount, healthB.rampCount);
    compare('cardDrawCount', healthA.cardDrawCount, healthB.cardDrawCount);
    compare('removalCount', healthA.removalCount, healthB.removalCount);
    compare('winConditionCount', healthA.winConditionCount, healthB.winConditionCount);
    compare('comboCount', healthA.comboCount, healthB.comboCount);

    return { changes };
  }

  // ==================== Helpers ====================

  private estimateCMC(cardName: string): number {
    const cmcMatch = cardName.match(/\((\d+)\)/);
    if (cmcMatch) return parseInt(cmcMatch[1], 10);
    return 0;
  }

  private isLand(cardName: string): boolean {
    return cardName.toLowerCase().includes('land') ||
      cardName.toLowerCase().includes('basic') ||
      cardName.toLowerCase().includes('swamp') ||
      cardName.toLowerCase().includes('island') ||
      cardName.toLowerCase().includes('mountain') ||
      cardName.toLowerCase().includes('forest') ||
      cardName.toLowerCase().includes('plains');
  }

  private detectCardTypes(cardName: string): string[] {
    const lower = cardName.toLowerCase();
    const types: string[] = [];
    for (const [type, keywords] of Object.entries(CARD_TYPE_KEYWORDS)) {
      if (keywords.some(k => lower.includes(k))) {
        types.push(type);
      }
    }
    return types;
  }

  private detectColors(cards: Array<{ name: string; tags: string[] }>): string[] {
    const colorIndicators = ['white', 'blue', 'black', 'red', 'green', 'colorless'];
    const colors = new Set<string>();

    for (const card of cards) {
      const lower = card.name.toLowerCase();
      if (card.tags.includes('land')) continue;
      for (const color of colorIndicators) {
        if (lower.includes(color)) {
          colors.add(color);
        }
      }
    }

    return Array.from(colors);
  }

  private producesColor(landName: string, colors: string[]): boolean {
    const lower = landName.toLowerCase();
    return colors.some(c => lower.includes(c));
  }

  private countByKeywords(
    cards: Array<{ name: string; qty: number }>,
    keywords: string[]
  ): number {
    let count = 0;
    for (const card of cards) {
      const lower = card.name.toLowerCase();
      if (keywords.some(k => lower.includes(k.toLowerCase()))) {
        count += card.qty;
      }
    }
    return count;
  }

  private estimateComboCount(cards: Array<{ name: string }>): number {
    const comboCards = [
      'dockside', 'isochron', 'dramatic reversal', 'scepter', 'reversal',
      'mike', 'trike', 'food chain', 'flash', 'hulk', 'body snatcher',
      'protein', 'pulmonic', 'splinter', 'worship', 'dramica', 'aetherflux',
      'laboratory', 'jace', 'archivist', 'mindcrank', 'pile', 'biorhythm',
      'crater', 'beacon', 'dire', 'fleet', 'licid', 'transcendence',
    ];

    let count = 0;
    for (const card of cards) {
      const lower = card.name.toLowerCase();
      if (comboCards.some(k => lower.includes(k))) {
        count++;
      }
    }

    return Math.floor(count / 2);
  }
}
