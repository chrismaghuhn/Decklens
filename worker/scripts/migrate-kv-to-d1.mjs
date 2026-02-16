import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = (command) => {
  return execSync(command, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
};

function escapeSql(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function fetchKvJson(key) {
  try {
    const out = run(`npx wrangler kv key get "${key}" --binding COMMUNITY_KV`);
    const trimmed = out.trim();
    if (!trimmed || trimmed === 'Value not found') return null;
    return JSON.parse(trimmed);
  } catch (error) {
    const msg = String(error?.stderr || error?.message || error);
    if (msg.includes('Value not found')) return null;
    throw error;
  }
}

function buildDeckInsertSql(decks) {
  if (!Array.isArray(decks) || decks.length === 0) return '';
  const values = decks
    .filter((deck) => deck && deck.id && deck.id !== '__meta_snapshot__')
    .map((deck) => `(
      '${escapeSql(deck.id)}',
      '${escapeSql(deck.name)}',
      '${escapeSql(deck.format || 'commander')}',
      '${escapeSql(deck.commander)}',
      '${escapeSql(deck.archetype)}',
      '${escapeSql(deck.decklist)}',
      '${escapeSql(deck.notes || '')}',
      '${escapeSql(deck.createdAt || new Date().toISOString())}',
      ${Number(deck.upvotes || 0)},
      ${Number(deck.views || 0)},
      '${escapeSql(JSON.stringify(Array.isArray(deck.tags) ? deck.tags : []))}'
    )`)
    .join(',\n');

  if (!values) return '';

  return `
INSERT OR REPLACE INTO community_decks (id, name, format, commander, archetype, decklist, notes, created_at, upvotes, views, tags_json)
VALUES
${values};
`;
}

function buildSnapshotSql(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  return `
INSERT OR REPLACE INTO community_decks (id, name, format, commander, archetype, decklist, notes, created_at, upvotes, views, tags_json)
VALUES (
  '__meta_snapshot__',
  'meta_snapshot',
  'commander',
  'system',
  'meta',
  '',
  '${escapeSql(JSON.stringify(snapshot))}',
  '${escapeSql(snapshot.updatedAt || new Date().toISOString())}',
  0,
  0,
  '[]'
);
`;
}

function buildFlagsSql(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return '';
  const values = flags
    .filter((flag) => flag && flag.id && flag.deckId)
    .map((flag) => `(
      '${escapeSql(flag.id)}',
      '${escapeSql(flag.deckId)}',
      '${escapeSql(flag.reason || 'manual_report')}',
      '${escapeSql(flag.reporterIpHash || 'unknown')}',
      '${escapeSql(flag.reportedAt || new Date().toISOString())}'
    )`)
    .join(',\n');

  if (!values) return '';

  return `
INSERT OR REPLACE INTO community_abuse_flags (id, deck_id, reason, reporter_ip_hash, reported_at)
VALUES
${values};
`;
}

async function main() {
  const decks = fetchKvJson('community:decks:v1');
  const snapshot = fetchKvJson('meta:realtime:v1');
  const flags = fetchKvJson('community:abuse-flags:v1');

  if (!decks && !snapshot && !flags) {
    console.log('No KV data found to migrate. Nothing to do.');
    return;
  }

  const sqlParts = [
    '-- generated migration from KV to D1',
    buildDeckInsertSql(decks || []),
    buildSnapshotSql(snapshot),
    buildFlagsSql(flags || []),
  ].filter(Boolean);

  if (sqlParts.length === 0) {
    console.log('KV data exists but no valid rows to migrate.');
    return;
  }

  const filePath = join(process.cwd(), 'migrations', '_tmp_kv_to_d1.sql');
  writeFileSync(filePath, `${sqlParts.join('\n')}\n`, 'utf8');

  try {
    run(`npx wrangler d1 execute decklens-community --remote --file "${filePath}"`);
    console.log('KV -> D1 migration completed.');
  } finally {
    if (existsSync(filePath)) unlinkSync(filePath);
  }
}

main().catch((error) => {
  console.error('Migration failed:', error?.stderr || error?.message || error);
  process.exit(1);
});
