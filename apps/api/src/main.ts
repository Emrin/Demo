import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN || '*' });
  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port);
  console.log(`API running on port ${port}`);
}
bootstrap();