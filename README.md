# CrossPoolOracleHook

A Uniswap v4 hook that uses deep-liquidity pools as free, trustless, same-block price oracles to protect thinner pools from manipulation.

## Problem

New tokens launching on Uniswap have thin liquidity pools that are easy to manipulate. External oracles (Chainlink, Pyth) are expensive and don't list new tokens. There's no affordable way for small projects to protect their pools.

## Solution

CrossPoolOracleHook reads reference pools' prices (e.g. ETH/USDC, ETH/DAI with deep liquidity) directly from Uniswap v4's singleton PoolManager during every swap on the protected pool. By comparing the maximum reference price movement against the protected pool's swap impact, the hook distinguishes legitimate market movements from manipulation attempts.

**No external oracle needed** — Uniswap pools act as oracles for each other.

This is only possible with Uniswap v4's singleton architecture, where all pools share one contract and hooks can read any pool's state in the same transaction.

### Key Features

- **Cross-pool state reads** — reads any pool's price via `getSlot0` in the same tx
- **Multi-reference pools** — up to 5 reference pools per protected pool for robustness
- **Dynamic fees** — base fee for normal swaps, elevated fee for suspicious ones
- **Circuit breaker** — blocks swaps with extreme unexplained price impact
- **sqrtPrice-based impact estimation** — uses actual AMM math, not linear approximation

## How It Works

On every swap in the protected pool, the hook:

1. Reads all reference pools' current prices (cross-pool state reads via `getSlot0`)
2. Calculates the maximum price movement across all references since the last swap
3. Estimates the current swap's price impact using sqrtPrice-based AMM math
4. Computes **unexplained impact** = swap impact - max reference movement
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

# Run tests (6 hook tests + 6 helper tests)
forge test

# Deploy to Sepolia
forge script script/DeployCrossPoolOracle.s.sol:DeployCrossPoolOracle \
  --rpc-url <RPC_URL> --private-key <KEY> --broadcast

# Run demo swaps
forge script script/DemoSwaps.s.sol:DemoSwaps \
  --rpc-url <RPC_URL> --private-key <KEY> --broadcast -v

# Frontend
cd frontend && npm install && npm run dev
```

## Configuration

### Single reference pool

```solidity
hook.registerPool(protectedPoolKey, referencePoolId, true, 3000, 10000, 200, 1000);
```

### Multiple reference pools

```solidity
PoolId[] memory refs = new PoolId[](2);
refs[0] = ethUsdcPoolId;
refs[1] = ethDaiPoolId;
bool[] memory dirs = new bool[](2);
dirs[0] = true;
dirs[1] = true;
hook.registerPoolMultiRef(protectedPoolKey, refs, dirs, 3000, 10000, 200, 1000);
```

| Parameter | Example | Description |
|-----------|---------|-------------|
| `referencePoolIds` | ETH/USDC, ETH/DAI | Deep liquidity pools to read price from (max 5) |
| `baseFee` | 3000 (0.3%) | Normal swap fee |
| `highImpactFee` | 10000 (1%) | Fee when unexplained impact is elevated |
| `highImpactThresholdBps` | 200 (2%) | Threshold for elevated fee |
| `circuitBreakerBps` | 1000 (10%) | Threshold to block swap entirely |

## Deployed on Sepolia

| Contract | Address |
|----------|---------|
| Hook | [`0x9c981cdc56335664F21448cA4f40c54390B7D0C0`](https://sepolia.etherscan.io/address/0x9c981cdc56335664F21448cA4f40c54390B7D0C0) |
| WETH (test) | [`0x53f646Df4442A1Caca581078Ca63076D882640A4`](https://sepolia.etherscan.io/address/0x53f646Df4442A1Caca581078Ca63076D882640A4) |
| USDC (test) | [`0x0B2B7b0fa0ad02D6A2bbE5d93cAE06045f849C8A`](https://sepolia.etherscan.io/address/0x0B2B7b0fa0ad02D6A2bbE5d93cAE06045f849C8A) |
| NEWTOKEN (test) | [`0x12b067D6755340bd03fdFA370D73A84f7Ad06c19`](https://sepolia.etherscan.io/address/0x12b067D6755340bd03fdFA370D73A84f7Ad06c19) |

Full addresses and infrastructure in [`deployments/sepolia.json`](deployments/sepolia.json).

## Built With

- [Uniswap v4](https://github.com/Uniswap/v4-core) — Singleton pool architecture with hooks
- [OpenZeppelin Uniswap Hooks](https://github.com/openzeppelin/uniswap-hooks) — BaseHook framework
- [Foundry](https://github.com/foundry-rs/foundry) — Solidity development toolchain
- [Next.js](https://nextjs.org/) + [wagmi](https://wagmi.sh/) — Frontend
