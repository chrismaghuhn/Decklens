/**
 * EDHREC Deck Scraper
 *
 * Scrapes deck data from EDHREC to seed commander_stats with real-world data.
 * USE SPARINGLY - rate limited and fragile (HTML parsing)
 */

export interface EDHRECDeckData {
  commanderName: string;
  deckCount: number;
  avgPrice?: number;
  saltScore?: number;
  themes: string[];
}

/**
 * Scrape commander page from EDHREC
 * Example: https://edhrec.com/commanders/atraxa-praetors-voice
 */
export async function scrapeCommanderPage(
  commanderName: string
): Promise<EDHRECDeckData | null> {
  // Convert commander name to EDHREC URL format
  // "Atraxa, Praetors' Voice" → "atraxa-praetors-voice"
  const urlSlug = commanderName
    .toLowerCase()
    .replace(/[,']/g, '')  // Remove apostrophes and commas
    .replace(/\s+/g, '-')   // Spaces to hyphens
    .replace(/[^a-z0-9-]/g, ''); // Remove special chars

  const url = `https://edhrec.com/commanders/${urlSlug}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      console.error(`[EDHREC Scraper] Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Parse deck count from HTML
    // Look for patterns like: "12,345 decks" or "<span class="deck-count">12345</span>"
    const deckCountMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*decks?/i)
                        || html.match(/<span[^>]*deck[^>]*>(\d{1,3}(?:,\d{3})*)<\/span>/i)
                        || html.match(/data-deck-count="(\d+)"/);

    const deckCountStr = deckCountMatch ? deckCountMatch[1].replace(/,/g, '') : '0';
    const deckCount = parseInt(deckCountStr, 10);

    // Parse average price (if available)
    // Look for: "$123.45" or "€123.45" or "Average Price: $123"
    const priceMatch = html.match(/(?:average[^$€]*)?[$€]\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i);
    const avgPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : undefined;

    // Parse salt score (if available)
    const saltMatch = html.match(/salt(?:\s*score)?[:\s]+(\d+(?:\.\d+)?)/i);
    const saltScore = saltMatch ? parseFloat(saltMatch[1]) : undefined;

    // Parse themes
    const themes: string[] = [];
    const themeMatches = html.matchAll(/<a[^>]*href="\/themes\/([^"]+)"[^>]*>([^<]+)<\/a>/gi);
    for (const match of themeMatches) {
      themes.push(match[2].trim());
    }

    return {
      commanderName,
      deckCount,
      avgPrice,
      saltScore,
      themes: themes.slice(0, 5), // Top 5 themes
    };
  } catch (err) {
    console.error(`[EDHREC Scraper] Error scraping ${commanderName}:`, err);
    return null;
  }
}

/**
 * Scrape top commanders list from EDHREC
 * https://edhrec.com/top/commanders
 */
export async function scrapeTopCommanders(limit: number = 100): Promise<string[]> {
  const url = 'https://edhrec.com/top/commanders';

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      console.error(`[EDHREC Scraper] Failed to fetch top commanders: ${response.status}`);
      return [];
    }

    const html = await response.text();

    // Parse commander names from HTML
    // Look for: <a href="/commanders/name">Commander Name</a>
    const commanderMatches = html.matchAll(/<a[^>]*href="\/commanders\/([^"]+)"[^>]*>([^<]+)<\/a>/gi);

    const commanders: string[] = [];
    for (const match of commanderMatches) {
      const name = match[2].trim();
      // Filter out navigation links, only keep actual commander names
      if (name && !name.toLowerCase().includes('more') && !name.toLowerCase().includes('view')) {
        commanders.push(name);
      }
      if (commanders.length >= limit) break;
    }

    return commanders.slice(0, limit);
  } catch (err) {
    console.error('[EDHREC Scraper] Error scraping top commanders:', err);
    return [];
  }
}

/**
 * Seed commander_stats with EDHREC data
 * Should be run manually via admin endpoint, not automatically
 */
export async function seedCommanderStatsFromEDHREC(
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

    const data = await scrapeCommanderPage(commanderName);

    if (!data || data.deckCount === 0) {
      console.log(`[EDHREC Scraper] Skipping ${commanderName} (no data)`);
      continue;
    }

    // Insert into commander_stats (only if doesn't exist yet)
    await db.prepare(`
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
      ) VALUES (?, 0, 0, ?, 5.0, ?, 0, 0, ?)
    `).bind(
      commanderName,
      data.deckCount,
      data.avgPrice || 0,
      Math.floor(Date.now() / 1000)
    ).run();

    seededCount++;

    // Rate limit: 1 request per second to be respectful
    await sleep(1000);
  }

  // Recalculate popularity ranks
  await db.prepare(`
    UPDATE commander_stats
    SET popularity_rank = (
      SELECT COUNT(*) + 1
      FROM commander_stats AS c2
      WHERE c2.total_decks > commander_stats.total_decks
    )
  `).run();

  return seededCount;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
