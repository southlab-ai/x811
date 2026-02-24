/**
 * Generate deployer + relayer wallets for X811TrustAnchor deployment.
 * Outputs private keys and addresses — SAVE THESE SECURELY.
 */

import { ethers } from "ethers";

console.log("=== x811 Wallet Generator ===\n");

// Deployer wallet (owns the contract, can pause/update relayer)
const deployer = ethers.Wallet.createRandom();
console.log("DEPLOYER (contract owner):");
console.log(`  Address:     ${deployer.address}`);
console.log(`  Private Key: ${deployer.privateKey}`);

console.log("");

// Relayer wallet (submits Merkle batches, needs gas ETH on Base)
const relayer = ethers.Wallet.createRandom();
console.log("RELAYER (batch submitter — used by server):");
console.log(`  Address:     ${relayer.address}`);
console.log(`  Private Key: ${relayer.privateKey}`);

console.log("\n=== NEXT STEPS ===");
console.log("1. Fund DEPLOYER with ETH on the target network (Base Sepolia or Base mainnet)");
console.log("   - Base Sepolia faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia");
console.log("   - Or use https://faucet.quicknode.com/base/sepolia");
console.log("2. Run deployment:");
console.log("   DEPLOYER_PRIVATE_KEY=0x... RELAYER_ADDRESS=0x... node scripts/deploy-contract.mjs --network sepolia");
console.log("3. After testing on Sepolia, deploy to mainnet:");
console.log("   DEPLOYER_PRIVATE_KEY=0x... RELAYER_ADDRESS=0x... node scripts/deploy-contract.mjs --network mainnet");
console.log("4. Fund RELAYER with ~0.01 ETH on Base mainnet for gas");
console.log("5. Set CONTRACT_ADDRESS and RELAYER_PRIVATE_KEY in Dokploy env vars");
console.log("\nSAVE BOTH PRIVATE KEYS SECURELY. Never commit them to git.");
