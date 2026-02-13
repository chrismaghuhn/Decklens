import { Injectable, Inject, OnApplicationBootstrap } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/db.module';
import { users } from '@mtg/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB_CONNECTION) private db: ReturnType<typeof drizzle>
  ) {}

  async onApplicationBootstrap() {
    await this.seedUser();
  }

  async seedUser() {
    try {
        const result = await this.db.select().from(users).where(eq(users.username, 'testuser'));
        if (result.length === 0) {
            console.log('Seeding test user...');
            await this.db.insert(users).values({
                id: '11111111-1111-1111-1111-111111111111',
                email: 'test@example.com',
                username: 'testuser',
                passwordHash: 'hashedpassword',
            });
            console.log('Test user created: 11111111-1111-1111-1111-111111111111');
        }
    } catch (e) {
        console.error("Seeding failed", e);
    }
  }
}
