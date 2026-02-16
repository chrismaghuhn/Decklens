// ============================================================
// AutoLabelService — Automatic scope-based labeling for PRs
// ============================================================
// Analyzes DeckPatchOps to determine affected scopes
// and applies appropriate labels to Pull Requests.
// ============================================================

import type { DeckPatchOp, DeckBoard } from './types.js';

// Scope labels that can be auto-assigned
export const SCOPE_LABELS: Record<string, { color: string; description: string }> = {
  'scope:manabase':   { color: '#3dd68c', description: 'Changes to mana-producing cards' },
  'scope:sideboard':  { color: '#f59e42', description: 'Sideboard modifications' },
  'scope:commander':  { color: '#a78bfa', description: 'Commander zone changes' },
  'scope:interaction':{ color: '#ef5350', description: 'Removal/interaction package' },
  'scope:wincon':     { color: '#c9a84c', description: 'Win condition changes' },
  'scope:ramp':       { color: '#3dd68c', description: 'Ramp package changes' },
  'scope:draw':       { color: '#5ea3f8', description: 'Card draw changes' },
  'size:small':       { color: '#6b7084', description: '1-5 card changes' },
  'size:medium':      { color: '#f59e42', description: '6-15 card changes' },
  'size:large':       { color: '#ef5350', description: '16+ card changes' },
};

/**
 * Analyze a patch array and derive scope labels.
 */
export function analyzeScopes(patch: DeckPatchOp[]): string[] {
  const labels: Set<string> = new Set();
  if (!patch || patch.length === 0) return [];

  // Track affected boards and infer scopes
  const boardOps: Partial<Record<DeckBoard, DeckPatchOp[]>> = {};
  const cardNames = new Set<string>();
  let totalCardChanges = 0;

  for (const op of patch) {
    // Count card-level changes
    if (op.op === 'add_card' || op.op === 'remove_card') {
      totalCardChanges += op.qty;
      cardNames.add(op.name.toLowerCase());
      const board = op.board;
      if (!boardOps[board]) boardOps[board] = [];
      boardOps[board]!.push(op);
    } else if (op.op === 'move_card') {
      totalCardChanges += op.qty;
      cardNames.add(op.name.toLowerCase());
      if (!boardOps[op.fromBoard]) boardOps[op.fromBoard] = [];
      if (!boardOps[op.toBoard]) boardOps[op.toBoard] = [];
      boardOps[op.fromBoard]!.push(op);
      boardOps[op.toBoard]!.push(op);
    } else if (op.op === 'update_qty') {
      totalCardChanges += Math.abs(op.newQty - op.oldQty);
      cardNames.add(op.name.toLowerCase());
      if (!boardOps[op.board]) boardOps[op.board] = [];
      boardOps[op.board]!.push(op);
    } else if (op.op === 'set_tag') {
      // Tags help identify scope
      const tag = op.tag.toLowerCase();
      if (tag === 'removal' || tag === 'interaction' || tag === 'counterspell') labels.add('scope:interaction');
      if (tag === 'wincon' || tag === 'combo') labels.add('scope:wincon');
      if (tag === 'ramp' || tag === 'mana_dork') labels.add('scope:ramp');
      if (tag === 'draw' || tag === 'card_advantage') labels.add('scope:draw');
      if (tag === 'land' || tag === 'manabase') labels.add('scope:manabase');
    }
  }

  // Board-based scope detection
  if (boardOps.commander && boardOps.commander.length > 0) labels.add('scope:commander');
  if (boardOps.sideboard && boardOps.sideboard.length > 0) labels.add('scope:sideboard');

  // Name-based heuristics for manabase (if tags aren't available)
  const landKeywords = ['land', 'plains', 'island', 'swamp', 'mountain', 'forest', 'fetch', 'shock', 'dual', 'mana'];
  const interactionKeywords = ['path', 'swords', 'bolt', 'counter', 'negate', 'remove', 'destroy', 'exile', 'bounce'];
  const rampKeywords = ['sol ring', 'mana crypt', 'signet', 'talisman', 'cultivate', 'rampant', 'birds of paradise', 'llanowar'];
  const winconKeywords = ['thassa\'s oracle', 'approach', 'lab man', 'thoracle', 'craterhoof', 'expropriate'];

  for (const name of cardNames) {
    if (landKeywords.some(k => name.includes(k))) labels.add('scope:manabase');
    if (interactionKeywords.some(k => name.includes(k))) labels.add('scope:interaction');
    if (rampKeywords.some(k => name.includes(k))) labels.add('scope:ramp');
    if (winconKeywords.some(k => name.includes(k))) labels.add('scope:wincon');
  }

  // Size labels
  if (totalCardChanges <= 5) labels.add('size:small');
  else if (totalCardChanges <= 15) labels.add('size:medium');
  else labels.add('size:large');

  return Array.from(labels);
}

/**
 * AutoLabelService — applies auto-generated labels to PRs.
 */
export class AutoLabelService {
  constructor(private db: D1Database) {}

  /**
   * Analyze the PR's diff and update its labels.
   * Preserves any manually-added labels.
   */
  async applyAutoLabels(prId: string, patch: DeckPatchOp[]): Promise<string[]> {
    const autoLabels = analyzeScopes(patch);

    // Fetch current labels
    const row = await this.db.prepare(
      'SELECT labels_json FROM deck_pull_requests WHERE id = ?'
    ).bind(prId).first<{ labels_json: string }>();

    const currentLabels: string[] = row ? JSON.parse(row.labels_json || '[]') : [];

    // Separate manual labels (not starting with 'scope:' or 'size:')
    const manualLabels = currentLabels.filter(
      l => !l.startsWith('scope:') && !l.startsWith('size:')
    );

    // Merge: manual labels + new auto labels (deduped)
    const merged = [...new Set([...manualLabels, ...autoLabels])];

    // Update PR
    await this.db.prepare(
      'UPDATE deck_pull_requests SET labels_json = ? WHERE id = ?'
    ).bind(JSON.stringify(merged), prId).run();

    return merged;
  }
}
