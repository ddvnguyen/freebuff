import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { createAuth } from '../auth'
import { startProxy, type ProxyHandle } from '../proxy'

const PASSWORD = 'test-password-123'

let upstream: Bun.Server<unknown>
let proxy: ProxyHandle
let base: string
let cookie: string

function upstreamPort(): number {
  const port = upstream.port
  if (!port) throw new Error('fake orchestrator did not bind a port')
  return port
}

function openSocket(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers } as never)
    const timer = setTimeout(
      () => reject(new Error('websocket timed out')),
      3_000,
    )
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('websocket failed'))
    })
  })
}

beforeAll(async () => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, server) => {
      const url = new URL(request.url)
      if (url.pathname === '/api/ws') {
        if (server.upgrade(request, { data: undefined })) return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      if (url.pathname === '/') {
        return new Response('<html><body>upstream</body></html>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url.pathname === '/api/data') {
        return Response.json({ ok: true, source: 'upstream' })
      }
      if (url.pathname === '/api/echo') {
        return Response.json({
          body: await request.text(),
          origin: request.headers.get('origin'),
          cookie: request.headers.get('cookie'),
          forwardedFor: request.headers.get('x-forwarded-for'),
        })
      }
      if (url.pathname === '/api/stream') {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('data: one\n\n'))
            await Bun.sleep(250)
            controller.enqueue(encoder.encode('data: two\n\n'))
            controller.close()
          },
        })
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (url.pathname === '/api/auth/login/start') {
        return Response.json({
          url: `http://127.0.0.1:${upstreamPort()}/auth/login/launch/tok`,
          attemptId: 'attempt-1',
        })
      }
      if (url.pathname === '/api/setcookie') {
        return new Response('ok', {
          headers: { 'set-cookie': 'flavor=vanilla; Path=/' },
        })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        ws.send(message)
      },
    },
  })

  const auth = createAuth({
    passwordHash: await Bun.password.hash(PASSWORD, { algorithm: 'argon2id' }),
    sessionSecret: 'proxy-test-secret',
  })
  proxy = startProxy({
    hostname: '127.0.0.1',
    port: 0,
    orchestratorPort: upstreamPort(),
    auth,
    secureCookie: false,
  })
  base = `http://127.0.0.1:${proxy.port}`

  const login = await fetch(`${base}/__freebuff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: 'manual',
  })
  if (login.status !== 303) throw new Error(`login failed: ${login.status}`)
  const setCookie = login.headers.get('set-cookie')
  if (!setCookie) throw new Error('login did not set a cookie')
  cookie = setCookie.split(';')[0]!
})

afterAll(async () => {
  await proxy?.stop()
  await upstream?.stop(true)
})

describe('authentication gate', () => {
  it('answers health checks without a session', async () => {
    const response = await fetch(`${base}/__freebuff/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, app: 'freebuff-web' })
  })

  it('redirects document requests to the login page', async () => {
    const response = await fetch(`${base}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/__freebuff/login')
  })

  it('returns 401 rather than HTML for unauthenticated API calls', async () => {
    const response = await fetch(`${base}/api/data`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('rejects a wrong password and accepts the configured one', async () => {
    const wrong = await fetch(`${base}/__freebuff/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'nope' }).toString(),
      redirect: 'manual',
    })
    expect(wrong.status).toBe(401)

    const right = await fetch(`${base}/__freebuff/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: 'manual',
    })
    expect(right.status).toBe(303)
    expect(right.headers.get('set-cookie')).toContain('HttpOnly')
    expect(right.headers.get('set-cookie')).toContain('SameSite=Strict')
  })

  it('accepts the opaque origin embedded webviews send on the login form', async () => {
    const response = await fetch(`${base}/__freebuff/login`, {
      method: 'POST',
      headers: {
        origin: 'null',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
  })

  it('clears the session on logout', async () => {
    const response = await fetch(`${base}/__freebuff/logout`, {
      method: 'POST',
      headers: { cookie },
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('authenticated proxying', () => {
  it('passes reads to the orchestrator', async () => {
    const response = await fetch(`${base}/api/data`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, source: 'upstream' })
  })

  it('passes a request body and rewrites Origin', async () => {
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: {
        cookie,
        origin: base,
        'content-type': 'text/plain',
      },
      body: 'hello upstream',
    })
    expect(response.status).toBe(200)
    const echoed = (await response.json()) as Record<string, string | null>
    expect(echoed.body).toBe('hello upstream')
    expect(echoed.origin).toBe(`http://127.0.0.1:${upstreamPort()}`)
    expect(echoed.cookie).toBeNull()
  })

  it('refuses a cross-origin mutation', async () => {
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://evil.example',
        'content-type': 'text/plain',
      },
      body: 'nope',
    })
    expect(response.status).toBe(403)
  })

  it('rewrites the loopback sign-in launch URL in a JSON body', async () => {
    const response = await fetch(`${base}/api/auth/login/start`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      url: '/auth/login/launch/tok',
      attemptId: 'attempt-1',
    })
  })

  it('passes upstream cookies through', async () => {
    const response = await fetch(`${base}/api/setcookie`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('flavor=vanilla')
  })

  it('streams SSE chunks without waiting for the whole response', async () => {
    const response = await fetch(`${base}/api/stream`, { headers: { cookie } })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    const startedAt = performance.now()
    const first = await reader.read()
    const firstChunkMs = performance.now() - startedAt
    expect(decoder.decode(first.value)).toContain('data: one')
    expect(firstChunkMs).toBeLessThan(150)

    const second = await reader.read()
    expect(decoder.decode(second.value)).toBe('data: two\n\n')
  })

  it('proxies WebSocket messages in both directions', async () => {
    const socket = await openSocket(`ws://127.0.0.1:${proxy.port}/api/ws`, {
      cookie,
    })
    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('echo timed out')), 3_000)
      socket.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
      })
    })
    socket.send('hello socket')
    expect(await received).toBe('hello socket')
    socket.close()
  })

  it('does not upgrade an unauthenticated WebSocket', async () => {
    await expect(
      openSocket(`ws://127.0.0.1:${proxy.port}/api/ws`, {}),
    ).rejects.toThrow()
  })
})
