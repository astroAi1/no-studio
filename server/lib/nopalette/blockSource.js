"use strict";

class EthereumBlockSource {
  constructor(options = {}) {
    this.rpcUrl = String(options.rpcUrl || process.env.ETH_RPC_URL || "").trim();
    this.chainId = Number(options.chainId || process.env.ETH_CHAIN_ID || 1) || 1;
  }

  hasLiveHead() {
    return Boolean(this.rpcUrl);
  }

  async getLatestHead() {
    if (!this.hasLiveHead()) {
      const error = new Error("live-head-unavailable");
      error.code = "live-head-unavailable";
      throw error;
    }

    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
    });

    if (!response.ok) {
      throw new Error(`rpc-head-failed (${response.status})`);
    }

    const payload = await response.json();
    const result = payload && payload.result ? String(payload.result) : "";
    const blockNumber = Number.parseInt(result, 16);
    if (!Number.isFinite(blockNumber) || blockNumber < 0) {
      throw new Error("invalid-rpc-block-number");
    }

    return {
      number: blockNumber,
      chainId: this.chainId,
      source: "rpc",
    };
  }
}

module.exports = {
  EthereumBlockSource,
};
