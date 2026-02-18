/**
 * Commander Stats Types
 * Shared between frontend and backend
 */

export interface CommanderStatsData {
  commanderName: string;
  winRate: number;           // 0-100%
  metaPercentage: number;    // 0-100%
  totalDecks: number;
  avgPowerLevel: number;     // 1-10
  avgDeckPrice: number;      // EUR
  avgGamesPlayed: number;
  popularityRank: number;    // 1 = most popular
  lastUpdated: number;       // Unix timestamp
}

export interface CommanderStatsResponse {
  ok: boolean;
  stats?: CommanderStatsData;
  error?: string;
}

export interface TopCommandersResponse {
  ok: boolean;
  commanders?: CommanderStatsData[];
  error?: string;
}
