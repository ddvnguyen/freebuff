import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAuth } from '../auth'
import { startProxy, type ProxyHandle } from '../proxy'

const dir = mkdtempSync('/mnt/workspace/tmp/freebuff-registry-test-')
const path = join(dir, 'registry.json')
const launch = '0123456789abcdef0123456789abcdef'
let upstream: Bun.Server<unknown>,
  proxy: ProxyHandle,
  base: string,
  session: string,
  otherSession: string

beforeAll(async () => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      if (
        url.pathname === '/healthz' &&
        req.headers.get('x-freebuff-launch-id') === launch
      )
        return Response.json({
          ok: true,
          launchId: launch,
          pid: 42,
          port: server.port,
        })
      if (req.headers.get('x-freebuff-launch-id') !== launch)
        return new Response('denied', { status: 401 })
      if (url.pathname === '/ws') {
        if (server.upgrade(req, { data: undefined })) return
        return new Response('failed', { status: 400 })
      }
      if (url.pathname === '/events') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return Response.json({ account: 'managed' })
    },
    websocket: {
      message(ws, message) {
        ws.send(message)
      },
    },
  })
  writeFileSync(
    path,
    JSON.stringify([
      {
        accountId: 'a1',
        runtimeId: 'rt',
        label: 'Account One',
        port: upstream.port,
        pid: 42,
        launchId: launch,
      },
    ]),
    { mode: 0o600 },
  )
  const auth = createAuth({
    passwordHash: await Bun.password.hash('test-password'),
    sessionSecret: 'test-secret',
  })
  proxy = startProxy({
    hostname: '127.0.0.1',
    port: 0,
    orchestratorPort: upstream.port!,
    auth,
    secureCookie: false,
    registryPath: path,
  })
  base = `http://127.0.0.1:${proxy.port}`
  session = `${auth.cookieName}=${auth.createSessionValue()}`
  otherSession = `${auth.cookieName}=${auth.createSessionValue()}`
})
afterAll(async () => {
  await proxy.stop()
  await upstream.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

test('selector routes authenticated HTTP and fails closed for stale identity', async () => {
  const page = await fetch(`${base}/__freebuff/accounts`, {
    headers: { cookie: session },
  })
  const html = await page.text()
  expect(html).toContain('Account One')
  expect(html).not.toContain(launch)
  expect(html).not.toContain(String(upstream.port))
  const unknown = await fetch(`${base}/__freebuff/accounts`, {
    method: 'POST',
    headers: {
      cookie: session,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'account=unknown',
    redirect: 'manual',
  })
  expect(unknown.status).toBe(404)
  const selected = await fetch(`${base}/__freebuff/accounts`, {
    method: 'POST',
    headers: {
      cookie: session,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
    },
    body: 'account=a1',
    redirect: 'manual',
  })
  expect(selected.status).toBe(303)
  const cookies = selected.headers.getSetCookie()
  expect(
    cookies.every(
      (c) =>
        c.includes('HttpOnly') &&
        c.includes('SameSite=Lax') &&
        c.includes('Secure'),
    ),
  ).toBe(true)
  const selection = cookies.map((c) => c.split(';')[0]).join('; ')
  const response = await fetch(`${base}/api/data`, {
    headers: {
      cookie: `${session}; ${selection}`,
      'x-freebuff-launch-id': 'forged',
    },
  })
  expect(await response.json()).toEqual({ account: 'managed' })
  const health = await fetch(`${base}/healthz`, {
    headers: { cookie: `${session}; ${selection}` },
  })
  expect(health.status).toBe(404)
  const unauth = await fetch(`${base}/api/data`, {
    headers: { cookie: selection },
  })
  expect(unauth.status).toBe(401)
  const wrongSession = await fetch(`${base}/api/data`, {
    headers: { cookie: `${otherSession}; ${selection}` },
  })
  expect(wrongSession.status).toBe(403)
  writeFileSync(
    path,
    JSON.stringify([
      {
        accountId: 'a1',
        runtimeId: 'rt',
        label: 'Account One',
        port: upstream.port,
        pid: 99,
        launchId: launch,
      },
    ]),
  )
  const stale = await fetch(`${base}/api/data`, {
    headers: { cookie: `${session}; ${selection}` },
  })
  expect(stale.status).toBe(503)
})

test('switching selects a distinct account without forwarding the selector cookie', async () => {
  const other = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === '/healthz')
        return Response.json({
          ok: true,
          launchId: launch,
          pid: 43,
          port: server.port,
        })
      return Response.json({
        account: 'other',
        cookie: req.headers.get('cookie'),
        token: req.headers.get('x-freebuff-launch-id') === launch,
      })
    },
  })
  try {
    writeFileSync(
      path,
      JSON.stringify([
        {
          accountId: 'a1',
          runtimeId: 'rt',
          label: 'One',
          port: upstream.port,
          pid: 42,
          launchId: launch,
        },
        {
          accountId: 'a2',
          runtimeId: 'rt',
          label: 'Two',
          port: other.port,
          pid: 43,
          launchId: launch,
        },
      ]),
    )
    const selected = await fetch(`${base}/__freebuff/accounts`, {
      method: 'POST',
      headers: {
        cookie: session,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'account=a2',
      redirect: 'manual',
    })
    const cookies = selected.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const result = await fetch(`${base}/api/data`, {
      headers: { cookie: `${session}; ${cookies}` },
    })
    expect(await result.json()).toEqual({
      account: 'other',
      cookie: null,
      token: true,
    })
  } finally {
    await other.stop(true)
  }
})

