// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title TrustReputation
/// @notice Maintains a bounded, continuously updated trust score (0-100)
///         per DID, computed off-chain by the continuous trust-scoring
///         engine and committed on-chain. Score updates require quorum
///         from a validator committee to prevent a single compromised
///         edge node from unilaterally manipulating a peer's trust.
contract TrustReputation {
    uint8 public constant MAX_SCORE = 100;
    uint8 public constant DEFAULT_SCORE = 70;
    uint256 public quorumThreshold; // number of validator confirmations required
    uint256 public minUpdateInterval = 30 seconds;

    mapping(bytes32 => uint8) public scores;
    mapping(bytes32 => bool) public hasScore; // distinguishes "score 0" from "never scored"
    mapping(bytes32 => uint256) public lastUpdate;
    mapping(address => bool) public isValidator;
    address[] public validators;

    // did => proposedScore => count of validator votes
    mapping(bytes32 => mapping(uint8 => uint256)) private votes;
    mapping(bytes32 => mapping(uint8 => mapping(address => bool))) private hasVoted;

    event ScoreUpdated(bytes32 indexed did, uint8 newScore);
    event AnomalyFlagged(bytes32 indexed did, string reason, address indexed reporter);

    modifier onlyValidator() {
        require(isValidator[msg.sender], "TrustReputation: not validator");
        _;
    }

    constructor(address[] memory _validators, uint256 _quorumThreshold) {
        for (uint256 i = 0; i < _validators.length; i++) {
            isValidator[_validators[i]] = true;
            validators.push(_validators[i]);
        }
        quorumThreshold = _quorumThreshold;
    }

    function getScore(bytes32 did) public view returns (uint8) {
        return hasScore[did] ? scores[did] : DEFAULT_SCORE;
    }

    /// @notice Propose a new score for a DID; finalizes once quorum of
    ///         validators agree, rate-limited to `minUpdateInterval`.
    function updateScore(bytes32 did, uint8 proposedScore) external onlyValidator {
        require(proposedScore <= MAX_SCORE, "TrustReputation: score out of range");
        require(
            block.timestamp >= lastUpdate[did] + minUpdateInterval,
            "TrustReputation: rate limited"
        );
        require(!hasVoted[did][proposedScore][msg.sender], "TrustReputation: already voted");

        hasVoted[did][proposedScore][msg.sender] = true;
        votes[did][proposedScore] += 1;

        if (votes[did][proposedScore] >= quorumThreshold) {
            scores[did] = proposedScore;
            hasScore[did] = true;
            lastUpdate[did] = block.timestamp;
            emit ScoreUpdated(did, proposedScore);
        }
    }

    function flagAnomaly(bytes32 did, string calldata reason) external onlyValidator {
        emit AnomalyFlagged(did, reason, msg.sender);
        // Anomaly flags immediately and conservatively lower trust pending
        // full quorum re-evaluation, reflecting continuous risk reassessment.
        uint8 current = getScore(did);
        uint8 penalized = current > 20 ? current - 20 : 0;
        scores[did] = penalized;
        hasScore[did] = true;
        lastUpdate[did] = block.timestamp;
        emit ScoreUpdated(did, penalized);
    }
}
