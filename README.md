# ClusterCode for VS Code

Run and monitor your ClusterCode AI coding agents without leaving VS Code.

## What it does

This extension opens the ClusterCode console in a VS Code tab, so you can view and manage your runs, schedules, and agents right beside your code. Sign in once — your session is kept alive in the background — and if the console can't be reached, the panel shows guidance and reconnects automatically.

## Commands

| Command | What it does |
|---------|--------------|
| `ClusterCode: Open` | Opens the ClusterCode console. If you're not signed in yet, it shows the sign-in screen first (see [Signing in](#signing-in)). |
| `ClusterCode: Reload` | Reloads the console panel. |
| `ClusterCode: Pair Device` | Starts the sign-in flow without opening the panel — handy for signing in ahead of time, or re-pairing after a session ends. |
| `ClusterCode: Sign Out` | Ends the session and clears the stored credentials for this VS Code instance. |

## Signing in

ClusterCode signs in with a device code — no password is ever typed into VS Code.

1. Run **ClusterCode: Open** — the panel shows a sign-in screen; choose **Sign In**. (Or run **ClusterCode: Pair Device** to start signing in without opening the panel.)
2. A notification shows a short code and an **Open in Browser** button — click it.
3. Approve the request in your browser (confirm the code if asked).
4. VS Code confirms the sign-in, and the console opens with your data.

Sign out any time with **ClusterCode: Sign Out**.

## Requirements

- VS Code 1.74 or newer
- A ClusterCode account

---

Issues and contributions are welcome — see the [repository](https://github.com/clustercodehq/vscode-extension).
