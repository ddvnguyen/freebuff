import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  findFreebuffBundle,
  findInstalledFreebuffBundle,
  readAppVersion,
} from '../orchestrator'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'freebuff-bundle-'))
  directories.push(directory)
  return directory
}

/** A directory shaped like a Desktop Resources directory. */
function fakeResources(options: { version?: string } = {}): string {
  const resourcesDir = temporaryDirectory()
  mkdirSync(path.join(resourcesDir, 'orchestrator', 'ui'), { recursive: true })
  mkdirSync(path.join(resourcesDir, 'orchestrator', 'wasm'), {
    recursive: true,
  })
  writeFileSync(
    path.join(resourcesDir, 'orchestrator', 'orchestrator.js'),
    '// orchestrator\n',
  )
  writeFileSync(
    path.join(resourcesDir, 'orchestrator', 'ui', 'index.html'),
    '<html><body>Freebuff</body></html>',
  )
  writeFileSync(
    path.join(resourcesDir, 'orchestrator', 'wasm', 'tree-sitter.wasm'),
    '',
  )
  if (options.version) {
    writeFileSync(
      path.join(resourcesDir, 'manifest.json'),
      JSON.stringify({ version: options.version }),
    )
  }
  return resourcesDir
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('findInstalledFreebuffBundle', () => {
  it('finds a Desktop-shaped Resources directory', () => {
    const resourcesDir = fakeResources()
    const bundle = findInstalledFreebuffBundle({
      FREEBUFF_APP_PATH: resourcesDir,
    })

    expect(bundle?.resourcesDir).toBe(resourcesDir)
    expect(bundle?.source).toBe('desktop')
    expect(bundle?.wasmDir).toBe(
      path.join(resourcesDir, 'orchestrator', 'wasm'),
    )
    expect(bundle?.rgPath).toBeTruthy()
  })

  it('accepts the app bundle shape and the orchestrator directory', () => {
    const appRoot = temporaryDirectory()
    const appBundle = path.join(appRoot, 'Freebuff.app')
    const appResources = path.join(appBundle, 'Contents', 'Resources')
    mkdirSync(path.join(appResources, 'orchestrator', 'ui'), {
      recursive: true,
    })
    writeFileSync(
      path.join(appResources, 'orchestrator', 'orchestrator.js'),
      '// orchestrator\n',
    )
    writeFileSync(
      path.join(appResources, 'orchestrator', 'ui', 'index.html'),
      '<html></html>',
    )

    expect(
      findInstalledFreebuffBundle({ FREEBUFF_APP_PATH: appBundle })
        ?.resourcesDir,
    ).toBe(appResources)
    expect(
      findInstalledFreebuffBundle({
        FREEBUFF_APP_PATH: path.join(appResources, 'orchestrator'),
      })?.resourcesDir,
    ).toBe(appResources)
  })
})

describe('findFreebuffBundle', () => {
  it('uses an explicit runtime without requiring the Desktop app', () => {
    const runtimeDir = fakeResources({ version: '9.9.9-test' })
    const bundle = findFreebuffBundle({ FREEBUFF_RUNTIME_DIR: runtimeDir })

    expect(bundle.source).toBe('vendored')
    expect(bundle.resourcesDir).toBe(runtimeDir)
    expect(bundle.orchestratorPath).toBe(
      path.join(runtimeDir, 'orchestrator', 'orchestrator.js'),
    )
    expect(readAppVersion(bundle)).toBe('9.9.9-test')
  })
})
