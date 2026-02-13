import { Controller, Get, Post, Body, Param, Delete, BadRequestException } from '@nestjs/common';
import { DecksService } from './decks.service';
import { z } from 'zod';

const CreateDeckSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().min(1),
  format: z.string().optional(),
});

const AddCardSchema = z.object({
  cardId: z.string().uuid(),
  quantity: z.number().positive().default(1),
  section: z.string().default('mainboard'),
});

@Controller('decks')
export class DecksController {
  constructor(private readonly decksService: DecksService) {}

  @Post()
  async createDeck(@Body() body: unknown) {
    const result = CreateDeckSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.decksService.createDeck(result.data.userId, result.data.name, result.data.format);
  }

  @Get(':id')
  async getDeck(@Param('id') id: string) {
    return this.decksService.getDeck(id);
  }

  @Post(':id/cards')
  async addCard(@Param('id') deckId: string, @Body() body: unknown) {
    const result = AddCardSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.decksService.addCard(deckId, result.data.cardId, result.data.quantity, result.data.section);
  }

  @Delete(':id/cards/:cardId')
  async removeCard(@Param('id') deckId: string, @Param('cardId') cardId: string, @Body('section') section: string) {
    // Note: In real app, section should probably be query param or body
    return this.decksService.removeCard(deckId, cardId, section || 'mainboard');
  }
}
