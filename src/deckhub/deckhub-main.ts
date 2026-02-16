/**
 * DeckHub — Main Entry Point
 *
 * Initializes auth, routing, theme, tabs, branch dropdown,
 * and orchestrates data loading + rendering for the DeckHub repo view.
 */

import { initAuth, getCurrentUser, onAuthStateChange, getUser, loginWithGoogle, loginWithGitHub, logout } from '../shared/auth.js';
import {
  repoApi, branchApi, commitApi, prApi, reviewApi, checksApi,
  issueApi, releaseApi, settingsApi, collaboratorApi, commentApi,
  blameApi, goldenApi, workflowApi, guidelinesApi,
  webhookApi, watchApi, bisectApi, scryfallApi,
  type Repo, type Branch, type Commit, type PullRequest, type PRComment, type DeckPatchOp, type Collaborator,
  type BlameEntry, type GoldenDrift, type SuggestedReviewer, type Issue,
  type PRStackEntry, type PRStackResult, type ReleaseChannel, type BisectSession,
  type ScryfallSearchCard, type DeckState,
} from '../deckbuilder/repo-api.js';
import {
  adaptBranches, adaptCommits, adaptPRList, adaptPR, adaptIssues,
  adaptReleases, adaptChecks, adaptDeckState, adaptRepoHeader,
  adaptCollaborators, generatePRTemplate,
  type AdaptedBranch, type AdaptedPR, type AdaptedIssue, type AdaptedRelease,
  type AdaptedCheck, type AdaptedCommit, type AdaptedCard, type AdaptedFile,
} from './deckhub-data.js';

// ───── Types ─────

interface DemoBranch {
  name: string;
  isDefault: boolean;
}

interface DemoCommit {
  id: string;
  message: string;
  author: string;
  time: string;
  branch: string;
}

interface DemoPR {
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
  reviews?: { user: string; initials: string; color: string; state: string; comment: string }[];
  checks?: { name: string; pass: boolean; detail?: string }[];
}

interface DemoIssue {
  number: number;
  title: string;
  labels: string[];
  author: string;
  time: string;
  comments: number;
}

interface DemoRelease {
  tag: string;
  title: string;
  date: string;
  notes: { type: string; text: string }[];
}

interface DemoFile {
  name: string;
  icon: string;
  msg: string;
  time: string;
}

interface DemoCard {
  qty: number;
  name: string;
  type: string;
  cmc: number;
  tags: string[];
}

interface DemoCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

// ───── Demo Data ─────
// This data will be replaced by API calls in Commit 2

const BRANCHES: DemoBranch[] = [
  { name: 'main', isDefault: true },
  { name: 'meta-tune', isDefault: false },
  { name: 'budget-variant', isDefault: false },
];

const COMMITS: DemoCommit[] = [
  { id: 'a3f8c01', message: 'Tune mana base for consistency', author: 'arcane_user', time: '2 hours ago', branch: 'main' },
  { id: 'b7d4e22', message: 'Add Rhystic Study to draw package', author: 'meta_drafter', time: '5 hours ago', branch: 'meta-tune' },
  { id: 'c1a9f33', message: 'Replace Mana Drain with Arcane Denial (budget)', author: 'budget_brewer', time: '1 day ago', branch: 'budget-variant' },
  { id: 'd5e2b44', message: 'Initial deck import from Arena export', author: 'arcane_user', time: '3 days ago', branch: 'main' },
];

const PRS: DemoPR[] = [
  {
    number: 3, title: 'Tune sideboard for current meta', status: 'open',
    author: 'meta_drafter', branch: 'meta-tune', target: 'main',
    time: '2 hours ago', checksPass: false, approved: false,
    description: 'Swapping some underperforming sideboard cards for better answers to the current Turbo Naus / Tymna meta.',
    diffAdd: 4, diffRemove: 3,
    files: [
      { name: 'deck.json', status: 'modified' },
      { name: 'sideboard.json', status: 'modified' },
      { name: 'matchup-plans.md', status: 'modified' },
    ],
    reviews: [
      { user: 'arcane_user', initials: 'CG', color: 'linear-gradient(135deg,#a78bfa,#5ea3f8)', state: 'changes_requested', comment: "Cutting Dovin's Veto seems risky in a counter-heavy meta" },
    ],
    checks: [
      { name: 'Format Validation', pass: true },
      { name: 'Regression Tests', pass: false, detail: 'Keepable hand % dropped from 78% to 71%' },
      { name: 'Tag Quotas', pass: true },
    ],
  },
  {
    number: 2, title: 'Optimize mana rock package', status: 'open',
    author: 'budget_brewer', branch: 'budget-variant', target: 'main',
    time: '1 day ago', checksPass: true, approved: true,
    description: 'Replacing Chrome Mox and Mox Diamond with Fellwar Stone and Talisman of Progress. Saves $180 while maintaining curve.',
    diffAdd: 2, diffRemove: 2,
    files: [
      { name: 'deck.json', status: 'modified' },
    ],
    reviews: [
      { user: 'arcane_user', initials: 'CG', color: 'linear-gradient(135deg,#a78bfa,#5ea3f8)', state: 'approved', comment: 'Looks good, curve math checks out' },
      { user: 'meta_drafter', initials: 'MD', color: 'linear-gradient(135deg,#f59e42,#ef5350)', state: 'approved', comment: 'LGTM' },
    ],
    checks: [
      { name: 'Format Validation', pass: true },
      { name: 'Regression Tests', pass: true },
      { name: 'Tag Quotas', pass: true },
    ],
  },
  {
    number: 1, title: 'Add initial stax package', status: 'merged',
    author: 'arcane_user', branch: 'stax-additions', target: 'main',
    time: '3 days ago', checksPass: true, approved: true,
    description: 'Added Winter Orb, Static Orb, and Stasis along with untap engines.',
    diffAdd: 6, diffRemove: 0,
    files: [
      { name: 'deck.json', status: 'modified' },
      { name: 'primer.md', status: 'modified' },
    ],
    reviews: [
      { user: 'meta_drafter', initials: 'MD', color: 'linear-gradient(135deg,#f59e42,#ef5350)', state: 'approved', comment: 'Perfect additions' },
    ],
    checks: [
      { name: 'Format Validation', pass: true },
      { name: 'Regression Tests', pass: true },
    ],
  },
];

const ISSUES: DemoIssue[] = [
  { number: 6, title: 'Mana base feels inconsistent in T1-T2', labels: ['bug'], author: 'arcane_user', time: '1 hour ago', comments: 3 },
  { number: 5, title: 'Consider Mystic Remora over Rhystic Study', labels: ['enhancement', 'meta'], author: 'meta_drafter', time: '4 hours ago', comments: 1 },
  { number: 4, title: 'Add budget alternatives section to primer', labels: ['enhancement', 'budget'], author: 'budget_brewer', time: '1 day ago', comments: 0 },
  { number: 3, title: 'Rule 0 discussion: Stasis legality in playgroup', labels: ['rules', 'question'], author: 'arcane_user', time: '2 days ago', comments: 7 },
  { number: 2, title: 'Sideboard plan vs Turbo Naus is incomplete', labels: ['bug', 'meta'], author: 'meta_drafter', time: '3 days ago', comments: 2 },
  { number: 1, title: 'Track price trends for expensive staples', labels: ['enhancement'], author: 'budget_brewer', time: '4 days ago', comments: 0 },
];

const RELEASES: DemoRelease[] = [
  {
    tag: 'v1.1', title: 'Meta Adjustment — Feb 2026', date: 'Feb 10, 2026',
    notes: [
      { type: 'add', text: 'Added <strong>Rhystic Study</strong> and <strong>Mystic Remora</strong> to draw suite' },
      { type: 'add', text: 'Added <strong>Stasis</strong> + <strong>Teferi, Time Raveler</strong> lock package' },
      { type: 'remove', text: 'Removed <strong>Fact or Fiction</strong> (too slow in current meta)' },
      { type: 'change', text: 'Swapped <strong>Mana Drain</strong> &rarr; <strong>Counterspell</strong> (budget optimization)' },
      { type: 'fix', text: 'Fixed mana base: added 2 more islands for consistency' },
    ],
  },
  {
    tag: 'v1.0', title: 'Initial Release — Azorius Control', date: 'Jan 28, 2026',
    notes: [
      { type: 'add', text: 'Initial 100-card EDH list with <strong>Grand Arbiter Augustin IV</strong>' },
      { type: 'add', text: 'Primer with key combo lines and matchup notes' },
      { type: 'add', text: 'Sideboard guide for common matchups' },
    ],
  },
];

const FILES: DemoFile[] = [
  { name: 'deck.json', icon: '\u{1F4C4}', msg: 'Tune mana base for consistency', time: '2h ago' },
  { name: 'sideboard.json', icon: '\u{1F4C4}', msg: 'Update sideboard for meta', time: '5h ago' },
  { name: 'primer.md', icon: '\u{1F4D6}', msg: 'Add stax package primer section', time: '3d ago' },
  { name: 'matchup-plans.md', icon: '\u{1F4DD}', msg: 'Initial deck import', time: '3d ago' },
  { name: 'tests.yml', icon: '\u{2699}\u{FE0F}', msg: 'Configure regression checks', time: '3d ago' },
];

const CARDS: Record<string, DemoCard[]> = {
  commander: [
    { qty: 1, name: 'Grand Arbiter Augustin IV', type: 'Creature', cmc: 4, tags: ['engine'] },
  ],
  main: [
    { qty: 1, name: 'Counterspell', type: 'Instant', cmc: 2, tags: ['protection'] },
    { qty: 1, name: 'Swords to Plowshares', type: 'Instant', cmc: 1, tags: ['removal'] },
    { qty: 1, name: 'Path to Exile', type: 'Instant', cmc: 1, tags: ['removal'] },
    { qty: 1, name: 'Rhystic Study', type: 'Enchantment', cmc: 3, tags: ['draw'] },
    { qty: 1, name: 'Mystic Remora', type: 'Enchantment', cmc: 1, tags: ['draw'] },
    { qty: 1, name: 'Sol Ring', type: 'Artifact', cmc: 1, tags: ['ramp'] },
    { qty: 1, name: 'Arcane Signet', type: 'Artifact', cmc: 2, tags: ['ramp'] },
    { qty: 1, name: 'Azorius Signet', type: 'Artifact', cmc: 2, tags: ['ramp'] },
    { qty: 1, name: 'Talisman of Progress', type: 'Artifact', cmc: 2, tags: ['ramp'] },
    { qty: 1, name: 'Fellwar Stone', type: 'Artifact', cmc: 2, tags: ['ramp'] },
    { qty: 1, name: 'Isochron Scepter', type: 'Artifact', cmc: 2, tags: ['wincon', 'engine'] },
    { qty: 1, name: 'Dramatic Reversal', type: 'Instant', cmc: 2, tags: ['wincon'] },
    { qty: 1, name: 'Stasis', type: 'Enchantment', cmc: 2, tags: ['engine'] },
    { qty: 1, name: 'Teferi, Time Raveler', type: 'Planeswalker', cmc: 3, tags: ['engine'] },
    { qty: 1, name: 'Winter Orb', type: 'Artifact', cmc: 2, tags: ['engine'] },
    { qty: 1, name: 'Static Orb', type: 'Artifact', cmc: 3, tags: ['engine'] },
    { qty: 1, name: 'Approach of the Second Sun', type: 'Sorcery', cmc: 7, tags: ['wincon'] },
    { qty: 1, name: 'Dig Through Time', type: 'Instant', cmc: 8, tags: ['draw'] },
    { qty: 1, name: 'Wrath of God', type: 'Sorcery', cmc: 4, tags: ['removal'] },
    { qty: 1, name: 'Supreme Verdict', type: 'Sorcery', cmc: 4, tags: ['removal'] },
    { qty: 1, name: 'Walking Ballista', type: 'Artifact Creature', cmc: 0, tags: ['wincon'] },
    { qty: 1, name: 'Cyclonic Rift', type: 'Instant', cmc: 2, tags: ['removal'] },
    { qty: 1, name: 'Fierce Guardianship', type: 'Instant', cmc: 3, tags: ['protection'] },
  ],
  lands: [
    { qty: 1, name: 'Command Tower', type: 'Land', cmc: 0, tags: ['land'] },
    { qty: 1, name: 'Hallowed Fountain', type: 'Land', cmc: 0, tags: ['land'] },
  ],
};

const CURVE_DATA = [3, 14, 22, 12, 8, 3, 1, 2];

const CHECKS: DemoCheck[] = [
  { name: 'Format Validation (EDH)', pass: true },
  { name: 'Singleton Check', pass: true },
  { name: 'Color Identity', pass: true },
  { name: 'Regression Tests', pass: false, detail: 'Hand % regressed' },
  { name: 'Tag Quotas', pass: true },
];

const INSIGHTS_CHECKS: DemoCheck[] = [
  { name: 'Format Validation', pass: true, detail: 'EDH \u2014 100 cards, singleton, color OK' },
  { name: 'Singleton Check', pass: true, detail: 'No duplicates outside basic lands' },
  { name: 'Color Identity', pass: true, detail: 'W/U \u2014 matches commander' },
  { name: 'Regression Tests', pass: false, detail: 'Keepable hand % dropped: 78% \u2192 71%' },
  { name: 'Tag Quotas', pass: true, detail: 'Ramp: 10 \u2713 Draw: 8 \u2713 Removal: 7 \u2713' },
  { name: 'Mana Base Analysis', pass: true, detail: '36 sources, 22W / 26U pips covered' },
];

const WARNINGS = [
  { icon: '\u26A0\uFE0F', text: 'Mana base has only 36 lands \u2014 consider 37-38 for this curve' },
  { icon: '\u26A0\uFE0F', text: 'Sideboard is empty \u2014 no answers for specific matchups' },
  { icon: '\u{1F4A1}', text: 'Low creature count (4) \u2014 vulnerable to edict effects' },
];

const REGRESSIONS = [
  { label: 'Keepable Hand %', before: '78%', after: '71%', delta: '-7%' },
  { label: 'Average CMC', before: '2.31', after: '2.47', delta: '+0.16' },
];

// ───── DOM Helpers ─────

function $<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function $$<T extends HTMLElement = HTMLElement>(sel: string): NodeListOf<T> {
  return document.querySelectorAll<T>(sel);
}

// ───── State ─────

let currentBranch = 'main';
let currentTab = 'code';
let repoId: string | null = null;
let isLiveMode = false;

// Live data (populated by loadRepo() when ?repo= is present)
let liveBranches: AdaptedBranch[] = [];
let liveCommits: AdaptedCommit[] = [];
let rawCommitData: Commit[] = [];
let livePRs: AdaptedPR[] = [];
let liveIssues: AdaptedIssue[] = [];
let liveReleases: AdaptedRelease[] = [];
let liveChecks: AdaptedCheck[] = [];
let rawBranches: Branch[] = [];
let rawPRs: PullRequest[] = [];
let liveCards: Record<string, AdaptedCard[]> = {};
let liveFiles: AdaptedFile[] = [];
let liveTotalCards = 0;
let liveCommanderCount = 0;
let liveMainboardCount = 0;
let liveSideboardCount = 0;
let liveDeckMeta: { name: string; description: string; format: string } | null = null;
let liveSettings: Record<string, unknown> | null = null;
let liveCollabs: Collaborator[] = [];
let isEnriching = false;
let triedEnrichment = new Set<string>();
let goldenDrift: GoldenDrift | null = null;
let releaseChannelFilter: ReleaseChannel | 'all' = 'all';
let cardFilterStr = '';
let currentSort: 'cmc' | 'price' | 'name' | 'type' = 'cmc';
let currentGroup: 'board' | 'type' | 'tag' | 'cmc' = 'board';

// ───── Bulk Actions State ─────
let selectedPRs: Set<number> = new Set();
let selectedIssues: Set<number> = new Set();
let bulkActionMode: 'pr' | 'issue' | null = null;

// ───── Toast Utility ─────

function showToast(message: string, type: 'success' | 'error' | 'info' = 'info', duration = 3500): void {
  const toast = document.createElement('div');
  toast.className = `hub-toast${type === 'error' ? ' hub-toast--error' : type === 'success' ? ' hub-toast--success' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hub-toast--exiting');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ───── Live Data Loading ─────

async function loadRepo(id: string): Promise<void> {
  repoId = id;
  isLiveMode = true;

  // Show loading state
  showLoading();

  try {
    // Fetch repo info
    const repo = await repoApi.get(id);
    const currentUser = await getCurrentUser();
    const header = adaptRepoHeader(repo);

    // Update header UI
    const ownerEl = $('#repoOwner');
    const nameEl = $('#repoName');
    const breadOwner = $('#breadcrumbOwner');
    const breadRepo = $('#breadcrumbRepo');
    if (ownerEl) ownerEl.textContent = header.owner;
    if (nameEl) nameEl.textContent = header.name;
    if (breadOwner) breadOwner.textContent = header.owner;
    if (breadRepo) breadRepo.textContent = header.name;

    // Update badges
    const badgesEl = $('#repoBadges');
    if (badgesEl) {
      const isOwner = currentUser && (currentUser.id === repo.owner_id);
      
      let visibilityHTML = `<span class="hub-badge">${header.visibility}</span>`;
      
      if (isOwner) {
        const icon = header.visibility === 'private' ? '🔒' : '🌐';
        const title = header.visibility === 'private' ? 'Private (Click to make Public)' : 'Public (Click to make Private)';
        visibilityHTML = `<button id="btnToggleVisibility" class="hub-badge hub-badge--interactive" title="${title}" style="cursor:pointer;border:none;font-family:inherit;background:var(--hub-raised);color:var(--hub-text-main);display:inline-flex;align-items:center;gap:4px">
          ${icon} ${header.visibility}
        </button>`;
      }

      badgesEl.innerHTML = `
        <span class="hub-badge hub-badge--format">${header.format}</span>
        ${visibilityHTML}
      `;
      
      if (isOwner) {
         $('#btnToggleVisibility')?.addEventListener('click', () => toggleVisibility(id, header.visibility as 'public' | 'private'));
      }
    }

    // Parallel fetch: branches, PRs, issues, releases
    const [branchList, openPRs, closedPRs, issues, releases] = await Promise.all([
      branchApi.list(id).catch(() => [] as Branch[]),
      prApi.list(id, 'open').catch(() => [] as PullRequest[]),
      prApi.list(id, 'merged').catch(() => [] as PullRequest[]),
      issueApi.list(id).catch(() => []),
      releaseApi.list(id).catch(() => []),
    ]);

    rawBranches = branchList;
    rawPRs = [...openPRs, ...closedPRs];

    // Adapt data
    liveBranches = adaptBranches(branchList, repo.default_branch);
    livePRs = adaptPRList(rawPRs, branchList);
    liveIssues = adaptIssues(issues);
    liveReleases = adaptReleases(releases);

    // Find default branch and load its commits
    const defaultBranch = liveBranches.find(b => b.isDefault) || liveBranches[0];
    if (defaultBranch) {
      currentBranch = defaultBranch.name;
      const commits = await commitApi.list(id, defaultBranch.id, 10).catch(() => []);
      rawCommitData = commits;
      liveCommits = adaptCommits(commits, defaultBranch.name);

      // Load DeckState from the latest commit
      if (commits.length > 0) {
        try {
          const deckState = await commitApi.getState(id, commits[0].id);
          const adapted = adaptDeckState(deckState);
          liveCards = adapted.cards;
          liveFiles = adapted.files;
          liveTotalCards = adapted.totalCards;
          liveCommanderCount = adapted.commanderCount;
          liveMainboardCount = adapted.mainboardCount;
          liveSideboardCount = adapted.sideboardCount;
          liveDeckMeta = deckState.meta || null;

          // FIX: Database description should take precedence over Git history for the README/Primer
          // This ensures that when we save the README (which updates the DB), we see the new version
          // on reload, even if a new commit hasn't been generated yet.
          if (liveDeckMeta && repo.description) {
            liveDeckMeta.description = repo.description;
          } else if (!liveDeckMeta && repo.description) {
             // If git has no meta but DB has description, use it
             liveDeckMeta = { name: repo.name, description: repo.description, format: repo.format };
          }


          // Start auto-enrichment (background)
          enrichDeckCards().catch(err => console.error('[DeckHub] Enrichment failed:', err));
        } catch (err) {
          console.warn('[DeckHub] Could not load deck state:', err);
        }
      }
    }

    // Load collaborators + settings
    let collabs: Collaborator[] = [];
    try {
      collabs = await collaboratorApi.list(id);
    } catch { /* ignore */ }
    liveCollabs = collabs;

    try {
      liveSettings = await settingsApi.get(id);
    } catch { liveSettings = null; }
    populateSettingsForm();

    // Load golden state drift
    try {
      goldenDrift = await goldenApi.get(id);
    } catch { goldenDrift = null; }

    // Update tab counts
    const countPRs = $('#countPRs');
    const countIssues = $('#countIssues');
    const countReleases = $('#countReleases');
    if (countPRs) countPRs.textContent = String(openPRs.length);
    if (countIssues) countIssues.textContent = String(issues.filter(i => i.status === 'open').length);
    if (countReleases) countReleases.textContent = String(releases.length);

    // Render live data
    renderLiveData(collabs);

    console.log('[DeckHub] Loaded repo:', header.name, '| Branches:', branchList.length, '| PRs:', rawPRs.length, '| Issues:', issues.length, '| Cards:', liveTotalCards);

  } catch (err) {
    console.error('[DeckHub] Failed to load repo:', err);
    showError(err instanceof Error ? err.message : 'Failed to load repository');
  }
}

function showLoading(): void {
  // File tree skeleton
  const fileTree = document.getElementById('fileTreeBody');
  if (fileTree) fileTree.innerHTML = Array.from({ length: 5 }, () => '<div class="hub-skeleton hub-skeleton-row"></div>').join('');

  // Card table skeleton
  const cardTable = document.getElementById('cardTableBody');
  if (cardTable) cardTable.innerHTML = Array.from({ length: 3 }, () => '<div class="hub-skeleton hub-skeleton-card"></div>').join('');

  // PR list skeleton
  const prList = document.getElementById('prListBody');
  if (prList) prList.innerHTML = Array.from({ length: 4 }, () => '<div class="hub-skeleton hub-skeleton-row"></div>').join('');

  // Issue list skeleton
  const issueList = document.getElementById('issueListBody');
  if (issueList) issueList.innerHTML = Array.from({ length: 4 }, () => '<div class="hub-skeleton hub-skeleton-row"></div>').join('');

  // Release list skeleton
  const releaseList = document.getElementById('releaseListBody');
  if (releaseList) releaseList.innerHTML = Array.from({ length: 2 }, () => '<div class="hub-skeleton hub-skeleton-card"></div>').join('');

  // Primer skeleton
  const primerEl = $('#primerBody');
  if (primerEl) primerEl.innerHTML = '<div class="hub-skeleton hub-skeleton-block"></div><div class="hub-skeleton hub-skeleton-row" style="width:60%"></div>';

  // Sidebar skeletons
  const checksEl = $('#checksBody');
  if (checksEl) checksEl.innerHTML = Array.from({ length: 3 }, () => '<div class="hub-skeleton hub-skeleton-row" style="height:24px"></div>').join('');

  const contribEl = $('#contributorsBody');
  if (contribEl) contribEl.innerHTML = '<div class="hub-skeleton" style="width:80px;height:28px;border-radius:14px"></div>';
}

function showError(message: string): void {
  const el = $('#fileTreeBody');
  if (el) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state__icon">\u26A0\uFE0F</div>
      <div class="empty-state__text">${message}</div>
      <button class="hub-btn hub-btn--sm" style="margin-top:12px" onclick="location.reload()">\u{1F504} Retry</button>
    </div>`;
  }
}

// ───── Live Data Orchestration ─────

/**
 * Automatically fetch missing card data (types, CMC, tags) from Scryfall
 * and apply auto-labeling heuristics.
 */
async function enrichDeckCards(): Promise<void> {
  if (isEnriching) return;

  const allCards = [
    ...(liveCards.commander || []),
    ...(liveCards.main || []),
    ...(liveCards.sideboard || []),
  ];

  // Only enrich cards that are missing basic info (type)
  // And haven't been tried in this session (to avoid infinite loops on 404s)
  const namesToResolve = [...new Set(allCards
    .filter(c => (!c.type || c.type === '—') && !triedEnrichment.has(c.name.toLowerCase()))
    .map(c => c.name))];

  if (namesToResolve.length === 0) {
    console.log('[DeckHub] All cards already enriched or tried.');
    return;
  }

  isEnriching = true;
  console.log(`[DeckHub] Enriching ${namesToResolve.length} cards:`, namesToResolve);
  
  // Show loading indicator
  const badgeContainer = $('#repoBadges');
  let loadingBadge: HTMLElement | null = null;
  if (badgeContainer) {
      loadingBadge = document.createElement('span');
      loadingBadge.className = 'hub-badge hub-badge--neutral';
      loadingBadge.innerHTML = '\u23F3 Syncing prices...';
      loadingBadge.style.animation = 'pulse 1.5s infinite';
      badgeContainer.appendChild(loadingBadge);
  }

  try {
    const response = await scryfallApi.resolve(namesToResolve);
    console.log(`[DeckHub] Scryfall resolved ${response.resolved.length} cards, missing ${response.missing.length}`);

    // Mark all attempted names as tried
    namesToResolve.forEach(n => triedEnrichment.add(n.toLowerCase()));

    const map = new Map<string, ScryfallSearchCard>();
    response.resolved.forEach(r => map.set(r.query.toLowerCase(), r.card));

    // Update liveCards with enriched data
    let enrichedCount = 0;
    for (const board of Object.keys(liveCards)) {
      liveCards[board] = (liveCards[board] || []).map(c => {
        const scry = map.get(c.name.toLowerCase());
        if (!scry) return c;

        enrichedCount++;
        const autoTags = autoTagCard(scry);
        const combinedTags = [...new Set([...c.tags, ...autoTags])];

        return {
          ...c,
          type: scry.type_line,
          cmc: scry.cmc,
          tags: combinedTags,
          image: scry.image_uris?.normal || scry.image_uris?.small,
          price: parseFloat(scry.prices?.usd || scry.prices?.eur || '0'),
          manaCost: scry.mana_cost,
          produced: scry.produced_mana,
        };
      });
    }

    console.log(`[DeckHub] Successfully enriched ${enrichedCount} card instances.`);

    // Refresh UI
    renderLiveData(liveCollabs);
  } catch (err) {
    console.error('[DeckHub] Enrichment error:', err);
  } finally {
    isEnriching = false;
    if (loadingBadge) loadingBadge.remove();
  }
}

/**
 * Basic heuristic for auto-labeling cards based on Scryfall data
 */
function autoTagCard(scry: ScryfallSearchCard): string[] {
  const tags: Set<string> = new Set();
  const text = (scry.oracle_text || '').toLowerCase();
  const type = scry.type_line.toLowerCase();
  const keywords = (scry.keywords || []).map(k => k.toLowerCase());

  // 1. Core Categories
  // Draw
  if (text.includes('draw a card') || text.includes('draw cards') || text.includes('draw two cards') || text.includes('draw three cards')) {
    tags.add('Draw');
  }

  // Ramp
  if (text.includes('search your library for a land') || text.includes('put a land card from your hand onto the battlefield') || text.includes('search your library for a basic land')) {
    tags.add('Ramp');
  } else if (type.includes('artifact') && text.includes('add ') && text.includes('mana')) {
    tags.add('Ramp'); // Mana rocks
  } else if (type.includes('creature') && text.includes('add ') && text.includes('mana')) {
    tags.add('Ramp'); // Mana dorks
  }

  // Removal (Targeted)
  if (text.includes('destroy target') || text.includes('exile target') || (text.includes('return target') && text.includes('to its owner\'s hand'))) {
    tags.add('Removal');
  } else if (text.includes('deals ') && (text.includes('damage to target creature') || text.includes('damage to any target'))) {
    tags.add('Removal');
  }

  // Board Wipes
  if (text.includes('destroy all') || text.includes('exile all') || text.includes('return all') && text.includes('to their owners\' hands')) {
    tags.add('Wipe');
  }

  // Counterspells
  if (text.includes('counter target spell')) {
    tags.add('Counter');
  }

  // Tutors
  if (text.includes('search your library') && !tags.has('Ramp')) {
    tags.add('Tutor');
  }

  // 2. Utility & Protection
  // Protection
  if (keywords.includes('hexproof') || keywords.includes('indestructible') || text.includes('hexproof') || text.includes('indestructible') || text.includes('protection from')) {
    tags.add('Protection');
  }

  // Tokens
  if (text.includes('create ') && text.includes('token')) {
    tags.add('Token');
  }

  // Graveyard interaction
  if (text.includes('from your graveyard') || text.includes('return target card from your graveyard') || text.includes('exile target card from a graveyard')) {
    tags.add('Graveyard');
  }

  // Recursion
  if (text.includes('return target') && text.includes('graveyard') && text.includes('to your hand')) {
    tags.add('Recursion');
  }

  // 3. Type-based Tags
  if (type.includes('land')) tags.add('Land');
  if (type.includes('artifact')) tags.add('Artifact');
  if (type.includes('enchantment')) tags.add('Enchantment');
  if (type.includes('planeswalker')) tags.add('Planeswalker');
  if (type.includes('legendary creature')) tags.add('Legend');

  // 4. Keyword-based (if not already covered)
  if (keywords.includes('flying')) tags.add('Flying');
  if (keywords.includes('haste')) tags.add('Haste');

  return Array.from(tags);
}

function renderLiveData(collabs: { userId: string; role: string }[] = []): void {
  renderLiveFileTree();
  renderLiveCardTable();
  renderLiveCurveBar();
  renderLiveChecks();
  renderLivePRList();
  renderLiveIssues();
  renderLiveReleases();
  renderLiveStats();
  renderLivePrimer();
  renderLiveContributors(collabs);
  renderLiveQuickLinks();
  renderLiveInsights();
  renderLiveCollaboratorTable();
}

function renderLiveFileTree(): void {
  const el = $('#fileTreeBody');
  if (!el) return;

  // Use files from DeckState if available, otherwise fallback to commit-based
  const files = liveFiles.length ? liveFiles.map((f, i) => ({
    ...f,
    time: i === 0 ? (liveCommits[0]?.time || '') : '',
    msg: i === 0 ? (liveCommits[0]?.message || f.msg) : f.msg,
  })) : (liveCommits.length ? [
    { name: 'deck.json', icon: '\u{1F4C4}', msg: liveCommits[0]?.message || '', time: liveCommits[0]?.time || '' },
  ] : []);

  if (files.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state__text">No files yet — commit your deck to get started</div></div>`;
    return;
  }

  el.innerHTML = files.map(f =>
    `<div class="file-tree__row">
      <span class="file-tree__row-icon">${f.icon}</span>
      <span class="file-tree__row-name">${f.name}</span>
      <span class="file-tree__row-msg">${f.msg}</span>
      <span class="file-tree__row-time">${f.time}</span>
    </div>`
  ).join('');

  const countEl = $('#fileCount');
  if (countEl) countEl.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
}

