import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { readSecret } from './config/read-secret';

async function bootstrap() {
  // Validate critical env vars / secrets before starting. Missing secrets
  // would otherwise boot the app in a broken state where the first request
  // to the affected feature throws at runtime — fail fast at boot instead.
  const REQUIRED_SECRETS = [
    { name: 'DATABASE_URL', always: true },
    { name: 'ENCRYPTION_KEY', always: true }, // AES-256 key for Shopify token encryption
    { name: 'PROVIDER_JWT_SECRET', always: true }, // Provider login tokens
    { name: 'SHOPIFY_API_SECRET', prodOnly: true }, // OAuth + session token verification
    { name: 'SHOPIFY_WEBHOOK_SECRET', prodOnly: true }, // Webhook HMAC verification
    { name: 'STELO_PROXY_SECRET', prodOnly: true }, // Remix → API wallet-auth gate
  ];

  // Known insecure defaults from docker-compose / .env.example / inline
  // fallbacks. If any of these leak into production they effectively
  // disable the protection they were meant to provide, so refuse to start.
  const KNOWN_INSECURE_DEFAULTS: Record<string, string[]> = {
    STELO_PROXY_SECRET: ['dev-only-proxy-secret-change-me-in-production'],
    SESSION_SECRET: [
      'a1b2c3d4e5f6789012345678abcdef01a1b2c3d4e5f6789012345678abcdef01',
    ],
    PROVIDER_JWT_SECRET: [
      'provider-jwt-dev-secret',
      'provider-jwt-dev-secret-change-me',
    ],
  };

  const missing: string[] = [];
  const insecure: string[] = [];
  for (const { name, always, prodOnly } of REQUIRED_SECRETS) {
    if (always || (prodOnly && process.env.NODE_ENV === 'production')) {
      const value = readSecret(name);
      if (!value) {
        missing.push(name);
        continue;
      }
      if (
        process.env.NODE_ENV === 'production' &&
        KNOWN_INSECURE_DEFAULTS[name]?.includes(value)
      ) {
        insecure.push(name);
      }
    }
  }

  if (missing.length > 0) {
    console.error(
      `FATAL: Missing required secrets at boot: ${missing.join(', ')}. ` +
        `Set them as env vars or mount them as Docker secrets in /run/secrets/. ` +
        `In production, refusing to start with these missing prevents silent feature breakage.`,
    );
    process.exit(1);
  }

  if (insecure.length > 0) {
    console.error(
      `FATAL: Production secret(s) still use the publicly-known dev default: ${insecure.join(', ')}. ` +
        `Generate a real value (e.g. \`openssl rand -hex 32\`) and set it before deploying — ` +
        `using the dev default negates the protection these secrets were added to provide.`,
    );
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    rawBody: true, // needed for Shopify HMAC verification
  });

  // Trust the reverse proxy (Docker network, nginx, ALB, etc.) so
  // `express-rate-limit` and any IP-based logic sees the real client IP
  // via X-Forwarded-For. Without this, in production all traffic appears
  // to come from a single hop and one abusive client can drain everyone's
  // shared rate-limit bucket.
  //
  // `1` = trust one layer of proxy, which is the typical Docker/ALB setup.
  // Increase if there are multiple proxy layers in front of the API.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter — consistent error response format
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global logging interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // CORS — accept a comma-separated list of origins and echo back whichever
  // origin matches. `Access-Control-Allow-Origin` must be a single origin
  // (not a list) to be valid, and wildcards are incompatible with
  // `credentials: true`, so we resolve it per request.
  //
  // In production, we refuse to fall through to the permissive wildcard —
  // setting `CORS_ORIGIN=*` with `credentials: true` lets any origin make
  // credentialed requests, which defeats CORS entirely. Force an explicit
  // origin list in prod and hard-crash on the insecure default.
  const rawCorsOrigin = process.env.CORS_ORIGIN || '*';
  if (process.env.NODE_ENV === 'production' && rawCorsOrigin === '*') {
    console.error(
      'FATAL: CORS_ORIGIN=* is not allowed in production. Set it to a ' +
        'comma-separated allowlist of trusted origins before deploying.',
    );
    process.exit(1);
  }
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

  // Rate limiting — 100 requests per minute per client IP (global).
  // Requires `trust proxy` above to be set so we rate-limit by the real
  // X-Forwarded-For client IP, not the proxy hop.
  //
  // Tighter per-endpoint limits for sensitive auth paths would go here
  // as additional `app.use(rateLimit({ ... }))` calls mounted with a
  // `skip` predicate — not yet implemented; the global limit applies.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { statusCode: 429, message: 'Too many requests, please try again later.' },
    }),
  );

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
