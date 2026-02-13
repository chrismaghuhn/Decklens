import { Module } from '@nestjs/common';
import { ScryfallService } from './scryfall.service';
import { ScryfallController } from './scryfall.controller';
import { DbModule } from '../../db/db.module';

@Module({
  imports: [DbModule],
  controllers: [ScryfallController],
  providers: [ScryfallService],
  exports: [ScryfallService],
})
export class ScryfallModule {}
