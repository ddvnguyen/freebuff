import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { startProxy, type ProxyHandle } from '../proxy'

let upstream: Bun.Server<unknown>
let proxy: ProxyHandle
let base: string

function upstreamPort(): number {
  const port = upstream.port
  if (!port) throw new Error('fake orchestrator did not bind a port')
  return port
}

beforeAll(() => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) => {
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
        return Response.json({ ok: true })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        ws.send(message)
      },
    },
  })

  proxy = startProxy({
    hostname: '127.0.0.1',
    port: 0,
    orchestratorPort: upstreamPort(),
    auth: null,
    secureCookie: false,
  })
  base = `http://127.0.0.1:${proxy.port}`
})

afterAll(async () => {
  await proxy?.stop()
  await upstream?.stop(true)
})

describe('no-auth mode', () => {
  it('serves documents without a session', async () => {
    const response = await fetch(`${base}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('upstream')
  })

  it('serves API calls without a session', async () => {
    const response = await fetch(`${base}/api/data`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('sends the login page back to the app', async () => {
    const response = await fetch(`${base}/__freebuff/login`, {
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
  })

  it('accepts an unauthenticated WebSocket', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/ws`)
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('socket timed out')),
        3_000,
      )
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('socket failed'))
      })
    })
    await opened

    const echoed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('echo timed out')), 3_000)
      socket.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
      })
    })
    socket.send('hello without a password')
    expect(await echoed).toBe('hello without a password')
    socket.close()
  })
})
