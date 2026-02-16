// ============================================================
// BisectService — Binary search through deck history
// ============================================================
// Helps find the specific commit that introduced a regression
// (e.g., when a deck became illegal or budget exceeded).
// ============================================================

import { type Commit, type DeckState, generateId } from './types.js';
import { CommitService } from './commit-service.js';
import { ChecksService } from './checks-service.js';

export interface BisectSession {
  id: string;
  repoId: string;
  goodCommitId: string;
  badCommitId: string;
  candidateCommitIds: string[];
  currentStep: number;
  maxSteps: number;
  status: 'active' | 'found' | 'failed';
  resultCommitId?: string;
}

export class BisectService {
  constructor(
    private db: D1Database,
    private commitSvc: CommitService,
    private checksSvc: ChecksService
  ) {}

  /**
   * Start a new bisect session.
   */
  async startBisect(repoId: string, goodCommitId: string, badCommitId: string): Promise<BisectSession> {
    // 1. Get commit history between good and bad
    const history = await this.getHistoryBetween(repoId, goodCommitId, badCommitId);
    
    if (history.length === 0) {
      throw new Error('No commits found between specified points');
    }

    const id = generateId();
    const session: BisectSession = {
      id,
      repoId,
      goodCommitId,
      badCommitId,
      candidateCommitIds: history.map(c => c.id),
      currentStep: 0,
      maxSteps: Math.ceil(Math.log2(history.length)),
      status: 'active'
    };

    // Store session in D1 (simplified)
    await this.db.prepare(`
      INSERT INTO deck_bisect_sessions (id, repo_id, good_commit_id, bad_commit_id, candidates_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).bind(id, repoId, goodCommitId, badCommitId, JSON.stringify(session.candidateCommitIds), new Date().toISOString()).run();

    return session;
  }

  /**
   * Get next commit to test.
   */
  async getNextCandidate(sessionId: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT candidates_json FROM deck_bisect_sessions WHERE id = ?').bind(sessionId).first<{ candidates_json: string }>();
    if (!row) return null;

    const candidates: string[] = JSON.parse(row.candidates_json);
    if (candidates.length === 0) return null;

    // Pick middle
    const mid = Math.floor(candidates.length / 2);
    return candidates[mid];
  }

  /**
   * Mark current candidate as good or bad and narrow down.
   */
  async reportResult(sessionId: string, commitId: string, isGood: boolean): Promise<BisectSession> {
    const row = await this.db.prepare('SELECT * FROM deck_bisect_sessions WHERE id = ?').bind(sessionId).first<any>();
    if (!row) throw new Error('Session not found');

    let candidates: string[] = JSON.parse(row.candidates_json);
    const idx = candidates.indexOf(commitId);
    
    if (idx === -1) throw new Error('Commit not in current candidate list');

    if (isGood) {
      // Everything before and including this commit is good
      candidates = candidates.slice(idx + 1);
    } else {
      // This commit is bad, so anything after it is also bad (or irrelevant)
      // The first bad commit is either this one or something before it.
      candidates = candidates.slice(0, idx);
    }

    let status: BisectSession['status'] = 'active';
    let resultCommitId = undefined;

    if (candidates.length === 0) {
      status = 'found';
      resultCommitId = isGood ? row.bad_commit_id : commitId;
    }

    await this.db.prepare(`
      UPDATE deck_bisect_sessions 
      SET candidates_json = ?, status = ?, result_commit_id = ?
      WHERE id = ?
    `).bind(JSON.stringify(candidates), status, resultCommitId ?? null, sessionId).run();

    return {
      id: sessionId,
      repoId: row.repo_id,
      goodCommitId: row.good_commit_id,
      badCommitId: row.bad_commit_id,
      candidateCommitIds: candidates,
      currentStep: 0, // Needs tracking
      maxSteps: 0,
      status,
      resultCommitId
    };
  }

  private async getHistoryBetween(repoId: string, goodId: string, badId: string): Promise<Commit[]> {
    // Traverse back from bad until good is found
    const history: Commit[] = [];
    let currentId: string | null = badId;

    while (currentId && currentId !== goodId) {
      const commit = await this.commitSvc.getCommit(repoId, currentId);
      if (!commit) break;
      
      // Don't include badId itself in candidates for testing if we already know it's bad?
      // Actually, git bisect includes it. Let's include everything strictly between them.
      if (currentId !== badId) {
        history.push(commit);
      }
      
      currentId = commit.parentId;
    }

    return history.reverse(); // chronological order
  }
}
