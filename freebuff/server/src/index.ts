import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createAuth } from './auth'
import { lanAddresses, loadWebServerConfig } from './config'
import {
  findFreebuffBundle,
  readAppVersion,
  startOrchestrator,
  type OrchestratorHandle,
} from './orchestrator'
import { startProxy, type ProxyHandle } from './proxy'

const HELP = `Freebuff Web — serve the installed Freebuff Desktop app to browsers on your network.

Usage:
  bun --cwd freebuff/server start

Environment:
  FREEBUFF_WEB_PORT            Port to listen on (default 4310, 0 picks a free port)
  FREEBUFF_WEB_HOST            Interface to bind (default 0.0.0.0; use 127.0.0.1 for local only)
  FREEBUFF_WEB_PASSWORD        Login password (otherwise one is generated and printed once)
  FREEBUFF_WEB_NO_AUTH         Set to 1 to disable the password gate (trusted networks only)
  FREEBUFF_WEB_CONFIG_DIR      Where config, profile and logs live (default ~/.config/freebuff-web)
  FREEBUFF_WEB_PROFILE         Orchestrator profile path (default <config dir>/state.json)
  FREEBUFF_WEB_TLS_CERT        PEM certificate for HTTPS (must be paired with FREEBUFF_WEB_TLS_KEY)
  FREEBUFF_WEB_TLS_KEY         PEM private key for HTTPS
  FREEBUFF_APP_PATH            Freebuff Desktop app bundle or its Resources directory
  FREEBUFF_DESKTOP_STATE       Desktop state.json to seed projects from on first run

The server never opens the Desktop app's live profile. It runs its own orchestrator
on a loopback port and puts this password-protected proxy in front.
`

function printBanner(options: {
  version: string | null
  resourcesDir: string
  profilePath: string
  logPath: string
  hostname: string
  port: number
  tls: boolean
  authDisabled: boolean
  generatedPassword: string | null
  passwordFromEnv: boolean
  configPath: string
  seededFrom: string | null
}): void {
  const scheme = options.tls ? 'https' : 'http'
  const localHost = ['0.0.0.0', '::'].includes(options.hostname)
    ? 'localhost'
    : options.hostname
  const urls = [`${scheme}://${localHost}:${options.port}`]
  if (['0.0.0.0', '::'].includes(options.hostname)) {
    for (const address of lanAddresses()) {
      urls.push(`${scheme}://${address}:${options.port}`)
    }
  }

  console.log('')
  console.log('  Freebuff Web')
  console.log(
    `  Desktop ${options.version ?? '(unknown version)'} at ${options.resourcesDir}`,
  )
  console.log(`  Profile ${options.profilePath}`)
  if (options.seededFrom) {
    console.log(`  Seeded projects from ${options.seededFrom}`)
  }
  console.log(`  Logs    ${options.logPath}`)
  console.log('')
  console.log(`  Open    ${urls.join('\n          ')}`)
  console.log('')
  if (options.authDisabled) {
    console.log('  Authentication DISABLED (FREEBUFF_WEB_NO_AUTH).')
    console.log(
      '  Anyone who can reach this URL can run commands and edit files.',
    )
    console.log('  Bind 127.0.0.1 or use a trusted network only.')
  } else if (options.generatedPassword) {
    console.log('  Password (shown once, stored hashed in')
    console.log(`  ${options.configPath}):`)
    console.log('')
    console.log(`      ${options.generatedPassword}`)
    console.log('')
    console.log(
      '  Choose your own with FREEBUFF_WEB_PASSWORD before the next start.',
    )
  } else if (options.passwordFromEnv) {
    console.log('  Password is the value of FREEBUFF_WEB_PASSWORD.')
  } else {
    console.log('  Password is the one stored from the first run.')
    console.log('  Change it by setting FREEBUFF_WEB_PASSWORD before starting.')
  }
  console.log('')
  console.log(
    '  Anyone who can reach this URL and sign in can run commands and',
  )
  console.log(
    '  edit files on this machine. Sign in to Freebuff in the browser.',
  )
  console.log('')
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP)
    return
  }

  const config = await loadWebServerConfig()
  const bundle = findFreebuffBundle()
  const version = readAppVersion(bundle)
  const logPath = path.join(config.configDir, 'orchestrator.log')
  const tls = config.tls
    ? {
        cert: readFileSync(config.tls.certPath, 'utf8'),
        key: readFileSync(config.tls.keyPath, 'utf8'),
      }
    : null

  const auth =
    config.authDisabled || !config.passwordHash
      ? null
      : createAuth({
          passwordHash: config.passwordHash,
          sessionSecret: config.sessionSecret,
          secureCookie: !!tls,
        })

  let proxy: ProxyHandle | null = null
  let orchestrator: OrchestratorHandle | null = null
  let shuttingDown = false

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await proxy?.stop()
    } catch (error) {
      console.error(`[web] proxy shutdown failed: ${String(error)}`)
    }
    try {
      await orchestrator?.stop()
    } catch (error) {
      console.error(`[web] orchestrator shutdown failed: ${String(error)}`)
    }
    process.exit(code)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  orchestrator = await startOrchestrator({
    bundle,
    profilePath: config.profilePath,
    logPath,
    onUnexpectedExit: (code, signal) => {
      console.error(
        `\n[web] Freebuff's orchestrator stopped unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
      )
      console.error(`[web] See ${logPath}.`)
      void shutdown(1)
    },
  })

  try {
    proxy = startProxy({
      hostname: config.hostname,
      port: config.port,
      orchestratorPort: orchestrator.port,
      auth,
      secureCookie: !!tls,
      tls,
    })
  } catch (error) {
    await orchestrator.stop()
    throw error
  }

  printBanner({
    version,
    resourcesDir: bundle.resourcesDir,
    profilePath: config.profilePath,
    logPath,
    hostname: proxy.hostname,
    port: proxy.port,
    tls: !!tls,
    authDisabled: config.authDisabled,
    generatedPassword: config.generatedPassword,
    passwordFromEnv: !!process.env.FREEBUFF_WEB_PASSWORD?.trim(),
    configPath: config.configPath,
    seededFrom: config.seededFrom,
  })
}

main().catch((error: unknown) => {
  console.error('')
  console.error(error instanceof Error ? error.message : String(error))
  console.error('')
  process.exit(1)
})
