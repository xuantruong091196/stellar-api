import { defineConfig } from 'prisma/config'

// Prisma v7: connection URL lives in prisma.config.ts, not schema.prisma.
// The Dockerfile passes DATABASE_URL as an environment variable at build
// and runtime, and migrations are run via `prisma migrate deploy`.
export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL as string,
  },
})
