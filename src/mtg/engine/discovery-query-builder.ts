/**
 * Query Builder for contextual card discovery
 * Generates Scryfall queries based on deck profile and needs
 */

import type { ScryfallSearchParams } from './scryfall-client.js';

export type DiscoveryRole = 
  | 'ramp'
  | 'draw'
  | 'removal'
  | 'interaction'
  | 'protection'
  | 'finisher'
  | 'mana_fix'
  | 'tutor'
  | 'board_wipe'
  | 'graveyard_hate'
  | 'artifact_hate'
  | 'combo_piece';

export type DiscoveryArchetype =
  | 'aggro'
  | 'control'
  | 'combo'
  | 'midrange'
  | 'ramp'
  | 'tempo'
  | 'reanimator'
  | 'storm'
  | 'tribal'
  | 'artifact'
  | 'graveyard';

export interface DeckProfile {
  colors: Set<string>;
  avgCmc: number;
  roleCounts: Record<DiscoveryRole, number>;
  dominantArchetype: DiscoveryArchetype;
  commanderKeywords: Set<string>;
  format: string;
}

export interface CardDiscoveryQuery {
  role: DiscoveryRole;
  params: ScryfallSearchParams;
  priority: number;
  reason: string;
}

export interface QueryBuilderConfig {
  maxResultsPerQuery?: number;
  preferBudget?: boolean;
  excludeGoldBorders?: boolean;
  maxCmc?: number;
}

const ROLE_TARGETS: Record<DiscoveryRole, number> = {
  ramp: 10,
  draw: 10,
  removal: 8,
  interaction: 8,
  protection: 4,
  finisher: 3,
  mana_fix: 8,
  tutor: 4,
  board_wipe: 3,
  graveyard_hate: 2,
  artifact_hate: 2,
  combo_piece: 6,
};

const ROLE_ORACLE_PATTERNS: Record<DiscoveryRole, string[]> = {
  ramp: ['add {', 'search your library for a land', 'mana of any color'],
  draw: ['draw ', 'draw a card', 'draw two cards', 'draw X cards'],
  removal: ['destroy target', 'exile target', 'sacrifice', 'damage to target'],
  interaction: ['counter target', 'prevent', 'hexproof', 'shroud'],
  protection: ['indestructible', 'protection from', 'hexproof until', 'phase out'],
  finisher: ['you win the game', 'combat damage', 'extra turn', 'game'],
  mana_fix: ['mana of any color', 'add one mana of any color', 'commander'],
  tutor: ['search your library', 'tutor'],
  board_wipe: ['destroy all', 'exile all', 'sacrifice all', 'each player sacrifices'],
  graveyard_hate: ['exile from graveyard', 'graveyard', 'from a graveyard'],
  artifact_hate: ['destroy target artifact', 'exile target artifact', 'artifacts'],
  combo_piece: ['infinite', 'untap', 'copy', 'storm', 'paradox'],
};

const ARCHETYPE_QUERIES: Record<DiscoveryArchetype, Partial<ScryfallSearchParams>[]> = {
  aggro: [
    { q: 'type:creature cmc<=2' },
    { q: 'oracle:"haste"' },
    { q: 'oracle:"whenever ~ attacks"' },
  ],
  control: [
    { q: 'type:instant type:sorcery oracle:"counter target"' },
    { q: 'oracle:"destroy all" or oracle:"exile all"' },
    { q: 'oracle:"draw" cmc<=4' },
  ],
  combo: [
    { q: 'oracle:"search your library" cmc<=3' },
    { q: 'oracle:"infinite" or oracle:"untap"' },
    { q: 'oracle:"copy" type:instant type:sorcery' },
  ],
  midrange: [
    { q: 'type:creature cmc>=3 cmc<=5' },
    { q: 'oracle:"value" or oracle:"card advantage"' },
  ],
  ramp: [
    { q: 'oracle:"search your library for a land"' },
    { q: 'oracle:"add {" cmc<=3' },
  ],
  tempo: [
    { q: 'type:creature cmc<=3 oracle:"flash"' },
    { q: 'oracle:"return target" cmc<=3' },
  ],
  reanimator: [
    { q: 'oracle:"return" oracle:"graveyard"' },
    { q: 'oracle:"discard" oracle:"draw"' },
    { q: 'type:creature power>=5 cmc>=5' },
  ],
  storm: [
    { q: 'oracle:"storm"' },
    { q: 'oracle:"copy" oracle:"spell"' },
    { q: 'oracle:"ritual" or oracle:"add {' },
  ],
  tribal: [
    { q: 'oracle:"changeling" or oracle:"tribal"' },
    { q: 'type:creature oracle:"lord"' },
  ],
  artifact: [
    { q: 'type:artifact' },
    { q: 'oracle:"artifact" oracle:"sacrifice"' },
  ],
  graveyard: [
    { q: 'oracle:"graveyard"' },
    { q: 'oracle:"delve" or oracle:"escape" or oracle:"unearth"' },
  ],
};

export class DiscoveryQueryBuilder {
  private config: Required<QueryBuilderConfig>;

  constructor(config: QueryBuilderConfig = {}) {
    this.config = {
      maxResultsPerQuery: 25,
      preferBudget: false,
      excludeGoldBorders: true,
      maxCmc: 15,
      ...config,
    };
  }

