import {
  createCommunityDeck,
  fetchMonitorHealth,
  fetchCommunityModerationQueue,
  flagCommunityDeck,
  fetchCommunityDecks,
  fetchRealtimeMeta,
  upvoteCommunityDeck,
  moderateCommunityDeck,
  type CommunityDeck,
  type CommunityFeedSortMode,
} from '../shared/api.js';
import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import { renderMarkdown } from '../deckbuilder/markdown-lite.js';
import { trackAnalyticsEvent } from '../shared/analytics.js';

interface CommunityProfileState {
  displayName: string;
  deckCount: number;
  updatedAt: string;
}

interface CommunityFeedState {
  sort: CommunityFeedSortMode;
  format: '' | 'commander' | 'cedh';
  archetype: string;
  query: string;
}

const DEFAULT_PROFILE_NAME = 'Anonymous Brewer';

const DEFAULT_FEED_STATE: CommunityFeedState = {
  sort: 'newest',
  format: '',
  archetype: '',
  query: '',
};

let communityProfile: CommunityProfileState = loadCommunityProfile();
let feedState: CommunityFeedState = loadFeedState();
let feedSearchDebounceRef: ReturnType<typeof setTimeout> | null = null;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeProfile(raw: unknown): CommunityProfileState {
  const obj = raw && typeof raw === 'object' ? raw as Partial<CommunityProfileState> : null;
  const displayName = typeof obj?.displayName === 'string' && obj.displayName.trim()
    ? obj.displayName.trim().slice(0, 40)
    : DEFAULT_PROFILE_NAME;
  const deckCount = typeof obj?.deckCount === 'number' && Number.isFinite(obj.deckCount)
    ? Math.max(0, Math.trunc(obj.deckCount))
    : 0;
  const updatedAt = typeof obj?.updatedAt === 'string' && obj.updatedAt.trim()
    ? obj.updatedAt
    : new Date().toISOString();
  return {
    displayName,
    deckCount,
    updatedAt,
  };
}

function loadCommunityProfile(): CommunityProfileState {
  const raw = storageGet<unknown>(STORAGE_KEYS.COMMUNITY_PROFILE, null);
  return normalizeProfile(raw);
}

function saveCommunityProfile(profile: CommunityProfileState): void {
  communityProfile = {
    ...profile,
    displayName: profile.displayName.trim().slice(0, 40) || DEFAULT_PROFILE_NAME,
    deckCount: Math.max(0, Math.trunc(profile.deckCount)),
    updatedAt: new Date().toISOString(),
  };
  storageSet(STORAGE_KEYS.COMMUNITY_PROFILE, communityProfile);
}

function normalizeFeedState(raw: unknown): CommunityFeedState {
  const obj = raw && typeof raw === 'object' ? raw as Partial<CommunityFeedState> : null;
  const sort = obj?.sort === 'top' || obj?.sort === 'archetype' ? obj.sort : 'newest';
  const format = obj?.format === 'commander' || obj?.format === 'cedh' ? obj.format : '';
  const archetype = typeof obj?.archetype === 'string' ? obj.archetype.trim().slice(0, 50) : '';
  const query = typeof obj?.query === 'string' ? obj.query.trim().slice(0, 80) : '';
  return {
    sort,
    format,
    archetype,
    query,
  };
}

function loadFeedState(): CommunityFeedState {
  const raw = storageGet<unknown>(STORAGE_KEYS.COMMUNITY_FEED_PREFS, null);
  if (!raw) return { ...DEFAULT_FEED_STATE };
  return normalizeFeedState(raw);
}

function saveFeedState(nextState: CommunityFeedState): void {
  feedState = normalizeFeedState(nextState);
  storageSet(STORAGE_KEYS.COMMUNITY_FEED_PREFS, feedState);
}

