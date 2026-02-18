/**
 * EDHREC JSON API Client
 *
 * Uses EDHREC's unofficial JSON API (more stable than HTML scraping)
 * Example: https://json.edhrec.com/pages/commanders/atraxa-praetors-voice.json
 */

export interface EDHRECCommanderData {
  commanderName: string;
  avgPrice: number;
  numDecks: number;
  saltScore: number;
  colorIdentity: string[];
}

/**
 * Fetch commander data from EDHREC JSON API
 */
export async function fetchCommanderDataFromEDHREC(
  commanderName: string
): Promise<EDHRECCommanderData | null> {
  // Convert commander name to EDHREC URL slug
  // "Atraxa, Praetors' Voice" → "atraxa-praetors-voice"
  const slug = commanderName
    .toLowerCase()
    .replace(/[,']/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  const url = `https://json.edhrec.com/pages/commanders/${slug}.json`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.log(`[EDHREC JSON] Commander not found: ${commanderName} (${response.status})`);
      return null;
    }

    const data = await response.json() as any;

    return {
      commanderName,
      avgPrice: data.avg_price || 0,
      numDecks: data.num_decks_avg || 0,
      saltScore: data.salt || 0,
      colorIdentity: data.color_identity || [],
    };
  } catch (err) {
    console.error(`[EDHREC JSON] Error fetching ${commanderName}:`, err);
    return null;
  }
}

/**
 * Fetch top commanders from EDHREC JSON API
 * https://json.edhrec.com/pages/top/commanders.json
 */
export async function fetchTopCommandersFromEDHREC(limit: number = 100): Promise<string[]> {
  const url = 'https://json.edhrec.com/pages/top/commanders.json';

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[EDHREC JSON] Failed to fetch top commanders: ${response.status}`);
      return [];
    }

    const data = await response.json() as any;

    // EDHREC JSON structure: { "cardlists": [ { "header": "Top Commanders", "cardviews": [...] } ] }
    const cardlists = data.cardlists || [];
    const topCommandersList = cardlists.find((list: any) =>
      list.header?.includes('Top') || list.tag === 'commanders'
    );

    if (!topCommandersList || !topCommandersList.cardviews) {
      console.error('[EDHREC JSON] Could not find cardviews in response');
      return [];
    }

    const commanders: string[] = [];
    for (const card of topCommandersList.cardviews) {
      if (card.name && commanders.length < limit) {
        commanders.push(card.name);
      }
    }

    return commanders.slice(0, limit);
  } catch (err) {
    console.error('[EDHREC JSON] Error fetching top commanders:', err);
    return [];
  }
}

/**
 * Seed commander_stats from EDHREC JSON API
 * Much more reliable than HTML scraping!
 */
export async function seedCommanderStatsFromEDHRECJSON(
  db: D1Database,
  commanders: string[],
  onProgress?: (current: number, total: number, commander: string) => void
): Promise<number> {
  let seededCount = 0;

  for (let i = 0; i < commanders.length; i++) {
    const commanderName = commanders[i];

    if (onProgress) {
      onProgress(i + 1, commanders.length, commanderName);
    }

    const data = await fetchCommanderDataFromEDHREC(commanderName);

    if (!data || data.numDecks === 0) {
      console.log(`[EDHREC JSON] Skipping ${commanderName} (no data)`);
      continue;
    }

    // Insert into database (INSERT OR REPLACE to update existing)
    await db.prepare(`
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
      ) VALUES (?, 0, 0, ?, 5.0, ?, 0, 0, ?)
    `).bind(
      commanderName,
      data.numDecks,
      Math.round(data.avgPrice),
      Math.floor(Date.now() / 1000)
    ).run();

    seededCount++;

    // Rate limit: 500ms between requests
    await sleep(500);
  }

  // Recalculate meta percentages and popularity ranks
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

  return seededCount;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