function renderLiveCardTable(): void {
  const el = $('#cardTableBody');
  if (!el) return;

  const hasCards = Object.values(liveCards).some(arr => arr.length > 0);

  if (!hasCards) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state__icon">\u{1F0CF}</div>
      <div class="empty-state__text">No cards yet — commit a deck from the editor</div>
    </div>`;
    return;
  }

  // Sorting Toolbar
  const toolbarHTML = `
    <div style="display:flex;gap:12px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <div class="hub-input-group" style="width:auto">
        <span class="hub-input-icon">\u{1F50D}</span>
        <input type="text" id="cardFilterInput" class="hub-input" placeholder="Filter cards..." value="${escapeHtml(cardFilterStr)}" style="max-width:200px">
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--hub-text-muted)">Group by:</span>
        <select id="groupSelect" class="hub-select" style="padding:4px 8px;font-size:12px">
          <option value="board" ${currentGroup === 'board' ? 'selected' : ''}>Board</option>
          <option value="type" ${currentGroup === 'type' ? 'selected' : ''}>Type</option>
          <option value="tag" ${currentGroup === 'tag' ? 'selected' : ''}>Tag</option>
          <option value="cmc" ${currentGroup === 'cmc' ? 'selected' : ''}>CMC</option>
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--hub-text-muted)">Sort by:</span>
        <select id="sortSelect" class="hub-select" style="padding:4px 8px;font-size:12px">
          <option value="cmc" ${currentSort === 'cmc' ? 'selected' : ''}>CMC</option>
          <option value="price" ${currentSort === 'price' ? 'selected' : ''}>Price</option>
          <option value="name" ${currentSort === 'name' ? 'selected' : ''}>Name</option>
          <option value="type" ${currentSort === 'type' ? 'selected' : ''}>Type</option>
        </select>
      </div>
    </div>
  `;

  // Filter
  const filter = cardFilterStr.toLowerCase().trim();
  const allCards = [
    ...(liveCards.commander || []).map(c => ({...c, board: 'Commander'})),
    ...(liveCards.main || []).map(c => ({...c, board: 'Mainboard'})),
    ...(liveCards.sideboard || []).map(c => ({...c, board: 'Sideboard'})),
    ...(liveCards.maybeboard || []).map(c => ({...c, board: 'Maybeboard'})),
  ].filter(c => !filter || 
      c.name.toLowerCase().includes(filter) || 
      (c.type || '').toLowerCase().includes(filter) || 
      c.tags.some(t => t.toLowerCase().includes(filter))
  );

  // Grouping Logic
  let sections: Record<string, AdaptedCard[]> = {};

  if (currentGroup === 'board') {
    // Default board grouping (preserve order: Commander -> Main -> Side -> Maybe)
    if (liveCards.commander?.length) sections['Commander'] = allCards.filter(c => c.board === 'Commander');
    if (liveCards.main?.length) sections['Mainboard'] = allCards.filter(c => c.board === 'Mainboard');
    if (liveCards.sideboard?.length) sections['Sideboard'] = allCards.filter(c => c.board === 'Sideboard');
    if (liveCards.maybeboard?.length) sections['Maybeboard'] = allCards.filter(c => c.board === 'Maybeboard');
  } else if (currentGroup === 'type') {
    allCards.forEach(c => {
      const type = (c.type || 'Other').split('—')[0].trim(); // Simple type (Creature, Instant...)
      if (!sections[type]) sections[type] = [];
      sections[type].push(c);
    });
  } else if (currentGroup === 'cmc') {
    allCards.forEach(c => {
      const cmc = typeof c.cmc === 'number' ? c.cmc : '?';
      const key = `CMC ${cmc}`;
      if (!sections[key]) sections[key] = [];
      sections[key].push(c);
    });
  } else if (currentGroup === 'tag') {
    const untagged: AdaptedCard[] = [];
    allCards.forEach(c => {
      if (c.tags.length === 0) untagged.push(c);
      c.tags.forEach(t => {
        if (!sections[t]) sections[t] = [];
        sections[t].push(c);
      });
    });
    if (untagged.length) sections['Untagged'] = untagged;
  }

  // Helper for sorting
  const sortFn = (a: AdaptedCard, b: AdaptedCard) => {
    switch (currentSort) {
      case 'cmc': return (a.cmc || 0) - (b.cmc || 0) || a.name.localeCompare(b.name);
      case 'price': return (b.price || 0) - (a.price || 0) || a.name.localeCompare(b.name);
      case 'name': return a.name.localeCompare(b.name);
      case 'type': return (a.type || '').localeCompare(b.type || '');
      default: return 0;
    }
  };

  // Render Sections
  let tableHTML = '';
  // Sort section keys explicitly if possible, otherwise alphabetical
  const sectionKeys = Object.keys(sections).sort((a, b) => {
     if (currentGroup === 'cmc') {
         const va = parseInt(a.replace('CMC ', '')) || 99;
         const vb = parseInt(b.replace('CMC ', '')) || 99;
         return va - vb;
     }
     if (currentGroup === 'board') return 0; 
     return a.localeCompare(b);
  });
  
  // Custom board order
  if (currentGroup === 'board') {
      const order = ['Commander', 'Mainboard', 'Sideboard', 'Maybeboard'];
      sectionKeys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }

  sectionKeys.forEach(label => {
    const cards = sections[label].sort(sortFn);
    // Even if empty, we might want a drop target if it's a board group
    // But currently we only render sections that have cards + we rely on headers for drop.
    // To allow dropping into empty boards, we need fixed sections if grouping by board.
    
    // For Drag & Drop: Only allow if grouping by 'board'
    const isBoardGroup = currentGroup === 'board';
    const dropAttr = isBoardGroup ? `ondragover="event.preventDefault();this.style.background='var(--hub-hover)'" ondragleave="this.style.background=''" ondrop="handleCardDrop(event, '${label}')"` : '';

    if (cards.length === 0 && !isBoardGroup) return;

    const rows = cards.map(c =>
      `<tr data-card="${escapeHtml(c.name)}" class="card-row" draggable="true" ondragstart="handleCardDragStart(event, '${escapeHtml(c.name)}', '${label}')">
        <td class="card-table__qty">${c.qty}</td>
        <td class="card-table__name"><span class="card-table__blame-trigger" data-card="${escapeHtml(c.name)}" title="Click for blame info">${c.name}</span></td>
        <td class="card-table__type">${c.type || '—'}</td>
        <td class="card-table__cmc" style="text-align:center">${(c.cmc !== undefined && c.cmc !== null) ? c.cmc : '—'}</td>
        <td class="card-table__tags">
          ${c.tags.map(chipHTML).join('')}
          <button class="hub-btn-icon tag-edit-btn" data-card-name="${escapeHtml(c.name)}" title="Edit Tags" style="opacity:0.5;margin-left:4px;cursor:pointer;border:none;background:none;color:var(--hub-text-muted);font-size:12px">&#x270E;</button>
        </td>
      </tr>`
    ).join('');
    
    const count = cards.reduce((s, c) => s + c.qty, 0);
    const price = cards.reduce((a, b) => a + ((b.price||0)*b.qty), 0);
    
    // Header is the drop target
    tableHTML += `<div class="card-table__section" ${dropAttr}>${label} (${count}) <span style="font-size:11px;color:var(--hub-text-muted)">($${price.toFixed(2)})</span></div>
      <table><thead><tr><th style="width:32px">#</th><th>Name</th><th>Type</th><th style="width:40px;text-align:center">CMC</th><th>Tags</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  });

  el.innerHTML = toolbarHTML + tableHTML;

  updateDeckPriceDisplay();
  setupCardHovers(el);

  // Wire Events
  el.querySelectorAll('.card-table__blame-trigger').forEach(span => {
    span.addEventListener('click', (e) => {
      const cardName = (e.target as HTMLElement).dataset.card;
      if (cardName) showBlamePopover(cardName, e.target as HTMLElement);
    });
  });

  el.querySelectorAll('.tag-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardName = (e.target as HTMLElement).dataset.cardName;
      if (cardName) openTagEditModal(cardName);
    });
  });

  // Wire Toolbar
  $('#cardFilterInput')?.addEventListener('input', (e) => {
    cardFilterStr = (e.target as HTMLInputElement).value;
    renderLiveCardTable();
    // Maintain focus logic
    const input = $<HTMLInputElement>('#cardFilterInput');
    if (input) {
        input.focus();
        const val = input.value;
        input.value = '';
        input.value = val;
    }
  });

  $('#groupSelect')?.addEventListener('change', (e) => {
    currentGroup = (e.target as HTMLSelectElement).value as any;
    renderLiveCardTable();
  });

  $('#sortSelect')?.addEventListener('change', (e) => {
    currentSort = (e.target as HTMLSelectElement).value as any;
    renderLiveCardTable();
  });
}

// ───── Drag & Drop Handlers ─────

// Global handlers exposed to window for inline HTML events
(window as any).handleCardDragStart = (e: DragEvent, name: string, board: string) => {
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ name, board }));
    e.dataTransfer.effectAllowed = 'move';
  }
};

(window as any).handleCardDrop = async (e: DragEvent, targetBoardLabel: string) => {
  e.preventDefault();
  (e.target as HTMLElement).style.background = '';
  
  if (!repoId || !e.dataTransfer) return;
  
  try {
    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
    const { name, board: sourceBoardLabel } = data;
    
    if (sourceBoardLabel === targetBoardLabel) return;
    
    // Map labels to keys
    const labelToKey = (l: string): keyof DeckState['boards'] => {
      if (l === 'Commander') return 'commander';
      if (l === 'Sideboard') return 'sideboard';
      if (l === 'Maybeboard') return 'maybeboard';
      return 'mainboard';
    };
    
    const sourceKey = labelToKey(sourceBoardLabel);
    const targetKey = labelToKey(targetBoardLabel);
    
    // Optimistic Update & Save
    // Construct new state
     const newState: DeckState = {
        meta: liveDeckMeta || { name: 'Deck', description: '', format: 'EDH' },
        boards: {
          commander: [...(liveCards.commander || [])],
          mainboard: [...(liveCards.main || [])],
          sideboard: [...(liveCards.sideboard || [])],
          maybeboard: [...(liveCards.maybeboard || [])],
        }
      };
      
      const sourceList = newState.boards[sourceKey];
      const targetList = newState.boards[targetKey];
      
      const idx = sourceList.findIndex(c => c.name === name);
      if (idx === -1) return;
      
      const [card] = sourceList.splice(idx, 1);
      
      // Check if exists in target
      const existing = targetList.find(c => c.name === card.name);
      if (existing) {
        existing.qty += card.qty;
      } else {
        targetList.push(card);
      }
      
      const branchObj = liveBranches.find(b => b.name === currentBranch);
      if (!branchObj) return;

      showToast(`Moving ${name} to ${targetBoardLabel}...`, 'info');
      
      // We can also optimistic render here if we want, but let's wait for save
      await commitApi.create(repoId, branchObj.id, `Move ${name} to ${targetKey}`, newState);
      loadRepo(repoId);
      showToast('Moved', 'success');
      
  } catch (err) {
    console.error('Drop error', err);
    showToast('Failed to move card', 'error');
  }
};

function openTagEditModal(cardName: string): void {
  // Find card in any board
  let card: AdaptedCard | undefined;
  let boardName: string = '';
  
  for (const board of ['commander', 'main', 'sideboard', 'maybeboard'] as const) {
    const c = (liveCards[board] || []).find(c => c.name === cardName);
    if (c) {
      card = c;
      boardName = board;
      break;
    }
  }

  if (!card) return;

  const modalHTML = `
    <div id="tagEditModal" class="hub-modal" aria-hidden="false" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:3000;display:flex;align-items:center;justify-content:center">
      <div class="hub-modal__content" style="background:var(--hub-bg-elevated);border-radius:12px;width:90%;max-width:400px;border:1px solid var(--hub-border-accent)">
        <div class="hub-modal__header" style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hub-border)">
          <h3 style="margin:0;font-size:16px;font-weight:600">Edit Tags: ${escapeHtml(card.name)}</h3>
          <button id="tagEditClose" class="hub-btn" style="font-size:20px;line-height:1">&times;</button>
        </div>
        <div class="hub-modal__body" style="padding:20px">
           <div style="display:flex;gap:8px;margin-bottom:12px">
             <input type="text" id="newTagInput" class="hub-input" placeholder="Add tag..." style="flex:1">
             <button id="btnAddTag" class="hub-btn hub-btn--secondary">Add</button>
           </div>
           <div id="tagList" style="display:flex;flex-wrap:wrap;gap:6px">
             ${card.tags.map(t => `
               <span class="hub-badge" style="display:flex;align-items:center;gap:4px">
                 ${escapeHtml(t)}
                 <button class="tag-remove" data-tag="${escapeHtml(t)}" style="border:none;background:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;margin-left:2px">&times;</button>
               </span>
             `).join('')}
           </div>
        </div>
        <div class="hub-modal__footer" style="display:flex;justify-content:flex-end;gap:12px;padding:16px 20px;border-top:1px solid var(--hub-border)">
          <button id="tagEditCancel" class="hub-btn hub-btn--secondary">Cancel</button>
          <button id="tagEditSave" class="hub-btn hub-btn--primary">Save Changes</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  const modal = $('#tagEditModal');
  const input = $<HTMLInputElement>('#newTagInput');
  const tagList = $('#tagList');
  let currentTags = [...card.tags];

  // Auto-focus input
  if (input) {
      setTimeout(() => input.focus(), 50);
  }

  function renderTags() {
    if(!tagList) return;
    tagList.innerHTML = currentTags.map(t => `
       <span class="hub-badge" style="display:flex;align-items:center;gap:4px">
         ${escapeHtml(t)}
         <button class="tag-remove" data-tag="${escapeHtml(t)}" style="border:none;background:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;margin-left:2px">&times;</button>
       </span>
    `).join('');
    
    tagList.querySelectorAll('.tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).dataset.tag;
        if (t) {
          currentTags = currentTags.filter(tag => tag !== t);
          renderTags();
        }
      });
    });
  }
  
  // Handlers
  $('#tagEditClose')?.addEventListener('click', () => modal?.remove());
  $('#tagEditCancel')?.addEventListener('click', () => modal?.remove());
  
  const addTagAction = () => {
    const val = input?.value.trim();
    if (val && !currentTags.includes(val)) {
      currentTags.push(val);
      if(input) input.value = '';
      renderTags();
      input?.focus();
    }
  };

  $('#btnAddTag')?.addEventListener('click', addTagAction);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        addTagAction();
    }
  });
  
  $('#tagEditSave')?.addEventListener('click', async () => {
    if (!repoId) return;
    const btn = $('#tagEditSave') as HTMLButtonElement;
    btn.textContent = 'Saving...';
    btn.disabled = true;

    // Update locally
    card!.tags = currentTags;
    
    // Save to repo
    // Create new deck state
    const newState: DeckState = {
       meta: liveDeckMeta!,
       boards: {
         commander: [], mainboard: [], sideboard: [], maybeboard: []
       }
    };
    
    // Map liveCards back to deck state
    // Note: liveCards are AdaptedCard, need to map to {name, qty, tags}
    newState.boards.commander = (liveCards.commander || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags }));
    newState.boards.mainboard = (liveCards.main || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags }));
    newState.boards.sideboard = (liveCards.sideboard || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags }));
    newState.boards.maybeboard = (liveCards.maybeboard || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags }));
    
    try {
      await commitApi.create(repoId, currentBranch, `Update tags for ${card!.name}`, newState);
      showToast('Tags updated!', 'success');
      modal?.remove();
      loadRepo(repoId); // Reload to reflect changes globally
    } catch (err) {
      showToast('Failed to save tags', 'error');
      btn.textContent = 'Save Changes';
      btn.disabled = false;
    }
  });
  
  renderTags(); // Init listeners
}

function updateDeckPriceDisplay(): void {
  let total = 0;
  for (const board of Object.keys(liveCards)) {
    for (const card of (liveCards[board] || [])) {
      total += (card.price || 0) * card.qty;
    }
  }

  const badge = $('#deckPriceBadge');
  if (badge) {
    if (total > 0) {
      badge.style.display = 'inline-flex';
      const span = badge.querySelector('span');
      if (span) span.textContent = `$${total.toFixed(2)}`;
    } else {
      badge.style.display = 'none';
    }
  }
}

function setupCardHovers(container: HTMLElement): void {
  const tooltip = $('#cardHoverTooltip');
  const img = $('#cardHoverImg') as HTMLImageElement;
  if (!tooltip || !img) return;

  const rows = container.querySelectorAll('.card-row');
  rows.forEach(row => {
    row.addEventListener('mouseenter', () => {
      const cardName = (row as HTMLElement).dataset.card;
      if (!cardName) return;

      let imageUrl = '';
      for (const board of Object.values(liveCards)) {
        const found = board.find(c => c.name === cardName);
        if (found && found.image) {
          imageUrl = found.image;
          break;
        }
      }

      if (imageUrl) {
        img.src = imageUrl;
        tooltip.style.display = 'block';
      }
    });

    row.addEventListener('mousemove', (e: Event) => {
      const me = e as MouseEvent;
      if (tooltip.style.display === 'block') {
        const x = me.clientX + 20;
        const y = me.clientY - 150;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;

        let finalX = x;
        let finalY = y;
        if (x + tw > winW) finalX = me.clientX - tw - 20;
        if (y + th > winH) finalY = winH - th - 10;
        if (y < 10) finalY = 10;

        tooltip.style.left = `${finalX}px`;
        tooltip.style.top = `${finalY}px`;
      }
    });

    row.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      img.src = '';
    });
  });
}

function renderLiveCurveBar(): void {
  const el = $('#curveBar');
  if (!el) return;

  // Build mana curve from live cards (commander + main)
  const allCards = [...(liveCards.commander || []), ...(liveCards.main || [])]
    .filter(c => !(c.type || '').toLowerCase().includes('land'));

  if (allCards.length === 0) {
    el.innerHTML = '<div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--hub-text-muted);font-size:11px">No non-land cards</div>';
    return;
  }

  const curve = [0, 0, 0, 0, 0, 0, 0, 0]; // 0-6, 7+
  for (const c of allCards) {
    const cmcValue = typeof c.cmc === 'number' && !isNaN(c.cmc) ? c.cmc : 0;
    const bucket = Math.min(Math.floor(cmcValue), 7);
    curve[bucket] += c.qty;
  }

  const max = Math.max(...curve, 1);
  const totalCurveCards = curve.reduce((a, b) => a + b, 0);
  
  el.innerHTML = curve.map((v, i) => {
    const h = Math.max(4, (v / max) * 100);
    const label = i === 7 ? '7+' : i;
    const pct = totalCurveCards > 0 ? Math.round((v / totalCurveCards) * 100) : 0;
    const tooltip = `CMC ${label}: ${v} cards (${pct}%)`;
    
    return `<div class="curve-bar__col" style="height:${h}%" data-label="${label}" title="${tooltip}"></div>`;
  }).join('');
}

function renderLiveChecks(): void {
  const el = $('#checksBody');
  if (!el) return;
  if (liveChecks.length === 0) {
    el.innerHTML = '<div style="font-size:12px;color:var(--hub-text-muted)">No checks available</div>';
    return;
  }
  el.innerHTML = liveChecks.map(c =>
    `<div class="check-item">
      <span class="check-item__icon ${c.pass ? 'check-item__icon--pass' : 'check-item__icon--fail'}">${c.pass ? '\u2705' : '\u274C'}</span>
      <span class="check-item__name">${c.name}</span>
    </div>`
  ).join('');
}

function renderLivePRList(): void {
  const el = $('#prListBody');
  if (!el) return;

  if (livePRs.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state__icon">\u{1F501}</div>
      <div class="empty-state__text">No pull requests yet</div>
      <button class="hub-btn hub-btn--sm hub-btn--gold" style="margin-top:12px" id="btnEmptyNewPR">\u2795 New Pull Request</button>
    </div>`;
    const emptyBtn = $('#btnEmptyNewPR');
    if (emptyBtn) emptyBtn.addEventListener('click', () => $('#btnNewPR')?.click());
    return;
  }

  // Bulk actions toolbar for open PRs
  const hasSelected = selectedPRs.size > 0;
  let html = '';
  
  if (isLiveMode) {
    html += `<div class="bulk-toolbar" style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--hub-border);background:var(--hub-raised);${hasSelected ? '' : 'display:none'}">
      <span style="font-size:12px;color:var(--hub-text-muted)">${selectedPRs.size} selected</span>
      <button class="hub-btn hub-btn--xs" id="btnBulkClosePRs">Close</button>
      <button class="hub-btn hub-btn--xs hub-btn--danger" id="btnBulkClearPRs">Clear</button>
    </div>`;
  }

  const openPRs = livePRs.filter(p => p.status === 'open');
  const mergedPRs = livePRs.filter(p => p.status === 'merged');

  if (openPRs.length) html += openPRs.map(pr => prItemHTML(pr, true)).join('');
  if (mergedPRs.length) {
    html += `<div style="padding:10px 16px;font-size:12px;font-weight:600;color:var(--hub-text-muted);border-bottom:1px solid var(--hub-border)">Merged</div>`;
    html += mergedPRs.map(pr => prItemHTML(pr, false)).join('');
  }

  el.innerHTML = html;

  // Attach checkbox handlers
  if (isLiveMode) {
    $$<HTMLInputElement>('.pr-bulk-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const prNumber = parseInt(cb.dataset.pr!, 10);
        if ((e.target as HTMLInputElement).checked) {
          selectedPRs.add(prNumber);
        } else {
          selectedPRs.delete(prNumber);
        }
        renderLivePRList(); // Re-render to show/hide toolbar
      });
    });

    // Bulk action handlers
    $('#btnBulkClosePRs')?.addEventListener('click', bulkClosePRs);
    $('#btnBulkClearPRs')?.addEventListener('click', () => {
      selectedPRs.clear();
      renderLivePRList();
    });
  }

  // Attach click handlers for PR items (not on checkbox)
  $$<HTMLElement>('.pr-item[data-pr]').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't open modal if clicking checkbox
      if ((e.target as HTMLElement).classList.contains('pr-bulk-checkbox')) return;
      openLivePRModal(parseInt(item.dataset.pr!, 10));
    });
    item.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openLivePRModal(parseInt(item.dataset.pr!, 10));
      }
    });
  });
}

function prItemHTML(pr: AdaptedPR, showCheckbox = false): string {
  const iconClass: Record<string, string> = { open: 'pr-item__icon--open', merged: 'pr-item__icon--merged', closed: 'pr-item__icon--closed' };
  const icon: Record<string, string> = { open: '\u{1F7E2}', merged: '\u{1F7E3}', closed: '\u{1F534}' };

  let checksHTML = '';
  if (pr.status === 'open') {
    checksHTML = pr.checksPass
      ? '<span class="hub-status hub-status--pass">\u2705 Checks pass</span>'
      : '<span class="hub-status hub-status--fail">\u274C Checks failing</span>';
    if (pr.approved) {
      checksHTML += ' <span class="hub-status hub-status--approved">\u2705 Approved</span>';
    }
  }

  // Look up raw PR for labels
  const rawPr = rawPRs.find(p => p.number === pr.number);
  const labelsHTML = rawPr?.labels?.length ? `<div class="pr-item__labels">${renderScopeLabels(rawPr.labels)}</div>` : '';

  const checkboxHTML = showCheckbox && pr.status === 'open' 
    ? `<input type="checkbox" class="pr-bulk-checkbox" data-pr="${pr.number}" ${selectedPRs.has(pr.number) ? 'checked' : ''} style="margin-right:10px;cursor:pointer">`
    : '';
  
  const isPinned = getPinnedPRs().includes(pr.number);
  const pinHTML = `<button class="pr-pin-btn" data-pr="${pr.number}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 6px;margin-right:4px;opacity:${isPinned ? '1' : '0.3'}" title="${isPinned ? 'Unpin' : 'Pin'}">${isPinned ? '\u2605' : '\u2606'}</button>`;

  return `<div class="pr-item" data-pr="${pr.number}" role="button" tabindex="0" aria-label="Pull request #${pr.number}: ${pr.title}">
    ${checkboxHTML}
    ${pinHTML}
    <span class="pr-item__icon ${iconClass[pr.status]}">${icon[pr.status]}</span>
    <div class="pr-item__body">
      <div class="pr-item__title">${pr.title} <span style="color:var(--hub-text-muted);font-weight:400">#${pr.number}</span>${labelsHTML}</div>
      <div class="pr-item__meta">
        ${pr.status === 'merged' ? 'Merged' : 'Opened'} ${pr.time} by ${pr.author}
        &middot; ${pr.branch} &rarr; ${pr.target}
      </div>
    </div>
    <div class="pr-item__checks">${checksHTML}</div>
  </div>`;
}

async function bulkCloseIssues(): Promise<void> {
  if (!repoId || selectedIssues.size === 0) return;
  
  const count = selectedIssues.size;
  if (!confirm(`Close ${count} issue${count > 1 ? 's' : ''}?`)) return;
  
  const btn = $('#btnBulkCloseIssues') as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Closing...';
  }
  
  let successCount = 0;
  let failCount = 0;
  
  for (const issueNumber of selectedIssues) {
    try {
      await issueApi.update(repoId, issueNumber, { status: 'closed' });
      successCount++;
    } catch (err) {
      failCount++;
      console.error(`Failed to close issue #${issueNumber}:`, err);
    }
  }
  
  selectedIssues.clear();
  
  if (failCount === 0) {
    showToast(`Closed ${successCount} issue${successCount > 1 ? 's' : ''}`, 'success');
  } else {
    showToast(`Closed ${successCount}, failed ${failCount}`, 'error');
  }
  
  // Refresh issue list
  try {
    const issues = await issueApi.list(repoId).catch(() => []);
    liveIssues = adaptIssues(issues);
    renderLiveIssues();
    const countEl = $('#countIssues');
    if (countEl) countEl.textContent = String(issues.filter(i => i.status === 'open').length);
  } catch (err) {
    showToast('Failed to refresh issue list', 'error');
  }
}

async function bulkClosePRs(): Promise<void> {
  if (!repoId || selectedPRs.size === 0) return;
  
  const count = selectedPRs.size;
  if (!confirm(`Close ${count} pull request${count > 1 ? 's' : ''}?`)) return;
  
  const btn = $('#btnBulkClosePRs') as HTMLButtonElement;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Closing...';
  }
  
  let successCount = 0;
  let failCount = 0;
  
  for (const prNumber of selectedPRs) {
    try {
      await prApi.close(repoId, prNumber);
      successCount++;
    } catch (err) {
      failCount++;
      console.error(`Failed to close PR #${prNumber}:`, err);
    }
  }
  
  selectedPRs.clear();
  
  if (failCount === 0) {
    showToast(`Closed ${successCount} PR${successCount > 1 ? 's' : ''}`, 'success');
  } else {
    showToast(`Closed ${successCount}, failed ${failCount}`, 'error');
  }
  
  // Refresh PR list
  try {
    const [open, closed] = await Promise.all([
      prApi.list(repoId, 'open').catch(() => []),
      prApi.list(repoId, 'closed').catch(() => []),
    ]);
    rawPRs = [...open, ...closed];
    livePRs = adaptPRList(rawPRs, rawBranches);
    renderLivePRList();
    const countEl = $('#countPRs');
    if (countEl) countEl.textContent = String(open.length);
  } catch (err) {
    showToast('Failed to refresh PR list', 'error');
  }
}

async function openLivePRModal(prNumber: number): Promise<void> {
  if (!repoId) return;
  const rawPR = rawPRs.find(p => p.number === prNumber);
  if (!rawPR) return;

  // Fetch reviews, checks, comments, and diff for this specific PR
  const [reviews, checks, comments, diff] = await Promise.all([
    reviewApi.list(repoId, prNumber).catch(() => []),
    checksApi.list(repoId, prNumber).catch(() => []),
    commentApi.list(repoId, prNumber).catch(() => [] as PRComment[]),
    prApi.getDiff(repoId, prNumber).catch(() => [] as DeckPatchOp[]),
  ]);

  const pr = adaptPR(rawPR, reviews, checks, rawBranches);

  // Open the modal with the assembled PR data + comments + diff
  openPRModalWithData(pr, comments, diff);
}

