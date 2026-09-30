// ==================== Direct Scryfall Browser Client ====================
// Replaces the Cloudflare Worker /api/scryfall/* proxy routes with direct
// browser calls to https://api.scryfall.com (Scryfall serves CORS headers).
// Signatures are identical to the old src/shared/api.ts versions so call
// sites only change their import path.

export interface DeckbuilderSearchCard {
  id: string;
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  keywords?: string[];
  color_identity?: string[];
  legalities?: Record<string, string>;
  set?: string;
  collector_number?: string;
  prices?: Record<string, string | null>;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
  };
  rarity?: string;
  power?: string;
  toughness?: string;
  edhrec_rank?: number;
  /** Wizards' Commander Brackets "Game Changer" list membership */
  game_changer?: boolean;
  produced_mana?: string[];
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
    };
  }>;
}

export interface DeckbuilderSearchParams {
  q: string;
  colorIdentity?: string;
  type?: string;
  manaValue?: string;
  oracleText?: string;
  keyword?: string;
  legality?: 'commander';
  sort?: 'name' | 'mv' | 'price';
  /** Trusted raw Scryfall syntax appended verbatim (internal presets only). */
  raw?: string;
}

const SCRYFALL_API = 'https://api.scryfall.com';
const COLLECTION_CHUNK_SIZE = 75; // Scryfall /cards/collection hard limit
const FETCH_TIMEOUT_MS = 12000;

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * fetch with timeout and a single backoff retry on 429/503/504.
 * Unlike fetchRobust it returns the raw Response so callers can treat
 * Scryfall's 404 ("no results") as data instead of an error.
 */
async function scryfallFetch(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    init?.signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      return await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.headers || {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', onOuterAbort);
    }
  };

  let response = await attempt();
  if ([429, 503, 504].includes(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    response = await attempt();
  }
  if (response.status === 429) {
    throw new Error('Rate limited. Please try again in a moment.');
  }
  return response;
}

function mapImageUris(raw: unknown): DeckbuilderSearchCard['image_uris'] {
  if (!isObject(raw)) return undefined;
  return {
    small: typeof raw.small === 'string' ? raw.small : undefined,
    normal: typeof raw.normal === 'string' ? raw.normal : undefined,
    large: typeof raw.large === 'string' ? raw.large : undefined,
  };
}

function mapScryfallCard(raw: unknown): DeckbuilderSearchCard | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!id || !name) return null;

  const cmcRaw = Number(raw.cmc);
  const pricesRaw = isObject(raw.prices) ? raw.prices : {};

  const faces = Array.isArray(raw.card_faces)
    ? raw.card_faces.filter(isObject).map((face) => ({
        name: typeof face.name === 'string' ? face.name : undefined,
        mana_cost: typeof face.mana_cost === 'string' ? face.mana_cost : undefined,
        type_line: typeof face.type_line === 'string' ? face.type_line : undefined,
        oracle_text: typeof face.oracle_text === 'string' ? face.oracle_text : undefined,
        power: typeof face.power === 'string' ? face.power : undefined,
        toughness: typeof face.toughness === 'string' ? face.toughness : undefined,
        image_uris: mapImageUris(face.image_uris),
      }))
    : undefined;

  const firstFace = faces && faces.length > 0 ? faces[0] : undefined;

  return {
    id,
    oracle_id: typeof raw.oracle_id === 'string' ? raw.oracle_id : undefined,
    name,
    mana_cost: typeof raw.mana_cost === 'string' ? raw.mana_cost : firstFace?.mana_cost,
    cmc: Number.isFinite(cmcRaw) ? cmcRaw : 0,
    type_line: typeof raw.type_line === 'string' ? raw.type_line : firstFace?.type_line || '',
    oracle_text: typeof raw.oracle_text === 'string' ? raw.oracle_text : firstFace?.oracle_text,
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === 'string') : undefined,
    color_identity: Array.isArray(raw.color_identity)
      ? raw.color_identity.filter((c): c is string => typeof c === 'string').map((c) => c.toUpperCase())
      : undefined,
    legalities: isObject(raw.legalities)
      ? Object.fromEntries(Object.entries(raw.legalities).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)]))
      : undefined,
    set: typeof raw.set === 'string' ? raw.set : undefined,
    collector_number: typeof raw.collector_number === 'string' ? raw.collector_number : undefined,
    prices: {
      eur: typeof pricesRaw.eur === 'string' ? pricesRaw.eur : null,
      usd: typeof pricesRaw.usd === 'string' ? pricesRaw.usd : null,
    },
    image_uris: mapImageUris(raw.image_uris) ?? firstFace?.image_uris,
    rarity: typeof raw.rarity === 'string' ? raw.rarity : undefined,
    power: typeof raw.power === 'string' ? raw.power : firstFace?.power,
    toughness: typeof raw.toughness === 'string' ? raw.toughness : firstFace?.toughness,
    edhrec_rank: typeof raw.edhrec_rank === 'number' && Number.isFinite(raw.edhrec_rank) ? raw.edhrec_rank : undefined,
    game_changer: raw.game_changer === true ? true : undefined,
    produced_mana: Array.isArray(raw.produced_mana)
      ? raw.produced_mana.filter((p): p is string => typeof p === 'string')
      : undefined,
    card_faces: faces,
  };
}

