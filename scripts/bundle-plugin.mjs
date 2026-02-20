#!/usr/bin/env node

/**
 * Bundle the MCP server + SDK + core into a single file for the plugin.
 *
 * Output: plugins/x811/dist/index.js
 *
 * Usage: node scripts/bundle-plugin.mjs
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

await build({
  entryPoints: [join(root, "packages/mcp-server/src/index.ts")],
  outfile: join(root, "plugins/x811/dist/index.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  minify: false,
});

console.log("✓ Bundled → plugins/x811/dist/index.mjs");
