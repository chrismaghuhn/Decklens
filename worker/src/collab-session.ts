/**
 * CollabSession — Cloudflare Durable Object for real-time collaborative deck editing.
 *
 * Each instance manages one shared editing session:
 * - Maintains WebSocket connections for all participants
 * - Stores deck state in Durable Object storage (persists across restarts)
 * - Broadcasts card mutations to all OTHER connected clients
 * - Last-write-wins conflict resolution per card slot
 */

// ───── Cloudflare Runtime Types (Workers + Durable Objects) ─────

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

// ───── Types ─────

export type CollabRole = 'owner' | 'editor' | 'viewer';

export interface CollabParticipant {
  id: string;
  name: string;
  color: string;
  connectedAt: string;
  /** Persistent user ID (if authenticated via GitHub OAuth) */
  userId?: string;
  /** Avatar URL from GitHub */
  avatarUrl?: string;
  /** Role in the collab session */
  role: CollabRole;
}

interface CollabCardEntry {
  name: string;
  qty: number;
  set?: string | null;
  collectorNumber?: string | null;
  tags: string[];
}

type CollabBoard = 'commander' | 'mainboard' | 'sideboard' | 'maybeboard';

interface CollabBoards {
  commander: CollabCardEntry[];
  mainboard: CollabCardEntry[];
  sideboard: CollabCardEntry[];
  maybeboard: CollabCardEntry[];
}

interface CollabDeckState {
  name: string;
  description: string;
  boards: CollabBoards;
}

// Inbound message types (client → server)
type CollabClientMessage =
  | { type: 'join'; name: string; authToken?: string }
  | { type: 'card-add'; board: CollabBoard; entry: CollabCardEntry }
  | { type: 'card-remove'; board: CollabBoard; index: number }
  | { type: 'card-update'; board: CollabBoard; index: number; entry: CollabCardEntry }
  | { type: 'deck-meta'; name: string; description: string }
  | { type: 'sync-request' }
  | { type: 'ping' }
  // ── Collab Tools ──
  | { type: 'cursor-move'; x: number; y: number }
  | { type: 'draw-stroke'; stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number } }
  | { type: 'draw-clear' }
  | { type: 'card-ping'; board: CollabBoard; cardName: string }
  | { type: 'chat-message'; text: string }
  | { type: 'vote-update'; board: CollabBoard; cardName: string; vote: 1 | -1 | 0 }
  | { type: 'auth-identify'; userId: string; username: string; displayName: string; avatarUrl: string | null }
  | { type: 'role-assign'; participantId: string; role: 'editor' | 'viewer' }
  | { type: 'transfer-ownership'; participantId: string }
  // ── Versioning ──
  | { type: 'branch-switch'; branchId: string; branchName: string }
  | { type: 'snapshot-notify'; snapshotId: string; label: string }
  // ── Decision Tools (Phase 2) ──
  | { type: 'proposal-notify'; action: 'created' | 'voted' | 'resolved'; proposalId: string; title?: string }
  | { type: 'thread-notify'; board: string; cardName: string; text: string }
  | { type: 'decision-notify'; cardName?: string; rationale: string }
  | { type: 'task-notify'; action: 'created' | 'updated' | 'deleted'; taskId: string; title?: string }
  // ── Presence & Locking (Phase 3) ──
  | { type: 'presence-update'; board: string; cardName?: string }
  | { type: 'lock-acquire'; board: string; cardName?: string; durationMs?: number }
  | { type: 'lock-release'; lockId: string }
  | { type: 'lock-request'; board: string; cardName: string }
  // ── Team Intelligence (Phase 4) ──
  | { type: 'collection-share'; cardCount: number }
  | { type: 'constraint-notify'; action: 'set' | 'removed'; constraintType: string; constraintValue?: string }
  // ── Collaborative Testing (Phase 5) ──
  | { type: 'goldfish-start'; deckName: string }
  | { type: 'goldfish-action'; action: string; details: string; turn: number }
  | { type: 'goldfish-end'; result: string; turnCount: number }
  | { type: 'goldfish-comment'; text: string; turn: number }
  | { type: 'sideboard-plan-notify'; action: 'created' | 'updated' | 'deleted'; matchup: string }
  | { type: 'test-session-notify'; action: 'logged'; sessionId: string };

