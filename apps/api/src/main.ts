import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // Allow frontend PWA access
  await app.listen(3002);
  console.log('API running on http://localhost:3002');
}
bootstrap();
