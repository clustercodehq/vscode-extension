import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { isAllowedExternalUrl } from './url-guard';
import { resolveOrchestratorUrl, distinctOrigins } from './orchestrator-url';

type PanelState = 'loading' | 'running' | 'not-running';

/**
 * Supplies the current embedded bearer token to the webview's data-plane. The
 * webview (running the orchestrator console at a different origin) has no
 * session cookie, so it fetches this token from the local broker and attaches
 * it to its same-origin API calls. Returns undefined when the user hasn't
 * paired yet.
 */
export type EmbedTokenGetter = () => Promise<{ accessToken: string; expiresAt: number } | undefined>;

export class ClusterCodePanel {
  static currentPanel: ClusterCodePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _orchestratorUrl: string;
  private _frameOrigins: string[] = [];
  private _clipboardServer: http.Server | null = null;
  private _clipboardPort = 0;
  private _clipboardToken = '';
  private _getEmbeddedToken?: EmbedTokenGetter;
  private readonly _isDev: boolean;
  private _pollTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(panel: vscode.WebviewPanel, isDev: boolean, getEmbeddedToken?: EmbedTokenGetter) {
    this._panel = panel;
    this._isDev = isDev;
    this._getEmbeddedToken = getEmbeddedToken;
    this._orchestratorUrl = resolveOrchestratorUrl(process.env.ORCHESTRATOR_URL);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    // Listen for VSCode theme changes and forward to the webview iframe
    this._disposables.push(
      vscode.window.onDidChangeActiveColorTheme((theme) => {
        this._panel.webview.postMessage({
          type: 'themeChange',
          theme: this._resolveVscTheme(theme.kind),
        });
      })
    );

    this._checkAndRender();
  }

  private _resolveVscTheme(kind: vscode.ColorThemeKind): 'light' | 'dark' {
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';
  }

  static reload() {
    if (ClusterCodePanel.currentPanel) {
      ClusterCodePanel.currentPanel._checkAndRender();
    }
  }

  static onConfigChanged() {
    if (ClusterCodePanel.currentPanel) {
      ClusterCodePanel.currentPanel._checkAndRender();
    }
  }

  static createOrShow(extensionUri: vscode.Uri, isDev = false, getEmbeddedToken?: EmbedTokenGetter) {
    if (ClusterCodePanel.currentPanel) {
      ClusterCodePanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'clusterCode',
      'ClusterCode',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'logo-small.png');

    ClusterCodePanel.currentPanel = new ClusterCodePanel(panel, isDev, getEmbeddedToken);
  }

  private _setState(state: PanelState) {
    this._panel.webview.html = this._getHtml(state);
  }

  private async _checkAndRender() {
    this._clearPoll();
    this._setState('loading');
    await this._startClipboardServer();

    // ORCHESTRATOR_URL env (developer override for local/UAT) or hosted console.
    this._orchestratorUrl = resolveOrchestratorUrl(process.env.ORCHESTRATOR_URL);
    const probe = await this._probe(this._orchestratorUrl);
    this._frameOrigins = probe.origins;
    if (probe.reachable) {
      this._setState('running');
    } else {
      this._setState('not-running');
      this._schedulePoll();
    }
  }

  // Instead of a Retry button, quietly re-probe while the not-running screen is
  // shown and switch to the app the moment the orchestrator answers.
  private _schedulePoll() {
    this._clearPoll();
    this._pollTimer = setTimeout(() => this._poll(), 3000);
  }

  private _clearPoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private async _poll() {
    const probe = await this._probe(this._orchestratorUrl);
    if (probe.reachable) {
      this._frameOrigins = probe.origins;
      this._setState('running');
    } else {
      this._schedulePoll();
    }
  }