function openPRModalWithData(pr: AdaptedPR, comments?: PRComment[], diff?: DeckPatchOp[]): void {
  const modal = $('#prModal');
  if (!modal) return;

  const allChecksPass = pr.checks?.every(c => c.pass) ?? false;
  const allApproved = pr.reviews?.every(r => r.state === 'approved') ?? false;
  const canMerge = allChecksPass && allApproved && pr.status === 'open';

  const titleEl = $('#prModalTitle');
  const metaEl = $('#prModalMeta');

  // Risk Score
  const risk = diff ? computeRiskScore(diff) : null;
  const riskBadgeHTML = risk && risk.score > 0 ? ` ${renderRiskBadge(risk)}` : '';
  const rawPr = rawPRs.find(p => p.number === pr.number);
  const verifiedBadge = rawPr?.verified ? ` <span class="hub-verified-badge">\u2705 Verified${rawPr.verifiedBy ? ` by @${rawPr.verifiedBy}` : ''}</span>` : '';
  const firstTimeBadge = pr.status === 'open' && isFirstTimeContributor(pr) ? ' <span class="hub-first-time-badge">\u{1F44B} First-time contributor</span>' : '';
  if (titleEl) titleEl.innerHTML = `${pr.title} <span class="pr-modal__number">#${pr.number}</span>${riskBadgeHTML}${verifiedBadge}${firstTimeBadge}`;
  if (metaEl) metaEl.textContent = `${pr.author} wants to merge ${pr.branch} into ${pr.target} \u00B7 ${pr.time}`;

  let bodyHTML = '';

  // Locked conversation banner
  if (rawPr?.locked) {
    bodyHTML += `<div class="hub-locked-banner">\u{1F512} This conversation is locked. Only maintainers can comment.</div>`;
  }

  bodyHTML += `<div class="pr-modal__section">
    <div class="pr-modal__section-title">Description</div>
    <div class="pr-modal__desc">${pr.description || '<em>No description</em>'}</div>
  </div>`;

  // Deck Diff section with filter + focus mode
  if (diff && diff.length > 0) {
    const filteredDiff = focusModeActive && focusModeSections.length > 0
      ? filterDiffOps(diff, { board: focusModeSections[focusModeStep], opType: 'all' })
      : filterDiffOps(diff, currentDiffFilter);
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Deck Diff <span style="font-size:11px;color:var(--hub-text-muted)">(${diff.length} changes)</span></div>
      ${renderDiffFilterToolbar(diff)}
      ${renderFocusBar()}
      <div class="pr-modal__diff-detail">
        ${filteredDiff.length > 0 ? filteredDiff.map(renderDiffOp).join('') : '<div style="padding:16px;text-align:center;color:var(--hub-text-muted)">No changes match filter</div>'}
      </div>
    </div>`;
  }

  // Suggested Review Questions
  if (diff && diff.length > 0) {
    const questions = getSuggestedQuestions(diff);
    if (questions.length > 0) {
      bodyHTML += `<div class="pr-modal__section">
        <div class="pr-modal__section-title">\u{1F4A1} Suggested Review Questions</div>
        <div class="pr-modal__suggested-questions">
          ${questions.map(q => `<div class="pr-modal__question-item">\u2022 ${escapeHtml(q)}</div>`).join('')}
        </div>
      </div>`;
    }
  }

  if (pr.checks?.length) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Checks</div>
      <div class="checks-list">
        ${pr.checks.map(c => `<div class="check-item">
          <span class="check-item__icon ${c.pass ? 'check-item__icon--pass' : 'check-item__icon--fail'}">${c.pass ? '\u2705' : '\u274C'}</span>
          <span class="check-item__name">${c.name}</span>
          ${c.detail ? `<span style="font-size:11px;color:var(--hub-text-muted);margin-left:auto">${c.detail}</span>` : ''}
        </div>`).join('')}
      </div>
      ${isLiveMode && pr.status === 'open' ? '<button class="hub-btn hub-btn--sm" style="margin-top:8px" id="btnRerunChecks">\u{1F504} Re-run Checks</button>' : ''}
    </div>`;
  }

  if (pr.reviews?.length) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Reviews</div>
      <div class="pr-modal__reviews">
        ${pr.reviews.map(r => {
          const stateLabel = r.state === 'approved'
            ? '<span class="hub-status hub-status--approved">Approved</span>'
            : '<span class="hub-status hub-status--changes">Changes Requested</span>';
          return `<div class="pr-modal__review">
            <div class="pr-modal__review-avatar" style="background:${r.color}">${r.initials}</div>
            <strong style="font-size:13px">${r.user}</strong>
            ${stateLabel}
            <span style="font-size:12px;color:var(--hub-text-dim)">&ldquo;${r.comment}&rdquo;</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Comments section
  if (comments && comments.length > 0) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Comments (${comments.length})</div>
      ${comments.map(c => {
        if (c.hidden) {
          return `<div class="pr-modal__comment pr-modal__comment--hidden">
            <div class="pr-modal__comment-body">
              <div class="pr-modal__comment-text" style="color:var(--hub-text-muted);font-style:italic">\u{26A0}\u{FE0F} Comment hidden by moderation</div>
            </div>
          </div>`;
        }
        const reportBtn = isLiveMode ? `<button class="hub-btn-link hub-btn-link--dim" data-report-comment="${c.id}" title="Report comment">\u{2691}</button>` : '';
        return `<div class="pr-modal__comment">
          <div class="pr-modal__comment-avatar" style="background:${hashColorFromId(c.authorId)}">${c.authorName.slice(0, 2).toUpperCase()}</div>
          <div class="pr-modal__comment-body">
            <div class="pr-modal__comment-meta"><strong>${escapeHtml(c.authorName)}</strong> &middot; ${timeAgoFromISO(c.createdAt)} ${reportBtn}</div>
            <div class="pr-modal__comment-text">${escapeHtml(c.body)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Add comment input (for live mode)
  if (isLiveMode) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Add Comment</div>
      <div class="pr-modal__add-comment">
        <textarea class="hub-input" id="prCommentInput" placeholder="Write a comment..." style="flex:1;min-height:40px;resize:vertical;font-family:var(--hub-font)"></textarea>
        <button class="hub-btn hub-btn--primary hub-btn--sm" id="btnAddPRComment">Comment</button>
      </div>
    </div>`;
  }

  // Review Checklist
  if (pr.status === 'open') {
    bodyHTML += renderChecklist(pr.number);
  }

  // Guarded Areas badges
  if (diff && diff.length > 0) {
    const guardedHTML = renderGuardedBadges(diff);
    if (guardedHTML) {
      bodyHTML += `<div class="pr-modal__section">
        <div class="pr-modal__section-title">\u{1F6E1}\uFE0F Guarded Areas</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${guardedHTML}</div>
      </div>`;
    }
  }

  // Automerge toggle + Suggested Reviewers
  if (pr.status === 'open' && isLiveMode) {
    bodyHTML += `<div class="pr-modal__section" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
        <input type="checkbox" id="chkAutoMerge" ${(pr as any).autoMerge ? 'checked' : ''} />
        <span>\u{1F504} Auto-merge when ready</span>
      </label>
    </div>
    <div class="pr-modal__section">
      <div class="pr-modal__section-title">\u{1F4A1} Suggested Reviewers</div>
      <div id="suggestedReviewers" style="font-size:11px;color:var(--hub-text-muted)">Loading...</div>
    </div>`;
  }

  // PR Stack section (populated async)
  if (isLiveMode) {
    bodyHTML += `<div class="pr-modal__section" id="prStackSection" style="display:none"></div>`;
  }

  // Similar PRs section
  if (diff && diff.length > 0) {
    const similarPRs = findSimilarPRs(diff, pr.number);
    if (similarPRs.length > 0) {
      bodyHTML += `<div class="pr-modal__section">
        <div class="pr-modal__section-title">\u{1F50D} Similar PRs</div>
        <div class="hub-similar-prs">
          ${similarPRs.map(({ pr: simPr, similarity }) => {
            const icon: Record<string, string> = { open: '\u{1F7E2}', merged: '\u{1F7E3}', closed: '\u{1F534}' };
            return `<div class="hub-similar-pr">
              <span>${icon[simPr.status] || ''}</span>
              <span class="hub-similar-pr__title">PR #${simPr.number}: ${escapeHtml(simPr.title)}</span>
              <span class="hub-similar-pr__meta">${simPr.time} — ${Math.round(similarity * 10)}% overlap</span>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }
  }

  // Golden drift badge for merged PRs
  const goldenBadgeHTML = (pr.status === 'merged' && goldenDrift?.drift) ? renderGoldenDriftBadge() : '';

  // Quick Actions (Review Summary, Share, Sandbox, Revert, Verify, Lock)
  if (diff && diff.length > 0) {
    const lockBtn = isLiveMode
      ? `<button class="hub-btn hub-btn--sm" id="btnLockPR">${rawPr?.locked ? '\u{1F513} Unlock' : '\u{1F512} Lock'} Conversation</button>`
      : '';
    const verifyBtn = (pr.status === 'merged' && isLiveMode && !rawPr?.verified)
      ? '<button class="hub-btn hub-btn--sm hub-btn--gold" id="btnVerifyPR">\u2705 Verify Merge</button>'
      : '';

    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">\u26A1 Quick Actions ${goldenBadgeHTML}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="hub-btn hub-btn--sm" id="btnGenSummary">\u{1F4DD} Generate Summary</button>
        <button class="hub-btn hub-btn--sm" id="btnSharePack">\u{1F4E4} Share Review Pack</button>
        ${pr.status === 'open' ? '<button class="hub-btn hub-btn--sm" id="btnPRSandbox">\u{1F3AE} Playtest Branch</button>' : ''}
        ${pr.status === 'merged' && isLiveMode ? '<button class="hub-btn hub-btn--sm hub-btn--danger-outline" id="btnRevertPR">\u21A9 Revert this PR</button>' : ''}
        ${verifyBtn}
        ${lockBtn}
      </div>
    </div>`;
  }

  const bodyEl = $('#prModalBody');
  if (bodyEl) bodyEl.innerHTML = bodyHTML;

  // Wire Review Checklist checkboxes
  const checklistEl = $('#prChecklist');
  if (checklistEl) {
    checklistEl.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.type !== 'checkbox' || !input.dataset.idx) return;
      const state = getChecklistState(pr.number);
      state[parseInt(input.dataset.idx, 10)] = input.checked;
      setChecklistState(pr.number, state);
      // Update progress counter
      const template = getChecklistTemplate();
      const checked = Object.values(state).filter(Boolean).length;
      const progress = checklistEl.parentElement?.querySelector('.pr-modal__checklist-progress');
      if (progress) progress.textContent = `${checked}/${template.length}`;
    });
  }

  // Wire Automerge toggle
  const chkAutoMerge = $<HTMLInputElement>('#chkAutoMerge');
  if (chkAutoMerge) {
    chkAutoMerge.addEventListener('change', () => toggleAutoMerge(pr.number, chkAutoMerge.checked));
  }

  // Load suggested reviewers (async, non-blocking)
  if (pr.status === 'open' && isLiveMode) {
    loadSuggestedReviewers(pr.number);
  }

  // Load PR stack (async, non-blocking)
  if (isLiveMode) {
    loadPRStack(pr.number);
  }

  // Wire Quick Action buttons
  const btnSummary = $('#btnGenSummary');
  if (btnSummary && diff) {
    btnSummary.addEventListener('click', () => {
      const summary = generateReviewSummary(pr, diff, comments || []);
      navigator.clipboard.writeText(summary).then(() => showToast('Summary copied to clipboard!', 'success')).catch(() => showToast(summary, 'info'));
    });
  }
  const btnShare = $('#btnSharePack');
  if (btnShare && diff) {
    btnShare.addEventListener('click', () => {
      const pack = exportReviewPack(pr, diff, comments || []);
      navigator.clipboard.writeText(pack).then(() => showToast('Review pack copied as Markdown!', 'success')).catch(() => showToast('Failed to copy', 'error'));
    });
  }
  const btnSandbox = $('#btnPRSandbox');
  if (btnSandbox) btnSandbox.addEventListener('click', () => openPRSandbox(pr));
  const btnRevert = $('#btnRevertPR');
  if (btnRevert) btnRevert.addEventListener('click', () => { if (confirm(`Revert PR #${pr.number}? This creates a new PR that undoes these changes.`)) revertPR(pr.number); });

  // Wire Verify button
  const btnVerify = $('#btnVerifyPR');
  if (btnVerify) btnVerify.addEventListener('click', async () => {
    await verifyPR(pr.number);
    closePRModal();
    setTimeout(() => openLivePRModal(pr.number), 500);
  });

  // Wire Lock button
  const btnLock = $('#btnLockPR');
  if (btnLock) btnLock.addEventListener('click', async () => {
    const isLocked = rawPr?.locked ?? false;
    await toggleLockPR(pr.number, !isLocked);
    closePRModal();
    setTimeout(() => openLivePRModal(pr.number), 500);
  });

  // Wire Report comment buttons
  $$<HTMLButtonElement>('[data-report-comment]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const commentId = btn.dataset.reportComment!;
      if (confirm('Report this comment?')) {
        await reportComment(pr.number, commentId);
        closePRModal();
        setTimeout(() => openLivePRModal(pr.number), 500);
      }
    });
  });

  // Wire re-run checks button
  const btnRerun = $('#btnRerunChecks');
  if (btnRerun && repoId) {
    btnRerun.addEventListener('click', async () => {
      btnRerun.textContent = 'Running...';
      (btnRerun as HTMLButtonElement).disabled = true;
      try {
        await checksApi.run(repoId!, pr.number);
        showToast('Checks re-triggered!', 'success');
        closePRModal();
        // Re-open with fresh data
        setTimeout(() => openLivePRModal(pr.number), 500);
      } catch (err) {
        showToast(`Failed: ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
        btnRerun.textContent = '\u{1F504} Re-run Checks';
        (btnRerun as HTMLButtonElement).disabled = false;
      }
    });
  }

  // Wire add comment button
  const btnComment = $('#btnAddPRComment');
  if (btnComment && repoId) {
    btnComment.addEventListener('click', async () => {
      const input = $<HTMLTextAreaElement>('#prCommentInput');
      const body = input?.value.trim();
      if (!body) { showToast('Comment cannot be empty', 'info'); return; }
      (btnComment as HTMLButtonElement).disabled = true;
      btnComment.textContent = 'Posting...';
      try {
        await commentApi.add(repoId!, pr.number, body);
        showToast('Comment added!', 'success');
        closePRModal();
        setTimeout(() => openLivePRModal(pr.number), 300);
      } catch (err) {
        showToast(`Failed: ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
        (btnComment as HTMLButtonElement).disabled = false;
        btnComment.textContent = 'Comment';
      }
    });
  }

  // Merge box
  let mergeHTML = '';
  if (pr.status === 'merged') {
    mergeHTML = `<div class="pr-modal__merge-status">
      <span style="color:var(--hub-purple);font-size:16px">\u{1F7E3}</span>
      <span style="color:var(--hub-text-bright);font-weight:600">This PR was merged</span>
    </div>`;
  } else if (pr.status === 'open') {
    const reasons: string[] = [];
    if (!allChecksPass) reasons.push('checks are failing');
    if (!allApproved) reasons.push('missing approvals');
    mergeHTML = `<div class="pr-modal__merge-status">
      <div class="pr-modal__merge-checks">
        ${allChecksPass ? '<span class="hub-status hub-status--pass">\u2705 Checks</span>' : '<span class="hub-status hub-status--fail">\u274C Checks</span>'}
        ${allApproved ? '<span class="hub-status hub-status--approved">\u2705 Approved</span>' : '<span class="hub-status hub-status--changes">\u23F3 Pending</span>'}
      </div>
      ${!canMerge ? `<span style="font-size:11px;color:var(--hub-text-muted)">Cannot merge: ${reasons.join(', ')}</span>` : ''}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <button class="hub-btn hub-btn--primary" id="btnMergePR" ${canMerge ? '' : 'disabled aria-disabled="true"'} style="flex:1">${canMerge ? '\u2705 Merge Pull Request' : '\u{1F6AB} Merge blocked'}</button>
      ${canMerge ? '<button class="hub-btn hub-btn--sm" id="btnAutoSquash" title="Generate merge message from commits">\u{1F4DD} Auto-message</button>' : ''}
    </div>`;
  }

  const mergeEl = $('#prModalMerge');
  if (mergeEl) mergeEl.innerHTML = mergeHTML;

  // Wire auto-squash button
  const btnSquash = $('#btnAutoSquash');
  if (btnSquash) {
    btnSquash.addEventListener('click', () => {
      const msg = generateSquashMessage(liveCommits.filter(c => c.branch === pr.branch));
      if (msg) {
        navigator.clipboard.writeText(msg).then(() => showToast('Merge message copied!', 'success')).catch(() => showToast(msg, 'info'));
      } else {
        showToast('No commits found for this branch', 'info');
      }
    });
  }

  // Attach merge handler
  if (canMerge && repoId) {
    const mergeBtn = $('#btnMergePR');
    if (mergeBtn) {
      mergeBtn.addEventListener('click', async () => {
        if (!repoId) return;
        mergeBtn.textContent = 'Merging...';
        (mergeBtn as HTMLButtonElement).disabled = true;
        try {
          await prApi.merge(repoId, pr.number);
          closePRModal();
          showToast(`PR #${pr.number} merged successfully!`, 'success');
          loadRepo(repoId); // Refresh
        } catch (err) {
          showToast(`Merge failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
          mergeBtn.textContent = '\u2705 Merge Pull Request';
          (mergeBtn as HTMLButtonElement).disabled = false;
        }
      });
    }
  }

  // Wire diff filter buttons
  if (diff && diff.length > 0) {
    modal.querySelectorAll('[data-filter-board]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentDiffFilter.board = (btn as HTMLElement).dataset.filterBoard || 'all';
        focusModeActive = false;
        openPRModalWithData(pr, comments, diff);
      });
    });
    modal.querySelectorAll('[data-filter-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentDiffFilter.opType = (btn as HTMLElement).dataset.filterType || 'all';
        focusModeActive = false;
        openPRModalWithData(pr, comments, diff);
      });
    });
    const btnFocus = $('#btnToggleFocusMode');
    if (btnFocus) {
      btnFocus.addEventListener('click', () => {
        focusModeActive = !focusModeActive;
        if (focusModeActive) {
          focusModeSections = getDiffSections(diff);
          focusModeStep = 0;
        }
        openPRModalWithData(pr, comments, diff);
      });
    }
    const btnPrev = $('#btnFocusPrev');
    const btnNext = $('#btnFocusNext');
    if (btnPrev) btnPrev.addEventListener('click', () => { focusModeStep = Math.max(0, focusModeStep - 1); openPRModalWithData(pr, comments, diff); });
    if (btnNext) btnNext.addEventListener('click', () => { focusModeStep = Math.min(focusModeSections.length - 1, focusModeStep + 1); openPRModalWithData(pr, comments, diff); });
  }

  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#prModalClose')?.focus();
}

function renderLiveIssues(): void {
  const el = $('#issueListBody');
  if (!el) return;

  const filtered = liveIssues.filter(i => i.status === issueFilter);

  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state__icon">\u{1F4CB}</div>
      <div class="empty-state__text">${issueFilter === 'open' ? 'No open issues \u2014 looking good!' : 'No closed issues'}</div>
      ${issueFilter === 'open' ? '<button class="hub-btn hub-btn--sm hub-btn--gold" style="margin-top:12px" id="btnEmptyNewIssue">\u2795 New Issue</button>' : ''}
    </div>`;
    const emptyBtn = $('#btnEmptyNewIssue');
    if (emptyBtn) emptyBtn.addEventListener('click', openIssueModal);
    return;
  }

  // Bulk actions toolbar
  const hasSelected = selectedIssues.size > 0;
  let html = '';
  
  if (isLiveMode && issueFilter === 'open') {
    html += `<div class="bulk-toolbar" style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--hub-border);background:var(--hub-raised);${hasSelected ? '' : 'display:none'}">
      <span style="font-size:12px;color:var(--hub-text-muted)">${selectedIssues.size} selected</span>
      <button class="hub-btn hub-btn--xs" id="btnBulkCloseIssues">Close</button>
      <button class="hub-btn hub-btn--xs hub-btn--danger" id="btnBulkClearIssues">Clear</button>
    </div>`;
  }

  html += filtered.map(issue => {
    const isOpen = issue.status === 'open';
    const icon = isOpen ? '\u{1F7E2}' : '\u{1F534}';
    const checkboxHTML = isLiveMode && isOpen
      ? `<input type="checkbox" class="issue-bulk-checkbox" data-issue="${issue.number}" ${selectedIssues.has(issue.number) ? 'checked' : ''} style="margin-right:10px;cursor:pointer">`
      : '';
    const isPinned = getPinnedIssues().includes(issue.number);
    const pinHTML = `<button class="issue-pin-btn" data-issue="${issue.number}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 6px;margin-right:4px;opacity:${isPinned ? '1' : '0.3'}" title="${isPinned ? 'Unpin' : 'Pin'}">${isPinned ? '\u2605' : '\u2606'}</button>`;
    const actionBtn = isLiveMode
      ? `<button class="hub-btn hub-btn--sm" data-toggle-issue="${issue.number}" style="flex-shrink:0">${isOpen ? 'Close' : 'Reopen'}</button>`
      : '';
    return `<div class="issue-item" data-issue="${issue.number}">
      ${checkboxHTML}
      ${pinHTML}
      <span class="issue-item__icon">${icon}</span>
      <div class="issue-item__body">
        <div class="issue-item__title">${issue.title} <span style="color:var(--hub-text-muted);font-weight:400">#${issue.number}</span></div>
        <div class="issue-item__meta">
          ${issue.labels.map(labelHTML).join(' ')}
          &middot; ${isOpen ? 'opened' : 'closed'} ${issue.time}${issue.author ? ` by ${issue.author}` : ''}
        </div>
      </div>
      ${actionBtn}
    </div>`;
  }).join('');

  el.innerHTML = html;

  // Wire checkbox handlers for issues
  if (isLiveMode && issueFilter === 'open') {
    $$<HTMLInputElement>('.issue-bulk-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const issueNumber = parseInt(cb.dataset.issue!, 10);
        if ((e.target as HTMLInputElement).checked) {
          selectedIssues.add(issueNumber);
        } else {
          selectedIssues.delete(issueNumber);
        }
        renderLiveIssues();
      });
    });

    // Wire pin buttons for issues
    $$<HTMLButtonElement>('.issue-pin-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const issueNumber = parseInt(btn.dataset.issue!, 10);
        togglePinIssue(issueNumber);
      });
    });

    // Bulk action handlers
    $('#btnBulkCloseIssues')?.addEventListener('click', bulkCloseIssues);
    $('#btnBulkClearIssues')?.addEventListener('click', () => {
      selectedIssues.clear();
      renderLiveIssues();
    });
  }

  // Wire toggle buttons
  el.querySelectorAll<HTMLButtonElement>('[data-toggle-issue]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!repoId) return;
      const num = parseInt(btn.dataset.toggleIssue!, 10);
      const issue = liveIssues.find(i => i.number === num);
      if (!issue) return;
      const newStatus = issue.status === 'open' ? 'closed' : 'open';
      btn.textContent = 'Updating...';
      btn.disabled = true;
      try {
        await issueApi.update(repoId, num, { status: newStatus });
        showToast(`Issue #${num} ${newStatus === 'closed' ? 'closed' : 'reopened'}`, 'success');
        // Refresh
        const issues = await issueApi.list(repoId).catch(() => []);
        liveIssues = adaptIssues(issues);
        const countEl = $('#countIssues');
        if (countEl) countEl.textContent = String(issues.filter(i => i.status === 'open').length);
        renderFilteredIssues();
      } catch (err) {
        showToast(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
        btn.textContent = issue.status === 'open' ? 'Close' : 'Reopen';
        btn.disabled = false;
      }
    });
  });
}

function renderLiveReleases(): void {
  const el = $('#releaseListBody');
  if (!el) return;

  // Filter by channel
  const filtered = releaseChannelFilter === 'all'
    ? liveReleases
    : liveReleases.filter(r => r.channel === releaseChannelFilter);

  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="empty-state__icon">\u{1F3F7}\u{FE0F}</div>
      <div class="empty-state__text">${releaseChannelFilter === 'all' ? 'No releases yet' : `No ${releaseChannelFilter} releases`}</div>
      <button class="hub-btn hub-btn--sm hub-btn--gold" style="margin-top:12px" id="btnEmptyNewRelease">\u2795 Create Release</button>
    </div>`;
    const emptyBtn = $('#btnEmptyNewRelease');
    if (emptyBtn) emptyBtn.addEventListener('click', openReleaseModal);
    return;
  }
  el.innerHTML = filtered.map((rel, idx) => {
    let notesHTML = '';
    if (rel.notes.length) {
      notesHTML = rel.notes.map(n => {
        const prefix: Record<string, string> = { add: '\u2795', remove: '\u274C', change: '\u{1F504}', fix: '\u{1F527}' };
        return `<li>${prefix[n.type] || ''} ${n.text}</li>`;
      }).join('');
    } else if (rel.body) {
      notesHTML = `<li>${escapeHtml(rel.body)}</li>`;
    }

    const channel = rel.channel || 'stable';
    const channelBadge = renderReleaseChannelBadge(channel);
    const verifiedBadge = (rel as any).verified ? `<span class="hub-verified-badge">\u2705 Verified</span>` : '';
    const verifyBtn = isLiveMode && !(rel as any).verified ? `<button class="hub-btn hub-btn--sm hub-btn--gold" data-release-verify="${idx}">\u2705 Verify</button>` : '';

    return `<div class="release-item">
      <div class="release-item__header">
        <span class="release-item__tag">${escapeHtml(rel.tag)}</span>
        ${channelBadge}
        ${verifiedBadge}
        <span class="release-item__date">${rel.date}</span>
      </div>
      <div class="release-item__title">${escapeHtml(rel.title)}</div>
      ${notesHTML ? `<ul class="release-item__notes">${notesHTML}</ul>` : ''}
      <div class="release-item__actions">
        <button class="hub-btn hub-btn--sm" data-release-packet="${idx}">\u{1F4E6} Tournament Packet</button>
        <button class="hub-btn hub-btn--sm" data-release-share="${idx}">\u{1F517} Share Link</button>
        ${verifyBtn}
      </div>
    </div>`;
  }).join('');

  // Wire share link buttons
  el.querySelectorAll<HTMLButtonElement>('[data-release-share]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.releaseShare!, 10);
      const rel = filtered[idx];
      if (!rel) return;
      const url = `${location.origin}/deckhub?repo=${repoId}#tab=releases`;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied!', 'success');
      }).catch(() => {
        showToast('Failed to copy link', 'error');
      });
    });
  });

  // Wire tournament packet buttons
  el.querySelectorAll<HTMLButtonElement>('[data-release-packet]').forEach(btn => {
    btn.addEventListener('click', () => {
      showToast('Tournament Packet export coming soon!', 'info');
    });
  });

  // Wire verify buttons
  el.querySelectorAll<HTMLButtonElement>('[data-release-verify]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.releaseVerify!, 10);
      const rel = filtered[idx];
      if (!rel) return;
      btn.textContent = 'Verifying...';
      btn.disabled = true;
      await verifyRelease(rel.tag);
    });
  });
}

function renderReleaseChannelBadge(channel: string): string {
  const icons: Record<string, string> = { stable: '\u{1F7E2}', experimental: '\u{1F7E1}', prerelease: '\u{1F534}' };
  const labels: Record<string, string> = { stable: 'Stable', experimental: 'Experimental', prerelease: 'Prerelease' };
  return `<span class="hub-release-channel hub-release-channel--${channel}">${icons[channel] || ''} ${labels[channel] || channel}</span>`;
}

// ───── Live Sidebar Renders ─────

function renderLiveStats(): void {
  const totalEl = $('#statTotal');
  const cmdEl = $('#statCommander');
  const mainEl = $('#statMainboard');
  const cmcEl = $('#statAvgCmc');

  if (totalEl) totalEl.textContent = String(liveTotalCards || '—');
  if (cmdEl) cmdEl.textContent = String(liveCommanderCount || '—');
  if (mainEl) mainEl.textContent = String(liveMainboardCount || '—');

  // Compute avg CMC from live cards
  const allCards = [...(liveCards.commander || []), ...(liveCards.main || [])];
  if (allCards.length > 0 && cmcEl) {
    const totalCmc = allCards.reduce((s, c) => s + (c.cmc * c.qty), 0);
    const totalQty = allCards.reduce((s, c) => s + c.qty, 0);
    cmcEl.textContent = totalQty > 0 ? (totalCmc / totalQty).toFixed(2) : '—';
  } else if (cmcEl) {
    cmcEl.textContent = '—';
  }

  // Update mana pips placeholder
  const pipsEl = $('#manaPips');
  if (pipsEl) {
    pipsEl.style.display = 'none';
  }

  // Ensure analytics container exists and render
  let analytics = $('#manaAnalytics');
  if (!analytics) {
    analytics = document.createElement('div');
    analytics.id = 'manaAnalytics';
    analytics.style.marginTop = '24px';
    analytics.style.paddingTop = '16px';
    analytics.style.borderTop = '1px solid var(--hub-border)';
    // Append to stats sidebar if found
    const sidebar = $('#statTotal')?.closest('.layout__sidebar-right') || document.querySelector('.layout__sidebar-right'); 
    if (sidebar) sidebar.appendChild(analytics);
  }

  // Ensure budget container exists
  let budget = $('#budgetStats');
  if (!budget) {
    budget = document.createElement('div');
    budget.id = 'budgetStats';
    // Append to stats sidebar if found
    const sidebar = $('#statTotal')?.closest('.layout__sidebar-right') || document.querySelector('.layout__sidebar-right'); 
    if (sidebar) sidebar.appendChild(budget);
  }

  renderManaAnalytics();
  renderBudgetStats();
}

function renderLivePrimer(): void {
  const el = $('#primerBody');
  const editBtn = $('#btnEditReadme');
  if (!el) return;

  // Show edit button in live mode
  if (editBtn) {
    editBtn.style.display = isLiveMode ? 'inline-block' : 'none';
  }

  if (liveDeckMeta?.description) {
    // Convert markdown to HTML
    const html = markdownToHtml(liveDeckMeta.description);
    el.innerHTML = `<h3>${escapeHtml(liveDeckMeta.name || 'Deck Primer')}</h3>${html}`;
  } else if (liveDeckMeta?.name) {
    el.innerHTML = `<h3>${escapeHtml(liveDeckMeta.name)}</h3><p style="color:var(--hub-text-muted)">No primer written yet. Click "Edit" to add a README.</p>`;
  } else {
    el.innerHTML = `<p style="color:var(--hub-text-muted)">No primer available. Add a description to your deck in the editor.</p>`;
  }
}

function renderLiveContributors(collabs: { userId: string; role: string }[]): void {
  const el = $('#contributorsBody');
  if (!el) return;

  if (collabs.length === 0) {
    // Show current user if available
    const user = getUser();
    if (user) {
      const initials = user.displayName.split(/[\s_-]+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2);
      el.innerHTML = `<div class="contributor" style="background:linear-gradient(135deg,#a78bfa,#5ea3f8)" title="${user.displayName}">${initials}</div>`;
    } else {
      el.innerHTML = `<span style="font-size:12px;color:var(--hub-text-muted)">No collaborators</span>`;
    }
    return;
  }

  const adapted = adaptCollaborators(collabs as Collaborator[]);
  el.innerHTML = adapted.map(c =>
    `<div class="contributor" style="background:${c.color}" title="${c.displayName} (${c.role})">${c.initials}</div>`
  ).join('');
}

function renderLiveQuickLinks(): void {
  const el = $('#quickLinks');
  if (!el) return;

  const links: string[] = [];

  if (livePRs.length > 0) {
    const latestPR = livePRs.find(p => p.status === 'open') || livePRs[0];
    links.push(`<div class="quick-link">\u{1F501} <a href="#" data-open-tab="pulls">Latest PR: #${latestPR.number} ${latestPR.title}</a></div>`);
  }

  const openIssueCount = liveIssues.filter(i => i.status === 'open').length;
  if (openIssueCount > 0) {
    links.push(`<div class="quick-link">\u{1F4CB} <a href="#" data-open-tab="issues">${openIssueCount} open issue${openIssueCount !== 1 ? 's' : ''}</a></div>`);
  }

  if (liveReleases.length > 0) {
    links.push(`<div class="quick-link">\u{1F3F7}\u{FE0F} <a href="#" data-open-tab="releases">Latest release: ${liveReleases[0].tag}</a></div>`);
  }

  if (links.length === 0) {
    links.push(`<div class="quick-link" style="color:var(--hub-text-muted)">No activity yet</div>`);
  }

  el.innerHTML = links.join('');

  // Attach tab-switch handlers
  el.querySelectorAll<HTMLAnchorElement>('[data-open-tab]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = a.dataset.openTab;
      if (tab) switchTab(tab);
    });
  });
}

function renderLiveManaBalance(): void {
  const el = $('#insightManaBody');
  if (!el) return;

  const symbolCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const sourceCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };

  const allCards = [...(liveCards.commander || []), ...(liveCards.main || [])];

  for (const card of allCards) {
    // Symbols
    const cost = card.manaCost || '';
    (['W', 'U', 'B', 'R', 'G'] as const).forEach(color => {
      // Match {W}, {W/U}, {U/W}, {2/W}, {W/P} etc.
      const regex = new RegExp(`{[^}]*${color}[^}]*}`, 'g');
      const matches = cost.match(regex);
      if (matches) symbolCounts[color] += matches.length * card.qty;
    });

    // Sources
    const isLand = (card.type || '').toLowerCase().includes('land');
    if (isLand) {
      (card.produced || []).forEach(color => {
        if (color in sourceCounts) {
          sourceCounts[color as keyof typeof sourceCounts] += card.qty;
        }
      });
    }
  }

  const totalSymbols = Object.values(symbolCounts).reduce((a, b) => a + b, 0);
  const totalSources = Object.values(sourceCounts).reduce((a, b) => a + b, 0);

  if (totalSymbols === 0 && totalSources === 0) {
    el.innerHTML = '<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">Add cards with mana costs or lands to see balance</div>';
    return;
  }

  const rows = (['W', 'U', 'B', 'R', 'G'] as const).map(color => {
    const symbols = symbolCounts[color];
    const sources = sourceCounts[color];
    if (symbols === 0 && sources === 0) return '';

    const symPercent = totalSymbols > 0 ? (symbols / totalSymbols) * 100 : 0;
    const colorName = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[color];
    const colorVar = { W: '--mana-w', U: '--mana-u', B: '--mana-b', R: '--mana-r', G: '--mana-g' }[color];

    return `
      <tr>
        <td style="width:24px"><span class="mana-symbol-icon mana-symbol-icon--${color.toLowerCase()}">${color}</span></td>
        <td>
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <span style="font-weight:600">${colorName}</span>
            <span style="color:var(--hub-text-muted)">${symbols} sym / ${sources} src</span>
          </div>
          <div class="mana-balance-bar">
            <div class="mana-balance-fill" style="width:${symPercent}%; background:var(${colorVar}); box-shadow: 0 0 8px var(${colorVar})"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `<table class="mana-balance-table"><tbody>${rows}</tbody></table>`;
}

function renderLiveInsights(): void {
  renderLiveManaBalance();

  const checksEl = $('#insightChecksBody');
  if (checksEl) {
    if (liveChecks.length > 0) {
      checksEl.innerHTML = liveChecks.map(c =>
        `<div class="insight-row">
          <span class="insight-row__icon">${c.pass ? '\u2705' : '\u274C'}</span>
          <span class="insight-row__name">${c.name}</span>
          <span class="insight-row__detail">${c.detail || ''}</span>
        </div>`
      ).join('');
    } else {
      checksEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">No check data available — checks run when PRs are created</div>`;
    }
  }

  const warningsEl = $('#insightWarningsBody');
  if (warningsEl) {
    warningsEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">No warnings</div>`;
  }

  const regressionsEl = $('#insightRegressionsBody');
  if (regressionsEl) {
    regressionsEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">No regressions tracked yet</div>`;
  }

  // Package Changelog
  const changelogEl = $('#insightChangelogBody');
  if (changelogEl) {
    if (rawCommitData.length > 0) {
      const changelog = buildPackageChangelog(liveCommits, rawCommitData);
      if (changelog.size > 0) {
        const order = ['commander', 'mainboard', 'sideboard', 'maybeboard', 'meta', 'other'];
        const sortedSections = [...changelog.entries()].sort((a, b) => {
          const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        changelogEl.innerHTML = sortedSections.map(([section, entries]) =>
          renderChangelogSection(section, entries)
        ).join('');
      } else {
        changelogEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">No card changes found in recent commits</div>`;
      }
    } else {
      changelogEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">No commit data — changelog unavailable</div>`;
    }
  }

  // Golden State drift display
  const goldenEl = $('#insightGoldenBody');
  if (goldenEl) {
    if (goldenDrift?.goldenCommitId && goldenDrift.drift) {
      const d = goldenDrift.drift;
      const level = d.driftPercent <= 5 ? 'low' : d.driftPercent <= 15 ? 'medium' : d.driftPercent <= 30 ? 'high' : 'critical';
      goldenEl.innerHTML = `
        <div class="hub-golden-card">
          <div class="hub-golden-card__header">
            <span class="hub-golden-drift hub-golden-drift--${level}">\u2B50 ${d.driftPercent}% drift</span>
            <button class="hub-btn hub-btn--xs" id="btnClearGolden">\u274C Clear</button>
          </div>
          <div class="hub-golden-card__stats">
            <span>+${d.added} added</span> <span>\u00B7</span>
            <span>-${d.removed} removed</span> <span>\u00B7</span>
            <span>${d.totalChanges} total changes</span>
          </div>
          <div style="font-size:11px;color:var(--hub-text-muted)">Commit: ${goldenDrift.goldenCommitId.slice(0, 8)}</div>
        </div>`;
      const btnClear = goldenEl.querySelector('#btnClearGolden');
      if (btnClear) btnClear.addEventListener('click', () => setGoldenState(null));
    } else if (goldenDrift && !goldenDrift.goldenCommitId && rawCommitData.length > 0) {
      goldenEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">
        No golden state set. <button class="hub-btn hub-btn--xs" id="btnSetGolden">\u2B50 Set current as golden</button>
      </div>`;
      const btnSet = goldenEl.querySelector('#btnSetGolden');
      if (btnSet) btnSet.addEventListener('click', () => { if (rawCommitData[0]) setGoldenState(rawCommitData[0].id); });
    } else {
      goldenEl.innerHTML = `<div style="font-size:12px;color:var(--hub-text-muted);padding:12px">Golden state tracking unavailable</div>`;
    }
  }
}

// ───── Command Palette ─────

interface CmdItem {
  icon: string;
  label: string;
  hint: string;
  action: () => void;
}

function initCommandPalette(): void {
  const overlay = $('#cmdPalette');
  const input = $<HTMLInputElement>('#cmdPaletteInput');
  const results = $('#cmdPaletteResults');
  if (!overlay || !input || !results) return;

  let items: CmdItem[] = [];
  let activeIndex = 0;

  function buildItems(): CmdItem[] {
    const list: CmdItem[] = [];

    // Tabs
    TABS.forEach(t => {
      const labels: Record<string, string> = { code: 'Code', pulls: 'Pull Requests', issues: 'Issues', releases: 'Releases', insights: 'Insights', settings: 'Settings' };
      list.push({ icon: '\u{1F4C1}', label: labels[t] || t, hint: `Tab`, action: () => { closeCmdPalette(); switchTab(t); } });
    });

    // Branches
    const branches = isLiveMode ? liveBranches : BRANCHES.map(b => ({ name: b.name, isDefault: b.isDefault }));
    branches.forEach(b => {
      list.push({ icon: '\u{1F500}', label: b.name, hint: b.isDefault ? 'default branch' : 'branch', action: () => {
        closeCmdPalette();
        currentBranch = b.name;
        const label = $('#branchLabel');
        if (label) label.textContent = currentBranch;
        // Trigger branch UI update
        const branchBtn = $('#branchBtn');
        if (branchBtn) branchBtn.click();
      }});
    });

    // PRs
    const prs = isLiveMode ? livePRs : PRS;
    prs.forEach(p => {
      list.push({ icon: '\u{1F501}', label: `#${p.number} ${p.title}`, hint: `PR · ${p.status}`, action: () => {
        closeCmdPalette();
        switchTab('pulls');
        setTimeout(() => {
          if (isLiveMode) openLivePRModal(p.number);
          else openPRModal(p.number);
        }, 200);
      }});
    });

    // Issues
    const issues = isLiveMode ? liveIssues : ISSUES;
    issues.forEach(i => {
      list.push({ icon: '\u{1F4CB}', label: `#${i.number} ${i.title}`, hint: `Issue`, action: () => {
        closeCmdPalette();
        switchTab('issues');
      }});
    });

    // Actions
    list.push({ icon: '\u2795', label: 'New Pull Request', hint: 'Action', action: () => { closeCmdPalette(); $('#btnNewPR')?.click(); }});
    list.push({ icon: '\u2795', label: 'New Issue', hint: 'Action', action: () => { closeCmdPalette(); openIssueModal(); }});
    list.push({ icon: '\u2795', label: 'Create Release', hint: 'Action', action: () => { closeCmdPalette(); openReleaseModal(); }});
    list.push({ icon: '\u{1F500}', label: 'Create Branch', hint: 'Action', action: () => { closeCmdPalette(); $('#btnCreateBranch')?.click(); }});
    list.push({ icon: '\u{1F50D}', label: 'Compare Branches', hint: 'Action', action: () => { closeCmdPalette(); openBranchCompareModal(); }});
    list.push({ icon: '\u2699\uFE0F', label: 'Settings', hint: 'Action', action: () => { closeCmdPalette(); switchTab('settings'); }});

    // Phase 3 actions
    if (isLiveMode && rawCommitData.length > 0) {
      list.push({ icon: '\u2B50', label: 'Set Golden State (latest commit)', hint: 'Action', action: () => {
        closeCmdPalette();
        if (rawCommitData[0]) setGoldenState(rawCommitData[0].id);
      }});
      if (goldenDrift?.goldenCommitId) {
        list.push({ icon: '\u274C', label: 'Clear Golden State', hint: 'Action', action: () => { closeCmdPalette(); setGoldenState(null); }});
      }
    }

    // Phase 6 actions
    if (isLiveMode) {
      list.push({ icon: '\u{1F9EA}', label: 'Create Meta-Tune Branch', hint: 'Workflow', action: () => { closeCmdPalette(); createMetaBranch(); }});
      list.push({ icon: '\u{1F50D}', label: 'Start Deck Bisect', hint: 'Debug', action: () => { closeCmdPalette(); openBisectWizard(); }});
    }
    list.push({ icon: '\u{1F7E2}', label: 'Filter Releases: Stable', hint: 'Filter', action: () => { closeCmdPalette(); releaseChannelFilter = 'stable'; switchTab('releases'); if (isLiveMode) renderLiveReleases(); }});
    list.push({ icon: '\u{1F7E1}', label: 'Filter Releases: Experimental', hint: 'Filter', action: () => { closeCmdPalette(); releaseChannelFilter = 'experimental'; switchTab('releases'); if (isLiveMode) renderLiveReleases(); }});
    list.push({ icon: '\u{1F534}', label: 'Filter Releases: Prerelease', hint: 'Filter', action: () => { closeCmdPalette(); releaseChannelFilter = 'prerelease'; switchTab('releases'); if (isLiveMode) renderLiveReleases(); }});
    list.push({ icon: '\u{1F30D}', label: 'Filter Releases: All', hint: 'Filter', action: () => { closeCmdPalette(); releaseChannelFilter = 'all'; switchTab('releases'); if (isLiveMode) renderLiveReleases(); }});

    // Phase 7 actions
    if (isLiveMode) {
      list.push({ icon: '\u{1F4CB}', label: 'Contribution Guidelines', hint: 'Info', action: () => { closeCmdPalette(); showGuidelinesModal(); }});
    }

    // Saved searches
    getSavedSearches().forEach(s => {
      list.push({ icon: '\u2B50', label: s.name, hint: `Saved: ${s.query}`, action: () => { 
        if (input) {
          input.value = s.query; 
          input.dispatchEvent(new Event('input')); 
          addRecentSearch(s.query);
        }
      }});
    });

    // Recent searches (last 5)
    getRecentSearches().forEach(q => {
      list.push({ icon: '\u{1F553}', label: q, hint: 'Recent', action: () => { 
        if (input) {
          input.value = q; 
          input.dispatchEvent(new Event('input')); 
        }
      }});
    });

    // Saved workspaces
    getSavedWorkspaces().forEach(ws => {
      list.push({ icon: '\u{1F4CB}', label: `Workspace: ${ws.name}`, hint: `Tab: ${ws.tab}`, action: () => { closeCmdPalette(); loadWorkspace(ws.name); }});
    });

    return list;
  }

  function renderResults(filtered: CmdItem[]): void {
    const resultsEl = results;
    if (!resultsEl) return;

    if (filtered.length === 0) {
      resultsEl.innerHTML = `<div style="padding:16px;font-size:13px;color:var(--hub-text-muted);text-align:center">No results</div>`;
      return;
    }
    resultsEl.innerHTML = filtered.map((item, i) =>
      `<div class="cmd-result${i === activeIndex ? ' active' : ''}" data-cmd-idx="${i}">
        <span class="cmd-result__icon">${item.icon}</span>
        <span class="cmd-result__label">${item.label}</span>
        <span class="cmd-result__hint">${item.hint}</span>
      </div>`
    ).join('');

    resultsEl.querySelectorAll<HTMLElement>('.cmd-result').forEach(el => {
      el.addEventListener('click', () => {
        const idxStr = el.dataset.cmdIdx;
        if (idxStr) {
          const idx = parseInt(idxStr, 10);
          filtered[idx]?.action();
        }
      });
    });
  }

  function openCmdPalette(): void {
    if (!input || !overlay) return;
    items = buildItems();
    activeIndex = 0;
    input.value = '';
    overlay.setAttribute('aria-hidden', 'false');
    renderResults(items);
    input.focus();
  }

  function closeCmdPalette(): void {
    if (!overlay) return;
    overlay.setAttribute('aria-hidden', 'true');
  }

  function filterItems(query: string): CmdItem[] {
    if (!query) return items;

    // Query language mode
    if (isQueryInput(query)) {
      const parsed = parseQuery(query);
      const queryResults = executeQuery(parsed);
      
      // Save to recent searches
      addRecentSearch(query);
      
      return queryResults.map(r => ({
        icon: r.type === 'PR' ? '\u{1F501}' : '\u{1F4CB}',
        label: r.label,
        hint: r.type,
        action: r.action,
      }));
    }

    const q = query.toLowerCase();
    return items.filter(item =>
      item.label.toLowerCase().includes(q) ||
      item.hint.toLowerCase().includes(q)
    );
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Ctrl+K / Cmd+K to open
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (overlay.getAttribute('aria-hidden') === 'false') closeCmdPalette();
      else openCmdPalette();
      return;
    }

    // / key (when not in an input) to open
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
      e.preventDefault();
      openCmdPalette();
      return;
    }
  });

  // Input filtering
  input.addEventListener('input', () => {
    activeIndex = 0;
    const filtered = filterItems(input.value);
    renderResults(filtered);
  });

  // Arrow nav + Enter
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const filtered = filterItems(input.value);
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, filtered.length - 1); renderResults(filtered); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); renderResults(filtered); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[activeIndex]?.action(); }
    else if (e.key === 'Escape') { closeCmdPalette(); }
  });

  // Click outside
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCmdPalette(); });

  // Topbar search click opens palette
  const searchBox = $('.topbar__search');
  if (searchBox) searchBox.addEventListener('click', openCmdPalette);
}

