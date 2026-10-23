export function renderLoginPage(options: { error?: string } = {}): string {
  const error = options.error
    ? `<p class="error" role="alert">${options.error}</p>`
    : ''
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Freebuff Web</title>
    <style>
      :root {
        color-scheme: dark light;
        --shell: #292b2a;
        --surface: #222423;
        --border: #3a3d3a;
        --text: #dedfdd;
        --muted: #a0a39f;
        --accent: #b5cea5;
        --accent-text: #1c211b;
        --error: #e7a6a0;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --shell: #e3e7e4;
          --surface: #f7f8f5;
          --border: #d0d8d1;
          --text: #232b26;
          --muted: #5d6962;
          --accent: #b5cea5;
          --accent-text: #232b26;
          --error: #a13a33;
        }
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--shell);
        color: var(--text);
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(400px, 100%);
        padding: 28px;
        border: 1px solid var(--border);
        border-radius: 24px;
        background: var(--surface);
      }
      .mark {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 18px;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent);
      }
      h1 {
        margin: 0 0 6px;
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      p { margin: 0; }
      .hint { color: var(--muted); margin-bottom: 22px; }
      label {
        display: block;
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
      }
      input {
        width: 100%;
        padding: 11px 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--shell);
        color: var(--text);
        font: inherit;
      }
      input:focus {
        outline: 2px solid var(--accent);
        outline-offset: 1px;
      }
      button {
        width: 100%;
        margin-top: 14px;
        padding: 11px 14px;
        border: 0;
        border-radius: 12px;
        background: var(--accent);
        color: var(--accent-text);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover { filter: brightness(1.04); }
      .error {
        margin: 0 0 16px;
        padding: 10px 12px;
        border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
        border-radius: 12px;
        color: var(--error);
      }
      footer {
        margin-top: 22px;
        color: var(--muted);
        font-size: 12px;
      }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    </style>
  </head>
  <body>
    <main>
      <div class="mark"><span class="dot"></span> Freebuff Web</div>
      <h1>Unlock this server</h1>
      <p class="hint">Enter the password for this Freebuff server. It was printed when the server started.</p>
      ${error}
      <form method="post" action="/__freebuff/login">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Continue</button>
      </form>
      <footer>
        Set <code>FREEBUFF_WEB_PASSWORD</code> before starting the server to choose this password.
      </footer>
    </main>
  </body>
</html>`
}
