/**
 * Auth — GitHub + Google OAuth authentication for DeckLens.
 *
 * Handles the full OAuth flow for both providers:
 *   1. Redirect to provider authorize URL
 *   2. Exchange code for access token
 *   3. Fetch user profile
 *   4. Create/update user in D1
 *   5. Create session token, set cookie
 *
 * Also provides session validation and user lookup helpers.
 */

// ───── Types ─────

export type AuthProvider = 'github' | 'google';

export interface AuthUser {
  id: string;
  githubId: number;
  googleId: string | null;
  authProvider: AuthProvider;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AuthSession {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserResponse {
  sub: string;        // unique Google user ID
  name?: string;
  given_name?: string;
  email?: string;
  picture?: string;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

// ───── Constants ─────

const SESSION_DURATION_DAYS = 30;
const COOKIE_NAME = 'decklens_session';

// GitHub
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

// Google
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// ───── GitHub OAuth Flow ─────

/**
 * Redirect to GitHub OAuth authorization.
 */
export function handleGitHubRedirect(
  clientId: string,
  redirectUri: string,
  state?: string,
): Response {
  // Encode return URL in state if provided
  const stateValue = state || generateId();
  
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state: stateValue,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GITHUB_AUTHORIZE_URL}?${params.toString()}`,
    },
  });
}

/**
 * Handle GitHub OAuth callback — exchange code, create/update user, set session.
 */
export async function handleGitHubCallback(
  request: Request,
  clientId: string,
  clientSecret: string,
  db: D1Database,
  frontendUrl: string,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (error || !code) {
    return redirectWithError(frontendUrl, error || 'no_code');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = (await tokenResponse.json()) as GitHubTokenResponse;
    if (tokenData.error || !tokenData.access_token) {
      return redirectWithError(frontendUrl, tokenData.error_description || 'token_exchange_failed');
    }

    // Fetch GitHub user profile
    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json',
        'User-Agent': 'DeckLens/1.0',
      },
    });

    if (!userResponse.ok) {
      return redirectWithError(frontendUrl, 'github_user_fetch_failed');
    }

    const ghUser = (await userResponse.json()) as GitHubUserResponse;

    // Create or update user in D1
    const user = await upsertGitHubUser(db, {
      githubId: ghUser.id,
      username: ghUser.login,
      displayName: ghUser.name || ghUser.login,
      avatarUrl: ghUser.avatar_url || null,
    });

    return await createSessionAndRedirect(db, user.id, frontendUrl, state);
  } catch (err) {
    console.error('[Auth] GitHub callback error:', err);
    return redirectWithError(frontendUrl, 'internal_error');
  }
}

// ───── Google OAuth Flow ─────

/**
 * Redirect to Google OAuth authorization.
 */
export function handleGoogleRedirect(
  clientId: string,
  redirectUri: string,
  state?: string,
): Response {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    access_type: 'online',
    state: state || generateId(),
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`,
    },
  });
}

/**
 * Handle Google OAuth callback — exchange code, create/update user, set session.
 */
export async function handleGoogleCallback(
  request: Request,
  clientId: string,
  clientSecret: string,
  db: D1Database,
  frontendUrl: string,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (error || !code) {
    return redirectWithError(frontendUrl, error || 'no_code');
  }

  try {
    // Exchange code for access token
    const redirectUri = `${new URL(request.url).origin}/api/auth/google/callback`;
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    });

    const tokenData = (await tokenResponse.json()) as GoogleTokenResponse;
    if (tokenData.error || !tokenData.access_token) {
      return redirectWithError(frontendUrl, tokenData.error_description || 'google_token_exchange_failed');
    }

    // Fetch Google user profile
    const userResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      return redirectWithError(frontendUrl, 'google_user_fetch_failed');
    }

    const gUser = (await userResponse.json()) as GoogleUserResponse;

    if (!gUser.sub) {
      return redirectWithError(frontendUrl, 'google_no_user_id');
    }

    // Create or update user in D1
    const username = gUser.email
      ? gUser.email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
      : `google_${gUser.sub.slice(-8)}`;
    const displayName = gUser.name || gUser.given_name || username;

    const user = await upsertGoogleUser(db, {
      googleId: gUser.sub,
      username,
      displayName,
      avatarUrl: gUser.picture || null,
    });

    return await createSessionAndRedirect(db, user.id, frontendUrl, state);
  } catch (err) {
    console.error('[Auth] Google callback error:', err);
    return redirectWithError(frontendUrl, 'internal_error');
  }
}

