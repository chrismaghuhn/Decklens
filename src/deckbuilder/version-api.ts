// ==================== Version API Client ====================
// Cloud sync for deck branches and snapshots.
// Mirrors patterns from src/shared/api.ts

export interface CloudBranch {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  createdAt: string;
}

export interface CloudSnapshot {
  id: string;
  label: string;
  snapshotType: 'auto' | 'manual';
  cardCount: number;
  createdBy: string | null;
  createdAt: string;
  boardsJson?: string;
}

function getApiBase(): string {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${getApiBase()}${path}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json() as { ok: boolean; data?: T };
    return json.ok && json.data ? json.data : null;
  } catch {
    return null;
  }
}

async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${getApiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const json = await res.json() as { ok: boolean; data?: T };
    return json.ok && json.data ? json.data : null;
  } catch {
    return null;
  }
}

async function apiDelete(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}${path}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Branches ──

export async function fetchBranches(deckId: string): Promise<CloudBranch[]> {
  const data = await apiGet<{ branches: CloudBranch[] }>(`/api/decks/${deckId}/branches`);
  return data?.branches || [];
}

export async function createBranch(
  deckId: string,
  name: string,
  opts?: { description?: string; boardsJson?: string; parentBranchId?: string },
): Promise<CloudBranch | null> {
  return apiPost<CloudBranch>(`/api/decks/${deckId}/branches`, {
    name,
    description: opts?.description || '',
    boardsJson: opts?.boardsJson || '{}',
    parentBranchId: opts?.parentBranchId || null,
  });
}

export async function deleteBranch(deckId: string, branchId: string): Promise<boolean> {
  return apiDelete(`/api/decks/${deckId}/branches/${branchId}`);
}

// ── Snapshots ──

export async function fetchSnapshots(deckId: string, branchId?: string): Promise<CloudSnapshot[]> {
  const params = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
  const data = await apiGet<{ snapshots: CloudSnapshot[] }>(`/api/decks/${deckId}/snapshots${params}`);
  return data?.snapshots || [];
}

export async function createCloudSnapshot(
  deckId: string,
  opts: {
    label?: string;
    boardsJson: string;
    cardCount: number;
    snapshotType?: 'auto' | 'manual';
    branchId?: string;
  },
): Promise<CloudSnapshot | null> {
  return apiPost<CloudSnapshot>(`/api/decks/${deckId}/snapshots`, {
    label: opts.label || '',
    boardsJson: opts.boardsJson,
    cardCount: opts.cardCount,
    snapshotType: opts.snapshotType || 'auto',
    branchId: opts.branchId || null,
  });
}

export async function fetchSnapshotDetail(deckId: string, snapshotId: string): Promise<CloudSnapshot | null> {
  return apiGet<CloudSnapshot>(`/api/decks/${deckId}/snapshots/${snapshotId}`);
}
