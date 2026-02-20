---
name: setup
description: Developer setup for x811 Protocol — build all packages and bundle the MCP server plugin
---

# x811 Setup — Build & Bundle

Builds all packages and bundles the MCP server into the plugin directory. This is for developers contributing to x811 — end users just install the plugin from the marketplace.

## Prerequisites Check

Before starting, verify:

1. **Repository root** — This skill must run from the x811 monorepo root (the directory containing `turbo.json`). Check that `turbo.json` exists in the current working directory. If not, tell the user to `cd` to the repo root and stop.
2. **Dependencies installed** — Check that `node_modules/` exists. If not, run `npm install` first.

## Step 1: Clean Build

Run a full clean build to ensure all `dist/` directories are fresh:

```bash
npx turbo run clean
npx turbo run build
```

If the build fails, show the error and stop.

## Step 2: Run Tests

Run the full test suite to make sure everything passes:

```bash
npm run test
```

If tests fail, show failures and stop.

## Step 3: Bundle Plugin

Bundle the MCP server + SDK + core into a single file for the plugin:

```bash
npm run bundle:plugin
```

This produces `plugins/x811/dist/index.mjs` — a self-contained MCP server that requires no npm install.

## Step 4: Verify Bundle

Test that the bundle starts correctly:

```bash
timeout 3 node plugins/x811/dist/index.mjs 2>&1 || true
```

You should see output like:
```
[x811] MCP server starting
[x811]   DID: did:x811:...
[x811]   Server: https://api.x811.org
```

## Step 5: Report

Show the user:

| Step | Status |
|------|--------|
| Build | Passed |
| Tests | Passed |
| Bundle | `plugins/x811/dist/index.mjs` |

Then tell them:

> Setup complete. The plugin is ready. To install in Claude Code:
>
> ```
> /plugin marketplace add southlab-ai/x811
> /plugin install x811@x811-marketplace
> ```
>
> Then restart Claude Code. The MCP server runs from the bundled file — no npm publish needed.
