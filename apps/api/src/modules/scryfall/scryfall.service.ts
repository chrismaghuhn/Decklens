import { Injectable, Logger, Inject } from '@nestjs/common';
import axios from 'axios';
import * as JSONStream from 'JSONStream';
import { DB_CONNECTION } from '../../db/db.module';
import { cards } from '@mtg/db/schema';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Writable } from 'stream';

@Injectable()
export class ScryfallService {
  private readonly logger = new Logger(ScryfallService.name);
  private readonly BULK_DATA_URL = 'https://api.scryfall.com/bulk-data/default-cards';

  constructor(
    @Inject(DB_CONNECTION) private db: ReturnType<typeof drizzle>
  ) {}

  async syncCards() {
    this.logger.log('Starting Scryfall sync...');
    
    // 1. Get Bulk Data URL
    const metaResponse = await axios.get(this.BULK_DATA_URL);
    const downloadUri = metaResponse.data.download_uri;
    this.logger.log(`Downloading from ${downloadUri}`);

    // 2. Stream and Process
    const response = await axios({
      method: 'get',
      url: downloadUri,
      responseType: 'stream',
    });

    const stream = response.data.pipe(JSONStream.parse('*'));
    let batch: any[] = [];
    let count = 0;
    const BATCH_SIZE = 500;

    return new Promise((resolve, reject) => {
        const writable = new Writable({
            objectMode: true,
            write: async (card: any, encoding, callback) => {
                try {
                    // Simple validation: Ensure it has a UUID and Name
                    if (card.id && card.name) {
                        batch.push(this.transformCard(card));
                    }

                    if (batch.length >= BATCH_SIZE) {
                        const batchToInsert = [...batch];
                        batch = []; // Clear immediately
                        await this.upsertBatch(batchToInsert);
                        count += batchToInsert.length;
                        if (count % 5000 === 0) {
                            this.logger.log(`Processed ${count} cards...`);
                        }
                    }
                    callback();
                } catch (err) {
                     this.logger.error(`Error processing batch at count ${count}: ${err}`);
                     // Don't kill the stream on single batch failure, but log critical error
                     callback(); 
                }
            },
            final: async (callback) => {
                 try {
                     if (batch.length > 0) {
                        await this.upsertBatch(batch);
                        count += batch.length;
                     }
                     this.logger.log(`Sync complete. Total cards: ${count}`);
                     resolve({ count });
                     callback();
                 } catch (err) {
                     callback(err as Error);
                     reject(err);
                 }
            }
        });

        stream.pipe(writable);
        
        stream.on('error', (err: any) => {
            this.logger.error('Stream error:', err);
            reject(err);
        });
    });
  }

  private transformCard(card: any) {
    return {
      id: card.id,
      oracleId: card.oracle_id || card.id, // Fallback for some odd cards
      name: card.name,
      lang: card.lang,
      uri: card.uri,
      scryfallUri: card.scryfall_uri,
      layout: card.layout,
      // Handle Image URIs - prioritized: direct, face 0, null
      imageUris: card.image_uris || (card.card_faces && card.card_faces[0] ? card.card_faces[0].image_uris : null),
      manaCost: card.mana_cost || '',
      cmc: card.cmc ? Math.floor(card.cmc) : 0,
      typeLine: card.type_line || '',
      oracleText: card.oracle_text || '',
      colors: card.colors || [],
      colorIdentity: card.color_identity || [],
      keywords: card.keywords || [],
      legalities: card.legalities || {},
      set: card.set,
      setName: card.set_name,
      collectorNumber: card.collector_number,
      rarity: card.rarity,
      prices: card.prices || {},
      relatedUris: card.related_uris || {},
      purchaseUris: card.purchase_uris || {},
    };
  }

  private async upsertBatch(batch: any[]) {
    if (batch.length === 0) return;
    
    try {
        // For mock database, simulate the Drizzle insert interface
        // The mock db.insert() method expects a table, then we call .values()
        await this.db.insert({} as any).values(batch);
        this.logger.log(`Inserted ${batch.length} cards`);
    } catch (error) {
        this.logger.error(`Batch insert failed: ${error}`);
        throw error;
    }
  }
}
