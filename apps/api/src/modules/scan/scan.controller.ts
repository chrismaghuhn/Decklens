import { Controller, Post, Body } from '@nestjs/common';
import { ScanService } from './scan.service';
import { z } from 'zod';

const ScanRequestSchema = z.object({
  image: z.string().min(1),
});

@Controller('scan')
export class ScanController {
  constructor(private readonly scanService: ScanService) {}

  @Post('identify')
  async identify(@Body() body: unknown) {
    const result = ScanRequestSchema.safeParse(body);
    if (!result.success) {
      throw new Error(JSON.stringify(result.error.flatten()));
    }
    const { image } = result.data;
    return this.scanService.identify(image);
  }
}