function formatElapsedFromIso(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'just now';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value * 100)}%`;
}

function renderProfileCard(): void {
  const input = byId<HTMLInputElement>('profileDisplayName');
  const count = byId<HTMLSpanElement>('profileDeckCount');
  const updated = byId<HTMLSpanElement>('profileUpdatedAt');

  input.value = communityProfile.displayName;
  count.textContent = String(communityProfile.deckCount);
  updated.textContent = new Date(communityProfile.updatedAt).toLocaleString();
}

function readFeedControls(): CommunityFeedState {
  const sort = byId<HTMLSelectElement>('feedSort').value as CommunityFeedSortMode;
  const formatRaw = byId<HTMLSelectElement>('feedFormat').value;
  const format = formatRaw === 'commander' || formatRaw === 'cedh' ? formatRaw : '';
  const archetype = byId<HTMLSelectElement>('feedArchetype').value.trim();
  const query = byId<HTMLInputElement>('feedSearch').value.trim();

  return normalizeFeedState({
    sort,
    format,
    archetype,
    query,
  });
}

function syncFeedControlsFromState(): void {
  byId<HTMLSelectElement>('feedSort').value = feedState.sort;
  byId<HTMLSelectElement>('feedFormat').value = feedState.format;
  byId<HTMLInputElement>('feedSearch').value = feedState.query;
}

function renderArchetypeFilterOptions(items: CommunityDeck[]): void {
  const select = byId<HTMLSelectElement>('feedArchetype');
  const selected = feedState.archetype;

  const archetypeCounts = new Map<string, number>();
  for (const deck of items) {
    const at = deck.archetype.trim();
    if (at) archetypeCounts.set(at, (archetypeCounts.get(at) || 0) + 1);
  }
  const archetypes = [...archetypeCounts.keys()].sort((a, b) => a.localeCompare(b));

  const options = ['<option value="">All archetypes</option>'];
  for (const archetype of archetypes) {
    const value = escapeHtml(archetype);
    const count = archetypeCounts.get(archetype) || 0;
    const selectedAttr = archetype === selected ? ' selected' : '';
    options.push(`<option value="${value}"${selectedAttr}>${value} (${count})</option>`);
  }
  select.innerHTML = options.join('');

  if (selected && !archetypes.includes(selected)) {
    select.value = '';
    saveFeedState({ ...feedState, archetype: '' });
  }
}

async function renderMeta(): Promise<void> {
  const box = byId<HTMLDivElement>('metaBox');
  const healthBox = byId<HTMLDivElement>('healthBox');
  try {
    const meta = await fetchRealtimeMeta();
    const top = meta.archetypes
      .map((a) => `<span class="meta-chip">${escapeHtml(a.name)} ${Math.round(a.share * 100)}% ${a.trend === 'up' ? '↗' : a.trend === 'down' ? '↘' : '→'}</span>`)
      .join('');
    const cards = meta.trendingCards
      .map((c) => `<span class="meta-chip">${escapeHtml(c.name)} +${c.delta}</span>`)
      .join('');
    const freshness = meta.freshness.ageMinutes <= 0
      ? 'just now'
      : `${meta.freshness.ageMinutes}m ago`;
    const confidenceBandLabel = meta.confidence.band.toUpperCase();
    const confidenceColor = meta.confidence.band === 'high'
      ? 'var(--accent)'
      : (meta.confidence.band === 'medium' ? 'var(--gold)' : 'var(--danger)');
    const qualityLine = meta.quality.degraded
      ? `<div class="danger" style="margin-top:6px;">${escapeHtml(meta.quality.label)} · ${meta.quality.reasons.join(', ') || 'limited signals'}</div>`
      : `<div class="muted" style="margin-top:6px;">${escapeHtml(meta.quality.label)}</div>`;

    box.innerHTML = `
      <div class="muted">Updated: ${new Date(meta.updatedAt).toLocaleString()} · ${freshness} · ${meta.freshness.state}</div>
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="meta-chip" style="border-color:${confidenceColor};color:${confidenceColor};">Confidence ${formatPercent(meta.confidence.score)} (${confidenceBandLabel})</span>
        <span class="meta-chip">Session ${formatPercent(meta.confidence.components.sessionSignal)}</span>
        <span class="meta-chip">Volume ${formatPercent(meta.confidence.components.eventVolume)}</span>
        <span class="meta-chip">Coverage ${formatPercent(meta.confidence.components.communityCoverage)}</span>
      </div>
      ${qualityLine}
      <div style="margin-top:6px;">${top || '<span class="muted">No archetype data</span>'}</div>
      <div style="margin-top:8px;">${cards || '<span class="muted">No card trend data</span>'}</div>
    `;
    try {
      const health = await fetchMonitorHealth();
      healthBox.innerHTML = `Ops: ${health.status} · persistence ${health.persistence} · decks ${health.communityDecks} · abuse 24h ${health.abuseFlags24h}`;
      healthBox.className = 'muted';
    } catch (err) {
      healthBox.textContent = `Monitor unavailable: ${err instanceof Error ? err.message : 'unknown error'}`;
      healthBox.className = 'danger';
    }
  } catch (error) {
    box.textContent = `Failed to load meta: ${error instanceof Error ? error.message : 'unknown error'}`;
    box.classList.add('danger');
    healthBox.textContent = '';
  }
}

function deckRow(deck: CommunityDeck, deckCountByAuthor: Map<string, number>): string {
  const author = (deck.authorDisplayName || 'Anonymous').trim() || 'Anonymous';
  const authorDeckCount = deckCountByAuthor.get(author.toLowerCase()) || 1;
  const notesPlaceholder = deck.notes ? `<div class="feed-notes" data-notes-for="${escapeHtml(deck.id)}"></div>` : '';

  return `
    <div class="feed-item" data-deck-id="${escapeHtml(deck.id)}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
        <strong>${escapeHtml(deck.name)}</strong>
        <button class="btn upvote" data-deck-id="${escapeHtml(deck.id)}">▲ ${deck.upvotes}</button>
      </div>
      <div class="muted" style="margin-top:4px;">by ${escapeHtml(author)} · ${authorDeckCount} deck${authorDeckCount === 1 ? '' : 's'} shared</div>
      <div class="muted" style="margin-top:2px;">${escapeHtml(deck.commander)} · ${escapeHtml(deck.archetype)} · ${deck.format.toUpperCase()} · ${formatElapsedFromIso(deck.createdAt)}</div>
      ${notesPlaceholder}
      <details style="margin-top:8px;"><summary class="muted">Decklist</summary><pre>${escapeHtml(deck.decklist)}</pre></details>
      <button class="btn" style="margin-top:6px;" data-flag-id="${escapeHtml(deck.id)}">Report</button>
    </div>
  `;
}

function renderFeedSkeleton(container: HTMLElement): void {
  container.innerHTML = Array.from({ length: 3 }, () =>
    '<div class="feed-item feed-skeleton"><div class="skeleton-line w60"></div><div class="skeleton-line w40"></div><div class="skeleton-line w80"></div></div>',
  ).join('');
}

async function renderFeed(): Promise<void> {
  const feed = byId<HTMLDivElement>('feed');
  feed.classList.remove('danger');
  renderFeedSkeleton(feed);

  try {
    const items = await fetchCommunityDecks({
      limit: 50,
      sort: feedState.sort,
      format: feedState.format || undefined,
      archetype: feedState.archetype || undefined,
      q: feedState.query || undefined,
    });

    renderArchetypeFilterOptions(items);

    if (!items.length) {
      feed.innerHTML = '<span class="muted">No shared decks match the current filters.</span>';
      return;
    }

    const deckCountByAuthor = new Map<string, number>();
    for (const deck of items) {
      const key = (deck.authorDisplayName || 'Anonymous').trim().toLowerCase() || 'anonymous';
      deckCountByAuthor.set(key, (deckCountByAuthor.get(key) || 0) + 1);
    }

    const countEl = document.createElement('div');
    countEl.className = 'feed-count muted';
    countEl.textContent = `Showing ${items.length} deck${items.length === 1 ? '' : 's'}`;

    feed.innerHTML = items.map((deck) => deckRow(deck, deckCountByAuthor)).join('');
    feed.prepend(countEl);

    // Render notes as markdown DOM (XSS-safe) for each feed item
    for (const deck of items) {
      if (!deck.notes) continue;
      const notesEl = feed.querySelector<HTMLDivElement>(`[data-notes-for="${deck.id}"]`);
      if (notesEl) {
        notesEl.appendChild(renderMarkdown(deck.notes));
      }
    }

    feed.querySelectorAll<HTMLButtonElement>('button.upvote').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deckId || '';
        if (!id) return;
        btn.disabled = true;
        try {
          await upvoteCommunityDeck(id);
          trackAnalyticsEvent('community_deck_upvoted', { deckId: id });
          await renderFeed();
        } finally {
          btn.disabled = false;
        }
      });
    });

    feed.querySelectorAll<HTMLButtonElement>('button[data-flag-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.flagId || '';
        if (!id) return;
        btn.disabled = true;
        try {
          await flagCommunityDeck(id, 'manual_report');
          trackAnalyticsEvent('community_deck_flagged', { deckId: id });
          btn.textContent = 'Reported';
          await renderModerationQueue();
        } catch (error) {
          btn.disabled = false;
          btn.textContent = `Report failed: ${error instanceof Error ? error.message : 'unknown error'}`;
          btn.classList.add('danger');
        }
      });
    });
  } catch (error) {
    feed.textContent = `Failed to load feed: ${error instanceof Error ? error.message : 'unknown error'}`;
    feed.classList.add('danger');
  }
}

async function renderModerationQueue(): Promise<void> {
  const queue = byId<HTMLDivElement>('moderationQueue');
  queue.classList.remove('danger');
  renderFeedSkeleton(queue);

  try {
    const items = await fetchCommunityModerationQueue({ limit: 25 });
    if (!items.length) {
      queue.innerHTML = '<span class="muted">No flagged decks in queue.</span>';
      return;
    }

    queue.innerHTML = items.map((item) => {
      const deckMeta = item.deck
        ? `${escapeHtml(item.deck.name)} · ${escapeHtml(item.deck.commander)} · ${escapeHtml(item.deck.archetype)} · ▲${item.deck.upvotes}`
        : `Deck ${escapeHtml(item.deckId)} (missing)`;

      const flagCount = item.totalFlagsForDeck;
      const badge = flagCount >= 3
        ? '<span class="queue-badge queue-badge-high">3+ flags — consider removing</span>'
        : `<span class="queue-badge">${flagCount} flag${flagCount === 1 ? '' : 's'}</span>`;

      return `
        <div class="queue-item">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
            <strong>${deckMeta}</strong>
            <span style="display:flex;gap:8px;align-items:center;">
              ${badge}
              <span class="muted">${formatElapsedFromIso(item.reportedAt)}</span>
            </span>
          </div>
          <div class="muted" style="margin-top:4px;">Reason: ${escapeHtml(item.reason)} · Reporter: ${escapeHtml(item.reporterRef)}</div>
          <div class="queue-actions">
            <button class="btn inline queue-dismiss" data-flag-id="${escapeHtml(item.id)}" data-deck-id="${escapeHtml(item.deckId)}">Dismiss Flag</button>
            <button class="btn inline queue-remove" data-deck-id="${escapeHtml(item.deckId)}">Remove Deck</button>
          </div>
        </div>
      `;
    }).join('');

    // Bind moderation action buttons
    queue.querySelectorAll<HTMLButtonElement>('.queue-dismiss').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const flagId = btn.dataset.flagId || '';
        const deckId = btn.dataset.deckId || '';
        if (!deckId) return;
        btn.disabled = true;
        try {
          await moderateCommunityDeck(deckId, 'dismiss', flagId || undefined);
          trackAnalyticsEvent('community_moderation_action', { action: 'dismiss', deckId });
          await renderModerationQueue();
        } catch (error) {
          btn.disabled = false;
          btn.textContent = `Failed: ${error instanceof Error ? error.message : 'error'}`;
          btn.classList.add('danger');
        }
      });
    });

    queue.querySelectorAll<HTMLButtonElement>('.queue-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const deckId = btn.dataset.deckId || '';
        if (!deckId) return;
        if (!confirm('Remove this deck permanently? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          await moderateCommunityDeck(deckId, 'remove');
          trackAnalyticsEvent('community_moderation_action', { action: 'remove', deckId });
          await Promise.all([renderModerationQueue(), renderFeed()]);
        } catch (error) {
          btn.disabled = false;
          btn.textContent = `Failed: ${error instanceof Error ? error.message : 'error'}`;
          btn.classList.add('danger');
        }
      });
    });
  } catch (error) {
    queue.textContent = `Failed to load moderation queue: ${error instanceof Error ? error.message : 'unknown error'}`;
    queue.classList.add('danger');
  }
}

async function shareDeck(): Promise<void> {
  const msg = byId<HTMLDivElement>('shareMsg');
  msg.textContent = '';

  const payload = {
    name: byId<HTMLInputElement>('name').value.trim(),
    format: byId<HTMLSelectElement>('format').value as 'commander' | 'cedh',
    commander: byId<HTMLInputElement>('commander').value.trim(),
    archetype: byId<HTMLInputElement>('archetype').value.trim(),
    decklist: byId<HTMLTextAreaElement>('decklist').value.trim(),
    notes: byId<HTMLInputElement>('notes').value.trim(),
    authorDisplayName: communityProfile.displayName,
  };

  if (!payload.name || !payload.commander || !payload.archetype || !payload.decklist) {
    msg.textContent = 'Please fill required fields.';
    msg.className = 'danger';
    return;
  }

  try {
    await createCommunityDeck(payload);
    trackAnalyticsEvent('community_deck_shared', {
      format: payload.format,
      archetype: payload.archetype,
      hasNotes: Boolean(payload.notes),
    });
    saveCommunityProfile({
      ...communityProfile,
      deckCount: communityProfile.deckCount + 1,
    });
    renderProfileCard();

    msg.textContent = 'Deck shared successfully.';
    msg.className = 'muted';
    await Promise.all([renderFeed(), renderMeta(), renderModerationQueue()]);
  } catch (error) {
    msg.textContent = `Share failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    msg.className = 'danger';
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all([renderMeta(), renderFeed(), renderModerationQueue()]);
}

