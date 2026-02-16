// ============================================================
// Repo API Client — Typed fetch wrappers for deck-git endpoints
// ============================================================
// Frontend API client for all /api/repos/* endpoints.
// Handles auth, error handling, and response parsing.
// ============================================================

// ==================== Types (mirror of worker types) ====================

export interface Repo {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  visibility: string;
  format: string;
  default_branch: string;
  upstream_repo_id: string | null;
  fork_count: number;
  star_count: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface Branch {
  id: string;
  repoId: string;
  name: string;
  headCommitId: string | null;
  isProtected: boolean;
  createdAt: string;
}

export interface Commit {
  id: string;
  repoId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  message: string;
  patch: DeckPatchOp[];
  createdAt: string;
}

export interface PullRequest {
  id: string;
  repoId: string;
  number: number;
  title: string;
  description: string;
  sourceBranchId: string;
  targetBranchId: string;
  authorId: string;
  authorName: string;
  status: 'open' | 'merged' | 'closed';
  labels: string[];
  assignees: string[];
  locked: boolean;
  verified: boolean;
  verifiedBy: string | null;
  parentPrId: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface Review {
  id: string;
  prId: string;
  reviewerId: string;
  reviewerName: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  body: string;
  createdAt: string;
}

export interface PRComment {
  id: string;
  prId: string;
  authorId: string;
  authorName: string;
  body: string;
  path: string | null;
  hidden: boolean;
  reportCount: number;
  createdAt: string;
}

export interface CheckRun {
  id: string;
  checkName: string;
  status: 'pending' | 'running' | 'pass' | 'fail' | 'error';
  report: { summary: string; details: Array<{ severity: string; message: string }> } | null;
}

export interface Issue {
  id: string;
  repoId: string;
  number: number;
  title: string;
  body: string;
  status: 'open' | 'closed';
  labels: string[];
  kanbanColumn: string;
  createdAt: string;
}

export type ReleaseChannel = 'stable' | 'experimental' | 'prerelease';

export interface Release {
  id: string;
  tagName: string;
  title: string;
  body: string;
  commitId: string;
  channel: ReleaseChannel;
  verified: boolean;
  verifiedBy: string | null;
  createdAt: string;
}

export interface PRStackEntry {
  id: string;
  number: number;
  title: string;
  status: string;
  parentPrId: string | null;
}

export interface PRStackResult {
  stack: PRStackEntry[];
  currentIndex: number;
}

export interface AuditEntry {
  id: string;
  actorName: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface DeckPatchOp {
  op: string;
  board?: string;
  name?: string;
  qty?: number;
  [key: string]: unknown;
}

export interface DeckState {
  boards: {
    commander: Array<{ name: string; qty: number; tags: string[] }>;
    mainboard: Array<{ name: string; qty: number; tags: string[] }>;
    sideboard: Array<{ name: string; qty: number; tags: string[] }>;
    maybeboard: Array<{ name: string; qty: number; tags: string[] }>;
  };
  meta: { name: string; description: string; format: string };
}

export interface MergeResult {
  success: boolean;
  conflicts?: Array<{ board: string; cardName: string }>;
  mergeCommit?: Commit;
}

export interface Collaborator {
  userId: string;
  role: string;
  createdAt: string;
}

export interface SuggestedReviewer {
  userId: string;
  authorName: string;
  reason: string;
  score: number;
}

export interface BlameEntry {
  cardName: string;
  board: string;
  introduced: {
    commitId: string;
    authorId: string;
    authorName: string;
    message: string;
    time: string;
  } | null;
  lastChanged: {
    commitId: string;
    authorId: string;
    authorName: string;
    message: string;
    time: string;
  } | null;
  changeCount: number;
}

export interface GoldenDrift {
  goldenCommitId: string | null;
  drift: { added: number; removed: number; totalChanges: number; driftPercent: number } | null;
}

// ==================== API Client ====================

const API_BASE = typeof window !== 'undefined'
  ? (window.location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://decklens-api.chrisgarkisch.workers.dev')
  : '';

/** Get device fingerprint for anonymous auth fallback */
function getFingerprint(): string {
  try {
    let fp = localStorage.getItem('decklens_deckbuilder_device_fp');
    if (!fp) {
      fp = `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('decklens_deckbuilder_device_fp', fp);
    }
    return fp;
  } catch {
    return `fp_${Date.now()}`;
  }
}

function getAuthToken(): string | null {
  try {
    return localStorage.getItem('decklens_auth_token');
  } catch {
    return null;
  }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Fingerprint': getFingerprint(),
  };

  // Include auth token if available (from OAuth login)
  const token = getAuthToken();
  if (token) {
    authHeaders['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...authHeaders,
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((error as { error?: string }).error || `API error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ==================== Repos ====================

export const repoApi = {
  create: (data: { name: string; description?: string; format?: string; visibility?: string }) =>
    apiFetch<{ id: string; defaultBranchId: string }>('/api/repos', { method: 'POST', body: JSON.stringify(data) }),

  get: (id: string) => apiFetch<Repo>(`/api/repos/${id}`),

  update: (id: string, data: Partial<Repo>) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  delete: (id: string) => apiFetch<{ ok: boolean }>(`/api/repos/${id}`, { method: 'DELETE' }),

  fork: (id: string, name?: string) =>
    apiFetch<Repo>(`/api/repos/${id}/fork`, { method: 'POST', body: JSON.stringify({ name }) }),

  listForks: (id: string) => apiFetch<Repo[]>(`/api/repos/${id}/forks`),

  sync: (id: string, branchName: string) =>
    apiFetch<{ success: boolean; message: string }>(`/api/repos/${id}/sync`, { method: 'POST', body: JSON.stringify({ branchName }) }),
};

// ==================== Branches ====================

export const branchApi = {
  list: (repoId: string) => apiFetch<Branch[]>(`/api/repos/${repoId}/branches`),

  create: (repoId: string, name: string, fromBranchId?: string) =>
    apiFetch<Branch>(`/api/repos/${repoId}/branches`, { method: 'POST', body: JSON.stringify({ name, fromBranchId }) }),

  delete: (repoId: string, branchId: string) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/branches/${branchId}`, { method: 'DELETE' }),

  update: (repoId: string, branchId: string, data: { name?: string; isProtected?: boolean }) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/branches/${branchId}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ==================== Commits ====================

export const commitApi = {
  list: (repoId: string, branchId: string, limit = 50, offset = 0) =>
    apiFetch<Commit[]>(`/api/repos/${repoId}/branches/${branchId}/commits?limit=${limit}&offset=${offset}`),

  create: (repoId: string, branchId: string, message: string, state: DeckState) =>
    apiFetch<Commit>(`/api/repos/${repoId}/branches/${branchId}/commits`, {
      method: 'POST', body: JSON.stringify({ message, state }),
    }),

  get: (repoId: string, commitId: string) => apiFetch<Commit>(`/api/repos/${repoId}/commits/${commitId}`),

  getState: (repoId: string, commitId: string) => apiFetch<DeckState>(`/api/repos/${repoId}/commits/${commitId}/state`),

  revert: (repoId: string, commitId: string, branchId: string) =>
    apiFetch<Commit>(`/api/repos/${repoId}/commits/${commitId}/revert`, {
      method: 'POST', body: JSON.stringify({ branchId }),
    }),

  cherryPick: (repoId: string, commitId: string, targetBranchId: string) =>
    apiFetch<{ commit: Commit | null; conflicts: Array<{ board: string; cardName: string; reason: string }> }>(
      `/api/repos/${repoId}/commits/${commitId}/cherry-pick`,
      { method: 'POST', body: JSON.stringify({ targetBranchId }) },
    ),
};

// ==================== Pull Requests ====================

export const prApi = {
  list: (repoId: string, status?: string) =>
    apiFetch<PullRequest[]>(`/api/repos/${repoId}/pulls${status ? `?status=${status}` : ''}`),

  create: (repoId: string, data: { title: string; description?: string; sourceBranchId: string; targetBranchId: string }) =>
    apiFetch<PullRequest>(`/api/repos/${repoId}/pulls`, { method: 'POST', body: JSON.stringify(data) }),

  get: (repoId: string, number: number) => apiFetch<PullRequest>(`/api/repos/${repoId}/pulls/${number}`),

  update: (repoId: string, number: number, data: Partial<PullRequest>) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/pulls/${number}`, { method: 'PATCH', body: JSON.stringify(data) }),

  merge: (repoId: string, number: number, strategy = 'squash') =>
    apiFetch<MergeResult>(`/api/repos/${repoId}/pulls/${number}/merge`, {
      method: 'POST', body: JSON.stringify({ strategy }),
    }),

  close: (repoId: string, number: number) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/pulls/${number}/close`, { method: 'POST' }),

  getDiff: (repoId: string, number: number) => apiFetch<DeckPatchOp[]>(`/api/repos/${repoId}/pulls/${number}/diff`),

  canMerge: (repoId: string, number: number) =>
    apiFetch<{ mergeable: boolean; reasons: string[] }>(`/api/repos/${repoId}/pulls/${number}/mergeable`),

  resolve: (repoId: string, number: number, resolutions: unknown[], message?: string) =>
    apiFetch<Commit>(`/api/repos/${repoId}/pulls/${number}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolutions, message }),
    }),

