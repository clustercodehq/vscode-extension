# ClusterCode VS Code Extension

Run and monitor your ClusterCode AI coding agents without leaving VS Code.

## What it does

This extension embeds the ClusterCode console inside VS Code as a tab, so you can view and manage your runs, schedules, and agents alongside your code. If the console can't be reached, the panel shows guidance and reconnects automatically.

## Commands

| Command | Description |
|---------|-------------|
| `ClusterCode: Open` | Opens the ClusterCode panel. If you're not signed in, prompts you to sign in first (see [Signing In](#signing-in)) — or open the console without signing in. |
| `ClusterCode: Reload` | Re-runs the probe and refreshes the panel content. |
| `ClusterCode: Pair Device` | Starts the sign-in flow directly, without opening the panel. Useful for signing in ahead of time or re-pairing. |
| `ClusterCode: Sign Out` | Ends the current session and clears the stored credentials for this VS Code instance. |

## Signing In

The console loads without an account, but you need to sign in to see your data.

1. Run **ClusterCode: Open** (or **ClusterCode: Pair Device** to sign in without opening the panel).
2. If you're not already signed in, choose **Sign In** on the prompt.
3. A code and a link to open in your browser appear — click **Open in Browser**.
4. Enter the code (or confirm it) on the page that opens, and approve the request.
5. VS Code shows a confirmation once sign-in completes, and the console opens automatically (if you started from **Open**) with your data.

You can sign out at any time with **ClusterCode: Sign Out**.

## Configuration

- `clustercode.extraFrameOrigins` (setting) — additional origins the embedded UI is permitted to load in a frame. Only needed if an allowed page fails to load.

## Installation

Install from the VS Code Marketplace.

---

Contributions welcome — see the repo.
