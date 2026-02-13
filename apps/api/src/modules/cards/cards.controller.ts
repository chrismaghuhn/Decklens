import { Controller, Get, Query, Param, ParseIntPipe, BadRequestException } from '@nestjs/common';
import { CardsService, SearchParams } from './cards.service';
import { z } from 'zod';

const SearchQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  sort: z.enum(['name', 'cmc', 'release']).optional().default('name'),
  dir: z.enum(['asc', 'desc']).optional().default('asc'),
});

@Controller('cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  async search(@Query() query: unknown) {
    const result = SearchQuerySchema.safeParse(query);
    if (!result.success) {
      throw new BadRequestException(result.error.flatten());
    }
    
    return this.cardsService.search(result.data as SearchParams);
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.cardsService.findById(id);
  }
}