// ───── Risk Score + Suggested Questions ─────

interface RiskResult {
  score: number;
  reasons: string[];
  level: 'low' | 'medium' | 'high' | 'critical';
}

function computeRiskScore(diff: DeckPatchOp[]): RiskResult {
  let score = 0;
  const reasons: string[] = [];
  if (!diff || diff.length === 0) return { score: 0, reasons: ['No changes'], level: 'low' };

  const boards = new Set(diff.map(d => d.board).filter(Boolean));
  const cardCount = diff.filter(d => d.op === 'add_card' || d.op === 'remove_card').reduce((s, d) => s + (d.qty || 1), 0);

  // Commander changed
  if (diff.some(d => d.board === 'commander')) { score += 5; reasons.push('Commander changed'); }
  // Manabase touched
  if (diff.some(d => d.board === 'mainboard' && (d.name?.toLowerCase().includes('land') || (d.tags as string[] | undefined)?.includes('land')))) {
    score += 3; reasons.push('Manabase touched');
  }
  // Sideboard touched
  if (diff.some(d => d.board === 'sideboard')) { score += 2; reasons.push('Sideboard modified'); }
  // Many cards changed
  if (cardCount > 10) { score += 3; reasons.push(`${cardCount} cards changed`); }
  else if (cardCount > 5) { score += 2; reasons.push(`${cardCount} cards changed`); }
  // Multiple sections
  if (boards.size >= 3) { score += 2; reasons.push(`${boards.size} sections affected`); }
  // Meta changes
  if (diff.some(d => d.op === 'set_meta')) { score += 1; reasons.push('Metadata changed'); }
  // Moves
  const moves = diff.filter(d => d.op === 'move_card').length;
  if (moves > 3) { score += 2; reasons.push(`${moves} cards moved between boards`); }

  const level: RiskResult['level'] = score >= 10 ? 'critical' : score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low';
  if (reasons.length === 0) reasons.push('Minor changes');
  return { score, reasons, level };
}

function getSuggestedQuestions(diff: DeckPatchOp[]): string[] {
  if (!diff || diff.length === 0) return [];
  const questions: string[] = [];
  const hasSideboard = diff.some(d => d.board === 'sideboard');
  const hasManabase = diff.some(d => d.board === 'mainboard' && ((d.tags as string[] | undefined)?.includes('land') || d.name?.toLowerCase().includes('land')));
  const hasCommander = diff.some(d => d.board === 'commander');
  const hasRemoval = diff.some(d => (d.tags as string[] | undefined)?.includes('removal') || (d.tags as string[] | undefined)?.includes('interaction'));
  const hasRamp = diff.some(d => (d.tags as string[] | undefined)?.includes('ramp'));
  const hasDraw = diff.some(d => (d.tags as string[] | undefined)?.includes('draw'));
  const addCount = diff.filter(d => d.op === 'add_card').length;
  const removeCount = diff.filter(d => d.op === 'remove_card').length;

  if (hasSideboard) {
    questions.push('What matchups does this sideboard change address?');
    questions.push('Is graveyard hate coverage still sufficient?');
  }
  if (hasManabase) {
    questions.push('Are color pip requirements still met for T1-T3 curve?');
    questions.push('Enough untapped sources for the game plan?');
  }
  if (hasCommander) {
    questions.push('Does the new commander align with existing synergy packages?');
    questions.push('Are power level constraints still respected?');
  }
  if (hasRemoval) {
    questions.push('Is interaction density still sufficient (creature vs noncreature)?');
  }
  if (hasRamp) {
    questions.push('Does ramp count still hit T3-T4 acceleration targets?');
  }
  if (hasDraw) {
    questions.push('Is card advantage density maintained?');
  }
  if (addCount > 5 && removeCount > 5) {
    questions.push('Is this a major overhaul? Consider splitting into smaller PRs.');
  }
  return questions.slice(0, 5); // max 5 questions
}

function renderRiskBadge(risk: RiskResult): string {
  const colors: Record<string, string> = {
    low: 'var(--hub-green)', medium: 'var(--hub-orange)', high: 'var(--hub-red)', critical: '#ff1744',
  };
  const icons: Record<string, string> = { low: '\u{1F7E2}', medium: '\u{1F7E1}', high: '\u{1F7E0}', critical: '\u{1F534}' };
  return `<span class="pr-modal__risk-badge pr-modal__risk-badge--${risk.level}" style="color:${colors[risk.level]}" title="${risk.reasons.join(', ')}">${icons[risk.level]} ${risk.level.charAt(0).toUpperCase() + risk.level.slice(1)} Risk</span>`;
}

// ───── Diff Filter + Focus Mode ─────

interface DiffFilter {
  board: string; // 'all' | 'mainboard' | 'sideboard' | 'commander'
  opType: string; // 'all' | 'add' | 'remove' | 'move'
}

let currentDiffFilter: DiffFilter = { board: 'all', opType: 'all' };
let focusModeActive = false;
let focusModeStep = 0;
let focusModeSections: string[] = [];

function filterDiffOps(diff: DeckPatchOp[], filter: DiffFilter): DeckPatchOp[] {
  return diff.filter(op => {
    if (filter.board !== 'all' && op.board !== filter.board) return false;
    if (filter.opType !== 'all') {
      if (filter.opType === 'add' && op.op !== 'add_card') return false;
      if (filter.opType === 'remove' && op.op !== 'remove_card') return false;
      if (filter.opType === 'move' && op.op !== 'move_card') return false;
    }
    return true;
  });
}

function getDiffSections(diff: DeckPatchOp[]): string[] {
  const sections = new Set<string>();
  diff.forEach(op => {
    if (op.board) sections.add(op.board);
    if (op.op === 'set_meta') sections.add('meta');
  });
  return Array.from(sections);
}

function renderDiffFilterToolbar(diff: DeckPatchOp[]): string {
  const boards = new Set(diff.map(d => d.board).filter(Boolean));
  const boardOptions = ['all', ...Array.from(boards)];
  return `<div class="pr-modal__diff-toolbar">
    <div class="pr-modal__diff-filter-group">
      <label class="pr-modal__diff-filter-label">Board:</label>
      ${boardOptions.map(b => `<button class="hub-chip hub-chip--sm pr-modal__diff-filter-btn ${currentDiffFilter.board === b ? 'hub-chip--active' : ''}" data-filter-board="${b}">${b}</button>`).join('')}
    </div>
    <div class="pr-modal__diff-filter-group">
      <label class="pr-modal__diff-filter-label">Type:</label>
      ${['all', 'add', 'remove', 'move'].map(t => `<button class="hub-chip hub-chip--sm pr-modal__diff-filter-btn ${currentDiffFilter.opType === t ? 'hub-chip--active' : ''}" data-filter-type="${t}">${t === 'all' ? 'All' : t === 'add' ? '+ Adds' : t === 'remove' ? '- Removes' : '\u21C4 Moves'}</button>`).join('')}
    </div>
    <button class="hub-btn hub-btn--xs pr-modal__focus-toggle" id="btnToggleFocusMode">${focusModeActive ? '\u{1F50D} Exit Focus' : '\u{1F50D} Focus Mode'}</button>
  </div>`;
}

function renderFocusBar(): string {
  if (!focusModeActive || focusModeSections.length === 0) return '';
  const current = focusModeSections[focusModeStep] || '?';
  return `<div class="pr-modal__focus-bar">
    <div class="pr-modal__focus-progress">
      <div class="pr-modal__focus-progress-fill" style="width:${((focusModeStep + 1) / focusModeSections.length) * 100}%"></div>
    </div>
    <div class="pr-modal__focus-info">
      <span>Reviewing: <strong>${current}</strong></span>
      <span class="pr-modal__focus-step">${focusModeStep + 1}/${focusModeSections.length}</span>
    </div>
    <div class="pr-modal__focus-nav">
      <button class="hub-btn hub-btn--xs" id="btnFocusPrev" ${focusModeStep <= 0 ? 'disabled' : ''}>\u2190 Prev</button>
      <button class="hub-btn hub-btn--xs" id="btnFocusNext" ${focusModeStep >= focusModeSections.length - 1 ? 'disabled' : ''}>Next \u2192</button>
    </div>
  </div>`;
}

// ───── Diff Rendering ─────

function renderDiffOp(op: DeckPatchOp): string {
  const name = (op as any).name || '?';
  
  // Helper to get card image URL
  const getCardImage = (cardName: string): string => {
    for (const board of Object.values(liveCards)) {
      const found = board.find(c => c.name === cardName);
      if (found?.image) return found.image;
    }
    return '';
  };

  const imageUrl = getCardImage(name);
  const imagePreview = imageUrl 
    ? `<div class="diff-image-preview"><img src="${imageUrl}" alt="${escapeHtml(name)}" loading="lazy"></div>` 
    : '';

  switch (op.op) {
    case 'add_card': {
      const qty = (op as any).qty || 1;
      const board = (op as any).board || 'mainboard';
      return `
        <div class="pr-modal__diff-line pr-modal__diff-line--add">
          <div style="display:flex;align-items:center;gap:12px">
            <span>+ ${qty}x ${escapeHtml(name)} (${board})</span>
            ${imagePreview}
          </div>
        </div>`;
    }
    case 'remove_card': {
      const qty = (op as any).qty || 1;
      const board = (op as any).board || 'mainboard';
      return `
        <div class="pr-modal__diff-line pr-modal__diff-line--remove">
          <div style="display:flex;align-items:center;gap:12px">
            <span>- ${qty}x ${escapeHtml(name)} (${board})</span>
            ${imagePreview}
          </div>
        </div>`;
    }
    case 'move_card': {
      const fromBoard = (op as any).fromBoard || (op as any).from || 'mainboard';
      const toBoard = (op as any).toBoard || (op as any).to || 'sideboard';
      return `
        <div class="pr-modal__diff-line pr-modal__diff-line--move">
          <div style="display:flex;align-items:center;gap:12px">
            <span>${escapeHtml(name)}:</span>
            <div class="diff-move-images">
              ${imageUrl ? `<div class="diff-image-preview" title="From: ${fromBoard}"><img src="${imageUrl}" alt="${escapeHtml(name)}" loading="lazy"></div>` : ''}
              <span class="diff-move-arrow">→</span>
              ${imageUrl ? `<div class="diff-image-preview" title="To: ${toBoard}"><img src="${imageUrl}" alt="${escapeHtml(name)}" loading="lazy"></div>` : ''}
            </div>
            <span style="color:var(--hub-text-muted)">${fromBoard} → ${toBoard}</span>
          </div>
        </div>`;
    }
    case 'update_qty': {
      const oldQty = (op as any).oldQty || 0;
      const newQty = (op as any).newQty || 1;
      const board = (op as any).board || 'mainboard';
      return `
        <div class="pr-modal__diff-line pr-modal__diff-line--meta">
          <div style="display:flex;align-items:center;gap:12px">
            <span>~ ${escapeHtml(name)}: ${oldQty}x → ${newQty}x (${board})</span>
            ${imagePreview}
          </div>
        </div>`;
    }
    case 'set_tag': {
      const tag = (op as any).tag || '?';
      const value = (op as any).value ? 'add' : 'remove';
      const board = (op as any).board || 'mainboard';
      return `<div class="pr-modal__diff-line pr-modal__diff-line--meta">⚙ ${escapeHtml(name)}: ${value} tag "${escapeHtml(tag)}" (${board})</div>`;
    }
    case 'set_meta':
      return `<div class="pr-modal__diff-line pr-modal__diff-line--meta">\u{1F4DD} Meta: ${escapeHtml(String((op as any).key || '?'))} = ${escapeHtml(String((op as any).value || ''))}</div>`;
    default:
      return `<div class="pr-modal__diff-line">${escapeHtml(op.op)}: ${escapeHtml(JSON.stringify(op))}</div>`;
  }
}

// ───── Branch Compare ─────

interface CompareCard { name: string; qtyA: number; qtyB: number; boardA: string; boardB: string; status: 'added' | 'removed' | 'changed' | 'same' }

function openBranchCompareModal(): void {
  const modal = $('#branchCompareModal');
  if (!modal) return;
  const selectA = $<HTMLSelectElement>('#compareSelectA');
  const selectB = $<HTMLSelectElement>('#compareSelectB');
  if (!selectA || !selectB) return;

  const branches = isLiveMode ? liveBranches : BRANCHES.map((b, i) => ({ ...b, id: `demo-${i}`, headCommitId: null, isProtected: false }));
  const optionsHTML = branches.map(b => `<option value="${(b as AdaptedBranch).id || b.name}">${b.name}${(b as AdaptedBranch).isDefault ? ' (default)' : ''}</option>`).join('');
  selectA.innerHTML = optionsHTML;
  selectB.innerHTML = optionsHTML;
  if (branches.length > 1) selectB.selectedIndex = 1;

  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeBranchCompareModal(): void {
  const modal = $('#branchCompareModal');
  if (modal) { modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; }
}

async function runBranchCompare(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Branch compare requires a live repo', 'info');
    return;
  }
  const selectA = $<HTMLSelectElement>('#compareSelectA');
  const selectB = $<HTMLSelectElement>('#compareSelectB');
  const resultEl = $('#branchCompareResult');
  if (!selectA || !selectB || !resultEl) return;

  const branchA = liveBranches.find(b => b.id === selectA.value);
  const branchB = liveBranches.find(b => b.id === selectB.value);
  if (!branchA?.headCommitId || !branchB?.headCommitId) {
    resultEl.innerHTML = '<div style="text-align:center;color:var(--hub-text-muted);padding:20px">One or both branches have no commits</div>';
    return;
  }

  resultEl.innerHTML = '<div class="hub-skeleton hub-skeleton-row" style="height:120px"></div>';
  try {
    const [stateA, stateB] = await Promise.all([
      commitApi.getState(repoId, branchA.headCommitId),
      commitApi.getState(repoId, branchB.headCommitId),
    ]);

    const cardsA = new Map<string, { qty: number; board: string }>();
    const cardsB = new Map<string, { qty: number; board: string }>();

    ['commander', 'mainboard', 'sideboard', 'maybeboard'].forEach(board => {
      (stateA.boards as Record<string, { name: string; qty: number }[]>)[board]?.forEach(c => {
        cardsA.set(`${board}:${c.name}`, { qty: c.qty, board });
      });
      (stateB.boards as Record<string, { name: string; qty: number }[]>)[board]?.forEach(c => {
        cardsB.set(`${board}:${c.name}`, { qty: c.qty, board });
      });
    });

    const allKeys = new Set([...cardsA.keys(), ...cardsB.keys()]);
    const compared: CompareCard[] = [];
    let added = 0, removed = 0, changed = 0;

    allKeys.forEach(key => {
      const a = cardsA.get(key);
      const b = cardsB.get(key);
      const name = key.split(':').slice(1).join(':');
      if (!a && b) { compared.push({ name, qtyA: 0, qtyB: b.qty, boardA: '', boardB: b.board, status: 'added' }); added++; }
      else if (a && !b) { compared.push({ name, qtyA: a.qty, qtyB: 0, boardA: a.board, boardB: '', status: 'removed' }); removed++; }
      else if (a && b && a.qty !== b.qty) { compared.push({ name, qtyA: a.qty, qtyB: b.qty, boardA: a.board, boardB: b.board, status: 'changed' }); changed++; }
      else if (a && b) { compared.push({ name, qtyA: a.qty, qtyB: b.qty, boardA: a.board, boardB: b.board, status: 'same' }); }
    });

    const totalA = [...cardsA.values()].reduce((s, c) => s + c.qty, 0);
    const totalB = [...cardsB.values()].reduce((s, c) => s + c.qty, 0);

    const changedCards = compared.filter(c => c.status !== 'same');
    const displayCards = changedCards.length > 0 ? changedCards : compared.slice(0, 20);

    resultEl.innerHTML = `
      <div class="branch-compare__stats">
        <div class="branch-compare__stat"><strong>${branchA.name}</strong>: ${totalA} cards</div>
        <div class="branch-compare__stat"><strong>${branchB.name}</strong>: ${totalB} cards</div>
        <div class="branch-compare__stat branch-compare__stat--add">+${added} added</div>
        <div class="branch-compare__stat branch-compare__stat--remove">-${removed} removed</div>
        <div class="branch-compare__stat branch-compare__stat--change">~${changed} changed</div>
      </div>
      <div class="branch-compare__grid">
        <div class="branch-compare__column">
          <div class="branch-compare__column-title">${escapeHtml(branchA.name)}</div>
          ${displayCards.map(c => `<div class="branch-compare__card branch-compare__card--${c.status}">${c.qtyA > 0 ? `${c.qtyA}x ` : ''}${escapeHtml(c.name)}${c.status === 'removed' ? ' \u2717' : ''}</div>`).join('')}
        </div>
        <div class="branch-compare__column">
          <div class="branch-compare__column-title">${escapeHtml(branchB.name)}</div>
          ${displayCards.map(c => `<div class="branch-compare__card branch-compare__card--${c.status}">${c.qtyB > 0 ? `${c.qtyB}x ` : ''}${escapeHtml(c.name)}${c.status === 'added' ? ' \u2713' : ''}</div>`).join('')}
        </div>
      </div>`;
  } catch (err) {
    resultEl.innerHTML = `<div style="text-align:center;color:var(--hub-red);padding:20px">Compare failed: ${err instanceof Error ? err.message : 'Unknown error'}</div>`;
  }
}

function initBranchCompare(): void {
  const closeBtn = $('#branchCompareClose');
  if (closeBtn) closeBtn.addEventListener('click', closeBranchCompareModal);
  const modal = $('#branchCompareModal');
  if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeBranchCompareModal(); });
  const runBtn = $('#btnRunCompare');
  if (runBtn) runBtn.addEventListener('click', runBranchCompare);
}

// ───── Saved Workspaces ─────

interface Workspace { name: string; tab: string; branch: string; filters: Record<string, string> }

function getSavedWorkspaces(): Workspace[] {
  try { return JSON.parse(localStorage.getItem('deckhub_workspaces') || '[]'); } catch { return []; }
}

function saveWorkspace(name: string): void {
  const ws: Workspace = {
    name,
    tab: document.querySelector('.hub-tab.active')?.getAttribute('data-tab') || 'code',
    branch: $<HTMLSelectElement>('#branchSelect')?.value || 'main',
    filters: { issueFilter },
  };
  const all = getSavedWorkspaces().filter(w => w.name !== name);
  all.push(ws);
  localStorage.setItem('deckhub_workspaces', JSON.stringify(all));
  showToast(`Workspace "${name}" saved`, 'success');
}

function loadWorkspace(name: string): void {
  const all = getSavedWorkspaces();
  const ws = all.find(w => w.name === name);
  if (!ws) return;
  // Switch tab
  const tabBtn = document.querySelector(`.hub-tab[data-tab="${ws.tab}"]`) as HTMLElement;
  if (tabBtn) tabBtn.click();
  showToast(`Workspace "${name}" loaded`, 'info');
}

function deleteWorkspace(name: string): void {
  const all = getSavedWorkspaces().filter(w => w.name !== name);
  localStorage.setItem('deckhub_workspaces', JSON.stringify(all));
  showToast(`Workspace "${name}" deleted`, 'info');
}

// ───── Query Language ─────

interface QueryFilter { type?: string; status?: string; label?: string; board?: string; op?: string; text?: string }

function parseQuery(input: string): QueryFilter {
  const filter: QueryFilter = {};
  const parts = input.trim().split(/\s+/);
  for (const part of parts) {
    const [key, ...vals] = part.split(':');
    const val = vals.join(':');
    if (key === 'type' && val) filter.type = val;
    else if (key === 'status' && val) filter.status = val;
    else if (key === 'label' && val) filter.label = val;
    else if (key === 'board' && val) filter.board = val;
    else if (key === 'op' && val) filter.op = val;
    else filter.text = (filter.text ? filter.text + ' ' : '') + part;
  }
  return filter;
}

function isQueryInput(input: string): boolean {
  return /^(type|status|label|board|op):/.test(input.trim());
}

function executeQuery(query: QueryFilter): { type: string; label: string; action: () => void }[] {
  const results: { type: string; label: string; action: () => void }[] = [];

  if (!query.type || query.type === 'pr') {
    livePRs.filter(pr => {
      if (query.status && pr.status !== query.status) return false;
      if (query.text && !pr.title.toLowerCase().includes(query.text.toLowerCase())) return false;
      return true;
    }).forEach(pr => {
      results.push({ type: 'PR', label: `#${pr.number} ${pr.title}`, action: () => openLivePRModal(pr.number) });
    });
  }

  if (!query.type || query.type === 'issue') {
    liveIssues.filter(issue => {
      if (query.status && issue.status !== query.status) return false;
      if (query.label && !issue.labels.includes(query.label)) return false;
      if (query.text && !issue.title.toLowerCase().includes(query.text.toLowerCase())) return false;
      return true;
    }).forEach(issue => {
      results.push({ type: 'Issue', label: `#${issue.number} ${issue.title}`, action: () => {} });
    });
  }

  return results;
}

// ───── Saved Searches ─────

interface SavedSearch { name: string; query: string }

function getSavedSearches(): SavedSearch[] {
  try { return JSON.parse(localStorage.getItem('deckhub_saved_searches') || '[]'); } catch { return []; }
}

function addSavedSearch(name: string, query: string): void {
  const all = getSavedSearches().filter(s => s.name !== name);
  all.push({ name, query });
  localStorage.setItem('deckhub_saved_searches', JSON.stringify(all));
  showToast(`Search "${name}" saved`, 'success');
}

function deleteSavedSearch(name: string): void {
  const all = getSavedSearches().filter(s => s.name !== name);
  localStorage.setItem('deckhub_saved_searches', JSON.stringify(all));
}

// ───── Recent Searches ─────

function getRecentSearches(): string[] {
  try { 
    return JSON.parse(localStorage.getItem('deckhub_recent_searches') || '[]'); 
  } catch { 
    return []; 
  }
}

function addRecentSearch(query: string): void {
  if (!query.trim()) return;
  
  const searches = getRecentSearches().filter(q => q !== query);
  searches.unshift(query.trim());
  
  // Keep only last 10
  while (searches.length > 10) {
    searches.pop();
  }
  
  localStorage.setItem('deckhub_recent_searches', JSON.stringify(searches));
}

// ───── Semantic Commits + Auto-Squash ─────

interface SemanticCommit {
  type: string | null;
  scope: string | null;
  description: string;
}

function parseSemanticCommit(msg: string): SemanticCommit {
  const match = msg.match(/^(feat|fix|chore|meta|refactor|style)\(([^)]+)\):\s*(.+)/i);
  if (match) return { type: match[1].toLowerCase(), scope: match[2], description: match[3] };
  // Also try without scope
  const match2 = msg.match(/^(feat|fix|chore|meta|refactor|style):\s*(.+)/i);
  if (match2) return { type: match2[1].toLowerCase(), scope: null, description: match2[2] };
  return { type: null, scope: null, description: msg };
}

function renderSemanticBadge(type: string | null): string {
  if (!type) return '';
  return `<span class="hub-commit-type hub-commit-type--${type}">${type}</span>`;
}

function generateSquashMessage(commits: AdaptedCommit[]): string {
  if (commits.length === 0) return '';
  if (commits.length === 1) return commits[0].message;

  const grouped = new Map<string, string[]>();
  for (const c of commits) {
    const parsed = parseSemanticCommit(c.message);
    const key = parsed.type || 'changes';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(parsed.scope ? `${parsed.scope}: ${parsed.description}` : parsed.description);
  }

  const parts: string[] = [];
  for (const [type, descs] of grouped) {
    if (descs.length === 1) parts.push(`${type}: ${descs[0]}`);
    else parts.push(`${type}: ${descs.join('; ')}`);
  }
  return parts.join('\n');
}

// ───── Changelog by Package ─────

interface ChangelogEntry {
  commitId: string;
  time: string;
  author: string;
  op: string;
  cardName: string;
  board: string;
  qty?: number;
}

function buildPackageChangelog(commits: AdaptedCommit[], rawCommits: { id: string; patch: DeckPatchOp[]; authorName: string; createdAt: string }[]): Map<string, ChangelogEntry[]> {
  const changelog = new Map<string, ChangelogEntry[]>();

  for (const raw of rawCommits) {
    if (!raw.patch || !Array.isArray(raw.patch)) continue;
    for (const op of raw.patch) {
      let section = 'other';
      if (op.op === 'add_card' || op.op === 'remove_card') {
        section = op.board || 'mainboard';
      } else if (op.op === 'move_card') {
        section = (op as any).toBoard || 'mainboard';
      } else if (op.op === 'update_qty') {
        section = op.board || 'mainboard';
      } else if (op.op === 'set_meta') {
        section = 'meta';
      } else if (op.op === 'set_tag') {
        section = op.board || 'mainboard';
      }

      if (!changelog.has(section)) changelog.set(section, []);
      changelog.get(section)!.push({
        commitId: raw.id.slice(0, 7),
        time: timeAgoFromISO(raw.createdAt),
        author: raw.authorName,
        op: op.op,
        cardName: (op as { name?: string }).name || (op as { key?: string }).key || '?',
        board: section,
        qty: (op as { qty?: number }).qty,
      });
    }
  }

  return changelog;
}

function renderChangelogSection(section: string, entries: ChangelogEntry[]): string {
  const sectionNames: Record<string, string> = {
    commander: '\u{1F451} Commander', mainboard: '\u{1F0CF} Mainboard',
    sideboard: '\u{1F4E6} Sideboard', maybeboard: '\u{1F914} Maybeboard', meta: '\u{1F4DD} Metadata', other: '\u{1F4E2} Other',
  };
  const displayEntries = entries.slice(0, 20); // Limit display
  return `<div class="hub-changelog__section">
    <div class="hub-changelog__header" onclick="this.parentElement.classList.toggle('open')">
      <span>${sectionNames[section] || section}</span>
      <span class="hub-changelog__count">${entries.length} change${entries.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="hub-changelog__body">
      ${displayEntries.map(e => {
        const opClass = e.op === 'add_card' ? 'add' : e.op === 'remove_card' ? 'remove' : e.op === 'move_card' ? 'move' : '';
        const opSymbol = e.op === 'add_card' ? '+' : e.op === 'remove_card' ? '-' : e.op === 'move_card' ? '\u21C4' : '\u00B7';
        return `<div class="hub-changelog__entry">
          <span class="hub-changelog__entry-op hub-changelog__entry-op--${opClass}">${opSymbol}</span>
          <span class="hub-changelog__entry-name">${e.qty ? `${e.qty}x ` : ''}${escapeHtml(e.cardName)}</span>
          <span class="hub-changelog__entry-meta">${e.author} &middot; ${e.time}</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ───── Blame Popover ─────

let activeBlamePopover: HTMLElement | null = null;

function renderBlamePopover(blame: BlameEntry): string {
  const intro = blame.introduced
    ? `<div class="hub-blame__row">
        <span class="hub-blame__label">Introduced by</span>
        <span class="hub-blame__value">@${escapeHtml(blame.introduced.authorName)}</span>
        <span class="hub-blame__time">${timeAgoFromISO(blame.introduced.time)}</span>
      </div>
      <div class="hub-blame__msg">${escapeHtml(blame.introduced.message.slice(0, 60))}</div>`
    : '<div class="hub-blame__row"><span class="hub-blame__label">Origin unknown</span></div>';

  const last = blame.lastChanged
    ? `<div class="hub-blame__row">
        <span class="hub-blame__label">Last changed by</span>
        <span class="hub-blame__value">@${escapeHtml(blame.lastChanged.authorName)}</span>
        <span class="hub-blame__time">${timeAgoFromISO(blame.lastChanged.time)}</span>
      </div>
      <div class="hub-blame__msg">${escapeHtml(blame.lastChanged.message.slice(0, 60))}</div>`
    : '';

  return `<div class="hub-blame-popover">
    <div class="hub-blame__header">\u{1F50D} Blame: ${escapeHtml(blame.cardName)}</div>
    ${intro}
    ${last}
    <div class="hub-blame__footer">Changed ${blame.changeCount} time${blame.changeCount !== 1 ? 's' : ''} total</div>
  </div>`;
}

async function showBlamePopover(cardName: string, targetEl: HTMLElement): Promise<void> {
  // Remove any existing popover
  if (activeBlamePopover) { activeBlamePopover.remove(); activeBlamePopover = null; }
  if (!repoId || !isLiveMode) return;

  const defaultBranch = rawBranches.find(b => liveBranches.find(lb => lb.isDefault && lb.name === b.name));
  if (!defaultBranch) return;

  try {
    const blame = await blameApi.getCard(repoId, defaultBranch.id, cardName);
    const popover = document.createElement('div');
    popover.innerHTML = renderBlamePopover(blame);
    const pop = popover.firstElementChild as HTMLElement;
    document.body.appendChild(pop);
    activeBlamePopover = pop;

    // Position near the target element
    const rect = targetEl.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
    pop.style.zIndex = '9999';

    // Auto-close on click outside
    const closeHandler = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== targetEl) {
        pop.remove();
        activeBlamePopover = null;
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 50);
  } catch (err) {
    showToast(`Blame unavailable: ${(err as Error).message}`, 'error');
  }
}

// ───── Revert PR ─────

async function revertPR(prNumber: number): Promise<void> {
  if (!repoId) return;
  try {
    const result = await prApi.revert(repoId, prNumber);
    showToast(`Revert PR created: #${result.pr.number}`, 'success');
    // Refresh PR list
    const [open, closed] = await Promise.all([
      prApi.list(repoId, 'open').catch(() => []),
      prApi.list(repoId, 'closed').catch(() => []),
    ]);
    rawPRs = [...open, ...closed];
    livePRs = adaptPRList(rawPRs, rawBranches);
    renderLivePRList();
    const countPRs = $('#countPRs');
    if (countPRs) countPRs.textContent = String(open.length);
  } catch (err) {
    showToast(`Revert failed: ${(err as Error).message}`, 'error');
  }
}

// ───── Cherry-pick ─────

async function cherryPickCommit(commitId: string, targetBranchId: string): Promise<void> {
  if (!repoId) return;
  try {
    const result = await commitApi.cherryPick(repoId, commitId, targetBranchId);
    if (result.conflicts && result.conflicts.length > 0) {
      showToast(`Cherry-pick has ${result.conflicts.length} conflict(s): ${result.conflicts.map(c => c.cardName).join(', ')}`, 'error');
    } else {
      showToast('Cherry-pick successful!', 'success');
    }
  } catch (err) {
    showToast(`Cherry-pick failed: ${(err as Error).message}`, 'error');
  }
}

// ───── Golden Deck State ─────