function escapeScryfallTerm(raw: string): string {
  const clean = raw.trim().replace(/"/g, '');
  if (!clean) return '';
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

function parseManaValueToken(raw: string): string | null {
  const match = raw.trim().match(/^([<>]=?|=)?\s*(\d{1,2})$/);
  if (!match) return null;
  const operator = match[1] || '=';
  const value = Number.parseInt(match[2], 10);
  if (!Number.isFinite(value) || value < 0 || value > 20) return null;
  return `mv${operator}${value}`;
}

function buildScryfallSearchQuery(params: DeckbuilderSearchParams): { query: string; order: string } {
  const tokens: string[] = [];

  const q = params.q.trim();
  if (q) {
    const escaped = escapeScryfallTerm(q);
    if (escaped) tokens.push(escaped);
  }

  const colorIdentityRaw = (params.colorIdentity || '').toUpperCase();
  const colorIdentity = [...new Set(colorIdentityRaw.replace(/[^WUBRG]/g, '').split(''))].join('');
  if (colorIdentity) tokens.push(`id<=${colorIdentity.toLowerCase()}`);

  if (params.type?.trim()) {
    const escaped = escapeScryfallTerm(params.type);
    if (escaped) tokens.push(`t:${escaped}`);
  }

  if (params.manaValue?.trim()) {
    const token = parseManaValueToken(params.manaValue);
    if (token) tokens.push(token);
  }

  if (params.oracleText?.trim()) {
    const escaped = escapeScryfallTerm(params.oracleText);
    if (escaped) tokens.push(`o:${escaped}`);
  }

  if (params.keyword?.trim()) {
    const escaped = escapeScryfallTerm(params.keyword);
    if (escaped) tokens.push(`keyword:${escaped}`);
  }

  if (params.legality === 'commander') {
    tokens.push('legal:commander');
  }

  if (params.raw?.trim()) {
    tokens.push(params.raw.trim());
  }

  const order = params.sort === 'mv' ? 'cmc' : params.sort === 'price' ? 'eur' : 'name';
  return { query: tokens.join(' ').trim(), order };
}

export async function fetchDeckbuilderAutocomplete(
  query: string,
  options?: { signal?: AbortSignal },
): Promise<string[]> {
  const q = query.trim();
  if (!q || q.length < 2) return [];

  const response = await scryfallFetch(
    `${SCRYFALL_API}/cards/autocomplete?q=${encodeURIComponent(q)}`,
    { signal: options?.signal },
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error('Failed to fetch autocomplete suggestions.');
  }
  const parsed = await response.json() as { data?: unknown[] };
  return Array.isArray(parsed.data)
    ? parsed.data.filter((item): item is string => typeof item === 'string')
    : [];
}

export async function searchDeckbuilderCards(
  params: DeckbuilderSearchParams,
  options?: { signal?: AbortSignal },
): Promise<{ items: DeckbuilderSearchCard[]; hasMore: boolean; totalCards: number | null }> {
  const { query, order } = buildScryfallSearchQuery(params);
  if (!query) {
    return { items: [], hasMore: false, totalCards: 0 };
  }

  const response = await scryfallFetch(
    `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(query)}&order=${encodeURIComponent(order)}&dir=asc&unique=cards`,
    { signal: options?.signal },
  );

  // Scryfall answers a search with zero hits with HTTP 404 — that is "no results", not an error.
  if (response.status === 404) {
    return { items: [], hasMore: false, totalCards: 0 };
  }
  if (!response.ok) {
    throw new Error('Failed to search cards.');
  }

  const payload = await response.json() as { data?: unknown[]; has_more?: boolean; total_cards?: number };
  const items = Array.isArray(payload.data)
    ? payload.data.map(mapScryfallCard).filter((item): item is DeckbuilderSearchCard => Boolean(item)).slice(0, 80)
    : [];

  return {
    items,
    hasMore: Boolean(payload.has_more),
    totalCards: Number.isFinite(payload.total_cards) ? Number(payload.total_cards) : null,
  };
}

export async function resolveDeckbuilderCards(names: string[]): Promise<{
  resolved: Record<string, DeckbuilderSearchCard>;
  missing: string[];
}> {
  const clean = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 500);
  if (clean.length === 0) {
    return { resolved: {}, missing: [] };
  }

  const resolvedMap: Record<string, DeckbuilderSearchCard> = {};
  const missing: string[] = [];

  for (let offset = 0; offset < clean.length; offset += COLLECTION_CHUNK_SIZE) {
    const chunk = clean.slice(offset, offset + COLLECTION_CHUNK_SIZE);
    const response = await scryfallFetch(`${SCRYFALL_API}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Scryfall's collection endpoint does not match full double-faced
      // names ("A // B") — it needs the front face; the response still
      // carries the full name, which our key mapping handles below.
      body: JSON.stringify({ identifiers: chunk.map((name) => ({ name: name.split('//')[0].trim() })) }),
    });
    if (!response.ok) {
      throw new Error('Failed to resolve cards.');
    }
    const payload = await response.json() as { data?: unknown[]; not_found?: Array<{ name?: string }> };

    const cards = Array.isArray(payload.data)
      ? payload.data.map(mapScryfallCard).filter((item): item is DeckbuilderSearchCard => Boolean(item))
      : [];
    const cardsByName = new Map<string, DeckbuilderSearchCard>();
    for (const card of cards) {
      const key = normalizeNameKey(card.name);
      if (!cardsByName.has(key)) cardsByName.set(key, card);
      resolvedMap[key] = card;
      // Double-faced cards: allow lookup by front-face name too.
      const frontFace = card.name.split('//')[0];
      const frontKey = normalizeNameKey(frontFace);
      if (frontKey && !resolvedMap[frontKey]) resolvedMap[frontKey] = card;
    }

    const notFound = new Set(
      (payload.not_found || [])
        .map((item) => (typeof item.name === 'string' ? normalizeNameKey(item.name) : ''))
        .filter(Boolean),
    );

    for (const name of chunk) {
      const key = normalizeNameKey(name);
      if (resolvedMap[key]) continue;
      // not_found echoes the queried (front-face) identifier
      if (notFound.has(key) || notFound.has(normalizeNameKey(name.split('//')[0]))) {
        missing.push(name);
        continue;
      }
      // Fuzzy match: Scryfall may return a card whose exact name differs from the query.
      const fallback = cards.find((card) => normalizeNameKey(card.name).startsWith(key));
      if (fallback) {
        resolvedMap[key] = fallback;
      } else {
        missing.push(name);
      }
    }
  }

  return { resolved: resolvedMap, missing };
}

/** All paper printings of a card, newest first (for the artwork picker). */
export async function fetchCardPrints(name: string): Promise<DeckbuilderSearchCard[]> {
  const clean = name.trim().replace(/"/g, '');
  if (!clean) return [];
  const q = `!"${clean}" game:paper`;
  const response = await scryfallFetch(
    `${SCRYFALL_API}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&dir=desc`,
  );
  if (response.status === 404) return [];
  if (!response.ok) throw new Error('Failed to load printings.');
  const payload = await response.json() as { data?: unknown[] };
  return Array.isArray(payload.data)
    ? payload.data.map(mapScryfallCard).filter((c): c is DeckbuilderSearchCard => Boolean(c))
    : [];
}

/** Resolve specific printings by set + collector number. */
export async function resolveDeckbuilderPrintings(
  refs: Array<{ set: string; collectorNumber: string }>,
): Promise<DeckbuilderSearchCard[]> {
  const clean = refs
    .filter((r) => r.set.trim() && r.collectorNumber.trim())
    .slice(0, COLLECTION_CHUNK_SIZE);
  if (clean.length === 0) return [];

  const response = await scryfallFetch(`${SCRYFALL_API}/cards/collection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifiers: clean.map((r) => ({ set: r.set.trim(), collector_number: r.collectorNumber.trim() })),
    }),
  });
  if (!response.ok) throw new Error('Failed to resolve printings.');
  const payload = await response.json() as { data?: unknown[] };
  return Array.isArray(payload.data)
    ? payload.data.map(mapScryfallCard).filter((c): c is DeckbuilderSearchCard => Boolean(c))
    : [];
}
