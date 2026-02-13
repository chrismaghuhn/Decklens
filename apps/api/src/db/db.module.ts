import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DB_CONNECTION = 'DB_CONNECTION';

// Mock database for development - simple in-memory storage with sample data
class MockDatabase {
  private users: any[] = [];
  private cards: any[] = [
    {
      id: '1',
      name: 'Lightning Bolt',
      oracleText: 'Lightning Bolt deals 3 damage to any target.',
      typeLine: 'Instant',
      cmc: 1,
      set: 'LEA',
      setName: 'Limited Edition Alpha',
      colors: ['R'],
      imageUris: { small: 'https://c1.scryfall.com/file/scryfall-cards/small/front/1/1/1.jpg' }
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
      imageUris: { small: 'https://c1.scryfall.com/file/scryfall-cards/small/front/2/2/2.jpg' }
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
      imageUris: { small: 'https://c1.scryfall.com/file/scryfall-cards/small/front/3/3/3.jpg' }
    }
  ];
  private collections: any[] = [];
  private decks: any[] = [];
  private deckCards: any[] = [];

  select(columns?: any) {
    return {
      from: (table: any) => ({
        where: (condition?: any) => ({
          limit: (limit: number) => ({
            offset: (offset: number) => ({
              orderBy: (orderBy: any) => this._executeQuery(table, condition, limit, offset, orderBy)
            })
          })
        })
      })
    };
  }

  private _executeQuery(table: any, condition: any, limit: number, offset: number, orderBy: any) {
    let results = [...this.cards]; // For now, always return cards

    // Simple filter for search
    if (condition && typeof condition === 'function') {
      // This is a mock - in real implementation would parse the condition
      results = results.slice();
    }

    // Apply limit and offset
    const startIndex = offset || 0;
    const endIndex = startIndex + (limit || results.length);
    const paginatedResults = results.slice(startIndex, endIndex);

    // Return as Promise to match async interface
    return Promise.resolve(paginatedResults);
  }

  selectWithCount(sql: any) {
    return {
      from: (table: any) => ({
        where: (condition?: any) => Promise.resolve([{ count: this.cards.length }])
      })
    };
  }

  insert(table: any) {
    // Return object with values() method to match Drizzle interface
    return {
      values: (values: any) => {
        const newRecord = Array.isArray(values) ? values : [values];
        console.log(`Mock inserting ${newRecord.length} records`);
        return newRecord;
      }
    };
  }

  async query(sql: string, params?: any[]) {
    // Handle count queries
    if (sql && sql.toString().includes('count')) {
      return [{ count: this.cards.length }];
    }
    return [];
  }
}

@Module({
  providers: [
    {
      provide: DB_CONNECTION,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const connectionString = configService.get<string>('DATABASE_URL');
        // For now, use mock database even if DATABASE_URL is provided
        // In production, you would use real PostgreSQL connection here
        console.log('🔧 Using mock database for development');
        return new MockDatabase();
      },
    },
  ],
  exports: [DB_CONNECTION],
})
export class DbModule {}
