// ============================================================
// DeckLens "GitHub for Decks" — Core Types
// ============================================================
// Shared types for the delta-based commit system, PRs,
// reviews, checks, issues, releases, and permissions.
// ============================================================

// ==================== Board & Patch Types ====================

export type DeckBoard = 'commander' | 'mainboard' | 'sideboard' | 'maybeboard';

/**
 * Deterministic patch operations for deck changes.
 * Every deck edit is expressed as one or more DeckPatchOps.
 * Patches are stored in commits and used for diff/merge.
 */
export type DeckPatchOp =
  | { op: 'add_card'; board: DeckBoard; name: string; qty: number }
  | { op: 'remove_card'; board: DeckBoard; name: string; qty: number }
  | { op: 'update_qty'; board: DeckBoard; name: string; oldQty: number; newQty: number }
  | { op: 'move_card'; fromBoard: DeckBoard; toBoard: DeckBoard; name: string; qty: number }
  | { op: 'set_tag'; board: DeckBoard; name: string; tag: string; value: boolean }
  | { op: 'set_meta'; key: string; value: string }
  | { op: 'set_section'; board: DeckBoard; name: string; sectionId: string };

// ==================== Deck State ====================

export interface DeckCardEntry {
  name: string;
  qty: number;
  set?: string | null;
  collectorNumber?: string | null;
  tags: string[];
  customCategoryId?: string;
}

export interface DeckBoards {
  commander: DeckCardEntry[];
  mainboard: DeckCardEntry[];
  sideboard: DeckCardEntry[];
  maybeboard: DeckCardEntry[];
}

export interface DeckMeta {
  name: string;
  description: string;
  format: string;
}

/**
 * Full state of a deck at any point in time.
 * Can be reconstructed by applying patches from genesis commit.
 */
export interface DeckState {
  boards: DeckBoards;
  meta: DeckMeta;
}

// ==================== Repo ====================

export type RepoVisibility = 'private' | 'unlisted' | 'public';

export interface Repo {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  visibility: RepoVisibility;
  format: string;
  defaultBranch: string;
  upstreamRepoId: string | null;
  forkCount: number;
  starCount: number;
  settingsJson: RepoSettings;
  createdAt: string;
  updatedAt: string;
}

export interface RepoSettings {
  /** Branch names that are protected (require PR to merge) */
  protectedBranches?: string[];
  /** Number of approvals required to merge a PR */
  requiredApprovals?: number;
  /** Check names that must pass before merge */
  requiredChecks?: string[];
  /** Maximum deck budget (in USD) */
  maxBudget?: number;
  /** Tag quotas: { "ramp": 10, "draw": 10, "removal": 5 } */
  tagQuotas?: Record<string, number>;
  /** Playgroup-specific rules (Feature 7) */
  playgroupRules?: PlaygroupRule[];
  /** Locked card slots (Feature F) */
  lockedSlots?: LockedSlot[];
  /** Review checklist template items */
  reviewChecklist?: ReviewTemplateItem[];
  /** Rules requiring specific reviewers based on labels */
  requiredReviewerRules?: RequiredReviewerRule[];
  /** Guarded sections requiring extra approvals */
  guardedSections?: { section: string; requiredApprovals: number }[];
  /** Golden commit ID for drift tracking */
  goldenCommitId?: string | null;
  /** Contribution guidelines (markdown) */
  contributionGuidelines?: string;
  /** PR description template */
  prTemplate?: string;
}

export interface PlaygroupRule {
  id: string;
  name: string;
  type: 'ban' | 'allow' | 'limit' | 'require';
  target: string;         // card name, tag, or category
  value?: number;         // for limit rules
  description?: string;
}

export interface LockedSlot {
  board: DeckBoard;
  cardName: string;
  lockedBy: string;       // user ID who locked it
  reason?: string;
}

// ==================== Branch ====================

export interface Branch {
  id: string;
  repoId: string;
  name: string;
  headCommitId: string | null;
  baseBranchId: string | null;
  isProtected: boolean;
  createdBy: string;
  createdAt: string;
}

// ==================== Commit ====================

export interface Commit {
  id: string;
  repoId: string;
  parentId: string | null;
  parent2Id: string | null;    // second parent for merge commits
  authorId: string;
  authorName: string;
  message: string;
  patch: DeckPatchOp[];
  boardsSnapshot: string | null; // cached full state JSON
  createdAt: string;
}

