# Freebuff

**The free coding agent.** No subscription. No configuration. Start in seconds.

An AI coding agent that runs in your terminal — describe what you want, and Freebuff edits your code.

## Install

```bash
npm install -g freebuff
```

## Usage

```bash
cd ~/my-project
freebuff
```

## Self-host the Desktop UI

Run the interface of the Freebuff Desktop app you already have installed in a
browser on this machine:

```bash
# From the repository root
bun install
FREEBUFF_WEB_HOST=127.0.0.1 bun run start:server
```

Open <http://localhost:4310> and enter the password printed on first run. The
server works on macOS, Linux, and Windows. Linux does not need Freebuff Desktop
installed: it uses the runtime exported in `server/runtime` and the Linux
ripgrep binaries already in `sdk/vendor`. The [server README](server/README.md)
covers refreshing that runtime, the one-time browser sign-in, LAN and Tailscale
access, HTTPS, configuration, and troubleshooting.

## Project Structure

```
freebuff/
├── cli/       # CLI build & npm release files
├── server/    # Browser access to the installed Desktop app
└── e2e/       # End-to-end CLI tests
```

## Building from Source

```bash
# From the repo root
bun freebuff/cli/build.ts 1.0.0
```

---

For everything else — what Freebuff does, how it works, FAQ, and how it relates to Codebuff — see the [repo root README](../README.md). We keep that one up to date as the single source of truth.

## License

MIT
