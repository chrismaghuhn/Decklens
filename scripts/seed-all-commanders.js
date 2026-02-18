/**
 * Offline Commander Seeding Script
 *
 * Fetches ALL legendary creatures from Scryfall and generates SQL insert statements
 * Run this locally, then execute the SQL against the database
 *
 * Usage: node scripts/seed-all-commanders.js > commanders.sql
 */

const SCRYFALL_API = 'https://api.scryfall.com/cards/search';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimatePopularity(card) {
  let score = 100;

  const colorCount = card.color_identity?.length || 0;
  if (colorCount >= 4) score += 50;
  else if (colorCount === 3) score += 30;
  else if (colorCount === 2) score += 20;
  else if (colorCount === 1) score += 10;

  const keywords = card.keywords || [];
  if (keywords.includes('Partner')) score += 100;
  if (keywords.includes('Partner with')) score += 80;
  if (keywords.includes('Flying')) score += 10;
  if (keywords.includes('Haste')) score += 15;

  const text = (card.oracle_text || '').toLowerCase();
  if (text.includes('draw')) score += 20;
  if (text.includes('sacrifice')) score += 15;
  if (text.includes('graveyard')) score += 15;
  if (text.includes('token')) score += 10;
  if (text.includes('whenever')) score += 10;

  return score;
}

async function fetchAllCommanders() {
  const commanders = [];
  let page = 1;
  const query = encodeURIComponent('t:legendary t:creature -is:rebalanced -is:digital -is:funny legal:commander');

  while (true) {
    const url = `${SCRYFALL_API}?q=${query}&page=${page}&order=edhrec`;

    console.error(`Fetching page ${page}...`);

    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) break;
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    for (const card of data.data) {
      if (card.type_line.includes('Legendary') && card.type_line.includes('Creature')) {
        commanders.push(card);
      }
    }

    console.error(`Total commanders: ${commanders.length}`);

    if (!data.has_more) break;
    page++;

    await sleep(100); // Scryfall rate limit
  }

  return commanders;
}

async function main() {
  console.error('Fetching all commanders from Scryfall...');
  const commanders = await fetchAllCommanders();

  console.error(`Found ${commanders.length} commanders`);
  console.error('Generating SQL...');

  // Generate SQL
  console.log('-- Commander Stats Seed Data (Generated from Scryfall)');
  console.log('-- Total commanders:', commanders.length);
  console.log('-- Generated:', new Date().toISOString());
  console.log('');

  const timestamp = Math.floor(Date.now() / 1000);
  const batchSize = 100;

  for (let i = 0; i < commanders.length; i += batchSize) {
    const batch = commanders.slice(i, i + batchSize);
    const values = [];

    for (const card of batch) {
      const popularity = estimatePopularity(card);
      const estimatedDecks = Math.floor(popularity * (Math.random() * 50 + 50));
      const estimatedPrice = card.cmc ? card.cmc * 10 : 50;
      const name = card.name.replace(/'/g, "''"); // Escape quotes

      values.push(`('${name}', 0, 0, ${estimatedDecks}, 5.0, ${estimatedPrice}, 0, 0, ${timestamp})`);
    }

    console.log(`INSERT OR IGNORE INTO commander_stats (commander_name, win_rate, meta_percentage, total_decks, avg_power_level, avg_deck_price, avg_games_played, popularity_rank, last_updated) VALUES`);
    console.log(values.join(',\n'));
    console.log(';');
    console.log('');
  }

  // Recalculate ranks
  console.log('-- Recalculate popularity ranks and meta percentages');
  console.log(`UPDATE commander_stats SET popularity_rank = (SELECT COUNT(*) + 1 FROM commander_stats AS c2 WHERE c2.total_decks > commander_stats.total_decks), meta_percentage = ROUND((total_decks * 100.0 / (SELECT SUM(total_decks) FROM commander_stats)), 3);`);

  console.error('Done! SQL written to stdout');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