function applyFeedControlsAndRefresh(): void {
  saveFeedState(readFeedControls());
  trackAnalyticsEvent('community_filter_changed', {
    sort: feedState.sort,
    format: feedState.format,
    archetype: feedState.archetype,
  });
  void renderFeed();
}

function resetFeedControls(): void {
  saveFeedState({ ...DEFAULT_FEED_STATE });
  syncFeedControlsFromState();
  void renderFeed();
}

function saveProfileFromInput(): void {
  const input = byId<HTMLInputElement>('profileDisplayName');
  const message = byId<HTMLDivElement>('profileMsg');
  const nextName = input.value.trim().slice(0, 40);
  if (!nextName) {
    message.textContent = 'Display name cannot be empty.';
    message.className = 'danger';
    return;
  }

  saveCommunityProfile({
    ...communityProfile,
    displayName: nextName,
  });
  renderProfileCard();
  message.textContent = 'Profile saved.';
  message.className = 'muted';
}

function bindFeedControls(): void {
  byId<HTMLSelectElement>('feedSort').addEventListener('change', applyFeedControlsAndRefresh);
  byId<HTMLSelectElement>('feedFormat').addEventListener('change', applyFeedControlsAndRefresh);
  byId<HTMLSelectElement>('feedArchetype').addEventListener('change', applyFeedControlsAndRefresh);
  byId<HTMLButtonElement>('feedApplyFilters').addEventListener('click', applyFeedControlsAndRefresh);
  byId<HTMLButtonElement>('feedResetFilters').addEventListener('click', resetFeedControls);

  byId<HTMLInputElement>('feedSearch').addEventListener('input', () => {
    if (feedSearchDebounceRef) {
      clearTimeout(feedSearchDebounceRef);
    }
    feedSearchDebounceRef = setTimeout(() => {
      const query = byId<HTMLInputElement>('feedSearch').value.trim();
      if (query) {
        trackAnalyticsEvent('community_search_performed', { query });
      }
      applyFeedControlsAndRefresh();
    }, 280);
  });
}