// Outbound message types (server → client)
type CollabServerMessage =
  | { type: 'joined'; participant: CollabParticipant; participants: CollabParticipant[] }
  | { type: 'left'; participantId: string; participants: CollabParticipant[] }
  | { type: 'card-add'; board: CollabBoard; entry: CollabCardEntry; by: string }
  | { type: 'card-remove'; board: CollabBoard; index: number; by: string }
  | { type: 'card-update'; board: CollabBoard; index: number; entry: CollabCardEntry; by: string }
  | { type: 'deck-meta'; name: string; description: string; by: string }
  | { type: 'sync-response'; deck: CollabDeckState; participants: CollabParticipant[] }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  // ── Collab Tools ──
  | { type: 'cursor-move'; participantId: string; name: string; color: string; x: number; y: number }
  | { type: 'draw-stroke'; participantId: string; color: string; stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number } }
  | { type: 'draw-clear'; by: string }
  | { type: 'card-ping'; board: CollabBoard; cardName: string; participantId: string; participantName: string; color: string }
  | { type: 'chat-message'; id: string; participantId: string; participantName: string; color: string; text: string; timestamp: number }
  | { type: 'vote-update'; board: CollabBoard; cardName: string; participantId: string; vote: 1 | -1 | 0 }
  | { type: 'vote-sync'; votes: Record<string, Record<string, Record<string, 1 | -1>>> }
  | { type: 'auth-identified'; participantId: string; userId: string; username: string; displayName: string; avatarUrl: string | null }
  | { type: 'role-changed'; participantId: string; newRole: CollabRole; by: string }
  // ── Versioning ──
  | { type: 'branch-changed'; branchId: string; branchName: string; by: string }
  | { type: 'snapshot-created'; snapshotId: string; label: string; by: string }
  | { type: 'activity-logged'; action: string; userName: string; detail: string }
  // ── Decision Tools (Phase 2) ──
  | { type: 'proposal-event'; action: string; proposalId: string; title?: string; by: string }
  | { type: 'thread-event'; board: string; cardName: string; text: string; by: string }
  | { type: 'decision-event'; cardName?: string; rationale: string; by: string }
  | { type: 'task-event'; action: string; taskId: string; title?: string; by: string }
  // ── Presence & Locking (Phase 3) ──
  | { type: 'presence-sync'; presenceMap: Record<string, { board: string; cardName?: string; name: string; color: string }> }
  | { type: 'lock-result'; success: boolean; lock?: SlotLock; reason?: string }
  | { type: 'locks-sync'; locks: SlotLock[] }
  | { type: 'lock-request-received'; board: string; cardName: string; requestedBy: string; requestedByName: string }
  | { type: 'ownership-transferred'; ownerToken: string; previousOwner: string; newOwner: string }
  // ── Team Intelligence (Phase 4) ──
  | { type: 'collection-shared'; participantName: string; cardCount: number }
  | { type: 'constraint-event'; action: string; constraintType: string; constraintValue?: string; by: string }
  // ── Collaborative Testing (Phase 5) ──
  | { type: 'goldfish-started'; by: string; deckName: string }
  | { type: 'goldfish-action-broadcast'; by: string; action: string; details: string; turn: number }
  | { type: 'goldfish-ended'; by: string; result: string; turnCount: number }
  | { type: 'goldfish-comment-broadcast'; by: string; text: string; turn: number }
  | { type: 'sideboard-plan-event'; action: string; matchup: string; by: string }
  | { type: 'test-session-event'; action: string; sessionId: string; by: string };

// ───── Slot Lock Type ─────

export interface SlotLock {
  id: string;
  board: string;
  cardName?: string;
  lockedBy: string;
  lockedByName: string;
  lockedAt: number;
  expiresAt: number;
}

// ───── Constants ─────

const MAX_PARTICIPANTS = 8;
const PARTICIPANT_COLORS = [
  '#c9a84c', // gold
  '#34d399', // emerald
  '#f472b6', // pink
  '#60a5fa', // blue
  '#fb923c', // orange
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#f87171', // red
];
const INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ───── Durable Object ─────

export class CollabSession {
  private state: DurableObjectState;
  private connections: Map<WebSocket, CollabParticipant> = new Map();
  private deck: CollabDeckState = {
    name: 'Untitled Deck',
    description: '',
    boards: { commander: [], mainboard: [], sideboard: [], maybeboard: [] },
  };
  private ownerToken: string | null = null;
  private lastActivity: number = Date.now();
  private initialized = false;
  /** Persisted vote storage: votes[board][cardName][participantId] = 1 | -1 */
  private votes: Record<string, Record<string, Record<string, 1 | -1>>> = {};
  /** Ephemeral presence: which board/card each participant is viewing */
  private presence: Map<string, { board: string; cardName?: string; lastActivity: number }> = new Map();
  /** Ephemeral locks: which cards/boards are locked for editing */
  private locks: Map<string, SlotLock> = new Map();
  /** G3: Timer for auto-promoting an editor to owner after owner disconnect */
  private ownerAutoPromoteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /** Load persisted state on first access */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const stored = await this.state.storage.get<CollabDeckState>('deck');
    if (stored) this.deck = stored;

    const token = await this.state.storage.get<string>('ownerToken');
    if (token) this.ownerToken = token;

    const storedVotes = await this.state.storage.get<Record<string, Record<string, Record<string, 1 | -1>>>>('votes');
    if (storedVotes) this.votes = storedVotes;

