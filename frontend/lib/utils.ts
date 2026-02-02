import { keccak256, encodePacked, type Hex } from "viem";

const Q96 = BigInt(2) ** BigInt(96);

/** Convert sqrtPriceX96 to a human-readable price (token1/token0) */
export function sqrtPriceToPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 === 0n) return 0;
  // price = (sqrtPrice / 2^96)^2
  const priceNum = Number(sqrtPriceX96 * sqrtPriceX96) / Number(Q96 * Q96);
  return priceNum;
}

/** Format price to readable string */
export function formatPrice(price: number): string {
  if (price === 0) return "0";
  if (price >= 1000) return price.toFixed(0);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

/** Format bps as percentage string */
export function bpsToPercent(bps: bigint | number): string {
  return (Number(bps) / 100).toFixed(2) + "%";
}

/** Format fee (Uniswap fee units, where 1000000 = 100%) */
export function feeToPercent(fee: number): string {
  return (fee / 10000).toFixed(2) + "%";
}

/** Format token amount from wei */
export function formatAmount(wei: bigint, decimals = 18): string {
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = wei / divisor;
  const frac = wei % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6);
  return `${whole}.${fracStr}`;
}

/** Compute the storage slot for a pool's Slot0 in PoolManager */
export function getSlot0StorageSlot(poolId: Hex): Hex {
  // Slot0 is at: keccak256(abi.encodePacked(poolId, POOLS_SLOT))
  // POOLS_SLOT = bytes32(uint256(6))
  const POOLS_SLOT =
    "0x0000000000000000000000000000000000000000000000000000000000000006";
  return keccak256(encodePacked(["bytes32", "bytes32"], [poolId, POOLS_SLOT]));
}

/** Parse Slot0 packed data from a single storage word */
export function parseSlot0(data: Hex): {
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
} {
  const value = BigInt(data);
  const sqrtPriceX96 = value & ((1n << 160n) - 1n);
  const tickRaw = Number((value >> 160n) & ((1n << 24n) - 1n));
  // Sign-extend 24-bit tick
  const tick = tickRaw >= 1 << 23 ? tickRaw - (1 << 24) : tickRaw;
  const protocolFee = Number((value >> 184n) & ((1n << 24n) - 1n));
  const lpFee = Number((value >> 208n) & ((1n << 24n) - 1n));
  return { sqrtPriceX96, tick, protocolFee, lpFee };
}

/** Shorten address for display */
export function shortenAddress(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

/** Calculate price change in bps between two sqrtPrices */
export function priceChangeBps(
  oldSqrtPrice: bigint,
  newSqrtPrice: bigint
): number {
  if (oldSqrtPrice === 0n) return 0;
  const diff =
    newSqrtPrice > oldSqrtPrice
      ? newSqrtPrice - oldSqrtPrice
      : oldSqrtPrice - newSqrtPrice;
  return Number((2n * diff * 10000n) / oldSqrtPrice);
}
