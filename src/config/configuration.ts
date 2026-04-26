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

  app: {
    publicUrl: process.env.PUBLIC_APP_URL || 'http://localhost:3000',
    /**
     * Shared secret the Remix frontend attaches to every wallet-authenticated
     * request via X-Stelo-Proxy-Secret. The API guard requires this to accept
     * an X-Wallet-Address header — without it, any HTTP client could claim
     * ownership of any wallet. Leave unset in local dev; MUST be set in prod.
     */
    proxySecret: process.env.STELO_PROXY_SECRET || '',
  },

  admin: {
    apiKey: readSecret('ADMIN_API_KEY'),
  },

  pricing: {
    platformFeeRate: parseFloat(process.env.PLATFORM_FEE_RATE || '0.05'),
  },

  providerAuth: {
    // Dev fallback only — in production, bootstrap fails fast if this
    // secret is missing, so the fallback can never be used there. Keeping
    // a dev default means local `pnpm dev` / docker-compose-up just works
    // without a .env copy step.
    jwtSecret:
      readSecret('PROVIDER_JWT_SECRET') ||
      (process.env.NODE_ENV === 'production'
        ? ''
        : 'provider-jwt-dev-secret-change-me'),
    jwtExpiresIn: process.env.PROVIDER_JWT_EXPIRES_IN || '24h',
  },

  nft: {
    systemXlmWarnThreshold: parseInt(process.env.SYSTEM_XLM_WARN_THRESHOLD || '500', 10),
    systemXlmCriticalThreshold: parseInt(process.env.SYSTEM_XLM_CRITICAL_THRESHOLD || '200', 10),
    issuerFundXlm: '5',
    buyerFundXlm: '2',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@stelo.life',
  },

  ai: {
    geminiApiKey: readSecret('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  },

  aws: {
    s3Bucket: process.env.R2_BUCKET || process.env.AWS_S3_BUCKET,
    r2AccountId: process.env.R2_ACCOUNT_ID,
    region: 'auto',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: readSecret('AWS_SECRET_ACCESS_KEY'),
    r2PublicUrl: process.env.R2_PUBLIC_URL,
  },

  trends: {
    redditClientId: readSecret('REDDIT_CLIENT_ID'),
    redditClientSecret: readSecret('REDDIT_CLIENT_SECRET'),
    redditUsername: readSecret('REDDIT_USERNAME'),
    redditPassword: readSecret('REDDIT_PASSWORD'),
    redditUserAgent: process.env.REDDIT_USER_AGENT || 'stelo-trend-bot/1.0',
    twitterApiIoKey: readSecret('TWITTERAPI_IO_KEY'),
    rapidApiKey: readSecret('RAPIDAPI_KEY'),
    rapidApiPinterestHost: process.env.RAPIDAPI_PINTEREST_HOST || 'pinterest-scraper.p.rapidapi.com',
    rapidApiTiktokHost: process.env.RAPIDAPI_TIKTOK_HOST || 'tikapi.p.rapidapi.com',
    serpApiKey: readSecret('SERPAPI_KEY'),
    replicateApiToken: readSecret('REPLICATE_API_TOKEN'),
    pythonBinary: process.env.PYTHON_BINARY || 'python3',
  },

  subscription: {
    treasuryStellarAddress: process.env.TREASURY_STELLAR_ADDRESS,
    pricingUsdc: {
      m1: parseFloat(process.env.SUB_PRICE_1MO || '19'),
      m6: parseFloat(process.env.SUB_PRICE_6MO || '97'),
      m12: parseFloat(process.env.SUB_PRICE_12MO || '160'),
    },
    priceLockTtlSeconds: parseInt(process.env.PRICE_LOCK_TTL || '900', 10),
    xlmPriceCacheTtlSeconds: 60,
    coingeckoUrl: 'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd',
  },
});
