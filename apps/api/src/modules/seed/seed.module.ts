import { Module } from '@nestjs/common';
import { SeedService } from './seed.service';
import { DbModule } from '../../db/db.module';

@Module({
  imports: [DbModule],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
