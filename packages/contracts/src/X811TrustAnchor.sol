// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title X811TrustAnchor
 * @notice On-chain trust anchor for the x811 Protocol. Stores Merkle roots of
 *         batched agent interaction hashes and supports inclusion verification.
 * @dev Only the designated relayer can submit batches. The owner can update the
 *      relayer address and pause/unpause the contract.
 */
contract X811TrustAnchor {
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Batch {
        bytes32 merkleRoot;
        uint256 timestamp;
        uint256 interactionCount;
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /// @notice All submitted batches, indexed from 1.
    mapping(uint256 => Batch) public batches;

    /// @notice Number of batches submitted.
    uint256 public batchCount;

    /// @notice Address authorized to submit batches.
    address public relayer;

    /// @notice Contract owner (deployer).
    address public owner;

    /// @notice Whether the contract is paused.
    bool public paused;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event BatchSubmitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 interactionCount, uint256 timestamp);
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error OnlyRelayer();
    error OnlyOwner();
    error ContractPaused();
    error ContractNotPaused();
    error EmptyMerkleRoot();
    error ZeroInteractionCount();
    error ZeroAddress();
    error BatchNotFound();

    // -----------------------------------------------------------------------
    // Modifiers
    // -----------------------------------------------------------------------

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier whenPaused() {
        if (!paused) revert ContractNotPaused();
        _;
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param _relayer Address authorized to submit Merkle root batches.
     */
    constructor(address _relayer) {
        if (_relayer == address(0)) revert ZeroAddress();
        owner = msg.sender;
        relayer = _relayer;
    }

    // -----------------------------------------------------------------------
    // Admin functions
    // -----------------------------------------------------------------------

    /**
     * @notice Pause the contract, preventing new batch submissions.
     */
    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the contract.
     */
    function unpause() external onlyOwner whenPaused {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Update the relayer address.
     * @param _newRelayer New relayer address.
     */
    function setRelayer(address _newRelayer) external onlyOwner {
        if (_newRelayer == address(0)) revert ZeroAddress();
        address old = relayer;
        relayer = _newRelayer;
        emit RelayerUpdated(old, _newRelayer);
    }

    /**
     * @notice Transfer contract ownership.
     * @param _newOwner New owner address.
     */
    function transferOwnership(address _newOwner) external onlyOwner {
        if (_newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = _newOwner;
        emit OwnershipTransferred(previous, _newOwner);
    }

    // -----------------------------------------------------------------------
    // Batch submission
    // -----------------------------------------------------------------------

    /**
     * @notice Submit a new batch of interaction hashes as a Merkle root.
     * @param _root Merkle root of the interaction hashes.
     * @param _count Number of interactions in the batch.
     */
    function submitBatch(bytes32 _root, uint256 _count) external onlyRelayer whenNotPaused {
        if (_root == bytes32(0)) revert EmptyMerkleRoot();
        if (_count == 0) revert ZeroInteractionCount();

        batchCount++;
        batches[batchCount] = Batch({
            merkleRoot: _root,
            timestamp: block.timestamp,
            interactionCount: _count
        });

        emit BatchSubmitted(batchCount, _root, _count, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Verification
    // -----------------------------------------------------------------------

    /**
     * @notice Verify that a leaf is included in a submitted batch.
     * @param _batchId ID of the batch to verify against.
     * @param _leaf The leaf hash to verify.
     * @param _proof Merkle proof (array of sibling hashes).
     * @return True if the leaf is included in the batch's Merkle tree.
     */
    function verifyInclusion(
        uint256 _batchId,
        bytes32 _leaf,
        bytes32[] calldata _proof
    ) external view returns (bool) {
        if (_batchId == 0 || _batchId > batchCount) revert BatchNotFound();
        return MerkleProof.verify(_proof, batches[_batchId].merkleRoot, _leaf);
    }

    // -----------------------------------------------------------------------
    // View functions
    // -----------------------------------------------------------------------

    /**
     * @notice Get the total number of interactions across all batches.
     * @return total Sum of all batch interaction counts.
     */
    function totalInteractions() external view returns (uint256 total) {
        for (uint256 i = 1; i <= batchCount; i++) {
            total += batches[i].interactionCount;
        }
    }
}
