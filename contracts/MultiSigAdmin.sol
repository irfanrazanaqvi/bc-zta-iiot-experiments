// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MultiSigAdmin
/// @notice Optional M-of-N administrator for AccessControl / AuditLog. It removes the single admin key:
///         a call (for example setPolicy or setGateway) runs only after `threshold` owners have confirmed it.
///         It was NOT used in the cloud measurements; it is exercised by unit tests only.
contract MultiSigAdmin {
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    struct Proposal { address target; bytes data; uint256 confirmations; bool executed; }
    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public confirmedBy;

    event Proposed(uint256 indexed id, address indexed proposer, address target);
    event Confirmed(uint256 indexed id, address indexed owner);
    event Executed(uint256 indexed id);

    modifier onlyOwner() { require(isOwner[msg.sender], "MultiSig: not owner"); _; }

    constructor(address[] memory _owners, uint256 _threshold) {
        require(_owners.length >= _threshold && _threshold > 0, "MultiSig: bad threshold");
        for (uint256 i = 0; i < _owners.length; i++) {
            require(!isOwner[_owners[i]] && _owners[i] != address(0), "MultiSig: bad owner");
            isOwner[_owners[i]] = true;
            owners.push(_owners[i]);
        }
        threshold = _threshold;
    }

    function propose(address target, bytes calldata data) external onlyOwner returns (uint256 id) {
        id = proposals.length;
        proposals.push(Proposal(target, data, 1, false));
        confirmedBy[id][msg.sender] = true;
        emit Proposed(id, msg.sender, target);
    }

    function confirm(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        require(!p.executed, "MultiSig: executed");
        require(!confirmedBy[id][msg.sender], "MultiSig: already confirmed");
        confirmedBy[id][msg.sender] = true;
        p.confirmations += 1;
        emit Confirmed(id, msg.sender);
    }

    function execute(uint256 id) external onlyOwner {
        Proposal storage p = proposals[id];
        require(!p.executed, "MultiSig: executed");
        require(p.confirmations >= threshold, "MultiSig: not enough confirmations");
        p.executed = true;
        emit Executed(id);
        (bool ok, ) = p.target.call(p.data);
        require(ok, "MultiSig: call failed");
    }
}
