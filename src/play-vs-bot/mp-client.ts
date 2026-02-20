/**
 * MultiplayerClient — WebSocket client for the DeckLens multiplayer game session API.
 *
 * Wraps the Cloudflare Durable Object WebSocket protocol and dispatches
 * typed CustomEvents so the UI layer can react declaratively.
 *
 * Events dispatched on this EventTarget:
 *   'lobby-update'      — detail: { seats: SeatInfo[] }
 *   'game-started'      — detail: { yourSeat: number; playerCount: number }
 *   'state-update'      — detail: GameStateView
 *   'action-rejected'   — detail: string (reason)
 *   'game-over'         — detail: { winner: number | null; reason: string }
 *   'connection-error'  — detail: string
 */

export interface SeatInfo {
  seat: number;
  playerName: string | null;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
}

export interface GameStateView {
  activePlayer: number;
  priorityPlayer: number;
  turn: number;
  phase: string;
  step: string;
  players: Array<{
    id: number;
    name: string;
    life: number;
    handSize: number;
    librarySize: number;
    battlefield: unknown[];
    graveyard: unknown[];
    exile: unknown[];
    commandZone: unknown[];
    eliminated?: boolean;
  }>;
  stack: unknown[];
  log: unknown[];
  winner: number | null;
  gameOver: boolean;
  yourHand: unknown[];
  yourLibrarySize: number;
}

const API_BASE = 'https://decklens-api.chrisgarkisch.workers.dev';
const WS_BASE = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');

export class MultiplayerClient extends EventTarget {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private mySeat: number = -1;
  private reconnectDelay: number = 1000;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 15;
  private playerName: string = '';
  private deckJson: string = '';
  private _dead: boolean = false;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId.toUpperCase();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection and send a lobby-join message.
   * Safe to call multiple times — will no-op if already connected.
   */
  connect(playerName: string, deckJson: string): void {
    if (this._dead) return;
    this.playerName = playerName || 'Player';
    this.deckJson = deckJson || '{}';
    this._openSocket();
  }

  /** Submit a game action to the server. */
  submitAction(action: object): void {
    this._send({ type: 'game-action', action });
  }

  /** Mark this player as ready so the game can start. */
  sendReady(): void {
    this._send({ type: 'lobby-ready' });
  }

  /** Request a bot to fill an empty seat. */
  addBot(seat: number): void {
    this._send({ type: 'lobby-add-bot', seat });
  }

  /** Request a full state sync from the server. */
  requestSync(): void {
    this._send({ type: 'game-sync-request' });
  }

  /** Permanently close the connection without reconnecting. */
  disconnect(): void {
    this._dead = true;
    this._stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ─── Getters ────────────────────────────────────────────────────────────────

  get seat(): number { return this.mySeat; }
  get sessionCode(): string { return this.sessionId; }
  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private _openSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = `${WS_BASE}/api/game-sessions/${this.sessionId}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this._dispatchError(`Failed to create WebSocket: ${String(err)}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;

      // Join (or rejoin) the lobby
      this._send({
        type: 'lobby-join',
        playerName: this.playerName,
        deckJson: this.deckJson,
      });

      // Start keepalive pings
      this._startPing();
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      this._handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      this._stopPing();
      if (!this._dead) {
        console.warn(`[MpClient] WS closed (code=${event.code}), reconnecting…`);
        this._scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      this._dispatchError('WebSocket error');
      // close event will fire next and schedule reconnect
    });
  }

  private _handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.warn('[MpClient] Received non-JSON message:', raw);
      return;
    }

    switch (msg.type) {
      case 'lobby-state': {
        const seats = (msg.seats ?? []) as SeatInfo[];
        this.dispatchEvent(new CustomEvent('lobby-update', { detail: { seats } }));
        break;
      }

      case 'game-started': {
        const yourSeat = (msg.yourSeat ?? -1) as number;
        const playerCount = (msg.playerCount ?? 0) as number;
        this.mySeat = yourSeat;
        this.dispatchEvent(new CustomEvent('game-started', { detail: { yourSeat, playerCount } }));
        break;
      }

      case 'game-state': {
        const state = msg.state as GameStateView;
        this.dispatchEvent(new CustomEvent('state-update', { detail: state }));
        break;
      }

      case 'game-action-rejected': {
        const reason = (msg.reason ?? 'Action rejected') as string;
        this.dispatchEvent(new CustomEvent('action-rejected', { detail: reason }));
        break;
      }

      case 'game-over': {
        const winner = (msg.winner ?? null) as number | null;
        const reason = (msg.reason ?? '') as string;
        this.dispatchEvent(new CustomEvent('game-over', { detail: { winner, reason } }));
        break;
      }

      case 'error': {
        const message = (msg.message ?? 'Unknown server error') as string;
        this._dispatchError(message);
        break;
      }

      case 'pong':
        // Keepalive acknowledged — nothing to do
        break;

      default:
        console.warn('[MpClient] Unknown message type:', msg.type);
    }
  }

  private _send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[MpClient] Cannot send — WebSocket not open. Message queued-drop:', msg);
    }
  }

  private _scheduleReconnect(): void {
    if (this._dead) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._dispatchError(`Connection lost after ${this.maxReconnectAttempts} attempts.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1), 30_000);

    console.log(`[MpClient] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})…`);

    setTimeout(() => {
      if (!this._dead) {
        this.ws = null;
        this._openSocket();
      }
    }, delay);
  }

  private _startPing(): void {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      this._send({ type: 'ping' });
    }, 25_000);
  }

  private _stopPing(): void {
    if (this._pingInterval !== null) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  private _dispatchError(detail: string): void {
    console.error('[MpClient] Error:', detail);
    this.dispatchEvent(new CustomEvent('connection-error', { detail }));
  }
}

// ─── Static helper: create a new game session via POST ──────────────────────

/**
 * POST /api/game-sessions to create a new session.
 * Returns the sessionId string.
 */
export async function createGameSession(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/game-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as { sessionId?: string; id?: string };
  const sessionId = body.sessionId ?? body.id;

  if (!sessionId) {
    throw new Error('Server did not return a sessionId');
  }

  return String(sessionId).toUpperCase();
}
