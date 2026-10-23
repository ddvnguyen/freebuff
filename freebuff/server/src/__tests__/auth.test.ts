import { describe, expect, it } from 'bun:test'

import {
  createAuth,
  LoginLimiter,
  parseCookieHeader,
  SESSION_COOKIE,
} from '../auth'

async function makeAuth(now = () => Date.now()) {
  const passwordHash = await Bun.password.hash('correct horse', {
    algorithm: 'argon2id',
  })
  return createAuth({
    passwordHash,
    sessionSecret: 'test-secret',
    sessionTtlSeconds: 60,
    now,
  })
}

function requestWithCookie(value: string): Request {
  return new Request('http://localhost/', {
    headers: { cookie: `${SESSION_COOKIE}=${value}` },
  })
}

describe('parseCookieHeader', () => {
  it('parses multiple cookies and ignores malformed parts', () => {
    expect(parseCookieHeader('a=1; b=two; broken; c="quoted"')).toEqual({
      a: '1',
      b: 'two',
      c: 'quoted',
    })
  })

  it('returns an empty object without a header', () => {
    expect(parseCookieHeader(null)).toEqual({})
  })
})

describe('sessions', () => {
  it('verifies a session it issued', async () => {
    const auth = await makeAuth()
    const value = auth.createSessionValue()
    expect(auth.isAuthenticated(requestWithCookie(value))).toBe(true)
  })

  it('rejects a tampered signature', async () => {
    const auth = await makeAuth()
    const value = auth.createSessionValue()
    const tampered = `${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`
    expect(auth.isAuthenticated(requestWithCookie(tampered))).toBe(false)
  })

  it('rejects an expired session', async () => {
    let now = 1_000
    const auth = await makeAuth(() => now)
    const value = auth.createSessionValue()
    expect(auth.isAuthenticated(requestWithCookie(value))).toBe(true)
    now += 61_000
    expect(auth.isAuthenticated(requestWithCookie(value))).toBe(false)
  })

  it('rejects sessions signed with a different secret', async () => {
    const auth = await makeAuth()
    const other = createAuth({
      passwordHash: await Bun.password.hash('other', { algorithm: 'argon2id' }),
      sessionSecret: 'different-secret',
    })
    const value = other.createSessionValue()
    expect(auth.isAuthenticated(requestWithCookie(value))).toBe(false)
  })

  it('verifies the configured password only', async () => {
    const auth = await makeAuth()
    expect(await auth.verifyPassword('correct horse')).toBe(true)
    expect(await auth.verifyPassword('wrong')).toBe(false)
  })
})

describe('LoginLimiter', () => {
  it('blocks after the configured number of failures and resets on success', () => {
    let now = 0
    const limiter = new LoginLimiter(3, 60_000, () => now)
    expect(limiter.blockedFor('ip')).toBe(0)
    for (let i = 0; i < 3; i++) limiter.recordFailure('ip')
    expect(limiter.blockedFor('ip')).toBeGreaterThan(0)
    limiter.reset('ip')
    expect(limiter.blockedFor('ip')).toBe(0)
  })

  it('lets the window expire', () => {
    let now = 0
    const limiter = new LoginLimiter(1, 1_000, () => now)
    limiter.recordFailure('ip')
    expect(limiter.blockedFor('ip')).toBeGreaterThan(0)
    now = 1_001
    expect(limiter.blockedFor('ip')).toBe(0)
  })
})