// ───── Shared Handlers ─────

/**
 * GET /api/auth/me — Returns current user or null.
 */
export async function handleAuthMe(
  request: Request,
  db: D1Database,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const user = await authenticateRequest(request, db);

  if (!user) {
    return new Response(
      JSON.stringify({ ok: true, data: { user: null } }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Update last_seen_at
  try {
    await db
      .prepare('UPDATE users SET last_seen_at = datetime(\'now\') WHERE id = ?')
      .bind(user.id)
      .run();
  } catch {
    // Non-critical
  }

  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          authProvider: user.authProvider,
        },
      },
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}

/**
 * POST /api/auth/logout — Deletes the session and clears the cookie.
 */
export async function handleAuthLogout(
  request: Request,
  db: D1Database,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const token = extractSessionToken(request);

  if (token) {
    try {
      await db.prepare('DELETE FROM user_sessions WHERE token = ?').bind(token).run();
    } catch {
      // Non-critical
    }
  }

  return new Response(
    JSON.stringify({ ok: true }),
    {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`,
      },
    },
  );
}

// ───── Session Helpers ─────

/**
 * Extract session token from cookie or Authorization header.
 */
export function extractSessionToken(request: Request): string | null {
  // Try cookie first
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = parseCookies(cookieHeader);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];

  // Try Authorization header (for API clients)
  const authHeader = request.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  return null;
}

/**
 * Validate a session token and return the associated user.
 * Returns null if invalid/expired.
 */
export async function authenticateRequest(
  request: Request,
  db: D1Database,
): Promise<AuthUser | null> {
  const token = extractSessionToken(request);
  if (!token) return null;
  return validateToken(token, db);
}

/**
 * Validate a raw token string (used for collab join with auth).
 */
export async function validateToken(
  token: string,
  db: D1Database,
): Promise<AuthUser | null> {
  try {
    const row = await db
      .prepare(
        `SELECT u.id, u.github_id, u.google_id, u.auth_provider, u.username, u.display_name, u.avatar_url, u.created_at, u.last_seen_at
         FROM user_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = ? AND s.expires_at > datetime('now')`,
      )
      .bind(token)
      .first<{
        id: string;
        github_id: number;
        google_id: string | null;
        auth_provider: string;
        username: string;
        display_name: string;
        avatar_url: string | null;
        created_at: string;
        last_seen_at: string | null;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      githubId: row.github_id,
      googleId: row.google_id,
      authProvider: row.auth_provider as AuthProvider,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  } catch (err) {
    console.error('[Auth] Session validation error:', err);
    return null;
  }
}

// ───── User CRUD ─────

async function upsertGitHubUser(
  db: D1Database,
  data: {
    githubId: number;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  },
): Promise<AuthUser> {
  const id = generateId();

  try {
    await db
      .prepare(
        `INSERT INTO users (id, github_id, username, display_name, avatar_url, auth_provider, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'github', datetime('now'))
         ON CONFLICT(github_id) DO UPDATE SET
           username = excluded.username,
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           last_seen_at = datetime('now')`,
      )
      .bind(id, data.githubId, data.username, data.displayName, data.avatarUrl)
      .run();
  } catch (err) {
    console.error('[Auth] GitHub upsert error:', err);
    throw err;
  }

  // Fetch the user (might be existing or newly created)
  const row = await db
    .prepare('SELECT id, github_id, google_id, auth_provider, username, display_name, avatar_url, created_at, last_seen_at FROM users WHERE github_id = ?')
    .bind(data.githubId)
    .first<{
      id: string;
      github_id: number;
      google_id: string | null;
      auth_provider: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      created_at: string;
      last_seen_at: string | null;
    }>();

  if (!row) throw new Error('User not found after upsert');

  return {
    id: row.id,
    githubId: row.github_id,
    googleId: row.google_id,
    authProvider: row.auth_provider as AuthProvider,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function upsertGoogleUser(
  db: D1Database,
  data: {
    googleId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  },
): Promise<AuthUser> {
  const id = generateId();

  // For Google users: github_id gets a sentinel value of 0
  // and we use google_id as the unique identifier
  try {
    // First check if a user with this google_id already exists
    const existing = await db
      .prepare('SELECT id FROM users WHERE google_id = ?')
      .bind(data.googleId)
      .first<{ id: string }>();

    if (existing) {
      // Update existing Google user
      await db
        .prepare(
          `UPDATE users SET
             display_name = ?,
             avatar_url = ?,
             last_seen_at = datetime('now')
           WHERE google_id = ?`,
        )
        .bind(data.displayName, data.avatarUrl, data.googleId)
        .run();
    } else {
      // Ensure unique username for Google users
      let finalUsername = data.username;
      const usernameExists = await db
        .prepare('SELECT id FROM users WHERE username = ?')
        .bind(finalUsername)
        .first<{ id: string }>();

      if (usernameExists) {
        finalUsername = `${data.username}_${generateId().slice(0, 4)}`;
      }

      // Insert new Google user
      await db
        .prepare(
          `INSERT INTO users (id, github_id, google_id, username, display_name, avatar_url, auth_provider, last_seen_at)
           VALUES (?, 0, ?, ?, ?, ?, 'google', datetime('now'))`,
        )
        .bind(id, data.googleId, finalUsername, data.displayName, data.avatarUrl)
        .run();
    }
  } catch (err) {
    console.error('[Auth] Google upsert error:', err);
    throw err;
  }

  // Fetch the user
  const row = await db
    .prepare('SELECT id, github_id, google_id, auth_provider, username, display_name, avatar_url, created_at, last_seen_at FROM users WHERE google_id = ?')
    .bind(data.googleId)
    .first<{
      id: string;
      github_id: number;
      google_id: string | null;
      auth_provider: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      created_at: string;
      last_seen_at: string | null;
    }>();

  if (!row) throw new Error('User not found after Google upsert');

  return {
    id: row.id,
    githubId: row.github_id,
    googleId: row.google_id,
    authProvider: row.auth_provider as AuthProvider,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

// ───── Shared Session Logic ─────

async function createSessionAndRedirect(
  db: D1Database,
  userId: string,
  frontendUrl: string,
  state?: string | null,
): Promise<Response> {
  const session = await createSession(db, userId);
  const cookieExpires = new Date(session.expiresAt);
  const cookie = `${COOKIE_NAME}=${session.token}; Path=/; HttpOnly; SameSite=None; Secure; Expires=${cookieExpires.toUTCString()}`;

  // Determine return URL
  // State can be either a simple ID or contain a return URL encoded as: id|returnUrl
  let returnUrl = '/';
  
  if (state) {
    try {
      // Check if state contains a pipe separator for return URL
      const pipeIndex = state.indexOf('|');
      if (pipeIndex > 0) {
        returnUrl = state.substring(pipeIndex + 1);
        // Validate: must be a relative path starting with /
        if (!returnUrl.startsWith('/')) {
          returnUrl = '/';
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  // Pass token in URL so the frontend (different domain) can store it in localStorage
  // and use it via Authorization header for cross-domain API calls.
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': cookie,
      Location: `${frontendUrl}${returnUrl}?auth=success&token=${session.token}`,
    },
  });
}

async function createSession(db: D1Database, userId: string): Promise<AuthSession> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000);

  await db
    .prepare('INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, userId, expiresAt.toISOString())
    .run();

  // Clean up expired sessions for this user (max 5 active)
  try {
    await db
      .prepare(
        `DELETE FROM user_sessions
         WHERE user_id = ? AND (expires_at < datetime('now') OR token NOT IN (
           SELECT token FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
         ))`,
      )
      .bind(userId, userId)
      .run();
  } catch {
    // Non-critical cleanup
  }

  return {
    token,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function redirectWithError(frontendUrl: string, errorMsg: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${frontendUrl}/deck-editor.html?auth_error=${encodeURIComponent(errorMsg)}`,
    },
  });
}

// ───── Utility ─────

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 16; i++) {
    id += chars[arr[i] % chars.length];
  }
  return id;
}

function generateSessionToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...valueParts] = pair.trim().split('=');
    if (key) {
      cookies[key.trim()] = valueParts.join('=').trim();
    }
  }
  return cookies;
}
