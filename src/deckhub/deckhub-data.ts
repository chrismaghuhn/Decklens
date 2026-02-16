/**
 * DeckHub Data Adapter
 *
 * Transforms API responses (repo-api.ts types) into the shapes
 * that deckhub-main.ts render functions expect.
 */

import type {
  Branch, Commit, PullRequest, Review, CheckRun,
  Issue, Release, DeckState, Collaborator, Repo, DeckPatchOp,
} from '../deckbuilder/repo-api.js';

// ───── Adapted Types (what render functions consume) ─────

export interface AdaptedBranch {
  name: string;
  id: string;
  isDefault: boolean;
  isProtected: boolean;
  headCommitId: string | null;
}

export interface AdaptedCommit {
  id: string;
  fullId: string;
  message: string;
  author: string;
  time: string;
  branch: string;
}

export interface AdaptedFile {
  name: string;
  icon: string;
  msg: string;
  time: string;
}

export interface AdaptedCard {
  qty: number;
  name: string;
  type: string;
  cmc: number;
  tags: string[];
  image?: string;
  price?: number;
  manaCost?: string;
  produced?: string[];
}

export interface AdaptedPR {
  number: number;
  title: string;
  status: 'open' | 'merged' | 'closed';
  author: string;
  branch: string;
  target: string;
  time: string;
  checksPass: boolean;
  approved: boolean;
  description: string;
  diffAdd: number;
  diffRemove: number;
  files?: { name: string; status: string }[];
  reviews: { user: string; initials: string; color: string; state: string; comment: string }[];
  checks: { name: string; pass: boolean; detail?: string }[];
}

export interface AdaptedIssue {
  number: number;
  title: string;
  labels: string[];
  author: string;
  time: string;
  comments: number;
  status: string;
}

export interface AdaptedRelease {
  tag: string;
  title: string;
  date: string;
  notes: { type: string; text: string }[];
  body: string;
  channel: string;
  verified: boolean;
  verifiedBy: string | null;
}

export interface AdaptedCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface AdaptedCollaborator {
  userId: string;
  initials: string;
  color: string;
  role: string;
  displayName: string;
}

// ───── Adapter Functions ─────

/**
 * Adapt Branch[] from API → AdaptedBranch[] for DeckHub render
 */
export function adaptBranches(branches: Branch[], defaultBranchId: string): AdaptedBranch[] {
  return branches.map(b => ({
    name: b.name,
    id: b.id,
    isDefault: b.id === defaultBranchId || b.name === 'main',
    isProtected: b.isProtected,
    headCommitId: b.headCommitId,
  }));
}

/**
 * Adapt Commit[] from API → AdaptedCommit[] for DeckHub render
 */
export function adaptCommits(commits: Commit[], branchName: string): AdaptedCommit[] {
  return commits.map(c => ({
    id: c.id.slice(0, 7),
    fullId: c.id,
    message: c.message,
    author: c.authorName,
    time: timeAgo(c.createdAt),
    branch: branchName,
  }));
}

/**
 * Adapt a DeckState → file tree + card table data
 */
export function adaptDeckState(state: DeckState): {
  files: AdaptedFile[];
  cards: Record<string, AdaptedCard[]>;
  totalCards: number;
  commanderCount: number;
  mainboardCount: number;
  sideboardCount: number;
} {
  const commander = (state.boards.commander || []).map(c => ({
    qty: c.qty, name: c.name, type: '', cmc: 0, tags: c.tags || [],
  }));
  const mainboard = (state.boards.mainboard || []).map(c => ({
    qty: c.qty, name: c.name, type: '', cmc: 0, tags: c.tags || [],
  }));
  const sideboard = (state.boards.sideboard || []).map(c => ({
    qty: c.qty, name: c.name, type: '', cmc: 0, tags: c.tags || [],
  }));

  const commanderCount = commander.reduce((s, c) => s + c.qty, 0);
  const mainboardCount = mainboard.reduce((s, c) => s + c.qty, 0);
  const sideboardCount = sideboard.reduce((s, c) => s + c.qty, 0);
  const totalCards = commanderCount + mainboardCount + sideboardCount;

  // Generate pseudo file tree from deck structure
  const files: AdaptedFile[] = [
    { name: 'deck.json', icon: '\u{1F4C4}', msg: state.meta?.name || 'Deck state', time: '' },
  ];
  if (sideboardCount > 0) {
    files.push({ name: 'sideboard.json', icon: '\u{1F4C4}', msg: `${sideboardCount} cards`, time: '' });
  }
  if (state.meta?.description) {
    files.push({ name: 'primer.md', icon: '\u{1F4D6}', msg: state.meta.description.slice(0, 60), time: '' });
  }

  return {
    files,
    cards: { commander, main: mainboard, lands: [], sideboard },
    totalCards,
    commanderCount,
    mainboardCount,
    sideboardCount,
  };
}

