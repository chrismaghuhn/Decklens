/**
 * CollabManager — WebSocket client for real-time collaborative deck editing.
 *
 * Connects to a CollabSession Durable Object via WebSocket.
 * Handles reconnection with exponential backoff, heartbeat keepalive,
 * and event-based communication with the editor.
 */

import type {
  CollabConnectionState,
  CollabDeckState,
  CollabParticipant,
  DeckBoard,
  DeckbuilderCardEntry,
  DrawStroke,
} from './types.js';

// ───── Message Types ─────

interface CardAddMessage {
  type: 'card-add';
  board: DeckBoard;
  entry: DeckbuilderCardEntry;
}

interface CardRemoveMessage {
  type: 'card-remove';
  board: DeckBoard;
  index: number;
}

interface CardUpdateMessage {
  type: 'card-update';
  board: DeckBoard;
  index: number;
  entry: DeckbuilderCardEntry;
}

interface DeckMetaMessage {
  type: 'deck-meta';
  name: string;
  description: string;
}

type OutboundMessage =
  | { type: 'join'; name: string }
  | CardAddMessage
  | CardRemoveMessage
  | CardUpdateMessage
  | DeckMetaMessage
  | { type: 'sync-request' }
  | { type: 'ping' }
  // ── Collab Tools ──
  | { type: 'cursor-move'; x: number; y: number }
  | { type: 'draw-stroke'; stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number }; board?: string; branchId?: string }
  | { type: 'draw-clear'; board?: string; branchId?: string }
  | { type: 'card-ping'; board: DeckBoard; cardName: string }
  | { type: 'chat-message'; text: string }
  | { type: 'vote-update'; board: DeckBoard; cardName: string; vote: 1 | -1 | 0 }
  // ── Auth ──
  | { type: 'auth-identify'; userId: string; username: string; displayName: string; avatarUrl: string | null }
  | { type: 'role-assign'; participantId: string; role: 'editor' | 'viewer' }
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
  | { type: 'test-session-notify'; action: 'logged'; sessionId: string }
  // ── Ownership Transfer (G3) ──
  | { type: 'transfer-ownership'; participantId: string };

// Server messages (inbound)
interface SyncResponseMessage {
  type: 'sync-response';
  deck: CollabDeckState;
  participants: CollabParticipant[];
}

interface JoinedMessage {
  type: 'joined';
  participant: CollabParticipant;
  participants: CollabParticipant[];
}

interface LeftMessage {
  type: 'left';
  participantId: string;
  participants: CollabParticipant[];
}

interface RemoteCardAddMessage {
  type: 'card-add';
  board: DeckBoard;
  entry: DeckbuilderCardEntry;
  by: string;
}

interface RemoteCardRemoveMessage {
  type: 'card-remove';
  board: DeckBoard;
  index: number;
  by: string;
}

interface RemoteCardUpdateMessage {
  type: 'card-update';
  board: DeckBoard;
  index: number;
  entry: DeckbuilderCardEntry;
  by: string;
}

