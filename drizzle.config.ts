import { defineConfig } from 'drizzle-kit'

// Read directly from process.env rather than importing src/config.ts: that
// module resolves the bearer token at import time and throws if none is set
// (see src/config.ts), which would make `drizzle-kit generate`/`migrate`
// fail on a machine that hasn't provisioned a token yet.
const dbPath = process.env['LINEWATCH_DB'] ?? './data/linewatch.db'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
})
