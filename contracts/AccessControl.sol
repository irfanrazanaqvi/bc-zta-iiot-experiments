// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IdentityRegistry.sol";
import "./TrustReputation.sol";

/// @title AccessControl
/// @notice Attribute-based access control (ABAC) contract implementing the
///         policy-decision logic of the zero-trust security layer. Every
///         grant is least-privilege and time-bound; sessions must be
///         re-evaluated rather than persisting indefinitely.
contract AccessControl {
    IdentityRegistry public identityRegistry;
    TrustReputation public trustReputation;
    address public policyAdmin;

    struct Policy {
        uint8 minDeviceClass;   // minimum permitted device class attribute
        uint8 maxDeviceClass;
        uint8 minTrustScore;    // 0-100
        uint32 sessionTTL;      // seconds
        bool active;
    }

    // resourceId => policy
    mapping(bytes32 => Policy) public policies;
    // sessionId => expiry timestamp
    mapping(bytes32 => uint256) public sessionExpiry;

    event PolicySet(bytes32 indexed resourceId, uint8 minClass, uint8 maxClass, uint8 minTrust, uint32 ttl);
    event AccessEvaluated(bytes32 indexed did, bytes32 indexed resourceId, bool granted);
    event SessionGranted(bytes32 indexed sessionId, bytes32 indexed did, bytes32 indexed resourceId, uint256 expiry);
    event SessionRevoked(bytes32 indexed sessionId);

    modifier onlyAdmin() {
        require(msg.sender == policyAdmin, "AccessControl: not admin");
        _;
    }

    constructor(address _identityRegistry, address _trustReputation) {
        identityRegistry = IdentityRegistry(_identityRegistry);
        trustReputation = TrustReputation(_trustReputation);
        policyAdmin = msg.sender;
    }

    function setPolicy(
        bytes32 resourceId,
        uint8 minClass,
        uint8 maxClass,
        uint8 minTrust,
        uint32 ttl
    ) external onlyAdmin {
        policies[resourceId] = Policy(minClass, maxClass, minTrust, ttl, true);
        emit PolicySet(resourceId, minClass, maxClass, minTrust, ttl);
    }

    /// @notice Continuous, per-request policy evaluation (PDP function).
    function evaluateRequest(
        bytes32 did,
        bytes32 resourceId,
        uint8 deviceClass
    ) public view returns (bool granted) {
        if (!identityRegistry.isActive(did)) return false;
        Policy memory p = policies[resourceId];
        if (!p.active) return false;
        if (deviceClass < p.minDeviceClass || deviceClass > p.maxDeviceClass) return false;
        uint8 score = trustReputation.getScore(did);
        if (score < p.minTrustScore) return false;
        return true;
    }

    function grantSession(
        bytes32 did,
        bytes32 resourceId,
        uint8 deviceClass
    ) external returns (bytes32 sessionId) {
        bool granted = evaluateRequest(did, resourceId, deviceClass);
        emit AccessEvaluated(did, resourceId, granted);
        require(granted, "AccessControl: access denied");

        Policy memory p = policies[resourceId];
        sessionId = keccak256(abi.encodePacked(did, resourceId, block.timestamp, block.number));
        sessionExpiry[sessionId] = block.timestamp + p.sessionTTL;
        emit SessionGranted(sessionId, did, resourceId, sessionExpiry[sessionId]);
    }

    function isSessionValid(bytes32 sessionId) external view returns (bool) {
        return sessionExpiry[sessionId] > block.timestamp;
    }

    function revokeSession(bytes32 sessionId) external onlyAdmin {
        sessionExpiry[sessionId] = 0;
        emit SessionRevoked(sessionId);
    }
}
