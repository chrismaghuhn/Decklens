/**
 * combo-db.ts — Combo Database Module for DeckLens
 *
 * CRUD operations, inverted index, and lookup logic for a scalable
 * combo detection system backed by Cloudflare D1 (SQLite).
 */

// Avoid importing worker-specific types; use a loose alias.
type D1 = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComboRecord {
  id: string;
  source: 'spellbook' | 'catalog' | 'community';
  name: string;
  cards: string[];
  cardsCount: number;
  optionalCards: string[];
  requires: string[];
  description: string;
  produces: string[];
  resultTags: string[];
  colorIdentity: string;
  spellbookUrl: string;
  ofId: string | null;
  popularity: number;
  hasTemplateReqs?: boolean;
}

export interface ComboLookupResult {
  complete: ComboRecord[];
  nearMiss: ComboRecord[];
  partial: ComboRecord[];
}

export interface ComboStats {
  total: number;
  bySource: { spellbook: number; catalog: number; community: number };
  lastSync: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max items per D1 batch (leave headroom under the 100-stmt hard cap). */
const BATCH_SIZE = 80;

/** Max bound parameters per SQL placeholder list (stay under 100). */
const CHUNK_SIZE = 90;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a card name for index lookups. */
export function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Turn a string into a URL-safe slug. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Parse a DB row into a `ComboRecord`. */
export function parseComboRow(row: any): ComboRecord {
  const parseJSON = (val: any, fallback: any[] = []): any => {
    if (val == null) return fallback;
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        return fallback;
      }
    }
    return val;
  };

  return {
    id: row.id,
    source: row.source,
    name: row.name,
    cards: parseJSON(row.cards_json, []),
    cardsCount: row.cards_count ?? 0,
    optionalCards: parseJSON(row.optional_cards_json, []),
    requires: parseJSON(row.requires_json, []),
    description: row.description ?? '',
    produces: parseJSON(row.produces_json, []),
    resultTags: parseJSON(row.result_tags_json, []),
    colorIdentity: row.color_identity ?? '',
    spellbookUrl: row.spellbook_url ?? '',
    ofId: row.of_id ?? null,
    popularity: row.popularity ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Upsert combos
// ---------------------------------------------------------------------------

/**
 * INSERT OR REPLACE combos into the `combos` table.
 * Batches statements in groups of BATCH_SIZE to stay within D1 limits.
 * Returns the total number of upserted rows.
 */
export async function upsertComboBatch(
  db: D1,
  combos: ComboRecord[],
): Promise<number> {
  if (combos.length === 0) return 0;

  const now = new Date().toISOString();
  let upserted = 0;

  for (let i = 0; i < combos.length; i += BATCH_SIZE) {
    const chunk = combos.slice(i, i + BATCH_SIZE);
    const stmts = chunk.map((c) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO combos
           (id, source, name, cards_json, cards_count, optional_cards_json,
            requires_json, description, produces_json, result_tags_json,
            color_identity, spellbook_url, of_id, popularity,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          c.id,
          c.source,
          c.name,
          JSON.stringify(c.cards),
          c.cardsCount,
          JSON.stringify(c.optionalCards),
          JSON.stringify(c.requires),
          c.description,
          JSON.stringify(c.produces),
          JSON.stringify(c.resultTags),
          c.colorIdentity,
          c.spellbookUrl,
          c.ofId,
          c.popularity,
          now, // created_at (kept on first insert; replaced on conflict)
          now, // updated_at
        ),
    );

    await db.batch(stmts);
    upserted += chunk.length;
  }

  return upserted;
}

// ---------------------------------------------------------------------------
// 2. Inverted index rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild the `combo_card_index` table.
 *
 * - If `comboIds` is provided, only those combos are re-indexed.
 * - Otherwise a full rebuild is performed.
 *
 * Returns the number of index entries created.
 */
export async function rebuildInvertedIndex(
  db: D1,
  comboIds?: string[],
): Promise<number> {
  // ------ Step 1: delete stale entries ------
  if (comboIds && comboIds.length > 0) {
    // Chunked delete for the supplied IDs.
    for (let i = 0; i < comboIds.length; i += CHUNK_SIZE) {
      const chunk = comboIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      await db
        .prepare(
          `DELETE FROM combo_card_index WHERE combo_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .run();
    }
  } else {
    // Full rebuild: wipe everything.
    await db.prepare('DELETE FROM combo_card_index').run();
  }

  // ------ Step 2: fetch combos to index ------
  let rows: any[];

  if (comboIds && comboIds.length > 0) {
    rows = [];
    for (let i = 0; i < comboIds.length; i += CHUNK_SIZE) {
      const chunk = comboIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const res = await db
        .prepare(`SELECT * FROM combos WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all();
      rows.push(...(res.results ?? []));
    }
  } else {
    const res = await db.prepare('SELECT * FROM combos').all();
    rows = res.results ?? [];
  }

  // ------ Step 3: build index entries and batch-insert ------
  let totalEntries = 0;
  const insertStmts: any[] = [];

  for (const row of rows) {
    const combo = parseComboRow(row);
    for (const card of combo.cards) {
      insertStmts.push(
        db
          .prepare(
            `INSERT INTO combo_card_index
             (card_name_norm, combo_id, oracle_id, canonical_name, is_required, combo_cards_count)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            norm(card),
            combo.id,
            null, // oracle_id — not resolved yet
            card,
            1,
            combo.cardsCount,
          ),
      );
    }
  }

  // Execute in BATCH_SIZE groups.
  for (let i = 0; i < insertStmts.length; i += BATCH_SIZE) {
    const chunk = insertStmts.slice(i, i + BATCH_SIZE);
    await db.batch(chunk);
    totalEntries += chunk.length;
  }

  return totalEntries;
}

// ---------------------------------------------------------------------------
// 3. Batch-fetch combos by ID
// ---------------------------------------------------------------------------

/**
 * Fetch combo records by a list of IDs, chunked to respect D1 limits.
 */
export async function batchFetchCombos(
  db: D1,
  ids: string[],
): Promise<ComboRecord[]> {
  if (ids.length === 0) return [];

  const results: ComboRecord[] = [];

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(`SELECT * FROM combos WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all();

    for (const row of res.results ?? []) {
      results.push(parseComboRow(row));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 4. Lookup combos by deck card list
// ---------------------------------------------------------------------------

/**
 * Given a list of card names (e.g. the whole deck), find:
 *  - **complete**: every required card is present
 *  - **nearMiss**: exactly one card short (only for small combos, cards <= 4)
 *  - **partial**: at least 2 hits
 *
 * Uses a chunked inverted-index query strategy.
 */
export async function lookupCombosByCards(
  db: D1,
  cardNames: string[],
): Promise<ComboLookupResult> {
  // Deduplicate and normalise.
  const normSet = new Set<string>();
  for (const n of cardNames) {
    const cn = norm(n);
    if (cn) normSet.add(cn);
  }
  const normNames = [...normSet];

  if (normNames.length === 0) {
    return { complete: [], nearMiss: [], partial: [] };
  }

  // ---- Hit map: combo_id -> number of matching cards ----
  const hitMap = new Map<string, number>();
  const comboCardCountMap = new Map<string, number>();

  for (let i = 0; i < normNames.length; i += CHUNK_SIZE) {
    const chunk = normNames.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');

    // Query 1: combos with >= 2 total hits across the deck.
    // We gather per-chunk hits first then merge.
    const q1 = await db
      .prepare(
        `SELECT combo_id, combo_cards_count, COUNT(*) AS hits
         FROM combo_card_index
         WHERE card_name_norm IN (${placeholders})
         GROUP BY combo_id
         HAVING hits >= 1`,
      )
      .bind(...chunk)
      .all();

    for (const row of q1.results ?? []) {
      const prev = hitMap.get(row.combo_id) ?? 0;
      hitMap.set(row.combo_id, prev + (row.hits as number));
      comboCardCountMap.set(row.combo_id, row.combo_cards_count as number);
    }
  }

  // ---- Filter candidates ----
  const candidateIds: string[] = [];

  for (const [comboId, hits] of hitMap) {
    const total = comboCardCountMap.get(comboId) ?? Infinity;

    // Complete: all cards present.
    if (hits >= total) {
      candidateIds.push(comboId);
      continue;
    }
    // Near-miss: one card short, small combo.
    if (hits === total - 1 && total <= 4) {
      candidateIds.push(comboId);
      continue;
    }
    // Partial: at least 2 hits.
    if (hits >= 2) {
      candidateIds.push(comboId);
      continue;
    }
  }

  // Cap to top 100 candidates, prioritised by hit ratio.
  candidateIds.sort((a, b) => {
    const hitsA = hitMap.get(a) ?? 0;
    const hitsB = hitMap.get(b) ?? 0;
    const totalA = comboCardCountMap.get(a) ?? 1;
    const totalB = comboCardCountMap.get(b) ?? 1;
    return hitsB / totalB - hitsA / totalA;
  });
  const topIds = candidateIds.slice(0, 100);

  if (topIds.length === 0) {
    return { complete: [], nearMiss: [], partial: [] };
  }

  // ---- Fetch full combo records ----
  const combos = await batchFetchCombos(db, topIds);

  // ---- Classify ----
  const complete: ComboRecord[] = [];
  const nearMiss: ComboRecord[] = [];
  const partial: ComboRecord[] = [];

  for (const combo of combos) {
    const hits = hitMap.get(combo.id) ?? 0;

    // Tag template-based requirements.
    if (combo.requires.length > 0) {
      combo.hasTemplateReqs = true;
    }

    if (hits >= combo.cardsCount) {
      complete.push(combo);
    } else if (hits === combo.cardsCount - 1 && combo.cardsCount <= 4) {
      nearMiss.push(combo);
    } else if (hits >= 2) {
      partial.push(combo);
    }
  }

  // Sort each bucket: complete by popularity desc, near-miss by cards count asc, partial by hits desc.
  complete.sort((a, b) => b.popularity - a.popularity);
  nearMiss.sort((a, b) => a.cardsCount - b.cardsCount);
  partial.sort((a, b) => {
    const hA = hitMap.get(a.id) ?? 0;
    const hB = hitMap.get(b.id) ?? 0;
    return hB - hA;
  });

  return { complete, nearMiss, partial };
}

// ---------------------------------------------------------------------------
// 5. Seed catalog combos
// ---------------------------------------------------------------------------

/** Well-known archetype combos shipped with the app. */
const CATALOG_COMBOS: Omit<ComboRecord, 'id'>[] = [
  {
    source: 'catalog',
    name: 'High Tide Loop',
    cards: ['High Tide', 'Time Spiral', 'Brain Freeze'],
    cardsCount: 3,
    optionalCards: [],
    requires: [],
    description:
      'Cast High Tide, untap lands with Time Spiral, and storm off with Brain Freeze for lethal mill.',
    produces: ['Infinite Storm', 'Infinite Mill'],
    resultTags: ['storm', 'mill', 'infinite'],
    colorIdentity: 'U',
    spellbookUrl: '',
    ofId: null,
    popularity: 80,
  },
  {
    source: 'catalog',
    name: 'Breach LED',
    cards: ['Underworld Breach', "Lion's Eye Diamond", 'Brain Freeze'],
    cardsCount: 3,
    optionalCards: [],
    requires: [],
    description:
      'Escape spells from the graveyard via Underworld Breach, discard hand to LED for mana, and storm out with Brain Freeze.',
    produces: ['Infinite Storm', 'Infinite Mill'],
    resultTags: ['storm', 'mill', 'infinite'],
    colorIdentity: 'R',
    spellbookUrl: '',
    ofId: null,
    popularity: 95,
  },
  {
    source: 'catalog',
    name: 'Food Chain Infinite',
    cards: ['Food Chain', 'Eternal Scourge'],
    cardsCount: 2,
    optionalCards: [],
    requires: [],
    description:
      'Exile Eternal Scourge to Food Chain for mana, then recast it from exile infinitely for infinite creature mana.',
    produces: ['Infinite Creature Mana'],
    resultTags: ['infinite', 'mana'],
    colorIdentity: 'G',
    spellbookUrl: '',
    ofId: null,
    popularity: 88,
  },
  {
    source: 'catalog',
    name: 'Walking Ballista Kill',
    cards: ['Food Chain', 'Misthollow Griffin', 'Walking Ballista'],
    cardsCount: 3,
    optionalCards: [],
    requires: [],
    description:
      'Generate infinite creature mana with Food Chain + Misthollow Griffin, then cast Walking Ballista for lethal damage.',
    produces: ['Infinite Creature Mana', 'Infinite Damage'],
    resultTags: ['infinite', 'mana', 'damage', 'win'],
    colorIdentity: 'G',
    spellbookUrl: '',
    ofId: null,
    popularity: 85,
  },
  {
    source: 'catalog',
    name: 'Consultation Oracle',
    cards: ["Thassa's Oracle", 'Demonic Consultation'],
    cardsCount: 2,
    optionalCards: [],
    requires: [],
    description:
      "Cast Demonic Consultation naming a card not in your deck to exile your library, then win with Thassa's Oracle's ETB trigger.",
    produces: ['Win the Game'],
    resultTags: ['win', 'infinite'],
    colorIdentity: 'UB',
    spellbookUrl: '',
    ofId: null,
    popularity: 98,
  },
  {
    source: 'catalog',
    name: 'Hermit Druid',
    cards: ['Hermit Druid', "Thassa's Oracle"],
    cardsCount: 2,
    optionalCards: [],
    requires: ['No basic lands in deck'],
    description:
      "Activate Hermit Druid with no basics to mill your entire library, then win with Thassa's Oracle.",
    produces: ['Win the Game'],
    resultTags: ['win', 'self-mill'],
    colorIdentity: 'UG',
    spellbookUrl: '',
    ofId: null,
    popularity: 82,
  },
  {
    source: 'catalog',
    name: 'Monolith Power',
    cards: ['Grim Monolith', 'Power Artifact'],
    cardsCount: 2,
    optionalCards: [],
    requires: [],
    description:
      'Enchant Grim Monolith with Power Artifact to reduce its untap cost below its mana output, producing infinite colorless mana.',
    produces: ['Infinite Colorless Mana'],
    resultTags: ['infinite', 'mana'],
    colorIdentity: 'U',
    spellbookUrl: '',
    ofId: null,
    popularity: 78,
  },
  {
    source: 'catalog',
    name: 'Basalt Rings',
    cards: ['Basalt Monolith', 'Rings of Brighthearth'],
    cardsCount: 2,
    optionalCards: [],
    requires: [],
    description:
      'Copy Basalt Monolith\'s untap ability with Rings of Brighthearth. Pay 2 to copy, untap twice, tap for 3 each time — net +1 mana per loop.',
    produces: ['Infinite Colorless Mana'],
    resultTags: ['infinite', 'mana'],
    colorIdentity: '',
    spellbookUrl: '',
    ofId: null,
    popularity: 76,
  },
];

/**
 * Seed the database with well-known catalog combos.
 * Returns the number of combos seeded.
 */
export async function seedCatalogCombos(db: D1): Promise<number> {
  const records: ComboRecord[] = CATALOG_COMBOS.map((c) => ({
    ...c,
    id: `catalog:${slugify(c.name)}`,
  }));

  const count = await upsertComboBatch(db, records);

  // Rebuild index only for the seeded combos.
  const ids = records.map((r) => r.id);
  await rebuildInvertedIndex(db, ids);

  return count;
}

// ---------------------------------------------------------------------------
// 6. Sync metadata helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a value from the `sync_meta` key-value table.
 */
export async function getSyncMeta(
  db: D1,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM combo_sync_meta WHERE key = ?')
    .bind(key)
    .first();
  return row?.value ?? null;
}

/**
 * Set a value in the `sync_meta` key-value table.
 */
export async function setSyncMeta(
  db: D1,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO combo_sync_meta (key, value, updated_at) VALUES (?, ?, ?)',
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

// ---------------------------------------------------------------------------
// 7. Stats
// ---------------------------------------------------------------------------

/**
 * Return aggregate combo statistics.
 */
export async function getComboStats(db: D1): Promise<ComboStats> {
  const [totalRow, spellbookRow, catalogRow, communityRow] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS cnt FROM combos').first(),
    db
      .prepare("SELECT COUNT(*) AS cnt FROM combos WHERE source = 'spellbook'")
      .first(),
    db
      .prepare("SELECT COUNT(*) AS cnt FROM combos WHERE source = 'catalog'")
      .first(),
    db
      .prepare("SELECT COUNT(*) AS cnt FROM combos WHERE source = 'community'")
      .first(),
  ]);

  const lastSync = await getSyncMeta(db, 'lastSync');

  return {
    total: totalRow?.cnt ?? 0,
    bySource: {
      spellbook: spellbookRow?.cnt ?? 0,
      catalog: catalogRow?.cnt ?? 0,
      community: communityRow?.cnt ?? 0,
    },
    lastSync,
  };
}
