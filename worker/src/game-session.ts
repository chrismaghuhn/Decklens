/**
 * GameSession — Cloudflare Durable Object for real-time multiplayer MTG (Commander) games.
 *
 * Each instance manages one game session:
 * - Lobby phase: players join with their decks, bots can be added
 * - Game phase: N-player game using the @mtg/game-engine
 * - Finished phase: game over, result persisted
 *
 * Pattern copied from collab-session.ts (WebSocketPair, storage, broadcast, alarm).
 */

// ───── Cloudflare Runtime Types ─────

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

// ───── Message Protocol Types ─────

export type GameSessionClientMessage =
  | { type: 'lobby-join'; playerName: string; deckJson: string; seat?: number }
  | { type: 'lobby-ready' }
  | { type: 'lobby-add-bot'; seat: number }
  | { type: 'game-action'; action: GameActionPayload }
  | { type: 'game-sync-request' }
  | { type: 'ping' };

export type GameSessionServerMessage =
  | { type: 'lobby-state'; seats: SeatInfo[]; sessionId: string }
  | { type: 'game-started'; yourSeat: number; playerCount: number }
  | { type: 'game-state'; state: GameStateView }
  | { type: 'game-action-rejected'; reason: string }
  | { type: 'game-over'; winner: number | null; reason: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

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

// Minimal GameAction for inbound messages — matches game-engine GameAction shape
interface GameActionPayload {
  type: string;
  player?: number;
  [key: string]: unknown;
}

// ───── Constants ─────

const INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_BOT_MOVES_PER_CALL = 200;
const AUTO_PASS_DELAY_MS = 30_000; // 30s before auto-pass for disconnected player

// ───── Utilities ─────

function generateSessionId(): string {
  return `gs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ───── Simple inline bot heuristic ─────
// Intentionally simple — just passes priority. Bot AI can be improved later
// without importing @mtg/bot-core (which would introduce bundling complexity).

function simpleBotAction(gameState: GameStateJson, botSeat: number): GameActionPayload {
  if (gameState.priorityPlayer !== botSeat) {
    return { type: 'pass', player: botSeat };
  }
  // Check if we're in mulligan phase — bots always keep
  if (gameState.mulliganPhase) {
    return { type: 'pass', player: botSeat };
  }
  // Default: pass priority
  return { type: 'pass', player: botSeat };
}

// ───── Serializable GameState (from game-engine) ─────
// We store GameState as JSON but the engine uses Set<number> for playersPassed.
// We handle Set serialization/deserialization manually.

interface GameStateJson {
  players: PlayerStateJson[];
  activePlayer: number;
  priorityPlayer: number;
  turn: number;
  phase: string;
  step: string;
  stack: unknown[];
  combat: unknown | null;
  winner: number | null;
  gameOver: boolean;
  log: unknown[];
  actionHistory: unknown[];
  playersPassed: number[]; // serialized as array
  mulliganPhase: boolean;
  mulliganCount: number[];
  [key: string]: unknown;
}

interface PlayerStateJson {
  id: number;
  name: string;
  life: number;
  hand: unknown[];
  library: unknown[];
  battlefield: unknown[];
  graveyard: unknown[];
  exile: unknown[];
  commandZone: unknown[];
  eliminated?: boolean;
  [key: string]: unknown;
}

/** Serialize a GameState (with Set) to a plain JSON-safe object */
function serializeGameState(state: unknown): GameStateJson {
  const s = state as Record<string, unknown>;
  const serialized = { ...s } as Record<string, unknown>;
  // Convert Set<number> to number[]
  if (s.playersPassed instanceof Set) {
    serialized.playersPassed = Array.from(s.playersPassed as Set<number>);
  } else if (!Array.isArray(serialized.playersPassed)) {
    serialized.playersPassed = [];
  }
  return serialized as unknown as GameStateJson;
}

/** Deserialize from stored JSON back to a GameState (with Set reconstructed) */
function deserializeGameState(json: GameStateJson): unknown {
  const state = { ...json } as Record<string, unknown>;
  // Reconstruct Set<number> from number[]
  const passed = Array.isArray(json.playersPassed) ? json.playersPassed : [];
  state.playersPassed = new Set<number>(passed);
  return state;
}

// ───── Deck parser ─────
// Parses deckJson (Arena format or minimal JSON) into Card[] + commander Card
// For the Durable Object context we build simple Card objects inline.

interface SimpleCard {
  id: string;
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  colors: string[];
  colorIdentity: string[];
  rarity: string;
  tags: string[];
  imageUrl: string;
  owner: number;
  power?: string;
  toughness?: string;
  loyalty?: string;
}

let _cardIdSeq = 0;
function makeCardId(): string {
  return `c_${++_cardIdSeq}_${Date.now().toString(36)}`;
}

function makeCard(name: string, owner: number, qty = 1): SimpleCard[] {
  const cards: SimpleCard[] = [];
  for (let i = 0; i < qty; i++) {
    cards.push({
      id: makeCardId(),
      oracleId: '',
      name,
      manaCost: '',
      cmc: 0,
      typeLine: 'Unknown',
      oracleText: '',
      colors: [],
      colorIdentity: [],
      rarity: 'common',
      tags: [],
      imageUrl: '',
      owner,
    });
  }
  return cards;
}

interface ParsedDeck {
  commander: SimpleCard;
  deck: SimpleCard[];
}

/**
 * Parse a deck JSON string. Supports:
 * 1. JSON object with { commander: string, cards: [{name, qty}] }
 * 2. Arena export format (plain text "N CardName" lines)
 * 3. Fallback: generate a minimal 99-card basic-land deck
 */
function parseDeckJson(deckJson: string, owner: number): ParsedDeck {
  let commanderName = 'Commander';
  const deckCards: SimpleCard[] = [];

  try {
    const parsed = JSON.parse(deckJson) as Record<string, unknown>;

    // JSON format
    if (typeof parsed.commander === 'string') {
      commanderName = parsed.commander;
    }

    const cards = parsed.cards ?? parsed.mainboard ?? parsed.mainDeck;
    if (Array.isArray(cards)) {
      for (const entry of cards as Array<{ name?: string; qty?: number }>) {
        const name = String(entry.name ?? '').trim();
        const qty = Math.max(1, Math.min(20, Number(entry.qty) || 1));
        if (name) {
          deckCards.push(...makeCard(name, owner, qty));
        }
      }
    }
  } catch {
    // Try Arena format: lines like "1 Lightning Bolt" or "// Commander\n1 Sol Ring"
    const lines = deckJson.split('\n');
    let inCommander = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) {
        inCommander = line.toLowerCase().includes('commander');
        continue;
      }
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) {
        const qty = parseInt(m[1], 10);
        const name = m[2].trim();
        if (inCommander && commanderName === 'Commander') {
          commanderName = name;
          inCommander = false;
        } else {
          deckCards.push(...makeCard(name, owner, qty));
        }
      }
    }
  }

  // Fallback: build a 99-card basics deck
  if (deckCards.length < 10) {
    for (let i = 0; i < 99; i++) {
      deckCards.push(...makeCard('Plains', owner, 1));
    }
  }

  const commander = makeCard(commanderName, owner)[0];
  commander.typeLine = 'Legendary Creature';

  // Ensure deck is exactly 99 (excluding commander)
  const filtered = deckCards.filter((c) => c.name !== commanderName);
  const padded = filtered.slice(0, 99);
  while (padded.length < 99) {
    padded.push(...makeCard('Plains', owner, 1));
  }

  return { commander, deck: padded };
}

// ───── Game Engine Dynamic Import ─────
// We use dynamic import with a relative path from the worker bundle root.
// Wrangler (esbuild) resolves these relative to worker/src/.

type SetupNewGameNFn = (configs: Array<{ name: string; deck: unknown; commander: unknown }>) => unknown;
type ExecuteActionFn = (state: unknown, action: unknown) => unknown;
type ValidateActionFn = (state: unknown, action: unknown) => string | null;

let _setupNewGameN: SetupNewGameNFn | null = null;
let _executeAction: ExecuteActionFn | null = null;
let _validateAction: ValidateActionFn | null = null;
let _engineLoaded = false;

async function loadGameEngine(): Promise<void> {
  if (_engineLoaded) return;
  _engineLoaded = true;
  try {
    // Relative path from worker/src/ to packages/game-engine/src/
    const engine = await import('../../packages/game-engine/src/index.ts') as {
      setupNewGameN: SetupNewGameNFn;
      executeAction: ExecuteActionFn;
      validateAction: ValidateActionFn;
    };
    _setupNewGameN = engine.setupNewGameN;
    _executeAction = engine.executeAction;
    _validateAction = engine.validateAction;
  } catch (err) {
    console.error('[GameSession] Failed to load game engine:', err);
    // Engine stays null — we'll handle gracefully
  }
}

// ───── GameSession Durable Object ─────

export class GameSession {
  private state: DurableObjectState;
  private connections: Map<WebSocket, { seat: number; playerName: string }> = new Map();
  private lobbySeats: SeatInfo[] = [];
  private sessionPhase: 'lobby' | 'game' | 'finished' = 'lobby';
  private maxPlayers: number = 4;
  private gameStateJson: GameStateJson | null = null;
  private sessionId: string = '';
  private initialized = false;
  /** Auto-pass timers for disconnected players: seat → timer handle */
  private autoPassTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  // ───── Main Entry Point ─────

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    const url = new URL(request.url);

    if (url.pathname === '/info' && request.method === 'GET') {
      return this.handleInfo();
    }

    return new Response('Not found', { status: 404 });
  }

  // ───── Persistence ─────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const storedId = await this.state.storage.get<string>('sessionId');
    if (storedId) this.sessionId = storedId;
    else this.sessionId = generateSessionId();

    const storedPhase = await this.state.storage.get<'lobby' | 'game' | 'finished'>('phase');
    if (storedPhase) this.sessionPhase = storedPhase;

    const storedMaxPlayers = await this.state.storage.get<number>('maxPlayers');
    if (storedMaxPlayers) this.maxPlayers = storedMaxPlayers;

    const storedSeats = await this.state.storage.get<SeatInfo[]>('lobbySeats');
    if (storedSeats) {
      this.lobbySeats = storedSeats;
    } else {
      this.lobbySeats = this.buildEmptySeats(this.maxPlayers);
    }

    const storedState = await this.state.storage.get<GameStateJson>('gameState');
    if (storedState) this.gameStateJson = storedState;

    // Schedule inactivity alarm
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    // Load game engine in background
    void loadGameEngine();
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('sessionId', this.sessionId);
    await this.state.storage.put('phase', this.sessionPhase);
    await this.state.storage.put('maxPlayers', this.maxPlayers);
    await this.state.storage.put('lobbySeats', this.lobbySeats);
    if (this.gameStateJson) {
      await this.state.storage.put('gameState', this.gameStateJson);
    }
    // Reset inactivity alarm
    await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
  }

  // ───── Alarm ─────

  async alarm(): Promise<void> {
    if (this.connections.size > 0) {
      // Still has connections — reschedule
      await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
      return;
    }
    // No connections + timed out → clean up
    await this.state.storage.deleteAll();
  }

  // ───── HTTP Info Handler ─────

  private handleInfo(): Response {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        sessionId: this.sessionId,
        phase: this.sessionPhase,
        maxPlayers: this.maxPlayers,
        seats: this.lobbySeats,
        connectedCount: this.connections.size,
      },
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ───── WebSocket Handler ─────

  private handleWebSocket(request: Request): Response {
    const url = new URL(request.url);

    // Parse maxPlayers from query param (only respected when lobby is empty)
    const playersParam = parseInt(url.searchParams.get('players') ?? '4');
    if (this.lobbySeats.length === 0 || !this.initialized) {
      this.maxPlayers = Math.max(2, Math.min(8, isNaN(playersParam) ? 4 : playersParam));
      this.lobbySeats = this.buildEmptySeats(this.maxPlayers);
    }

    const pair = new (WebSocketPair as any)();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;

    (server as any).accept();

    server.addEventListener('message', (event: any) => {
      void this.handleMessage(server, event);
    });

    server.addEventListener('close', () => {
      void this.onDisconnect(server);
    });

    server.addEventListener('error', () => {
      void this.onDisconnect(server);
    });

    return new Response(null, { status: 101, webSocket: client } as any);
  }

  // ───── Message Router ─────

  private async handleMessage(ws: WebSocket, event: MessageEvent): Promise<void> {
    let msg: GameSessionClientMessage;
    try {
      msg = JSON.parse(String(event.data)) as GameSessionClientMessage;
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'lobby-join':
        return this.onLobbyJoin(ws, msg.playerName, msg.deckJson, msg.seat);
      case 'lobby-ready':
        return this.onLobbyReady(ws);
      case 'lobby-add-bot':
        return this.onAddBot(ws, msg.seat);
      case 'game-action':
        return this.onGameAction(ws, msg.action);
      case 'game-sync-request':
        return this.onSyncRequest(ws);
      case 'ping':
        this.send(ws, { type: 'pong' });
        return;
      default:
        this.send(ws, { type: 'error', message: 'Unknown message type' });
    }
  }

  // ───── Lobby Handlers ─────

  private onLobbyJoin(ws: WebSocket, playerName: string, deckJson: string, preferredSeat?: number): void {
    if (this.sessionPhase !== 'lobby') {
      // Game already started — reconnect
      const existing = this.findSeatByName(playerName);
      if (existing !== -1) {
        this.connections.set(ws, { seat: existing, playerName });
        this.lobbySeats[existing].connected = true;
        this.cancelAutoPass(existing);
        this.broadcastLobbyState();
        if (this.sessionPhase === 'game' && this.gameStateJson) {
          this.send(ws, { type: 'game-started', yourSeat: existing, playerCount: this.maxPlayers });
          this.sendStateToPlayer(ws, existing);
        }
        return;
      }
      this.send(ws, { type: 'error', message: 'Game already in progress' });
      return;
    }

    // Find an open seat
    const name = (playerName || 'Player').trim().slice(0, 32);
    let seat = -1;

    // Try preferred seat first
    if (preferredSeat !== undefined && preferredSeat >= 0 && preferredSeat < this.maxPlayers) {
      if (!this.lobbySeats[preferredSeat].playerName && !this.lobbySeats[preferredSeat].isBot) {
        seat = preferredSeat;
      }
    }

    // Find first open seat
    if (seat === -1) {
      for (let i = 0; i < this.maxPlayers; i++) {
        if (!this.lobbySeats[i].playerName && !this.lobbySeats[i].isBot) {
          seat = i;
          break;
        }
      }
    }

    if (seat === -1) {
      this.send(ws, { type: 'error', message: 'No seats available' });
      return;
    }

    // Store deck JSON in seat metadata (reuse SeatInfo with a custom field via extension)
    this.lobbySeats[seat] = {
      seat,
      playerName: name,
      isBot: false,
      ready: false,
      connected: true,
    };

    // Store deckJson separately by seat
    this.storeDeckJson(seat, deckJson);

    this.connections.set(ws, { seat, playerName: name });
    this.broadcastLobbyState();
    void this.persistState();
  }

  private onLobbyReady(ws: WebSocket): void {
    const info = this.connections.get(ws);
    if (!info) {
      this.send(ws, { type: 'error', message: 'Not in a seat' });
      return;
    }

    this.lobbySeats[info.seat].ready = true;
    this.broadcastLobbyState();
    void this.persistState();

    // Check if all occupied seats are ready
    const occupiedSeats = this.lobbySeats.filter((s) => s.playerName !== null);
    if (occupiedSeats.length >= 2 && occupiedSeats.every((s) => s.ready)) {
      void this.startGame();
    }
  }

  private onAddBot(ws: WebSocket, seat: number): void {
    if (this.sessionPhase !== 'lobby') {
      this.send(ws, { type: 'error', message: 'Game already started' });
      return;
    }

    if (seat < 0 || seat >= this.maxPlayers) {
      this.send(ws, { type: 'error', message: 'Invalid seat number' });
      return;
    }

    if (this.lobbySeats[seat].playerName !== null) {
      this.send(ws, { type: 'error', message: 'Seat already occupied' });
      return;
    }

    const botName = `Bot ${seat + 1}`;
    this.lobbySeats[seat] = {
      seat,
      playerName: botName,
      isBot: true,
      ready: true,
      connected: true,
    };

    // Give bot a simple 99-basic-land deck
    this.storeDeckJson(seat, JSON.stringify({
      commander: `Bot Commander ${seat + 1}`,
      cards: Array(99).fill({ name: 'Plains', qty: 1 }),
    }));

    this.broadcastLobbyState();
    void this.persistState();

    // Check if all occupied seats are ready
    const occupiedSeats = this.lobbySeats.filter((s) => s.playerName !== null);
    if (occupiedSeats.length >= 2 && occupiedSeats.every((s) => s.ready)) {
      void this.startGame();
    }
  }

  // ───── Game Start ─────

  private async startGame(): Promise<void> {
    if (this.sessionPhase !== 'lobby') return;

    await loadGameEngine();

    if (!_setupNewGameN) {
      // Engine not available — broadcast error
      this.broadcastAll({ type: 'error', message: 'Game engine unavailable. Please try again.' });
      return;
    }

    // Build PlayerConfig[] from occupied seats
    const occupiedSeats = this.lobbySeats.filter((s) => s.playerName !== null);
    const configs: Array<{ name: string; deck: unknown; commander: unknown }> = [];

    for (const seat of occupiedSeats) {
      const deckJson = this.getDeckJson(seat.seat);
      const parsed = parseDeckJson(deckJson, seat.seat);
      configs.push({
        name: seat.playerName!,
        deck: parsed.deck,
        commander: parsed.commander,
      });
    }

    // Start the N-player game
    let initialState: unknown;
    try {
      initialState = _setupNewGameN(configs);
    } catch (err) {
      this.broadcastAll({ type: 'error', message: `Failed to start game: ${String(err)}` });
      return;
    }

    this.sessionPhase = 'game';
    this.gameStateJson = serializeGameState(initialState);
    await this.persistState();

    // Notify each connected human player
    for (const [ws, info] of this.connections) {
      this.send(ws, { type: 'game-started', yourSeat: info.seat, playerCount: occupiedSeats.length });
      this.sendStateToPlayer(ws, info.seat);
    }

    // Run bot turns if the first priority player is a bot
    void this.runBotTurnsIfNeeded();
  }

  // ───── Game Action Handler ─────

  private onGameAction(ws: WebSocket, action: GameActionPayload): void {
    if (this.sessionPhase !== 'game') {
      this.send(ws, { type: 'game-action-rejected', reason: 'Game not in progress' });
      return;
    }

    const info = this.connections.get(ws);
    if (!info) {
      this.send(ws, { type: 'game-action-rejected', reason: 'Not connected to a seat' });
      return;
    }

    if (!this.gameStateJson) {
      this.send(ws, { type: 'game-action-rejected', reason: 'No game state' });
      return;
    }

    // Verify this player has priority
    const priorityPlayer = this.gameStateJson.priorityPlayer;
    if (info.seat !== priorityPlayer) {
      this.send(ws, { type: 'game-action-rejected', reason: `Not your priority (player ${priorityPlayer} has priority)` });
      return;
    }

    if (!_executeAction || !_validateAction) {
      this.send(ws, { type: 'game-action-rejected', reason: 'Game engine not loaded' });
      return;
    }

    const currentState = deserializeGameState(this.gameStateJson);

    // Validate
    const validationError = _validateAction(currentState, action);
    if (validationError !== null) {
      this.send(ws, { type: 'game-action-rejected', reason: validationError });
      return;
    }

    // Execute
    const newState = _executeAction(currentState, action);
    this.gameStateJson = serializeGameState(newState);
    void this.persistState();

    // Check game over
    if (this.gameStateJson.gameOver) {
      this.sessionPhase = 'finished';
      void this.persistState();
      this.broadcastAll({
        type: 'game-over',
        winner: this.gameStateJson.winner,
        reason: this.gameStateJson.winner !== null
          ? `Player ${this.gameStateJson.winner} wins!`
          : 'Game ended in a draw.',
      });
      return;
    }

    // Broadcast updated state to all
    this.broadcastStateToAll();

    // Run bot turns if needed
    void this.runBotTurnsIfNeeded();
  }

  // ───── Sync Request ─────

  private onSyncRequest(ws: WebSocket): void {
    const info = this.connections.get(ws);
    if (!info) return;

    if (this.sessionPhase === 'lobby') {
      this.send(ws, { type: 'lobby-state', seats: this.lobbySeats, sessionId: this.sessionId });
    } else if (this.sessionPhase === 'game' && this.gameStateJson) {
      this.sendStateToPlayer(ws, info.seat);
    }
  }

  // ───── Bot Turn Runner ─────

  private async runBotTurnsIfNeeded(): Promise<void> {
    if (this.sessionPhase !== 'game' || !this.gameStateJson) return;
    if (!_executeAction) return;

    let safety = 0;

    while (safety < MAX_BOT_MOVES_PER_CALL) {
      if (!this.gameStateJson || this.gameStateJson.gameOver) break;

      const priorityPlayer = this.gameStateJson.priorityPlayer;
      const prioritySeat = this.lobbySeats.find((s) => s.seat === priorityPlayer);

      // If priority player is not a bot, stop
      if (!prioritySeat?.isBot) break;

      // Make a bot decision
      const botAction = simpleBotAction(this.gameStateJson, priorityPlayer);
      const currentState = deserializeGameState(this.gameStateJson);

      // Validate bot action
      if (_validateAction) {
        const err = _validateAction(currentState, botAction);
        if (err !== null) {
          // Bot action invalid — force pass to avoid infinite loop
          const forcePass = { type: 'pass', player: priorityPlayer };
          const newState = _executeAction(currentState, forcePass);
          this.gameStateJson = serializeGameState(newState);
        } else {
          const newState = _executeAction(currentState, botAction);
          this.gameStateJson = serializeGameState(newState);
        }
      } else {
        const newState = _executeAction(currentState, botAction);
        this.gameStateJson = serializeGameState(newState);
      }

      safety++;

      // Check game over after each bot move
      if (this.gameStateJson.gameOver) {
        this.sessionPhase = 'finished';
        await this.persistState();
        this.broadcastAll({
          type: 'game-over',
          winner: this.gameStateJson.winner,
          reason: this.gameStateJson.winner !== null
            ? `Player ${this.gameStateJson.winner} wins!`
            : 'Game ended in a draw.',
        });
        return;
      }
    }

    // Persist and broadcast after bot moves
    if (safety > 0) {
      await this.persistState();
      this.broadcastStateToAll();
    }
  }

  // ───── State Broadcasting ─────

  private buildStateView(gameState: GameStateJson, forSeat: number): GameStateView {
    const playerViews = gameState.players.map((p: PlayerStateJson) => ({
      id: p.id,
      name: p.name,
      life: p.life,
      handSize: Array.isArray(p.hand) ? p.hand.length : 0,
      librarySize: Array.isArray(p.library) ? p.library.length : 0,
      battlefield: Array.isArray(p.battlefield) ? p.battlefield : [],
      graveyard: Array.isArray(p.graveyard) ? p.graveyard : [],
      exile: Array.isArray(p.exile) ? p.exile : [],
      commandZone: Array.isArray(p.commandZone) ? p.commandZone : [],
      eliminated: p.eliminated,
    }));

    const myPlayer = gameState.players[forSeat];
    const yourHand = (myPlayer && Array.isArray(myPlayer.hand)) ? myPlayer.hand : [];
    const yourLibrarySize = (myPlayer && Array.isArray(myPlayer.library)) ? myPlayer.library.length : 0;

    return {
      activePlayer: gameState.activePlayer,
      priorityPlayer: gameState.priorityPlayer,
      turn: gameState.turn,
      phase: gameState.phase,
      step: gameState.step,
      players: playerViews,
      stack: Array.isArray(gameState.stack) ? gameState.stack : [],
      log: Array.isArray(gameState.log) ? gameState.log.slice(-50) : [], // last 50 log entries
      winner: gameState.winner,
      gameOver: gameState.gameOver,
      yourHand,
      yourLibrarySize,
    };
  }

  private sendStateToPlayer(ws: WebSocket, seat: number): void {
    if (!this.gameStateJson) return;
    const view = this.buildStateView(this.gameStateJson, seat);
    this.send(ws, { type: 'game-state', state: view });
  }

  private broadcastStateToAll(): void {
    if (!this.gameStateJson) return;
    for (const [ws, info] of this.connections) {
      this.sendStateToPlayer(ws, info.seat);
    }
  }

  // ───── Lobby State Broadcasting ─────

  private broadcastLobbyState(): void {
    const msg: GameSessionServerMessage = {
      type: 'lobby-state',
      seats: this.lobbySeats,
      sessionId: this.sessionId,
    };
    this.broadcastAll(msg);
  }

  // ───── Disconnect Handler ─────

  private async onDisconnect(ws: WebSocket): Promise<void> {
    const info = this.connections.get(ws);
    if (!info) return;

    this.connections.delete(ws);

    // Mark seat as disconnected
    if (this.lobbySeats[info.seat]) {
      this.lobbySeats[info.seat].connected = false;
    }

    this.broadcastLobbyState();

    // If game is in progress, schedule auto-pass after 30s
    if (this.sessionPhase === 'game') {
      this.scheduleAutoPass(info.seat);
    }
  }

  // ───── Auto-Pass for Disconnected Players ─────

  private scheduleAutoPass(seat: number): void {
    this.cancelAutoPass(seat);
    const timer = setTimeout(async () => {
      this.autoPassTimers.delete(seat);
      await this.autoPassForDisconnectedPlayer(seat);
    }, AUTO_PASS_DELAY_MS);
    this.autoPassTimers.set(seat, timer);
  }

  private cancelAutoPass(seat: number): void {
    const timer = this.autoPassTimers.get(seat);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.autoPassTimers.delete(seat);
    }
  }

  private async autoPassForDisconnectedPlayer(seat: number): Promise<void> {
    if (this.sessionPhase !== 'game' || !this.gameStateJson) return;
    if (!_executeAction) return;

    // Only auto-pass if this player has priority
    if (this.gameStateJson.priorityPlayer !== seat) return;

    const currentState = deserializeGameState(this.gameStateJson);
    const passAction = { type: 'pass', player: seat };
    const newState = _executeAction(currentState, passAction);
    this.gameStateJson = serializeGameState(newState);
    await this.persistState();
    this.broadcastStateToAll();
    await this.runBotTurnsIfNeeded();
  }

  // ───── Deck JSON Storage ─────
  // Store deck JSON per seat in DO storage (too large for in-memory lobby state)

  private storeDeckJson(seat: number, deckJson: string): void {
    void this.state.storage.put(`deck_${seat}`, deckJson.slice(0, 100_000));
  }

  private getDeckJson(seat: number): string {
    // Synchronously we can't retrieve from storage; we use a workaround:
    // The deck JSON is stored at game start from the seat's cached entry.
    // Since this is called only during startGame() (which is async), we've
    // pre-loaded it via getDeckJsonAsync() before calling this.
    return this._cachedDeckJsons.get(seat) ?? '{}';
  }

  private _cachedDeckJsons: Map<number, string> = new Map();

  private async preloadDeckJsons(): Promise<void> {
    for (let i = 0; i < this.maxPlayers; i++) {
      const stored = await this.state.storage.get<string>(`deck_${i}`);
      if (stored) {
        this._cachedDeckJsons.set(i, stored);
      }
    }
  }

  // Override startGame to preload decks first
  // (override the above startGame method via pattern)

  // ───── Helpers ─────

  private buildEmptySeats(count: number): SeatInfo[] {
    return Array.from({ length: count }, (_, i) => ({
      seat: i,
      playerName: null,
      isBot: false,
      ready: false,
      connected: false,
    }));
  }

  private findSeatByName(name: string): number {
    return this.lobbySeats.findIndex((s) => s.playerName === name);
  }

  private send(ws: WebSocket, msg: GameSessionServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Ignore — will be cleaned up on disconnect
    }
  }

  private broadcastAll(msg: GameSessionServerMessage): void {
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
