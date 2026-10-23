import type { Auth } from './auth'
import { renderLoginPage } from './login-page'

const LOGIN_PATH = '/__freebuff/login'
const LOGOUT_PATH = '/__freebuff/logout'
const HEALTH_PATH = '/__freebuff/health'
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

function stripCookie(header: string, omitNames: string[]): string {
  const omit = new Set(omitNames)
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, Math.max(0, part.indexOf('='))).trim()
      return name && !omit.has(name)
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
    const filtered = stripCookie(cookie, [options.auth.cookieName])
    if (filtered) headers.cookie = filtered
  } else if (cookie) {
    headers.cookie = cookie
  }
  const userAgent = request.headers.get('user-agent')
  if (userAgent) headers['user-agent'] = userAgent

  const upstreamUrl = `ws://127.0.0.1:${options.orchestratorPort}${url.pathname}${url.search}`
  const upgraded = server.upgrade(request, {
    data: {
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
  } catch (error) {
    console.error(`[proxy] could not open upstream socket: ${String(error)}`)
    ws.close(1011, 'upstream unavailable')
    return
  }
  data.upstream = upstream
  upstream.binaryType = 'arraybuffer'

  upstream.addEventListener('open', () => {
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
): Promise<Response> {
  const headers = new Headers()
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (
      lower === 'host' ||
      lower === 'accept-encoding' ||
      lower === 'content-length'
    ) {
      continue
    }
    if (lower === 'cookie') {
      const filtered = options.auth
        ? stripCookie(value, [options.auth.cookieName])
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

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const upstreamUrl = `${upstreamOrigin(options.orchestratorPort)}${url.pathname}${url.search}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: request.signal,
    } as RequestInit)
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    console.error(
      `[proxy] ${request.method} ${url.pathname} failed: ${String(error)}`,
    )
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
    responseHeaders.set(key, value)
  }
  for (const cookie of setCookies ?? []) {
    responseHeaders.append('set-cookie', cookie)
  }

  const body =
    request.method === 'HEAD' ||
    upstream.status === 204 ||
    upstream.status === 304
      ? null
      : upstream.body
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export function startProxy(options: ProxyOptions): ProxyHandle {
  const server = Bun.serve<SocketData>({
    hostname: options.hostname,
    port: options.port,
    ...(options.tls ? { tls: options.tls } : {}),
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

      if (
        (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
      ) {
        return proxyWebSocket(request, url, options, server)
      }

      return proxyHttp(request, url, options, server)
    },
    websocket: {
      open(ws) {
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
