---
description: First-time setup — build, test, and publish @x811/core, @x811/sdk, @x811/mcp-server to npm
argument-hint: ""
---

# /x811:setup

First-time setup for the x811 Protocol npm packages.

## Workflow

1. Verify npm login (`npm whoami`)
2. Clean build all packages (`turbo clean && turbo build`)
3. Run tests (`npm run test`)
4. Check which packages are already published
5. Publish in order: `@x811/core` → `@x811/sdk` → `@x811/mcp-server`
6. Verify all packages are available on npm
7. Show install instructions