interface RemoteDeckMetaMessage {
  type: 'deck-meta';
  name: string;
  description: string;
  by: string;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

// ── Collab Tools inbound messages ──

interface RemoteCursorMoveMessage {
  type: 'cursor-move';
  participantId: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

interface RemoteDrawStrokeMessage {
  type: 'draw-stroke';
  participantId: string;
  color: string;
  stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number };
}

interface RemoteDrawClearMessage {
  type: 'draw-clear';
  by: string;
}

interface RemoteCardPingMessage {
  type: 'card-ping';
  board: DeckBoard;
  cardName: string;
  participantId: string;
  participantName: string;
  color: string;
}

interface RemoteChatMessage {
  type: 'chat-message';
  id: string;
  participantId: string;
  participantName: string;
  color: string;
  text: string;
  timestamp: number;
}

interface RemoteVoteUpdateMessage {
  type: 'vote-update';
  board: DeckBoard;
  cardName: string;
  participantId: string;
  vote: 1 | -1 | 0;
}

interface VoteSyncMessage {
  type: 'vote-sync';
  votes: Record<string, Record<string, Record<string, 1 | -1>>>;
}

interface AuthIdentifiedMessage {
  type: 'auth-identified';
  participantId: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

interface RoleChangedMessage {
  type: 'role-changed';
  participantId: string;
  newRole: 'owner' | 'editor' | 'viewer';
  by: string;
}

type InboundMessage =
  | SyncResponseMessage
  | JoinedMessage
  | LeftMessage
  | RemoteCardAddMessage
  | RemoteCardRemoveMessage
  | RemoteCardUpdateMessage
  | RemoteDeckMetaMessage
  | ErrorMessage
  | { type: 'pong' }
  // ── Collab Tools ──
  | RemoteCursorMoveMessage
  | RemoteDrawStrokeMessage
  | RemoteDrawClearMessage
  | RemoteCardPingMessage
  | RemoteChatMessage
  | RemoteVoteUpdateMessage
  | VoteSyncMessage
  // ── Auth ──
  | AuthIdentifiedMessage
  | RoleChangedMessage
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
  | { type: 'lock-result'; success: boolean; lock?: { id: string; board: string; cardName?: string; lockedBy: string; lockedByName: string; lockedAt: number; expiresAt: number }; reason?: string }
  | { type: 'locks-sync'; locks: Array<{ id: string; board: string; cardName?: string; lockedBy: string; lockedByName: string; lockedAt: number; expiresAt: number }> }
  | { type: 'lock-request-received'; board: string; cardName: string; requestedBy: string; requestedByName: string }
  // ── Team Intelligence (Phase 4) ──
  | { type: 'collection-shared'; participantName: string; cardCount: number }
  | { type: 'constraint-event'; action: string; constraintType: string; constraintValue?: string; by: string }
  // ── Collaborative Testing (Phase 5) ──
  | { type: 'goldfish-started'; by: string; deckName: string }
  | { type: 'goldfish-action-broadcast'; by: string; action: string; details: string; turn: number }
  | { type: 'goldfish-ended'; by: string; result: string; turnCount: number }
  | { type: 'goldfish-comment-broadcast'; by: string; text: string; turn: number }
  | { type: 'sideboard-plan-event'; action: string; matchup: string; by: string }
  | { type: 'test-session-event'; action: string; sessionId: string; by: string }
  // ── Ownership Transfer (G3) ──
  | { type: 'ownership-transferred'; ownerToken: string; previousOwner: string; newOwner: string };

// ───── Event Types ─────

export type CollabEventType =
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'sync'
  | 'participant-joined'
  | 'participant-left'
  | 'remote-card-add'
  | 'remote-card-remove'
  | 'remote-card-update'
  | 'remote-deck-meta'
  | 'error'
  | 'state-change'
  // ── Collab Tools ──
  | 'remote-cursor-move'
  | 'remote-draw-stroke'
  | 'remote-draw-clear'
  | 'remote-card-ping'
  | 'remote-chat-message'
  | 'remote-vote-update'
  | 'vote-sync'
  // ── Auth ──
  | 'auth-identified'
  | 'role-changed'
  | 'remote-branch-switch'
  // ── Versioning (Phase 1) ──
  | 'branch-changed'
  | 'branch-list'
  | 'snapshot-created'
  | 'activity-logged'
  // ── Decision Tools (Phase 2) ──
  | 'proposal-event'
  | 'thread-event'
  | 'decision-event'
  | 'task-event'
  // ── Presence & Locking (Phase 3) ──
  | 'presence-sync'
  | 'lock-result'
  | 'locks-sync'
  | 'lock-request-received'
  // ── Team Intelligence (Phase 4) ──
  | 'collection-shared'
  | 'constraint-event'
  // ── Collaborative Testing (Phase 5) ──
  | 'goldfish-started'
  | 'goldfish-action-broadcast'
  | 'goldfish-ended'
  | 'goldfish-comment-broadcast'
  | 'sideboard-plan-event'
  | 'test-session-event'
  // ── Ownership Transfer (G3) ──
  | 'ownership-transferred';

export interface CollabEvent {
  type: CollabEventType;
  data?: unknown;
}

export type CollabEventHandler = (event: CollabEvent) => void;

// ───── Constants ─────

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 15;
const HEARTBEAT_INTERVAL_MS = 25000;

// ───── CollabManager ─────

export class CollabManager {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private displayName: string = 'Anonymous';
  private wsUrl: string = '';

  private connectionState: CollabConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;

  private participants: CollabParticipant[] = [];
  private listeners: Map<CollabEventType, Set<CollabEventHandler>> = new Map();

  // ─── Public API ───