// ==================== Pull Request ====================

export type PRStatus = 'open' | 'merged' | 'closed';
export type MergeStrategy = 'squash' | 'merge' | 'rebase';

export interface PullRequest {
  id: string;
  repoId: string;
  number: number;
  title: string;
  description: string;
  sourceBranchId: string;
  targetBranchId: string;
  sourceRepoId: string | null;
  authorId: string;
  authorName: string;
  status: PRStatus;
  mergeCommitId: string | null;
  mergeStrategy: MergeStrategy | null;
  labels: string[];
  assignees: string[];
  requiredApprovals: number;
  autoMerge: boolean;
  parentPrId: string | null;
  locked: boolean;
  verified: boolean;
  verifiedBy: string | null;
  isDraft: boolean;
  draftReady: boolean;
  mergeScheduledAt: string | null;
  mergeSchedule: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

// ==================== Review ====================

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';

export interface Review {
  id: string;
  prId: string;
  reviewerId: string;
  reviewerName: string;
  state: ReviewState;
  body: string;
  createdAt: string;
}

// ==================== Comments ====================

export interface PRComment {
  id: string;
  prId: string;
  authorId: string;
  authorName: string;
  body: string;
  /** NULL for general conversation, set for inline comments */
  commitId: string | null;
  /** Path like "mainboard:Lightning Bolt" or "meta:description" */
  path: string | null;
  lineContext: string | null;
  parentCommentId: string | null;
  hidden: boolean;
  reportCount: number;
  createdAt: string;
  updatedAt: string | null;
}

export interface IssueComment {
  id: string;
  issueId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

// ==================== Check Runs ====================

export type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'error';
export type CheckName =
  | 'format_validation'
  | 'regression_test'
  | 'tag_quotas'
  | 'budget'
  | 'sideboard_complete'
  | 'playgroup_rules';

export interface CheckRun {
  id: string;
  prId: string;
  commitId: string;
  checkName: CheckName;
  status: CheckStatus;
  report: CheckReport | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CheckReport {
  summary: string;
  details: CheckDetail[];
  metrics?: Record<string, number>;
}

export interface CheckDetail {
  severity: 'error' | 'warning' | 'info';
  message: string;
  card?: string;
  board?: DeckBoard;
}

export interface CheckResult {
  status: 'pass' | 'fail';
  report: CheckReport;
}

// ==================== Issues ====================

export type IssueStatus = 'open' | 'closed';
export type KanbanColumn = 'backlog' | 'in_progress' | 'done';

export interface Issue {
  id: string;
  repoId: string;
  number: number;
  title: string;
  body: string;
  authorId: string;
  authorName: string;
  status: IssueStatus;
  labels: string[];
  assignees: string[];
  linkedPrId: string | null;
  kanbanColumn: KanbanColumn;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

// ==================== Releases ====================

export type ReleaseChannel = 'stable' | 'experimental' | 'prerelease';

export interface Release {
  id: string;
  repoId: string;
  tagName: string;
  title: string;
  body: string;
  commitId: string;
  authorId: string;
  boardsSnapshot: string;           // frozen deck state JSON
  channel: ReleaseChannel;
  verified: boolean;
  verifiedBy: string | null;
  createdAt: string;
}

// ==================== Permissions ====================

export type RepoRole = 'OWNER' | 'MAINTAINER' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER';

export interface Collaborator {
  repoId: string;
  userId: string;
  role: RepoRole;
  invitedBy: string | null;
  createdAt: string;
}

/** Permission matrix for roles */
export const ROLE_PERMISSIONS: Record<RepoRole, {
  canRead: boolean;
  canComment: boolean;
  canReview: boolean;
  canPush: boolean;
  canMerge: boolean;
  canManageSettings: boolean;
  canManageCollaborators: boolean;
  canDelete: boolean;
}> = {
  VIEWER:      { canRead: true,  canComment: false, canReview: false, canPush: false, canMerge: false, canManageSettings: false, canManageCollaborators: false, canDelete: false },
  REVIEWER:    { canRead: true,  canComment: true,  canReview: true,  canPush: false, canMerge: false, canManageSettings: false, canManageCollaborators: false, canDelete: false },
  CONTRIBUTOR: { canRead: true,  canComment: true,  canReview: true,  canPush: true,  canMerge: false, canManageSettings: false, canManageCollaborators: false, canDelete: false },
  MAINTAINER:  { canRead: true,  canComment: true,  canReview: true,  canPush: true,  canMerge: true,  canManageSettings: true,  canManageCollaborators: true,  canDelete: false },
  OWNER:       { canRead: true,  canComment: true,  canReview: true,  canPush: true,  canMerge: true,  canManageSettings: true,  canManageCollaborators: true,  canDelete: true  },
};

// ==================== Audit Log ====================

export type AuditAction =
  | 'repo.create' | 'repo.update' | 'repo.delete' | 'repo.fork'
  | 'branch.create' | 'branch.delete' | 'branch.rename' | 'branch.protect'
  | 'commit.create' | 'commit.revert' | 'commit.cherry-pick'
  | 'pr.open' | 'pr.update' | 'pr.merge' | 'pr.close' | 'pr.draft' | 'pr.ready' | 'pr.schedule' | 'pr.verify'
  | 'review.add' | 'review.approve' | 'review.request_changes'
  | 'comment.add' | 'comment.hide'
  | 'check.run'
  | 'issue.create' | 'issue.update' | 'issue.close'
  | 'release.create' | 'release.verify'
  | 'settings.update'
  | 'collaborator.add' | 'collaborator.remove' | 'collaborator.update'
  | 'webhook.create' | 'webhook.delete' | 'webhook.trigger'
  | 'template.create' | 'template.use'
  | 'health.snapshot';

export interface AuditEntry {
  id: string;
  repoId: string;
  actorId: string;
  actorName: string;
  action: AuditAction;
  details: Record<string, unknown>;
  createdAt: string;
}

// ==================== Merge Types ====================

export interface MergeResult {
  success: boolean;
  conflicts?: ConflictEntry[];
  mergedState?: DeckState;
  mergeCommit?: Commit;
}

export interface ConflictEntry {
  board: DeckBoard;
  cardName: string;
  sourceChange: DeckPatchOp;
  targetChange: DeckPatchOp;
}

export type ConflictResolutionChoice = 'source' | 'target' | 'both';

export interface ConflictResolution {
  board: DeckBoard;
  cardName: string;
  choice: ConflictResolutionChoice;
  /** Custom qty if choice doesn't directly apply */
  customQty?: number;
}

// ==================== Inventory Types (Feature 8) ====================

export interface InventoryEntry {
  id: string;
  ownerId: string;
  cardName: string;
  qtyOwned: number;
  qtyReserved: number;
  createdAt: string;
}

export interface InventoryReservation {
  id: string;
  inventoryId: string;
  repoId: string;
  branchId: string;
  qty: number;
  createdAt: string;
}

export interface AvailabilityReport {
  available: { cardName: string; owned: number; reserved: number; free: number }[];
  missing: { cardName: string; needed: number; owned: number }[];
}

// ==================== Draft/Sealed Types (Feature 12) ====================

export type DraftFormat = 'draft' | 'sealed';
export type DraftStatus = 'waiting' | 'active' | 'completed';

export interface DraftSession {
  id: string;
  format: DraftFormat;
  hostId: string;
  status: DraftStatus;
  settings: DraftSettings;
  createdAt: string;
  completedAt: string | null;
}

export interface DraftSettings {
  packsPerPlayer: number;
  cardsPerPack: number;
  pickTimerSeconds: number;
  setCode?: string;            // for set-specific drafts
}

export interface DraftParticipant {
  sessionId: string;
  userId: string;
  seatNumber: number;
  pool: string[];              // picked card names
}

// ==================== Template Types (Feature N) ====================

export interface DeckTemplate {
  id: string;
  name: string;
  description: string;
  authorId: string;
  format: string;
  boardsJson: string;
  tags: string[];
  isPublic: boolean;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

// ==================== Combo Lines Types (Feature 2) ====================

export interface ComboLine {
  id: string;
  repoId: string;
  name: string;
  description: string;
  cards: string[];
  steps: ComboStep[];
  tags: string[];              // ["infinite", "wincon", "value"]
  authorId: string;
  createdAt: string;
}

export interface ComboStep {
  order: number;
  action: string;              // "Cast Isochron Scepter imprinting Dramatic Reversal"
  cardName: string;
  result?: string;             // "Generate infinite mana"
}

// ==================== Utility ====================

/** Generate a short random ID (collision-safe for our scale) */
export function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const segments = [8, 4, 4];
  return segments
    .map(len => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(''))
    .join('-');
}

/** ISO timestamp for DB storage */
export function now(): string {
  return new Date().toISOString();
}

// ==================== QOL Feature Types ====================

// ==================== Webhooks ====================
export interface Webhook {
  id: string;
  repoId: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  createdAt: string;
}

// ==================== Activity Feed ====================
export interface ActivityEntry {
  id: string;
  repoId: string;
  actorId: string;
  actionType: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type ActivityActionType =
  | 'repo.create' | 'repo.update' | 'repo.delete' | 'repo.fork'
  | 'branch.create' | 'branch.delete' | 'branch.rename'
  | 'commit.create' | 'commit.revert' | 'commit.cherry-pick'
  | 'pr.open' | 'pr.update' | 'pr.merge' | 'pr.close' | 'pr.review' | 'pr.draft' | 'pr.ready'
  | 'issue.create' | 'issue.update' | 'issue.close'
  | 'release.create'
  | 'review.add' | 'review.approve' | 'review.request_changes'
  | 'comment.add' | 'comment.hide'
  | 'check.run'
  | 'settings.update'
  | 'collaborator.add' | 'collaborator.remove'
  | 'webhook.trigger';

// ==================== User Stats ====================
export interface UserStats {
  userId: string;
  reposCreated: number;
  prsOpened: number;
  prsMerged: number;
  reviewsDone: number;
  commitsCount: number;
  lastActiveAt: string | null;
  updatedAt: string;
}

// ==================== Deck Health ====================
export interface DeckHealthMetrics {
  totalCards: number;
  avgCmc: number;
  curve: Record<number, number>;
  manaBase: {
    colors: string[];
    colorless: number;
    landCount: number;
    avgLandCmc: number;
  };
  cardTypes: {
    creature: number;
    instant: number;
    sorcery: number;
    artifact: number;
    enchantment: number;
    planeswalker: number;
  };
  comboCount: number;
  winConditionCount: number;
  removalCount: number;
  cardDrawCount: number;
  rampCount: number;
}

export interface DeckHealthSnapshot {
  id: string;
  repoId: string;
  branchId: string;
  commitId: string;
  health: DeckHealthMetrics;
  curve: Record<number, number> | null;
  manaBase: Record<string, unknown> | null;
  comboCount: number;
  avgCmc: number | null;
  createdAt: string;
}

// ==================== Scheduled Jobs ====================
export type ScheduledJobType = 'merge' | 'sync' | 'cleanup' | 'webhook';
export type ScheduledJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ScheduledJob {
  id: string;
  jobType: ScheduledJobType;
  targetType: string;
  targetId: string;
  scheduledFor: string;
  executedAt: string | null;
  status: ScheduledJobStatus;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

// ==================== Search ====================
export interface SearchResult {
  repoId: string;
  branchId: string | null;
  cardNames: string[];
  deckName: string;
  deckDescription: string;
  updatedAt: string;
}

// ==================== Branch Comparison ====================
export interface BranchComparison {
  fromBranch: string;
  toBranch: string;
  addedCards: Array<{ board: string; card: string; qty: number }>;
  removedCards: Array<{ board: string; card: string; qty: number }>;
  modifiedCards: Array<{ board: string; card: string; oldQty: number; newQty: number }>;
  totalChanges: number;
  fromCommitId: string;
  toCommitId: string;
}

// ==================== Review Template ====================
export interface ReviewTemplateItem {
  id: string;
  text: string;
  required: boolean;
}

export interface RequiredReviewerRule {
  label: string;
  requiredReviewers: number;
}

// ==================== Watch Rules (8C) ====================
export interface WatchRule {
  id: string;
  userId: string;
  repoId: string;
  events: string[];      // ["pr.open", "pr.merge", "release.create", "check.run"]
  active: boolean;
  createdAt: string;
}

// ==================== Smart Commit Message ====================
export interface SmartCommitSuggestion {
  shortMessage: string;
  longMessage: string;
  suggestedTitle: string;
  tags: string[];
}
