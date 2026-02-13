import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/db.module';
// import { cards } from '@mtg/db/schema';
// import { drizzle } from 'drizzle-orm/postgres-js';
// import { ilike, or, and, sql, desc, asc, eq, SQL } from 'drizzle-orm';

export interface SearchParams {
  q?: string;
  page: number;
  limit: number;
  sort?: 'name' | 'cmc' | 'release';
  dir?: 'asc' | 'desc';
}

@Injectable()
export class CardsService {
  constructor(
    @Inject(DB_CONNECTION) private db: any
  ) {}

  async search(params: SearchParams) {
    const { q, page = 1, limit = 50, sort = 'name', dir = 'asc' } = params;
    const offset = (page - 1) * limit;

    // Mock data for testing
    const mockCards = [
      {
        id: '1',
        name: 'Lightning Bolt',
        oracleText: 'Lightning Bolt deals 3 damage to any target.',
        typeLine: 'Instant',
        cmc: 1,
        set: 'LEA',
        setName: 'Limited Edition Alpha',
        colors: ['R'],
        imageUris: { 
          small: 'https://c1.scryfall.com/file/scryfall-cards/small/front/b/b/bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd.jpg?1562799766',
          normal: 'https://c1.scryfall.com/file/scryfall-cards/normal/front/b/b/bd8fa327-dd41-4737-8f19-2cf5eb1f7cdd.jpg?1562799766'
        },
        collectorNumber: '1',
        rarity: 'common'
      },
      {
        id: '2', 
        name: 'Dark Ritual',
        oracleText: 'Add three black mana.',
        typeLine: 'Instant',
        cmc: 1,
        set: 'LEA',
        setName: 'Limited Edition Alpha',
        colors: ['B'],
        imageUris: { 
          small: 'https://c1.scryfall.com/file/scryfall-cards/small/front/5/5/5c5c3a73-16f0-4e7e-9307-1dcd4bd73944.jpg?1562799773',
          normal: 'https://c1.scryfall.com/file/scryfall-cards/normal/front/5/5/5c5c3a73-16f0-4e7e-9307-1dcd4bd73944.jpg?1562799773'
        },
        collectorNumber: '2',
        rarity: 'common'
      },
      {
        id: '3',
        name: 'Ancestral Recall',
        oracleText: 'Target player draws three cards.',
        typeLine: 'Instant',
        cmc: 1,
        set: 'LEA',
        setName: 'Limited Edition Alpha', 
        colors: ['U'],
        imageUris: { 
          small: 'https://c1.scryfall.com/file/scryfall-cards/small/front/e/e/e10043d5-787f-4f01-bce0-c23f1a8f0368.jpg?1562799870',
          normal: 'https://c1.scryfall.com/file/scryfall-cards/normal/front/e/e/e10043d5-787f-4f01-bce0-c23f1a8f0368.jpg?1562799870'
        },
        collectorNumber: '3',
        rarity: 'rare'
      }
    ];

    let results = [...mockCards];

    // Filter by search query
    if (q) {
      const query = q.toLowerCase();
      results = results.filter(card => 
        card.name.toLowerCase().includes(query) ||
        (card.oracleText && card.oracleText.toLowerCase().includes(query)) ||
        (card.typeLine && card.typeLine.toLowerCase().includes(query))
      );
    }

    // Sort results
    results.sort((a, b) => {
      let aVal: any = a[sort] || '';
      let bVal: any = b[sort] || '';
      
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();

      if (dir === 'desc') {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      } else {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }
    });

    // Apply pagination
    const total = results.length;
    const paginatedResults = results.slice(offset, offset + limit);

    return {
      data: paginatedResults,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    };
  }

  async findById(id: string) {
    // Use mock database for now
    if ((this.db as any).cards) {
      return (this.db as any).cards.find((card: any) => card.id === id) || null;
    }

    // Fallback for real database
    try {
      return null; // Mock implementation
    } catch (error) {
       return null; 
    }
  }
}
