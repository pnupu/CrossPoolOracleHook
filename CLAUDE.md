# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CrossPoolOracleHook** — A Uniswap v4 hook that uses deep-liquidity reference pools (e.g. ETH/USDC, ETH/DAI) as free, trustless, same-block price oracles for thinner pools. No Chainlink, no Pyth — just Uniswap pools reading each other's prices via v4's singleton architecture.

Built for HackMoney 2026, targeting Uniswap Foundation tracks.

## Build & Test Commands

```bash
forge build                                            # Compile contracts
forge test                                             # Run all tests (12 total)
forge test --match-path test/CrossPoolOracleHook.t.sol  # Run hook tests only (6 tests)
cd frontend && npm run dev                              # Run frontend locally
```

## Architecture

- **Solidity ^0.8.26** / **Foundry** toolchain
- **Next.js 14** / **wagmi v2** / **Tailwind CSS** frontend
- Dependencies: OpenZeppelin uniswap-hooks, hookmate, forge-std

### Core Contract: `src/CrossPoolOracleHook.sol`

Hook permissions: `afterInitialize`, `beforeSwap`, `afterSwap`

The hook reads reference pools' `sqrtPriceX96` via `StateLibrary.getSlot0()` during `beforeSwap`. It compares the maximum reference price movement against the protected pool's swap impact to distinguish legitimate market movement from manipulation.

**Multi-reference support**: Up to 5 reference pools per protected pool. The hook takes the maximum price movement across all references (most generous to the trader). If ANY reference pool moved, that movement is credited as "explained."

**Decision logic in `beforeSwap`:**
1. Read all reference pools' prices (cross-pool state reads)
2. Calculate max reference price movement since last swap
3. Estimate the current swap's price impact using sqrtPrice-based AMM math
4. Compute "unexplained impact" = swap impact - max reference movement
5. If unexplained impact >= `circuitBreakerBps` → revert (block the swap)
6. If unexplained impact >= `highImpactThresholdBps` → return elevated fee
7. Otherwise → return base fee

`afterSwap` updates stored reference prices for next comparison.

### Pool Setup

At least two pools are required:
- **Reference pool(s)**: Deep liquidity, no hook (e.g. WETH/USDC). Already exist on mainnet.
- **Protected pool**: Thin liquidity, uses this hook. Must be created with `LPFeeLibrary.DYNAMIC_FEE_FLAG`.

The hook owner calls `registerPool()` (single ref) or `registerPoolMultiRef()` (multiple refs) before pool initialization.

### Key Configuration (per-pool via `PoolConfig`)

- `referencePoolIds`: Array of PoolIds of deep reference pools (max 5)
- `baseFee`: Normal fee (e.g. 3000 = 0.3%)
- `highImpactFee`: Elevated fee (e.g. 10000 = 1%)
- `highImpactThresholdBps`: Unexplained impact that triggers elevated fee (e.g. 200 = 2%)
- `circuitBreakerBps`: Unexplained impact that blocks the swap (e.g. 1000 = 10%)

### File Structure

```
src/
  CrossPoolOracleHook.sol      # Main hook contract
test/
  CrossPoolOracleHook.t.sol    # 6 tests (single-ref + multi-ref scenarios)
  utils/                       # Test helpers (BaseTest, EasyPosm)
script/
  DeployCrossPoolOracle.s.sol  # Deploy hook + tokens + pools to testnet
  DemoSwaps.s.sol              # Demo: normal swap, elevated fee, circuit breaker
deployments/
  sepolia.json                 # Deployed contract addresses
frontend/
  app/                         # Next.js app router pages
  components/                  # PoolCard, SwapPanel, EventLog, ConnectButton
  lib/                         # Contract addresses, ABIs, price math utils
```

### Sepolia Deployment

Deployed 2026-01-31. Addresses in `deployments/sepolia.json`.
Hook contract verified on Etherscan.

```bash
# Deploy
forge script script/DeployCrossPoolOracle.s.sol:DeployCrossPoolOracle \
  --rpc-url <RPC> --private-key <KEY> --broadcast

# Demo swaps
forge script script/DemoSwaps.s.sol:DemoSwaps \
  --rpc-url <RPC> --private-key <KEY> --broadcast -v

# Frontend
cd frontend && npm install && npm run dev
```
