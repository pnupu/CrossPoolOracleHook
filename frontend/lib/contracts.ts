import { type Address } from "viem";

// === Sepolia deployment addresses ===
export const ADDRESSES = {
  hook: "0x4112Af357570ADc7C6D35801Af1d64eEb57e90c0" as Address,
  weth: "0xB33638d05b9A69bb1731027d3F3561Cc03aD2c74" as Address,
  usdc: "0x75EaaB39eB72db66372852e1beeFebA2dE5FE7f5" as Address,
  newtoken: "0xF4EB0d2406aD8897c0350b7be2551663a765c234" as Address,
  poolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543" as Address,
  swapRouter: "0xf13D190e9117920c703d79B5F33732e10049b115" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
} as const;

// === Pool keys ===
// Reference pool: USDC(currency0) / WETH(currency1), fee=3000, tickSpacing=60, hooks=0x0
export const REFERENCE_POOL_KEY = {
  currency0: ADDRESSES.usdc,
  currency1: ADDRESSES.weth,
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000" as Address,
} as const;

// Protected pool: WETH(currency0) / NEWTOKEN(currency1), fee=DYNAMIC, tickSpacing=60, hooks=hook
export const PROTECTED_POOL_KEY = {
  currency0: ADDRESSES.weth,
  currency1: ADDRESSES.newtoken,
  fee: 8388608, // LPFeeLibrary.DYNAMIC_FEE_FLAG
  tickSpacing: 60,
  hooks: ADDRESSES.hook,
} as const;

// === Pool IDs (keccak256 of abi.encode(poolKey)) ===
export const REFERENCE_POOL_ID =
  "0xa809bca02a254188e0547595bf5dae238b8a5e807e3e699c3204f13742ed0e3e" as `0x${string}`;
export const PROTECTED_POOL_ID =
  "0x9678bc6421e11d6f5d2d5fea508093b498f605629c7085c7d8f435339049619b" as `0x${string}`;

// === ABIs ===
export const hookAbi = [
  {
    type: "function",
    name: "poolConfigs",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "referencePoolId", type: "bytes32" },
      { name: "referenceZeroForOne", type: "bool" },
      { name: "baseFee", type: "uint24" },
      { name: "highImpactFee", type: "uint24" },
      { name: "highImpactThresholdBps", type: "uint256" },
      { name: "circuitBreakerBps", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lastReferenceSqrtPrice",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint160" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "DynamicFeeApplied",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "impactBps", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "CircuitBreakerHit",
    inputs: [
      { name: "poolId", type: "bytes32", indexed: true },
      { name: "impactBps", type: "uint256", indexed: false },
      { name: "refSqrtPrice", type: "uint160", indexed: false },
    ],
  },
] as const;

export const poolManagerAbi = [
  {
    type: "function",
    name: "extsload",
    inputs: [{ name: "slot", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const;

export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const swapRouterAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "zeroForOne", type: "bool" },
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "hookData", type: "bytes" },
      { name: "receiver", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "", type: "int256" }],
    stateMutability: "payable",
  },
] as const;
