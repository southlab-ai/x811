// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import { X811TrustAnchor } from "../src/X811TrustAnchor.sol";

/**
 * @title Deploy
 * @notice Deployment script for X811TrustAnchor.
 * @dev Usage:
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url $RPC_URL \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 *
 * Required environment variables:
 *   DEPLOYER_PRIVATE_KEY — Private key of the deployer account.
 *   RELAYER_ADDRESS      — Address authorized to submit Merkle batches.
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address relayerAddress = vm.envAddress("RELAYER_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        X811TrustAnchor anchor = new X811TrustAnchor(relayerAddress);

        vm.stopBroadcast();

        console.log("X811TrustAnchor deployed at:", address(anchor));
        console.log("Owner:", anchor.owner());
        console.log("Relayer:", anchor.relayer());
    }
}