async function setGoldenState(commitId: string | null): Promise<void> {
  if (!repoId) return;
  try {
    await goldenApi.set(repoId, commitId);
    goldenDrift = await goldenApi.get(repoId);
    showToast(commitId ? 'Golden state set!' : 'Golden state cleared', 'success');
    renderLiveInsights();
  } catch (err) {
    showToast(`Golden state error: ${(err as Error).message}`, 'error');
  }
}

function renderGoldenDriftBadge(): string {
  if (!goldenDrift?.drift) return '';
  const d = goldenDrift.drift;
  const level = d.driftPercent <= 5 ? 'low' : d.driftPercent <= 15 ? 'medium' : d.driftPercent <= 30 ? 'high' : 'critical';
  return `<span class="hub-golden-drift hub-golden-drift--${level}" title="Golden state drift: +${d.added}/-${d.removed} cards (${d.driftPercent}%)">
    \u2B50 ${d.driftPercent}% drift
  </span>`;
}

// ───── Review Checklist Templates ─────

const DEFAULT_EDH_CHECKLIST = [
  'Ramp count \u22658?',
  'Draw count \u226510?',
  'Interaction \u22658?',
  'Mana curve acceptable?',
  'Power level consistent?',
  'Playgroup rules OK?',
];

const DEFAULT_CONSTRUCTED_CHECKLIST = [
  'Sideboard plan complete?',
  'Matchup coverage verified?',
  'Curve/pip distribution OK?',
  'Budget within limit?',
  'Meta-relevant hate included?',
];

function getChecklistTemplate(): string[] {
  if (liveSettings && Array.isArray((liveSettings as Record<string, unknown>).reviewChecklist)) {
    return (liveSettings as { reviewChecklist: string[] }).reviewChecklist;
  }
  // Default based on deck format
  if (liveDeckMeta?.format === 'commander' || liveDeckMeta?.format === 'edh') return DEFAULT_EDH_CHECKLIST;
  return DEFAULT_CONSTRUCTED_CHECKLIST;
}

function getChecklistState(prNumber: number): Record<number, boolean> {
  try {
    const key = `deckhub_checklist_${repoId}_${prNumber}`;
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch { return {}; }
}

function setChecklistState(prNumber: number, state: Record<number, boolean>): void {
  try {
    const key = `deckhub_checklist_${repoId}_${prNumber}`;
    localStorage.setItem(key, JSON.stringify(state));
  } catch { /* ignore */ }
}

function renderChecklist(prNumber: number): string {
  const template = getChecklistTemplate();
  if (template.length === 0) return '';
  const state = getChecklistState(prNumber);
  const checked = Object.values(state).filter(Boolean).length;
  return `<div class="pr-modal__section">
    <div class="pr-modal__section-title">\u{1F4CB} Review Checklist <span class="pr-modal__checklist-progress">${checked}/${template.length}</span></div>
    <div class="pr-modal__checklist" id="prChecklist">
      ${template.map((item, i) => `
        <label class="pr-modal__checklist-item">
          <input type="checkbox" data-idx="${i}" ${state[i] ? 'checked' : ''} />
          <span>${escapeHtml(item)}</span>
        </label>
      `).join('')}
    </div>
  </div>`;
}

// ───── Guarded Areas Badge ─────

function getGuardedSections(): Array<{ section: string; requiredApprovals: number }> {
  if (liveSettings && Array.isArray((liveSettings as Record<string, unknown>).guardedSections)) {
    return (liveSettings as { guardedSections: Array<{ section: string; requiredApprovals: number }> }).guardedSections;
  }
  return [];
}

function renderGuardedBadges(diff: DeckPatchOp[]): string {
  const guarded = getGuardedSections();
  if (guarded.length === 0 || !diff.length) return '';

  const affectedBoards = new Set<string>();
  for (const op of diff) {
    if ('board' in op && (op as any).board) affectedBoards.add((op as any).board);
    if ('fromBoard' in op) affectedBoards.add((op as any).fromBoard);
    if ('toBoard' in op) affectedBoards.add((op as any).toBoard);
  }

  const matches = guarded.filter(g => affectedBoards.has(g.section));
  if (matches.length === 0) return '';

  return matches.map(g =>
    `<span class="hub-guarded-badge">\u{1F6E1}\uFE0F ${g.section} (needs ${g.requiredApprovals} approvals)</span>`
  ).join(' ');
}

// ───── Automerge Toggle ─────

async function toggleAutoMerge(prNumber: number, enabled: boolean): Promise<void> {
  if (!repoId) return;
  try {
    const result = await prApi.setAutoMerge(repoId, prNumber, enabled);
    if (result.merged) {
      showToast('Auto-merge triggered — PR merged!', 'success');
    } else {
      showToast(enabled ? 'Auto-merge enabled' : 'Auto-merge disabled', 'success');
    }
  } catch (err) {
    showToast(`Auto-merge error: ${(err as Error).message}`, 'error');
  }
}

// ───── Suggested Reviewers ─────

async function loadSuggestedReviewers(prNumber: number): Promise<void> {
  if (!repoId || !isLiveMode) return;
  const container = $('#suggestedReviewers');
  if (!container) return;

  try {
    const suggestions = await prApi.suggestedReviewers(repoId, prNumber);
    if (suggestions.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--hub-text-muted)">No reviewer suggestions available</div>';
      return;
    }
    container.innerHTML = suggestions.map(s =>
      `<div class="hub-suggested-reviewer">
        <span class="hub-suggested-reviewer__name">@${escapeHtml(s.authorName)}</span>
        <span class="hub-suggested-reviewer__reason">${escapeHtml(s.reason)}</span>
      </div>`
    ).join('');
  } catch {
    container.innerHTML = '<div style="font-size:11px;color:var(--hub-text-muted)">Could not load suggestions</div>';
  }
}

// ───── Meta Branch Generator ─────

async function createMetaBranch(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Meta branch creation: available in live mode', 'info');
    return;
  }
  const name = prompt('Branch name (or leave empty for auto):', '');
  if (name === null) return; // cancelled

  try {
    const result = await workflowApi.createMetaBranch(repoId, {
      name: name || undefined,
      format: liveDeckMeta?.format || 'edh',
    });
    showToast(`Meta branch "${result.branch.name}" created with ${result.issues.length} issues!`, 'success');
    // Refresh data
    loadRepo(repoId);
  } catch (err) {
    showToast(`Failed: ${(err as Error).message}`, 'error');
  }
}

// ───── PR Stack ─────

async function loadPRStack(prNumber: number): Promise<void> {
  if (!repoId || !isLiveMode) return;
  const container = $('#prStackSection');
  if (!container) return;

  try {
    const result = await prApi.getStack(repoId, prNumber);
    if (result.stack.length <= 1) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    container.innerHTML = `
      <div class="pr-modal__section-title">\u{1F4DA} PR Stack</div>
      <div class="hub-pr-stack">
        ${result.stack.map((entry, i) => {
          const isCurrent = i === result.currentIndex;
          const statusIcon: Record<string, string> = { open: '\u{1F7E2}', merged: '\u{1F7E3}', closed: '\u{1F534}' };
          return `<div class="hub-pr-stack__item ${isCurrent ? 'hub-pr-stack__item--current' : ''}">
            <span class="hub-pr-stack__connector">${i < result.stack.length - 1 ? '\u2502' : '\u2514'}</span>
            <span>${statusIcon[entry.status] || '\u26AA'}</span>
            <span class="hub-pr-stack__title">PR #${entry.number}: ${escapeHtml(entry.title)}</span>
            <span class="hub-pr-stack__status">${entry.status}</span>
            ${isCurrent ? '<span class="hub-pr-stack__badge">\u25C0 current</span>' : ''}
          </div>`;
        }).join('')}
      </div>`;
  } catch {
    container.style.display = 'none';
  }
}

// ───── Find Similar PRs ─────

function findSimilarPRs(currentDiff: DeckPatchOp[], currentPRNumber: number): Array<{ pr: AdaptedPR; similarity: number }> {
  if (!rawPRs || rawPRs.length <= 1) return [];

  // Get boards/cards from current diff
  const currentBoards = new Set<string>();
  const currentCards = new Set<string>();
  for (const op of currentDiff) {
    if (op.board) currentBoards.add(op.board);
    if (op.name) currentCards.add(op.name);
  }

  const results: Array<{ pr: AdaptedPR; similarity: number }> = [];

  for (const rawPr of rawPRs) {
    if (rawPr.number === currentPRNumber) continue;
    if (rawPr.status === 'open') continue; // only compare with past PRs

    // Use labels as scope proxy
    let similarity = 0;
    const prBoards = new Set<string>();
    for (const label of (rawPr.labels || [])) {
      if (label.startsWith('scope:')) {
        const scope = label.replace('scope:', '');
        if (currentBoards.has(scope) || currentBoards.has(scope === 'manabase' ? 'mainboard' : scope)) {
          similarity += 2;
        }
        prBoards.add(scope);
      }
    }

    // Check if same boards are affected (using label overlap)
    for (const b of currentBoards) {
      if (prBoards.has(b) || prBoards.has(b === 'mainboard' ? 'manabase' : '')) {
        similarity += 1;
      }
    }

    // Minimum threshold
    if (similarity >= 2) {
      const adapted = livePRs.find(p => p.number === rawPr.number);
      if (adapted) {
        results.push({ pr: adapted, similarity });
      }
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

// ───── Verified Merges ─────

async function verifyPR(prNumber: number): Promise<void> {
  if (!repoId) return;
  try {
    await prApi.verify(repoId, prNumber);
    showToast(`PR #${prNumber} verified!`, 'success');
  } catch (err) {
    showToast(`Verify failed: ${(err as Error).message}`, 'error');
  }
}

async function verifyRelease(tagName: string): Promise<void> {
  if (!repoId) return;
  try {
    await releaseApi.verify(repoId, tagName);
    showToast(`Release ${tagName} verified!`, 'success');
    // Refresh releases
    const releases = await releaseApi.list(repoId).catch(() => []);
    liveReleases = adaptReleases(releases);
    renderLiveReleases();
  } catch (err) {
    showToast(`Verify failed: ${(err as Error).message}`, 'error');
  }
}

// ───── Lock/Unlock Conversation ─────

async function toggleLockPR(prNumber: number, locked: boolean): Promise<void> {
  if (!repoId) return;
  try {
    await prApi.lock(repoId, prNumber, locked);
    showToast(locked ? 'Conversation locked' : 'Conversation unlocked', 'success');
  } catch (err) {
    showToast(`Lock failed: ${(err as Error).message}`, 'error');
  }
}

// ───── Report Comment ─────

async function reportComment(prNumber: number, commentId: string): Promise<void> {
  if (!repoId) return;
  try {
    const result = await prApi.reportComment(repoId, prNumber, commentId);
    if (result.hidden) {
      showToast('Comment reported and hidden due to multiple reports', 'info');
    } else {
      showToast('Comment reported', 'success');
    }
  } catch (err) {
    showToast(`Report failed: ${(err as Error).message}`, 'error');
  }
}

// ───── Contribution Guidelines ─────

async function showGuidelinesModal(): Promise<void> {
  if (!repoId) return;
  try {
    const data = await guidelinesApi.get(repoId);
    if (!data.guidelines && !data.prTemplate) {
      showToast('No contribution guidelines configured. Add them in Settings.', 'info');
      return;
    }
    const modal = $('#prModal');
    if (!modal) return;
    const titleEl = $('#prModalTitle');
    const metaEl = $('#prModalMeta');
    const bodyEl = $('#prModalBody');
    if (titleEl) titleEl.innerHTML = '\u{1F4CB} Contribution Guidelines';
    if (metaEl) metaEl.textContent = 'How to contribute to this deck repository';
    let html = '';
    if (data.guidelines) {
      html += `<div class="pr-modal__section">
        <div class="pr-modal__section-title">Guidelines</div>
        <div class="pr-modal__desc" style="white-space:pre-wrap">${escapeHtml(data.guidelines)}</div>
      </div>`;
    }
    if (data.prTemplate) {
      html += `<div class="pr-modal__section">
        <div class="pr-modal__section-title">PR Template</div>
        <div class="pr-modal__desc" style="white-space:pre-wrap;font-family:var(--hub-mono);font-size:12px">${escapeHtml(data.prTemplate)}</div>
      </div>`;
    }
    if (bodyEl) bodyEl.innerHTML = html;
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  } catch (err) {
    showToast(`Failed to load guidelines: ${(err as Error).message}`, 'error');
  }
}

function isFirstTimeContributor(pr: AdaptedPR): boolean {
  // Check if PR author has any other merged PRs
  return !rawPRs.some(p => p.authorName === (pr as any).authorName && p.status === 'merged' && p.number !== pr.number);
}

// ───── Review Summary + Shareable Pack + PR Sandbox ─────

function generateReviewSummary(pr: AdaptedPR, diff: DeckPatchOp[], comments: PRComment[]): string {
  const addCount = diff.filter(d => d.op === 'add_card').reduce((s, d) => s + (d.qty || 1), 0);
  const removeCount = diff.filter(d => d.op === 'remove_card').reduce((s, d) => s + (d.qty || 1), 0);
  const moveCount = diff.filter(d => d.op === 'move_card').length;
  const risk = computeRiskScore(diff);
  const boards = [...new Set(diff.map(d => d.board).filter(Boolean))];
  const checksPass = pr.checks?.filter(c => c.pass).length ?? 0;
  const checksFail = pr.checks?.filter(c => !c.pass).length ?? 0;

  let summary = `PR #${pr.number} "${pr.title}" by ${pr.author}: `;
  if (addCount > 0 && removeCount > 0) summary += `swaps ${addCount} cards in / ${removeCount} out`;
  else if (addCount > 0) summary += `adds ${addCount} cards`;
  else if (removeCount > 0) summary += `removes ${removeCount} cards`;
  if (moveCount > 0) summary += `, moves ${moveCount} between boards`;
  summary += ` across ${boards.join(', ')}. `;
  summary += `Risk: ${risk.level} (${risk.reasons.slice(0, 2).join(', ')}). `;
  summary += `Checks: ${checksPass} pass, ${checksFail} fail. `;
  if (comments.length > 0) summary += `${comments.length} comment${comments.length > 1 ? 's' : ''} in thread. `;
  return summary.trim();
}

function exportReviewPack(pr: AdaptedPR, diff: DeckPatchOp[], comments: PRComment[]): string {
  const summary = generateReviewSummary(pr, diff, comments);
  const risk = computeRiskScore(diff);
  let md = `# Review Pack: PR #${pr.number} — ${pr.title}\n\n`;
  md += `**Author:** ${pr.author} | **Branch:** ${pr.branch} → ${pr.target} | **Status:** ${pr.status}\n\n`;
  md += `## Summary\n${summary}\n\n`;
  md += `## Risk: ${risk.level.toUpperCase()}\n${risk.reasons.map(r => `- ${r}`).join('\n')}\n\n`;
  md += `## Changes (${diff.length})\n`;
  diff.forEach(op => {
    if (op.op === 'add_card') md += `+ ${op.qty || 1}x ${op.name} (${op.board})\n`;
    else if (op.op === 'remove_card') md += `- ${op.qty || 1}x ${op.name} (${op.board})\n`;
    else if (op.op === 'move_card') md += `=> ${op.name}: ${op.from} → ${op.to}\n`;
  });
  if (pr.checks?.length) {
    md += `\n## Checks\n`;
    pr.checks.forEach(c => { md += `${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`; });
  }
  if (comments.length > 0) {
    md += `\n## Comments (${comments.length})\n`;
    comments.forEach(c => { md += `**${c.authorName}**: ${c.body}\n`; });
  }
  return md;
}

function openPRSandbox(pr: AdaptedPR): void {
  const branchName = pr.branch;
  const url = `/deck-editor.html?repo=${repoId || ''}&branch=${encodeURIComponent(branchName)}&readonly=true`;
  window.open(url, '_blank');
  showToast(`Opening playtest for branch "${branchName}"...`, 'info');
}

// ───── Settings Tab ─────

function populateSettingsForm(): void {
  if (!liveSettings) return;

  const protectMain = $<HTMLInputElement>('#settingsProtectMain');
  const reqApprovals = $<HTMLSelectElement>('#settingsRequiredApprovals');
  const checkFormat = $<HTMLInputElement>('#settingsCheckFormat');
  const checkRegression = $<HTMLInputElement>('#settingsCheckRegression');
  const checkBudget = $<HTMLInputElement>('#settingsCheckBudget');
  const checkQuotas = $<HTMLInputElement>('#settingsCheckQuotas');

  // Populate from saved settings
  const protectedBranches = (liveSettings.protectedBranches as string[]) || [];
  if (protectMain) protectMain.checked = protectedBranches.includes('main');

  const approvals = Number(liveSettings.requiredApprovals ?? 1);
  if (reqApprovals) reqApprovals.value = String(approvals);

  const requiredChecks = (liveSettings.requiredChecks as string[]) || [];
  if (checkFormat) checkFormat.checked = requiredChecks.includes('format_validation');
  if (checkRegression) checkRegression.checked = requiredChecks.includes('regression_tests');
  if (checkBudget) checkBudget.checked = requiredChecks.includes('budget_check');
  if (checkQuotas) checkQuotas.checked = requiredChecks.includes('tag_quotas');

  // Populate guarded sections
  const guardedEl = $<HTMLTextAreaElement>('#settingsGuardedSections');
  if (guardedEl) {
    const guarded = (liveSettings.guardedSections as Array<{ section: string; requiredApprovals: number }>) || [];
    guardedEl.value = guarded.map(g => `${g.section}:${g.requiredApprovals}`).join('\n');
  }

  // Populate review checklist
  const checklistEl = $<HTMLTextAreaElement>('#settingsReviewChecklist');
  if (checklistEl) {
    const checklist = (liveSettings.reviewChecklist as string[]) || [];
    checklistEl.value = checklist.join('\n');
  }
}

async function saveSettings(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Settings: available in live mode with ?repo= parameter', 'info');
    return;
  }

  const protectMain = $<HTMLInputElement>('#settingsProtectMain');
  const reqApprovals = $<HTMLSelectElement>('#settingsRequiredApprovals');
  const checkFormat = $<HTMLInputElement>('#settingsCheckFormat');
  const checkRegression = $<HTMLInputElement>('#settingsCheckRegression');
  const checkBudget = $<HTMLInputElement>('#settingsCheckBudget');
  const checkQuotas = $<HTMLInputElement>('#settingsCheckQuotas');

  const requiredChecks: string[] = [];
  if (checkFormat?.checked) requiredChecks.push('format_validation');
  if (checkRegression?.checked) requiredChecks.push('regression_tests');
  if (checkBudget?.checked) requiredChecks.push('budget_check');
  if (checkQuotas?.checked) requiredChecks.push('tag_quotas');

  const protectedBranches: string[] = protectMain?.checked ? ['main'] : [];

  // Parse guarded sections from textarea
  const guardedEl = $<HTMLTextAreaElement>('#settingsGuardedSections');
  let guardedSections: Array<{ section: string; requiredApprovals: number }> = [];
  if (guardedEl && guardedEl.value.trim()) {
    guardedSections = guardedEl.value.trim().split('\n').map(line => {
      const [section, approvals] = line.split(':').map(s => s.trim());
      return { section, requiredApprovals: parseInt(approvals, 10) || 2 };
    }).filter(g => g.section);
  }

  // Parse review checklist from textarea
  const checklistEl = $<HTMLTextAreaElement>('#settingsReviewChecklist');
  let reviewChecklist: string[] | undefined;
  if (checklistEl && checklistEl.value.trim()) {
    reviewChecklist = checklistEl.value.trim().split('\n').map(s => s.trim()).filter(Boolean);
  }

  try {
    await settingsApi.update(repoId, {
      protectedBranches,
      requiredApprovals: Number(reqApprovals?.value ?? 1),
      requiredChecks,
      guardedSections: guardedSections.length > 0 ? guardedSections : undefined,
      reviewChecklist: reviewChecklist && reviewChecklist.length > 0 ? reviewChecklist : undefined,
    });

    // Also update branch protection
    const mainBranch = liveBranches.find(b => b.name === 'main');
    if (mainBranch) {
      await branchApi.update(repoId, mainBranch.id, { isProtected: protectMain?.checked ?? false }).catch(() => {});
    }

    liveSettings = {
      ...(liveSettings || {}), protectedBranches,
      requiredApprovals: Number(reqApprovals?.value ?? 1), requiredChecks,
      guardedSections, reviewChecklist,
    };
    showToast('Settings saved successfully!', 'success');
  } catch (err) {
    showToast(`Failed to save settings: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
  }
}

function initSettingsTab(): void {
  const btnSave = $('#btnSaveSettings');
  if (btnSave) btnSave.addEventListener('click', saveSettings);

  initWebhookSettings();
  initSavedSearchesUI();

  const btnDelete = $('#btnDeleteRepo');
  if (btnDelete) {
    btnDelete.addEventListener('click', async () => {
      if (!repoId || !isLiveMode) {
        showToast('Delete: available in live mode', 'info');
        return;
      }
      const confirmed = confirm('Are you sure you want to delete this repository? This action cannot be undone.');
      if (!confirmed) return;
      try {
        await repoApi.delete(repoId);
        showToast('Repository deleted. Redirecting...', 'success');
        setTimeout(() => { window.location.href = '/'; }, 1500);
      } catch (err) {
        showToast(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      }
    });
  }

  const btnTransfer = $('#btnTransferOwnership');
  if (btnTransfer) {
    btnTransfer.addEventListener('click', () => {
      showToast('Transfer ownership is not yet implemented', 'info');
    });
  }
}

// ───── Saved Searches UI ─────

function initSavedSearchesUI(): void {
  renderSavedSearches();

  const btnAdd = $('#btnAddSavedSearch');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      const nameInput = $<HTMLInputElement>('#savedSearchName');
      const queryInput = $<HTMLInputElement>('#savedSearchQuery');
      
      const name = nameInput?.value.trim();
      const query = queryInput?.value.trim();
      
      if (!name || !query) {
        showToast('Please enter both name and query', 'info');
        return;
      }
      
      addSavedSearch(name, query);
      if (nameInput) nameInput.value = '';
      if (queryInput) queryInput.value = '';
      renderSavedSearches();
    });
  }
}

function renderSavedSearches(): void {
  const container = $('#savedSearchesContainer');
  if (!container) return;
  
  const searches = getSavedSearches();
  
  if (searches.length === 0) {
    container.innerHTML = '<p style="font-size:13px;color:var(--hub-text-muted)">No saved searches yet.</p>';
    return;
  }
  
  container.innerHTML = searches.map(s => `
    <div class="saved-search-chip" style="display:inline-flex;align-items:center;gap:6px;background:var(--hub-raised);border:1px solid var(--hub-border);border-radius:16px;padding:4px 12px;margin:0 8px 8px 0;font-size:12px">
      <span style="font-weight:600">${escapeHtml(s.name)}</span>
      <code style="font-size:10px;color:var(--hub-text-muted);background:var(--hub-deep);padding:1px 4px;border-radius:3px">${escapeHtml(s.query)}</code>
      <button class="saved-search-delete" data-search-name="${escapeHtml(s.name)}" style="background:none;border:none;color:var(--hub-red);cursor:pointer;font-size:14px;line-height:1;padding:0 2px">&times;</button>
    </div>
  `).join('');
  
  // Wire delete buttons
  container.querySelectorAll('.saved-search-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = (btn as HTMLElement).dataset.searchName;
      if (name) {
        deleteSavedSearch(name);
        renderSavedSearches();
      }
    });
  });
}

// ───── Collaborator CRUD ─────

function renderLiveCollaboratorTable(): void {
  const tbody = $('#rolesTableBody');
  if (!tbody) return;

  if (!isLiveMode || liveCollabs.length === 0) return; // Keep demo data if not live

  const rows = liveCollabs.map(c => {
    const initials = c.userId.slice(0, 2).toUpperCase();
    const color = hashColorFromId(c.userId);
    const isOwner = c.role === 'owner';

    return `<tr>
      <td><div class="roles-table__user"><div class="roles-table__avatar" style="background:${color}">${initials}</div> ${escapeHtml(c.userId)}</div></td>
      <td>${isOwner
        ? '<span class="hub-badge hub-badge--format">Owner</span>'
        : `<select class="hub-select" aria-label="Role for ${escapeHtml(c.userId)}" data-collab-role="${escapeHtml(c.userId)}">
            <option${c.role === 'viewer' ? ' selected' : ''}>Viewer</option>
            <option${c.role === 'contributor' ? ' selected' : ''}>Contributor</option>
            <option${c.role === 'maintainer' ? ' selected' : ''}>Maintainer</option>
            <option${c.role === 'owner' ? ' selected' : ''}>Owner</option>
          </select>`
      }</td>
      <td>${isOwner ? '' : `<button class="hub-btn hub-btn--sm" style="color:var(--hub-red)" data-remove-collab="${escapeHtml(c.userId)}">Remove</button>`}</td>
    </tr>`;
  }).join('');

  // Add row for new collaborator
  const addRow = `<tr>
    <td><input type="text" class="hub-input" id="inputCollabUserId" placeholder="User ID..." style="width:140px"></td>
    <td><select class="hub-select" id="selectCollabRole" aria-label="Role for new collaborator">
      <option>Viewer</option><option selected>Contributor</option><option>Maintainer</option>
    </select></td>
    <td><button class="hub-btn hub-btn--sm hub-btn--primary" id="btnAddCollab">+ Add</button></td>
  </tr>`;

  tbody.innerHTML = rows + addRow;

  // Wire remove buttons
  tbody.querySelectorAll<HTMLButtonElement>('[data-remove-collab]').forEach(btn => {
    btn.addEventListener('click', () => removeCollaborator(btn.dataset.removeCollab!));
  });

  // Wire role change selects
  tbody.querySelectorAll<HTMLSelectElement>('[data-collab-role]').forEach(sel => {
    sel.addEventListener('change', () => changeCollabRole(sel.dataset.collabRole!, sel.value.toLowerCase()));
  });

  // Wire add button
  const btnAdd = $('#btnAddCollab');
  if (btnAdd) btnAdd.addEventListener('click', addCollaborator);
}

async function addCollaborator(): Promise<void> {
  if (!repoId) return;
  const input = $<HTMLInputElement>('#inputCollabUserId');
  const roleSelect = $<HTMLSelectElement>('#selectCollabRole');
  const userId = input?.value.trim();
  const role = roleSelect?.value.toLowerCase() || 'contributor';

  if (!userId) {
    showToast('Enter a user ID to add', 'info');
    return;
  }

  try {
    await collaboratorApi.add(repoId, userId, role);
    showToast(`Added ${userId} as ${role}`, 'success');
    liveCollabs = await collaboratorApi.list(repoId).catch(() => liveCollabs);
    renderLiveCollaboratorTable();
    renderLiveContributors(liveCollabs);
  } catch (err) {
    showToast(`Failed to add collaborator: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
  }
}

async function removeCollaborator(userId: string): Promise<void> {
  if (!repoId) return;
  if (!confirm(`Remove ${userId} from this repository?`)) return;

  try {
    await collaboratorApi.remove(repoId, userId);
    showToast(`Removed ${userId}`, 'success');
    liveCollabs = await collaboratorApi.list(repoId).catch(() => liveCollabs.filter(c => c.userId !== userId));
    renderLiveCollaboratorTable();
    renderLiveContributors(liveCollabs);
  } catch (err) {
    showToast(`Failed to remove: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
  }
}

async function changeCollabRole(userId: string, newRole: string): Promise<void> {
  if (!repoId) return;
  try {
    await collaboratorApi.add(repoId, userId, newRole);
    showToast(`Updated ${userId} to ${newRole}`, 'success');
    liveCollabs = await collaboratorApi.list(repoId).catch(() => liveCollabs);
  } catch (err) {
    showToast(`Failed to update role: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
  }
}

// ───── Issue CRUD ─────

let issueFilter: 'open' | 'closed' = 'open';

function initIssueCRUD(): void {
  // New Issue button
  const btnNew = $('#btnNewIssue');
  if (btnNew) btnNew.addEventListener('click', openIssueModal);

  // Filter buttons
  const btnOpen = $('#btnFilterIssuesOpen');
  const btnClosed = $('#btnFilterIssuesClosed');
  if (btnOpen) btnOpen.addEventListener('click', () => {
    issueFilter = 'open';
    updateIssueFilterUI();
    renderFilteredIssues();
  });
  if (btnClosed) btnClosed.addEventListener('click', () => {
    issueFilter = 'closed';
    updateIssueFilterUI();
    renderFilteredIssues();
  });

  // Modal close
  const btnClose = $('#issueModalClose');
  if (btnClose) btnClose.addEventListener('click', closeIssueModal);
  const modal = $('#issueModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeIssueModal(); });

  // Submit
  const btnSubmit = $('#btnSubmitIssue');
  if (btnSubmit) btnSubmit.addEventListener('click', submitIssue);
}

function updateIssueFilterUI(): void {
  const btnOpen = $('#btnFilterIssuesOpen');
  const btnClosed = $('#btnFilterIssuesClosed');
  if (btnOpen) {
    btnOpen.style.background = issueFilter === 'open' ? 'var(--hub-green-dim)' : '';
    btnOpen.style.color = issueFilter === 'open' ? 'var(--hub-green)' : '';
    btnOpen.style.fontWeight = issueFilter === 'open' ? '600' : '';
  }
  if (btnClosed) {
    btnClosed.style.background = issueFilter === 'closed' ? 'var(--hub-red-dim)' : '';
    btnClosed.style.color = issueFilter === 'closed' ? 'var(--hub-red)' : '';
    btnClosed.style.fontWeight = issueFilter === 'closed' ? '600' : '';
  }
}

function renderFilteredIssues(): void {
  if (isLiveMode) {
    renderLiveIssues();
  } else {
    renderIssues();
  }
}

function openIssueModal(): void {
  const modal = $('#issueModal');
  if (!modal) return;
  // Clear form
  const title = $<HTMLInputElement>('#issueInputTitle');
  const body = $<HTMLTextAreaElement>('#issueInputBody');
  if (title) title.value = '';
  if (body) body.value = '';
  // Uncheck all labels
  $$<HTMLInputElement>('#issueLabelCheckboxes input[type="checkbox"]').forEach(cb => cb.checked = false);
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  title?.focus();
}

function closeIssueModal(): void {
  const modal = $('#issueModal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function submitIssue(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Issue creation: available in live mode', 'info');
    closeIssueModal();
    return;
  }

  const titleInput = $<HTMLInputElement>('#issueInputTitle');
  const bodyInput = $<HTMLTextAreaElement>('#issueInputBody');
  const title = titleInput?.value.trim();
  if (!title) {
    showToast('Issue title is required', 'error');
    return;
  }

  const labels: string[] = [];
  $$<HTMLInputElement>('#issueLabelCheckboxes input[type="checkbox"]:checked').forEach(cb => labels.push(cb.value));

  const btn = $<HTMLButtonElement>('#btnSubmitIssue');
  if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }

  try {
    await issueApi.create(repoId, {
      title,
      body: bodyInput?.value || '',
      labels,
    });
    showToast(`Issue "${title}" created!`, 'success');
    closeIssueModal();

    // Refresh issues
    const issues = await issueApi.list(repoId).catch(() => []);
    liveIssues = adaptIssues(issues);
    const countEl = $('#countIssues');
    if (countEl) countEl.textContent = String(issues.filter(i => i.status === 'open').length);
    renderFilteredIssues();
  } catch (err) {
    showToast(`Failed to create issue: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
  } finally {
    if (btn) { btn.textContent = '\u2705 Create Issue'; btn.disabled = false; }
  }
}

// ───── Release CRUD ─────

function initReleaseCRUD(): void {
  const btnNew = $('#btnNewRelease');
  if (btnNew) btnNew.addEventListener('click', openReleaseModal);

  const btnClose = $('#releaseModalClose');
  if (btnClose) btnClose.addEventListener('click', closeReleaseModal);
  const modal = $('#releaseModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeReleaseModal(); });

  const btnSubmit = $('#btnSubmitRelease');
  if (btnSubmit) btnSubmit.addEventListener('click', submitRelease);

  // Release channel filter buttons
  const channelBtns: Array<{ id: string; value: ReleaseChannel | 'all' }> = [
    { id: '#btnChannelAll', value: 'all' },
    { id: '#btnChannelStable', value: 'stable' },
    { id: '#btnChannelExperimental', value: 'experimental' },
    { id: '#btnChannelPrerelease', value: 'prerelease' },
  ];
  for (const { id, value } of channelBtns) {
    const btn = $(id);
    if (btn) {
      btn.addEventListener('click', () => {
        releaseChannelFilter = value;
        updateChannelFilterUI();
        if (isLiveMode) renderLiveReleases(); else renderReleases();
      });
    }
  }
}

function updateChannelFilterUI(): void {
  const allBtns = $$<HTMLElement>('.hub-channel-btn');
  allBtns.forEach(btn => btn.classList.remove('hub-channel-btn--active'));
  const activeMap: Record<string, string> = {
    all: '#btnChannelAll',
    stable: '#btnChannelStable',
    experimental: '#btnChannelExperimental',
    prerelease: '#btnChannelPrerelease',
  };
  const activeBtn = $(activeMap[releaseChannelFilter]);
  if (activeBtn) activeBtn.classList.add('hub-channel-btn--active');
}

function openReleaseModal(): void {
  const modal = $('#releaseModal');
  if (!modal) return;
  const tag = $<HTMLInputElement>('#releaseInputTag');
  const title = $<HTMLInputElement>('#releaseInputTitle');
  const body = $<HTMLTextAreaElement>('#releaseInputBody');
  const autoNotes = $<HTMLInputElement>('#releaseAutoNotes');
  if (tag) tag.value = '';
  if (title) title.value = '';
  if (body) body.value = '';
  if (autoNotes) autoNotes.checked = true;
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  tag?.focus();
}

function closeReleaseModal(): void {
  const modal = $('#releaseModal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function submitRelease(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Release creation: available in live mode', 'info');
    closeReleaseModal();
    return;
  }

  const tagInput = $<HTMLInputElement>('#releaseInputTag');
  const titleInput = $<HTMLInputElement>('#releaseInputTitle');
  const bodyInput = $<HTMLTextAreaElement>('#releaseInputBody');
  const autoNotesInput = $<HTMLInputElement>('#releaseAutoNotes');

  const tagName = tagInput?.value.trim();
  const title = titleInput?.value.trim();
  if (!tagName) { showToast('Tag name is required (e.g. v1.0)', 'error'); return; }
  if (!title) { showToast('Release title is required', 'error'); return; }

  // Get head commit from current branch
  const branch = liveBranches.find(b => b.isDefault) || liveBranches[0];
  const headCommitId = branch?.headCommitId;
  if (!headCommitId) {
    showToast('No commits found — commit your deck first', 'error');
    return;
  }

  const btn = $<HTMLButtonElement>('#btnSubmitRelease');
  if (btn) { btn.textContent = 'Publishing...'; btn.disabled = true; }

  try {
    const channelSelect = $<HTMLSelectElement>('#releaseChannelSelect');
    const channel = (channelSelect?.value as ReleaseChannel) || 'stable';
    await releaseApi.create(repoId, {
      tagName,
      title,
      body: bodyInput?.value || '',
      commitId: headCommitId,
      autoNotes: autoNotesInput?.checked ?? false,
      channel,
    });
    showToast(`Release ${tagName} published!`, 'success');
    closeReleaseModal();

    // Refresh releases
    const releases = await releaseApi.list(repoId).catch(() => []);
    liveReleases = adaptReleases(releases);
    const countEl = $('#countReleases');
    if (countEl) countEl.textContent = String(releases.length);
    if (isLiveMode) renderLiveReleases(); else renderReleases();
  } catch (err) {
    showToast(`Failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
  } finally {
    if (btn) { btn.textContent = '\u{1F3F7}\u{FE0F} Publish Release'; btn.disabled = false; }
  }
}

// ───── Helper Functions ─────

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function hashColorFromId(id: string): string {
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

function timeAgoFromISO(iso: string): string {
  if (!iso) return '';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ───── Render: Chips & Labels ─────

function chipHTML(tag: string): string {
  const t = tag.toLowerCase();
  const cls: Record<string, string> = {
    ramp: 'hub-chip--ramp', draw: 'hub-chip--draw', removal: 'hub-chip--removal',
    wipe: 'hub-chip--removal',
    wincon: 'hub-chip--wincon', engine: 'hub-chip--engine', land: 'hub-chip--land',
    protection: 'hub-chip--protection',
    counter: 'hub-chip--counter', tutor: 'hub-chip--tutor',
    token: 'hub-chip--token', graveyard: 'hub-chip--graveyard',
    recursion: 'hub-chip--recursion', artifact: 'hub-chip--artifact',
    enchantment: 'hub-chip--enchantment', legend: 'hub-chip--legend',
    flying: 'hub-chip--protection', haste: 'hub-chip--protection',
    planeswalker: 'hub-chip--engine'
  };
  return `<span class="hub-chip ${cls[t] || ''}">${tag}</span>`;
}

function labelHTML(label: string): string {
  const cls: Record<string, string> = {
    bug: 'hub-label--bug', enhancement: 'hub-label--enhancement',
    meta: 'hub-label--meta', rules: 'hub-label--rules',
    budget: 'hub-label--budget', question: 'hub-label--question',
  };
  return `<span class="hub-label ${cls[label] || 'hub-label--question'}">${label}</span>`;
}

// Scope label colors for auto-labeling
const SCOPE_LABEL_COLORS: Record<string, string> = {
  'scope:manabase': '#3dd68c',
  'scope:sideboard': '#f59e42',
  'scope:commander': '#a78bfa',
  'scope:interaction': '#ef5350',
  'scope:wincon': '#c9a84c',
  'scope:ramp': '#3dd68c',
  'scope:draw': '#5ea3f8',
  'size:small': '#6b7084',
  'size:medium': '#f59e42',
  'size:large': '#ef5350',
};

function renderScopeLabels(labels: string[]): string {
  if (!labels || labels.length === 0) return '';
  return labels.map(l => {
    const color = SCOPE_LABEL_COLORS[l] || 'var(--hub-text-muted)';
    return `<span class="hub-scope-label" style="--scope-color:${color}">${escapeHtml(l.replace('scope:', '').replace('size:', ''))}</span>`;
  }).join('');
}

// ───── Render: File Tree ─────

function renderFileTree(): void {
  const el = $('#fileTreeBody');
  if (!el) return;
  el.innerHTML = FILES.map(f =>
    `<div class="file-tree__row">
      <span class="file-tree__row-icon">${f.icon}</span>
      <span class="file-tree__row-name">${f.name}</span>
      <span class="file-tree__row-msg">${f.msg}</span>
      <span class="file-tree__row-time">${f.time}</span>
    </div>`
  ).join('');
}

// ───── Render: Card Table ─────

function renderCardTable(): void {
  const el = $('#cardTableBody');
  if (!el) return;

  function sectionHTML(label: string, cards: DemoCard[]): string {
    if (!cards.length) return '';
    const rows = cards.map(c =>
      `<tr>
        <td class="card-table__qty">${c.qty}</td>
        <td class="card-table__name">${c.name}</td>
        <td class="card-table__type">${c.type}</td>
        <td class="card-table__cmc">${c.cmc}</td>
        <td class="card-table__tags">${c.tags.map(chipHTML).join('')}</td>
      </tr>`
    ).join('');
    return `<div class="card-table__section">${label} (${cards.length})</div>
      <table><thead><tr><th style="width:32px">#</th><th>Name</th><th>Type</th><th style="width:40px;text-align:center">CMC</th><th>Tags</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  el.innerHTML =
    sectionHTML('Commander', CARDS.commander) +
    sectionHTML('Mainboard', CARDS.main) +
    sectionHTML('Lands', CARDS.lands);
}

// ───── Render: Curve Bar ─────

function renderCurveBar(): void {
  const el = $('#curveBar');
  if (!el) return;
  const max = Math.max(...CURVE_DATA);
  el.innerHTML = CURVE_DATA.map((v, i) => {
    const h = Math.max(4, (v / max) * 100);
    return `<div class="curve-bar__col" style="height:${h}%" data-label="${i === 7 ? '7+' : i}"></div>`;
  }).join('');
}

// ───── Render: Checks Sidebar ─────

function renderChecks(): void {
  const el = $('#checksBody');
  if (!el) return;
  el.innerHTML = CHECKS.map(c =>
    `<div class="check-item">
      <span class="check-item__icon ${c.pass ? 'check-item__icon--pass' : 'check-item__icon--fail'}">${c.pass ? '\u2705' : '\u274C'}</span>
      <span class="check-item__name">${c.name}</span>
    </div>`
  ).join('');
}

// ───── Render: PR List ─────

function renderPRList(): void {
  const el = $('#prListBody');
  if (!el) return;

  const openPRs = PRS.filter(p => p.status === 'open');
  const mergedPRs = PRS.filter(p => p.status === 'merged');

  function prItemHTML(pr: DemoPR): string {
    const iconClass: Record<string, string> = { open: 'pr-item__icon--open', merged: 'pr-item__icon--merged', closed: 'pr-item__icon--closed' };
    const icon: Record<string, string> = { open: '\u{1F7E2}', merged: '\u{1F7E3}', closed: '\u{1F534}' };

    let checksHTML = '';
    if (pr.status === 'open') {
      checksHTML = pr.checksPass
        ? '<span class="hub-status hub-status--pass">\u2705 Checks pass</span>'
        : '<span class="hub-status hub-status--fail">\u274C Checks failing</span>';
      if (pr.approved) {
        checksHTML += ' <span class="hub-status hub-status--approved">\u2705 Approved</span>';
      }
    }

    return `<div class="pr-item" data-pr="${pr.number}" role="button" tabindex="0" aria-label="Pull request #${pr.number}: ${pr.title}">
      <span class="pr-item__icon ${iconClass[pr.status]}">${icon[pr.status]}</span>
      <div class="pr-item__body">
        <div class="pr-item__title">${pr.title} <span style="color:var(--hub-text-muted);font-weight:400">#${pr.number}</span></div>
        <div class="pr-item__meta">
          ${pr.status === 'merged' ? 'Merged' : 'Opened'} ${pr.time} by ${pr.author}
          &middot; ${pr.branch} &rarr; ${pr.target}
        </div>
      </div>
      <div class="pr-item__checks">${checksHTML}</div>
    </div>`;
  }

  let html = '';
  if (openPRs.length) {
    html += openPRs.map(prItemHTML).join('');
  }
  if (mergedPRs.length) {
    html += `<div style="padding:10px 16px;font-size:12px;font-weight:600;color:var(--hub-text-muted);border-bottom:1px solid var(--hub-border)">Merged</div>`;
    html += mergedPRs.map(prItemHTML).join('');
  }

  el.innerHTML = html;

  // Click handlers for PR items
  $$<HTMLElement>('.pr-item[data-pr]').forEach(item => {
    item.addEventListener('click', () => openPRModal(parseInt(item.dataset.pr!, 10)));
    item.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPRModal(parseInt(item.dataset.pr!, 10));
      }
    });
  });
}

// ───── PR Modal ─────

function openPRModal(prNumber: number): void {
  const pr = PRS.find(p => p.number === prNumber);
  if (!pr) return;

  const modal = $('#prModal');
  if (!modal) return;

  const allChecksPass = pr.checks?.every(c => c.pass) ?? false;
  const allApproved = pr.reviews?.every(r => r.state === 'approved') ?? false;
  const canMerge = allChecksPass && allApproved && pr.status === 'open';

  const titleEl = $('#prModalTitle');
  const metaEl = $('#prModalMeta');
  if (titleEl) titleEl.innerHTML = `${pr.title} <span class="pr-modal__number">#${pr.number}</span>`;
  if (metaEl) metaEl.textContent = `${pr.author} wants to merge ${pr.branch} into ${pr.target} \u00B7 ${pr.time}`;

  let bodyHTML = '';

  bodyHTML += `<div class="pr-modal__section">
    <div class="pr-modal__section-title">Description</div>
    <div class="pr-modal__desc">${pr.description}</div>
  </div>`;

  bodyHTML += `<div class="pr-modal__section">
    <div class="pr-modal__section-title">Diff Summary</div>
    <div class="pr-modal__diff-summary">
      <span class="pr-modal__diff-add">+${pr.diffAdd} cards added</span>
      <span class="pr-modal__diff-remove">-${pr.diffRemove} cards removed</span>
    </div>
  </div>`;

  if (pr.files) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Files Changed</div>
      <div class="pr-modal__files">
        ${pr.files.map(f => `<div class="pr-modal__file">
          <span class="pr-modal__file-status pr-modal__file-status--${f.status === 'modified' ? 'modified' : 'added'}">${f.status === 'modified' ? 'M' : 'A'}</span>
          ${f.name}
        </div>`).join('')}
      </div>
    </div>`;
  }

  if (pr.checks) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Checks</div>
      <div class="checks-list">
        ${pr.checks.map(c => `<div class="check-item">
          <span class="check-item__icon ${c.pass ? 'check-item__icon--pass' : 'check-item__icon--fail'}">${c.pass ? '\u2705' : '\u274C'}</span>
          <span class="check-item__name">${c.name}</span>
          ${c.detail ? `<span style="font-size:11px;color:var(--hub-text-muted);margin-left:auto">${c.detail}</span>` : ''}
        </div>`).join('')}
      </div>
    </div>`;
  }

  if (pr.reviews) {
    bodyHTML += `<div class="pr-modal__section">
      <div class="pr-modal__section-title">Reviews</div>
      <div class="pr-modal__reviews">
        ${pr.reviews.map(r => {
          const stateLabel = r.state === 'approved'
            ? '<span class="hub-status hub-status--approved">Approved</span>'
            : '<span class="hub-status hub-status--changes">Changes Requested</span>';
          return `<div class="pr-modal__review">
            <div class="pr-modal__review-avatar" style="background:${r.color}">${r.initials}</div>
            <strong style="font-size:13px">${r.user}</strong>
            ${stateLabel}
            <span style="font-size:12px;color:var(--hub-text-dim)">&ldquo;${r.comment}&rdquo;</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  const bodyEl = $('#prModalBody');
  if (bodyEl) bodyEl.innerHTML = bodyHTML;

  // Merge box
  let mergeHTML = '';
  if (pr.status === 'merged') {
    mergeHTML = `<div class="pr-modal__merge-status">
      <span style="color:var(--hub-purple);font-size:16px">\u{1F7E3}</span>
      <span style="color:var(--hub-text-bright);font-weight:600">This PR was merged</span>
    </div>`;
  } else if (pr.status === 'open') {
    const reasons: string[] = [];
    if (!allChecksPass) reasons.push('checks are failing');
    if (!allApproved) reasons.push('missing approvals');

    mergeHTML = `<div class="pr-modal__merge-status">
      <div class="pr-modal__merge-checks">
        ${allChecksPass ? '<span class="hub-status hub-status--pass">\u2705 Checks</span>' : '<span class="hub-status hub-status--fail">\u274C Checks</span>'}
        ${allApproved ? '<span class="hub-status hub-status--approved">\u2705 Approved</span>' : '<span class="hub-status hub-status--changes">\u23F3 Pending</span>'}
      </div>
      ${!canMerge ? `<span style="font-size:11px;color:var(--hub-text-muted)">Cannot merge: ${reasons.join(', ')}</span>` : ''}
    </div>
    <button class="hub-btn hub-btn--primary" ${canMerge ? '' : 'disabled aria-disabled="true"'}>${canMerge ? '\u2705 Merge Pull Request' : '\u{1F6AB} Merge blocked'}</button>`;
  }

  const mergeEl = $('#prModalMerge');
  if (mergeEl) mergeEl.innerHTML = mergeHTML;

  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#prModalClose')?.focus();
}

function closePRModal(): void {
  const modal = $('#prModal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// ───── Render: Issues ─────

function renderIssues(): void {
  const el = $('#issueListBody');
  if (!el) return;
  el.innerHTML = ISSUES.map(issue =>
    `<div class="issue-item">
      <span class="issue-item__icon">\u{1F7E2}</span>
      <div class="issue-item__body">
        <div class="issue-item__title">${issue.title} <span style="color:var(--hub-text-muted);font-weight:400">#${issue.number}</span></div>
        <div class="issue-item__meta">
          ${issue.labels.map(labelHTML).join(' ')}
          &middot; opened ${issue.time} by ${issue.author}
          ${issue.comments ? `&middot; \u{1F4AC} ${issue.comments}` : ''}
        </div>
      </div>
    </div>`
  ).join('');
}

// ───── Render: Releases ─────

function renderReleases(): void {
  const el = $('#releaseListBody');
  if (!el) return;
  el.innerHTML = RELEASES.map(rel => {
    const notesHTML = rel.notes.map(n => {
      const prefix: Record<string, string> = { add: '\u2795', remove: '\u274C', change: '\u{1F504}', fix: '\u{1F527}' };
      return `<li>${prefix[n.type] || ''} ${n.text}</li>`;
    }).join('');

    return `<div class="release-item">
      <div class="release-item__header">
        <span class="release-item__tag">${rel.tag}</span>
        <span class="release-item__date">${rel.date}</span>
      </div>
      <div class="release-item__title">${rel.title}</div>
      <ul class="release-item__notes">${notesHTML}</ul>
      <div class="release-item__actions">
        <button class="hub-btn hub-btn--sm">\u{1F4E6} Tournament Packet</button>
        <button class="hub-btn hub-btn--sm">\u{1F517} Share Link</button>
        <button class="hub-btn hub-btn--sm">\u{1F4BE} Download State</button>
      </div>
    </div>`;
  }).join('');
}

// ───── Render: Insights ─────

function renderInsights(): void {
  const checksEl = $('#insightChecksBody');
  if (checksEl) {
    checksEl.innerHTML = INSIGHTS_CHECKS.map(c =>
      `<div class="insight-row">
        <span class="insight-row__icon">${c.pass ? '\u2705' : '\u274C'}</span>
        <span class="insight-row__name">${c.name}</span>
        <span class="insight-row__detail">${c.detail || ''}</span>
      </div>`
    ).join('');
  }

  const warningsEl = $('#insightWarningsBody');
  if (warningsEl) {
    warningsEl.innerHTML = WARNINGS.map(w =>
      `<div class="warning-item">
        <span class="warning-item__icon">${w.icon}</span>
        <span>${w.text}</span>
      </div>`
    ).join('');
  }

  const regressionsEl = $('#insightRegressionsBody');
  if (regressionsEl) {
    regressionsEl.innerHTML = REGRESSIONS.map(r =>
      `<div class="regression-item">
        <div class="regression-item__label">${r.label}</div>
        <div class="regression-item__detail">${r.before} \u2192 ${r.after} (<span>${r.delta}</span>)</div>
      </div>`
    ).join('');
  }
}

// ───── Tab Logic (ARIA) ─────

const TABS = ['code', 'pulls', 'issues', 'releases', 'insights', 'settings'];

function switchTab(tabId: string): void {
  currentTab = tabId;
  TABS.forEach(id => {
    const btn = $(`#tab-${id}`);
    const panel = $(`#panel-${id}`);
    if (!btn || !panel) return;
    const isActive = id === tabId;
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    btn.setAttribute('tabindex', isActive ? '0' : '-1');
    panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });

  if (history.replaceState) {
    history.replaceState(null, '', `#tab=${tabId}`);
  }
}

function initTabNavigation(): void {
  $$<HTMLButtonElement>('[role="tab"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.id.replace('tab-', '');
      switchTab(id);
    });
  });

  // Keyboard nav for tabs
  const tabs = Array.from($$<HTMLButtonElement>('[role="tab"]'));
  tabs.forEach((btn, i) => {
    btn.addEventListener('keydown', (e: KeyboardEvent) => {
      let next: HTMLButtonElement | undefined;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); next.focus(); next.click(); }
    });
  });

  // Deep-link from hash
  function readHash(): void {
    const hash = location.hash.replace('#', '');
    const params = new URLSearchParams(hash);
    const tab = params.get('tab');
    if (tab && TABS.includes(tab)) switchTab(tab);
  }
  readHash();
  window.addEventListener('hashchange', readHash);

  // Quick link tab switching
  $$<HTMLElement>('[data-open-tab]').forEach(el => {
    el.addEventListener('click', (e: Event) => {
      e.preventDefault();
      switchTab(el.dataset.openTab!);
    });
  });
}

// ───── Branch Dropdown ─────

function initBranchDropdown(): void {
  const branchBtn = $<HTMLButtonElement>('#branchBtn');
  const branchDropdown = $('#branchDropdown');
  if (!branchBtn || !branchDropdown) return;

  function closeBranchDropdown(): void {
    branchDropdown!.setAttribute('aria-hidden', 'true');
    branchBtn!.setAttribute('aria-expanded', 'false');
  }

  function toggleBranchDropdown(): void {
    const isOpen = branchDropdown!.getAttribute('aria-hidden') === 'false';
    branchDropdown!.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
    branchBtn!.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
  }

  function renderBranchOptions(): void {
    const branches = isLiveMode && liveBranches.length ? liveBranches : BRANCHES;
    const opts = branches.map(b =>
      `<button class="branch-select__option" role="option" aria-selected="${b.name === currentBranch ? 'true' : 'false'}" data-branch="${b.name}">
        ${b.name}${b.isDefault ? ' <span style="color:var(--hub-text-muted);font-size:11px;margin-left:auto">default</span>' : ''}
      </button>`
    ).join('');
    branchDropdown!.innerHTML = `<div class="branch-select__dropdown-header">Switch branch</div>${opts}
      <div style="border-top:1px solid var(--hub-border);margin-top:4px;padding-top:4px">
        <button class="branch-select__option" id="btnBranchCompare" style="color:var(--hub-gold)">\u{1F50D} Compare branches...</button>
        ${isLiveMode ? '<button class="branch-select__option" id="btnMetaBranch" style="color:var(--hub-green)">\u{1F9EA} New Meta-Tune Branch...</button>' : ''}
      </div>`;
    const compareBtn = branchDropdown!.querySelector('#btnBranchCompare');
    if (compareBtn) compareBtn.addEventListener('click', () => { closeBranchDropdown(); openBranchCompareModal(); });
    const metaBtn = branchDropdown!.querySelector('#btnMetaBranch');
    if (metaBtn) metaBtn.addEventListener('click', () => { closeBranchDropdown(); createMetaBranch(); });

    branchDropdown!.querySelectorAll<HTMLButtonElement>('.branch-select__option').forEach(opt => {
      opt.addEventListener('click', () => {
        currentBranch = opt.dataset.branch!;
        const label = $('#branchLabel');
        if (label) label.textContent = currentBranch;
        closeBranchDropdown();
        updateBranchUI();
      });
    });
  }

  function updateBranchUI(): void {
    renderBranchOptions();
    const ctaBanner = $('#ctaBanner');
    const defaultName = isLiveMode
      ? (liveBranches.find(b => b.isDefault)?.name || 'main')
      : 'main';
    if (ctaBanner) ctaBanner.setAttribute('data-visible', currentBranch !== defaultName ? 'true' : 'false');

    // Update last commit based on branch
    if (isLiveMode && liveCommits.length) {
      const commit = liveCommits.find(c => c.branch === currentBranch) || liveCommits[0];
      const msgEl = $('#lastCommitMsg');
      const timeEl = $('#lastCommitTime');
      const authorEl = $('#lastCommitAuthor');
      if (msgEl && commit) {
        const parsed = parseSemanticCommit(commit.message);
        msgEl.innerHTML = renderSemanticBadge(parsed.type) + escapeHtml(parsed.description);
      }
      if (timeEl) timeEl.textContent = commit?.time || '';
      if (authorEl) authorEl.textContent = commit?.author || '';

      // In live mode, load commits for selected branch
      if (repoId) {
        const branch = liveBranches.find(b => b.name === currentBranch);
        if (branch) {
          commitApi.list(repoId, branch.id, 10).catch(() => []).then(commits => {
            liveCommits = adaptCommits(commits, currentBranch);
            const c = liveCommits[0];
            if (c) {
              const m = $('#lastCommitMsg');
              const t = $('#lastCommitTime');
              const a = $('#lastCommitAuthor');
              if (m) m.textContent = c.message;
              if (t) t.textContent = c.time;
              if (a) a.textContent = c.author;
            }
          });
        }
      }
    } else {
      const commit = COMMITS.find(c => c.branch === currentBranch) || COMMITS[0];
      const msgEl = $('#lastCommitMsg');
      const timeEl = $('#lastCommitTime');
      const authorEl = $('#lastCommitAuthor');
      if (msgEl) msgEl.textContent = commit.message;
      if (timeEl) timeEl.textContent = commit.time;
      if (authorEl) authorEl.textContent = commit.author;
    }
  }

  branchBtn.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    toggleBranchDropdown();
  });

  document.addEventListener('click', (e: Event) => {
    if (!branchDropdown.contains(e.target as Node) && e.target !== branchBtn) {
      closeBranchDropdown();
    }
  });

  // Initial render
  renderBranchOptions();
  updateBranchUI();
}

// ───── Theme Toggle ─────

function initThemeToggle(): void {
  const themeToggle = $('#themeToggle');
  const themeIcon = $('#themeIcon');
  if (!themeToggle || !themeIcon) return;

  function setTheme(theme: string): void {
    document.documentElement.setAttribute('data-theme', theme);
    themeIcon!.innerHTML = theme === 'dark' ? '\u2600\uFE0F' : '\u{1F319}';
    try { localStorage.setItem('deckhub-theme', theme); } catch { /* ok */ }
  }

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Restore theme
  try {
    const saved = localStorage.getItem('deckhub-theme');
    if (saved) setTheme(saved);
  } catch { /* ok */ }
}

// ───── PR Modal Events ─────

function initPRModal(): void {
  const closeBtn = $('#prModalClose');
  const modal = $('#prModal');
  if (closeBtn) closeBtn.addEventListener('click', closePRModal);
  if (modal) {
    modal.addEventListener('click', (e: Event) => {
      if (e.target === modal) closePRModal();
    });
  }
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (modal?.getAttribute('aria-hidden') === 'false') closePRModal();
      const issueModal = $('#issueModal');
      if (issueModal?.getAttribute('aria-hidden') === 'false') closeIssueModal();
      const releaseModal = $('#releaseModal');
      if (releaseModal?.getAttribute('aria-hidden') === 'false') closeReleaseModal();
      const compareModal = $('#branchCompareModal');
      if (compareModal?.getAttribute('aria-hidden') === 'false') closeBranchCompareModal();
    }
  });
}