/**
 * Assemble a full PR view from PR + Reviews + Checks + Branches
 */
export function adaptPR(
  pr: PullRequest,
  reviews: Review[],
  checks: CheckRun[],
  branches: Branch[],
): AdaptedPR {
  const allChecksPass = checks.every(c => c.status === 'pass');
  const approved = reviews.some(r => r.state === 'APPROVED');

  return {
    number: pr.number,
    title: pr.title,
    status: pr.status,
    author: pr.authorName,
    branch: branches.find(b => b.id === pr.sourceBranchId)?.name || '?',
    target: branches.find(b => b.id === pr.targetBranchId)?.name || 'main',
    time: timeAgo(pr.createdAt),
    checksPass: allChecksPass,
    approved,
    description: pr.description || '',
    diffAdd: 0,
    diffRemove: 0,
    reviews: reviews.map(r => ({
      user: r.reviewerName,
      initials: initials(r.reviewerName),
      color: hashColor(r.reviewerId),
      state: r.state.toLowerCase(),
      comment: r.body,
    })),
    checks: checks.map(c => ({
      name: formatCheckName(c.checkName),
      pass: c.status === 'pass',
      detail: c.report?.summary || '',
    })),
  };
}

/**
 * Adapt PR list (without individual review/check fetch — lightweight)
 */
export function adaptPRList(prs: PullRequest[], branches: Branch[]): AdaptedPR[] {
  return prs.map(pr => ({
    number: pr.number,
    title: pr.title,
    status: pr.status,
    author: pr.authorName,
    branch: branches.find(b => b.id === pr.sourceBranchId)?.name || '?',
    target: branches.find(b => b.id === pr.targetBranchId)?.name || 'main',
    time: timeAgo(pr.createdAt),
    checksPass: false, // unknown without fetching checks
    approved: false,   // unknown without fetching reviews
    description: pr.description || '',
    diffAdd: 0,
    diffRemove: 0,
    reviews: [],
    checks: [],
  }));
}

/**
 * Adapt Issue[] → AdaptedIssue[]
 */
export function adaptIssues(issues: Issue[]): AdaptedIssue[] {
  return issues.map(i => ({
    number: i.number,
    title: i.title,
    labels: i.labels || [],
    author: '', // Issues don't store author in the API type
    time: timeAgo(i.createdAt),
    comments: 0, // Comment count not in Issue type
    status: i.status,
  }));
}

/**
 * Adapt Release[] → AdaptedRelease[]
 */
export function adaptReleases(releases: Release[]): AdaptedRelease[] {
  return releases.map(r => ({
    tag: r.tagName,
    title: r.title,
    date: formatDate(r.createdAt),
    body: r.body || '',
    notes: parseReleaseNotes(r.body || ''),
    channel: r.channel || 'stable',
    verified: r.verified || false,
    verifiedBy: r.verifiedBy || null,
  }));
}

/**
 * Adapt CheckRun[] → AdaptedCheck[] for sidebar display
 */
export function adaptChecks(checks: CheckRun[]): AdaptedCheck[] {
  return checks.map(c => ({
    name: formatCheckName(c.checkName),
    pass: c.status === 'pass',
    detail: c.report?.summary || statusLabel(c.status),
  }));
}

/**
 * Adapt Collaborator[] → display-ready collaborators
 */
export function adaptCollaborators(collabs: Collaborator[]): AdaptedCollaborator[] {
  return collabs.map(c => ({
    userId: c.userId,
    initials: c.userId.slice(0, 2).toUpperCase(),
    color: hashColor(c.userId),
    role: c.role,
    displayName: c.userId,
  }));
}

/**
 * Extract repo display info
 */
export function adaptRepoHeader(repo: Repo): {
  name: string;
  owner: string;
  format: string;
  visibility: string;
  description: string;
  defaultBranch: string;
} {
  return {
    name: repo.name,
    owner: repo.owner_id.slice(0, 8),
    format: repo.format || 'EDH',
    visibility: repo.visibility || 'Public',
    description: repo.description || '',
    defaultBranch: repo.default_branch,
  };
}

// ───── Helper Functions ─────

