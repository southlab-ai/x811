---
name: setup
description: First-time setup for x811 Protocol — build all packages and publish @x811/core, @x811/sdk, and @x811/mcp-server to npm
---

# x811 Setup — First-Time Publish

Builds and publishes the three x811 npm packages in the correct dependency order so that `npx -y @x811/mcp-server` works for anyone installing the plugin.

## Prerequisites Check

Before starting, verify:

1. **npm login** — Run `npm whoami` to confirm the user is logged into npm. If not, tell them to run `npm login` first and stop.
2. **Repository root** — This skill must run from the x811 monorepo root (the directory containing `turbo.json`). Check that `turbo.json` exists in the current working directory. If not, tell the user to `cd` to the repo root and stop.

## Step 1: Clean Build

Run a full clean build to ensure all `dist/` directories are fresh:

```bash
npx turbo run clean
npx turbo run build
```

If the build fails, show the error and stop. Do not publish broken packages.

## Step 2: Run Tests

Run the full test suite to make sure everything passes:

```bash
npm run test
```

If tests fail, show failures and stop. Do not publish untested packages.

## Step 3: Check Current npm Status

For each package, check if it's already published at the current version:

```bash
npm view @x811/core version 2>/dev/null || echo "NOT PUBLISHED"
npm view @x811/sdk version 2>/dev/null || echo "NOT PUBLISHED"
npm view @x811/mcp-server version 2>/dev/null || echo "NOT PUBLISHED"
```

Show the user which packages need publishing. If all three are already published at the current version, tell the user "All packages already published" and stop.

## Step 4: Publish in Dependency Order

Packages MUST be published in this exact order (dependency chain):

### 4a. `@x811/core` (no x811 dependencies)

```bash
cd packages/core
npm publish --access public
```

Wait for success. If it fails (e.g., version already exists), show the error. If version conflict, suggest bumping the version.

### 4b. `@x811/sdk` (depends on @x811/core)

```bash
cd packages/sdk-ts
npm publish --access public
```

Wait for success before continuing.

### 4c. `@x811/mcp-server` (depends on @x811/core + @x811/sdk)

```bash
cd packages/mcp-server
npm publish --access public
```

## Step 5: Verify Publication

After all three are published, verify they're available:

```bash
npm view @x811/core version
npm view @x811/sdk version
npm view @x811/mcp-server version
```

Then test that `npx` can resolve the MCP server:

```bash
npx -y @x811/mcp-server --help 2>&1 || true
```

## Step 6: Report

Show the user a summary:

| Package | Version | Status |
|---------|---------|--------|
| `@x811/core` | 0.x.x | Published |
| `@x811/sdk` | 0.x.x | Published |
| `@x811/mcp-server` | 0.x.x | Published |

Then tell them:

> Setup complete. Anyone can now install the x811 plugin in Claude Code:
>
> ```
> /plugin marketplace add southlab-ai/x811
> /plugin install x811@x811-marketplace
> ```
>
> Or manually add to MCP config:
> ```json
> {
>   "mcpServers": {
>     "x811": {
>       "command": "npx",
>       "args": ["-y", "@x811/mcp-server"],
>       "env": {
>         "X811_SERVER_URL": "https://api.x811.org",
>         "X811_STATE_DIR": "/path/to/my-agent-state"
>       }
>     }
>   }
> }
> ```
