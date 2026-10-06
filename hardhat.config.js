require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Offline fallback: use the npm "solc" (solcjs) package instead of downloading a native compiler.
if (process.env.USE_SOLCJS === "1") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.20") {
      const compilerPath = require.resolve("solc/soljson.js");
      return { compilerPath, isSolcJs: true, version: "0.8.20", longVersion: "0.8.20+commit.a1b79de6" };
    }
    return runSuper();
  });
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "london" } },
  networks: {
    hardhat: { hardfork: "london" },
    besu: {
      url: process.env.BESU_RPC_URL || "http://127.0.0.1:8545",
      accounts: process.env.BESU_PRIVATE_KEY ? [process.env.BESU_PRIVATE_KEY] : [],
      chainId: 2026,
    },
  },
};
