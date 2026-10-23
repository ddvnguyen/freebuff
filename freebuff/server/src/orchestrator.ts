import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type FreebuffBundle = {
  resourcesDir: string
  orchestratorPath: string
  uiDir: string
  wasmDir: string | null
  bun: string
  gitDir: string | null
  /** ripgrep for this platform, from the app bundle, this repo, or PATH. */
  rgPath: string | null
  /** Whether these assets came from an install or the vendored runtime. */
  source: 'desktop' | 'vendored'
}

export type ReadyAnnouncement = {
  launchId: string | null
  pid: number
  port: number
}

function overrideResourceCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  const override = env.FREEBUFF_APP_PATH?.trim()
  if (override) {
    const resolved = path.resolve(override)
    if (resolved.endsWith('orchestrator.js')) {
      candidates.push(path.dirname(path.dirname(resolved)))
    } else if (resolved.endsWith('.app')) {
      candidates.push(path.join(resolved, 'Contents', 'Resources'))
    } else if (path.basename(resolved) === 'Resources') {
      candidates.push(resolved)
    } else if (path.basename(resolved) === 'orchestrator') {
      candidates.push(path.dirname(resolved))
    } else {
      // A user-supplied install root: try the common shapes below it.
      candidates.push(
        path.join(resolved, 'Contents', 'Resources'),
        path.join(resolved, 'resources'),
        resolved,
      )
    }
  }
  return candidates
}

function desktopResourceCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const candidates: string[] = []

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Freebuff.app/Contents/Resources',
      path.join(home, 'Applications', 'Freebuff.app', 'Contents', 'Resources'),
    )
  } else if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    const programFiles = env.PROGRAMFILES?.trim()
    if (localAppData) {
      candidates.push(
        path.join(localAppData, 'Programs', 'Freebuff', 'resources'),
      )
    }
    if (programFiles) {
      candidates.push(path.join(programFiles, 'Freebuff', 'resources'))
    }
  } else {
    candidates.push(
      '/opt/Freebuff/resources',
      '/opt/freebuff/resources',
      '/usr/lib/freebuff/resources',
      path.join(home, '.local', 'share', 'freebuff', 'resources'),
    )
  }
  return [...new Set(candidates)]
}

/** `freebuff/server/runtime`, exported from an installed Desktop app. */
function vendoredResourcesDir(env: NodeJS.ProcessEnv): string | null {
  const override = env.FREEBUFF_RUNTIME_DIR?.trim()
  if (override) return path.resolve(override)
  const candidate = path.resolve(import.meta.dir, '..', 'runtime')
  return existsSync(candidate) ? candidate : null
}

const RG_PLATFORM_DIRS: Record<string, string> = {
  'darwin-arm64': 'arm64-darwin',
  'darwin-x64': 'x64-darwin',
  'linux-arm64': 'arm64-linux',
  'linux-x64': 'x64-linux',
  'win32-arm64': 'arm64-win32',
  'win32-x64': 'x64-win32',
}