test('switching accounts closes the existing authenticated WebSocket', async () => {
  writeFileSync(
    path,
    JSON.stringify([
      {
        accountId: 'a1',
        runtimeId: 'rt',
        label: 'Account One',
        port: upstream.port,
        pid: 42,
        launchId: launch,
      },
    ]),
  )
  const selected = await fetch(`${base}/__freebuff/accounts`, {
    method: 'POST',
    headers: {
      cookie: session,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'account=a1',
    redirect: 'manual',
  })
  const selection = selected.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/ws`, {
    headers: { cookie: `${session}; ${selection}` },
  } as never)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('socket failed'))
  })
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (event) => resolve(event.code)
  })
  const switched = await fetch(`${base}/__freebuff/accounts`, {
    method: 'POST',
    headers: {
      cookie: session,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'account=',
    redirect: 'manual',
  })
  expect(switched.status).toBe(303)
  expect(await closed).toBe(4001)
})

test('switching cancels an existing account event stream', async () => {
  writeFileSync(
    path,
    JSON.stringify([
      {
        accountId: 'a1',
        runtimeId: 'rt',
        label: 'Account One',
        port: upstream.port,
        pid: 42,
        launchId: launch,
      },
    ]),
  )
  const selected = await fetch(`${base}/__freebuff/accounts`, {
    method: 'POST',
    headers: {
      cookie: session,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'account=a1',
    redirect: 'manual',
  })
  const selection = selected.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const response = await fetch(`${base}/events`, {
    headers: { cookie: `${session}; ${selection}` },
  })
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await fetch(`${base}/__freebuff/accounts`, {
    method: 'POST',
    headers: {
      cookie: session,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'account=',
    redirect: 'manual',
  })
  const ended = await Promise.race([
    reader
      .read()
      .then((value) => value.done)
      .catch(() => true),
    Bun.sleep(1000).then(() => false),
  ])
  expect(ended).toBe(true)
})

test('rejects a registry that other users can read or change', async () => {
  chmodSync(path, 0o644)
  try {
    const page = await fetch(`${base}/__freebuff/accounts`, {
      headers: { cookie: session },
    })
    expect(await page.text()).not.toContain('Account One')
  } finally {
    chmodSync(path, 0o600)
  }
})
