/**
 * Deploy X811TrustAnchor to Base Sepolia or Base Mainnet.
 *
 * Usage:
 *   node scripts/deploy-contract.mjs --network sepolia
 *   node scripts/deploy-contract.mjs --network mainnet
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — Private key of the deployer (becomes contract owner)
 *   RELAYER_ADDRESS       — Address of the relayer wallet (submits Merkle batches)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const networkFlag = args.find((a) => a.startsWith("--network"));
const networkArg = networkFlag
  ? args[args.indexOf(networkFlag) + 1] ?? args[0]?.replace("--network=", "")
  : args[0];

const network = networkArg || "sepolia";

const NETWORKS = {
  sepolia: {
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
    chainId: 84532,
    explorer: "https://sepolia.basescan.org",
  },
  mainnet: {
    name: "Base Mainnet",
    rpcUrl: "https://mainnet.base.org",
    chainId: 8453,
    explorer: "https://basescan.org",
  },
};

const net = NETWORKS[network];
if (!net) {
  console.error(`Unknown network: ${network}. Use 'sepolia' or 'mainnet'.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate env
// ---------------------------------------------------------------------------

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const relayerAddress = process.env.RELAYER_ADDRESS;

if (!deployerKey) {
  console.error("Missing DEPLOYER_PRIVATE_KEY environment variable.");
  process.exit(1);
}
if (!relayerAddress) {
  console.error("Missing RELAYER_ADDRESS environment variable.");
  process.exit(1);
}

if (!ethers.isAddress(relayerAddress)) {
  console.error(`Invalid RELAYER_ADDRESS: ${relayerAddress}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load compiled artifact
// ---------------------------------------------------------------------------

const artifactPath = resolve(
  ROOT,
  "packages/contracts/out/X811TrustAnchor.json",
);
let artifact;
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch {
  console.error(
    "Compiled artifact not found. Run: node scripts/compile-contract.mjs",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

console.log(`=== Deploying X811TrustAnchor to ${net.name} ===\n`);

const provider = new ethers.JsonRpcProvider(net.rpcUrl, net.chainId);
const deployer = new ethers.Wallet(deployerKey, provider);

console.log(`Deployer:  ${deployer.address}`);
console.log(`Relayer:   ${relayerAddress}`);
console.log(`Network:   ${net.name} (chain ${net.chainId})`);
console.log(`RPC:       ${net.rpcUrl}`);

// Check deployer balance
const balance = await provider.getBalance(deployer.address);
const balanceEth = ethers.formatEther(balance);
console.log(`Balance:   ${balanceEth} ETH`);

if (balance === 0n) {
  console.error("\nDeployer has no ETH. Fund the wallet first.");
  process.exit(1);
}

console.log("\nDeploying...");

const factory = new ethers.ContractFactory(
  artifact.abi,
  artifact.bytecode,
  deployer,
);

const contract = await factory.deploy(relayerAddress);
console.log(`Tx hash:   ${contract.deploymentTransaction().hash}`);
console.log("Waiting for confirmation...");

await contract.waitForDeployment();
const contractAddress = await contract.getAddress();

console.log(`\n=== DEPLOYMENT SUCCESSFUL ===`);
console.log(`Contract:  ${contractAddress}`);
console.log(`Explorer:  ${net.explorer}/address/${contractAddress}`);
console.log(`Tx:        ${net.explorer}/tx/${contract.deploymentTransaction().hash}`);

// Verify state
const owner = await contract.owner();
const relayer = await contract.relayer();
const paused = await contract.paused();
const batchCount = await contract.batchCount();

console.log(`\n=== Contract State ===`);
console.log(`Owner:     ${owner}`);
console.log(`Relayer:   ${relayer}`);
console.log(`Paused:    ${paused}`);
console.log(`Batches:   ${batchCount}`);

// Post-deploy balance
const postBalance = await provider.getBalance(deployer.address);
const gasCost = balance - postBalance;
console.log(`\nGas cost:  ${ethers.formatEther(gasCost)} ETH`);
console.log(`Remaining: ${ethers.formatEther(postBalance)} ETH`);

console.log(`\n=== SAVE THESE VALUES ===`);
console.log(`CONTRACT_ADDRESS=${contractAddress}`);
console.log(`\nSet this in Dokploy env vars for Phase 3.`);
