/**
 * Commander Stats Aggregation System
 *
 * Calculates commander statistics from community_decks table:
 * - Win Rate: % of games won
 * - Meta Percentage: % of all decks using this commander
 * - Popularity Rank: Ranking by total deck count
 * - Avg Power Level: Average user-submitted power level
 * - Avg Deck Price: Average deck cost in EUR
 */

export interface CommanderStatsRow {
  commander_name: string;
  win_rate: number;          // 0-100%
  meta_percentage: number;   // 0-100%
  total_decks: number;
  avg_power_level: number;   // 1-10
  avg_deck_price: number;    // EUR
  avg_games_played: number;
  popularity_rank: number;   // 1 = most popular
  last_updated: number;      // Unix timestamp
}

/**
 * Aggregate commander stats from community_decks
 *
 * HYBRID APPROACH:
 * - Only UPDATE commanders with 10+ real community decks
 * - Preserves Scryfall baseline data for commanders with <10 decks
 * - Provides real win rates and stats where we have sufficient data
 *
 * NOTE: community_decks.commander is plain TEXT (commander name)
 */
export const COMMANDER_STATS_AGGREGATION_QUERY = `
-- First, update existing commanders with 10+ community decks
INSERT OR REPLACE INTO commander_stats (
  commander_name,
  win_rate,
  meta_percentage,
  total_decks,
  avg_power_level,
  avg_deck_price,
  avg_games_played,
  popularity_rank,
  last_updated
)
SELECT
  d.commander AS commander_name,

  -- Win Rate: % of decks with win_count > loss_count
  ROUND(
    AVG(
      CASE
        WHEN d.win_count > d.loss_count THEN 100.0
        ELSE 0.0
      END
    ), 2
  ) AS win_rate,

  -- Meta Percentage: Calculate based on total decks (will be recalculated globally)
  0 AS meta_percentage,

  -- Total Decks: Count of real community decks
  COUNT(*) AS total_decks,

  -- Avg Power Level: Mean power level (1-10 scale)
  ROUND(AVG(COALESCE(d.power_level, 5.0)), 2) AS avg_power_level,

  -- Avg Deck Price: Mean price in EUR
  ROUND(AVG(COALESCE(d.price, 0.0)), 2) AS avg_deck_price,

  -- Avg Games Played: Mean games per deck
  ROUND(AVG(COALESCE(d.games_played, 0))) AS avg_games_played,

  -- Popularity Rank: Will be recalculated globally
  0 AS popularity_rank,

  -- Last Updated: Current timestamp
  unixepoch() AS last_updated

FROM community_decks d
WHERE
  d.commander IS NOT NULL
  AND d.commander != 'system'  -- Exclude system decks
GROUP BY d.commander
HAVING COUNT(*) >= 10  -- Minimum 10 decks for statistical significance
ORDER BY total_decks DESC;
`;

/**
 * Get commander stats by name
 */
export async function getCommanderStats(
  db: D1Database,
  commanderName: string
): Promise<CommanderStatsRow | null> {
  const result = await db
    .prepare('SELECT * FROM commander_stats WHERE commander_name = ?')
    .bind(commanderName)
    .first<CommanderStatsRow>();

  return result || null;
}

/**
 * Get top commanders by popularity
 */
export async function getTopCommanders(
  db: D1Database,
  limit: number = 100
): Promise<CommanderStatsRow[]> {
  const result = await db
    .prepare('SELECT * FROM commander_stats ORDER BY popularity_rank ASC LIMIT ?')
    .bind(limit)
    .all<CommanderStatsRow>();

  return result.results || [];
}

/**
 * Refresh all commander stats (run via cron)
 *
 * HYBRID APPROACH:
 * 1. Update commanders with 10+ real community decks (from COMMANDER_STATS_AGGREGATION_QUERY)
 * 2. Recalculate global meta percentages and popularity ranks for ALL commanders
 */
export async function refreshCommanderStats(db: D1Database): Promise<number> {
  // Step 1: Update commanders with sufficient community data
  const result = await db
    .prepare(COMMANDER_STATS_AGGREGATION_QUERY)
    .run();

  const updatedCount = result.meta?.changes || 0;

  // Step 2: Recalculate global meta percentages and popularity ranks
  const totalDecks = await db.prepare(`
    SELECT SUM(total_decks) as total FROM commander_stats
  `).first<{ total: number }>();

  const total = totalDecks?.total || 1;

  await db.prepare(`
    UPDATE commander_stats
    SET
      popularity_rank = (
        SELECT COUNT(*) + 1
        FROM commander_stats AS c2
        WHERE c2.total_decks > commander_stats.total_decks
      ),
      meta_percentage = ROUND((total_decks * 100.0 / ?), 3)
  `).bind(total).run();

  return updatedCount;
}

/**
 * Get stats for multiple commanders (batch)
 */
export async function getCommanderStatsBatch(
  db: D1Database,
  commanderNames: string[]
): Promise<Map<string, CommanderStatsRow>> {
  if (commanderNames.length === 0) {
    return new Map();
  }

  // Build placeholders for IN clause
  const placeholders = commanderNames.map(() => '?').join(',');
  const query = `
    SELECT * FROM commander_stats
    WHERE commander_name IN (${placeholders})
  `;

  const result = await db
    .prepare(query)
    .bind(...commanderNames)
    .all<CommanderStatsRow>();

  // Convert to Map for O(1) lookups
  const statsMap = new Map<string, CommanderStatsRow>();
  for (const row of result.results || []) {
    statsMap.set(row.commander_name, row);
  }

  return statsMap;
}
