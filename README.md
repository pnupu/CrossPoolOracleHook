# CrossPoolOracleHook

A Uniswap v4 hook that uses deep-liquidity pools as free, trustless, same-block price oracles to protect thinner pools from manipulation.

## Problem

New tokens launching on Uniswap have thin liquidity pools that are easy to manipulate. External oracles (Chainlink, Pyth) are expensive and don't list new tokens. There's no affordable way for small projects to protect their pools.

## Solution

CrossPoolOracleHook reads a reference pool's price (e.g. ETH/USDC with deep liquidity) directly from Uniswap v4's singleton PoolManager during every swap on the protected pool. By comparing the reference pool's price movement against the protected pool's swap impact, the hook distinguishes legitimate market movements from manipulation attempts.

**No external oracle needed** — one Uniswap pool acts as the oracle for another.

This is only possible with Uniswap v4's singleton architecture, where all pools share one contract and hooks can read any pool's state in the same transaction.

## How It Works

On every swap in the protected pool, the hook:

1. Reads the reference pool's current price (cross-pool state read via `getSlot0`)
2. Calculates how much the reference price moved since the last swap
3. Estimates the current swap's price impact
4. Computes **unexplained impact** = swap impact - reference movement
5. Applies tiered response:
   - **Normal**: unexplained impact < 2% → base fee (0.3%)
   - **Elevated**: unexplained impact 2-10% → high fee (1%)
   - **Circuit breaker**: unexplained impact > 10% → swap blocked

If ETH drops 5% market-wide (reference pool moves 5%) and someone swaps on the protected pool causing 7% impact, only the 2% unexplained portion triggers the elevated fee — the market-wide movement is recognized as legitimate.

## Demo Results (Sepolia)

| Scenario | Input | Output | Result |
|----------|-------|--------|--------|
| Normal swap | 0.01 ETH | 0.00996 | Base fee (0.3%) |
| Large swap | 0.5 ETH | 0.471 | Elevated fee (1%) |
| After reference move | 0.5 ETH | 0.431 | Succeeds (movement explained) |
| Manipulation (50% of pool) | 5 ETH | BLOCKED | Circuit breaker triggered |

## Quick Start

```bash
# Install dependencies
forge install

# Build
forge build

# Run tests (5 tests covering all scenarios)
forge test

# Deploy to Sepolia
forge script script/DeployCrossPoolOracle.s.sol:DeployCrossPoolOracle \
  --rpc-url <RPC_URL> --private-key <KEY> --broadcast

# Run demo swaps
forge script script/DemoSwaps.s.sol:DemoSwaps \
  --rpc-url <RPC_URL> --private-key <KEY> --broadcast -v
```

## Configuration

Each protected pool is registered with:

| Parameter | Example | Description |
|-----------|---------|-------------|
| `referencePoolId` | ETH/USDC pool | Deep liquidity pool to read price from |
| `baseFee` | 3000 (0.3%) | Normal swap fee |
| `highImpactFee` | 10000 (1%) | Fee when unexplained impact is elevated |
| `highImpactThresholdBps` | 200 (2%) | Threshold for elevated fee |
| `circuitBreakerBps` | 1000 (10%) | Threshold to block swap entirely |

## Deployed on Sepolia

Contract addresses in [`deployments/sepolia.json`](deployments/sepolia.json).

## Built With

- [Uniswap v4](https://github.com/Uniswap/v4-core) — Singleton pool architecture with hooks
- [OpenZeppelin Uniswap Hooks](https://github.com/openzeppelin/uniswap-hooks) — BaseHook framework
- [Foundry](https://github.com/foundry-rs/foundry) — Solidity development toolchain
