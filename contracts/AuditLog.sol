// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AuditLog
/// @notice Append-only, tamper-evident audit trail for every state-changing
///         transaction in the BC-ZTA architecture (identity, access,
///         trust-score events). Satisfies security requirement SR5.
contract AuditLog {
    struct Entry {
        bytes32 did;
        bytes32 resourceId;
        uint8 eventType; // 0=auth, 1=authz, 2=trust-update, 3=revocation, 4=anomaly
        uint256 timestamp;
        address reporter;
    }

    /// @dev Batch anchor: the edge/fog tier hashes many audit records into a Merkle
    ///      root off-chain and anchors only the root, so per-access cost on-chain is
    ///      amortized across the batch (see paper, Sections 3.9 and 6.4).
    struct Anchor {
        bytes32 root;
        uint256 count;
        uint256 timestamp;
        address reporter;
    }

    Entry[] private entries;
    Anchor[] private anchors;
    mapping(bytes32 => uint256[]) private entriesByDID;

    event BatchAnchored(uint256 indexed index, bytes32 root, uint256 count);

    event EventLogged(uint256 indexed index, bytes32 indexed did, uint8 eventType);

    function logEvent(
        bytes32 did,
        bytes32 resourceId,
        uint8 eventType
    ) external returns (uint256 index) {
        entries.push(Entry(did, resourceId, eventType, block.timestamp, msg.sender));
        index = entries.length - 1;
        entriesByDID[did].push(index);
        emit EventLogged(index, did, eventType);
    }

    function getAuditTrail(bytes32 did) external view returns (uint256[] memory) {
        return entriesByDID[did];
    }

    function getEntry(uint256 index) external view returns (Entry memory) {
        return entries[index];
    }

    function totalEntries() external view returns (uint256) {
        return entries.length;
    }

    /// @notice Anchor the Merkle root of an off-chain batch of audit records.
    function anchorBatch(bytes32 root, uint256 count) external returns (uint256 index) {
        require(count > 0, "AuditLog: empty batch");
        anchors.push(Anchor(root, count, block.timestamp, msg.sender));
        index = anchors.length - 1;
        emit BatchAnchored(index, root, count);
    }

    function getAnchor(uint256 index) external view returns (Anchor memory) {
        return anchors[index];
    }

    function totalAnchors() external view returns (uint256) {
        return anchors.length;
    }

    /// @notice Verify that a hashed audit record belongs to an anchored batch
    ///         (sorted-pair keccak256 Merkle proof).
    function verifyInBatch(
        bytes32 leaf,
        uint256 anchorIndex,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == anchors[anchorIndex].root;
    }
}
