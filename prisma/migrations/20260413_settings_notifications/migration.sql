-- Settings + Notifications Platform — 6 new tables

-- StoreSettings
CREATE TABLE IF NOT EXISTS "store_settings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeId" TEXT NOT NULL UNIQUE,
  "storeName" TEXT,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "webhookUrl" TEXT,
  "webhookSecret" TEXT,
  "webhookSecretPrev" TEXT,
  "webhookSecretRotatedAt" TIMESTAMP(3),
  "webhookEvents" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "webhookActiveSince" TIMESTAMP(3),
  "webhookFailureCount" INTEGER NOT NULL DEFAULT 0,
  "webhookDisabledAt" TIMESTAMP(3),
  "webhookDisabledReason" TEXT,
  "defaultMarkup" DOUBLE PRECISION NOT NULL DEFAULT 30,
  "notifyOrders" BOOLEAN NOT NULL DEFAULT true,
  "notifyEscrow" BOOLEAN NOT NULL DEFAULT true,
  "notifyShipping" BOOLEAN NOT NULL DEFAULT true,
  "notifyDisputes" BOOLEAN NOT NULL DEFAULT true,
  "notifyProducts" BOOLEAN NOT NULL DEFAULT true,
  "notifySystem" BOOLEAN NOT NULL DEFAULT true,
  "notificationEmail" TEXT,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
  "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "store_settings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ProviderSettings
CREATE TABLE IF NOT EXISTS "provider_settings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL UNIQUE,
  "locale" TEXT NOT NULL DEFAULT 'en',
  "webhookUrl" TEXT,
  "webhookSecret" TEXT,
  "webhookSecretPrev" TEXT,
  "webhookSecretRotatedAt" TIMESTAMP(3),
  "webhookFailureCount" INTEGER NOT NULL DEFAULT 0,
  "webhookDisabledAt" TIMESTAMP(3),
  "webhookDisabledReason" TEXT,
  "notifyNewOrders" BOOLEAN NOT NULL DEFAULT true,
  "notifyOrderCancelled" BOOLEAN NOT NULL DEFAULT true,
  "notifyEscrowReleased" BOOLEAN NOT NULL DEFAULT true,
  "notifyDisputes" BOOLEAN NOT NULL DEFAULT true,
  "notifySystem" BOOLEAN NOT NULL DEFAULT true,
  "notificationEmail" TEXT,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
  "inAppEnabled" BOOLEAN NOT NULL DEFAULT true,
  "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_settings_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Notification
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "recipientType" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "eventId" TEXT,
  "type" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "link" TEXT,
  "actorType" TEXT,
  "actorId" TEXT,
  "relatedType" TEXT,
  "relatedId" TEXT,
  "groupKey" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_eventId_recipientType_recipientId_key" ON "notifications"("eventId", "recipientType", "recipientId");
CREATE INDEX IF NOT EXISTS "notifications_recipientType_recipientId_readAt_idx" ON "notifications"("recipientType", "recipientId", "readAt");
CREATE INDEX IF NOT EXISTS "notifications_recipientType_recipientId_createdAt_idx" ON "notifications"("recipientType", "recipientId", "createdAt");
CREATE INDEX IF NOT EXISTS "notifications_recipientType_recipientId_groupKey_idx" ON "notifications"("recipientType", "recipientId", "groupKey");
CREATE INDEX IF NOT EXISTS "notifications_relatedType_relatedId_idx" ON "notifications"("relatedType", "relatedId");
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications"("createdAt");

-- WebhookDelivery
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL UNIQUE,
  "recipientType" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "notificationId" TEXT,
  "url" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "signature" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastAttemptAt" TIMESTAMP(3),
  "nextRetryAt" TIMESTAMP(3),
  "responseStatus" INTEGER,
  "responseBody" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "webhook_deliveries_recipientType_recipientId_createdAt_idx" ON "webhook_deliveries"("recipientType", "recipientId", "createdAt");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_nextRetryAt_idx" ON "webhook_deliveries"("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_requestId_idx" ON "webhook_deliveries"("requestId");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_createdAt_idx" ON "webhook_deliveries"("createdAt");

-- EventOutbox
CREATE TABLE IF NOT EXISTS "event_outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "storeId" TEXT,
  "providerId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "event_outbox_status_createdAt_idx" ON "event_outbox"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "event_outbox_eventType_idx" ON "event_outbox"("eventType");
CREATE INDEX IF NOT EXISTS "event_outbox_storeId_idx" ON "event_outbox"("storeId");
CREATE INDEX IF NOT EXISTS "event_outbox_providerId_idx" ON "event_outbox"("providerId");
CREATE INDEX IF NOT EXISTS "event_outbox_processedAt_idx" ON "event_outbox"("processedAt");

-- NotificationSession
CREATE TABLE IF NOT EXISTS "notification_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "recipientType" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "notification_sessions_token_expiresAt_idx" ON "notification_sessions"("token", "expiresAt");
CREATE INDEX IF NOT EXISTS "notification_sessions_expiresAt_idx" ON "notification_sessions"("expiresAt");
