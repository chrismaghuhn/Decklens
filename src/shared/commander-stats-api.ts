/**
 * Commander Stats API Client
 */

import type { CommanderStatsResponse, TopCommandersResponse } from './commander-stats-types.js';

const API_BASE = import.meta.env.VITE_API_URL || 'https://decklens-api.chrisgarkisch.workers.dev';

/**
 * Fetch stats for a specific commander
 */
export async function fetchCommanderStats(commanderName: string): Promise<CommanderStatsResponse> {
  try {
    const encodedName = encodeURIComponent(commanderName);
    const response = await fetch(`${API_BASE}/api/commander-stats/${encodedName}`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // Transform snake_case to camelCase
    if (data.ok && data.stats) {
      return {
        ok: true,
        stats: {
          commanderName: data.stats.commander_name,
          winRate: data.stats.win_rate,
          metaPercentage: data.stats.meta_percentage,
          totalDecks: data.stats.total_decks,
          avgPowerLevel: data.stats.avg_power_level,
          avgDeckPrice: data.stats.avg_deck_price,
          avgGamesPlayed: data.stats.avg_games_played,
          popularityRank: data.stats.popularity_rank,
          lastUpdated: data.stats.last_updated,
        },
      };
    }

    return data;
  } catch (err) {
    console.error('[Commander Stats] Error fetching stats:', err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Fetch top N commanders
 */
export async function fetchTopCommanders(limit: number = 100): Promise<TopCommandersResponse> {
  try {
    const response = await fetch(`${API_BASE}/api/commander-stats/top?limit=${limit}`, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    // Transform snake_case to camelCase
    if (data.ok && data.commanders) {
      return {
        ok: true,
        commanders: data.commanders.map((c: any) => ({
          commanderName: c.commander_name,
          winRate: c.win_rate,
          metaPercentage: c.meta_percentage,
          totalDecks: c.total_decks,
          avgPowerLevel: c.avg_power_level,
          avgDeckPrice: c.avg_deck_price,
          avgGamesPlayed: c.avg_games_played,
          popularityRank: c.popularity_rank,
          lastUpdated: c.last_updated,
        })),
      };
    }

    return data;
  } catch (err) {
    console.error('[Commander Stats] Error fetching top commanders:', err);
    return { ok: false, error: String(err) };
  }
}
