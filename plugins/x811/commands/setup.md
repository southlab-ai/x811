---
description: Developer setup — build, test, and bundle the MCP server plugin
argument-hint: ""
---

# /x811:setup

Developer setup for the x811 Protocol. Builds all packages and bundles the MCP server into the plugin.

## Workflow

1. Clean build all packages (`turbo clean && turbo build`)
2. Run tests (`npm run test`)
3. Bundle plugin (`npm run bundle:plugin`)
4. Verify the bundle starts correctly
5. Show results
