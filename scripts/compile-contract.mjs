/**
 * Compile X811TrustAnchor.sol using solc with OpenZeppelin import resolution.
 * Outputs ABI + bytecode to packages/contracts/out/
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONTRACTS_DIR = resolve(ROOT, "packages/contracts/src");
const OUT_DIR = resolve(ROOT, "packages/contracts/out");

// Read the main contract
const contractSource = readFileSync(
  resolve(CONTRACTS_DIR, "X811TrustAnchor.sol"),
  "utf8",
);

// Solc standard JSON input
const input = {
  language: "Solidity",
  sources: {
    "X811TrustAnchor.sol": { content: contractSource },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

// Import resolver: handles @openzeppelin imports
function findImports(importPath) {
  try {
    // Try node_modules resolution
    const resolved = resolve(ROOT, "node_modules", importPath);
    return { contents: readFileSync(resolved, "utf8") };
  } catch {
    return { error: `File not found: ${importPath}` };
  }
}

console.log("Compiling X811TrustAnchor.sol...");
const output = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImports }),
);

// Check for errors
if (output.errors) {
  const errors = output.errors.filter((e) => e.severity === "error");
  if (errors.length > 0) {
    console.error("Compilation errors:");
    errors.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
  }
  // Show warnings
  output.errors
    .filter((e) => e.severity === "warning")
    .forEach((w) => console.warn("Warning:", w.message));
}

const compiled =
  output.contracts["X811TrustAnchor.sol"]["X811TrustAnchor"];
const abi = compiled.abi;
const bytecode = compiled.evm.bytecode.object;

// Write output
mkdirSync(OUT_DIR, { recursive: true });

const artifact = {
  contractName: "X811TrustAnchor",
  abi,
  bytecode: `0x${bytecode}`,
};

writeFileSync(
  resolve(OUT_DIR, "X811TrustAnchor.json"),
  JSON.stringify(artifact, null, 2),
);

console.log(`Compiled successfully.`);
console.log(`  ABI: ${abi.length} entries`);
console.log(`  Bytecode: ${bytecode.length / 2} bytes`);
console.log(`  Output: packages/contracts/out/X811TrustAnchor.json`);
