import { open } from 'node:fs/promises'

export type ManagedAccount = {
  accountId: string
  runtimeId: string
  label: string
  port: number
  pid: number
  launchId: string
}

/**
 * The registry is a hint: only a matching authenticated health response is live.
 *
 * Nothing else in the file is trusted beyond shape — a bad entry is skipped, so
 * one malformed row cannot hide every account. A file whose permissions, owner
 * or shape as a whole is wrong is still rejected outright.
 */
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
    for (const [index, item] of value.entries()) {
      const problem = entryProblem(item, seen)
      if (problem) {
        // Never echo the entry: it carries a launch token.
        console.warn(`[registry] skipping entry ${index}: ${problem}`)
        continue
      }
      const account = item as ManagedAccount
      seen.add(account.accountId)
      result.push(account)
    }
    return result
  } catch {
    return []
  }
}

function entryProblem(item: unknown, seen: Set<string>): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item))
    return 'not an object'
  const a = item as Record<string, unknown>
  if (typeof a.accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(a.accountId))
    return 'invalid accountId'
  if (typeof a.runtimeId !== 'string' || !a.runtimeId) return 'invalid runtimeId'
  if (typeof a.label !== 'string' || a.label.length > 512) return 'invalid label'
  if (!Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65535)
    return 'invalid port'
  if (!Number.isInteger(a.pid) || (a.pid as number) < 1) return 'invalid pid'
  if (typeof a.launchId !== 'string' || !/^[a-f0-9]{32}$/.test(a.launchId))
    return 'invalid launchId'
  if (seen.has(a.accountId)) return 'duplicate accountId'
  return null
}

/**
 * Whether the recorded process still answers as this account.
 *
 * `/healthz` is the contract. Captured from a real managed orchestrator
 * (slimmer build, commit 7807c228, launched headless with FREEBUFF_LAUNCH_ID):
 *
 *   GET /healthz                              -> 401 {"error":"invalid launch id"}
 *   GET /healthz  x-freebuff-launch-id: <id>  -> 200 {"ok":true,"launchId":"<id>",
 *                                                     "pid":1887329,"port":40299}
 *
 * `launchId` is random per launch, so it alone rules out port and pid reuse and
 * is the only identity field required. `pid` and `port` are corroborated when
 * the endpoint reports them — it does today — but never demanded, so an
 * orchestrator build that trims the payload still reads as live instead of
 * showing every account offline.
 */
export async function accountIsLive(account: ManagedAccount): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${account.port}/healthz`, {
      headers: { 'x-freebuff-launch-id': account.launchId },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const health = (await response.json()) as Record<string, unknown>
    if (health.ok !== true || health.launchId !== account.launchId) return false
    if (typeof health.pid === 'number' && health.pid !== account.pid) return false
    if (typeof health.port === 'number' && health.port !== account.port) return false
    return true
  } catch {
    return false
  }
}
