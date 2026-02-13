import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ScryfallModule } from './modules/scryfall/scryfall.module';
import { CardsModule } from './modules/cards/cards.module';
import { CollectionModule } from './modules/collection/collection.module';
import { DecksModule } from './modules/decks/decks.module';
import { SeedModule } from './modules/seed/seed.module';
import { ScanModule } from './modules/scan/scan.module';
import { DbModule } from './db/db.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DbModule,
    ScryfallModule,
    CardsModule,
    CollectionModule,
    DecksModule,
    SeedModule,
    ScanModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
