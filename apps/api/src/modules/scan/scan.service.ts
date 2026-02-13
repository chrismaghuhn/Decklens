import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/db.module';
import { cards } from '@mtg/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql, ilike, or } from 'drizzle-orm';
import * as Tesseract from 'tesseract.js';
import * as sharp from 'sharp';

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    @Inject(DB_CONNECTION) private db: ReturnType<typeof drizzle>
  ) {}

  async identify(base64Image: string) {
    if (!base64Image) {
        throw new BadRequestException('Image data is required');
    }

    try {
        const imageBuffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        
        // 1. Process Image: Resize & Crop to Title Area (Top 15%)
        const processedImage = await sharp(imageBuffer)
            .resize(800) // Standardize width
            .extract({ left: 0, top: 0, width: 800, height: 120 }) // Approximate title area
            .grayscale()
            .toBuffer();

        // 2. Run OCR
        this.logger.log('Running OCR on image...');
        const result = await Tesseract.recognize(
            processedImage,
            'eng',
            { logger: m => console.log(m) }
        );

        const text = result.data.text.trim().replace(/\n/g, " ");
        this.logger.log(`OCR Result: "${text}"`);

        if (!text || text.length < 3) {
             return { card: null, error: 'Could not read text', rawText: text };
        }

        // 3. Search DB
        // Simple fuzzy search first word + whole string
        const searchTerms = text.split(' ').filter(w => w.length > 2);
        
        if (searchTerms.length === 0) {
             return { card: null, error: 'No valid words found', rawText: text };
        }

        // Search for full phrase or individual strong words
        const query = this.db.select()
            .from(cards)
            .where(
                or(
                    ilike(cards.name, `%${text}%`), // Exact-ish match
                    ilike(cards.name, `${searchTerms[0]}%`) // Starts with first word
                )
            )
            .limit(5);
        
        const matches = await query;
        
        if (matches.length > 0) {
            // Rank matches (Levenshtein distance would be better here, but simple for now)
            const bestMatch = matches[0]; 
            return { card: bestMatch, confidence: 0.8, rawText: text, candidates: matches };
        }

        return { card: null, rawText: text };

    } catch (error) {
        this.logger.error(`Scan failed: ${error}`);
        throw new BadRequestException('Failed to process image');
    }
  }
}
