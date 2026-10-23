import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'freebuff_web_session'
const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export type AuthOptions = {
  passwordHash: string
  sessionSecret: string
  cookieName?: string
  sessionTtlSeconds?: number
  secureCookie?: boolean
  now?: () => number
}

export type SessionCookieOptions = {
  secure: boolean
  maxAgeSeconds: number
}

export function parseCookieHeader(
  header: string | null,
): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    if (!name || name in cookies) continue
    let value = part.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    cookies[name] = value
  }
  return cookies
}

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class LoginLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly maxAttempts = 6,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds until this key may try again, or 0 when it is allowed. */
  blockedFor(key: string): number {
    this.prune()
    const entry = this.attempts.get(key)
    if (!entry) return 0
    const remaining = entry.resetAt - this.now()
    if (remaining <= 0) {
      this.attempts.delete(key)
      return 0
    }
    return entry.count >= this.maxAttempts ? remaining : 0
  }

  recordFailure(key: string): void {
    this.prune()
    const now = this.now()
    const entry = this.attempts.get(key)
    if (!entry || entry.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    entry.count += 1
  }

  reset(key: string): void {
    this.attempts.delete(key)
  }

  private prune(): void {
    if (this.attempts.size < 1024) return
    const now = this.now()
    for (const [key, entry] of this.attempts) {
      if (entry.resetAt <= now) this.attempts.delete(key)
    }
  }
}

export type Auth = {
  cookieName: string
  sessionTtlSeconds: number
  loginLimiter: LoginLimiter
  verifyPassword: (candidate: string) => Promise<boolean>
  isAuthenticated: (request: Request) => boolean
  sessionCookie: (options: SessionCookieOptions) => string
  clearCookie: (secure: boolean) => string
  createSessionValue: () => string
}

export function createAuth(options: AuthOptions): Auth {
  const cookieName = options.cookieName ?? SESSION_COOKIE
  const sessionTtlSeconds =
    options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS
  const now = options.now ?? Date.now
  const loginLimiter = new LoginLimiter(undefined, undefined, now)

  const createSessionValue = (): string => {
    const expiresAt = now() + sessionTtlSeconds * 1000
    const nonce = randomBytes(18).toString('base64url')
    const payload = `${expiresAt}.${nonce}`
    return `${payload}.${sign(options.sessionSecret, payload)}`
  }

  const verifySessionValue = (value: string | undefined): boolean => {
    if (!value) return false
    const parts = value.split('.')
    if (parts.length !== 3) return false
    const [expiresRaw, nonce, signature] = parts as [string, string, string]
    const expiresAt = Number(expiresRaw)
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) return false
    const expected = sign(options.sessionSecret, `${expiresRaw}.${nonce}`)
    return safeEqual(signature, expected)
  }

  const isAuthenticated = (request: Request): boolean => {
    const cookies = parseCookieHeader(request.headers.get('cookie'))
    return verifySessionValue(cookies[cookieName])
  }

  return {
    cookieName,
    sessionTtlSeconds,
    loginLimiter,
    verifyPassword: (candidate) =>
      Bun.password.verify(candidate, options.passwordHash),
    isAuthenticated,
    createSessionValue,
    sessionCookie: ({ secure, maxAgeSeconds }) => {
      const attributes = [
        `${cookieName}=${createSessionValue()}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAgeSeconds}`,
      ]
      if (secure) attributes.push('Secure')
      return attributes.join('; ')
    },
    clearCookie: (secure) => {
      const attributes = [
        `${cookieName}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=0',
      ]
      if (secure) attributes.push('Secure')
      return attributes.join('; ')
    },
  }
}
