'use strict';
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { keccak256, toUtf8Bytes } = require('ethers');
class AnchorBatch extends WorkloadModuleBase {
  async submitTransaction() {
    this.n = (this.n || 0) + 1;
    await this.sutAdapter.sendRequests({
      contract: 'AuditLog', verb: 'anchorBatch', readOnly: false,
      args: [keccak256(toUtf8Bytes(`batch-${this.workerIndex}-${this.n}`)), 1000],
    });
  }
}
module.exports.createWorkloadModule = () => new AnchorBatch();
