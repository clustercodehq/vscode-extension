# ClusterCode VS Code Extension

Source for the ClusterCode VS Code extension. It embeds the ClusterCode
orchestrator web UI in a VS Code WebviewPanel.

## Public repository — do not leak private detail

**This repository is public.** Never commit, document, or reference:

- Paths, file names, or directory structure of private repositories
- Internal architecture, business logic, or implementation detail of the
  orchestrator or any other private service
- Credentials, tokens, API keys, or internal URLs / hostnames
- The names of private repositories or internal projects

The orchestrator this extension embeds is maintained in a separate, private
repository. Cross-repo implementation detail belongs there, not here. Anything
in this repo — code, specs under `docs/`, commit messages — must be safe for
public view. Describe shared contracts (e.g. message protocols) as abstract
public interfaces only.

## Build / package / test

- `npm run build` — bundle the extension to `dist/` via esbuild
- `npm run dev` — esbuild watch mode
- `npm run package` — build and produce a `.vsix`
- `npm run install-ext` — package and install into VS Code
- `npm test` — run unit tests (node:test via tsx)
