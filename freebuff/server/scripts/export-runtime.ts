#!/usr/bin/env bun
/**
 * Copy the Desktop app's portable runtime (orchestrator, UI and wasm grammars)
 * into freebuff/server/runtime so the web server can run without the Desktop
 * app installed — notably on Linux.
 *
 * Usage, on a machine that has Freebuff Desktop installed:
 *
 *   cd freebuff/server && bun run export-runtime
 *   cd freebuff/server && bun run export-runtime -- /path/to/Freebuff.app
 *
 * ripgrep is not copied: this repository already ships every platform binary
 * under sdk/vendor/ripgrep, and the server points the orchestrator at it.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import {
  findFreebuffBundleAt,
  findInstalledFreebuffBundle,
  readAppVersion,
} from '../src/orchestrator'

function directorySize(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    total += entry.isDirectory()
      ? directorySize(entryPath)
      : statSync(entryPath).size
  }
  return total
}

function main(): void {
  const from = process.argv[2]?.trim()
  const bundle = from
    ? findFreebuffBundleAt(from)
    : findInstalledFreebuffBundle()

  if (!bundle) {
    throw new Error(
      [
        from
          ? `No Freebuff Desktop runtime found at ${from}.`
          : 'Freebuff Desktop was not found.',
        'Install it, or pass the app path:',
        '',
        '  cd freebuff/server && bun run export-runtime -- /Applications/Freebuff.app',
      ].join('\n'),
    )
  }

  const serverDir = path.resolve(import.meta.dir, '..')
  const runtimeDir = path.join(serverDir, 'runtime')
  const orchestratorDir = path.join(runtimeDir, 'orchestrator')
  const sourceOrchestratorDir = path.join(bundle.resourcesDir, 'orchestrator')

  if (path.resolve(bundle.resourcesDir) === runtimeDir) {
    throw new Error('The export source is already the vendored runtime.')
  }

  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(orchestratorDir, { recursive: true })

  cpSync(bundle.orchestratorPath, path.join(orchestratorDir, 'orchestrator.js'))
  chmodSync(path.join(orchestratorDir, 'orchestrator.js'), 0o644)

  const elevationHook = path.join(
    sourceOrchestratorDir,
    'claude-elevation-hook.js',
  )
  if (existsSync(elevationHook)) {
    cpSync(
      elevationHook,
      path.join(orchestratorDir, 'claude-elevation-hook.js'),
    )
  }

  cpSync(bundle.uiDir, path.join(orchestratorDir, 'ui'), { recursive: true })

  if (bundle.wasmDir) {
    cpSync(bundle.wasmDir, path.join(orchestratorDir, 'wasm'), {
      recursive: true,
    })
  }

  const version = readAppVersion(bundle) ?? 'unknown'
  const sizeBytes = directorySize(runtimeDir)
  writeFileSync(
    path.join(runtimeDir, 'manifest.json'),
    `${JSON.stringify(
      {
        format: 1,
        version,
        exportedAt: new Date().toISOString(),
        source: bundle.resourcesDir,
        platform: process.platform,
        arch: process.arch,
        sizeBytes,
      },
      null,
      2,
    )}\n`,
  )

  console.log(`Exported Freebuff Desktop ${version} runtime`)
  console.log(`  from ${bundle.resourcesDir}`)
  console.log(`  to   ${runtimeDir}`)
  console.log(`  size ${(sizeBytes / 1024 / 1024).toFixed(1)} MiB`)
  console.log('  ripgrep comes from sdk/vendor/ripgrep at run time')
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
