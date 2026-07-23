import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { isAllowedExternalUrl } from './url-guard';
import { resolveOrchestratorUrl, distinctOrigins, buildEmbedUrl, safeHttpOrigin } from './orchestrator-url';

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
    const reachable = await this._probe(this._orchestratorUrl);
    if (reachable) {
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
    const reachable = await this._probe(this._orchestratorUrl);
    if (reachable) {
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
        // CORS — the only legitimate caller is the embedded webview, which
        // runs at the orchestrator's origin. Recomputed per request (not
        // cached at server-start) so a reload that changes the orchestrator
        // URL picks it up. Fails CLOSED: if the current orchestrator URL
        // isn't a well-formed http(s) origin, no Access-Control-Allow-Origin
        // header is sent at all — never "*", and never the literal string
        // "null" that a scheme-less URL like "localhost:3000" would produce.
        // The X-Token check below is still the real per-request guard.
        const allowedOrigin = safeHttpOrigin(this._orchestratorUrl);
        if (allowedOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        }
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
   * Checks whether the embedded console is reachable. The embed route serves
   * a self-contained anonymous shell with no redirect to chase, so a single
   * request is enough — any response at all means the orchestrator is up.
   */
  private _probe(orchestratorUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
      let target: string;
      let isHttps: boolean;
      try {
        target = buildEmbedUrl(orchestratorUrl, {});
        isHttps = new URL(target).protocol === 'https:';
      } catch {
        resolve(false);
        return;
      }
      // http.get cannot speak TLS — pick the client by protocol so an https
      // orchestrator (e.g. the hosted console) is reachable.
      const req = (isHttps ? https : http).get(target, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async _handleMessage(msg: { command: string; text?: string }) {
    switch (msg.command) {
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
    // Allow the orchestrator origin, plus configured extras for JS-injected
    // frames such as an auth provider's iframe, so the embedded app can
    // complete flows that need one.
    const orchestratorOrigins = distinctOrigins([this._orchestratorUrl]);
    const extraFrameOrigins = vscode.workspace
      .getConfiguration('clustercode')
      .get<string[]>('extraFrameOrigins', []);
    const frameSrc = [...new Set([...orchestratorOrigins, ...extraFrameOrigins])].join(' ');
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

    if (state === 'running') {
      // Pass clipboard server URL and theme to the embedded console via query params.
      const vscTheme = this._resolveVscTheme(vscode.window.activeColorTheme.kind);
      const embedParams: Record<string, string> = { _vscTheme: vscTheme };
      if (this._clipboardPort) {
        embedParams._cbUrl = `http://127.0.0.1:${this._clipboardPort}`;
        embedParams._cbToken = this._clipboardToken;
      }
      const iframeSrc = buildEmbedUrl(this._orchestratorUrl, embedParams);
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
    // The orchestrator URL is diagnostic-only, and only meaningful once a
    // developer has pointed the extension at a self-hosted instance via the
    // ORCHESTRATOR_URL env var — the default hosted console needs no such
    // hint for a normal user. Hidden entirely otherwise.
    const selfHosted = !!process.env.ORCHESTRATOR_URL;
    const devFields = selfHosted ? /* html */ `
    <div class="diagnostic">Trying <code>${this._orchestratorUrl}</code></div>` : '';
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${styles}
  <style>
    body { display: flex; align-items: center; justify-content: center; overflow-y: auto; }
    .container { max-width: 560px; width: 100%; padding: 40px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; }
    .header { display: flex; align-items: center; gap: 12px; }
    .icon { font-size: 28px; }
    .heading { font-size: 18px; font-weight: 600; color: var(--warning); }
    .message { font-size: 13px; color: var(--text-secondary); }
    .diagnostic { font-size: 11px; color: var(--text-secondary); }
    .diagnostic code {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      color: var(--accent-teal);
    }
    .waiting { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); margin-top: 8px; }
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
      <span class="heading">Can't reach ClusterCode</span>
    </div>

    <div class="message">The ClusterCode console isn't responding.</div>

    ${devFields}

    <div class="waiting">
      <span class="dot"></span>
      <span>Retrying automatically…</span>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
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
