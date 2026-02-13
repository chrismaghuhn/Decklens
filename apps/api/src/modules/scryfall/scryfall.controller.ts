import { Controller, Post } from '@nestjs/common';
import { ScryfallService } from './scryfall.service';

@Controller('scryfall')
export class ScryfallController {
  constructor(private readonly scryfallService: ScryfallService) {}

  @Post('sync')
  async syncCards() {
    // Fire and forget - return immediately
    this.scryfallService.syncCards();
    return { message: 'Sync started' };
  }
}