// ───── Auth UI ─────

function updateAvatarUI(user: { displayName: string; avatarUrl?: string | null } | null): void {
  const avatar = $('#userAvatar');
  if (!avatar) return;
  if (user) {
    avatar.textContent = user.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    avatar.title = user.displayName;
    avatar.style.cursor = 'pointer';
    avatar.onclick = () => {
      if (confirm(`Logged in as ${user.displayName}.\nLog out?`)) {
        logout().then(() => location.reload());
      }
    };
  } else {
    avatar.textContent = '\u{1F464}';
    avatar.title = 'Sign in';
    avatar.style.cursor = 'pointer';
    avatar.onclick = () => {
      const choice = confirm('Sign in with Google?\n\nOK = Google\nCancel = GitHub');
      if (choice) {
        loginWithGoogle();
      } else {
        loginWithGitHub();
      }
    };
  }
}

function initAuthUI(): void {
  initAuth();
  onAuthStateChange((user) => updateAvatarUI(user));
  getCurrentUser().then(user => updateAvatarUI(user));
}

// ───── CRUD Operations ─────

function initCRUDHandlers(): void {
  // Create Branch
  const btnCreateBranch = $('#btnCreateBranch');
  if (btnCreateBranch) {
    btnCreateBranch.addEventListener('click', async () => {
      if (!repoId || !isLiveMode) {
        showToast('Create branch: available in live mode with ?repo= parameter', 'info');
        return;
      }
      const name = prompt('Branch name:');
      if (!name) return;
      try {
        const defaultBranch = liveBranches.find(b => b.isDefault);
        await branchApi.create(repoId, name, defaultBranch?.id);
        showToast(`Branch "${name}" created!`, 'success');
        loadRepo(repoId); // Refresh
      } catch (err) {
        showToast(`Error: ${err instanceof Error ? err.message : 'Failed to create branch'}`, 'error');
      }
    });
  }

  // New PR
  const btnNewPR = $('#btnNewPR');
  if (btnNewPR) {
    btnNewPR.addEventListener('click', async () => {
      if (!repoId || !isLiveMode) {
        showToast('New PR: available in live mode with ?repo= parameter', 'info');
        return;
      }
      if (liveBranches.length < 2) {
        showToast('Need at least 2 branches to create a PR', 'info');
        return;
      }
      const title = prompt('PR Title:');
      if (!title) return;
      const description = prompt('Description (optional):') || '';
      // Use current branch as source, default as target
      const sourceBranch = liveBranches.find(b => b.name === currentBranch);
      const targetBranch = liveBranches.find(b => b.isDefault && b.name !== currentBranch) || liveBranches[0];
      if (!sourceBranch || !targetBranch || sourceBranch.id === targetBranch.id) {
        showToast('Switch to a non-default branch first to create a PR', 'info');
        return;
      }
      try {
        await prApi.create(repoId, {
          title,
          description,
          sourceBranchId: sourceBranch.id,
          targetBranchId: targetBranch.id,
        });
        showToast(`PR "${title}" created!`, 'success');
        loadRepo(repoId); // Refresh
      } catch (err) {
        showToast(`Error: ${err instanceof Error ? err.message : 'Failed to create PR'}`, 'error');
      }
    });
  }

  // Settings button → switch to settings tab
  const btnSettings = $('#btnSettings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => switchTab('settings'));
  }

  // CTA banner → compare & pull request
  const btnCTA = $('#btnCTACompare');
  if (btnCTA) {
    btnCTA.addEventListener('click', async () => {
      if (!repoId || !isLiveMode) {
        showToast('Compare: available in live mode', 'info');
        return;
      }
      const sourceBranch = liveBranches.find(b => b.name === currentBranch);
      const targetBranch = liveBranches.find(b => b.isDefault && b.name !== currentBranch) || liveBranches[0];
      if (!sourceBranch || !targetBranch || sourceBranch.id === targetBranch.id) {
        showToast('Switch to a non-default branch first', 'info');
        return;
      }
      const title = prompt('PR Title:');
      if (!title) return;
      try {
        await prApi.create(repoId, {
          title,
          description: `Compare ${currentBranch} → ${targetBranch.name}`,
          sourceBranchId: sourceBranch.id,
          targetBranchId: targetBranch.id,
        });
        showToast(`PR "${title}" created!`, 'success');
        loadRepo(repoId);
      } catch (err) {
        showToast(`Error: ${err instanceof Error ? err.message : 'Failed to create PR'}`, 'error');
      }
    });
  }
}

// ───── Watch Modal (8C) ─────

async function initWatchModal(): Promise<void> {
  const btnWatch = $('#btnWatch');
  if (btnWatch) {
    btnWatch.addEventListener('click', openWatchModal);
  }

  const btnClose = $('#watchModalClose');
  if (btnClose) {
    btnClose.addEventListener('click', () => $('#watchModal')?.setAttribute('aria-hidden', 'true'));
  }

  const btnSave = $('#btnSaveWatch');
  if (btnSave) {
    btnSave.addEventListener('click', saveWatch);
  }
}

async function openWatchModal(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Watch settings: available in live mode', 'info');
    return;
  }

  try {
    const rule = await watchApi.get(repoId);
    const checkboxes = document.querySelectorAll<HTMLInputElement>('#watchEventList input[type="checkbox"]');
    checkboxes.forEach(cb => {
      cb.checked = rule.events.includes(cb.value);
    });
    $('#watchModal')?.setAttribute('aria-hidden', 'false');
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('no such table') || msg.includes('deck_watch_rules')) {
      showToast('Database update required. Please restart dev server or run migrations.', 'error', 8000);
      console.error('Missing table deck_watch_rules. Created migration 0011_watch_features.sql');
    } else {
      showToast(`Failed to load watch settings: ${msg}`, 'error');
    }
  }
}

async function saveWatch(): Promise<void> {
  if (!repoId) return;
  const checkboxes = document.querySelectorAll<HTMLInputElement>('#watchEventList input[type="checkbox"]');
  const events = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);

  try {
    await watchApi.set(repoId, events);
    showToast('Watch settings saved!', 'success');
    $('#watchModal')?.setAttribute('aria-hidden', 'true');
  } catch (err) {
    showToast(`Failed to save: ${(err as Error).message}`, 'error');
  }
}

// ───── Webhook Settings (8B) ─────

function initWebhookSettings(): void {
  const btnAdd = $('#btnAddWebhook');
  if (btnAdd) btnAdd.addEventListener('click', addWebhook);
  
  // Initial render when settings tab is opened (or repo loaded)
  if (repoId && isLiveMode) renderWebhookSettings();
}

async function addWebhook(): Promise<void> {
  if (!repoId) return;
  const urlInput = $<HTMLInputElement>('#webhookInputUrl');
  const eventInput = $<HTMLInputElement>('#webhookInputEvents');
  
  const url = urlInput?.value.trim();
  const eventsStr = eventInput?.value.trim() || '*';
  const events = eventsStr.split(',').map(e => e.trim());

  if (!url) {
    showToast('Please enter a webhook URL', 'info');
    return;
  }

  try {
    await webhookApi.create(repoId, { url, events });
    showToast('Webhook added successfully!', 'success');
    if (urlInput) urlInput.value = '';
    renderWebhookSettings();
  } catch (err) {
    showToast(`Failed to add webhook: ${(err as Error).message}`, 'error');
  }
}

async function renderWebhookSettings(): Promise<void> {
  const container = $('#webhookSettingsContainer');
  if (!container || !repoId) return;

  try {
    const hooks = await webhookApi.list(repoId);
    if (hooks.length === 0) {
      container.innerHTML = '<p style="font-size:13px;color:var(--hub-text-muted)">No webhooks configured.</p>';
    } else {
      container.innerHTML = hooks.map(h => `
        <div class="webhook-row" style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--hub-deep);border-radius:4px;margin-bottom:8px;border:1px solid var(--hub-border)">
          <div style="overflow:hidden">
            <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(h.url)}</div>
            <div style="font-size:11px;color:var(--hub-text-muted)">Events: ${h.events.join(', ')}</div>
          </div>
          <button class="hub-btn hub-btn--sm" style="color:var(--hub-red)" data-webhook-id="${h.id}">Delete</button>
        </div>
      `).join('');

      container.querySelectorAll('[data-webhook-id]').forEach(btn => {
        btn.addEventListener('click', () => deleteWebhook((btn as HTMLElement).dataset.webhookId!));
      });
    }
  } catch (err) {
    container.innerHTML = `<p style="color:var(--hub-red)">Failed to load webhooks.</p>`;
  }
}

async function deleteWebhook(id: string): Promise<void> {
  if (!repoId || !confirm('Delete this webhook?')) return;
  try {
    await webhookApi.delete(repoId, id);
    showToast('Webhook deleted', 'success');
    renderWebhookSettings();
  } catch (err) {
    showToast(`Error: ${(err as Error).message}`, 'error');
  }
}

// ───── Bisect Wizard (8A) ─────

let currentBisectSession: BisectSession | null = null;

function initBisectWizard(): void {
  const btnClose = $('#bisectModalClose');
  if (btnClose) {
    btnClose.addEventListener('click', () => $('#bisectModal')?.setAttribute('aria-hidden', 'true'));
  }
}

async function openBisectWizard(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('Bisect: available in live mode', 'info');
    return;
  }

  const modalBody = $('#bisectModalBody');
  if (!modalBody) return;

  // Initial step: Select Good and Bad commits
  modalBody.innerHTML = `
    <p style="font-size:13px;color:var(--hub-text-muted);margin-bottom:16px">Find which commit introduced a problem by performing a binary search.</p>
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--hub-text-muted);text-transform:uppercase;display:block;margin-bottom:4px">Last Known Good Commit</label>
        <select class="hub-input" id="bisectGoodSelect" style="width:100%"></select>
      </div>
      <div>
        <label style="font-size:11px;font-weight:600;color:var(--hub-text-muted);text-transform:uppercase;display:block;margin-bottom:4px">First Known Bad Commit</label>
        <select class="hub-input" id="bisectBadSelect" style="width:100%"></select>
      </div>
      <button class="hub-btn hub-btn--primary" id="btnStartBisect" style="margin-top:10px">Start Bisecting</button>
    </div>
  `;

  // Fill selects with recent commits
  const goodSelect = $<HTMLSelectElement>('#bisectGoodSelect');
  const badSelect = $<HTMLSelectElement>('#bisectBadSelect');
  if (goodSelect && badSelect) {
    const options = liveCommits.map(c => `<option value="${c.fullId}">${c.id} - ${escapeHtml(c.message)}</option>`).join('');
    goodSelect.innerHTML = options;
    badSelect.innerHTML = options;
    if (badSelect.options.length > 0) badSelect.selectedIndex = 0;
    if (goodSelect.options.length > 1) goodSelect.selectedIndex = Math.min(5, goodSelect.options.length - 1);
  }

  $('#btnStartBisect')?.addEventListener('click', startBisect);
  $('#bisectModal')?.setAttribute('aria-hidden', 'false');
}

