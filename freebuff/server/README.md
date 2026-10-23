# Freebuff Web server

Serve the Freebuff Desktop UI to browsers, using either the installed Desktop
app or the runtime exported in this package. This is not a reimplementation: it
starts the app's own Bun orchestrator (the process the Electron shell normally
supervises) and puts a password-protected reverse proxy in front of it,
including its UI, API, live event stream and terminal WebSocket.

```
browser ── password ──▶ proxy (0.0.0.0:4310) ──▶ orchestrator (127.0.0.1:<random>)
                                                     │
                                                     ├─ agent, shell, files
                                                     └─ Desktop profile (web copy)
```

## Requirements

- Freebuff Desktop installed **or** the exported runtime in
  `freebuff/server/runtime` (included in this repository; used automatically
  when no Desktop install is found). The server reuses the app's own
  orchestrator and UI rather than a second implementation. It looks in the
  standard install locations:
  - macOS: `/Applications/Freebuff.app` or `~/Applications/Freebuff.app`
  - Windows: `%LOCALAPPDATA%\Programs\Freebuff\resources` or
    `%PROGRAMFILES%\Freebuff\resources`
  - Linux: `/opt/Freebuff/resources`, `/opt/freebuff/resources`,
    `/usr/lib/freebuff/resources`, or `~/.local/share/freebuff/resources`
  - Anything else: set `FREEBUFF_APP_PATH` to the app bundle, its `Resources`
    directory, or `orchestrator.js`.
- Bun 1.4.2 or newer (`bun --version`), plus `git` on `PATH`.
- A clone of this repository.

## Standalone runtime (Linux and no Desktop install)

`freebuff/server/runtime` is an exported copy of the Desktop 0.0.188 runtime:
`orchestrator.js`, the UI, and the tree-sitter wasm grammars. When no Desktop
app is found, the server uses this copy, so Linux does not need Freebuff
Desktop installed at all. Ripgrep comes from `sdk/vendor/ripgrep`, which
already ships x64 and arm64 binaries for Linux, macOS, and Windows, and the
server passes the right one to the orchestrator.

### Refresh the exported runtime

Run this on a machine that has Freebuff Desktop installed, then commit the
result if you want other machines to pick it up:

```bash
# From the repository root
bun --cwd=freebuff/server run export-runtime

# Or from this directory
cd freebuff/server
bun run export-runtime

# A custom app location
bun run export-runtime -- /path/to/Freebuff.app
```

It writes a `runtime/manifest.json` with the Desktop version and export time.
Restart the server after refreshing the runtime. If both Desktop and the
exported runtime are present, the installed app wins; set
`FREEBUFF_RUNTIME_DIR` to force the exported copy.

### Linux quick start

```bash
bun install
FREEBUFF_WEB_HOST=127.0.0.1 bun run start:server
```

Open <http://localhost:4310>. No Desktop app, macOS-only binary, or Electron
runtime is involved; the orchestrator runs on the Bun you started the server
with.

## Self-host on localhost

This is the simplest setup: the UI runs on this machine only and no other
device can reach it.

### 1. Install once

```bash
cd freebuff
bun install
```

### 2. Start bound to loopback

From the repository root:

```bash
FREEBUFF_WEB_HOST=127.0.0.1 bun run start:server
```

Or from this directory:

```bash
FREEBUFF_WEB_HOST=127.0.0.1 bun start
```

`FREEBUFF_WEB_HOST=127.0.0.1` is the important part. The default is `0.0.0.0`,
which also listens on your LAN and Tailscale addresses. With loopback the
server refuses connections from every other machine.

### 3. Open it

Go to <http://localhost:4310>. On first run the server creates
`~/.config/freebuff-web/`, prints a generated password once, and copies the
Desktop app's project and thread list into a **separate web profile**
(`~/.config/freebuff-web/state.json`) so existing work appears. It never opens
the Desktop app's live profile, so the Desktop app can keep running.

Enter the printed password, then use **Continue in browser** on the Freebuff
sign-in screen. Sign in with the same Freebuff account you use in the Desktop
app. This is a one-time step for the server's profile.

### 4. Stop and restart

Press `Ctrl+C` in the terminal to stop both the proxy and the orchestrator.
Start the same command again later; the profile and password hash are reused.
Restart after updating Freebuff Desktop so the new orchestrator and UI are
picked up.

## Serve it to your network

Drop the host override to listen on every interface:

```bash
bun run start:server
```

The banner lists `localhost`, each LAN address, and each Tailscale address.
Open one of those from another device and enter the same password. Read the
security notes below before exposing the port beyond a trusted network.

> The Desktop app stores its session in an Electron-encrypted file that a plain
> Bun process cannot decrypt, so the web server cannot import that token. The
> browser sign-in is the supported way to reuse the same account; it is a
> one-time step for the server's profile.

## Configuration

