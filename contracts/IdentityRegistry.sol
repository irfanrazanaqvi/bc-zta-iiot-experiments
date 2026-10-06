// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IdentityRegistry
/// @notice On-chain registry of decentralized identifiers (DIDs) for IIoT
///         devices, edge gateways, and human operators. Device onboarding is
///         batched into fixed epochs and committed as a sparse-Merkle-tree
///         (SMT) root to amortize per-device gas/storage cost, following the
///         epoch/batch registration pattern reported in:
///         M. Asim et al., "Lightweight and privacy-aware decentralized
///         identity management for Industrial Internet of Things
///         applications," Future Generation Computer Systems, vol. 186,
///         Art. no. 108753, 2027. https://doi.org/10.1016/j.future.2026.108753
contract IdentityRegistry {
    address public plantAuthority; // plant-authorized registrar
    uint256 public currentEpoch;
    uint256 public epochLength = 1 hours;
    uint256 public epochStart;

    struct DIDRecord {
        bytes32 pubKeyHash;      // hash of device/operator public key
        uint8 deviceClass;       // 0 = PLC, 1 = sensor, 2 = gateway, 3 = operator
        bool revoked;
        uint256 registeredEpoch;
    }

    // did => record
    mapping(bytes32 => DIDRecord) public records;
    // epoch => sparse-Merkle-tree root committing that epoch's batch of DIDs
    mapping(uint256 => bytes32) public epochRoot;

    event DIDRegistered(bytes32 indexed did, uint256 indexed epoch, uint8 deviceClass);
    event DIDRevoked(bytes32 indexed did);
    event KeyUpdated(bytes32 indexed did, bytes32 newPubKeyHash);
    event EpochCommitted(uint256 indexed epoch, bytes32 root, uint256 batchSize);

    modifier onlyAuthority() {
        require(msg.sender == plantAuthority, "IdentityRegistry: not authority");
        _;
    }

    constructor(address _plantAuthority) {
        plantAuthority = _plantAuthority;
        epochStart = block.timestamp;
        currentEpoch = 0;
    }

    /// @notice Register (or pre-stage) a single DID; actual finalization
    ///         happens when the registrar commits the epoch's SMT root.
    function registerDID(bytes32 did, bytes32 pubKeyHash, uint8 deviceClass)
        external
        onlyAuthority
    {
        require(records[did].pubKeyHash == bytes32(0), "IdentityRegistry: exists");
        records[did] = DIDRecord({
            pubKeyHash: pubKeyHash,
            deviceClass: deviceClass,
            revoked: false,
            registeredEpoch: currentEpoch
        });
        emit DIDRegistered(did, currentEpoch, deviceClass);
    }

    /// @notice Commit the sparse-Merkle-tree root for the current epoch's
    ///         batch of registrations and advance to the next epoch.
    function commitEpoch(bytes32 root, uint256 batchSize) external onlyAuthority {
        epochRoot[currentEpoch] = root;
        emit EpochCommitted(currentEpoch, root, batchSize);
        currentEpoch += 1;
        epochStart = block.timestamp;
    }

    /// @notice Verify a device's membership in an epoch batch via Merkle
    ///         proof, avoiding a full on-chain lookup for every access check.
    function verifyMembership(
        bytes32 did,
        uint256 epoch,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 computed = did;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == epochRoot[epoch];
    }

    function revokeDID(bytes32 did) external onlyAuthority {
        require(records[did].pubKeyHash != bytes32(0), "IdentityRegistry: unknown DID");
        records[did].revoked = true;
        emit DIDRevoked(did);
    }

    function updateKey(bytes32 did, bytes32 newPubKeyHash) external onlyAuthority {
        require(records[did].pubKeyHash != bytes32(0), "IdentityRegistry: unknown DID");
        records[did].pubKeyHash = newPubKeyHash;
        emit KeyUpdated(did, newPubKeyHash);
    }

    function isActive(bytes32 did) external view returns (bool) {
        DIDRecord memory r = records[did];
        return r.pubKeyHash != bytes32(0) && !r.revoked;
    }
}
