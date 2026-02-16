/**
 * Client-side auth helpers for DeckLens.
 *
 * Provides `getCurrentUser()`, `isLoggedIn()`, login/logout triggers,
 * and a reactive callback system for auth state changes.
 */

// ───── Types ─────

export type AuthProvider = 'github' | 'google';

export interface DeckLensUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  authProvider?: AuthProvider;
}

type AuthStateListener = (user: DeckLensUser | null) => void;

// ───── Constants ─────

const TOKEN_KEY = 'decklens_auth_token';

// ───── State ─────

let currentUser: DeckLensUser | null = null;
let fetchedOnce = false;
let fetchPromise: Promise<void> | null = null;
const listeners: Set<AuthStateListener> = new Set();

// ───── API Origin ─────

function getApiOrigin(): string {
  if (typeof window === 'undefined') return '';
  const w = window as Window & { __DECKLENS_API_ORIGIN?: string };
  if (typeof w.__DECKLENS_API_ORIGIN === 'string' && w.__DECKLENS_API_ORIGIN.trim()) {
    return w.__DECKLENS_API_ORIGIN.trim().replace(/\/$/, '');
  }
  const host = window.location.hostname.toLowerCase();
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';
  return isLocalhost ? '' : 'https://decklens-api.chrisgarkisch.workers.dev';
}

// ───── Core Functions ─────

/**
 * Get the current authenticated user (fetches from server if not yet loaded).
 * Returns null if not logged in.
 */
export async function getCurrentUser(): Promise<DeckLensUser | null> {
  if (fetchedOnce) return currentUser;

  // Deduplicate concurrent calls
  if (!fetchPromise) {
    fetchPromise = fetchCurrentUser();
  }
  await fetchPromise;
  fetchPromise = null;

  return currentUser;
}

/**
 * Synchronous check — only returns true if user has been fetched and is logged in.
 * Call getCurrentUser() first to ensure the user is loaded.
 */
export function isLoggedIn(): boolean {
  return currentUser !== null;
}

/**
 * Synchronous getter — returns null if not yet fetched or not logged in.
 */
export function getUser(): DeckLensUser | null {
  return currentUser;
}

/**
 * Get the session token (localStorage first, then cookie fallback).
 * Used for API calls and collab join.
 */
export function getSessionToken(): string | null {
  // localStorage token (set after OAuth redirect from API worker)
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
  } catch { /* localStorage unavailable */ }

  // Cookie fallback (same-origin only)
  const match = document.cookie.match(/(?:^|;\s*)decklens_session=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Redirect to GitHub OAuth login.
 */
export function loginWithGitHub(): void {
  const origin = getApiOrigin();
  // Encode current path as return URL
  const currentPath = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `${origin}/api/auth/github?return=${currentPath}`;
}

/**
 * Redirect to Google OAuth login.
 */
export function loginWithGoogle(): void {
  const origin = getApiOrigin();
  // Encode current path as return URL
  const currentPath = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `${origin}/api/auth/google?return=${currentPath}`;
}

/**
 * Log out: call server to clear session, then clear local state.
 */
export async function logout(): Promise<void> {
  const origin = getApiOrigin();
  const token = getSessionToken();
  try {
    await fetch(`${origin}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    // Continue with local cleanup even if server call fails
  }

  // Clear stored token
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ok */ }

  currentUser = null;
  fetchedOnce = false;
  notifyListeners();
}

/**
 * Listen for auth state changes.
 * Returns an unsubscribe function.
 */
export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Force a re-fetch of the current user (e.g. after OAuth callback).
 */
export async function refreshAuth(): Promise<DeckLensUser | null> {
  fetchedOnce = false;
  fetchPromise = null;
  return getCurrentUser();
}

// ───── Internal ─────

async function fetchCurrentUser(): Promise<void> {
  const origin = getApiOrigin();
  try {
    const token = getSessionToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${origin}/api/auth/me`, {
      credentials: 'include',
      headers,
    });

    if (!response.ok) {
      currentUser = null;
      fetchedOnce = true;
      return;
    }

    const data = (await response.json()) as {
      ok: boolean;
      data?: { user: DeckLensUser | null };
    };

    currentUser = data.ok && data.data?.user ? data.data.user : null;
  } catch {
    currentUser = null;
  }

  fetchedOnce = true;
  notifyListeners();
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener(currentUser);
    } catch (err) {
      console.error('[Auth] Listener error:', err);
    }
  }
}

// ───── Auto-init on import ─────

/**
 * Initialize auth on page load. Checks for auth callback params.
 * If OAuth redirect included a token param, stores it in localStorage
 * so cross-domain API calls can use Authorization: Bearer header.
 */
export function initAuth(): void {
  // Check for OAuth callback result
  const params = new URLSearchParams(window.location.search);
  const authResult = params.get('auth');
  const authError = params.get('auth_error');
  const token = params.get('token');

  // Store token from OAuth redirect (cross-domain auth)
  if (authResult === 'success' && token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      console.warn('[Auth] Could not store token in localStorage');
    }
  }

  if (authResult === 'success' || authError || token) {
    // Clean up URL params (remove sensitive token from URL bar)
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    url.searchParams.delete('auth_error');
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
  }

  // Fetch current user in the background
  getCurrentUser();
}
