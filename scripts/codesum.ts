/**
 * Content fingerprint of a source tree — used by `make up` to PROVE the running
 * container holds the code that is in the working tree.
 *
 * The same command runs on both sides:
 *
 *     bun scripts/codesum.ts src web/src        # host
 *     docker exec linewatch cat /app/.codesum   # baked in at image build time
 *
 * Different hashes mean the container is serving something other than what you
 * have on disk, and everything you conclude from it is suspect. This exists
 * instead of a `--no-cache` escape hatch: Docker's layer-cache keys are content
 * checksums, so a nuclear rebuild cannot buy correctness and cannot tell "the
 * cache was stale" apart from "the cache was fine and something else is wrong".
 * The assertion tells them apart in about a second. On 2026-08-02 the deployed
 * dashboard was two generations behind the working tree — a `bun run build` had
 * been mistaken for a deploy — and nothing in the stack said so.
 *
 * Path-independent by design: it hashes the *set* of file content digests, not
 * the paths, because the tree is `web/src` on the host and `/app/web/src` in
 * the build stage.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, digests: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) {
      walk(path, digests)
      continue
    }

    digests.push(createHash('md5').update(readFileSync(path)).digest('hex'))
  }
}

const roots = process.argv.slice(2)
if (roots.length === 0) {
  console.error('usage: bun scripts/codesum.ts <dir> [<dir>...]')
  process.exit(1)
}

const digests: string[] = []
for (const root of roots) walk(root, digests)
digests.sort()

console.log(createHash('md5').update(digests.join('')).digest('hex'))
