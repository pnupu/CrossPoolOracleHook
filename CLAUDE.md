# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CrossPoolOracleHook** — A Uniswap v4 hook that uses a deep-liquidity reference pool (e.g. ETH/USDC) as a free, trustless, same-block price oracle for thinner pools. No Chainlink, no Pyth — just one Uniswap pool reading another's price via v4's singleton architecture.

Built for HackMoney 2026, targeting Uniswap Foundation tracks.

## Build & Test Commands

```bash
forge build                                            # Compile contracts
forge test                                             # Run all tests
forge test --match-test test_NormalSwap_BasesFee -vvv   # Run single test with traces
forge test --match-path test/CrossPoolOracleHook.t.sol  # Run hook tests only
```

## Architecture

- **Solidity ^0.8.26** / **Foundry** toolchain
- Template: [uniswapfoundation/v4-template](https://github.com/uniswapfoundation/v4-template)
- Dependencies: OpenZeppelin uniswap-hooks, hookmate, forge-std

### Core Contract: `src/CrossPoolOracleHook.sol`

Hook permissions: `afterInitialize`, `beforeSwap`, `afterSwap`

The hook reads a reference pool's `sqrtPriceX96` via `StateLibrary.getSlot0()` during `beforeSwap`. It compares reference price movement against the protected pool's swap impact to distinguish legitimate market movement from manipulation.

**Decision logic in `beforeSwap`:**
1. Read reference pool price (cross-pool state read)
2. Calculate how much the reference price moved since last swap
3. Estimate the current swap's price impact on the protected pool
4. Compute "unexplained impact" = swap impact - reference movement
5. If unexplained impact >= `circuitBreakerBps` → revert (block the swap)
6. If unexplained impact >= `highImpactThresholdBps` → return elevated fee
7. Otherwise → return base fee

`afterSwap` updates the stored reference price for the next comparison.

### Pool Setup

Two pools are required:
- **Reference pool**: Deep liquidity, no hook (e.g. WETH/USDC). Already exists on mainnet.
- **Protected pool**: Thin liquidity, uses this hook. Must be created with `LPFeeLibrary.DYNAMIC_FEE_FLAG` as the fee parameter.

The hook owner calls `registerPool()` before pool initialization to link the protected pool to its reference pool and set thresholds.

### Key Configuration (per-pool via `PoolConfig`)

- `referencePoolId`: PoolId of the deep reference pool
- `baseFee`: Normal fee (e.g. 3000 = 0.3%)
- `highImpactFee`: Elevated fee (e.g. 10000 = 1%)
- `highImpactThresholdBps`: Unexplained impact that triggers elevated fee (e.g. 200 = 2%)
- `circuitBreakerBps`: Unexplained impact that blocks the swap (e.g. 1000 = 10%)

### File Structure

```
src/
  CrossPoolOracleHook.sol    # Main hook contract
test/
  CrossPoolOracleHook.t.sol  # 5 tests covering all scenarios
  utils/                     # Test helpers (BaseTest, EasyPosm)
script/
  DeployCrossPoolOracle.s.sol # Deploy hook + tokens + pools to testnet
  DemoSwaps.s.sol             # Demo: normal swap, elevated fee, circuit breaker
deployments/
  sepolia.json                # Deployed contract addresses
```

### Sepolia Deployment

Deployed 2026-01-31. Addresses in `deployments/sepolia.json`.

Demo script: `forge script script/DemoSwaps.s.sol:DemoSwaps --rpc-url <RPC> --private-key <KEY> --broadcast -v`