    // Schedule cleanup alarm
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }
  }

  /** Persist deck state to Durable Object storage */
  private async persistDeck(): Promise<void> {
    await this.state.storage.put('deck', this.deck);
    this.lastActivity = Date.now();
    // Reset inactivity alarm
    await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
  }

  /** Alarm handler — auto-cleanup after inactivity */
  async alarm(): Promise<void> {
    if (this.connections.size > 0) {
      // Still active, reschedule
      await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
      return;
    }
    // No connections and timed out → clean up
    await this.state.storage.deleteAll();
  }

  /** Main entry point — handles HTTP requests and WebSocket upgrades */
  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    // WebSocket upgrade — check header first (regardless of path) so that
    // the Worker can forward the ORIGINAL request without rewriting the URL.
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    const url = new URL(request.url);

    // POST /init — initialize session with deck data + owner token
    if (url.pathname === '/init' && request.method === 'POST') {
      return this.handleInit(request);
    }

    // GET /info — return session info (no auth needed)
    if (url.pathname === '/info' && request.method === 'GET') {
      return this.handleInfo();
    }

    // GET /snapshot — return current deck state
    if (url.pathname === '/snapshot' && request.method === 'GET') {
      return this.handleSnapshot();
    }

    // POST /close — owner closes the session
    if (url.pathname === '/close' && request.method === 'POST') {
      return this.handleClose(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ───── HTTP Handlers ─────

  private async handleInit(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        deck?: Partial<CollabDeckState>;
        ownerToken?: string;
      };

      if (body.ownerToken) {
        this.ownerToken = body.ownerToken;
        await this.state.storage.put('ownerToken', this.ownerToken);
      }

      if (body.deck) {
        if (typeof body.deck.name === 'string') this.deck.name = body.deck.name.slice(0, 100);
        if (typeof body.deck.description === 'string') this.deck.description = body.deck.description;
        if (body.deck.boards && typeof body.deck.boards === 'object') {
          for (const board of ['commander', 'mainboard', 'sideboard', 'maybeboard'] as const) {
            if (Array.isArray(body.deck.boards[board])) {
              this.deck.boards[board] = body.deck.boards[board]!.map(normalizeCardEntry).filter(Boolean) as CollabCardEntry[];
            }
          }
        }
      }

      await this.persistDeck();
      return jsonResponse({ ok: true });
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid request body' }, 400);
    }
  }

  private handleInfo(): Response {
    const participants = Array.from(this.connections.values());
    return jsonResponse({
      ok: true,
      data: {
        deckName: this.deck.name,
        participantCount: participants.length,
        participants: participants.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      },
    });
  }

  private handleSnapshot(): Response {
    return jsonResponse({
      ok: true,
      data: { deck: this.deck },
    });
  }

  private async handleClose(request: Request): Promise<Response> {
    try {
      const body = await request.json() as { ownerToken?: string };
      if (!this.ownerToken || body.ownerToken !== this.ownerToken) {
        return jsonResponse({ ok: false, error: 'Unauthorized' }, 403);
      }

      // Notify all clients and close WebSocket connections
      const closeMsg = JSON.stringify({ type: 'error', message: 'Session closed by owner' } satisfies CollabServerMessage);
      for (const [ws] of this.connections) {
        try {
          ws.send(closeMsg);
          ws.close(1000, 'Session closed');
        } catch {
          // Ignore already-closed sockets
        }
      }
      this.connections.clear();

      // Clean up storage
      await this.state.storage.deleteAll();
      return jsonResponse({ ok: true });
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
    }
  }

  // ───── WebSocket Handler ─────

  private handleWebSocket(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    if (this.connections.size >= MAX_PARTICIPANTS) {
      return new Response('Session full', { status: 503 });
    }

    const pair = new (WebSocketPair as any)();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;

    // Accept the WebSocket (Cloudflare Durable Object API)
    (server as any).accept();

    // Create a temporary participant entry (will be updated on 'join' message)
    const tempId = generateId();

    server.addEventListener('message', (event: any) => {
      this.handleMessage(server, tempId, event);
    });

    server.addEventListener('close', () => {
      this.handleDisconnect(server);
    });

    server.addEventListener('error', () => {
      this.handleDisconnect(server);
    });

    return new Response(null, { status: 101, webSocket: client } as any);
  }

  // ───── Message Handling ─────

  private async handleMessage(ws: WebSocket, tempId: string, event: MessageEvent): Promise<void> {
    let msg: CollabClientMessage;
    try {
      msg = JSON.parse(String(event.data)) as CollabClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' } satisfies CollabServerMessage));
      return;
    }

    switch (msg.type) {
      case 'join':
        return this.onJoin(ws, tempId, msg.name, msg.authToken);
      case 'card-add':
        return this.onCardAdd(ws, msg.board, msg.entry);
      case 'card-remove':
        return this.onCardRemove(ws, msg.board, msg.index);
      case 'card-update':
        return this.onCardUpdate(ws, msg.board, msg.index, msg.entry);
      case 'deck-meta':
        return this.onDeckMeta(ws, msg.name, msg.description);
      case 'sync-request':
        return this.onSyncRequest(ws);
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' } satisfies CollabServerMessage));
        return;
      // ── Collab Tools ──
      case 'cursor-move':
        return this.onCursorMove(ws, msg.x, msg.y);
      case 'draw-stroke':
        return this.onDrawStroke(ws, msg.stroke, (msg as any).board, (msg as any).branchId);
      case 'draw-clear':
        return this.onDrawClear(ws, (msg as any).board, (msg as any).branchId);
      case 'card-ping':
        return this.onCardPing(ws, msg.board, msg.cardName);
      case 'chat-message':
        return this.onChatMessage(ws, msg.text);
      case 'vote-update':
        return this.onVoteUpdate(ws, msg.board, msg.cardName, msg.vote);
      case 'auth-identify':
        return this.onAuthIdentify(ws, msg.userId, msg.username, msg.displayName, msg.avatarUrl);
      case 'role-assign':
        return this.onRoleAssign(ws, msg.participantId, msg.role);
      case 'transfer-ownership':
        return this.onTransferOwnership(ws, msg.participantId);
      // ── Versioning ──
      case 'branch-switch':
        return this.onBranchSwitch(ws, msg.branchId, msg.branchName);
      case 'snapshot-notify':
        return this.onSnapshotNotify(ws, msg.snapshotId, msg.label);
      // ── Decision Tools (Phase 2) ──
      case 'proposal-notify':
        return this.onProposalNotify(ws, msg.action, msg.proposalId, msg.title);
      case 'thread-notify':
        return this.onThreadNotify(ws, msg.board, msg.cardName, msg.text);
      case 'decision-notify':
        return this.onDecisionNotify(ws, msg.cardName, msg.rationale);
      case 'task-notify':
        return this.onTaskNotify(ws, msg.action, msg.taskId, msg.title);
      // ── Presence & Locking (Phase 3) ──
      case 'presence-update':
        return this.onPresenceUpdate(ws, msg.board, msg.cardName);
      case 'lock-acquire':
        return this.onLockAcquire(ws, msg.board, msg.cardName, msg.durationMs);
      case 'lock-release':
        return this.onLockRelease(ws, msg.lockId);
      case 'lock-request':
        return this.onLockRequest(ws, msg.board, msg.cardName);
      // ── Team Intelligence (Phase 4) ──
      case 'collection-share':
        return this.onCollectionShare(ws, msg.cardCount);
      case 'constraint-notify':
        return this.onConstraintNotify(ws, msg.action, msg.constraintType, msg.constraintValue);
      // ── Collaborative Testing (Phase 5) ──
      case 'goldfish-start':
        return this.onGoldfishStart(ws, msg.deckName);
      case 'goldfish-action':
        return this.onGoldfishAction(ws, msg.action, msg.details, msg.turn);
      case 'goldfish-end':
        return this.onGoldfishEnd(ws, msg.result, msg.turnCount);
      case 'goldfish-comment':
        return this.onGoldfishComment(ws, msg.text, msg.turn);
      case 'sideboard-plan-notify':
        return this.onSideboardPlanNotify(ws, msg.action, msg.matchup);
      case 'test-session-notify':
        return this.onTestSessionNotify(ws, msg.action, msg.sessionId);
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' } satisfies CollabServerMessage));
    }
  }

  private onJoin(ws: WebSocket, tempId: string, displayName: string, _authToken?: string): void {
    const name = (displayName || 'Anonymous').trim().slice(0, 32);
    const colorIndex = this.connections.size % PARTICIPANT_COLORS.length;

    // Determine role: first participant is owner, rest are editors
    const isFirstParticipant = this.connections.size === 0;
    const role: CollabRole = isFirstParticipant ? 'owner' : 'editor';

    const participant: CollabParticipant = {
      id: tempId,
      name,
      color: PARTICIPANT_COLORS[colorIndex],
      connectedAt: new Date().toISOString(),
      role,
    };

    // Note: authToken validation would be done here once D1 is accessible from DOs.
    // For now, the userId/avatarUrl can be passed in a future 'auth-identify' message
    // from the client after connecting, using a validated token from the worker.

    this.connections.set(ws, participant);

    // G3: If a new owner just joined (first participant or auto-promote), cancel auto-promote timer
    if (role === 'owner' && this.ownerAutoPromoteTimer) {
      clearTimeout(this.ownerAutoPromoteTimer);
      this.ownerAutoPromoteTimer = null;
    }

    const participants = Array.from(this.connections.values());

    // Send sync data to the new participant
    ws.send(JSON.stringify({
      type: 'sync-response',
      deck: this.deck,
      participants,
    } satisfies CollabServerMessage));

    // Send persisted vote state to the new participant
    if (Object.keys(this.votes).length > 0) {
      ws.send(JSON.stringify({
        type: 'vote-sync',
        votes: this.votes,
      } satisfies CollabServerMessage));
    }

    // Send current presence + locks state to new participant (Phase 3)
    ws.send(JSON.stringify(this.buildPresenceSyncMessage()));
    if (this.locks.size > 0) {
      this.cleanExpiredLocks();
      ws.send(JSON.stringify({
        type: 'locks-sync',
        locks: Array.from(this.locks.values()),
      } satisfies CollabServerMessage));
    }

    // Broadcast join to all OTHER clients
    this.broadcast(ws, {
      type: 'joined',
      participant,
      participants,
    });
  }

  private async onCardAdd(ws: WebSocket, board: CollabBoard, entry: CollabCardEntry): Promise<void> {
    const normalized = normalizeCardEntry(entry);
    if (!normalized) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid card entry' } satisfies CollabServerMessage));
      return;
    }

    if (!this.deck.boards[board]) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid board' } satisfies CollabServerMessage));
      return;
    }

    this.deck.boards[board].push(normalized);
    await this.persistDeck();

    const participant = this.connections.get(ws);
    this.broadcast(ws, {
      type: 'card-add',
      board,
      entry: normalized,
      by: participant?.id || 'unknown',
    });
  }

  private async onCardRemove(ws: WebSocket, board: CollabBoard, index: number): Promise<void> {
    const boardArr = this.deck.boards[board];
    if (!boardArr || index < 0 || index >= boardArr.length) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid index' } satisfies CollabServerMessage));
      return;
    }

    boardArr.splice(index, 1);
    await this.persistDeck();

    const participant = this.connections.get(ws);
    this.broadcast(ws, {
      type: 'card-remove',
      board,
      index,
      by: participant?.id || 'unknown',
    });
  }

  private async onCardUpdate(ws: WebSocket, board: CollabBoard, index: number, entry: CollabCardEntry): Promise<void> {
    const boardArr = this.deck.boards[board];
    if (!boardArr || index < 0 || index >= boardArr.length) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid index' } satisfies CollabServerMessage));
      return;
    }

    const normalized = normalizeCardEntry(entry);
    if (!normalized) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid card entry' } satisfies CollabServerMessage));
      return;
    }

    boardArr[index] = normalized;
    await this.persistDeck();

    const participant = this.connections.get(ws);
    this.broadcast(ws, {
      type: 'card-update',
      board,
      index,
      entry: normalized,
      by: participant?.id || 'unknown',
    });
  }

  private async onDeckMeta(ws: WebSocket, name: string, description: string): Promise<void> {
    this.deck.name = (name || 'Untitled Deck').trim().slice(0, 100);
    this.deck.description = typeof description === 'string' ? description : '';
    await this.persistDeck();

    const participant = this.connections.get(ws);
    this.broadcast(ws, {
      type: 'deck-meta',
      name: this.deck.name,
      description: this.deck.description,
      by: participant?.id || 'unknown',
    });
  }

  private onSyncRequest(ws: WebSocket): void {
    const participants = Array.from(this.connections.values());
    ws.send(JSON.stringify({
      type: 'sync-response',
      deck: this.deck,
      participants,
    } satisfies CollabServerMessage));

    // Also send presence + locks (Phase 3)
    ws.send(JSON.stringify(this.buildPresenceSyncMessage()));
    this.cleanExpiredLocks();
    if (this.locks.size > 0) {
      ws.send(JSON.stringify({
        type: 'locks-sync',
        locks: Array.from(this.locks.values()),
      } satisfies CollabServerMessage));
    }
  }

  // ───── Collab Tool Handlers ─────

  /** Cursor move — ephemeral, broadcast only (no persist) */
  private onCursorMove(ws: WebSocket, x: number, y: number): void {
    const p = this.connections.get(ws);
    if (!p) return;
    // Clamp coordinates to 0-1 range
    const cx = Math.max(0, Math.min(1, Number(x) || 0));
    const cy = Math.max(0, Math.min(1, Number(y) || 0));
    this.broadcast(ws, {
      type: 'cursor-move',
      participantId: p.id,
      name: p.name,
      color: p.color,
      x: cx,
      y: cy,
    });
  }

  /** Draw stroke — ephemeral, broadcast to all others */
  private onDrawStroke(ws: WebSocket, stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number }, board?: string, branchId?: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    // Validate stroke data
    if (!stroke || typeof stroke.id !== 'string' || !Array.isArray(stroke.points)) return;
    const validTools = ['pen', 'line', 'arrow', 'circle', 'eraser'];
    if (!validTools.includes(stroke.tool)) return;
    // Limit points to 5000 and lineWidth to 20
    const points = stroke.points.slice(0, 5000) as [number, number][];
    const lineWidth = Math.max(1, Math.min(20, Number(stroke.lineWidth) || 2));
    this.broadcast(ws, {
      type: 'draw-stroke',
      participantId: p.id,
      color: p.color,
      stroke: { id: stroke.id, tool: stroke.tool, points, lineWidth },
      board,
      branchId,
    } as any);
  }

  /** Draw clear — ephemeral, broadcast to all others */
  private onDrawClear(ws: WebSocket, board?: string, branchId?: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcast(ws, {
      type: 'draw-clear',
      by: p.id,
      board,
      branchId,
    } as any);
  }

  /** Card ping — ephemeral, broadcast to ALL (including sender) */
  private onCardPing(ws: WebSocket, board: CollabBoard, cardName: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    if (!cardName || typeof cardName !== 'string') return;
    const validBoards: CollabBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];
    if (!validBoards.includes(board)) return;
    // Broadcast to ALL including sender (so sender sees confirmation too)
    this.broadcastAll({
      type: 'card-ping',
      board,
      cardName: cardName.slice(0, 200),
      participantId: p.id,
      participantName: p.name,
      color: p.color,
    });
  }

  /** Chat message — ephemeral, broadcast to ALL */
  private onChatMessage(ws: WebSocket, text: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    if (!text || typeof text !== 'string') return;
    const sanitized = text.trim().slice(0, 2000);
    if (!sanitized) return;
    this.broadcastAll({
      type: 'chat-message',
      id: generateId(),
      participantId: p.id,
      participantName: p.name,
      color: p.color,
      text: sanitized,
      timestamp: Date.now(),
    });
  }

  /** Vote update — persisted, broadcast to ALL */
  private async onVoteUpdate(ws: WebSocket, board: CollabBoard, cardName: string, vote: 1 | -1 | 0): Promise<void> {
    const p = this.connections.get(ws);
    if (!p) return;
    if (!cardName || typeof cardName !== 'string') return;
    const validBoards: CollabBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];
    if (!validBoards.includes(board)) return;
    if (vote !== 1 && vote !== -1 && vote !== 0) return;

    // Update vote storage
    if (!this.votes[board]) this.votes[board] = {};
    if (!this.votes[board][cardName]) this.votes[board][cardName] = {};

    if (vote === 0) {
      delete this.votes[board][cardName][p.id];
      // Clean up empty objects
      if (Object.keys(this.votes[board][cardName]).length === 0) {
        delete this.votes[board][cardName];
      }
      if (Object.keys(this.votes[board]).length === 0) {
        delete this.votes[board];
      }
    } else {
      this.votes[board][cardName][p.id] = vote;
    }

    // Persist votes
    await this.state.storage.put('votes', this.votes);

    // Broadcast to ALL (including sender for confirmation)
    this.broadcastAll({
      type: 'vote-update',
      board,
      cardName,
      participantId: p.id,
      vote,
    });
  }

  // ───── Auth Handlers ─────

  private onAuthIdentify(
    ws: WebSocket,
    userId: string,
    username: string,
    displayName: string,
    avatarUrl: string | null,
  ): void {
    const p = this.connections.get(ws);
    if (!p) return;

    // Update participant with auth info
    p.userId = userId;
    p.avatarUrl = avatarUrl;
    // Use authenticated name
    if (displayName) p.name = displayName.trim().slice(0, 32);

    // Broadcast to all so everyone knows this participant is authenticated
    this.broadcastAll({
      type: 'auth-identified',
      participantId: p.id,
      userId,
      username,
      displayName: p.name,
      avatarUrl,
    });
  }

  private onRoleAssign(ws: WebSocket, targetParticipantId: string, newRole: 'editor' | 'viewer'): void {
    const sender = this.connections.get(ws);
    if (!sender) return;

    // Only owner can assign roles
    if (sender.role !== 'owner') {
      ws.send(JSON.stringify({ type: 'error', message: 'Only the session owner can assign roles' } satisfies CollabServerMessage));
      return;
    }

    // Find target participant
    for (const [, p] of this.connections) {
      if (p.id === targetParticipantId) {
        p.role = newRole;
        this.broadcastAll({
          type: 'role-changed',
          participantId: p.id,
          newRole: p.role,
          by: sender.name,
        });
        return;
      }
    }

    ws.send(JSON.stringify({ type: 'error', message: 'Participant not found' } satisfies CollabServerMessage));
  }

  /** G3: Transfer session ownership to another participant */
  private async onTransferOwnership(ws: WebSocket, targetParticipantId: string): Promise<void> {
    const sender = this.connections.get(ws);
    if (!sender) return;

    // Only the current owner can transfer
    if (sender.role !== 'owner') {
      ws.send(JSON.stringify({ type: 'error', message: 'Only the session owner can transfer ownership' } satisfies CollabServerMessage));
      return;
    }

    // Find target participant
    let target: CollabParticipant | null = null;
    for (const [, p] of this.connections) {
      if (p.id === targetParticipantId) {
        target = p;
        break;
      }
    }

    if (!target) {
      ws.send(JSON.stringify({ type: 'error', message: 'Participant not found' } satisfies CollabServerMessage));
      return;
    }

    // Don't transfer to yourself
    if (target.id === sender.id) return;

    // Viewers can't become owners — promote to editor first
    if (target.role === 'viewer') {
      target.role = 'editor';
    }

    // Transfer: sender → editor, target → owner
    sender.role = 'editor';
    target.role = 'owner';

    // G3: Cancel auto-promote timer since ownership is being explicitly transferred
    if (this.ownerAutoPromoteTimer) {
      clearTimeout(this.ownerAutoPromoteTimer);
      this.ownerAutoPromoteTimer = null;
    }

    // Generate new owner token and persist
    const newToken = generateId();
    this.ownerToken = newToken;
    await this.state.storage.put('ownerToken', newToken);

    // Broadcast both role changes
    this.broadcastAll({
      type: 'role-changed',
      participantId: sender.id,
      newRole: 'editor' as CollabRole,
      by: sender.name,
    });
    this.broadcastAll({
      type: 'role-changed',
      participantId: target.id,
      newRole: 'owner' as CollabRole,
      by: sender.name,
    });

    // Send the new owner token to the target directly
    for (const [targetWs, p] of this.connections) {
      if (p.id === target.id) {
        targetWs.send(JSON.stringify({ type: 'ownership-transferred', ownerToken: newToken, previousOwner: sender.name, newOwner: target.name } satisfies CollabServerMessage));
        break;
      }
    }

    // Log activity
    this.broadcastAll({
      type: 'activity-logged',
      action: 'ownership-transfer',
      userName: sender.name,
      detail: `transferred ownership to ${target.name}`,
    });
  }

  // ───── Versioning Handlers ─────

  /** Branch switch — broadcast to all others */
  private onBranchSwitch(ws: WebSocket, branchId: string, branchName: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcast(ws, {
      type: 'branch-changed',
      branchId,
      branchName,
      by: p.name,
    });
    // Also log as activity
    this.broadcastAll({
      type: 'activity-logged',
      action: 'branch-switch',
      userName: p.name,
      detail: `switched to branch "${branchName}"`,
    });
  }

  /** Snapshot notify — broadcast to all */
  private onSnapshotNotify(ws: WebSocket, snapshotId: string, label: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcastAll({
      type: 'snapshot-created',
      snapshotId,
      label,
      by: p.name,
    });
    this.broadcastAll({
      type: 'activity-logged',
      action: 'snapshot-create',
      userName: p.name,
      detail: `created snapshot "${label}"`,
    });
  }

  // ───── Decision Tools (Phase 2) ─────

  private onProposalNotify(ws: WebSocket, action: string, proposalId: string, title?: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcast(ws, { type: 'proposal-event', action, proposalId, title, by: p.name });
    const actionLabels: Record<string, string> = { created: 'created proposal', voted: 'voted on proposal', resolved: 'resolved proposal' };
    this.broadcastAll({ type: 'activity-logged', action: 'proposal-' + action, userName: p.name, detail: `${actionLabels[action] || action} "${title || proposalId}"` });
  }

  private onThreadNotify(ws: WebSocket, board: string, cardName: string, text: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcast(ws, { type: 'thread-event', board, cardName, text, by: p.name });
    this.broadcastAll({ type: 'activity-logged', action: 'thread-post', userName: p.name, detail: `commented on ${cardName}` });
  }

  private onDecisionNotify(ws: WebSocket, cardName: string | undefined, rationale: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcast(ws, { type: 'decision-event', cardName, rationale, by: p.name });
    this.broadcastAll({ type: 'activity-logged', action: 'decision-add', userName: p.name, detail: `added decision${cardName ? ` for ${cardName}` : ''}: "${rationale.slice(0, 60)}"` });
  }

  private onTaskNotify(ws: WebSocket, action: string, taskId: string, title?: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.broadcast(ws, { type: 'task-event', action, taskId, title, by: p.name });
    const actionLabels: Record<string, string> = { created: 'created task', updated: 'updated task', deleted: 'deleted task' };
    this.broadcastAll({ type: 'activity-logged', action: 'task-' + action, userName: p.name, detail: `${actionLabels[action] || action} "${title || taskId}"` });
  }

  // ───── Presence & Locking (Phase 3) ─────

  /** Update which board/card a participant is viewing */
  private onPresenceUpdate(ws: WebSocket, board: string, cardName?: string): void {
    const p = this.connections.get(ws);
    if (!p) return;
    this.presence.set(p.id, { board, cardName, lastActivity: Date.now() });
    this.cleanExpiredLocks();
    this.broadcastAll(this.buildPresenceSyncMessage());
  }

  /** Acquire a lock on a card or board slot */
  private onLockAcquire(ws: WebSocket, board: string, cardName?: string, durationMs?: number): void {
    const p = this.connections.get(ws);
    if (!p) return;

    // Viewers cannot acquire locks
    if (p.role === 'viewer') {
      ws.send(JSON.stringify({ type: 'lock-result', success: false, reason: 'Viewer role cannot acquire locks' } satisfies CollabServerMessage));
      return;
    }

    this.cleanExpiredLocks();

    const lockKey = `${board}:${cardName || '__board__'}`;
    const existing = this.locks.get(lockKey);

    if (existing && existing.lockedBy !== p.id) {
      // Locked by someone else
      ws.send(JSON.stringify({
        type: 'lock-result',
        success: false,
        reason: `Locked by ${existing.lockedByName}`,
        lock: existing,
      } satisfies CollabServerMessage));
      return;
    }

    // Create or extend lock
    const duration = Math.min(durationMs || DEFAULT_LOCK_DURATION_MS, 30 * 60 * 1000); // max 30 min
    const lock: SlotLock = {
      id: generateId(),
      board,
      cardName,
      lockedBy: p.id,
      lockedByName: p.name,
      lockedAt: Date.now(),
      expiresAt: Date.now() + duration,
    };

    this.locks.set(lockKey, lock);

    // Send result to requester
    ws.send(JSON.stringify({
      type: 'lock-result',
      success: true,
      lock,
    } satisfies CollabServerMessage));

    // Broadcast updated locks to all
    this.broadcastAll({
      type: 'locks-sync',
      locks: Array.from(this.locks.values()),
    });
  }

  /** Release a lock by ID */
  private onLockRelease(ws: WebSocket, lockId: string): void {
    const p = this.connections.get(ws);
    if (!p) return;

    // Find and remove the lock (only if owned by this participant or by owner)
    for (const [key, lock] of this.locks) {
      if (lock.id === lockId) {
        if (lock.lockedBy !== p.id && p.role !== 'owner') {
          ws.send(JSON.stringify({ type: 'error', message: 'Cannot release a lock you do not own' } satisfies CollabServerMessage));
          return;
        }
        this.locks.delete(key);
        this.broadcastAll({
          type: 'locks-sync',
          locks: Array.from(this.locks.values()),
        });
        return;
      }
    }
  }

  /** D2: Handle a lock request — notify the lock holder that someone wants to edit */
  private onLockRequest(ws: WebSocket, board: string, cardName: string): void {
    const requester = this.connections.get(ws);
    if (!requester) return;

    const lockKey = `${board}:${cardName || '__board__'}`;
    const lock = this.locks.get(lockKey);
    if (!lock || lock.expiresAt < Date.now()) {
      // No lock or expired — requester can just acquire it
      ws.send(JSON.stringify({ type: 'lock-result', success: false, reason: 'Lock is no longer held — try editing again.' } satisfies CollabServerMessage));
      return;
    }

    // Don't notify yourself
    if (lock.lockedBy === requester.id) return;

    // Find the lock holder's WebSocket and send them a notification
    for (const [holderWs, participant] of this.connections) {
      if (participant.id === lock.lockedBy) {
        holderWs.send(JSON.stringify({
          type: 'lock-request-received',
          board,
          cardName,
          requestedBy: requester.id,
          requestedByName: requester.name,
        } satisfies CollabServerMessage));
        break;
      }
    }
  }

  /** Remove all expired locks and broadcast if any were removed */
  private cleanExpiredLocks(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, lock] of this.locks) {
      if (lock.expiresAt < now) {
        this.locks.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.broadcastAll({
        type: 'locks-sync',
        locks: Array.from(this.locks.values()),
      });
    }
  }

  /** Build the presence-sync message from current state */
  private buildPresenceSyncMessage(): CollabServerMessage {
    const presenceMap: Record<string, { board: string; cardName?: string; name: string; color: string }> = {};
    for (const [ws, participant] of this.connections) {
      const pres = this.presence.get(participant.id);
      presenceMap[participant.id] = {
        board: pres?.board || 'mainboard',
        cardName: pres?.cardName,
        name: participant.name,
        color: participant.color,
      };
    }
    return { type: 'presence-sync', presenceMap };
  }

  // ───── Team Intelligence (Phase 4) ─────

  private onCollectionShare(ws: WebSocket, cardCount: number): void {
    const participant = this.connections.get(ws);
    if (!participant) return;

    // Broadcast to all participants
    this.broadcastAll({
      type: 'collection-shared',
      participantName: participant.name,
      cardCount,
    } satisfies CollabServerMessage);

    // Log activity
    this.broadcastAll({
      type: 'activity-logged',
      action: 'collection-shared',
      userName: participant.name,
      detail: `shared their collection (${cardCount} cards)`,
    } satisfies CollabServerMessage);
  }

  private onConstraintNotify(ws: WebSocket, action: string, constraintType: string, constraintValue?: string): void {
    const participant = this.connections.get(ws);
    if (!participant) return;

    // Only editors+ can set constraints
    if (participant.role === 'viewer') {
      ws.send(JSON.stringify({ type: 'error', message: 'Editor role required' } satisfies CollabServerMessage));
      return;
    }

    this.broadcastAll({
      type: 'constraint-event',
      action,
      constraintType,
      constraintValue,
      by: participant.name,
    } satisfies CollabServerMessage);

    const verb = action === 'set' ? 'set' : 'removed';
    this.broadcastAll({
      type: 'activity-logged',
      action: 'constraint-changed',
      userName: participant.name,
      detail: `${verb} ${constraintType} constraint${constraintValue ? `: ${constraintValue}` : ''}`,
    } satisfies CollabServerMessage);
  }

  // ───── Collaborative Testing Handlers (Phase 5) ─────

  private onGoldfishStart(ws: WebSocket, deckName: string): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.broadcast(ws, {
      type: 'goldfish-started',
      by: participant.name,
      deckName,
    } satisfies CollabServerMessage);
    this.broadcastAll({
      type: 'activity-logged',
      action: 'goldfish-start',
      userName: participant.name,
      detail: `started goldfish testing "${deckName}"`,
    } satisfies CollabServerMessage);
  }

  private onGoldfishAction(ws: WebSocket, action: string, details: string, turn: number): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.broadcast(ws, {
      type: 'goldfish-action-broadcast',
      by: participant.name,
      action,
      details,
      turn,
    } satisfies CollabServerMessage);
  }

  private onGoldfishEnd(ws: WebSocket, result: string, turnCount: number): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.broadcast(ws, {
      type: 'goldfish-ended',
      by: participant.name,
      result,
      turnCount,
    } satisfies CollabServerMessage);
    this.broadcastAll({
      type: 'activity-logged',
      action: 'goldfish-end',
      userName: participant.name,
      detail: `finished goldfish test: ${result} (turn ${turnCount})`,
    } satisfies CollabServerMessage);
  }

  private onGoldfishComment(ws: WebSocket, text: string, turn: number): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.broadcastAll({
      type: 'goldfish-comment-broadcast',
      by: participant.name,
      text: text.slice(0, 500),
      turn,
    } satisfies CollabServerMessage);
  }

  private onSideboardPlanNotify(ws: WebSocket, action: string, matchup: string): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.broadcast(ws, {
      type: 'sideboard-plan-event',
      action,
      matchup,
      by: participant.name,
    } satisfies CollabServerMessage);
    const actionLabels: Record<string, string> = { created: 'created', updated: 'updated', deleted: 'deleted' };
    this.broadcastAll({
      type: 'activity-logged',
      action: 'sideboard-plan-' + action,
      userName: participant.name,
      detail: `${actionLabels[action] || action} sideboard plan for "${matchup}"`,
    } satisfies CollabServerMessage);
  }

  private onTestSessionNotify(ws: WebSocket, action: string, sessionId: string): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.broadcast(ws, {
      type: 'test-session-event',
      action,
      sessionId,
      by: participant.name,
    } satisfies CollabServerMessage);
    this.broadcastAll({
      type: 'activity-logged',
      action: 'test-session-logged',
      userName: participant.name,
      detail: `logged a test session result`,
    } satisfies CollabServerMessage);
  }

  // ───── Connection Management ─────

  private handleDisconnect(ws: WebSocket): void {
    const participant = this.connections.get(ws);
    if (!participant) return;
    this.connections.delete(ws);

    // Clean up presence (Phase 3)
    this.presence.delete(participant.id);

    // Clean up locks owned by this participant (Phase 3)
    let locksChanged = false;
    for (const [key, lock] of this.locks) {
      if (lock.lockedBy === participant.id) {
        this.locks.delete(key);
        locksChanged = true;
      }
    }

    const participants = Array.from(this.connections.values());
    this.broadcastAll({
      type: 'left',
      participantId: participant.id,
      participants,
    });

    // Broadcast updated presence + locks after disconnect
    this.broadcastAll(this.buildPresenceSyncMessage());
    if (locksChanged) {
      this.broadcastAll({
        type: 'locks-sync',
        locks: Array.from(this.locks.values()),
      });
    }

    // G3: If the owner disconnected, schedule auto-promote after 5 minutes
    if (participant.role === 'owner' && this.connections.size > 0) {
      this.scheduleOwnerAutoPromote();
    }
  }

  /**
   * G3: Schedule auto-promotion of the longest-connected editor to owner.
   * Fires 5 minutes after the owner disconnects. Cancelled if the owner rejoins.
   */
  private scheduleOwnerAutoPromote(): void {
    // Clear any existing timer
    if (this.ownerAutoPromoteTimer) {
      clearTimeout(this.ownerAutoPromoteTimer);
    }

    this.ownerAutoPromoteTimer = setTimeout(async () => {
      this.ownerAutoPromoteTimer = null;

      // Check if an owner has reconnected (or been transferred)
      const hasOwner = Array.from(this.connections.values()).some((p) => p.role === 'owner');
      if (hasOwner || this.connections.size === 0) return;

      // Find the first editor to promote (longest-connected = first in Map iteration)
      let candidate: { ws: WebSocket; participant: CollabParticipant } | null = null;
      for (const [ws, p] of this.connections) {
        if (p.role === 'editor') {
          candidate = { ws, participant: p };
          break;
        }
      }

      // Fall back to any connected participant (even viewers)
      if (!candidate) {
        for (const [ws, p] of this.connections) {
          candidate = { ws, participant: p };
          break;
        }
      }

      if (!candidate) return;

      // Promote to owner
      candidate.participant.role = 'owner' as CollabRole;
      const newToken = generateId() + '-' + generateId();
      this.ownerToken = newToken;
      await this.state.storage.put('ownerToken', newToken);

      // Broadcast the role change
      this.broadcastAll({
        type: 'role-changed',
        participantId: candidate.participant.id,
        newRole: 'owner' as CollabRole,
        by: 'system',
      });

      // Send the owner token to the new owner
      candidate.ws.send(JSON.stringify({
        type: 'ownership-transferred',
        ownerToken: newToken,
        previousOwner: 'system (auto-promote)',
        newOwner: candidate.participant.name,
      } satisfies CollabServerMessage));

      // Log activity
      this.broadcastAll({
        type: 'activity-logged',
        action: 'ownership-auto-promote',
        userName: 'System',
        detail: `auto-promoted ${candidate.participant.name} to owner (previous owner disconnected)`,
      } satisfies CollabServerMessage);
    }, 5 * 60 * 1000); // 5 minutes
  }

  /** Send message to all clients EXCEPT the sender */
  private broadcast(sender: WebSocket, msg: CollabServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.connections) {
      if (ws === sender) continue;
      try {
        ws.send(data);
      } catch {
        // Will be cleaned up on disconnect
      }
    }
  }

  /** Send message to ALL connected clients */
  private broadcastAll(msg: CollabServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of this.connections) {
      try {
        ws.send(data);
      } catch {
        // Will be cleaned up on disconnect
      }
    }
  }
}

// ───── Utilities ─────

function generateId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCardEntry(raw: unknown): CollabCardEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<CollabCardEntry>;
  const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 200) : '';
  if (!name) return null;

  const qtyRaw = Number(entry.qty);
  const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(99, Math.trunc(qtyRaw))) : 1;
  const set = typeof entry.set === 'string' && entry.set.trim() ? entry.set.trim().slice(0, 16) : null;
  const collectorNumber =
    typeof entry.collectorNumber === 'string' && entry.collectorNumber.trim()
      ? entry.collectorNumber.trim().slice(0, 16)
      : null;
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((t): t is string => typeof t === 'string').slice(0, 12) : [];

  return { name, qty, set, collectorNumber, tags };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
