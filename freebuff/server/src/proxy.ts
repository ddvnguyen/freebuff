import { createHmac, timingSafeEqual } from 'node:crypto'
import { parseCookieHeader, type Auth } from './auth'
import { renderLoginPage } from './login-page'
import { accountIsLive, readRegistry, type ManagedAccount } from './registry'

const LOGIN_PATH = '/__freebuff/login'
const LOGOUT_PATH = '/__freebuff/logout'
const HEALTH_PATH = '/__freebuff/health'
const ACCOUNTS_PATH = '/__freebuff/accounts'
const ACCOUNT_COOKIE = 'freebuff_web_account'
const ACCOUNT_SIGNATURE = 'freebuff_web_account_signature'
const LOGIN_START_PATH = '/api/auth/login/start'
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const MAX_LOGIN_BODY_BYTES = 8 * 1024
const MAX_SOCKET_QUEUE = 256

type SocketData = {
  session: string
  upstreamUrl: string
  headers: Record<string, string>
  upstream: WebSocket | null
  queue: Array<string | Uint8Array | ArrayBuffer>
  closed: boolean
}

export type ProxyOptions = {
  hostname: string
  port: number
  orchestratorPort: number
  /** null disables the password gate (FREEBUFF_WEB_NO_AUTH). */
  auth: Auth | null
  secureCookie: boolean
  registryPath?: string | null
  launchId?: string
  accountLabel?: string
  tls?: { cert: string; key: string } | null
}

export type ProxyHandle = {
  port: number
  hostname: string
  stop: () => Promise<void>
}

function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  )
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...securityHeaders(),
    },
  })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function redirect(location: string, status = 303): Response {
  return new Response(null, {
    status,
    headers: { location, 'cache-control': 'no-store' },
  })
}

function isDocumentRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-mode') === 'navigate') return true
  return (request.headers.get('accept') ?? '').includes('text/html')
}

function stripCookie(
  header: string,
  omitNames: string[],
  omitLaunch = false,
): string {
  const omit = new Set(omitNames)
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, Math.max(0, part.indexOf('='))).trim()
      return (
        name &&
        !omit.has(name) &&
        !(omitLaunch && name.startsWith('freebuff_launch_'))
      )
    })
    .join('; ')
}

function upstreamOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

function rewriteLocation(value: string, port: number): string {
  for (const origin of [upstreamOrigin(port), `http://localhost:${port}`]) {
    if (value.startsWith(origin)) {
      return value.slice(origin.length) || '/'
    }
  }
  return value
}

/**
 * The orchestrator builds its sign-in launch URL from its own loopback origin
 * and returns it in a JSON body, which the browser would follow to a port only
 * this host can reach. Strip the origin so the URL resolves through the proxy.
 */
function rewriteBodyOrigins(value: string, port: number): string {
  return value
    .replaceAll(upstreamOrigin(port), '')
    .replaceAll(`http://localhost:${port}`, '')
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  if (origin === 'null') {
    // Some browsers and embedded webviews (including Freebuff's own preview
    // panel) send an opaque origin on a form POST and omit Fetch Metadata.
    // Allowing it is safe here: proxied mutations still need the HttpOnly,
    // SameSite=Strict session cookie, and the login form only checks the
    // password, so a cross-site blank POST gains nothing.
    return true
  }
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

function clientKey(request: Request, server: Bun.Server<SocketData>): string {
  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')[0]
    ?.trim()
  if (forwarded) return forwarded
  return server.requestIP(request)?.address ?? 'unknown'
}

async function handleLogin(
  request: Request,
  auth: Auth,
  options: ProxyOptions,
  server: Bun.Server<SocketData>,
): Promise<Response> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (auth.isAuthenticated(request)) return redirect('/')
    return htmlResponse(renderLoginPage())
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'GET, POST' },
    })
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_LOGIN_BODY_BYTES) {
    return htmlResponse(
      renderLoginPage({ error: 'That request was too large.' }),
      413,
    )
  }

  const key = clientKey(request, server)
  const blockedFor = auth.loginLimiter.blockedFor(key)
  if (blockedFor > 0) {
    return new Response('Too many attempts. Try again later.', {
      status: 429,
      headers: { 'retry-after': String(Math.ceil(blockedFor / 1000)) },
    })
  }

  let password = ''
  try {
    const body = await request.text()
    if (body.length > MAX_LOGIN_BODY_BYTES) {
      return htmlResponse(
        renderLoginPage({ error: 'That request was too large.' }),
        413,
      )
    }
    password = new URLSearchParams(body).get('password') ?? ''
  } catch {
    return htmlResponse(
      renderLoginPage({ error: 'Could not read that form.' }),
      400,
    )
  }

  const valid = password.length > 0 && (await auth.verifyPassword(password))
  if (!valid) {
    auth.loginLimiter.recordFailure(key)
    return htmlResponse(
      renderLoginPage({ error: 'That password is not correct.' }),
      401,
    )
  }

  auth.loginLimiter.reset(key)
  const response = redirect('/')
  response.headers.append(
    'set-cookie',
    auth.sessionCookie({
      secure: options.secureCookie,
      maxAgeSeconds: auth.sessionTtlSeconds,
    }),
  )
  return response
}