function resolveRipgrep(
  resourcesDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const configured = env.CODEBUFF_RG_PATH?.trim()
  if (configured) return configured

  const platformDir = RG_PLATFORM_DIRS[`${process.platform}-${process.arch}`]
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  if (platformDir) {
    const repositoryRoot = path.resolve(import.meta.dir, '../../..')
    for (const candidate of [
      path.join(
        resourcesDir,
        'orchestrator',
        'vendor',
        'ripgrep',
        platformDir,
        binary,
      ),
      path.join(
        repositoryRoot,
        'sdk',
        'vendor',
        'ripgrep',
        platformDir,
        binary,
      ),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return Bun.which('rg') ?? null
}

function bundleAt(
  resourcesDir: string,
  env: NodeJS.ProcessEnv,
  source: FreebuffBundle['source'],
): FreebuffBundle | null {
  const orchestratorPath = path.join(
    resourcesDir,
    'orchestrator',
    'orchestrator.js',
  )
  const uiDir = path.join(resourcesDir, 'orchestrator', 'ui')
  if (
    !existsSync(orchestratorPath) ||
    !existsSync(path.join(uiDir, 'index.html'))
  ) {
    return null
  }

  const wasmDir = path.join(resourcesDir, 'orchestrator', 'wasm')
  const hasWasm = existsSync(path.join(wasmDir, 'tree-sitter.wasm'))
  const gitDir = path.join(resourcesDir, 'git')

  return {
    resourcesDir,
    orchestratorPath,
    uiDir,
    wasmDir: hasWasm ? wasmDir : null,
    bun: executableBun(resourcesDir, env),
    gitDir: existsSync(gitDir) ? gitDir : null,
    rgPath: resolveRipgrep(resourcesDir, env),
    source,
  }
}

function executableBun(resourcesDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.FREEBUFF_BUN_PATH?.trim()
  if (override) return override

  const bundled = path.join(
    resourcesDir,
    'bun',
    process.platform === 'win32' ? 'bun.exe' : 'bun',
  )
  if (existsSync(bundled)) return bundled

  // We are already running on Bun: reuse this exact runtime rather than guessing
  // at a PATH that a double-clicked launcher may not have inherited.
  if (path.basename(process.execPath).toLowerCase().startsWith('bun')) {
    return process.execPath
  }
  const onPath = Bun.which('bun')
  if (onPath) return onPath
  return 'bun'
}

/** Resolve one explicit app path, without falling back to other installs. */
export function findFreebuffBundleAt(
  appPath: string,
  env: NodeJS.ProcessEnv = process.env,
): FreebuffBundle | null {
  const candidates = overrideResourceCandidates({
    ...env,
    FREEBUFF_APP_PATH: appPath,
  })
  for (const resourcesDir of new Set(candidates)) {
    const bundle = bundleAt(path.resolve(resourcesDir), env, 'desktop')
    if (bundle) return bundle
  }
  return null
}

/** Just the installed Desktop app, ignoring the vendored runtime. */
export function findInstalledFreebuffBundle(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): FreebuffBundle | null {
  const candidates = [
    ...overrideResourceCandidates(env),
    ...desktopResourceCandidates(env, home),
  ]
  for (const resourcesDir of new Set(candidates)) {
    const bundle = bundleAt(path.resolve(resourcesDir), env, 'desktop')
    if (bundle) return bundle
  }
  return null
}

export function findFreebuffBundle(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): FreebuffBundle {
  const candidates: Array<{
    resourcesDir: string
    source: FreebuffBundle['source']
  }> = []
  const add = (resourcesDir: string, source: FreebuffBundle['source']) => {
    const resolved = path.resolve(resourcesDir)
    if (!candidates.some((entry) => entry.resourcesDir === resolved)) {
      candidates.push({ resourcesDir: resolved, source })
    }
  }

  // An explicit runtime wins so it can be used to test an export on a machine
  // that also has Desktop installed.
  const explicitRuntime = env.FREEBUFF_RUNTIME_DIR?.trim()
  if (explicitRuntime) add(explicitRuntime, 'vendored')
  for (const resourcesDir of overrideResourceCandidates(env)) {
    add(resourcesDir, 'desktop')
  }
  for (const resourcesDir of desktopResourceCandidates(env, home)) {
    add(resourcesDir, 'desktop')
  }
  const vendored = vendoredResourcesDir(env)
  if (vendored) add(vendored, 'vendored')

  for (const candidate of candidates) {
    const bundle = bundleAt(candidate.resourcesDir, env, candidate.source)
    if (bundle) return bundle
  }

  throw new Error(
    [
      'Freebuff Desktop was not found and no vendored runtime is available.',
      'Install Freebuff Desktop, point FREEBUFF_APP_PATH at the app bundle',
      '(/Applications/Freebuff.app on macOS) or its Resources directory,',
      'or export the runtime on a machine that has Desktop installed:',
      '',
      '  bun --cwd freebuff/server run export-runtime',
      '',
      `Looked in:\n  ${candidates.map((entry) => entry.resourcesDir).join('\n  ')}`,
    ].join('\n'),
  )
}

export function parseReadyAnnouncement(line: string): ReadyAnnouncement | null {
  const prefix = '[orchestrator-ready] '
  if (!line.startsWith(prefix)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(prefix.length))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null
  const record = parsed as Record<string, unknown>
  const port = record.port
  const pid = record.pid
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    return null
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  const launchId = typeof record.launchId === 'string' ? record.launchId : null
  return { launchId, pid, port }
}

export type OrchestratorHandle = {
  port: number
  pid: number
  bundle: FreebuffBundle
  logPath: string
  stop: () => Promise<void>
}

export type StartOrchestratorOptions = {
  bundle: FreebuffBundle
  profilePath: string
  logPath: string
  timeoutMs?: number
  onUnexpectedExit?: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void
}

function childEnvironment(
  bundle: FreebuffBundle,
  profilePath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '0',
    FREEBUFF_UI_DIR: bundle.uiDir,
    FREEBUFF_DESKTOP_STATE_PATH: profilePath,
    ...(bundle.rgPath ? { CODEBUFF_RG_PATH: bundle.rgPath } : {}),
    // A second server on the same profile must fail fast rather than hang.
    FREEBUFF_PROFILE_LOCK_WAIT_MS: '0',
    // Marks a hand-run (non-Electron) launch for the orchestrator's own logs.
    FREEBUFF_WEB_SERVER: '1',
  }
  if (bundle.wasmDir) {
    env.CODEBUFF_WASM_DIR = bundle.wasmDir
    env.CODEBUFF_TREE_SITTER_WASM_PATH = path.join(
      bundle.wasmDir,
      'tree-sitter.wasm',
    )
  }
  if (bundle.gitDir) env.FREEBUFF_GIT_DIR = bundle.gitDir

  // Never inherit a Desktop shell's private channels. This process is the shell.
  for (const key of [
    'FREEBUFF_SHELL_LIFETIME_PORT',
    'FREEBUFF_CDP_BRIDGE_PORT',
    'FREEBUFF_CDP_BRIDGE_TOKEN',
    'FREEBUFF_MCP_CONSENT_PORT',
    'FREEBUFF_MCP_CONSENT_TOKEN',
    'FREEBUFF_DESKTOP_UI_ORIGIN',
    'FREEBUFF_DESKTOP_SAFE_STORAGE',
    'ELECTRON_RUN_AS_NODE',
  ]) {
    delete env[key]
  }
  return env
}

export async function startOrchestrator(
  options: StartOrchestratorOptions,
): Promise<OrchestratorHandle> {
  const { bundle, profilePath, logPath } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 })
  const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 })
  log.write(
    `\n[${new Date().toISOString()}] starting orchestrator from ${bundle.resourcesDir}\n`,
  )

  const child: ChildProcessWithoutNullStreams = spawn(
    bundle.bun,
    [bundle.orchestratorPath],
    {
      cwd: path.dirname(bundle.orchestratorPath),
      env: childEnvironment(bundle, profilePath),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  let readyAnnouncement: ReadyAnnouncement | null = null
  let settled = false
  let stopping = false
  const tail: string[] = []

  const appendTail = (line: string) => {
    tail.push(line)
    if (tail.length > 40) tail.shift()
  }

  const ready = new Promise<ReadyAnnouncement>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new Error(
          [
            `Freebuff's orchestrator did not become ready within ${timeoutMs}ms.`,
            tail.length ? `Last output:\n${tail.join('\n')}` : '',
            `Full log: ${logPath}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      )
    }, timeoutMs)
    timer.unref?.()

    const finish = (announcement: ReadyAnnouncement) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      readyAnnouncement = announcement
      resolve(announcement)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    const handleLine = (line: string) => {
      appendTail(line)
      log.write(`${line}\n`)
      if (
        line.includes('[auth]') ||
        line.includes('[shutdown]') ||
        /error/i.test(line)
      ) {
        console.error(`[orchestrator] ${line}`)
      }
      const announcement = parseReadyAnnouncement(line)
      if (announcement) finish(announcement)
    }

    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        handleLine(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (!line) continue
        appendTail(line)
        log.write(`${line}\n`)
        if (/error/i.test(line)) console.error(`[orchestrator] ${line}`)
      }
    })

    child.once('error', (error) => {
      log.write(`[spawn] ${error.message}\n`)
      fail(new Error(`Could not start the orchestrator: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      log.write(`[exit] code=${code} signal=${signal}\n`)
      if (!settled) {
        fail(
          new Error(
            [
              `Freebuff's orchestrator exited before it was ready (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`,
              tail.length ? `Last output:\n${tail.join('\n')}` : '',
              `Full log: ${logPath}`,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        )
        return
      }
      if (!stopping) {
        log.end()
        options.onUnexpectedExit?.(code ?? null, signal ?? null)
      }
    })
  })

  try {
    const announcement = await ready
    if (!child.pid)
      throw new Error('Orchestrator started without a process id.')

    return {
      port: announcement.port,
      pid: child.pid,
      bundle,
      logPath,
      stop: async () => {
        if (stopping) return
        stopping = true
        if (child.exitCode !== null || child.signalCode !== null) {
          log.end()
          return
        }
        const exited = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        )
        child.kill('SIGTERM')
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL')
        }, 5_000)
        await exited
        clearTimeout(timer)
        log.end()
      },
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    log.end()
    throw error
  }
}

/** Small helper used by the banner: version from a runtime manifest or Info.plist. */
export function readAppVersion(bundle: FreebuffBundle): string | null {
  const manifestPath = path.join(bundle.resourcesDir, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        version?: unknown
      }
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version
      }
    } catch {
      // Fall through to the macOS app metadata.
    }
  }
  if (process.platform !== 'darwin') return null
  const plist = path.join(path.dirname(bundle.resourcesDir), 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    const text = readFileSync(plist, 'utf8')
    const match = text.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    )
    return match?.[1] ?? null
  } catch {
    return null
  }
}