  get state(): CollabConnectionState {
    return this.connectionState;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get currentParticipants(): CollabParticipant[] {
    return [...this.participants];
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /** D3: Expose the display name for local participant matching */
  get currentDisplayName(): string {
    return this.displayName;
  }

  /** Connect to a collaborative editing session */
  connect(wsUrl: string, sessionId: string, displayName: string): void {
    this.wsUrl = wsUrl;
    this.sessionId = sessionId;
    this.displayName = displayName || 'Anonymous';
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    this.doConnect();
  }

  /** Gracefully disconnect from the session */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.setConnectionState('disconnected');
  }

  /** Send card add event */
  sendCardAdd(board: DeckBoard, entry: DeckbuilderCardEntry): void {
    this.send({ type: 'card-add', board, entry });
  }

  /** Send card remove event */
  sendCardRemove(board: DeckBoard, index: number): void {
    this.send({ type: 'card-remove', board, index });
  }

  /** Send card update event */
  sendCardUpdate(board: DeckBoard, index: number, entry: DeckbuilderCardEntry): void {
    this.send({ type: 'card-update', board, index, entry });
  }

  /** Send deck metadata update */
  sendDeckMeta(name: string, description: string): void {
    this.send({ type: 'deck-meta', name, description });
  }

  /** Request full sync from server */
  requestSync(): void {
    this.send({ type: 'sync-request' });
  }

  // ─── Collab Tools Send Methods ───

  /** Send cursor position (normalised 0–1 coords) */
  sendCursorMove(x: number, y: number): void {
    this.send({ type: 'cursor-move', x, y });
  }

  /** Send a completed draw stroke */
  sendDrawStroke(stroke: { id: string; tool: string; points: [number, number][]; lineWidth: number }, board?: string, branchId?: string): void {
    this.send({ type: 'draw-stroke', stroke, board: board as DeckBoard, branchId });
  }

  /** Send draw clear command */
  sendDrawClear(board?: string, branchId?: string): void {
    this.send({ type: 'draw-clear', board: board as DeckBoard, branchId });
  }

  /** Ping a card to all participants */
  sendCardPing(board: DeckBoard, cardName: string): void {
    this.send({ type: 'card-ping', board, cardName });
  }

  /** Send a chat message */
  sendChatMessage(text: string): void {
    this.send({ type: 'chat-message', text });
  }

  /** Send a vote update for a card */
  sendVoteUpdate(board: DeckBoard, cardName: string, vote: 1 | -1 | 0): void {
    this.send({ type: 'vote-update', board, cardName, vote });
  }

  /** Send auth identity after connecting (if user is logged in) */
  sendAuthIdentify(userId: string, username: string, displayName: string, avatarUrl: string | null): void {
    this.send({ type: 'auth-identify', userId, username, displayName, avatarUrl });
  }

  /** Assign a role to a participant (owner only) */
  sendRoleAssign(participantId: string, role: 'editor' | 'viewer'): void {
    this.send({ type: 'role-assign', participantId, role });
  }

  /** Notify others about a branch switch */
  sendBranchSwitch(branchId: string, branchName: string): void {
    this.send({ type: 'branch-switch', branchId, branchName });
  }

  /** Notify others about a new snapshot */
  sendSnapshotNotify(snapshotId: string, label: string): void {
    this.send({ type: 'snapshot-notify', snapshotId, label });
  }

  // ── Decision Tools (Phase 2) ──

  /** Notify others about a proposal action */
  sendProposalNotify(action: 'created' | 'voted' | 'resolved', proposalId: string, title?: string): void {
    this.send({ type: 'proposal-notify', action, proposalId, title });
  }

  /** Notify others about a new thread comment */
  sendThreadNotify(board: string, cardName: string, text: string): void {
    this.send({ type: 'thread-notify', board, cardName, text });
  }

  /** Notify others about a new decision */
  sendDecisionNotify(cardName: string | undefined, rationale: string): void {
    this.send({ type: 'decision-notify', cardName, rationale });
  }

  /** Notify others about a task action */
  sendTaskNotify(action: 'created' | 'updated' | 'deleted', taskId: string, title?: string): void {
    this.send({ type: 'task-notify', action, taskId, title });
  }

  // ── Presence & Locking (Phase 3) ──

  /** Send presence update (which board/card you're viewing) */
  sendPresenceUpdate(board: string, cardName?: string): void {
    this.send({ type: 'presence-update', board, cardName });
  }

  /** Request a lock on a card or board slot */
  sendLockAcquire(board: string, cardName?: string, durationMs?: number): void {
    this.send({ type: 'lock-acquire', board, cardName, durationMs });
  }

  /** Release a lock by ID */
  sendLockRelease(lockId: string): void {
    this.send({ type: 'lock-release', lockId });
  }

  /** D2: Request a lock from the current holder */
  sendLockRequest(board: string, cardName: string): void {
    this.send({ type: 'lock-request', board, cardName });
  }

  // ── Ownership Transfer (G3) ──

  /** Transfer session ownership to another participant */
  sendTransferOwnership(participantId: string): void {
    this.send({ type: 'transfer-ownership', participantId });
  }

  // ── Team Intelligence (Phase 4) ──

  /** Notify that collection has been shared */
  sendCollectionShare(cardCount: number): void {
    this.send({ type: 'collection-share', cardCount });
  }

  /** Notify about a constraint change */
  sendConstraintNotify(action: 'set' | 'removed', constraintType: string, constraintValue?: string): void {
    this.send({ type: 'constraint-notify', action, constraintType, constraintValue });
  }

  // ── Collaborative Testing (Phase 5) ──

  /** Notify that goldfish playtest started */
  sendGoldfishStart(deckName: string): void {
    this.send({ type: 'goldfish-start', deckName });
  }

  /** Broadcast a goldfish action (play, draw, tap, etc.) */
  sendGoldfishAction(action: string, details: string, turn: number): void {
    this.send({ type: 'goldfish-action', action, details, turn });
  }

  /** Notify that goldfish playtest ended */
  sendGoldfishEnd(result: string, turnCount: number): void {
    this.send({ type: 'goldfish-end', result, turnCount });
  }

  /** Send a spectator comment during goldfish */
  sendGoldfishComment(text: string, turn: number): void {
    this.send({ type: 'goldfish-comment', text, turn });
  }

  /** Notify about a sideboard plan change */
  sendSideboardPlanNotify(action: 'created' | 'updated' | 'deleted', matchup: string): void {
    this.send({ type: 'sideboard-plan-notify', action, matchup });
  }

  /** Notify about a test session being logged */
  sendTestSessionNotify(sessionId: string): void {
    this.send({ type: 'test-session-notify', action: 'logged', sessionId });
  }

  /** Register event listener */
  on(event: CollabEventType, handler: CollabEventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  /** Unregister event listener */
  off(event: CollabEventType, handler: CollabEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  /** Remove all listeners */
  removeAllListeners(): void {
    this.listeners.clear();
  }

  // ─── Internal WebSocket Management ───

  private doConnect(): void {
    this.cleanup();
    this.setConnectionState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    console.log('[CollabManager] doConnect() →', this.wsUrl);

    try {
      this.ws = new WebSocket(this.wsUrl);
      console.log('[CollabManager] WebSocket created, readyState:', this.ws.readyState);

      this.ws.onopen = () => {
        console.log('[CollabManager] ✅ onopen fired');
        this.reconnectAttempts = 0;
        this.setConnectionState('connected');
        this.startHeartbeat();

        // Send join message
        this.send({ type: 'join', name: this.displayName });
        this.emit({ type: 'connected' });
      };

      this.ws.onmessage = (event) => {
        console.log('[CollabManager] onmessage:', typeof event.data === 'string' ? event.data.slice(0, 200) : event.data);
        this.handleMessage(event);
      };

      this.ws.onclose = (event) => {
        console.log('[CollabManager] ❌ onclose → code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
        this.stopHeartbeat();
        if (!this.intentionalClose) {
          this.emit({ type: 'disconnected', data: { code: event.code, reason: event.reason } });
          this.scheduleReconnect();
        } else {
          this.emit({ type: 'disconnected' });
        }
      };

      this.ws.onerror = (event) => {
        console.error('[CollabManager] ⚠️ onerror fired:', event);
      };
    } catch (err) {
      console.error('[CollabManager] WebSocket creation threw:', err);
      this.emit({ type: 'error', data: { message: 'Failed to create WebSocket connection' } });
      this.scheduleReconnect();
    }
  }

  private handleMessage(event: MessageEvent): void {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(String(event.data)) as InboundMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'sync-response':
        this.participants = msg.participants;
        this.emit({
          type: 'sync',
          data: { deck: msg.deck, participants: msg.participants },
        });
        break;

      case 'joined':
        this.participants = msg.participants;
        this.emit({
          type: 'participant-joined',
          data: { participant: msg.participant, participants: msg.participants },
        });
        break;

      case 'left':
        this.participants = msg.participants;
        this.emit({
          type: 'participant-left',
          data: { participantId: msg.participantId, participants: msg.participants },
        });
        break;

      case 'card-add':
        this.emit({
          type: 'remote-card-add',
          data: { board: (msg as RemoteCardAddMessage).board, entry: (msg as RemoteCardAddMessage).entry, by: (msg as RemoteCardAddMessage).by },
        });
        break;

      case 'card-remove':
        this.emit({
          type: 'remote-card-remove',
          data: { board: (msg as RemoteCardRemoveMessage).board, index: (msg as RemoteCardRemoveMessage).index, by: (msg as RemoteCardRemoveMessage).by },
        });
        break;

      case 'card-update':
        this.emit({
          type: 'remote-card-update',
          data: { board: (msg as RemoteCardUpdateMessage).board, index: (msg as RemoteCardUpdateMessage).index, entry: (msg as RemoteCardUpdateMessage).entry, by: (msg as RemoteCardUpdateMessage).by },
        });
        break;

      case 'deck-meta':
        this.emit({
          type: 'remote-deck-meta',
          data: { name: (msg as RemoteDeckMetaMessage).name, description: (msg as RemoteDeckMetaMessage).description, by: (msg as RemoteDeckMetaMessage).by },
        });
        break;

      case 'error':
        this.emit({ type: 'error', data: { message: msg.message } });
        break;

      case 'pong':
        // Heartbeat acknowledged
        break;

      // ── Collab Tools ──
      case 'cursor-move':
        this.emit({
          type: 'remote-cursor-move',
          data: { participantId: (msg as RemoteCursorMoveMessage).participantId, name: (msg as RemoteCursorMoveMessage).name, color: (msg as RemoteCursorMoveMessage).color, x: (msg as RemoteCursorMoveMessage).x, y: (msg as RemoteCursorMoveMessage).y },
        });
        break;

      case 'draw-stroke':
        this.emit({
          type: 'remote-draw-stroke',
          data: { participantId: (msg as RemoteDrawStrokeMessage).participantId, color: (msg as RemoteDrawStrokeMessage).color, stroke: (msg as RemoteDrawStrokeMessage).stroke, board: (msg as any).board, branchId: (msg as any).branchId },
        });
        break;

      case 'draw-clear':
        this.emit({
          type: 'remote-draw-clear',
          data: { by: (msg as RemoteDrawClearMessage).by, board: (msg as any).board, branchId: (msg as any).branchId },
        });
        break;

      case 'card-ping':
        this.emit({
          type: 'remote-card-ping',
          data: { board: (msg as RemoteCardPingMessage).board, cardName: (msg as RemoteCardPingMessage).cardName, participantId: (msg as RemoteCardPingMessage).participantId, participantName: (msg as RemoteCardPingMessage).participantName, color: (msg as RemoteCardPingMessage).color },
        });
        break;

      case 'chat-message':
        this.emit({
          type: 'remote-chat-message',
          data: { id: (msg as RemoteChatMessage).id, participantId: (msg as RemoteChatMessage).participantId, participantName: (msg as RemoteChatMessage).participantName, color: (msg as RemoteChatMessage).color, text: (msg as RemoteChatMessage).text, timestamp: (msg as RemoteChatMessage).timestamp },
        });
        break;

      case 'vote-update':
        this.emit({
          type: 'remote-vote-update',
          data: { board: (msg as RemoteVoteUpdateMessage).board, cardName: (msg as RemoteVoteUpdateMessage).cardName, participantId: (msg as RemoteVoteUpdateMessage).participantId, vote: (msg as RemoteVoteUpdateMessage).vote },
        });
        break;

      case 'vote-sync':
        this.emit({
          type: 'vote-sync',
          data: { votes: (msg as VoteSyncMessage).votes },
        });
        break;

      // ── Auth ──
      case 'auth-identified': {
        const authMsg = msg as AuthIdentifiedMessage;
        // Update participant in local list
        const p = this.participants.find((pp) => pp.id === authMsg.participantId);
        if (p) {
          p.userId = authMsg.userId;
          p.avatarUrl = authMsg.avatarUrl;
          if (authMsg.displayName) p.name = authMsg.displayName;
        }
        this.emit({
          type: 'auth-identified',
          data: { participantId: authMsg.participantId, userId: authMsg.userId, username: authMsg.username, displayName: authMsg.displayName, avatarUrl: authMsg.avatarUrl },
        });
        break;
      }

      case 'role-changed': {
        const roleMsg = msg as RoleChangedMessage;
        const rp = this.participants.find((pp) => pp.id === roleMsg.participantId);
        if (rp) rp.role = roleMsg.newRole;
        this.emit({
          type: 'role-changed',
          data: { participantId: roleMsg.participantId, newRole: roleMsg.newRole, by: roleMsg.by },
        });
        break;
      }

      // ── Versioning ──
      case 'branch-changed':
        this.emit({
          type: 'branch-changed',
          data: { branchId: (msg as { branchId: string }).branchId, branchName: (msg as { branchName: string }).branchName, by: (msg as { by: string }).by },
        });
        break;

      case 'snapshot-created':
        this.emit({
          type: 'snapshot-created',
          data: { snapshotId: (msg as { snapshotId: string }).snapshotId, label: (msg as { label: string }).label, by: (msg as { by: string }).by },
        });
        break;

      case 'activity-logged':
        this.emit({
          type: 'activity-logged',
          data: { action: (msg as { action: string }).action, userName: (msg as { userName: string }).userName, detail: (msg as { detail: string }).detail },
        });
        break;

      // ── Decision Tools (Phase 2) ──
      case 'proposal-event':
        this.emit({ type: 'proposal-event', data: msg });
        break;
      case 'thread-event':
        this.emit({ type: 'thread-event', data: msg });
        break;
      case 'decision-event':
        this.emit({ type: 'decision-event', data: msg });
        break;
      case 'task-event':
        this.emit({ type: 'task-event', data: msg });
        break;

      // ── Presence & Locking (Phase 3) ──
      case 'presence-sync':
        this.emit({ type: 'presence-sync', data: msg });
        break;
      case 'lock-result':
        this.emit({ type: 'lock-result', data: msg });
        break;
      case 'locks-sync':
        this.emit({ type: 'locks-sync', data: msg });
        break;
      case 'lock-request-received':
        this.emit({ type: 'lock-request-received', data: msg });
        break;
      // ── Team Intelligence (Phase 4) ──
      case 'collection-shared':
        this.emit({ type: 'collection-shared', data: msg });
        break;
      case 'constraint-event':
        this.emit({ type: 'constraint-event', data: msg });
        break;
      // ── Collaborative Testing (Phase 5) ──
      case 'goldfish-started':
        this.emit({ type: 'goldfish-started', data: msg });
        break;
      case 'goldfish-action-broadcast':
        this.emit({ type: 'goldfish-action-broadcast', data: msg });
        break;
      case 'goldfish-ended':
        this.emit({ type: 'goldfish-ended', data: msg });
        break;
      case 'goldfish-comment-broadcast':
        this.emit({ type: 'goldfish-comment-broadcast', data: msg });
        break;
      case 'sideboard-plan-event':
        this.emit({ type: 'sideboard-plan-event', data: msg });
        break;
      case 'test-session-event':
        this.emit({ type: 'test-session-event', data: msg });
        break;
      // ── Ownership Transfer (G3) ──
      case 'ownership-transferred':
        this.emit({ type: 'ownership-transferred', data: msg });
        break;
    }
  }

  private send(msg: OutboundMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Will reconnect on close
    }
  }

  // ─── Heartbeat ───

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Reconnection ───

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit({ type: 'error', data: { message: 'Max reconnection attempts reached' } });
      this.setConnectionState('disconnected');
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.setConnectionState('reconnecting');
    this.emit({ type: 'reconnecting', data: { attempt: this.reconnectAttempts, delayMs: delay } });

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  // ─── Cleanup ───

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Client disconnect');
        }
      } catch {
        // Ignore
      }
      this.ws = null;
    }
  }

  // ─── State & Events ───

  private setConnectionState(state: CollabConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.emit({ type: 'state-change', data: { state } });
  }

  private emit(event: CollabEvent): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error('[CollabManager] Event handler error:', err);
        }
      }
    }
  }
}

/** Singleton instance */
let _instance: CollabManager | null = null;

export function getCollabManager(): CollabManager {
  if (!_instance) {
    _instance = new CollabManager();
  }
  return _instance;
}