function proxyWebSocket(
  request: Request,
  url: URL,
  options: ProxyOptions,
  server: Bun.Server<SocketData>,
): Response | undefined {
  const headers: Record<string, string> = {
    origin: upstreamOrigin(options.orchestratorPort),
  }
  const cookie = request.headers.get('cookie')
  if (cookie && options.auth) {
    const filtered = stripCookie(
      cookie,
      [options.auth.cookieName, ACCOUNT_COOKIE, ACCOUNT_SIGNATURE],
      !!options.launchId,
    )
    if (filtered) headers.cookie = filtered
  } else if (cookie) {
    headers.cookie = cookie
  }
  const userAgent = request.headers.get('user-agent')
  if (userAgent) headers['user-agent'] = userAgent
  if (options.launchId) headers['x-freebuff-launch-id'] = options.launchId

  const upstreamUrl = `ws://127.0.0.1:${options.orchestratorPort}${url.pathname}${url.search}`
  const upgraded = server.upgrade(request, {
    data: {
      session: options.auth
        ? (parseCookieHeader(cookie)[options.auth.cookieName] ?? '')
        : '',
      upstreamUrl,
      headers,
      upstream: null,
      queue: [],
      closed: false,
    } satisfies SocketData,
  })
  if (!upgraded) {
    return new Response('WebSocket upgrade failed', { status: 400 })
  }
  return undefined
}

/** 1006 (abnormal) and other reserved codes cannot be sent in a close frame. */
function safeCloseCode(code: number): number {
  if (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) {
    return code
  }
  if (code >= 3000 && code <= 4999) return code
  return 1000
}

function openUpstream(ws: Bun.ServerWebSocket<SocketData>): void {
  const data = ws.data
  let upstream: WebSocket
  try {
    upstream = new WebSocket(data.upstreamUrl, {
      headers: data.headers,
    } as never)
  } catch {
    console.error('[proxy] could not open upstream socket')
    ws.close(1011, 'upstream unavailable')
    return
  }
  data.upstream = upstream
  upstream.binaryType = 'arraybuffer'

  upstream.addEventListener('open', () => {
    if (data.closed) {
      upstream.close(1000, 'client closed')
      return
    }
    for (const message of data.queue.splice(0)) {
      try {
        upstream.send(message)
      } catch {
        break
      }
    }
  })
  upstream.addEventListener('message', (event) => {
    if (data.closed || ws.readyState !== WebSocket.OPEN) return
    ws.send(event.data as string | Uint8Array | ArrayBuffer)
  })
  upstream.addEventListener('close', (event) => {
    data.closed = true
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(safeCloseCode(event.code), event.reason.slice(0, 123))
    }
  })
  upstream.addEventListener('error', () => {
    data.closed = true
    if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'upstream error')
  })
}