async function startBisect(): Promise<void> {
  if (!repoId) return;
  const goodId = $<HTMLSelectElement>('#bisectGoodSelect')?.value;
  const badId = $<HTMLSelectElement>('#bisectBadSelect')?.value;

  if (!goodId || !badId || goodId === badId) {
    showToast('Select two different commits', 'info');
    return;
  }

  try {
    currentBisectSession = await bisectApi.start(repoId, goodId, badId);
    renderBisectStep();
  } catch (err) {
    showToast(`Error: ${(err as Error).message}`, 'error');
  }
}

async function renderBisectStep(): Promise<void> {
  const modalBody = $('#bisectModalBody');
  if (!modalBody || !currentBisectSession) return;

  if (currentBisectSession.status === 'found') {
    modalBody.innerHTML = `
      <div style="text-align:center;padding:20px">
        <div style="font-size:48px;margin-bottom:10px">&#x1F6A8;</div>
        <h3 style="color:var(--hub-red)">Regression Found!</h3>
        <p style="margin:10px 0;font-size:14px">The problem was introduced in commit:</p>
        <div style="background:var(--hub-deep);padding:12px;border-radius:6px;font-family:var(--hub-mono);font-size:13px;margin:16px 0;border:1px solid var(--hub-border-accent)">
          ${currentBisectSession.resultCommitId}
        </div>
        <button class="hub-btn" onclick="document.getElementById('bisectModal').setAttribute('aria-hidden', 'true')">Close</button>
      </div>
    `;
    return;
  }

  const nextCommitId = currentBisectSession.candidateCommitIds[Math.floor(currentBisectSession.candidateCommitIds.length / 2)];
  
  modalBody.innerHTML = `
    <div style="text-align:center;padding:10px">
      <p style="font-size:14px;margin-bottom:20px">Is the deck state <strong>GOOD</strong> or <strong>BAD</strong> at this commit?</p>
      <div style="background:var(--hub-deep);padding:16px;border-radius:6px;text-align:left;margin-bottom:24px;border:1px solid var(--hub-border)">
        <div style="font-family:var(--hub-mono);font-size:12px;color:var(--hub-text-muted)">Testing Commit:</div>
        <div style="font-size:14px;font-weight:600;margin:4px 0">${nextCommitId}</div>
        <div style="margin-top:12px">
          <button class="hub-btn hub-btn--sm" id="btnViewAtCommit">&#x1F441; View Deck State</button>
        </div>
      </div>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="hub-btn" id="btnReportBad" style="border-color:var(--hub-red);color:var(--hub-red);flex:1">This is BAD</button>
        <button class="hub-btn" id="btnReportGood" style="border-color:var(--hub-green);color:var(--hub-green);flex:1">This is GOOD</button>
      </div>
      <p style="font-size:11px;color:var(--hub-text-muted);margin-top:20px">Steps remaining: ~${Math.ceil(Math.log2(currentBisectSession.candidateCommitIds.length))}</p>
    </div>
  `;

  $('#btnReportGood')?.addEventListener('click', () => reportBisectResult(nextCommitId, true));
  $('#btnReportBad')?.addEventListener('click', () => reportBisectResult(nextCommitId, false));
  $('#btnViewAtCommit')?.addEventListener('click', () => {
    window.open(`/deck-editor.html?repo=${repoId}&commit=${nextCommitId}&readonly=true`, '_blank');
  });
}

async function reportBisectResult(commitId: string, isGood: boolean): Promise<void> {
  if (!repoId || !currentBisectSession) return;
  try {
    currentBisectSession = await bisectApi.report(repoId, currentBisectSession.id, commitId, isGood);
    renderBisectStep();
  } catch (err) {
    showToast(`Error: ${(err as Error).message}`, 'error');
  }
}

function initExportModal(): void {
  const btnExport = $('#btnExportDeck');
  const modal = $('#exportModal');
  const close = $('#exportModalClose');
  const area = $<HTMLTextAreaElement>('#exportArea');

  if (!btnExport || !modal || !close || !area) return;

  // open modal
  btnExport.addEventListener('click', () => {
    modal.setAttribute('aria-hidden', 'false');
    area.value = generateExportString('text');
  });

  close.addEventListener('click', () => modal.setAttribute('aria-hidden', 'true'));

  // Wire existing buttons
  $('#btnExportText')?.addEventListener('click', function(this: HTMLElement) { 
    area.value = generateExportString('text'); 
    copyToClipboard(area.value); 
    animateCopy(this);
  });
  
  $('#btnExportArena')?.addEventListener('click', function(this: HTMLElement) { 
    area.value = generateExportString('arena'); 
    copyToClipboard(area.value); 
    animateCopy(this);
  });
  
  // Moxfield/Archidekt buttons (aliases for text for now)
  $('#btnExportMoxfield')?.addEventListener('click', function(this: HTMLElement) { 
    area.value = generateExportString('text'); 
    copyToClipboard(area.value); 
    animateCopy(this);
  });
  
  $('#btnExportArchidekt')?.addEventListener('click', function(this: HTMLElement) { 
    area.value = generateExportString('text'); 
    copyToClipboard(area.value); 
    animateCopy(this);
  });

  // Inject MTGO button if missing
  if (!$('#btnExportMTGO')) {
    const btnGroup = $('#btnExportText')?.parentElement;
    if (btnGroup) {
      const mtgoBtn = document.createElement('button');
      mtgoBtn.id = 'btnExportMTGO';
      mtgoBtn.className = 'hub-btn hub-btn--secondary hub-btn--sm';
      mtgoBtn.innerHTML = '\u{1F4E5} MTGO .txt'; // Download icon
      mtgoBtn.style.marginLeft = '8px';
      btnGroup.appendChild(mtgoBtn);
      
      mtgoBtn.addEventListener('click', () => {
        const text = generateExportString('mtgo');
        area.value = text;
        downloadTextFile(text, `deck-${repoId || 'export'}.txt`);
      });
    }
  }
}

function animateCopy(btn: HTMLElement): void {
  const original = btn.innerHTML;
  btn.innerHTML = '\u2714 Copied!';
  btn.classList.add('hub-btn--success');
  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('hub-btn--success');
  }, 1500);
}

function generateExportString(format: 'text' | 'arena' | 'mtgo'): string {
  let output = '';
  const boards = ['commander', 'main', 'sideboard'];
  const labels: Record<string, string> = { commander: 'Commander', main: 'Deck', sideboard: 'Sideboard' };

  boards.forEach(b => {
    const cards = liveCards[b] || [];
    if (cards.length > 0) {
      if (format === 'arena') {
        output += `${labels[b]}\n`;
      } else if (format === 'mtgo' && b === 'sideboard') {
        output += `Sideboard\n`; // MTGO often just wants Sideboard separated
      } else if (format === 'mtgo' && b === 'commander') {
         // MTGO usually puts commander in sidebar or main depending on format, 
         // lets just list it. Or maybe "Commander" header is fine.
         // Standard MTGO .txt import often expects just maindeck lines, then "Sideboard" header
      }
      
      cards.forEach(c => {
        output += `${c.qty} ${c.name}\n`;
      });
      output += '\n';
    }
  });
  return output.trim();
}

function downloadTextFile(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!', 'success'));
}

// ───── QOL Features ─────

function initQOLFeatures(): void {
  // Replace simple prompt-based New PR with full modal
  const btnNewPR = $('#btnNewPR');
  if (btnNewPR) {
    // Remove old listener by cloning
    const newBtn = btnNewPR.cloneNode(true) as HTMLElement;
    btnNewPR.parentNode?.replaceChild(newBtn, btnNewPR);
    newBtn.addEventListener('click', openNewPRModal);
  }
}

// New PR Modal with Template Support
async function openNewPRModal(): Promise<void> {
  if (!repoId || !isLiveMode) {
    showToast('New PR: available in live mode with ?repo= parameter', 'info');
    return;
  }
  if (liveBranches.length < 2) {
    showToast('Need at least 2 branches to create a PR', 'info');
    return;
  }

  // Get current branch diff for template generation
  const sourceBranch = liveBranches.find(b => b.name === currentBranch);
  const targetBranch = liveBranches.find(b => b.isDefault && b.name !== currentBranch) || liveBranches[0];
  
  if (!sourceBranch || !targetBranch || sourceBranch.id === targetBranch.id) {
    showToast('Switch to a non-default branch first to create a PR', 'info');
    return;
  }

  // Try to get diff for template generation
  let templateData = { title: '', desc: '' };
  try {
    // Compare branches to get diff
    const diff = await prApi.getDiff(repoId, 0).catch(() => [] as DeckPatchOp[]); // Mock: would need actual branch compare API
    templateData = generatePRTemplate(diff, liveSettings?.prTemplate as string);
  } catch {
    // Fallback: empty template
  }

  // Create modal HTML
  const modalHTML = `
    <div id="newPRModal" class="hub-modal" aria-hidden="true" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:2000;display:flex;align-items:center;justify-content:center">
      <div class="hub-modal__content" style="background:var(--hub-bg-elevated);border-radius:12px;width:90%;max-width:600px;max-height:90vh;overflow:auto;border:1px solid var(--hub-border-accent)">
        <div class="hub-modal__header" style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hub-border)">
          <h3 style="margin:0;font-size:18px;font-weight:600">Create Pull Request</h3>
          <button id="newPRClose" class="hub-btn" style="font-size:20px;line-height:1">&times;</button>
        </div>
        <div class="hub-modal__body" style="padding:20px">
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Title</label>
            <input type="text" id="newPRTitle" class="hub-input" value="${templateData.title}" placeholder="Enter PR title" style="width:100%;font-size:14px">
          </div>
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Description</label>
            <textarea id="newPRDesc" class="hub-input" placeholder="Enter PR description" style="width:100%;min-height:120px;font-size:13px;font-family:var(--hub-mono)">${templateData.desc}</textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
            <div>
              <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Source Branch</label>
              <select id="newPRSource" class="hub-input" style="width:100%">
                ${liveBranches.map(b => `<option value="${b.id}" ${b.id === sourceBranch.id ? 'selected' : ''}>${b.name}</option>`).join('')}
              </select>
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Target Branch</label>
              <select id="newPRTarget" class="hub-input" style="width:100%">
                ${liveBranches.map(b => `<option value="${b.id}" ${b.id === targetBranch.id ? 'selected' : ''}>${b.name}</option>`).join('')}
              </select>
            </div>
          </div>
          ${templateData.desc ? '<div style="background:var(--hub-deep);padding:12px;border-radius:6px;border:1px solid var(--hub-border);margin-bottom:16px"><div style="font-size:11px;color:var(--hub-gold);margin-bottom:4px">Template Applied</div><div style="font-size:12px;color:var(--hub-text-muted)">Based on detected changes</div></div>' : ''}
        </div>
        <div class="hub-modal__footer" style="display:flex;justify-content:flex-end;gap:12px;padding:16px 20px;border-top:1px solid var(--hub-border)">
          <button id="newPRCancel" class="hub-btn hub-btn--secondary">Cancel</button>
          <button id="newPRSubmit" class="hub-btn hub-btn--primary">Create Pull Request</button>
        </div>
      </div>
    </div>
  `;

  // Add modal to body
  const existingModal = $('#newPRModal');
  if (existingModal) existingModal.remove();
  
  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = modalHTML;
  document.body.appendChild(modalContainer.firstElementChild!);

  const modal = $('#newPRModal');
  if (!modal) return;

  // Show modal
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';

  // Focus title input
  const titleInput = $<HTMLInputElement>('#newPRTitle');
  if (titleInput) titleInput.focus();

  // Event handlers
  const closeModal = () => {
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setTimeout(() => modal.remove(), 300);
  };

  $('#newPRClose')?.addEventListener('click', closeModal);
  $('#newPRCancel')?.addEventListener('click', closeModal);
  
  modal.addEventListener('click', (e: Event) => {
    if (e.target === modal) closeModal();
  });

  $('#newPRSubmit')?.addEventListener('click', async () => {
    const title = titleInput?.value.trim();
    const desc = $<HTMLTextAreaElement>('#newPRDesc')?.value.trim() || '';
    const sourceId = $<HTMLSelectElement>('#newPRSource')?.value;
    const targetId = $<HTMLSelectElement>('#newPRTarget')?.value;

    if (!title) {
      showToast('Please enter a title', 'info');
      titleInput?.focus();
      return;
    }

    if (!sourceId || !targetId || sourceId === targetId) {
      showToast('Source and target branches must be different', 'info');
      return;
    }

    const submitBtn = $('#newPRSubmit') as HTMLButtonElement;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';
    }

    if (!repoId) return;
    
    try {
      await prApi.create(repoId, {
        title: title!,
        description: desc,
        sourceBranchId: sourceId!,
        targetBranchId: targetId!,
      });
      showToast(`PR "${title}" created!`, 'success');
      closeModal();
      loadRepo(repoId); // Refresh
    } catch (err) {
      showToast(`Error: ${err instanceof Error ? err.message : 'Failed to create PR'}`, 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Pull Request';
      }
    }
  });
}

// ───── Card Filter ─────

function initCardFilter(): void {
  // Try to find existing filter input (the "old" one)
  // It likely has a placeholder containing "Filter"
  let filterInput = document.querySelector<HTMLInputElement>('input[placeholder*="Filter"]');
  
  if (!filterInput) {
    // Fallback search: look above the card table
    const tableContainer = $('#cardTableBody')?.parentElement;
    if (tableContainer) {
      filterInput = tableContainer.querySelector<HTMLInputElement>('input');
    }
  }

  if (filterInput) {
    // Check if checks are already attached?
    // We can't really checks, but adding another listener is fine as long as we don't inject a 2nd input.
    filterInput.addEventListener('input', (e) => {
      cardFilterStr = (e.target as HTMLInputElement).value;
      renderLiveCardTable();
    });
    console.log('[DeckHub] Bound listener to existing filter input');
  } else {
    console.warn('[DeckHub] Could not find any filter input');
  }
}

// ───── Init ─────

function init(): void {
  // Auth
  initAuthUI();

  // UI interactions
  initThemeToggle();
  initTabNavigation();
  initBranchDropdown();
  initPRModal();
  initCRUDHandlers();
  initSettingsTab();
  initIssueCRUD();
  initReleaseCRUD();
  initCommandPalette();
  initBranchCompare();
  initWatchModal();
  initBisectWizard();
  initQOLFeatures();
  initExportModal();
  initReadmeEditor();
  initBulkEdit();
  initAddCardDialog();
  initHandSimulator();
  initCardFilter();

  // Check for repo ID in URL
  const params = new URLSearchParams(location.search);
  const repoParam = params.get('repo');

  if (repoParam) {
    // Live mode: fetch real data from API
    console.log('[DeckHub] Loading repo:', repoParam);
    loadRepo(repoParam);
  } else {
    // Demo mode: render static demo data
    console.log('[DeckHub] Demo mode (no ?repo= param)');
    renderFileTree();
    renderCardTable();
    renderCurveBar();
    renderChecks();
    renderPRList();
    renderIssues();
    renderReleases();
    renderInsights();
  }
}

// ───── Starting Hand Simulator (QOL) ─────

function initHandSimulator(): void {
  // Add "Simulate Hand" button to sidebar if not present
  const sidebar = $('.layout__sidebar');
  if (sidebar && !$('#btnSimulateHand')) {
    const btn = document.createElement('button');
    btn.id = 'btnSimulateHand';
    btn.className = 'hub-btn hub-btn--secondary';
    btn.innerHTML = '\u{1F0CF} Simulate Hand';
    btn.style.width = '100%';
    btn.style.marginTop = '12px';
    btn.style.marginBottom = '12px';
    
    // Insert after "New Issue" button or at top of sidebar
    const newIssueBtn = $('#btnNewIssue');
    if (newIssueBtn) {
      newIssueBtn.parentNode?.insertBefore(btn, newIssueBtn.nextSibling);
    } else {
       sidebar.prepend(btn);
    }
    
    btn.addEventListener('click', openHandSimulator);
  }
}

function openHandSimulator(): void {
  const modalHTML = `
    <div id="handSimModal" class="hub-modal" aria-hidden="false" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:2100;display:flex;align-items:center;justify-content:center">
      <div class="hub-modal__content" style="background:var(--hub-bg-elevated);border-radius:12px;width:95%;max-width:1000px;border:1px solid var(--hub-border-accent);display:flex;flex-direction:column;max-height:90vh">
        <div class="hub-modal__header" style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hub-border)">
          <h3 style="margin:0;font-size:18px;font-weight:600">Starting Hand Simulator</h3>
          <button id="handSimClose" class="hub-btn" style="font-size:20px;line-height:1">&times;</button>
        </div>
        <div class="hub-modal__body" style="padding:20px;flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:20px">
           <div id="handContainer" style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;perspective:1000px">
             <!-- Cards go here -->
           </div>
           
           <div style="display:flex;gap:12px;margin-top:auto">
             <button id="handSimMulligan" class="hub-btn hub-btn--danger">Mulligan (Draw 7)</button>
             <button id="handSimDraw1" class="hub-btn hub-btn--secondary">Draw 1</button>
             <button id="handSimKeep" class="hub-btn hub-btn--primary">Keep Hand</button>
           </div>
           
           <div id="handSimStats" style="font-size:12px;color:var(--hub-text-muted);margin-top:8px"></div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  const modal = $('#handSimModal');
  const close = () => modal?.remove();
  
  $('#handSimClose')?.addEventListener('click', close);
  $('#handSimKeep')?.addEventListener('click', close);
  $('#handSimMulligan')?.addEventListener('click', () => drawHand());
  $('#handSimDraw1')?.addEventListener('click', () => drawCard());

  // Initial Draw
  drawHand();
}

// State for simulation
let simDeck: AdaptedCard[] = [];
let simHand: AdaptedCard[] = [];

function drawHand(): void {
  // Flatten deck logic
  simDeck = [];
  (liveCards.main || []).forEach(c => {
    for (let i = 0; i < c.qty; i++) simDeck.push(c);
  });
  
  // Shuffle - Fisher-Yates
  for (let i = simDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [simDeck[i], simDeck[j]] = [simDeck[j], simDeck[i]];
  }
  
  simHand = simDeck.splice(0, 7);
  renderHand();
}

function drawCard(): void {
  if (simDeck.length > 0) {
    simHand.push(simDeck.shift()!);
    renderHand();
  } else {
    showToast('Library empty!', 'info');
  }
}

function renderHand(): void {
  const container = $('#handContainer');
  const stats = $('#handSimStats');
  if (!container) return;
  
  if (stats) stats.textContent = `${simHand.length} Cards in Hand / ${simDeck.length} in Library`;
  
  container.innerHTML = simHand.map(c => {
    // Attempt to resolve image
    // If we have an enriched image property, use it.
    // If not, we might not have it.
    const imgSrc = c.image || 'https://c1.scryfall.com/file/scryfall-cards/large/front/4/0/403f847d-810a-45c1-8408-4171630c98f9.jpg?1562910793'; // Fallback back of card or generic? 
    // Actually, let's use a placeholder if no image, or text.
    
    // Better fallback: if no image, render text card
    const hasImage = !!c.image;
    
    return `
      <div class="hand-card" style="width:140px;height:196px;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.5);transition:transform 0.2s;background:#000;position:relative;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px"
           onmouseover="this.style.transform='scale(1.1) translateY(-10px)';this.style.zIndex='100'"
           onmouseout="this.style.transform='scale(1) translateY(0)';this.style.zIndex='1'">
        ${hasImage 
          ? `<img src="${c.image}" style="width:100%;height:100%;object-fit:cover" alt="${escapeHtml(c.name)}">`
          : `<span style="color:#fff;font-size:12px;font-weight:600">${escapeHtml(c.name)}</span>`
        }
      </div>
    `;
  }).join('');
}

// ───── Keyboard Navigation ─────

function initKeyboardNavigation(): void {
  let focusedPRIndex = -1;
  let focusedIssueIndex = -1;

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Skip if in input or modal open
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    
    const prModal = $('#prModal');
    const issueModal = $('#issueModal');
    const cmdPalette = $('#cmdPalette');
    if (prModal?.getAttribute('aria-hidden') === 'false' || 
        issueModal?.getAttribute('aria-hidden') === 'false' ||
        cmdPalette?.getAttribute('aria-hidden') === 'false') return;

    const activeTab = document.querySelector('.tab-nav__btn[aria-selected="true"]')?.id;

    // j/k navigation for lists
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      
      if (activeTab === 'tab-prs') {
        const items = $$<HTMLElement>('.pr-item[data-pr]');
        if (items.length === 0) return;
        
        if (e.key === 'j') {
          focusedPRIndex = Math.min(focusedPRIndex + 1, items.length - 1);
        } else {
          focusedPRIndex = Math.max(focusedPRIndex - 1, 0);
        }
        
        items.forEach((item, i) => {
          item.style.background = i === focusedPRIndex ? 'var(--hub-hover)' : '';
          if (i === focusedPRIndex) item.scrollIntoView({ block: 'nearest' });
        });
      } else if (activeTab === 'tab-issues') {
        const items = $$<HTMLElement>('.issue-item[data-issue]');
        if (items.length === 0) return;
        
        if (e.key === 'j') {
          focusedIssueIndex = Math.min(focusedIssueIndex + 1, items.length - 1);
        } else {
          focusedIssueIndex = Math.max(focusedIssueIndex - 1, 0);
        }
        
        items.forEach((item, i) => {
          item.style.background = i === focusedIssueIndex ? 'var(--hub-hover)' : '';
          if (i === focusedIssueIndex) item.scrollIntoView({ block: 'nearest' });
        });
      }
    }

    // Enter to open
    if (e.key === 'Enter') {
      if (activeTab === 'tab-prs' && focusedPRIndex >= 0) {
        const items = $$<HTMLElement>('.pr-item[data-pr]');
        const prNumber = parseInt(items[focusedPRIndex]?.dataset.pr || '0', 10);
        if (prNumber) openLivePRModal(prNumber);
      } else if (activeTab === 'tab-issues' && focusedIssueIndex >= 0) {
        const items = $$<HTMLElement>('.issue-item[data-issue]');
        const issueNumber = parseInt(items[focusedIssueIndex]?.dataset.issue || '0', 10);
        if (issueNumber) {
          // Open issue modal
          const issue = liveIssues.find(i => i.number === issueNumber);
          if (issue) openIssueModalWithData(issue);
        }
      }
    }

    // Reset focus when tab changes
    document.querySelectorAll('.tab-nav__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        focusedPRIndex = -1;
        focusedIssueIndex = -1;
      });
    });
  });
}

// ───── Pin System ─────

function initPinSystem(): void {
  renderPinnedItems();
}

function getPinnedPRs(): number[] {
  try {
    return JSON.parse(localStorage.getItem('deckhub_pinned_prs') || '[]');
  } catch {
    return [];
  }
}

function getPinnedIssues(): number[] {
  try {
    return JSON.parse(localStorage.getItem('deckhub_pinned_issues') || '[]');
  } catch {
    return [];
  }
}

function togglePinPR(prNumber: number): void {
  const pinned = getPinnedPRs();
  const index = pinned.indexOf(prNumber);
  if (index === -1) {
    pinned.push(prNumber);
    if (pinned.length > 5) pinned.shift(); // Max 5
    showToast('PR pinned', 'success');
  } else {
    pinned.splice(index, 1);
    showToast('PR unpinned', 'info');
  }
  localStorage.setItem('deckhub_pinned_prs', JSON.stringify(pinned));
  renderPinnedItems();
  renderLivePRList(); // Refresh star icons
}

function togglePinIssue(issueNumber: number): void {
  const pinned = getPinnedIssues();
  const index = pinned.indexOf(issueNumber);
  if (index === -1) {
    pinned.push(issueNumber);
    if (pinned.length > 5) pinned.shift();
    showToast('Issue pinned', 'success');
  } else {
    pinned.splice(index, 1);
    showToast('Issue unpinned', 'info');
  }
  localStorage.setItem('deckhub_pinned_issues', JSON.stringify(pinned));
  renderPinnedItems();
  renderLiveIssues();
}

function renderPinnedItems(): void {
  const container = $('#pinnedItemsSidebar');
  if (!container) return;

  const pinnedPRs = getPinnedPRs();
  const pinnedIssues = getPinnedIssues();
  
  if (pinnedPRs.length === 0 && pinnedIssues.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  
  let html = '<div style="font-size:11px;font-weight:600;color:var(--hub-text-muted);text-transform:uppercase;margin-bottom:8px">Pinned</div>';
  
  // Pinned PRs
  pinnedPRs.forEach(prNumber => {
    const pr = livePRs.find(p => p.number === prNumber);
    if (pr) {
      html += `
        <div class="pinned-item" data-pinned-pr="${prNumber}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--hub-raised);border-radius:6px;margin-bottom:6px;cursor:pointer;border:1px solid var(--hub-border);font-size:12px">
          <span style="font-size:10px">\u{1F501}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">#${pr.number} ${escapeHtml(pr.title)}</span>
          <button class="pin-remove" data-pr="${prNumber}" style="background:none;border:none;color:var(--hub-text-muted);cursor:pointer;font-size:12px;padding:0 2px">&times;</button>
        </div>
      `;
    }
  });
  
  // Pinned Issues
  pinnedIssues.forEach(issueNumber => {
    const issue = liveIssues.find(i => i.number === issueNumber);
    if (issue) {
      html += `
        <div class="pinned-item" data-pinned-issue="${issueNumber}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--hub-raised);border-radius:6px;margin-bottom:6px;cursor:pointer;border:1px solid var(--hub-border);font-size:12px">
          <span style="font-size:10px">\u{1F4CB}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">#${issue.number} ${escapeHtml(issue.title)}</span>
          <button class="pin-remove" data-issue="${issueNumber}" style="background:none;border:none;color:var(--hub-text-muted);cursor:pointer;font-size:12px;padding:0 2px">&times;</button>
        </div>
      `;
    }
  });

  container.innerHTML = html;

  // Wire click handlers
  container.querySelectorAll('[data-pinned-pr]').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('pin-remove')) return;
      const prNumber = parseInt((el as HTMLElement).dataset.pinnedPr || '0', 10);
      if (prNumber) openLivePRModal(prNumber);
    });
  });

  container.querySelectorAll('[data-pinned-issue]').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('pin-remove')) return;
      const issueNumber = parseInt((el as HTMLElement).dataset.pinnedIssue || '0', 10);
      const issue = liveIssues.find(i => i.number === issueNumber);
      if (issue) openIssueModalWithData(issue);
    });
  });

  // Wire remove buttons
  container.querySelectorAll('.pin-remove[data-pr]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prNumber = parseInt((btn as HTMLElement).dataset.pr || '0', 10);
      if (prNumber) togglePinPR(prNumber);
    });
  });

  container.querySelectorAll('.pin-remove[data-issue]').forEach(btn => {
    btn.addEventListener('click', () => {
      const issueNumber = parseInt((btn as HTMLElement).dataset.issue || '0', 10);
      if (issueNumber) togglePinIssue(issueNumber);
    });
  });
}

function openIssueModalWithData(issue: AdaptedIssue): void {
  const modal = $('#issueModal');
  if (!modal) return;
  
  const titleEl = $('#issueModalTitle');
  const bodyEl = $('#issueModalBody');
  
  if (titleEl) titleEl.textContent = `#${issue.number} ${issue.title}`;
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
        ${issue.labels.map(l => `<span class="hub-badge hub-badge--tag">${escapeHtml(l)}</span>`).join(' ')}
      </div>
      <div style="font-size:13px;color:var(--hub-text-dim);margin-bottom:16px">
        ${issue.status === 'open' ? 'Opened' : 'Closed'} ${issue.time}${issue.author ? ` by ${issue.author}` : ''} · ${issue.comments} comments
      </div>
      <div style="background:var(--hub-raised);padding:16px;border-radius:8px;border:1px solid var(--hub-border)">
        <em style="color:var(--hub-text-muted)">Issue details would appear here...</em>
      </div>
    `;
  }
  
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

// ───── Feature 7: Inline Edit ─────

function initInlineEdit(): void {
  // Add double-click handlers to PR and issue items
  document.addEventListener('dblclick', async (e) => {
    const target = e.target as HTMLElement;
    const prItem = target.closest('.pr-item');
    const issueItem = target.closest('.issue-item');
    
    if (prItem) {
      const prNumber = parseInt(prItem.getAttribute('data-pr') || '0', 10);
      const titleEl = prItem.querySelector('.pr-item__title');
      if (titleEl && target.closest('.pr-item__title')) {
        enableInlineEdit(titleEl as HTMLElement, async (newTitle) => {
          if (!repoId) return;
          try {
            await prApi.update(repoId, prNumber, { title: newTitle });
            showToast('PR title updated', 'success');
            loadRepo(repoId);
          } catch (err) {
            showToast('Failed to update PR', 'error');
          }
        });
      }
    } else if (issueItem) {
      const issueNumber = parseInt(issueItem.getAttribute('data-issue') || '0', 10);
      const titleEl = issueItem.querySelector('.issue-item__title');
      if (titleEl && target.closest('.issue-item__title')) {
        enableInlineEdit(titleEl as HTMLElement, async (newTitle) => {
          if (!repoId) return;
          try {
            await issueApi.update(repoId, issueNumber, { title: newTitle });
            showToast('Issue title updated', 'success');
            loadRepo(repoId);
          } catch (err) {
            showToast('Failed to update issue', 'error');
          }
        });
      }
    }
  });
}

function enableInlineEdit(element: HTMLElement, onSave: (value: string) => void): void {
  const originalText = element.textContent || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = originalText;
  input.className = 'hub-input';
  input.style.width = '100%';
  input.style.fontSize = window.getComputedStyle(element).fontSize;
  
  element.innerHTML = '';
  element.appendChild(input);
  input.focus();
  input.select();
  
  function save() {
    const newValue = input.value.trim();
    if (newValue && newValue !== originalText) {
      onSave(newValue);
    }
    element.textContent = newValue || originalText;
  }
  
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      element.textContent = originalText;
    }
  });
}

// ───── Feature 8: Diff Export ─────

function initDiffExport(): void {
  // Export button is added dynamically in PR modal
  const observer = new MutationObserver(() => {
    const exportBtn = $('#btnExportDiff');
    if (exportBtn && !exportBtn.dataset.wired) {
      exportBtn.dataset.wired = 'true';
      exportBtn.addEventListener('click', exportCurrentDiff);
    }
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
}

async function exportCurrentDiff(): Promise<void> {
  const diffContainer = document.querySelector('.pr-modal__diff-detail');
  if (!diffContainer) {
    showToast('No diff to export', 'info');
    return;
  }
  
  // Simple text export as PNG is complex without html2canvas
  // For now, export as text/markdown
  const prTitle = $('#prModalTitle')?.textContent || 'PR';
  const diffLines = Array.from(diffContainer.querySelectorAll('.pr-modal__diff-line'))
    .map(line => line.textContent)
    .join('\n');
  
  const markdown = `# ${prTitle}\n\n## Changes\n\n${diffLines}`;
  
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `diff-${Date.now()}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast('Diff exported as Markdown', 'success');
}

// ───── Feature 9: Notifications ─────

function initNotifications(): void {
  // Check for updates every 30 seconds when in live mode
  if (!isLiveMode) return;
  
  let lastPRCount = 0;
  let lastIssueCount = 0;
  
  setInterval(async () => {
    if (!repoId) return;
    
    try {
      const [prs, issues] = await Promise.all([
        prApi.list(repoId, 'open').catch(() => []),
        issueApi.list(repoId).catch(() => []),
      ]);
      
      const openPRs = prs.length;
      const openIssues = issues.filter((i: Issue) => i.status === 'open').length;
      
      if (lastPRCount > 0 && openPRs > lastPRCount) {
        showToast(`${openPRs - lastPRCount} new pull request${openPRs - lastPRCount > 1 ? 's' : ''}`, 'info', 5000);
      }
      
      if (lastIssueCount > 0 && openIssues > lastIssueCount) {
        showToast(`${openIssues - lastIssueCount} new issue${openIssues - lastIssueCount > 1 ? 's' : ''}`, 'info', 5000);
      }
      
      lastPRCount = openPRs;
      lastIssueCount = openIssues;
    } catch {
      // Ignore errors
    }
  }, 30000);
  
  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ───── Feature 10: Repo Switcher ─────

function initRepoSwitcher(): void {
  const repoHeader = $('.repo-header__name');
  if (!repoHeader) return;
  
  repoHeader.style.cursor = 'pointer';
  repoHeader.title = 'Click to switch repository';
  
  repoHeader.addEventListener('click', () => {
    const recentRepos = getRecentRepos();
    if (recentRepos.length === 0) {
      showToast('No recent repositories', 'info');
      return;
    }
    
    const menu = document.createElement('div');
    menu.className = 'repo-switcher-menu';
    menu.style.cssText = `
      position: absolute;
      top: 100%;
      left: 0;
      background: var(--hub-bg-elevated);
      border: 1px solid var(--hub-border);
      border-radius: 8px;
      padding: 8px 0;
      min-width: 200px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 1000;
    `;
    
    menu.innerHTML = recentRepos.map(r => `
      <div class="repo-switcher-item" data-repo="${escapeHtml(r)}" style="padding: 8px 16px; cursor: pointer; hover: background: var(--hub-hover);">
        ${escapeHtml(r)}
      </div>
    `).join('');
    
    repoHeader.style.position = 'relative';
    repoHeader.appendChild(menu);
    
    menu.querySelectorAll('.repo-switcher-item').forEach(item => {
      item.addEventListener('click', () => {
        const repo = (item as HTMLElement).dataset.repo;
        if (repo) {
          window.location.href = `?repo=${encodeURIComponent(repo)}`;
        }
      });
    });
    
    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!menu.contains(e.target as Node)) {
          menu.remove();
          document.removeEventListener('click', close);
        }
      });
    }, 0);
  });
}

function getRecentRepos(): string[] {
  try {
    return JSON.parse(localStorage.getItem('deckhub_recent_repos') || '[]');
  } catch {
    return [];
  }
}

function addRecentRepo(repoId: string): void {
  const repos = getRecentRepos().filter(r => r !== repoId);
  repos.unshift(repoId);
  while (repos.length > 5) repos.pop();
  localStorage.setItem('deckhub_recent_repos', JSON.stringify(repos));
}

// ───── Feature 11: Stats Charts ─────

function initStatsCharts(): void {
  // Charts are rendered in renderDeckStats function
  // This adds interactive tooltips and updates
  const curveBar = $('#curveBar');
  if (curveBar) {
    curveBar.addEventListener('mouseover', (e) => {
      const bar = (e.target as HTMLElement).closest('.curve-bar__segment');
      if (bar) {
        const count = bar.getAttribute('data-count');
        const cmc = bar.getAttribute('data-cmc');
        showTooltip(e as MouseEvent, `CMC ${cmc}: ${count} cards`);
      }
    });
  }
}

function showTooltip(e: MouseEvent, text: string): void {
  const tooltip = document.createElement('div');
  tooltip.className = 'deckhub-tooltip';
  tooltip.textContent = text;
  tooltip.style.cssText = `
    position: fixed;
    left: ${e.clientX + 10}px;
    top: ${e.clientY - 30}px;
    background: var(--hub-bg-elevated);
    border: 1px solid var(--hub-border-accent);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 10000;
    pointer-events: none;
  `;
  document.body.appendChild(tooltip);
  
  setTimeout(() => tooltip.remove(), 2000);
}

// ───── Feature 12: Drag & Drop Reorder ─────

function initDragDropReorder(): void {
  // Simple DnD for PR and Issue lists
  const prList = $('#prListBody');
  const issueList = $('#issueListBody');
  
  if (prList) setupDragAndDrop(prList, 'pr');
  if (issueList) setupDragAndDrop(issueList, 'issue');
}

function setupDragAndDrop(container: HTMLElement, type: 'pr' | 'issue'): void {
  let draggedItem: HTMLElement | null = null;
  
  container.addEventListener('dragstart', (e) => {
    draggedItem = (e.target as HTMLElement).closest(type === 'pr' ? '.pr-item' : '.issue-item') as HTMLElement;
    if (draggedItem) {
      draggedItem.style.opacity = '0.5';
      e.dataTransfer?.setData('text/plain', draggedItem.getAttribute(`data-${type}`) || '');
    }
  });
  
  container.addEventListener('dragend', (e) => {
    if (draggedItem) {
      draggedItem.style.opacity = '1';
      draggedItem = null;
    }
  });
  
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest(type === 'pr' ? '.pr-item' : '.issue-item') as HTMLElement;
    if (target && target !== draggedItem) {
      const rect = target.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (e.clientY < midpoint) {
        container.insertBefore(draggedItem!, target);
      } else {
        container.insertBefore(draggedItem!, target.nextSibling);
      }
    }
  });
  
  // Make items draggable
  container.querySelectorAll(type === 'pr' ? '.pr-item' : '.issue-item').forEach(item => {
    (item as HTMLElement).draggable = true;
  });
}

// ───── README Editor ─────

function initReadmeEditor(): void {
  const btnEdit = $('#btnEditReadme');
  const btnClose = $('#readmeModalClose');
  const btnSave = $('#btnSaveReadme');
  const btnPreview = $('#btnPreviewReadme');
  const modal = $('#readmeModal');
  const editor = $<HTMLTextAreaElement>('#readmeEditor');

  // Show edit button only in live mode
  if (btnEdit) {
    btnEdit.style.display = isLiveMode ? 'inline-block' : 'none';
    btnEdit.addEventListener('click', openReadmeEditor);
  }

  if (btnClose) btnClose.addEventListener('click', closeReadmeEditor);
  if (btnSave) btnSave.addEventListener('click', saveReadme);
  if (btnPreview) btnPreview.addEventListener('click', previewReadme);

  // Template buttons
  $$<HTMLButtonElement>('.primer-tpl-btn').forEach(btn => {
    btn.addEventListener('click', () => insertTemplate(btn.dataset.template || ''));
  });

  // Load current README content when opening
  function openReadmeEditor(): void {
    if (!modal || !editor) return;
    
    let content = '';
    
    // Try to get content from various sources
    if (liveDeckMeta?.description) {
      content = liveDeckMeta.description;
    } else if (!isLiveMode) {
      // Demo mode: check localStorage
      try {
        content = localStorage.getItem('deckhub_demo_readme') || '';
      } catch { /* ignore */ }
    } else if (repoId) {
      // Live mode: check repo-specific localStorage backup
      try {
        content = localStorage.getItem(`deckhub_readme_${repoId}`) || '';
      } catch { /* ignore */ }
    }
    
    // If no content found, use default template
    if (!content) {
      content = `# ${liveDeckMeta?.name || 'Deck Primer'}

## Strategy
Describe your deck's game plan...

## Key Cards
- Card 1
- Card 2

## Win Conditions
How do you win the game?
`;
    }
    
    editor.value = content;
    
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    editor.focus();
  }

  function closeReadmeEditor(): void {
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  async function saveReadme(): Promise<void> {
    if (!editor) return;
    
    const content = editor.value.trim();
    if (!content) {
      showToast('README cannot be empty', 'info');
      return;
    }

    const btn = btnSave as HTMLButtonElement;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
    }

    // Demo mode: Save locally only
    if (!isLiveMode || !repoId) {
      // Update local state
      if (!liveDeckMeta) {
        liveDeckMeta = { name: 'Demo Deck', description: '', format: 'EDH' };
      }
      liveDeckMeta.description = content;
      
      // Save to localStorage for persistence in demo mode
      try {
        localStorage.setItem('deckhub_demo_readme', content);
      } catch { /* ignore */ }
      
      // Refresh preview
      renderLivePrimer();
      showToast('README saved locally (Demo Mode)', 'success');
      closeReadmeEditor();
      
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '&#x1F4BE; Save README';
      }
      return;
    }

    // Live mode: Try to save via API
    try {
      console.log('[README] Attempting to save to repo:', repoId);
      console.log('[README] API Base:', typeof window !== 'undefined' ? (window.location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://decklens-api.chrisgarkisch.workers.dev') : '');
      
      // Check auth first
      const user = await getCurrentUser();
      console.log('[README] Current user:', user);
      
      if (!user) {
        showToast('Please log in to save README', 'error');
        closeReadmeEditor();
        return;
      }

      // Update deck meta/description via repo API (not settings API, as description is on the repo object)
      console.log('[README] Calling repoApi.update...');
      await repoApi.update(repoId, { description: content });
      console.log('[README] repoApi.update succeeded');
      
      // Update local state
      if (liveDeckMeta) {
        liveDeckMeta.description = content;
      }
      
      // Refresh preview
      renderLivePrimer();
      
      showToast('README saved successfully!', 'success');
      closeReadmeEditor();
    } catch (err: any) {
      console.error('[README] Save error:', err);
      console.error('[README] Error name:', err.name);
      console.error('[README] Error message:', err.message);
      console.error('[README] Error stack:', err.stack);
      
      // Check if it's an auth error
      if (err.message?.includes('Unauthorized') || err.message?.includes('401')) {
        showToast('Please log in to save README', 'error');
      } else if (err.message?.includes('permission') || err.message?.includes('403')) {
        showToast('You do not have permission to edit this README', 'error');
      } else if (err.message?.includes('fetch') || err.name === 'TypeError') {
        // Network error - save locally as fallback
        console.log('[README] Network error, saving to localStorage as fallback');
        if (liveDeckMeta) {
          liveDeckMeta.description = content;
        }
        try {
          localStorage.setItem(`deckhub_readme_${repoId}`, content);
          console.log('[README] Saved to localStorage');
        } catch (e) { 
          console.error('[README] localStorage error:', e);
        }
        renderLivePrimer();
        showToast('Saved locally (API unavailable - check console)', 'info');
        closeReadmeEditor();
      } else if (err.message?.includes('CORS') || err.message?.includes('cross-origin')) {
        showToast('CORS error - API configuration issue', 'error');
        console.error('[README] CORS Error - Check Cloudflare Worker CORS settings');
      } else {
        showToast(`Failed to save: ${err.message || 'Unknown error'}`, 'error');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '&#x1F4BE; Save README';
      }
    }
  }

  function previewReadme(): void {
    if (!editor) return;
    const markdown = editor.value;
    const html = markdownToHtml(markdown);
    
    // Show preview in a temporary div or alert
    const previewDiv = document.createElement('div');
    previewDiv.innerHTML = html;
    previewDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: var(--hub-bg-elevated);
      border: 1px solid var(--hub-border);
      border-radius: 8px;
      padding: 20px;
      max-width: 600px;
      max-height: 80vh;
      overflow: auto;
      z-index: 3000;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close Preview';
    closeBtn.className = 'hub-btn hub-btn--primary';
    closeBtn.style.marginTop = '16px';
    closeBtn.onclick = () => previewDiv.remove();
    
    previewDiv.appendChild(closeBtn);
    document.body.appendChild(previewDiv);
  }

  function insertTemplate(template: string): void {
    if (!editor) return;
    
    const templates: Record<string, string> = {
      strategy: `## Strategy

### Early Game
- Establish mana ramp
- Deploy tax pieces
- Set up card draw engines

### Mid Game
- Control the board
- Build incremental advantage
- Prepare combo pieces

### Late Game
- Execute win condition
- Maintain lock if needed`,
      
      wincons: `## Win Conditions

### Primary
1. **Combo A**: Describe your main combo
   - Card 1 + Card 2 + Card 3
   - Result: Infinite mana/draw/damage

### Backup
- **Combo B**: Alternative win
- **Beatdown**: Commander damage
- **Stax**: Lock opponents out`,
      
      matchups: `## Matchup Guide

### Good Against
- **Aggro**: Wraths, pillowfort
- **Midrange**: Value advantage
- **Control**: Tax effects

### Bad Against
- **Fast Combo**: Too slow
- **Stax**: Competing locks
- **Goblins**: Wide boards

### Mulligan Guide
Keep: Interaction, ramp, card draw
Mulligan: Slow hands, no early plays`,
      
      budget: `## Budget Options

### Expensive -> Budget
- Mana Crypt -> Sol Ring
- Force of Will -> Fierce Guardianship
- Imperial Seal -> Vampiric Tutor

### Gradual Upgrades
1. Start with budget mana base
2. Add interaction suite
3. Upgrade to fast mana
4. Optimize tutors`,
      
      full: `# Deck Strategy

## Overview
Brief description of your deck's game plan.

## Strategy

### Early Game
- Establish mana ramp
- Deploy tax pieces
- Set up card draw engines

### Mid Game
- Control the board
- Build incremental advantage
- Prepare combo pieces

### Late Game
- Execute win condition
- Maintain lock if needed

## Win Conditions

### Primary
1. **Main Combo**: Describe your combo
   - Required cards
   - Execution steps
   - Backup plans

### Alternative
- Commander damage
- Stax lock
- Beatdown

## Matchup Guide

### Good Against
- List favorable matchups

### Bad Against
- List difficult matchups

### Mulligan Strategy
What to keep vs mulligan

## Budget Options

### Core (Under $100)
Essential budget replacements

### Upgrade Path
Priority order for improvements`
    };
    
    const text = templates[template] || '';
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const current = editor.value;
    
    editor.value = current.substring(0, start) + text + current.substring(end);
    editor.focus();
    editor.selectionStart = editor.selectionEnd = start + text.length;
  }
}

function htmlToMarkdown(html: string): string {
  // Simple HTML to Markdown conversion
  return html
    .replace(/<h3>(.*?)<\/h3>/gi, '## $1\n\n')
    .replace(/<h4>(.*?)<\/h4>/gi, '### $1\n\n')
    .replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<ul>(.*?)<\/ul>/gis, '$1')
    .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function markdownToHtml(markdown: string): string {
  // Simple Markdown to HTML conversion
  return markdown
    .replace(/^### (.*$)/gim, '<h4>$1</h4>')
    .replace(/^## (.*$)/gim, '<h3>$1</h3>')
    .replace(/^# (.*$)/gim, '<h2>$1</h2>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/^\- (.*$)/gim, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hl])/gm, '<p>$&')
    .replace(/$(?<!<\/p>)/gm, '$&</p>');
}

// ───── Budget Analysis ─────

function renderBudgetStats(): void {
  const container = $('#budgetStats');
  
  const allCards = [
    ...(liveCards.commander || []),
    ...(liveCards.main || []),
    ...(liveCards.sideboard || []),
  ];

  if (allCards.length === 0) {
    if (container) container.innerHTML = '';
    return;
  }

  // Calculate total price
  const totalPrice = allCards.reduce((sum, c) => sum + (c.price || 0) * c.qty, 0);

  // Find top 5 expensive cards
  const sortedByPrice = [...allCards]
    .filter(c => c.price && c.price > 0)
    .sort((a, b) => (b.price || 0) - (a.price || 0))
    .slice(0, 5);

  if (!container) {
     return; // Should be created in renderLiveStats
  }

  const topCardsHTML = sortedByPrice.map(c => {
    const isHighValue = (c.price || 0) >= 10;
    const priceColor = isHighValue ? 'var(--hub-gold)' : 'var(--hub-text-muted)';
    return `
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:4px;padding:2px 0;border-bottom:1px dashed var(--hub-border-dim)">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px;display:flex;align-items:center gap:4px">
         ${isHighValue ? '<span style="font-size:10px">💎</span>' : ''} ${c.qty} ${escapeHtml(c.name)}
      </span>
      <span style="color:${priceColor};font-family:var(--hub-mono);font-weight:${isHighValue ? '600' : '400'}">$${(c.price || 0).toFixed(2)}</span>
    </div>
  `}).join('');

  container.innerHTML = `
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--hub-border)">
      <div style="background:var(--hub-bg-deep);padding:12px;border-radius:8px;margin-bottom:12px;border:1px solid var(--hub-border)">
        <h4 style="font-size:11px;text-transform:uppercase;color:var(--hub-text-muted);margin:0 0 4px 0">Total Deck Value</h4>
        <div style="font-size:24px;font-weight:700;color:var(--hub-gold);font-family:var(--hub-mono)">$${totalPrice.toFixed(2)}</div>
      </div>
      
      ${topCardsHTML ? `
        <div style="margin-bottom:8px;font-size:11px;font-weight:600;color:var(--hub-text-muted);text-transform:uppercase;display:flex;justify-content:space-between">
            <span>Top Money Cards</span>
            <span>Price</span>
        </div>
        ${topCardsHTML}
      ` : '<div style="color:var(--hub-text-muted);font-style:italic;font-size:12px">No price data available</div>'}
    </div>
  `;
}

// ───── Mana Analytics ─────

function renderManaAnalytics(): void {
  const container = $('#manaAnalytics'); // Need to ensure this container exists in the HTML or inject it
  
  // Calculate Pips
  const pips = { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 };
  const allCards = [...(liveCards.commander||[]), ...(liveCards.main||[])];
  
  allCards.forEach(c => {
    if (!c.manaCost) return;
    const cost = c.manaCost.toLowerCase();
    pips.w += (cost.match(/\{w\}/g) || []).length;
    pips.u += (cost.match(/\{u\}/g) || []).length;
    pips.b += (cost.match(/\{b\}/g) || []).length;
    pips.r += (cost.match(/\{r\}/g) || []).length;
    pips.g += (cost.match(/\{g\}/g) || []).length;
    pips.c += (cost.match(/\{c\}/g) || []).length;
  });
  
  // Calculate Sources
  const sources = { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0 };
  allCards.forEach(c => {
    if (c.produced) {
      c.produced.forEach(color => {
        const k = color.toLowerCase();
        if (k in sources) sources[k as keyof typeof sources]++;
      });
    }
  });
  
  const totalPips = Object.values(pips).reduce((a, b) => a + b, 0) || 1; 
  // Avoid div/0
  
  // Render Chart HTML using simple CSS bars
  const colors = [
    { key: 'w', color: '#f0f2c0', label: 'White' },
    { key: 'u', color: '#b3ceea', label: 'Blue' },
    { key: 'b', color: '#a69f9d', label: 'Black' },
    { key: 'r', color: '#eb9f82', label: 'Red' },
    { key: 'g', color: '#c4d3ca', label: 'Green' },
    { key: 'c', color: '#ccc2c0', label: 'Colorless' },
  ];
  
  const rows = colors.map(c => {
    const pipCount = pips[c.key as keyof typeof pips];
    const srcCount = sources[c.key as keyof typeof sources];
    if (pipCount === 0 && srcCount === 0) return '';
    
    const pipPct = Math.min(100, (pipCount / totalPips) * 100 * 2); // Scale up for visibility
    
    return `
      <div style="display:flex;align-items:center;margin-bottom:8px;font-size:12px">
        <div style="width:20px;text-align:center;font-weight:bold;color:${c.color === '#f0f2c0' ? '#999' : c.color}"><i class="ms ms-${c.key} ms-cost"></i></div>
        <div style="flex:1;margin-left:8px">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <span style="color:var(--hub-text-muted)">Pips: ${pipCount}</span>
            <span style="color:var(--hub-text-muted)">Sources: ${srcCount}</span>
          </div>
          <div style="height:6px;background:var(--hub-bg-deep);border-radius:3px;overflow:hidden;position:relative">
            <div style="position:absolute;left:0;top:0;bottom:0;width:${pipPct}%;background:${c.color};opacity:0.8"></div>
            <div style="position:absolute;left:0;top:-2px;bottom:-2px;width:2px;background:#fff;left:${Math.min(100, srcCount * 5)}%"></div> 
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (!container) {
     // If container is missing, let's inject it into the Stats column or similar
     // Finding a place in renderLiveStats to call this?
     // Or we create a modal/popover? 
     // Let's return the HTML string and let renderLiveStats use it.
     return; // Logic handled in renderLiveStats
  }
  
  container.innerHTML = `
    <h4 style="font-size:13px;font-weight:600;margin-bottom:12px">Mana Analysis</h4>
    ${rows || '<div style="color:var(--hub-text-muted);font-style:italic">No mana costs found</div>'}
    <div style="font-size:10px;color:var(--hub-text-dim);margin-top:8px">Bar = Pip Intensity | Marker = Sources (approx)</div>
  `;
}