function timeAgo(iso: string): string {
  if (!iso) return '';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) return `${months} month${months > 1 ? 's' : ''} ago`;
  if (weeks > 0) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} min${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

function initials(name: string): string {
  return name.split(/[\s_-]+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
}

function hashColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  const colors = [
    'linear-gradient(135deg,#a78bfa,#5ea3f8)',
    'linear-gradient(135deg,#f59e42,#ef5350)',
    'linear-gradient(135deg,#3dd68c,#5ea3f8)',
    'linear-gradient(135deg,#c9a84c,#f59e42)',
    'linear-gradient(135deg,#ef5350,#a78bfa)',
    'linear-gradient(135deg,#5ea3f8,#3dd68c)',
  ];
  return colors[Math.abs(hash) % colors.length];
}

function formatCheckName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: 'Pending', running: 'Running', pass: 'Passed',
    fail: 'Failed', error: 'Error',
  };
  return labels[status] || status;
}

/**
 * Parse markdown-ish release body into structured notes
 */
function parseReleaseNotes(body: string): { type: string; text: string }[] {
  if (!body) return [];
  const lines = body.split('\n').filter(l => l.trim());
  return lines.map(line => {
    const trimmed = line.replace(/^[-*]\s*/, '').trim();
    // Detect type from prefix keywords
    if (/^(added?|new)\b/i.test(trimmed)) return { type: 'add', text: trimmed };
    if (/^(removed?|deleted?)\b/i.test(trimmed)) return { type: 'remove', text: trimmed };
    if (/^(changed?|swapped?|updated?)\b/i.test(trimmed)) return { type: 'change', text: trimmed };
    if (/^(fixed?|fix)\b/i.test(trimmed)) return { type: 'fix', text: trimmed };
    return { type: 'add', text: trimmed };
  });
}

/**
 * Generate PR title and description from deck patch operations
 */
export function generatePRTemplate(patch: DeckPatchOp[], template = ''): { title: string; desc: string } {
  const adds = patch.filter(p => p.op === 'add_card');
  const removes = patch.filter(p => p.op === 'remove_card');
  const moves = patch.filter(p => p.op === 'move_card');
  const updates = patch.filter(p => p.op === 'update_qty');

  // Generate semantic title
  let title = '';
  if (adds.length > 0 && removes.length === 0) {
    title = `feat: Add ${adds.length} card${adds.length > 1 ? 's' : ''}`;
  } else if (removes.length > 0 && adds.length === 0) {
    title = `refactor: Remove ${removes.length} card${removes.length > 1 ? 's' : ''}`;
  } else if (adds.length > 0 && removes.length > 0) {
    title = `chore: Update ${adds.length} adds, ${removes.length} removes`;
  } else if (moves.length > 0) {
    title = `chore: Move ${moves.length} card${moves.length > 1 ? 's' : ''}`;
  } else if (updates.length > 0) {
    title = `chore: Update quantities for ${updates.length} card${updates.length > 1 ? 's' : ''}`;
  } else {
    title = 'chore: Deck update';
  }

  // Generate description with changes list
  const changes: string[] = [];
  
  if (adds.length > 0) {
    changes.push('### Added\n' + adds.slice(0, 10).map(p => {
      const name = (p as any).name || 'Unknown';
      const qty = (p as any).qty || 1;
      const board = (p as any).board || 'mainboard';
      return `- +${qty}x ${name} (${board})`;
    }).join('\n') + (adds.length > 10 ? `\n- ... and ${adds.length - 10} more` : ''));
  }

  if (removes.length > 0) {
    changes.push('### Removed\n' + removes.slice(0, 10).map(p => {
      const name = (p as any).name || 'Unknown';
      const qty = (p as any).qty || 1;
      const board = (p as any).board || 'mainboard';
      return `- -${qty}x ${name} (${board})`;
    }).join('\n') + (removes.length > 10 ? `\n- ... and ${removes.length - 10} more` : ''));
  }

  if (moves.length > 0) {
    changes.push('### Moved\n' + moves.slice(0, 5).map(p => {
      const name = (p as any).name || 'Unknown';
      const from = (p as any).fromBoard || 'mainboard';
      const to = (p as any).toBoard || 'sideboard';
      return `- ${name}: ${from} → ${to}`;
    }).join('\n'));
  }

  // Apply custom template if provided
  let desc = changes.join('\n\n');
  if (template) {
    desc = template
      .replace('{{TITLE}}', title)
      .replace('{{CHANGES}}', desc)
      .replace('{{ADDS}}', String(adds.length))
      .replace('{{REMOVES}}', String(removes.length))
      .replace('{{MOVES}}', String(moves.length));
  }

  return { title, desc };
}
