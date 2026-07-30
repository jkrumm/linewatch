import { defineConfig, mergeConfig } from 'vite'
import { basaltViteConfig } from 'basalt-ui/vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf-8')) as {
  version: string
}

// VITE_API_TARGET lets a local dev run point at a live API for debugging.  The dev proxy strips
// `/api` from the source path and prepends the target, so the target itself must already include
// `/api` — the linewatch Elysia app registers its routes under that prefix (see docs/DESIGN.md's
// API table), unlike argo's bare-origin local API. Default is the local container port from
// docs/DESIGN.md ("Ports": 7731 service, 7731 = API + built UI).
const apiTarget = process.env['VITE_API_TARGET'] ?? 'http://localhost:7731/api'

// The tailnet dev door's hostname is machine-specific and stays out of the repo
// (this is a public repo; see the security rule on hostnames). Set it locally,
// e.g. LINEWATCH_DEV_HOSTS=.example-host.example.com — a leading dot allows the
// whole subdomain. Without it, only the local `.test` door is accepted, which is
// all a checkout elsewhere needs.
const extraHosts = (process.env['LINEWATCH_DEV_HOSTS'] ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

const basalt = basaltViteConfig({
  port: 7732,
  allowedHosts: ['linewatch.test', ...extraHosts],
  apiTarget,
  version: pkg.version,
})

export default defineConfig(
  mergeConfig(basalt, {
    plugins: [TanStackRouterVite({ target: 'react', autoCodeSplitting: true }), react()],
  }),
)
