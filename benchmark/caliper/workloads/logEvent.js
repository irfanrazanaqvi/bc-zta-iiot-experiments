'use strict';
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { keccak256, toUtf8Bytes } = require('ethers');
class LogEvent extends WorkloadModuleBase {
  async submitTransaction() {
    await this.sutAdapter.sendRequests({
      contract: 'AuditLog', verb: 'logEvent', readOnly: false,
      args: [keccak256(toUtf8Bytes('did:iiot:bench')), keccak256(toUtf8Bytes('resource:bench')), 1],
    });
  }
}
module.exports.createWorkloadModule = () => new LogEvent();
