import { readSecret } from './read-secret';

export default () => ({
  port: parseInt(process.env.PORT || '8000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: readSecret('DATABASE_URL'),
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: readSecret('REDIS_PASSWORD') || undefined,
  },

  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    horizonUrl:
      process.env.STELLAR_HORIZON_URL ||
      'https://horizon-testnet.stellar.org',
    systemSecretKey: readSecret('SYSTEM_STELLAR_SECRET_KEY'),
    escrowSecretKey: readSecret('ESCROW_STELLAR_SECRET_KEY'),
    treasurySecretKey: readSecret('TREASURY_STELLAR_SECRET_KEY'),
    usdcIssuer:
      process.env.USDC_ISSUER ||
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },

  shopify: {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: readSecret('SHOPIFY_API_SECRET'),
    webhookSecret: readSecret('SHOPIFY_WEBHOOK_SECRET'),
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },

  easypost: {
    apiKey: readSecret('EASYPOST_API_KEY'),
  },

  resend: {
    apiKey: readSecret('RESEND_API_KEY'),
    fromEmail: process.env.RESEND_FROM_EMAIL || 'notifications@stelo.life',
    replyTo: process.env.RESEND_REPLY_TO || 'noreply@stelo.life',
  },

  notifications: {
    sseSessionTtlMs: parseInt(process.env.SSE_SESSION_TTL_MS || '3600000', 10), // 1h
    emailDailyLimit: parseInt(process.env.EMAIL_DAILY_LIMIT || '90', 10), // soft limit before throttling
    emailHardLimit: parseInt(process.env.EMAIL_HARD_LIMIT || '100', 10), // Resend free tier
    webhookMaxFailures: parseInt(process.env.WEBHOOK_MAX_FAILURES || '50', 10),
    webhookSecretGracePeriodMs: parseInt(process.env.WEBHOOK_SECRET_GRACE_MS || '86400000', 10), // 24h
  },

  admin: {
    apiKey: readSecret('ADMIN_API_KEY'),
  },

  pricing: {
    platformFeeRate: parseFloat(process.env.PLATFORM_FEE_RATE || '0.05'),
  },

  providerAuth: {
    jwtSecret: readSecret('PROVIDER_JWT_SECRET') || 'provider-jwt-dev-secret',
    jwtExpiresIn: process.env.PROVIDER_JWT_EXPIRES_IN || '24h',
  },

  aws: {
    s3Bucket: process.env.R2_BUCKET || process.env.AWS_S3_BUCKET,
    r2AccountId: process.env.R2_ACCOUNT_ID,
    region: 'auto',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: readSecret('AWS_SECRET_ACCESS_KEY'),
    r2PublicUrl: process.env.R2_PUBLIC_URL,
  },
});