// ───── Bulk Edit ─────

function initBulkEdit(): void {
  let btn = $('#btnBulkEdit');
  
  if (!btn) {
    // Inject into header actions
    const headerActions = $('.repo-header__actions');
    if (headerActions) {
      btn = document.createElement('button');
      btn.id = 'btnBulkEdit';
      btn.className = 'hub-btn hub-btn--secondary hub-btn--sm';
      btn.innerHTML = '&#x270E; Bulk Edit';
      btn.style.marginLeft = '8px';
      headerActions.appendChild(btn);
    }
  }

  if (btn) {
    btn.addEventListener('click', openBulkEditModal);
  }
}

// ───── Add Card (Autocomplete) ─────

function initAddCardDialog(): void {
  let btn = $('#btnAddCardHeader');
  
  if (!btn) {
    const headerActions = $('.repo-header__actions');
    if (headerActions) {
      btn = document.createElement('button');
      btn.id = 'btnAddCardHeader';
      btn.className = 'hub-btn hub-btn--primary hub-btn--sm';
      btn.innerHTML = '&#x2795; Add Card';
      btn.style.marginLeft = '8px';
      headerActions.appendChild(btn);
    }
  }

  if (btn) {
    btn.addEventListener('click', openAddCardModal);
  }
}

function openAddCardModal(): void {
  if (!repoId) return;

  const modalHTML = `
    <div id="addCardModal" class="hub-modal" aria-hidden="false" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:2000;display:flex;align-items:center;justify-content:center">
      <div class="hub-modal__content" style="background:var(--hub-bg-elevated);border-radius:12px;width:90%;max-width:500px;border:1px solid var(--hub-border-accent);display:flex;flex-direction:column;max-height:90vh">
        <div class="hub-modal__header" style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hub-border)">
          <h3 style="margin:0;font-size:16px;font-weight:600">Add Card</h3>
          <button id="addCardClose" class="hub-btn" style="font-size:20px;line-height:1">&times;</button>
        </div>
        <div class="hub-modal__body" style="padding:20px;overflow-y:visible">
           <div style="position:relative;margin-bottom:16px">
             <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Card Name</label>
             <input type="text" id="addCardInput" class="hub-input" placeholder="Search Scryfall..." autocomplete="off" style="width:100%">
             <div id="addCardSuggestions" style="position:absolute;top:100%;left:0;right:0;background:var(--hub-bg-elevated);border:1px solid var(--hub-border);border-top:none;border-radius:0 0 8px 8px;max-height:200px;overflow-y:auto;z-index:10;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.3)"></div>
           </div>
           
           <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
             <div>
               <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Board</label>
               <select id="addCardBoard" class="hub-select" style="width:100%">
                 <option value="main">Mainboard</option>
                 <option value="commander">Commander</option>
                 <option value="sideboard">Sideboard</option>
                 <option value="maybeboard">Maybeboard</option>
               </select>
             </div>
             <div>
               <label style="display:block;font-size:12px;font-weight:600;color:var(--hub-text-muted);margin-bottom:6px">Quantity</label>
               <input type="number" id="addCardQty" class="hub-input" value="1" min="1" style="width:100%">
             </div>
           </div>

           <div id="addCardPreview" style="margin-top:16px;min-height:20px;font-size:12px;color:var(--hub-text-muted);display:flex;align-items:center;gap:8px">
             <!-- Preview details will go here -->
           </div>
        </div>
        <div class="hub-modal__footer" style="display:flex;justify-content:flex-end;gap:12px;padding:16px 20px;border-top:1px solid var(--hub-border)">
          <button id="addCardCancel" class="hub-btn hub-btn--secondary">Cancel</button>
          <button id="addCardSave" class="hub-btn hub-btn--primary" disabled>Add to Deck</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  const modal = $('#addCardModal');
  const input = $<HTMLInputElement>('#addCardInput');
  const suggestions = $('#addCardSuggestions');
  const saveBtn = $<HTMLButtonElement>('#addCardSave');
  const preview = $('#addCardPreview');

  if (input) setTimeout(() => input.focus(), 50);

  // Close handlers
  const close = () => modal?.remove();
  $('#addCardClose')?.addEventListener('click', close);
  $('#addCardCancel')?.addEventListener('click', close);

  // Autocomplete Logic
  let debounceTimer: number | null = null;
  
  input?.addEventListener('input', () => {
    const query = input.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    
    if (query.length < 2) {
      if (suggestions) suggestions.style.display = 'none';
      return;
    }

    debounceTimer = window.setTimeout(async () => {
      try {
        // We use scryfallApi.autocomplete if available, or just search
        // Assuming scryfallApi has a method, if not we can use resolve logic or custom fetch
        // Let's assume we need to implement a simple fetch here if not exposed, 
        // but wait, we have `scryfallApi` imported. Let's check checks... 
        // We'll trust it implies capability or we simulate it via search
        const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        const names = json.data || [];
        
        if (suggestions && names.length > 0) {
          suggestions.innerHTML = names.map((n: string) => 
            `<div class="suggestion-item" style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--hub-border-dim)">${escapeHtml(n)}</div>`
          ).join('');
          suggestions.style.display = 'block';
          
          suggestions.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
              input.value = item.textContent || '';
              suggestions.style.display = 'none';
              validateAndPreview(input.value);
            });
          });
          
          // Click outside to close
          const outsideClick = (e: Event) => {
            if (!suggestions.contains(e.target as Node) && e.target !== input) {
              suggestions.style.display = 'none';
              document.removeEventListener('click', outsideClick);
            }
          };
          setTimeout(() => document.addEventListener('click', outsideClick), 0);
        } else if (suggestions) {
           suggestions.style.display = 'none';
        }
      } catch (err) {
        console.warn('Autocomplete failed', err);
      }
    }, 300);
  });

  async function validateAndPreview(name: string) {
    if (!preview || !saveBtn) return;
    preview.innerHTML = '<span class="hub-spinner"></span> Validating...';
    saveBtn.disabled = true;
    
    try {
      const result = await scryfallApi.resolve([name]);
      if (result.resolved.length > 0) {
        const card = result.resolved[0].card;
        preview.innerHTML = `
          <span style="color:var(--hub-green)">\u2714 Found:</span> 
          <strong>${escapeHtml(card.name)}</strong> 
          <span style="color:var(--hub-text-muted)">(${card.type_line})</span>
        `;
        saveBtn.disabled = false;
      } else {
         preview.innerHTML = `<span style="color:var(--hub-red)">\u274C Card not found</span>`;
      }
    } catch {
       preview.innerHTML = `<span style="color:var(--hub-red)">\u274C Validation Error</span>`;
    }
  }

  // Save Handler
  saveBtn?.addEventListener('click', async () => {
    const name = input?.value.trim();
    const board = $<HTMLSelectElement>('#addCardBoard')?.value as keyof typeof liveCards;
    const qty = parseInt($<HTMLInputElement>('#addCardQty')?.value || '1', 10);
    
    if (!name || !board || !repoId) return;
    
    saveBtn.textContent = 'Adding...';
    saveBtn.disabled = true;
    
    try {
      // Optimistic update? No, let's just commit
      // We need to fetch current state, modify it, commit it.
      // But we don't have full state object locally easily unless we reconstruct it.
      // Better to use a "patch" operation if API supported it, but our `commitApi.create` takes full state.
      // We'll reconstruct state from `liveCards`.
      
      const newState: DeckState = {
        meta: liveDeckMeta || { name: 'Deck', description: '', format: 'EDH' },
        boards: {
          commander: (liveCards.commander || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags })),
          mainboard: (liveCards.main || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags })),
          sideboard: (liveCards.sideboard || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags })),
          maybeboard: (liveCards.maybeboard || []).map(c => ({ name: c.name, qty: c.qty, tags: c.tags })),
        }
      };

      // Add new card
      const boardKey = (board === 'main' ? 'mainboard' : board) as keyof DeckState['boards'];
      const targetList = newState.boards[boardKey];
      const existing = targetList.find((c: any) => c.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.qty += qty;
      } else {
        targetList.push({ name, qty, tags: [] }); // tags will be auto-enriched on next load
      }
      
      const branchObj = liveBranches.find(b => b.name === currentBranch);
      if (!branchObj) throw new Error('Current branch not found');

      await commitApi.create(repoId, branchObj.id, `Add ${qty}x ${name}`, newState);
      
      showToast(`Added ${name} to ${board}`, 'success');
      close();
      loadRepo(repoId);
    } catch (err) {
      console.error(err);
      showToast('Failed to add card', 'error');
      saveBtn.textContent = 'Add to Deck';
      saveBtn.disabled = false;
    }
  });

  // Enter key support
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
       if (suggestions && suggestions.style.display !== 'none') {
          // If suggestions open, select first? Nah, let user pick.
          // Or if they typed exact name, validate.
          suggestions.style.display = 'none';
          validateAndPreview(input.value);
       } else if (!saveBtn?.disabled) {
          saveBtn?.click();
       } else {
          validateAndPreview(input.value);
       }
    }
  });
}

function openBulkEditModal(): void {
  if (!repoId) return;

  // Generate current deck list text
  const main = (liveCards.main || []).map(c => `${c.qty} ${c.name}`).join('\n');
  const command = (liveCards.commander || []).map(c => `${c.qty} ${c.name} # Commander`).join('\n');
  const side = (liveCards.sideboard || []).map(c => `${c.qty} ${c.name} # Sideboard`).join('\n'); // naive 

  // Better: separate sections
  let content = '';
  if (liveCards.commander?.length) {
    content += `// Commander\n${liveCards.commander.map(c => `${c.qty} ${c.name}`).join('\n')}\n\n`;
  }
  if (liveCards.main?.length) {
    content += `// Mainboard\n${liveCards.main.map(c => `${c.qty} ${c.name}`).join('\n')}\n\n`;
  }
  if (liveCards.sideboard?.length) {
    content += `// Sideboard\n${liveCards.sideboard.map(c => `${c.qty} ${c.name}`).join('\n')}\n\n`;
  }

  const modalHTML = `
    <div id="bulkEditModal" class="hub-modal" aria-hidden="false" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:2000;display:flex;align-items:center;justify-content:center">
      <div class="hub-modal__content" style="background:var(--hub-bg-elevated);border-radius:12px;width:90%;max-width:800px;height:80vh;display:flex;flex-direction:column;border:1px solid var(--hub-border-accent)">
        <div class="hub-modal__header" style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--hub-border)">
          <h3 style="margin:0;font-size:18px;font-weight:600">Bulk Edit Deck</h3>
          <button id="bulkEditClose" class="hub-btn" style="font-size:20px;line-height:1">&times;</button>
        </div>
        <div class="hub-modal__body" style="padding:0;flex:1;display:flex;flex-direction:column">
           <div style="padding:12px;background:var(--hub-bg-deep);font-size:12px;color:var(--hub-text-muted);border-bottom:1px solid var(--hub-border)">
             Supported formats: "1 Sol Ring", "1x Sol Ring", "Sol Ring". Use // for comments/sections.
           </div>
           <textarea id="bulkEditor" style="flex:1;width:100%;resize:none;background:var(--hub-bg);color:var(--hub-text-main);border:none;padding:20px;font-family:var(--hub-mono);font-size:14px;line-height:1.5;outline:none">${content.trim()}</textarea>
        </div>
        <div class="hub-modal__footer" style="display:flex;justify-content:flex-end;gap:12px;padding:16px 20px;border-top:1px solid var(--hub-border)">
          <button id="bulkEditCancel" class="hub-btn hub-btn--secondary">Cancel</button>
          <button id="bulkEditSave" class="hub-btn hub-btn--primary">Save Changes</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHTML);
  document.body.style.overflow = 'hidden';

  $('#bulkEditClose')?.addEventListener('click', closeBulkEdit);
  $('#bulkEditCancel')?.addEventListener('click', closeBulkEdit);
  $('#bulkEditSave')?.addEventListener('click', saveBulkEdit);
}

function closeBulkEdit(): void {
  const modal = $('#bulkEditModal');
  if (modal) {
    modal.remove();
    document.body.style.overflow = '';
  }
}

async function saveBulkEdit(): Promise<void> {
  const editor = $<HTMLTextAreaElement>('#bulkEditor');
  if (!editor || !repoId) return;

  const btn = $('#bulkEditSave') as HTMLButtonElement;
  if(btn) {
    btn.disabled = true;
    btn.textContent = 'Parsing...';
  }

  const text = editor.value;
  const newState: DeckState = {
    meta: liveDeckMeta || { name: 'Deck', description: '', format: 'EDH' },
    boards: {
      commander: [],
      mainboard: [],
      sideboard: [],
      maybeboard: []
    }
  };

  // Parsing logic
  const lines = text.split('\n');
  let currentBoard: keyof DeckState['boards'] = 'mainboard'; // default

  for (const line of lines) {
    const trim = line.trim();
    if (!trim) continue;
    
    // Check for section headers
    if (trim.startsWith('//') || trim.startsWith('#')) {
      const lower = trim.toLowerCase();
      if (lower.includes('commander')) currentBoard = 'commander';
      else if (lower.includes('sideboard')) currentBoard = 'sideboard';
      else if (lower.includes('maybe')) currentBoard = 'maybeboard';
      else if (lower.includes('main')) currentBoard = 'mainboard';
      continue;
    }

    // Parse card: "1x Sol Ring" or "1 Sol Ring" or "Sol Ring"
    const match = trim.match(/^(\d+)[x\s]+(.*)$/);
    let qty = 1;
    let name = trim;
    
    if (match) {
      qty = parseInt(match[1], 10);
      name = match[2].trim();
    }
    
    // Basic validation
    if (name) {
       newState.boards[currentBoard].push({ name, qty, tags: [] }); // Start with empty tags, let enrichment handle it later
    }
  }

  // Save via API
  try {
     if(btn) btn.textContent = 'Saving...';
     
     // We define a generic commit message
     const msg = `Bulk edit via DeckHub`;
     
     // Using commitApi directly to push to currentBranch
     // First, we need the branch ID.
     const branchObj = liveBranches.find(b => b.name === currentBranch);
     if (!branchObj) throw new Error(`Could not find branch ${currentBranch}`);

     await commitApi.create(repoId, branchObj.id, msg, newState);
     
     showToast('Deck updated successfully', 'success');
     closeBulkEdit();
     loadRepo(repoId); // Reload to show changes
  } catch (err) {
    console.error('Bulk Edit Save Error:', err);
    showToast('Failed to save deck', 'error');
    if(btn) {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  }
}

// ───── Visibility Toggle ─────


async function toggleVisibility(repoId: string, currentVisibility: 'public' | 'private'): Promise<void> {
  const newVisibility = currentVisibility === 'public' ? 'private' : 'public';
  
  // Optimistic UI update
  updateVisibilityUI(newVisibility);
  
  try {
    showToast(`Setting visibility to ${newVisibility}...`, 'info');
    await repoApi.update(repoId, { visibility: newVisibility });
    showToast(`Repository is now ${newVisibility}`, 'success');
    
    // Reload repo to update full state logic
    loadRepo(repoId);
  } catch (err) {
    console.error('Failed to toggle visibility:', err);
    showToast('Failed to change visibility', 'error');
    // Revert UI on error
    updateVisibilityUI(currentVisibility);
  }
}

function updateVisibilityUI(visibility: 'public' | 'private'): void {
  const btn = $('#btnToggleVisibility');
  if (!btn || !repoId) return;

  const icon = visibility === 'private' ? '🔒' : '🌐';
  const title = visibility === 'private' ? 'Private (Click to make Public)' : 'Public (Click to make Private)';
  
  // Clone to strip listeners
  const newBtn = btn.cloneNode(true) as HTMLElement;
  newBtn.innerHTML = `${icon} ${visibility}`;
  newBtn.title = title;
  
  // Re-attach listener with NEW visibility (so clicking again toggles back)
  newBtn.addEventListener('click', () => toggleVisibility(repoId!, visibility));
  
  btn.parentNode?.replaceChild(newBtn, btn);
}

// Run on load
function injectDeckHubStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    @media (max-width: 768px) {
      .hub-modal__content {
        width: 95% !important;
        max-width: none !important;
        margin: 16px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
      }
      .hub-modal__body {
        overflow-y: auto;
      }
      .card-table__name {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hub-input-group {
        width: 100%;
      }
      #cardFilterInput {
        max-width: none !important;
        width: 100%;
      }
      .hub-select {
        flex: 1;
      }
    }
  `;
  document.head.appendChild(style);
}

// Run on load
injectDeckHubStyles();
init();
