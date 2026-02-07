"use client";

import { useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import {
  ADDRESSES,
  poolManagerAbi,
  hookAbi,
} from "@/lib/contracts";
import {
  parseSlot0,
  sqrtPriceToPrice,
  formatPrice,
  bpsToPercent,
  feeToPercent,
  getSlot0StorageSlot,
} from "@/lib/utils";
import type { Hex } from "viem";

interface PoolCardProps {
  title: string;
  poolId: Hex;
  token0Symbol: string;
  token1Symbol: string;
  isProtected: boolean;
}

export function PoolCard({
  title,
  poolId,
  token0Symbol,
  token1Symbol,
  isProtected,
}: PoolCardProps) {
  const slot = getSlot0StorageSlot(poolId);

  const { data: slot0Data, isError: slot0Error } = useReadContract({
    address: ADDRESSES.poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [slot],
    chainId: sepolia.id,
    query: { refetchInterval: 10000 },
  });

  const { data: configData } = useReadContract({
    address: ADDRESSES.hook,
    abi: hookAbi,
    functionName: "poolConfigs",
    args: [poolId],
    chainId: sepolia.id,
    query: { enabled: isProtected },
  });

  const { data: lastRefPrice } = useReadContract({
    address: ADDRESSES.hook,
    abi: hookAbi,
    functionName: "lastReferenceSqrtPrice",
    args: [poolId],
    chainId: sepolia.id,
    query: { enabled: isProtected, refetchInterval: 10000 },
  });

  const slot0 = slot0Data ? parseSlot0(slot0Data) : null;
  const price = slot0 ? sqrtPriceToPrice(slot0.sqrtPriceX96) : null;

  return (
    <div
      className={`rounded-xl border p-6 ${
        isProtected
          ? "border-orange-500/30 bg-orange-950/20"
          : "border-blue-500/30 bg-blue-950/20"
      }`}
    >
      <h2 className="text-lg font-semibold mb-1">{title}</h2>
      <p className="text-sm text-gray-400 mb-4">
        {token0Symbol} / {token1Symbol}
      </p>

      {slot0 ? (
        <div className="space-y-3">
          <div>
            <span className="text-sm text-gray-400">Price</span>
            <p className="text-2xl font-mono">
              {formatPrice(price!)} {token1Symbol}/{token0Symbol}
            </p>
          </div>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-gray-400">Tick</span>
              <p className="font-mono">{slot0.tick}</p>
            </div>
            <div>
              <span className="text-gray-400">LP Fee</span>
              <p className="font-mono">{feeToPercent(slot0.lpFee)}</p>
            </div>
          </div>
        </div>
      ) : slot0Error ? (
        <p className="text-red-400 text-sm">Failed to load pool data. Check RPC connection.</p>
      ) : (
        <p className="text-gray-500">Loading...</p>
      )}

      {isProtected && configData && (
        <div className="mt-4 pt-4 border-t border-gray-700/50">
          <h3 className="text-sm font-semibold text-orange-400 mb-2">
            Hook Protection
          </h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-400">Base Fee</span>
              <p className="font-mono">
                {feeToPercent(Number(configData[2]))}
              </p>
            </div>
            <div>
              <span className="text-gray-400">High Impact Fee</span>
              <p className="font-mono">
                {feeToPercent(Number(configData[3]))}
              </p>
            </div>
            <div>
              <span className="text-gray-400">Elevated Threshold</span>
              <p className="font-mono">{bpsToPercent(configData[4])}</p>
            </div>
            <div>
              <span className="text-gray-400">Circuit Breaker</span>
              <p className="font-mono">{bpsToPercent(configData[5])}</p>
            </div>
          </div>
          {lastRefPrice !== undefined && (
            <div className="mt-2">
              <span className="text-gray-400 text-sm">
                Cached Ref sqrtPrice
              </span>
              <p className="font-mono text-xs truncate">
                {lastRefPrice.toString()}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
