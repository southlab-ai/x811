// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import { X811TrustAnchor } from "../src/X811TrustAnchor.sol";

contract X811TrustAnchorTest is Test {
    X811TrustAnchor public anchor;

    address public owner = address(this);
    address public relayer = address(0xBEEF);
    address public nonOwner = address(0xDEAD);

    // A sample Merkle root (32 bytes)
    bytes32 constant SAMPLE_ROOT = keccak256("batch-1-root");
    bytes32 constant SAMPLE_ROOT_2 = keccak256("batch-2-root");

    function setUp() public {
        anchor = new X811TrustAnchor(relayer);
    }

    // -----------------------------------------------------------------------
    // submitBatch
    // -----------------------------------------------------------------------

    function test_submitBatch() public {
        vm.prank(relayer);
        anchor.submitBatch(SAMPLE_ROOT, 100);

        assertEq(anchor.batchCount(), 1);

        (bytes32 root, uint256 ts, uint256 count) = anchor.batches(1);
        assertEq(root, SAMPLE_ROOT);
        assertEq(count, 100);
        assertEq(ts, block.timestamp);
    }

    function test_revertIfNotRelayer() public {
        vm.prank(nonOwner);
        vm.expectRevert(X811TrustAnchor.OnlyRelayer.selector);
        anchor.submitBatch(SAMPLE_ROOT, 100);
    }

    function test_revertEmptyRoot() public {
        vm.prank(relayer);
        vm.expectRevert(X811TrustAnchor.EmptyMerkleRoot.selector);
        anchor.submitBatch(bytes32(0), 100);
    }

    function test_revertZeroCount() public {
        vm.prank(relayer);
        vm.expectRevert(X811TrustAnchor.ZeroInteractionCount.selector);
        anchor.submitBatch(SAMPLE_ROOT, 0);
    }

    function test_revertWhenPaused() public {
        anchor.pause();

        vm.prank(relayer);
        vm.expectRevert(X811TrustAnchor.ContractPaused.selector);
        anchor.submitBatch(SAMPLE_ROOT, 100);
    }

    function test_multipleBatches() public {
        vm.startPrank(relayer);
        anchor.submitBatch(SAMPLE_ROOT, 50);
        anchor.submitBatch(SAMPLE_ROOT_2, 75);
        vm.stopPrank();

        assertEq(anchor.batchCount(), 2);

        (bytes32 root1, , uint256 count1) = anchor.batches(1);
        assertEq(root1, SAMPLE_ROOT);
        assertEq(count1, 50);

        (bytes32 root2, , uint256 count2) = anchor.batches(2);
        assertEq(root2, SAMPLE_ROOT_2);
        assertEq(count2, 75);
    }

    // -----------------------------------------------------------------------
    // totalInteractions
    // -----------------------------------------------------------------------

    function test_totalInteractions() public {
        vm.startPrank(relayer);
        anchor.submitBatch(SAMPLE_ROOT, 50);
        anchor.submitBatch(SAMPLE_ROOT_2, 75);
        vm.stopPrank();

        assertEq(anchor.totalInteractions(), 125);
    }

    function test_totalInteractions_empty() public view {
        assertEq(anchor.totalInteractions(), 0);
    }

    // -----------------------------------------------------------------------
    // verifyInclusion
    // -----------------------------------------------------------------------

    function test_verifyInclusion() public {
        // Build a simple Merkle tree: two leaves -> one root
        bytes32 leaf1 = keccak256("interaction-1");
        bytes32 leaf2 = keccak256("interaction-2");

        // OZ MerkleProof expects: for a pair of leaves, the root is
        // hash(min(leaf1, leaf2), max(leaf1, leaf2))
        bytes32 computedRoot;
        if (leaf1 <= leaf2) {
            computedRoot = keccak256(abi.encodePacked(leaf1, leaf2));
        } else {
            computedRoot = keccak256(abi.encodePacked(leaf2, leaf1));
        }

        vm.prank(relayer);
        anchor.submitBatch(computedRoot, 2);

        // Proof for leaf1: sibling is leaf2
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leaf2;

        assertTrue(anchor.verifyInclusion(1, leaf1, proof));

        // Proof for leaf2: sibling is leaf1
        proof[0] = leaf1;
        assertTrue(anchor.verifyInclusion(1, leaf2, proof));

        // Verify a non-existent leaf fails
        bytes32 fakeLeaf = keccak256("fake");
        bytes32[] memory fakeProof = new bytes32[](1);
        fakeProof[0] = leaf2;
        assertFalse(anchor.verifyInclusion(1, fakeLeaf, fakeProof));
    }

    function test_verifyInclusion_invalidBatch() public {
        vm.expectRevert(X811TrustAnchor.BatchNotFound.selector);
        anchor.verifyInclusion(0, bytes32(0), new bytes32[](0));

        vm.expectRevert(X811TrustAnchor.BatchNotFound.selector);
        anchor.verifyInclusion(99, bytes32(0), new bytes32[](0));
    }

    // -----------------------------------------------------------------------
    // setRelayer
    // -----------------------------------------------------------------------

    function test_setRelayer() public {
        address newRelayer = address(0xCAFE);
        anchor.setRelayer(newRelayer);
        assertEq(anchor.relayer(), newRelayer);
    }

    function test_setRelayer_revertNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(X811TrustAnchor.OnlyOwner.selector);
        anchor.setRelayer(address(0xCAFE));
    }

    function test_setRelayer_revertZeroAddress() public {
        vm.expectRevert(X811TrustAnchor.ZeroAddress.selector);
        anchor.setRelayer(address(0));
    }

    // -----------------------------------------------------------------------
    // pause / unpause
    // -----------------------------------------------------------------------

    function test_pause_unpause() public {
        assertFalse(anchor.paused());

        anchor.pause();
        assertTrue(anchor.paused());

        anchor.unpause();
        assertFalse(anchor.paused());

        // Verify relayer can submit after unpause
        vm.prank(relayer);
        anchor.submitBatch(SAMPLE_ROOT, 10);
        assertEq(anchor.batchCount(), 1);
    }

    function test_pause_revertNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(X811TrustAnchor.OnlyOwner.selector);
        anchor.pause();
    }

    function test_unpause_revertWhenNotPaused() public {
        vm.expectRevert(X811TrustAnchor.ContractNotPaused.selector);
        anchor.unpause();
    }

    function test_pause_revertAlreadyPaused() public {
        anchor.pause();
        vm.expectRevert(X811TrustAnchor.ContractPaused.selector);
        anchor.pause();
    }

    // -----------------------------------------------------------------------
    // transferOwnership
    // -----------------------------------------------------------------------

    function test_transferOwnership() public {
        address newOwner = address(0xFACE);
        anchor.transferOwnership(newOwner);
        assertEq(anchor.owner(), newOwner);
    }

    function test_transferOwnership_revertNonOwner() public {
        vm.prank(nonOwner);
        vm.expectRevert(X811TrustAnchor.OnlyOwner.selector);
        anchor.transferOwnership(address(0xFACE));
    }

    function test_transferOwnership_revertZeroAddress() public {
        vm.expectRevert(X811TrustAnchor.ZeroAddress.selector);
        anchor.transferOwnership(address(0));
    }

    function test_revertNonOwner_allAdminFunctions() public {
        vm.startPrank(nonOwner);

        vm.expectRevert(X811TrustAnchor.OnlyOwner.selector);
        anchor.pause();

        vm.expectRevert(X811TrustAnchor.OnlyOwner.selector);
        anchor.setRelayer(address(0xCAFE));

        vm.expectRevert(X811TrustAnchor.OnlyOwner.selector);
        anchor.transferOwnership(address(0xCAFE));

        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Constructor edge cases
    // -----------------------------------------------------------------------

    function test_constructor_revertZeroRelayer() public {
        vm.expectRevert(X811TrustAnchor.ZeroAddress.selector);
        new X811TrustAnchor(address(0));
    }

    function test_constructor_setsOwner() public view {
        assertEq(anchor.owner(), owner);
    }

    function test_constructor_setsRelayer() public view {
        assertEq(anchor.relayer(), relayer);
    }
}
