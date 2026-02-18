/**
 * Scryfall Commander Seeder
 *
 * Uses Scryfall API to get list of all legendary creatures,
 * then seeds commander_stats with placeholder data.
 * More reliable than EDHREC scraping.
 */

export interface ScryfallCard {
  name: string;
  type_line: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  oracle_text?: string;
  power?: string;
  toughness?: string;
  mana_cost?: string;
  cmc?: number;
}

export interface ScryfallSearchResponse {
  data: ScryfallCard[];
  has_more: boolean;
  next_page?: string;
}

/**
 * Fetch all legendary creatures from Scryfall
 * These are potential commanders
 */
export async function fetchLegendaryCreatures(
  limit: number = 500
): Promise<ScryfallCard[]> {
  const commanders: ScryfallCard[] = [];
  let page = 1;

  // Scryfall query: Legendary Creatures that can be commanders
  // Excludes backgrounds, silver-bordered, etc.
  const query = encodeURIComponent(
    't:legendary t:creature -is:rebalanced -is:digital -is:funny legal:commander'
  );

  while (commanders.length < limit) {
    const url = `https://api.scryfall.com/cards/search?q=${query}&page=${page}&order=edhrec`;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'DeckLens/1.0',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          // No more results
          break;
        }
        console.error(`[Scryfall] Error fetching page ${page}: ${response.status}`);
        break;
      }

      const data = await response.json() as ScryfallSearchResponse;

      for (const card of data.data) {
        // Only include creatures (no backgrounds, etc.)
        if (card.type_line.includes('Legendary') && card.type_line.includes('Creature')) {
          commanders.push(card);
          if (commanders.length >= limit) break;
        }
      }

      if (!data.has_more) break;

      page++;

      // Scryfall rate limit: 10 requests per second, be conservative
      await sleep(100);

    } catch (err) {
      console.error(`[Scryfall] Error fetching commanders:`, err);
      break;
    }
  }

  return commanders;
}

/**
 * Estimate commander popularity based on Scryfall data
 * (Until we have real EDHREC data)
 */
function estimatePopularity(card: ScryfallCard): number {
  let score = 100; // Base score

  // Color identity (more colors = more popular in EDH)
  const colorCount = card.color_identity?.length || 0;
  if (colorCount >= 4) score += 50;      // 4-5 colors (very popular)
  else if (colorCount === 3) score += 30; // 3 colors (popular)
  else if (colorCount === 2) score += 20; // 2 colors (common)
  else if (colorCount === 1) score += 10; // Mono-color

  // Keywords that are popular in EDH
  const keywords = card.keywords || [];
  if (keywords.includes('Partner')) score += 100; // Partner commanders are very popular
  if (keywords.includes('Partner with')) score += 80;
  if (keywords.includes('Flying')) score += 10;
  if (keywords.includes('Haste')) score += 15;

  // Oracle text checks (powerful abilities)
  const text = (card.oracle_text || '').toLowerCase();
  if (text.includes('draw')) score += 20;
  if (text.includes('sacrifice')) score += 15;
  if (text.includes('graveyard')) score += 15;
  if (text.includes('token')) score += 10;
  if (text.includes('whenever')) score += 10;

  return score;
}

/**
 * Seed commander_stats from Scryfall data
 * Uses batch inserts to avoid timeout
 */
export async function seedCommanderStatsFromScryfall(
  db: D1Database,
  limit: number = 500
): Promise<number> {
  console.log(`[Scryfall] Fetching top ${limit} legendary creatures...`);
  const commanders = await fetchLegendaryCreatures(limit);

  if (commanders.length === 0) {
    console.error('[Scryfall] No commanders found');
    return 0;
  }

  console.log(`[Scryfall] Found ${commanders.length} commanders, seeding database...`);

  let seededCount = 0;
  const BATCH_SIZE = 100;

  // Process in batches to avoid timeout
  for (let i = 0; i < commanders.length; i += BATCH_SIZE) {
    const batch = commanders.slice(i, i + BATCH_SIZE);
    const values: string[] = [];
    const bindings: any[] = [];

    for (const card of batch) {
      const popularity = estimatePopularity(card);
      const estimatedDecks = Math.floor(popularity * (Math.random() * 50 + 50));
      const estimatedPrice = card.cmc ? card.cmc * 10 : 50;

      values.push('(?, 0, 0, ?, 5.0, ?, 0, 0, ?)');
      bindings.push(
        card.name,
        estimatedDecks,
        estimatedPrice,
        Math.floor(Date.now() / 1000)
      );
    }

    // Batch insert
    const query = `
      INSERT OR IGNORE INTO commander_stats (
        commander_name,
        win_rate,
        meta_percentage,
        total_decks,
        avg_power_level,
        avg_deck_price,
        avg_games_played,
        popularity_rank,
        last_updated
      ) VALUES ${values.join(', ')}
    `;

    await db.prepare(query).bind(...bindings).run();
    seededCount += batch.length;

    console.log(`[Scryfall] Seeded ${seededCount}/${commanders.length} commanders...`);
  }

  // Recalculate popularity ranks and meta percentages
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

  console.log(`[Scryfall] Seeded ${seededCount} commanders`);

  return seededCount;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
