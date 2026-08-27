/**
 * Development-only: make the harness packages this bundle declares as peers
 * resolvable from a plain clone.
 *
 * A real deployment never runs this — `dsh plugin add` installs the bundle into
 * a profile, where Node's parent-directory walk finds the harness installation's
 * own copies through `$DSH_HOME/profiles/node_modules`. This script reproduces
 * that arrangement locally by junctioning each peer to a harness checkout, so
 * the tests drive the exact code a user would run instead of a published
 * snapshot that may be several release candidates behind.
 *
 * Usage: `node scripts/link-harness.mjs [path-to-harness-checkout]`
 * (defaults to `$DSH_HARNESS`, then `../deepseek-harness`).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const harness = resolve(process.argv[2] ?? process.env.DSH_HARNESS ?? '../deepseek-harness')
if (!existsSync(join(harness, 'packages'))) {
  console.error(`link-harness: no harness checkout at ${harness}`)
  console.error('Pass the path explicitly: node scripts/link-harness.mjs ../deepseek-harness')
  process.exit(1)
}

// Every scoped package this bundle can import, wherever it lives in the harness
// layout: the vendored framework under vendor/, the harness packages under
// packages/<group>/<name>/.
const roots = [join(harness, 'vendor'), ...readdirSync(join(harness, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(harness, 'packages', entry.name))]

const found = new Map()
for (const root of roots) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    continue
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (!existsSync(join(dir, 'package.json'))) continue
    const { name } = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(dir, 'package.json'), 'utf8')))
    if (typeof name === 'string' && name.startsWith('@deepseek-ai/')) found.set(name, dir)
  }
}

const scopeDir = join('node_modules', '@deepseek-ai')
mkdirSync(scopeDir, { recursive: true })
for (const [name, dir] of found) {
  const link = join(scopeDir, name.slice('@deepseek-ai/'.length))
  rmSync(link, { recursive: true, force: true })
  // Junctions, not symlinks: Windows grants them without developer mode.
  symlinkSync(dir, link, 'junction')
}
console.log(`link-harness: linked ${found.size} package(s) from ${harness}`)
