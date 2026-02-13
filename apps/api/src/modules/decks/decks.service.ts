import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/db.module';
import { decks, deckCards, cards } from '@mtg/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';

@Injectable()
export class DecksService {
  constructor(
    @Inject(DB_CONNECTION) private db: ReturnType<typeof drizzle>
  ) {}

  async createDeck(userId: string, name: string, format: string = 'commander') {
    const result = await this.db.insert(decks).values({
      userId,
      name,
      format,
      isPublic: false,
    }).returning();
    return result[0];
  }

  async getDeck(id: string) {
    // 1. Fetch Deck
    const deckResult = await this.db.select().from(decks).where(eq(decks.id, id)).limit(1);
    if (!deckResult.length) throw new NotFoundException('Deck not found');
    const deck = deckResult[0];

    // 2. Fetch Cards
    const cardsResult = await this.db.select({
      deckCardId: deckCards.id,
      quantity: deckCards.quantity,
      section: deckCards.section,
      isFoil: deckCards.isFoil,
      card: cards, // Select all card fields
    })
    .from(deckCards)
    .innerJoin(cards, eq(deckCards.cardId, cards.id))
    .where(eq(deckCards.deckId, id));

    // 3. Transform to DeckbuilderDeck format
    const boards = {
      commander: [],
      mainboard: [],
      sideboard: [],
      maybeboard: [],
    };

    const resolvedCards = {};

    for (const row of cardsResult) {
      const entry = {
        name: row.card.name,
        qty: row.quantity,
        set: row.card.set,
        collectorNumber: row.card.collectorNumber,
        tags: [], // Tags not yet implemented in DB per card-deck link
      };

      if (boards[row.section]) {
        boards[row.section].push(entry);
      }

      // Populate resolver map for frontend analytics
      const key = row.card.name.trim().toLowerCase().replace(/\s+/g, ' ');
      if (!resolvedCards[key]) {
        resolvedCards[key] = {
          name: row.card.name,
          cmc: row.card.cmc,
          type_line: row.card.typeLine,
          oracle_text: row.card.oracleText,
          // Power/Toughness not yet in DB schema
          // power: row.card.power, 
          // toughness: row.card.toughness,
          color_identity: row.card.colorIdentity,
          image_uris: row.card.imageUris,
          prices: row.card.prices,
        };
      }
    }

    return {
      deck: {
        id: deck.id,
        name: deck.name,
        description: deck.description,
        visibility: deck.isPublic ? 'public' : 'private',
        createdAt: deck.createdAt.toISOString(),
        updatedAt: deck.updatedAt.toISOString(),
        boards,
      },
      resolvedCards, // Return this so frontend doesn't need to re-fetch
    };
  }

  async addCard(deckId: string, cardId: string, quantity: number, section: string = 'mainboard') {
    // Check if card exists in deck
    const existing = await this.db.select()
      .from(deckCards)
      .where(and(
        eq(deckCards.deckId, deckId),
        eq(deckCards.cardId, cardId),
        eq(deckCards.section, section)
      ))
      .limit(1);

    if (existing.length > 0) {
      await this.db.update(deckCards)
        .set({ quantity: existing[0].quantity + quantity })
        .where(eq(deckCards.id, existing[0].id));
    } else {
      await this.db.insert(deckCards).values({
        deckId,
        cardId,
        quantity,
        section,
      });
    }
    
    // Update deck timestamp
    await this.db.update(decks).set({ updatedAt: new Date() }).where(eq(decks.id, deckId));
    
    return { success: true };
  }

  async removeCard(deckId: string, cardId: string, section: string) {
     await this.db.delete(deckCards)
       .where(and(
         eq(deckCards.deckId, deckId),
         eq(deckCards.cardId, cardId),
         eq(deckCards.section, section)
       ));
     return { success: true };
  }
}
