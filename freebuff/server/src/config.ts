import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'

/** The profile the orchestrated server owns. Never the Desktop app's live profile. */
const DEFAULT_PROFILE_NAME = 'state.json'
const CONFIG_FILE_NAME = 'config.json'

export type WebTlsConfig = {
  certPath: string
  keyPath: string
}

export type WebServerConfig = {
  hostname: string
  port: number
  configDir: string
  configPath: string
  /** `${profilePath}.auth-secrets.json` is intentionally never created or read. */
  profilePath: string
  /** True when FREEBUFF_WEB_NO_AUTH disables the password gate entirely. */
  authDisabled: boolean
  passwordHash: string | null
  /** Plaintext, only when this run generated the password, so it can be printed once. */
  generatedPassword: string | null
  sessionSecret: string
  tls: WebTlsConfig | null
  /** Desktop state file copied into a brand-new web profile, if any. */
  seededFrom: string | null
}

type StoredConfig = {
  version: 1
  authDisabled?: boolean
  passwordHash?: string
  sessionSecret?: string
  createdAt?: string
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid FREEBUFF_WEB_PORT: ${raw}`)
  }
  return port
}

/** Explicit opt-in: an unset or empty value keeps the password gate. */
function parseNoAuth(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase())
}

function readStoredConfig(configPath: string): StoredConfig {
  if (!existsSync(configPath)) return { version: 1 }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as StoredConfig
    if (!parsed || typeof parsed !== 'object') return { version: 1 }
    return {
      version: 1,
      authDisabled:
        typeof parsed.authDisabled === 'boolean'
          ? parsed.authDisabled
          : undefined,
      passwordHash:
        typeof parsed.passwordHash === 'string'
          ? parsed.passwordHash
          : undefined,
      sessionSecret:
        typeof parsed.sessionSecret === 'string'
          ? parsed.sessionSecret
          : undefined,
      createdAt:
        typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
    }
  } catch (error) {
    throw new Error(
      `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function writeStoredConfig(configPath: string, config: StoredConfig): void {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  })
  chmodSync(configPath, 0o600)
}

/**
 * The web server keeps its own profile so a running Desktop app never has to share
 * its profile lock. On first run we seed the project list from the Desktop state
 * so the existing projects show up; sign-in state is not copied (Desktop keeps it
 * in an Electron-encrypted file that a plain Bun process cannot read).
 */
function seedProfileFromDesktop(
  profilePath: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (existsSync(profilePath)) return null
  const desktopState =
    env.FREEBUFF_DESKTOP_STATE?.trim() ||
    path.join(homedir(), '.config', 'freebuff-desktop', 'state.json')
  if (!existsSync(desktopState)) return null
  try {
    // Read first: a copy taken while Desktop rewrites state.json would leave a
    // truncated profile that this server would then refuse to reseed.
    const contents = readFileSync(desktopState, 'utf8')
    JSON.parse(contents)
    mkdirSync(path.dirname(profilePath), { recursive: true, mode: 0o700 })
    writeFileSync(profilePath, contents, { mode: 0o600 })
    chmodSync(profilePath, 0o600)
    return desktopState
  } catch {
    return null
  }
}

export async function loadWebServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebServerConfig> {
  const home = homedir()
  const configDir =
    env.FREEBUFF_WEB_CONFIG_DIR?.trim() ||
    path.join(
      env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'),
      'freebuff-web',
    )
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(configDir, 0o700)
  } catch {
    // Best-effort: a config dir on a filesystem without POSIX modes still works.
  }

  const configPath = path.join(configDir, CONFIG_FILE_NAME)
  const stored = readStoredConfig(configPath)

  const profilePath =
    env.FREEBUFF_WEB_PROFILE?.trim() ||
    path.join(configDir, DEFAULT_PROFILE_NAME)
  const seededFrom = seedProfileFromDesktop(profilePath, env)

  const envPassword = env.FREEBUFF_WEB_PASSWORD?.trim()
  // The flag is persisted after the first no-auth start, so a plain restart
  // stays open. Setting a password (or NO_AUTH=0) turns the gate back on.
  let authDisabled = stored.authDisabled ?? false
  if (env.FREEBUFF_WEB_NO_AUTH !== undefined) {
    authDisabled = parseNoAuth(env.FREEBUFF_WEB_NO_AUTH)
  }
  if (envPassword) authDisabled = false

  let passwordHash = stored.passwordHash ?? null
  let generatedPassword: string | null = null

  if (authDisabled) {
    // No password is needed; the stored hash is dropped so re-enabling auth
    // issues a fresh password instead of reviving an old one.
    passwordHash = null
  } else if (envPassword) {
    passwordHash = await Bun.password.hash(envPassword, {
      algorithm: 'argon2id',
    })
  } else if (!passwordHash) {
    generatedPassword = randomBytes(12).toString('base64url')
    passwordHash = await Bun.password.hash(generatedPassword, {
      algorithm: 'argon2id',
    })
  }

  const sessionSecret = stored.sessionSecret ?? randomBytes(32).toString('hex')
  // An env-supplied password is hashed in memory only. A hash stored by an
  // earlier run is kept, so removing the env var does not lock anyone out.
  const hashToStore = envPassword ? stored.passwordHash : passwordHash
  const needsWrite =
    (!stored.passwordHash && !envPassword) ||
    !stored.sessionSecret ||
    (authDisabled && !!stored.passwordHash) ||
    stored.authDisabled !== authDisabled
  if (needsWrite) {
    writeStoredConfig(configPath, {
      version: 1,
      authDisabled,
      ...(hashToStore ? { passwordHash: hashToStore } : {}),
      sessionSecret,
      createdAt: stored.createdAt ?? new Date().toISOString(),
    })
  }

  const certPath = env.FREEBUFF_WEB_TLS_CERT?.trim()
  const keyPath = env.FREEBUFF_WEB_TLS_KEY?.trim()
  if (!!certPath !== !!keyPath) {
    throw new Error(
      'Set both FREEBUFF_WEB_TLS_CERT and FREEBUFF_WEB_TLS_KEY, or neither.',
    )
  }
  if (certPath && !existsSync(certPath)) {
    throw new Error(`TLS certificate not found: ${certPath}`)
  }
  if (keyPath && !existsSync(keyPath)) {
    throw new Error(`TLS key not found: ${keyPath}`)
  }

  return {
    hostname: env.FREEBUFF_WEB_HOST?.trim() || '0.0.0.0',
    port: parsePort(env.FREEBUFF_WEB_PORT, 4310),
    configDir,
    configPath,
    profilePath,
    authDisabled,
    passwordHash,
    generatedPassword,
    sessionSecret,
    tls: certPath && keyPath ? { certPath, keyPath } : null,
    seededFrom,
  }
}

/** Every non-internal IPv4 address, for the "open this on your phone" banner. */
export function lanAddresses(): string[] {
  const addresses: string[] = []
  const interfaces = networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal)
        addresses.push(entry.address)
    }
  }
  return addresses
}
