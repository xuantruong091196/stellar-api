import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { readSecret } from './config/read-secret';

async function bootstrap() {
  // Validate critical env vars / secrets before starting
  if (!readSecret('DATABASE_URL')) {
    console.error('FATAL: DATABASE_URL environment variable or Docker secret is required');
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    rawBody: true, // needed for Shopify HMAC verification
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // CORS — accept a comma-separated list of origins and echo back whichever
  // origin matches. The Access-Control-Allow-Origin header must be a single
  // origin (not a list) to be valid, and wildcards are incompatible with
  // `credentials: true`, so we resolve it per request.
  const rawCorsOrigin = process.env.CORS_ORIGIN || '*';
  const corsOrigin: CorsOptions['origin'] = rawCorsOrigin === '*'
    ? true
    : (() => {
        const allowed = rawCorsOrigin
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
        return (origin, cb) => {
          if (!origin || allowed.includes(origin)) return cb(null, true);
          return cb(new Error(`Origin ${origin} not allowed by CORS`), false);
        };
      })();
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Body parser limits
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bodyParser = require('express');
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('StellarPOD API')
    .setDescription('Shopify POD marketplace with Stellar blockchain escrow')
    .setVersion('0.1.0')
    .addBearerAuth()
    .addTag('orders', 'Order management')
    .addTag('escrow', 'Stellar escrow operations')
    .addTag('designs', 'Design file management')
    .addTag('providers', 'Print provider management')
    .addTag('shopify', 'Shopify webhook integration')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`StellarPOD API running on port ${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap();