// ── Card Hover Preview (for [[Card Name]] links in notes) ──

let hoverPreviewEl: HTMLElement | null = null;

function initCardHoverPreview(): void {
  hoverPreviewEl = document.getElementById('cardHoverPreview');
  if (!hoverPreviewEl) return;

  const feed = byId<HTMLDivElement>('feed');

  feed.addEventListener('mouseover', (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    if (!link || !hoverPreviewEl) return;
    const name = link.getAttribute('data-card-name');
    if (!name) return;

    const img = hoverPreviewEl.querySelector<HTMLImageElement>('img');
    if (img) {
      img.src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;
      img.alt = name;
    }
    positionHoverPreview(e);
    hoverPreviewEl.classList.add('visible');
  });

  feed.addEventListener('mouseout', (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    if (!link || !hoverPreviewEl) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && link.contains(related)) return;
    hoverPreviewEl.classList.remove('visible');
  });
}

function positionHoverPreview(e: MouseEvent): void {
  if (!hoverPreviewEl) return;
  const pad = 16;
  const previewW = 250;
  const previewH = 350;
  let x = e.clientX + pad;
  let y = e.clientY - previewH / 2;
  if (x + previewW > window.innerWidth) x = e.clientX - previewW - pad;
  if (y < pad) y = pad;
  if (y + previewH > window.innerHeight - pad) y = window.innerHeight - previewH - pad;
  hoverPreviewEl.style.left = `${x}px`;
  hoverPreviewEl.style.top = `${y}px`;
}

function init(): void {
  trackAnalyticsEvent('community_page_viewed');
  syncFeedControlsFromState();
  renderProfileCard();
  bindFeedControls();
  initCardHoverPreview();

  byId<HTMLButtonElement>('saveProfileBtn').addEventListener('click', saveProfileFromInput);
  byId<HTMLButtonElement>('shareBtn').addEventListener('click', () => { void shareDeck(); });
  byId<HTMLButtonElement>('refreshAll').addEventListener('click', () => { void refreshAll(); });
  byId<HTMLButtonElement>('refreshQueue').addEventListener('click', () => { void renderModerationQueue(); });

  void refreshAll();
  setInterval(() => { void refreshAll(); }, 30_000);
}

init();