  autoLabel: (repoId: string, number: number) =>
    apiFetch<{ labels: string[] }>(`/api/repos/${repoId}/pulls/${number}/auto-label`, { method: 'POST' }),

  revert: (repoId: string, number: number) =>
    apiFetch<{ pr: PullRequest }>(`/api/repos/${repoId}/pulls/${number}/revert`, { method: 'POST' }),

  setAutoMerge: (repoId: string, number: number, enabled: boolean) =>
    apiFetch<{ autoMerge: boolean; merged: boolean }>(
      `/api/repos/${repoId}/pulls/${number}/automerge`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),

  suggestedReviewers: (repoId: string, number: number) =>
    apiFetch<SuggestedReviewer[]>(`/api/repos/${repoId}/pulls/${number}/suggested-reviewers`),

  setStack: (repoId: string, number: number, parentPrNumber: number | null) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/pulls/${number}/stack`, {
      method: 'POST', body: JSON.stringify({ parentPrNumber }),
    }),

  getStack: (repoId: string, number: number) =>
    apiFetch<PRStackResult>(`/api/repos/${repoId}/pulls/${number}/stack`),

  verify: (repoId: string, number: number) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/pulls/${number}/verify`, { method: 'POST' }),

  lock: (repoId: string, number: number, locked: boolean) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/pulls/${number}/lock`, {
      method: 'POST', body: JSON.stringify({ locked }),
    }),

  reportComment: (repoId: string, prNumber: number, commentId: string) =>
    apiFetch<{ ok: boolean; reportCount: number; hidden: boolean }>(
      `/api/repos/${repoId}/pulls/${prNumber}/comments/${commentId}/report`, { method: 'POST' }),
};

// ==================== Reviews ====================

export const reviewApi = {
  list: (repoId: string, prNumber: number) => apiFetch<Review[]>(`/api/repos/${repoId}/pulls/${prNumber}/reviews`),

  add: (repoId: string, prNumber: number, state: string, body: string) =>
    apiFetch<Review>(`/api/repos/${repoId}/pulls/${prNumber}/reviews`, {
      method: 'POST', body: JSON.stringify({ state, body }),
    }),
};

// ==================== PR Comments ====================

export const commentApi = {
  list: (repoId: string, prNumber: number) => apiFetch<PRComment[]>(`/api/repos/${repoId}/pulls/${prNumber}/comments`),

  add: (repoId: string, prNumber: number, body: string, inline?: { commitId: string; path: string }) =>
    apiFetch<PRComment>(`/api/repos/${repoId}/pulls/${prNumber}/comments`, {
      method: 'POST', body: JSON.stringify({ body, inline }),
    }),
};

// ==================== Checks ====================

export const checksApi = {
  list: (repoId: string, prNumber: number) => apiFetch<CheckRun[]>(`/api/repos/${repoId}/pulls/${prNumber}/checks`),

  run: (repoId: string, prNumber: number) =>
    apiFetch<CheckRun[]>(`/api/repos/${repoId}/pulls/${prNumber}/checks/run`, { method: 'POST' }),
};

// ==================== Issues ====================

export const issueApi = {
  list: (repoId: string, status?: string) =>
    apiFetch<Issue[]>(`/api/repos/${repoId}/issues${status ? `?status=${status}` : ''}`),

  create: (repoId: string, data: { title: string; body?: string; labels?: string[] }) =>
    apiFetch<Issue>(`/api/repos/${repoId}/issues`, { method: 'POST', body: JSON.stringify(data) }),

  get: (repoId: string, number: number) => apiFetch<Issue>(`/api/repos/${repoId}/issues/${number}`),

  update: (repoId: string, number: number, data: Partial<Issue>) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/issues/${number}`, { method: 'PATCH', body: JSON.stringify(data) }),