async function proxyHttp(
  request: Request,
  url: URL,
  options: ProxyOptions,
  server: Bun.Server<SocketData>,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === 'x-freebuff-launch-id') continue
    if (
      lower === 'host' ||
      lower === 'accept-encoding' ||
      lower === 'content-length'
    ) {
      continue
    }
    if (lower === 'cookie') {
      const filtered = options.auth
        ? stripCookie(
            value,
            [options.auth.cookieName, ACCOUNT_COOKIE, ACCOUNT_SIGNATURE],
            !!options.launchId,
          )
        : value
      if (filtered) headers.set('cookie', filtered)
      continue
    }
    if (lower === 'origin') {
      headers.set('origin', upstreamOrigin(options.orchestratorPort))
      continue
    }
    if (lower === 'referer') {
      try {
        const referer = new URL(value)
        headers.set(
          'referer',
          `${upstreamOrigin(options.orchestratorPort)}${referer.pathname}${referer.search}`,
        )
      } catch {
        // A malformed referer is not worth forwarding.
      }
      continue
    }
    headers.set(key, value)
  }
  headers.set('x-forwarded-for', clientKey(request, server))
  headers.set('x-forwarded-proto', options.secureCookie ? 'https' : 'http')
  headers.set('x-forwarded-host', url.host)
  if (options.launchId) headers.set('x-freebuff-launch-id', options.launchId)

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const upstreamUrl = `${upstreamOrigin(options.orchestratorPort)}${url.pathname}${url.search}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([request.signal, signal])
        : request.signal,
    } as RequestInit)
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    console.error(`[proxy] ${request.method} upstream unavailable`)
    return new Response(
      'The Freebuff server is not responding. Check its logs.',
      {
        status: 502,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }

  const responseHeaders = new Headers()
  const setCookies = (
    upstream.headers as unknown as { getSetCookie?: () => string[] }
  ).getSetCookie?.()
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase()
    if (lower === 'set-cookie') continue
    if (
      HOP_BY_HOP.has(lower) ||
      lower === 'content-encoding' ||
      lower === 'content-length'
    ) {
      continue
    }
    if (lower === 'location') {
      responseHeaders.set(
        'location',
        rewriteLocation(value, options.orchestratorPort),
      )
      continue
    }
    if (options.launchId && lower === 'content-security-policy') {
      let policy = value
      for (const scheme of ['http', 'ws']) {
        for (const host of ['127.0.0.1', 'localhost']) {
          policy = policy.replaceAll(
            `${scheme}://${host}:${options.orchestratorPort}`,
            '',
          )
        }
      }
      responseHeaders.set(key, policy)
      continue
    }
    responseHeaders.set(key, value)
  }
  for (const cookie of setCookies ?? []) {
    if (options.launchId && cookie.toLowerCase().startsWith('freebuff_launch_'))
      continue
    responseHeaders.append('set-cookie', cookie)
  }

  let body =
    request.method === 'HEAD' ||
    upstream.status === 204 ||
    upstream.status === 304
      ? null
      : url.pathname === LOGIN_START_PATH &&
          upstream.headers.get('content-type')?.includes('application/json')
        ? rewriteBodyOrigins(await upstream.text(), options.orchestratorPort)
        : upstream.body
  if (
    options.auth &&
    options.registryPath &&
    request.method === 'GET' &&
    url.pathname === '/' &&
    upstream.headers.get('content-type')?.includes('text/html') &&
    body
  ) {
    const html =
      typeof body === 'string' ? body : await new Response(body).text()
    body = html.replace(
      /<body([^>]*)>/i,
      `<body$1><nav><a href="/__freebuff/accounts">Account: ${escapeHtml(options.accountLabel || 'Default')}</a></nav>`,
    )
  }
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export function startProxy(options: ProxyOptions): ProxyHandle {
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>()
  const generations = new Map<string, number>()
  const sessionSelections = new Map<string, string>()
  const inflight = new Map<string, Set<AbortController>>()
  const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const clearSession = (session: string) => {
    for (const ws of sockets)
      if (ws.data.session === session) ws.close(4001, 'session ended')
    for (const controller of inflight.get(session) ?? []) controller.abort()
    inflight.delete(session)
    generations.delete(session)
    sessionSelections.delete(session)
    const timer = sessionTimers.get(session)
    if (timer) clearTimeout(timer)
    sessionTimers.delete(session)
  }
  const trackSession = (session: string) => {
    if (sessionTimers.has(session)) return
    const expires = Number(session.split('.')[0])
    const timer = setTimeout(
      () => {
        sessionTimers.delete(session)
        if (expires > Date.now()) trackSession(session)
        else clearSession(session)
      },
      Math.max(0, Math.min(expires - Date.now(), 2147483647)),
    )
    timer.unref()
    sessionTimers.set(session, timer)
  }
  const signature = (session: string, id: string) =>
    createHmac('sha256', session).update(id).digest('hex')
  const cookieValue = (request: Request, name: string, value: string) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${options.secureCookie || request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`
  const selected = (
    request: Request,
  ): { id: string; session: string } | null => {
    if (!options.auth) return null
    const cookies = parseCookieHeader(request.headers.get('cookie'))
    const session = cookies[options.auth.cookieName] ?? ''
    const id = cookies[ACCOUNT_COOKIE] ?? ''
    if (!id) return { id: '', session }
    const sig = cookies[ACCOUNT_SIGNATURE] ?? ''
    const expected = signature(session, id)
    if (
      !/^[a-f0-9]{64}$/.test(sig) ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    )
      return null
    return { id, session }
  }
  const server = Bun.serve<SocketData>({
    hostname: options.hostname,
    port: options.port,
    ...(options.tls ? { tls: options.tls } : {}),
    // Bun closes connections idle for 10s by default. The orchestrator only
    // pings /api/events every 25s, so a quiet desktop UI would lose its event
    // stream on every idle interval. Keep the connection open for the longest
    // interval Bun allows; the orchestrator sets idleTimeout: 0 itself.
    idleTimeout: 255,
    maxRequestBodySize: 256 * 1024 * 1024,
    fetch: async (request, server) => {
      const url = new URL(request.url)

      if (url.pathname === HEALTH_PATH && request.method === 'GET') {
        return jsonResponse({ ok: true, app: 'freebuff-web' })
      }

      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.method !== 'OPTIONS' &&
        !originAllowed(request)
      ) {
        console.error(
          `[web] refused cross-origin ${request.method} ${request.url} (origin ${request.headers.get('origin')})`,
        )
        return new Response('Cross-origin request refused', { status: 403 })
      }

      if (url.pathname === LOGIN_PATH) {
        if (!options.auth) return redirect('/')
        return handleLogin(request, options.auth, options, server)
      }

      if (url.pathname === LOGOUT_PATH) {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', {
            status: 405,
            headers: { allow: 'POST' },
          })
        }
        const response = redirect(options.auth ? LOGIN_PATH : '/')
        if (options.auth) {
          const session = parseCookieHeader(request.headers.get('cookie'))[
            options.auth.cookieName
          ]
          if (session && options.auth.isAuthenticated(request))
            clearSession(session)
          response.headers.append(
            'set-cookie',
            options.auth.clearCookie(options.secureCookie),
          )
        }
        return response
      }

      if (options.auth && !options.auth.isAuthenticated(request)) {
        if (isDocumentRequest(request)) {
          return redirect(LOGIN_PATH, 302)
        }
        return jsonResponse({ error: 'Authentication required' }, 401)
      }

      if (url.pathname === ACCOUNTS_PATH) {
        if (!options.auth || !options.registryPath)
          return new Response('Not found', { status: 404 })
        const session =
          parseCookieHeader(request.headers.get('cookie'))[
            options.auth.cookieName
          ] ?? ''
        trackSession(session)
        if (request.method === 'POST') {
          if (
            Number(request.headers.get('content-length') ?? 0) >
            MAX_LOGIN_BODY_BYTES
          )
            return new Response('Request too large', { status: 413 })
          const body = await request.text().catch(() => '')
          if (body.length > MAX_LOGIN_BODY_BYTES)
            return new Response('Request too large', { status: 413 })
          const id = new URLSearchParams(body).get('account')
          if (id === null)
            return new Response('Invalid selection', { status: 400 })
          const entries = await readRegistry(options.registryPath)
          const account = entries.find((a) => a.accountId === id)
          if (id && (!account || !(await accountIsLive(account))))
            return new Response('Account unavailable', { status: 404 })
          generations.set(session, (generations.get(session) ?? 0) + 1)
          sessionSelections.set(session, id)
          for (const ws of sockets)
            if (ws.data.session === session) ws.close(4001, 'account switched')
          for (const controller of inflight.get(session) ?? [])
            controller.abort()
          inflight.delete(session)
          const response = redirect('/')
          response.headers.append(
            'set-cookie',
            cookieValue(request, ACCOUNT_COOKIE, id),
          )
          response.headers.append(
            'set-cookie',
            cookieValue(
              request,
              ACCOUNT_SIGNATURE,
              id ? signature(session, id) : '',
            ),
          )
          return response
        }
        if (request.method !== 'GET')
          return new Response('Method not allowed', { status: 405 })
        const current = selected(request)
        if (!current)
          return new Response('Invalid account selection', { status: 403 })
        const entries = await readRegistry(options.registryPath)
        const live = await Promise.all(entries.map(accountIsLive))
        const items = entries
          .map(
            (a, i) =>
              `<option value="${escapeHtml(a.accountId)}"${a.accountId === current.id ? ' selected' : ''}${live[i] ? '' : ' disabled'}>${escapeHtml(a.label || a.accountId)}${live[i] ? '' : ' (offline)'}</option>`,
          )
          .join('')
        return htmlResponse(
          `<html><head><title>Freebuff accounts</title></head><body><h1>Choose account</h1><form method="post"><label>Account <select name="account"><option value="">Default</option>${items}</select></label><button type="submit">Switch</button></form><a href="/">Back</a></body></html>`,
        )
      }

      const selection = options.registryPath ? selected(request) : null
      if (options.auth && options.registryPath && !selection)
        return new Response('Invalid account selection', { status: 403 })
      if (selection) {
        trackSession(selection.session)
        const expected = sessionSelections.get(selection.session)
        if (expected !== undefined && expected !== selection.id)
          return new Response('Account selection changed', { status: 409 })
        if (expected === undefined)
          sessionSelections.set(selection.session, selection.id)
      }
      const generation = selection
        ? (generations.get(selection.session) ?? 0)
        : 0
      let account: ManagedAccount | undefined
      if (selection?.id) {
        account = (await readRegistry(options.registryPath ?? null)).find(
          (a) => a.accountId === selection.id,
        )
        if (!account || !(await accountIsLive(account)))
          return new Response('Account offline or unavailable', { status: 503 })
      }
      // The managed health response contains the launch credential and port.
      if (
        account &&
        (url.pathname === '/healthz' ||
          (() => {
            try {
              return decodeURIComponent(url.pathname) === '/healthz'
            } catch {
              return true
            }
          })())
      )
        return new Response('Not found', { status: 404 })
      if (selection && generation !== (generations.get(selection.session) ?? 0))
        return new Response('Account selection changed', { status: 409 })
      const route = account
        ? {
            ...options,
            orchestratorPort: account.port,
            launchId: account.launchId,
            accountLabel: account.label || account.accountId,
          }
        : options

      if (
        (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
      ) {
        return proxyWebSocket(request, url, route, server)
      }

      if (!selection) return proxyHttp(request, url, route, server)
      const controller = new AbortController()
      const active =
        inflight.get(selection.session) ?? new Set<AbortController>()
      active.add(controller)
      inflight.set(selection.session, active)
      const release = () => {
        active.delete(controller)
        if (!active.size && inflight.get(selection.session) === active)
          inflight.delete(selection.session)
      }
      try {
        const response = await proxyHttp(
          request,
          url,
          route,
          server,
          controller.signal,
        )
        if (!response.body) {
          release()
          return response
        }
        const reader = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const chunk = await reader.read()
              if (chunk.done) {
                release()
                stream.close()
              } else stream.enqueue(chunk.value)
            } catch (error) {
              release()
              if (controller.signal.aborted) stream.close()
              else stream.error(error)
            }
          },
          async cancel(reason) {
            release()
            await reader.cancel(reason)
          },
        })
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch (error) {
        release()
        throw error
      }
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        openUpstream(ws)
      },
      message(ws, message) {
        const data = ws.data
        if (data.closed) return
        if (data.upstream?.readyState === WebSocket.OPEN) {
          data.upstream.send(message as string | Uint8Array | ArrayBuffer)
          return
        }
        if (data.queue.length < MAX_SOCKET_QUEUE) {
          data.queue.push(message as string | Uint8Array | ArrayBuffer)
        }
      },
      close(ws, code, reason) {
        sockets.delete(ws)
        const data = ws.data
        data.closed = true
        if (data.upstream && data.upstream.readyState === WebSocket.OPEN) {
          data.upstream.close(safeCloseCode(code), reason.slice(0, 123))
        }
      },
    },
  })

  return {
    port: server.port ?? options.port,
    hostname: server.hostname ?? options.hostname,
    stop: async () => {
      await server.stop(true)
    },
  }
}
