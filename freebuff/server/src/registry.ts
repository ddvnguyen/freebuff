import { open } from 'node:fs/promises'

export type ManagedAccount = {
  accountId: string
  runtimeId: string
  label: string
  port: number
  pid: number
  launchId: string
}

/** The registry is a hint: only a matching authenticated health response is live. */
export async function readRegistry(
  path: string | null,
): Promise<ManagedAccount[]> {
  if (!path) return []
  try {
    const file = await open(path, 'r')
    let raw: string
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.size > 1024 * 1024 ||
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())
      )
        return []
      raw = await file.readFile('utf8')
    } finally {
      await file.close()
    }
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.length > 1000) return []
    const seen = new Set<string>()
    const result: ManagedAccount[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') return []
      const a = item as Record<string, unknown>
      if (
        typeof a.accountId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(a.accountId) ||
        typeof a.runtimeId !== 'string' ||
        !a.runtimeId ||
        typeof a.label !== 'string' ||
        a.label.length > 512 ||
        !Number.isInteger(a.port) ||
        (a.port as number) < 1 ||
        (a.port as number) > 65535 ||
        !Number.isInteger(a.pid) ||
        (a.pid as number) < 1 ||
        typeof a.launchId !== 'string' ||
        !/^[a-f0-9]{32}$/.test(a.launchId) ||
        seen.has(a.accountId)
      )
        return []
      seen.add(a.accountId)
      result.push(a as ManagedAccount)
    }
    return result
  } catch {
    return []
  }
}

export async function accountIsLive(account: ManagedAccount): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${account.port}/healthz`, {
      headers: { 'x-freebuff-launch-id': account.launchId },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const health = (await response.json()) as Record<string, unknown>
    return (
      health.ok === true &&
      health.launchId === account.launchId &&
      health.pid === account.pid &&
      health.port === account.port
    )
  } catch {
    return false
  }
}
