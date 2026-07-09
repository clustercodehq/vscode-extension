# ClusterCode VS Code Extension

Open the ClusterCode orchestrator directly inside VS Code as a tab, without leaving your editor.

## What it does

This extension embeds the ClusterCode orchestrator web UI in a VS Code WebviewPanel. By default it loads the hosted console at `https://console.clustercode.io`; developers can point it at a local or other environment with the `ORCHESTRATOR_URL` environment variable. On open it probes the orchestrator:

- **Reachable** — loads the full UI in an iframe
- **Not reachable** — shows a help screen, then connects automatically as soon as the orchestrator comes online

## Commands

| Command | Description |
|---------|-------------|
| `ClusterCode: Open` | Opens the ClusterCode panel. Probes the orchestrator and either loads the UI or shows the not-running help screen. |
| `ClusterCode: Reload` | Re-runs the probe and refreshes the panel content. |

## Not-Running Screen

When the orchestrator isn't reachable, the panel shows setup guidance and keeps polling — it switches to the live UI automatically once the orchestrator responds (no manual retry):

- **Start Orchestrator button** — opens a VS Code terminal and runs `clustercode login`
- **Start Worker Agent button** — opens a VS Code terminal and runs `clustercode worker`
- **Orchestrator / Worker WebSocket URLs** — shown as read-only diagnostics only when running in development (F5)

## Configuration

- `ORCHESTRATOR_URL` (environment variable) — overrides the orchestrator URL, read at runtime. Set it to e.g. `http://localhost:3000` to target a local environment. Defaults to `https://console.clustercode.io`.
- `clustercode.extraFrameOrigins` (setting) — extra origins the embedded UI is allowed to frame (webview CSP `frame-src`), e.g. the auth provider's domains.

## Installation

```bash
# From the extension directory
npm run install-ext
```

This builds the extension, packages it as a `.vsix`, and installs it into VS Code.

## Development

```bash
# Build once
npm run build

# Watch mode
npm run dev
```

Press **F5** to launch the Extension Development Host (the `launch.json` config sets `ORCHESTRATOR_URL=http://localhost:3000`), then run **ClusterCode: Open**.

To run an installed build against a local orchestrator, launch VS Code with the variable set:

```bash
ORCHESTRATOR_URL=http://localhost:3000 code
```
