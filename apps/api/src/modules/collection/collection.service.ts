import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/db.module';
import { collections, cards } from '@mtg/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, sql, desc } from 'drizzle-orm';

@Injectable()
export class CollectionService {
  constructor(
    @Inject(DB_CONNECTION) private db: ReturnType<typeof drizzle>
  ) {}

  async getCollection(userId: string) {
    return this.db.select({
      collectionId: collections.id,
      quantity: collections.quantity,
      condition: collections.condition,
      isFoil: collections.isFoil,
      updatedAt: collections.updatedAt,
      card: {
        id: cards.id,
        name: cards.name,
        set: cards.set,
        collectorNumber: cards.collectorNumber,
        imageUris: cards.imageUris,
        prices: cards.prices,
      }
    })
    .from(collections)
    .innerJoin(cards, eq(collections.cardId, cards.id))
    .where(eq(collections.userId, userId))
    .orderBy(desc(collections.updatedAt));
  }

  async addCard(userId: string, cardId: string, quantity: number = 1, isFoil: boolean = false) {
    // Check if card exists in user's collection (same foil status)
    const existing = await this.db.select()
      .from(collections)
      .where(and(
        eq(collections.userId, userId),
        eq(collections.cardId, cardId),
        eq(collections.isFoil, isFoil)
      ))
      .limit(1);

    if (existing.length > 0) {
      // Update quantity
      await this.db.update(collections)
        .set({ 
            quantity: existing[0].quantity + quantity,
            updatedAt: new Date()
        })
        .where(eq(collections.id, existing[0].id));
      
      return { action: 'updated', id: existing[0].id };
    } else {
      // Insert new entry
      const result = await this.db.insert(collections)
        .values({
            userId,
            cardId,
            quantity,
            isFoil,
            condition: 'NM', // Default
        })
        .returning({ id: collections.id });
      
      return { action: 'created', id: result[0].id };
    }
  }

  async removeCard(userId: string, collectionId: string, quantityToRemove: number = 1) {
     const existing = await this.db.select()
      .from(collections)
      .where(and(
        eq(collections.id, collectionId),
        eq(collections.userId, userId)
      ))
      .limit(1);

    if (existing.length === 0) {
        throw new BadRequestException('Collection item not found');
    }

    const currentQty = existing[0].quantity;
    
    if (currentQty <= quantityToRemove) {
        // Remove entire entry
        await this.db.delete(collections)
          .where(eq(collections.id, collectionId));
        return { action: 'deleted' };
    } else {
        // Decrease quantity
        await this.db.update(collections)
          .set({
              quantity: currentQty - quantityToRemove,
              updatedAt: new Date()
          })
          .where(eq(collections.id, collectionId));
        return { action: 'decreased', newQuantity: currentQty - quantityToRemove };
    }
  }
}
