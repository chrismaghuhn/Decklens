import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Users Table
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  username: text('username').unique(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Cards Table (Scryfall Cache)
// Using jsonb for complex Scryfall data to keep schema flexible
export const cards = pgTable('cards', {
  id: uuid('id').primaryKey(), // Scryfall UUID
  oracleId: uuid('oracle_id').notNull(),
  name: text('name').notNull(),
  lang: text('lang').notNull(),
  uri: text('uri').notNull(),
  scryfallUri: text('scryfall_uri').notNull(),
  layout: text('layout').notNull(),
  imageUris: jsonb('image_uris'), // { small, normal, large, png, art_crop, border_crop }
  manaCost: text('mana_cost'),
  cmc: integer('cmc'),
  typeLine: text('type_line'),
  oracleText: text('oracle_text'),
  colors: jsonb('colors'), // ["W", "U"]
  colorIdentity: jsonb('color_identity'),
  keywords: jsonb('keywords'),
  legalities: jsonb('legalities'),
  set: text('set').notNull(),
  setName: text('set_name').notNull(),
  collectorNumber: text('collector_number').notNull(),
  rarity: text('rarity').notNull(),
  prices: jsonb('prices'), // { usd, eur, tix }
  relatedUris: jsonb('related_uris'),
  purchaseUris: jsonb('purchase_uris'),
  // Full-text search vector (generated column in Postgres, but defined here for querying)
  // searchable: tsvector('searchable') -- Drizzle doesn't fully support generated tsvector columns in schema definition yet, managed via raw SQL migration
}, (table) => {
  return {
    nameIdx: index('name_idx').on(table.name),
    setIdx: index('set_idx').on(table.set),
  };
});

// Collections Table
export const collections = pgTable('collections', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  cardId: uuid('card_id').references(() => cards.id).notNull(),
  quantity: integer('quantity').default(1).notNull(),
  isFoil: boolean('is_foil').default(false).notNull(),
  condition: text('condition').default('NM').notNull(), // NM, LP, MP, HP, DMG
  language: text('language').default('en').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => {
  return {
    userIdIdx: index('collection_user_idx').on(table.userId),
    cardIdIdx: index('collection_card_idx').on(table.cardId),
  };
});

// Decks Table
export const decks = pgTable('decks', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  format: text('format').notNull(), // standard, commander, modern, etc.
  isPublic: boolean('is_public').default(false).notNull(),
  coverCardId: uuid('cover_card_id').references(() => cards.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Deck Cards (Join Table)
export const deckCards = pgTable('deck_cards', {
  id: uuid('id').defaultRandom().primaryKey(),
  deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'cascade' }).notNull(),
  cardId: uuid('card_id').references(() => cards.id).notNull(),
  quantity: integer('quantity').default(1).notNull(),
  section: text('section').default('mainboard').notNull(), // mainboard, sideboard, commander, maybeboard
  isFoil: boolean('is_foil').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => {
  return {
    deckIdIdx: index('deck_cards_deck_idx').on(table.deckId),
  };
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  collections: many(collections),
  decks: many(decks),
}));

export const collectionsRelations = relations(collections, ({ one }) => ({
  user: one(users, {
    fields: [collections.userId],
    references: [users.id],
  }),
  card: one(cards, {
    fields: [collections.cardId],
    references: [cards.id],
  }),
}));

export const decksRelations = relations(decks, ({ one, many }) => ({
  user: one(users, {
    fields: [decks.userId],
    references: [users.id],
  }),
  cards: many(deckCards),
  coverCard: one(cards, {
    fields: [decks.coverCardId],
    references: [cards.id],
  }),
}));

export const deckCardsRelations = relations(deckCards, ({ one }) => ({
  deck: one(decks, {
    fields: [deckCards.deckId],
    references: [decks.id],
  }),
  card: one(cards, {
    fields: [deckCards.cardId],
    references: [cards.id],
  }),
}));