  addComment: (repoId: string, issueNumber: number, body: string) =>
    apiFetch<{ id: string }>(`/api/repos/${repoId}/issues/${issueNumber}/comments`, {
      method: 'POST', body: JSON.stringify({ body }),
    }),
};

// ==================== Releases ====================

export const releaseApi = {
  list: (repoId: string, channel?: ReleaseChannel) =>
    apiFetch<Release[]>(`/api/repos/${repoId}/releases${channel ? `?channel=${channel}` : ''}`),

  create: (repoId: string, data: { tagName: string; title: string; body?: string; commitId: string; autoNotes?: boolean; channel?: ReleaseChannel }) =>
    apiFetch<Release>(`/api/repos/${repoId}/releases`, { method: 'POST', body: JSON.stringify(data) }),

  verify: (repoId: string, tagName: string) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/releases/${encodeURIComponent(tagName)}/verify`, { method: 'POST' }),
};

export const guidelinesApi = {
  get: (repoId: string) =>
    apiFetch<{ guidelines: string; prTemplate: string }>(`/api/repos/${repoId}/settings/guidelines`),
};

// ==================== Settings & Collaborators ====================

export const settingsApi = {
  get: (repoId: string) => apiFetch<Record<string, unknown>>(`/api/repos/${repoId}/settings`),

  update: (repoId: string, settings: Record<string, unknown>) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/settings`, { method: 'PATCH', body: JSON.stringify(settings) }),
};

