/**
 * Check the three things that make this package a loadable dsh bundle, against
 * the built artifacts rather than the sources:
 *
 * 1. Every `name:` in `cordis.patch.yml` resolves through the exports map — the
 *    failure mode that only shows up as "plugin(s) failed to load" at boot.
 * 2. Every entry point has exactly one plugin shape. A module carrying both a
 *    default export and a function-plugin `apply` makes the Cordis Loader drop
 *    the plugin namespace, which fails silently rather than loudly.
 * 3. `dsh.bundle.patch` points at a file that exists and parses.
 *
 * Run after `pnpm build`: `node scripts/verify-bundle.mjs`
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const errors = []

const patchPath = manifest.dsh?.bundle?.patch
if (typeof patchPath !== 'string') {
  errors.push('package.json: dsh.bundle.patch is missing — dsh would install this as a plain dependency and activate no layer')
}

const patchFile = join('.', patchPath ?? 'cordis.patch.yml')
if (!existsSync(patchFile)) errors.push(`${patchFile}: declared by dsh.bundle.patch but not present`)

// The patch is a small, fixed-shape document; parsing the row names it declares
// needs no YAML dependency and keeps this script runnable from a bare install.
const rows = []
for (const line of readFileSync(patchFile, 'utf8').split('\n')) {
  const match = /^\s*(?:-\s*)?name:\s*'?([^'\s#]+)'?/.exec(line)
  if (match) rows.push(match[1])
}
if (rows.length === 0) errors.push(`${patchFile}: declares no plugin rows`)

for (const row of rows) {
  if (row !== manifest.name && !row.startsWith(`${manifest.name}/`)) {
    errors.push(`${patchFile}: row "${row}" is not provided by this package`)
    continue
  }
  const subpath = row === manifest.name ? '.' : `.${row.slice(manifest.name.length)}`
  if (manifest.exports?.[subpath] === undefined) {
    errors.push(`package.json: row "${row}" has no exports entry for "${subpath}"`)
  }
}

const entryPoints = Object.keys(manifest.exports ?? {})
  .filter(subpath => subpath !== './package.json' && !subpath.endsWith('.yml'))

for (const subpath of entryPoints) {
  const target = manifest.exports[subpath]?.default
  if (typeof target !== 'string') {
    errors.push(`package.json: exports["${subpath}"] has no default target`)
    continue
  }
  if (!existsSync(target)) {
    errors.push(`exports["${subpath}"] -> ${target} is missing; run \`pnpm build\` first`)
    continue
  }
  let mod
  try {
    mod = await import(pathToFileURL(resolve(target)).href)
  } catch (error) {
    errors.push(`exports["${subpath}"] -> ${target} failed to import: ${error.message}`)
    continue
  }
  const hasDefault = typeof mod.default === 'function'
  const hasApply = typeof mod.apply === 'function'
  if (hasDefault && hasApply) {
    errors.push(`${subpath}: exports both a default and \`apply\`; the Loader drops the plugin namespace for such a module`)
  } else if (!hasDefault && !hasApply) {
    errors.push(`${subpath}: exports neither a default service class nor an \`apply\` function`)
  } else {
    const shape = hasDefault ? 'service (default export)' : `function plugin (name=${mod.name})`
    console.log(`  ok  ${subpath.padEnd(18)} ${shape}`)
  }
}

if (errors.length > 0) {
  console.error('\nverify-bundle: FAILED')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(`\nverify-bundle: ${rows.length} patch row(s), ${entryPoints.length} entry point(s) — OK`)