| Variable                  | Default                          | Meaning                                               |
| ------------------------- | -------------------------------- | ----------------------------------------------------- |
| `FREEBUFF_WEB_PORT`       | `4310`                           | Listen port (`0` picks a random free port)            |
| `FREEBUFF_WEB_HOST`       | `0.0.0.0`                        | Bind address; use `127.0.0.1` for this Mac only       |
| `FREEBUFF_WEB_PASSWORD`   | generated on first run           | Login password; not written to disk                   |
| `FREEBUFF_WEB_NO_AUTH`    | unset                            | `1` disables the password gate entirely               |
| `FREEBUFF_WEB_CONFIG_DIR` | `~/.config/freebuff-web`         | Config, profile and logs                              |
| `FREEBUFF_WEB_PROFILE`    | `<config dir>/state.json`        | Orchestrator profile for this server                  |
| `FREEBUFF_WEB_TLS_CERT`   | none                             | PEM certificate for HTTPS                             |
| `FREEBUFF_WEB_TLS_KEY`    | none                             | PEM private key; required with the certificate        |
| `FREEBUFF_APP_PATH`       | auto-detected                    | Freebuff app bundle, `Resources` dir, or orchestrator |
| `FREEBUFF_RUNTIME_DIR`    | `freebuff/server/runtime`        | Force an exported runtime instead of a Desktop install |
| `FREEBUFF_DESKTOP_STATE`  | `~/.config/freebuff-desktop/...` | Desktop state used to seed projects on first run      |

To change the password, set `FREEBUFF_WEB_PASSWORD` before starting. The value
is hashed in memory and takes precedence over the stored hash. Removing the
variable later falls back to the stored hash.

### Disabling authentication

```bash
FREEBUFF_WEB_NO_AUTH=1 bun run start:server
```

This removes the login page and serves the app to anyone who can reach the
port. The choice is persisted, so later plain starts stay open; run with
`FREEBUFF_WEB_NO_AUTH=0` or set `FREEBUFF_WEB_PASSWORD` to turn the gate back
on (a new password is generated if none is supplied). The stored hash is
dropped when auth is disabled. Only do this on a network you trust (or bind
`127.0.0.1`); anyone who can reach the server gets a shell as your user.

### HTTPS

Browsers increasingly restrict features on plain HTTP origins, and a LAN is not
a trusted network. To serve TLS, point the two variables at a certificate and
key:

```bash
FREEBUFF_WEB_TLS_CERT=/path/cert.pem FREEBUFF_WEB_TLS_KEY=/path/key.pem bun run start:server
```

The session cookie is marked `Secure` automatically. A self-signed certificate
will show a browser warning until trusted.

## Security model

- **Password gate.** Every path except `/__freebuff/health` requires a signed,
  `HttpOnly`, `SameSite=Strict` session cookie. Login attempts are rate limited
  per client address. `FREEBUFF_WEB_NO_AUTH=1` removes this gate by design.
- **Cross-origin checks still apply** when auth is disabled, and the
  orchestrator stays on loopback either way.
- **Loopback orchestrator.** The Desktop orchestrator binds `127.0.0.1` on a
  random port. Only the proxy can reach it.
- **Origin checks.** State-changing requests are refused when they carry a
  cross-origin `Origin`. Some embedded webviews (including Freebuff's own
  preview panel) send an opaque `Origin: null`; those requests are allowed and
  rely on the `SameSite=Strict` session cookie, which a cross-site page cannot
  send.
- **Operator authority.** Anyone who has the password and can reach the port can
  run shell commands and edit files as your user. Treat it like an SSH session.
  Do not expose it directly to the internet; put it behind a VPN, Tailscale, or
  an authenticated TLS reverse proxy.

## What works, and what does not

The proxy forwards the Desktop UI and its HTTP/SSE/WebSocket APIs, so chat,
projects, threads, files, diffs and the terminal work in a normal browser.

Desktop-only surfaces that require the Electron shell may be unavailable or
degraded:

- embedded preview browser and CDP-driven screenshot/automation
- native folder pickers and file dialogs
- MCP approval dialogs (the approval bridge is an Electron window)
- auto-update, notifications, and window chrome

Chat and terminal use the same server endpoints as the Desktop renderer, so
they are unaffected.

## Data and updates

- The server has its own profile and thread history under
  `~/.config/freebuff-web/`. It is seeded from the Desktop project list once.
- `orchestrator.log` in the same directory has the child process output when
  something fails to start.
- The wrapper launches the installed app's bundle at `start` time; after a
  Desktop update, restart the server to pick up the new orchestrator and UI.

## Troubleshooting

- **Port already in use** — set `FREEBUFF_WEB_PORT=4311` (or another free port).
- **Freebuff Desktop was not found** — install the Desktop app or set
  `FREEBUFF_APP_PATH` to `/Applications/Freebuff.app`, its `Resources`
  directory, or `orchestrator.js`.
- **Forgot the password** — restart with `FREEBUFF_WEB_PASSWORD='new-password'`,
  or run once with `FREEBUFF_WEB_NO_AUTH=1` to remove the gate.
- **Blank page or 502** — check `~/.config/freebuff-web/orchestrator.log`; the
  proxy itself logs to the terminal that started it.
- **Signed out after a Desktop update** — restart the server, then sign in
  again in the browser; the stored session belongs to the web profile.
- **Port 4310 is unresponsive on another device** — confirm the server was
  started without `FREEBUFF_WEB_HOST=127.0.0.1` and that the firewall allows
  the port.

## Tests

```bash
bun test
bun run typecheck
```

The proxy tests run a fake orchestrator and cover password auth, session
cookies, HTTP proxying, SSE streaming, WebSocket proxying and cross-origin
refusal.