export const collaboratorApi = {
  list: (repoId: string) => apiFetch<Collaborator[]>(`/api/repos/${repoId}/collaborators`),

  add: (repoId: string, userId: string, role: string) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/collaborators`, {
      method: 'POST', body: JSON.stringify({ userId, role }),
    }),

  remove: (repoId: string, userId: string) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/collaborators/${userId}`, { method: 'DELETE' }),
};

// ==================== Audit Log ====================

export const auditApi = {
  list: (repoId: string, limit = 50, offset = 0) =>
    apiFetch<AuditEntry[]>(`/api/repos/${repoId}/audit-log?limit=${limit}&offset=${offset}`),
};

// ==================== Workflows ====================

export const workflowApi = {
  createMetaBranch: (repoId: string, data: { name?: string; format?: string }) =>
    apiFetch<{ branch: Branch; issues: Issue[] }>(`/api/repos/${repoId}/workflows/meta-branch`, {
      method: 'POST', body: JSON.stringify(data),
    }),
};

// ==================== Blame ====================

export const blameApi = {
  getCard: (repoId: string, branchId: string, cardName: string) =>
    apiFetch<BlameEntry>(`/api/repos/${repoId}/branches/${branchId}/blame?card=${encodeURIComponent(cardName)}`),

  getBoard: (repoId: string, branchId: string, board: string) =>
    apiFetch<BlameEntry[]>(`/api/repos/${repoId}/branches/${branchId}/blame?board=${encodeURIComponent(board)}`),
};

// ==================== Golden Deck State ====================

export const goldenApi = {
  get: (repoId: string) => apiFetch<GoldenDrift>(`/api/repos/${repoId}/settings/golden`),

  set: (repoId: string, commitId: string | null) =>
    apiFetch<{ ok: boolean; goldenCommitId: string | null }>(
      `/api/repos/${repoId}/settings/golden`,
      { method: 'POST', body: JSON.stringify({ commitId }) },
    ),
};

// ==================== Webhooks (8B) ====================

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

export const webhookApi = {
  list: (repoId: string) => apiFetch<Webhook[]>(`/api/repos/${repoId}/webhooks`),

  create: (repoId: string, data: { url: string; events: string[]; secret?: string }) =>
    apiFetch<Webhook>(`/api/repos/${repoId}/webhooks`, { method: 'POST', body: JSON.stringify(data) }),

  delete: (repoId: string, webhookId: string) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/webhooks/${webhookId}`, { method: 'DELETE' }),
};

// ==================== Watch Rules (8C) ====================

export interface WatchRule {
  repoId: string;
  events: string[];
  active: boolean;
}

export const watchApi = {
  get: (repoId: string) => apiFetch<WatchRule>(`/api/repos/${repoId}/watch`),

  set: (repoId: string, events: string[]) =>
    apiFetch<WatchRule>(`/api/repos/${repoId}/watch`, { method: 'POST', body: JSON.stringify({ events }) }),
};

// ==================== Auto-Bisect (8A) ====================

export interface BisectSession {
  id: string;
  repoId: string;
  status: 'active' | 'found' | 'failed';
  candidateCommitIds: string[];
  resultCommitId?: string;
}

export const bisectApi = {
  start: (repoId: string, goodCommitId: string, badCommitId: string) =>
    apiFetch<BisectSession>(`/api/repos/${repoId}/bisect/start`, { method: 'POST', body: JSON.stringify({ goodCommitId, badCommitId }) }),

  report: (repoId: string, sessionId: string, commitId: string, isGood: boolean) =>
    apiFetch<BisectSession>(`/api/repos/${repoId}/bisect/${sessionId}/report`, { method: 'POST', body: JSON.stringify({ commitId, isGood }) }),
};

// ==================== Scryfall Proxy ====================

export interface ScryfallSearchCard {
  id: string;
  name: string;
  type_line: string;
  oracle_text?: string;
  mana_cost?: string;
  cmc: number;
  colors: string[];
  rarity: string;
  keywords?: string[];
  produced_mana?: string[];
  prices?: {
    usd?: string | null;
    usd_foil?: string | null;
    eur?: string | null;
    tix?: string | null;
  };
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    art_crop?: string;
  };
}

export const scryfallApi = {
  resolve: (names: string[]) =>
    apiFetch<{ resolved: Array<{ query: string; card: ScryfallSearchCard }>; missing: string[] }>(
      '/api/scryfall/resolve',
      { method: 'POST', body: JSON.stringify({ names }) },
    ),
};
