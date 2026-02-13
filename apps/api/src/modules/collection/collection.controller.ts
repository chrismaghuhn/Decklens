import { Controller, Get, Post, Delete, Body, Query, Param } from '@nestjs/common';
import { CollectionService } from './collection.service';
import { z } from 'zod';

const AddCardSchema = z.object({
  userId: z.string().uuid(),
  cardId: z.string().uuid(),
  quantity: z.number().int().positive().default(1),
  isFoil: z.boolean().default(false),
});

const RemoveCardSchema = z.object({
  userId: z.string().uuid(),
  collectionId: z.string().uuid(),
  quantity: z.number().int().positive().default(1),
});

@Controller('collection')
export class CollectionController {
  constructor(private readonly collectionService: CollectionService) {}

  @Get(':userId')
  async getCollection(@Param('userId') userId: string) {
    return this.collectionService.getCollection(userId);
  }

  @Post('add')
  async addCard(@Body() body: unknown) {
    const result = AddCardSchema.safeParse(body);
    if (!result.success) {
      throw new Error(JSON.stringify(result.error.flatten()));
    }
    const { userId, cardId, quantity, isFoil } = result.data;
    return this.collectionService.addCard(userId, cardId, quantity, isFoil);
  }

  @Delete('remove')
  async removeCard(@Body() body: unknown) {
    const result = RemoveCardSchema.safeParse(body);
    if (!result.success) {
       throw new Error(JSON.stringify(result.error.flatten()));
    }
    const { userId, collectionId, quantity } = result.data;
    return this.collectionService.removeCard(userId, collectionId, quantity);
  }
}