  /**
   * Build all discovery queries for a deck profile
   */
  buildQueries(profile: DeckProfile): CardDiscoveryQuery[] {
    const queries: CardDiscoveryQuery[] = [];

    // Role-based queries for deficits
    queries.push(...this.buildRoleDeficitQueries(profile));

    // Archetype-specific queries
    queries.push(...this.buildArchetypeQueries(profile));

    // Color-fixing queries if needed
    queries.push(...this.buildManaFixingQueries(profile));

    // Sort by priority
    return queries.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Build queries for roles the deck is lacking
   */
  private buildRoleDeficitQueries(profile: DeckProfile): CardDiscoveryQuery[] {
    const queries: CardDiscoveryQuery[] = [];

    for (const [role, current] of Object.entries(profile.roleCounts)) {
      const target = ROLE_TARGETS[role as DiscoveryRole];
      const deficit = target - current;

      if (deficit > 2) {
        const query = this.buildRoleQuery(
          role as DiscoveryRole,
          profile.colors,
          deficit
        );
        if (query) {
          queries.push(query);
        }
      }
    }

    return queries;
  }

  /**
   * Build a query for a specific role
   */
  private buildRoleQuery(
    role: DiscoveryRole,
    colors: Set<string>,
    deficit: number
  ): CardDiscoveryQuery | null {
    const patterns = ROLE_ORACLE_PATTERNS[role];
    if (!patterns || patterns.length === 0) return null;

    const colorQuery = this.buildColorQuery(colors);
    const oracleQuery = patterns.map(p => `oracle:"${p}"`).join(' or ');
    
    let query = `(${oracleQuery})`;
    if (colorQuery) {
      query += ` ${colorQuery}`;
    }

    // Exclude illegal cards
    query += ' -is:illegal -is:gold';

    // Prefer lower CMC for ramp/draw
    if (role === 'ramp' || role === 'draw') {
      query += ' cmc<=4';
    }

    const params: ScryfallSearchParams = {
      q: query,
      order: 'edhrec',
      unique: 'cards',
    };

    return {
      role,
      params,
      priority: deficit * 10,
      reason: `Deck needs ${role} (deficit: ${deficit})`,
    };
  }

  /**
   * Build archetype-specific queries
   */
  private buildArchetypeQueries(profile: DeckProfile): CardDiscoveryQuery[] {
    const queries: CardDiscoveryQuery[] = [];
    const archetypeParams = ARCHETYPE_QUERIES[profile.dominantArchetype];

    if (!archetypeParams) return queries;

    const colorQuery = this.buildColorQuery(profile.colors);

    for (const params of archetypeParams.slice(0, 3)) {
      let query = params.q || '';
      
      if (colorQuery) {
        query += ` ${colorQuery}`;
      }

      query += ' -is:illegal -is:gold';

      queries.push({
        role: 'combo_piece',
        params: {
          ...params,
          q: query,
          order: 'edhrec',
          unique: 'cards',
        },
        priority: 20,
        reason: `${profile.dominantArchetype} archetype support`,
      });
    }

    return queries;
  }

  /**
   * Build mana fixing queries for multi-color decks
   */
  private buildManaFixingQueries(profile: DeckProfile): CardDiscoveryQuery[] {
    if (profile.colors.size < 2) return [];

    const colorQuery = this.buildColorQuery(profile.colors);
    
    const query = `(
      oracle:"add one mana of any color" or
      oracle:"commander" oracle:"command zone" or
      oracle:"search your library for a basic land"
    ) ${colorQuery} -is:illegal -is:gold`;

    return [{
      role: 'mana_fix',
      params: {
        q: query,
        order: 'edhrec',
        unique: 'cards',
      },
      priority: profile.colors.size >= 3 ? 25 : 15,
      reason: 'Multi-color deck needs mana fixing',
    }];
  }

  /**
   * Build color identity query
   */
  private buildColorQuery(colors: Set<string>): string {
    if (colors.size === 0) return '';
    if (colors.size === 5) return '';

    const colorList = Array.from(colors).join('');
    return `id<=${colorList}`;
  }

  /**
   * Build a specific query by combining multiple constraints
   */
  buildSpecificQuery(options: {
    colors?: Set<string>;
    roles?: DiscoveryRole[];
    cmcMax?: number;
    cmcMin?: number;
    types?: string[];
    exclude?: string[];
    orderBy?: ScryfallSearchParams['order'];
  }): ScryfallSearchParams {
    const parts: string[] = [];

    // Color identity
    if (options.colors && options.colors.size > 0 && options.colors.size < 5) {
      parts.push(this.buildColorQuery(options.colors));
    }

    // Roles / Oracle patterns
    if (options.roles && options.roles.length > 0) {
      const patterns = options.roles
        .flatMap(role => ROLE_ORACLE_PATTERNS[role] || [])
        .map(p => `oracle:"${p}"`)
        .join(' or ');
      if (patterns) {
        parts.push(`(${patterns})`);
      }
    }

    // Card types
    if (options.types && options.types.length > 0) {
      const typeQuery = options.types.map(t => `type:${t}`).join(' or ');
      parts.push(`(${typeQuery})`);
    }

    // CMC constraints
    if (options.cmcMax !== undefined) {
      parts.push(`cmc<=${options.cmcMax}`);
    }
    if (options.cmcMin !== undefined) {
      parts.push(`cmc>=${options.cmcMin}`);
    }

    // Exclusions
    parts.push('-is:illegal');
    if (this.config.excludeGoldBorders) {
      parts.push('-is:gold');
    }
    if (options.exclude) {
      for (const exclusion of options.exclude) {
        parts.push(`-name:"${exclusion}"`);
      }
    }

    return {
      q: parts.join(' '),
      order: options.orderBy || 'edhrec',
      unique: 'cards',
    };
  }
}

// Convenience function
export function buildDiscoveryQueries(
  profile: DeckProfile,
  config?: QueryBuilderConfig
): CardDiscoveryQuery[] {
  const builder = new DiscoveryQueryBuilder(config);
  return builder.buildQueries(profile);
}