  // --- Clipboard HTTP server ---
  // VS Code nests webviews in 4+ iframe layers, blocking all postMessage.
  // Instead, the extension runs a tiny HTTP server on 127.0.0.1 that the
  // orchestrator iframe can fetch() from directly.
  private _startClipboardServer(): Promise<void> {
    if (this._clipboardServer) return Promise.resolve();

    this._clipboardToken = crypto.randomBytes(16).toString('hex');

    return new Promise((resolve) => {
      const server = http.createServer(async (req, res) => {
        // CORS — the orchestrator iframe is on a different origin
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'X-Token, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        // Token auth
        if (req.headers['x-token'] !== this._clipboardToken) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        if (req.url === '/clipboard' && req.method === 'GET') {
          try {
            const text = await vscode.env.clipboard.readText();
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(text);
          } catch {
            res.writeHead(500);
            res.end('Failed to read clipboard');
          }
        } else if (req.url === '/clipboard' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              await vscode.env.clipboard.writeText(body);
              res.writeHead(200);
              res.end('ok');
            } catch {
              res.writeHead(500);
              res.end('Failed to write clipboard');
            }
          });
        } else if (req.url === '/open-external' && req.method === 'POST') {
          // A URL body is tiny; cap it so a token-bearing caller can't grow
          // memory with an arbitrarily large payload. (The /clipboard POST
          // above intentionally has no small cap — clipboard contents can
          // legitimately be large.)
          const MAX_URL_BYTES = 8192;
          let body = '';
          let aborted = false;
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.length > MAX_URL_BYTES) {
              aborted = true;
              res.writeHead(413);
              res.end('Payload too large');
              req.destroy();
            }
          });
          req.on('end', async () => {
            if (aborted) return;
            const url = body.trim();
            if (!isAllowedExternalUrl(url)) {
              res.writeHead(400);
              res.end('Invalid URL');
              return;
            }
            try {
              await vscode.env.openExternal(vscode.Uri.parse(url));
              res.writeHead(200);
              res.end('ok');
            } catch {
              res.writeHead(500);
              res.end('Failed to open URL');
            }
          });
        } else if (req.url === '/embed-token' && req.method === 'GET') {
          // The webview console (different origin, no session cookie) fetches
          // the current embedded bearer token here to authenticate its
          // same-origin API calls. Already X-Token-gated above, so only the
          // extension's own webview (which holds the token) can read it.
          try {
            const record = this._getEmbeddedToken ? await this._getEmbeddedToken() : undefined;
            if (!record) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'not_paired' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ token: record.accessToken, expiresAt: new Date(record.expiresAt).toISOString() }));
          } catch {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'token_unavailable' }));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        this._clipboardPort = addr.port;
        this._clipboardServer = server;
        resolve();
      });

      server.on('error', () => {
        resolve(); // continue without clipboard server
      });
    });
  }

  /**
   * Probes the orchestrator, following its redirect chain (e.g. an
   * unauthenticated request bouncing to a portal login on another origin).
   * Returns whether it is reachable (first request got any response) and the
   * distinct origins touched, so the webview CSP frame-src can permit the
   * iframe to actually follow that redirect.
   */
  private _probe(startUrl: string, maxHops = 5): Promise<{ reachable: boolean; origins: string[] }> {
    const visited: string[] = [];
    let reachable = false;

    const visit = (current: string, hops: number): Promise<void> =>
      new Promise((resolve) => {
        let isHttps: boolean;
        try {
          isHttps = new URL(current).protocol === 'https:';
        } catch {
          resolve();
          return;
        }
        visited.push(current);
        // http.get cannot speak TLS — pick the client by protocol so an
        // https orchestrator (e.g. the hosted console) is reachable.
        const req = (isHttps ? https : http).get(current, { timeout: 2000 }, (res) => {
          res.resume();
          if (hops === 0) reachable = true; // first response = orchestrator is up
          const location = res.headers.location;
          const code = res.statusCode ?? 0;
          if (location && code >= 300 && code < 400 && hops < maxHops) {
            let next: string;
            try {
              next = new URL(location, current).toString();
            } catch {
              resolve();
              return;
            }
            visit(next, hops + 1).then(resolve);
          } else {
            resolve();
          }
        });
        req.on('error', () => resolve());
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
      });

    return visit(startUrl, 0).then(() => ({ reachable, origins: distinctOrigins(visited) }));
  }

  private async _handleMessage(msg: { command: string; text?: string }) {
    switch (msg.command) {
      case 'startOrchestrator': {
        const term = vscode.window.createTerminal('ClusterCode: Login');
        term.show();
        term.sendText('clustercode login');
        break;
      }
      case 'startWorker': {
        const term = vscode.window.createTerminal({
          name: 'ClusterCode: Worker',
          env: { ORCHESTRATOR_URL: this._orchestratorUrl },
        });
        term.show();
        term.sendText('clustercode worker');
        break;
      }
      case 'clipboardWrite':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
        }
        break;
      case 'clipboardRead': {
        const text = await vscode.env.clipboard.readText();
        this._panel.webview.postMessage({ type: 'clipboardPaste', text });
        break;
      }
    }
  }

  dispose() {
    ClusterCodePanel.currentPanel = undefined;
    this._clearPoll();
    if (this._clipboardServer) {
      this._clipboardServer.close();
      this._clipboardServer = null;
    }
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }

  private _nonce() {
    return crypto.randomBytes(16).toString('hex');
  }

  private _getHtml(state: PanelState): string {
    const nonce = this._nonce();
    // Allow fetch to the clipboard server
    const cbOrigin = this._clipboardPort ? `http://127.0.0.1:${this._clipboardPort}` : '';
    // Allow the orchestrator origin plus any origins it redirects to (e.g. a
    // portal login), plus configured extras for JS-injected frames such as the
    // Clerk auth iframe, so the embedded app can complete its auth flow.
    const redirectOrigins = this._frameOrigins.length
      ? this._frameOrigins
      : [this._orchestratorUrl];
    const extraFrameOrigins = vscode.workspace
      .getConfiguration('clustercode')
      .get<string[]>('extraFrameOrigins', []);
    const frameSrc = [...new Set([...redirectOrigins, ...extraFrameOrigins])].join(' ');
    const csp = [
      `default-src 'none'`,
      `frame-src ${frameSrc}`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'unsafe-inline'`,
      cbOrigin ? `connect-src ${cbOrigin}` : '',
    ].filter(Boolean).join('; ');

    const styles = `
      <style>
        :root {
          --bg-primary: var(--vscode-editor-background, #1e1e1e);
          --bg-secondary: var(--vscode-sideBar-background, #252526);
          --border: var(--vscode-panel-border, #3c3c3c);
          --text-primary: var(--vscode-editor-foreground, #d4d4d4);
          --text-secondary: var(--vscode-descriptionForeground, #808080);
          --accent-blue: var(--vscode-textLink-foreground, #569cd6);
          --accent-teal: var(--vscode-terminal-ansiGreen, #4ec9b0);
          --warning: var(--vscode-editorWarning-foreground, #cca700);
          --status-bar: var(--vscode-statusBar-background, #007acc);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: var(--bg-primary);
          color: var(--text-primary);
          font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
          font-size: 13px;
          height: 100vh;
          overflow: hidden;
        }
      </style>
    `;

    if (state === 'loading') {
      return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${styles}
  <style>
    body { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 16px; }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--status-bar);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .label { color: var(--text-secondary); font-size: 13px; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="label">Connecting to ClusterCode…</div>
</body>
</html>`;
    }

    // Pass clipboard server URL and theme to the orchestrator via query params
    const vscTheme = this._resolveVscTheme(vscode.window.activeColorTheme.kind);
    const params = [`_vscTheme=${vscTheme}`];
    if (this._clipboardPort) {
      params.push(`_cbUrl=${encodeURIComponent(`http://127.0.0.1:${this._clipboardPort}`)}`);
      params.push(`_cbToken=${this._clipboardToken}`);
    }
    const separator = this._orchestratorUrl.includes('?') ? '&' : '?';
    const iframeSrc = `${this._orchestratorUrl}${separator}${params.join('&')}`;

    if (state === 'running') {
      return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body, html { width: 100%; height: 100%; overflow: hidden; }
    iframe { width: 100%; height: 100vh; border: none; display: block; }
  </style>
</head>
<body>
  <iframe id="app" src="${iframeSrc}" allow="clipboard-read; clipboard-write"></iframe>
  <script nonce="${nonce}">
    // Forward theme change messages from the extension host to the iframe
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'themeChange') {
        const iframe = document.getElementById('app');
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage(msg, '*');
        }
      }
    });
  </script>
</body>
</html>`;
    }

    // not-running
    const wsScheme = this._orchestratorUrl.startsWith('https') ? 'wss' : 'ws';
    const workerWsUrl = `${wsScheme}://${new URL(this._orchestratorUrl).host}/ws/worker`;
    // The URL fields are diagnostic only — shown in development (F5) runs, hidden
    // in a production-built/installed extension.
    const devFields = this._isDev ? /* html */ `
    <div class="url-field">
      <label>Orchestrator URL</label>
      <input type="text" value="${this._orchestratorUrl}" readonly />
    </div>
    <div class="url-field">
      <label>Worker WebSocket URL</label>
      <input type="text" value="${workerWsUrl}" readonly />
    </div>` : '';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${styles}
  <style>
    body { display: flex; align-items: center; justify-content: center; overflow-y: auto; }
    .container { max-width: 560px; width: 100%; padding: 40px 24px; display: flex; flex-direction: column; gap: 28px; }
    .header { display: flex; align-items: center; gap: 12px; }
    .icon { font-size: 28px; }
    .heading { font-size: 18px; font-weight: 600; color: var(--warning); }
    .section { display: flex; flex-direction: column; gap: 8px; }
    .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
    pre {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px 14px;
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      font-size: 12px;
      color: var(--accent-teal);
      overflow-x: auto;
    }
    .note { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
    .url-field { display: flex; flex-direction: column; gap: 6px; }
    .url-field label { font-size: 12px; color: var(--text-secondary); }
    .url-field input {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 6px 10px;
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      font-size: 12px;
      color: var(--text-primary);
      outline: none;
    }
    .url-field input:focus { border-color: var(--status-bar); }
    .buttons { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button {
      padding: 8px 16px;
      border: 1px solid transparent;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    /* Primary = ClusterCode brand cyan to match the app; theme-aware so the
       label stays legible in both light and dark (the old --statusBar-based
       style rendered white-on-light and vanished in light themes). */
    .btn-primary { background: #10c0f0; color: #ffffff; }
    .btn-primary:hover { background: #0eb2df; }
    body.vscode-light .btn-primary { background: #0080e0; }
    body.vscode-light .btn-primary:hover { background: #0072c9; }
    .btn-secondary { background: transparent; color: var(--text-primary); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-secondary); }
    .waiting { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .waiting .dot {
      width: 13px; height: 13px;
      border: 2px solid var(--border);
      border-top-color: #10c0f0;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="icon">⚠️</span>
      <span class="heading">ClusterCode Orchestrator is not running</span>
    </div>

    <div class="section">
      <div class="section-title">Install CLI</div>
      <pre>npm install -g @clustercode/cli</pre>
    </div>

    <div class="section">
      <div class="section-title">Getting Started</div>
      <pre>clustercode login</pre>
      <div class="note">Authenticate with your ClusterCode account</div>
      <pre>clustercode worker</pre>
      <div class="note">Configure tenant and start the worker</div>
      <pre>clustercode onboard</pre>
      <div class="note">Guided setup wizard (handles everything)</div>
    </div>

    ${devFields}

    <div class="buttons">
      <button class="btn-primary" data-cmd="startOrchestrator">Start Orchestrator</button>
      <button class="btn-secondary" data-cmd="startWorker">Start Worker Agent</button>
    </div>

    <div class="waiting">
      <span class="dot"></span>
      <span>Waiting for the orchestrator… this panel will connect automatically.</span>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-cmd]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: btn.dataset.cmd });
      });
    });
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      const isInput = el?.tagName === 'INPUT';
      switch (e.key.toLowerCase()) {
        case 'c': {
          e.preventDefault();
          let text = '';
          if (isInput) {
            text = el.value.substring(el.selectionStart, el.selectionEnd);
          } else {
            text = window.getSelection()?.toString() || '';
          }
          if (text) vscode.postMessage({ command: 'clipboardWrite', text });
          break;
        }
        case 'v':
          if (isInput) return; // native paste works for inputs
          e.preventDefault();
          vscode.postMessage({ command: 'clipboardRead' });
          break;
        case 'x': {
          e.preventDefault();
          let text = '';
          if (isInput) {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            text = el.value.substring(start, end);
            el.value = el.value.substring(0, start) + el.value.substring(end);
            el.selectionStart = el.selectionEnd = start;
          } else {
            text = window.getSelection()?.toString() || '';
            document.execCommand('delete');
          }
          if (text) vscode.postMessage({ command: 'clipboardWrite', text });
          break;
        }
        case 'a':
          e.preventDefault();
          if (isInput) {
            el.select();
          } else {
            document.execCommand('selectAll');
          }
          break;
      }
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'clipboardPaste') {
        const el = document.activeElement;
        if (el?.tagName === 'INPUT') {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          el.value = el.value.substring(0, start) + msg.text + el.value.substring(end);
          el.selectionStart = el.selectionEnd = start + msg.text.length;
        } else {
          document.execCommand('insertText', false, msg.text);
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
