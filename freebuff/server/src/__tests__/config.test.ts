import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadWebServerConfig } from '../config'

const directories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'freebuff-web-config-'))
  directories.push(directory)
  return directory
}

function baseEnv(directory: string): NodeJS.ProcessEnv {
  return {
    FREEBUFF_WEB_CONFIG_DIR: directory,
    FREEBUFF_WEB_PROFILE: path.join(directory, 'state.json'),
    FREEBUFF_DESKTOP_STATE: path.join(directory, 'missing-desktop-state.json'),
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('loadWebServerConfig', () => {
  it('generates a password once, persists its hash, and reuses it', async () => {
    const directory = temporaryDirectory()
    const env = baseEnv(directory)

    const first = await loadWebServerConfig(env)
    expect(first.generatedPassword).toBeTruthy()
    expect(
      await Bun.password.verify(first.generatedPassword!, first.passwordHash!),
    ).toBe(true)

    const stored = JSON.parse(readFileSync(first.configPath, 'utf8')) as {
      passwordHash?: string
      sessionSecret?: string
    }
    expect(typeof stored.passwordHash).toBe('string')
    expect(typeof stored.sessionSecret).toBe('string')

    const second = await loadWebServerConfig(env)
    expect(second.generatedPassword).toBeNull()
    expect(second.passwordHash).toBe(first.passwordHash)
    expect(
      await Bun.password.verify(first.generatedPassword!, second.passwordHash!),
    ).toBe(true)
  })

  it('hashes an env password in memory without storing it', async () => {
    const directory = temporaryDirectory()
    const env = baseEnv(directory)

    const configured = await loadWebServerConfig({
      ...env,
      FREEBUFF_WEB_PASSWORD: 'chosen-password',
    })
    expect(configured.generatedPassword).toBeNull()
    expect(
      await Bun.password.verify('chosen-password', configured.passwordHash!),
    ).toBe(true)

    const stored = JSON.parse(readFileSync(configured.configPath, 'utf8')) as {
      passwordHash?: string
    }
    expect(stored.passwordHash).toBeUndefined()

    // Removing the env var must still leave a working password on the next run.
    const generated = await loadWebServerConfig(env)
    expect(generated.generatedPassword).toBeTruthy()
    const next = await loadWebServerConfig(env)
    expect(next.generatedPassword).toBeNull()
    expect(
      await Bun.password.verify(
        generated.generatedPassword!,
        next.passwordHash!,
      ),
    ).toBe(true)
  })

  it('disables auth without a password and drops a stored hash', async () => {
    const directory = temporaryDirectory()
    const env = baseEnv(directory)

    const withPassword = await loadWebServerConfig(env)
    expect(withPassword.passwordHash).toBeTruthy()

    const open = await loadWebServerConfig({
      ...env,
      FREEBUFF_WEB_NO_AUTH: '1',
    })
    expect(open.authDisabled).toBe(true)
    expect(open.passwordHash).toBeNull()
    expect(open.generatedPassword).toBeNull()

    const stored = JSON.parse(readFileSync(open.configPath, 'utf8')) as {
      authDisabled?: boolean
      passwordHash?: string
    }
    expect(stored.passwordHash).toBeUndefined()
    expect(stored.authDisabled).toBe(true)

    // A plain restart stays open; the flag is persisted.
    const restarted = await loadWebServerConfig(env)
    expect(restarted.authDisabled).toBe(true)
    expect(restarted.passwordHash).toBeNull()

    // Turning auth back on issues a new password instead of reviving the old one.
    const backOn = await loadWebServerConfig({
      ...env,
      FREEBUFF_WEB_NO_AUTH: '0',
    })
    expect(backOn.authDisabled).toBe(false)
    expect(backOn.generatedPassword).toBeTruthy()
  })

  it('seeds a fresh profile from the Desktop state but not its auth secrets', async () => {
    const directory = temporaryDirectory()
    const desktopState = path.join(directory, 'desktop-state.json')
    writeFileSync(desktopState, JSON.stringify({ projects: ['one'] }))
    writeFileSync(
      `${desktopState}.auth-secrets.json`,
      JSON.stringify({ encrypted: true }),
    )

    const config = await loadWebServerConfig({
      ...baseEnv(directory),
      FREEBUFF_DESKTOP_STATE: desktopState,
    })

    expect(config.seededFrom).toBe(desktopState)
    expect(existsSync(config.profilePath)).toBe(true)
    expect(JSON.parse(readFileSync(config.profilePath, 'utf8'))).toEqual({
      projects: ['one'],
    })
    expect(existsSync(`${config.profilePath}.auth-secrets.json`)).toBe(false)
  })
})
