"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  usePublicClient,
} from "wagmi";
import { sepolia } from "wagmi/chains";
import { parseEther } from "viem";
import {
  ADDRESSES,
  PROTECTED_POOL_KEY,
  PROTECTED_POOL_ID,
  erc20Abi,
  permit2Abi,
  swapRouterAbi,
  poolManagerAbi,
  hookAbi,
} from "@/lib/contracts";
import {
  getSlot0StorageSlot,
  getLiquidityStorageSlot,
  parseSlot0,
  estimateSwapImpactBps,
  predictFeeTier,
  bpsToPercent,
  feeToPercent,
} from "@/lib/utils";

export function SwapPanel() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("0.01");
  const [direction, setDirection] = useState<"buy" | "sell">("sell");
  const [simStatus, setSimStatus] = useState<
    "idle" | "ok" | "circuit-breaker"
  >("idle");

  const client = usePublicClient();
  const approveErc20 = useWriteContract();
  const approvePermit2 = useWriteContract();
  const swap = useWriteContract();

  const { isLoading: isSwapConfirming, isSuccess: isSwapSuccess } =
    useWaitForTransactionReceipt({ hash: swap.data });
  const { isLoading: isApproveConfirming } = useWaitForTransactionReceipt({
    hash: approveErc20.data,
  });
  const { isLoading: isPermitConfirming } = useWaitForTransactionReceipt({
    hash: approvePermit2.data,
  });

  const zeroForOne = direction === "sell";
  // Protected pool: currency0=NEWTOKEN, currency1=WETH
  const inputToken = zeroForOne ? "NEW" : "WETH";
  const outputToken = zeroForOne ? "WETH" : "NEW";
  const tokenAddress = zeroForOne ? ADDRESSES.newtoken : ADDRESSES.weth;

  // Read balances
  const { data: wethBalance } = useReadContract({
    address: ADDRESSES.weth,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  const { data: newtokenBalance } = useReadContract({
    address: ADDRESSES.newtoken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address!],
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  // Read on-chain allowance
  const { data: erc20Allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, ADDRESSES.permit2],
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  // Read pool state: sqrtPrice and liquidity
  const slot0Slot = getSlot0StorageSlot(PROTECTED_POOL_ID);
  const liqSlot = getLiquidityStorageSlot(PROTECTED_POOL_ID);

  const { data: slot0Data } = useReadContract({
    address: ADDRESSES.poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [slot0Slot],
    chainId: sepolia.id,
    query: { refetchInterval: 10000 },
  });

  const { data: liqData } = useReadContract({
    address: ADDRESSES.poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [liqSlot],
    chainId: sepolia.id,
    query: { refetchInterval: 10000 },
  });

  // Read hook config
  const { data: configData } = useReadContract({
    address: ADDRESSES.hook,
    abi: hookAbi,
    functionName: "poolConfigs",
    args: [PROTECTED_POOL_ID],
    chainId: sepolia.id,
  });

  // Read cached reference price
  const { data: lastRefPrice } = useReadContract({
    address: ADDRESSES.hook,
    abi: hookAbi,
    functionName: "lastReferenceSqrtPrice",
    args: [PROTECTED_POOL_ID],
    chainId: sepolia.id,
    query: { refetchInterval: 10000 },
  });

  const amountIn = useMemo(() => {
    try {
      return parseEther(amount || "0");
    } catch {
      return 0n;
    }
  }, [amount]);

  const needsApproval =
    erc20Allowance !== undefined && (erc20Allowance as bigint) < amountIn;

  // Compute estimated impact from on-chain data
  const poolState = useMemo(() => {
    if (!slot0Data || !liqData || !configData) return null;
    const { sqrtPriceX96 } = parseSlot0(slot0Data);
    const liquidity = BigInt(liqData) & ((1n << 128n) - 1n); // lower 128 bits
    const highImpactThresholdBps = Number(configData[4]);
    const circuitBreakerBps = Number(configData[5]);
    const baseFee = Number(configData[2]);
    const highImpactFee = Number(configData[3]);
    return {
      sqrtPriceX96,
      liquidity,
      highImpactThresholdBps,
      circuitBreakerBps,
      baseFee,
      highImpactFee,
    };
  }, [slot0Data, liqData, configData]);

  const impactEstimate = useMemo(() => {
    if (!poolState || amountIn === 0n) return null;
    const impactBps = estimateSwapImpactBps(
      amountIn,
      poolState.liquidity,
      poolState.sqrtPriceX96,
      zeroForOne
    );
    const tier = predictFeeTier(
      impactBps,
      poolState.highImpactThresholdBps,
      poolState.circuitBreakerBps
    );
    return { impactBps, tier };
  }, [poolState, amountIn, zeroForOne]);

  // Simulate swap for circuit breaker detection
  const simulateSwap = useCallback(async () => {
    if (!client || !address || amountIn === 0n) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    try {
      await client.simulateContract({
        address: ADDRESSES.swapRouter,
        abi: swapRouterAbi,
        functionName: "swapExactTokensForTokens",
        args: [
          amountIn, 0n, zeroForOne,
          {
            currency0: PROTECTED_POOL_KEY.currency0,
            currency1: PROTECTED_POOL_KEY.currency1,
            fee: PROTECTED_POOL_KEY.fee,
            tickSpacing: PROTECTED_POOL_KEY.tickSpacing,
            hooks: PROTECTED_POOL_KEY.hooks,
          },
          "0x" as `0x${string}`,
          address,
          deadline,
        ],
        account: address,
      });
      setSimStatus("ok");
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("CircuitBreakerTriggered")) {
        setSimStatus("circuit-breaker");
      } else {
        // Allowance or other errors — don't block
        setSimStatus("ok");
      }
    }
  }, [client, address, amountIn, zeroForOne]);

  useEffect(() => {
    setSimStatus("idle");
    if (amountIn > 0n) {
      simulateSwap();
    }
  }, [amountIn, zeroForOne, simulateSwap]);

  const isBlocked =
    simStatus === "circuit-breaker" || impactEstimate?.tier === "blocked";

  // Approve handlers
  const isApproving =
    approveErc20.isPending || isApproveConfirming ||
    approvePermit2.isPending || isPermitConfirming;

  function handleApprove() {
    approveErc20.writeContract(
      {
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDRESSES.permit2, parseEther("1000000")],
      },
      {
        onSuccess: () => {
          approvePermit2.writeContract(
            {
              address: ADDRESSES.permit2,
              abi: permit2Abi,
              functionName: "approve",
              args: [
                tokenAddress,
                ADDRESSES.swapRouter,
                BigInt("1461501637330902918203684832716283019655932542975"),
                281474976710655,
              ],
            },
            { onSuccess: () => refetchAllowance() }
          );
        },
      }
    );
  }

  function handleSwap() {
    if (!address || isBlocked) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    swap.writeContract({
      address: ADDRESSES.swapRouter,
      abi: swapRouterAbi,
      functionName: "swapExactTokensForTokens",
      args: [
        amountIn, 0n, zeroForOne,
        {
          currency0: PROTECTED_POOL_KEY.currency0,
          currency1: PROTECTED_POOL_KEY.currency1,
          fee: PROTECTED_POOL_KEY.fee,
          tickSpacing: PROTECTED_POOL_KEY.tickSpacing,
          hooks: PROTECTED_POOL_KEY.hooks,
        },
        "0x" as `0x${string}`,
        address,
        deadline,
      ],
      gas: 500000n,
    });
  }

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-gray-700 p-6">
        <h2 className="text-lg font-semibold mb-2">Swap</h2>
        <p className="text-gray-400 text-sm">
          Connect wallet to swap on the protected pool
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-700 p-6">
      <h2 className="text-lg font-semibold mb-4">Swap on Protected Pool</h2>

      <div className="space-y-4">
        {/* Direction */}
        <div className="flex gap-2">
          <button
            onClick={() => setDirection("sell")}
            className={`px-3 py-1.5 rounded text-sm ${
              direction === "sell"
                ? "bg-red-600 text-white"
                : "bg-gray-800 text-gray-400"
            }`}
          >
            Sell NEW for WETH
          </button>
          <button
            onClick={() => setDirection("buy")}
            className={`px-3 py-1.5 rounded text-sm ${
              direction === "buy"
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-400"
            }`}
          >
            Sell WETH for NEW
          </button>
        </div>

        {/* Amount */}
        <div>
          <label className="text-sm text-gray-400 block mb-1">
            Amount ({inputToken})
          </label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 font-mono text-sm"
            placeholder="0.01"
          />
        </div>

        {/* Balances */}
        <div className="text-xs text-gray-500 space-y-1">
          <p>
            WETH: {wethBalance !== undefined ? (Number(wethBalance) / 1e18).toFixed(4) : "..."}
          </p>
          <p>
            NEW: {newtokenBalance !== undefined ? (Number(newtokenBalance) / 1e18).toFixed(4) : "..."}
          </p>
        </div>

        {/* Impact estimate from on-chain data */}
        {impactEstimate && poolState && (
          <div
            className={`text-sm rounded p-3 border ${
              impactEstimate.tier === "blocked"
                ? "bg-red-900/40 border-red-600/50 text-red-300"
                : impactEstimate.tier === "elevated"
                ? "bg-yellow-900/40 border-yellow-600/50 text-yellow-300"
                : "bg-gray-800/50 border-gray-700/50 text-gray-300"
            }`}
          >
            <div className="flex justify-between items-center">
              <span>Estimated price impact</span>
              <span className="font-mono font-semibold">
                {bpsToPercent(impactEstimate.impactBps)}
              </span>
            </div>
            <div className="flex justify-between items-center mt-1">
              <span>Expected fee</span>
              <span className="font-mono">
                {impactEstimate.tier === "blocked"
                  ? "BLOCKED (circuit breaker)"
                  : impactEstimate.tier === "elevated"
                  ? `${feeToPercent(poolState.highImpactFee)} (elevated)`
                  : `${feeToPercent(poolState.baseFee)} (base)`}
              </span>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Pool liquidity: {(Number(poolState.liquidity) / 1e18).toFixed(2)} |
              Thresholds: {bpsToPercent(poolState.highImpactThresholdBps)} / {bpsToPercent(poolState.circuitBreakerBps)}
            </div>
          </div>
        )}

        {/* Circuit breaker from simulation */}
        {simStatus === "circuit-breaker" && (
          <div className="bg-red-900/40 border border-red-600/50 rounded p-3 text-sm text-red-300">
            Circuit breaker confirmed by on-chain simulation.
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2">
          {needsApproval && (
            <button
              onClick={handleApprove}
              disabled={isApproving}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
            >
              {isApproving ? "Approving..." : "Approve"}
            </button>
          )}
          <button
            onClick={handleSwap}
            disabled={swap.isPending || isBlocked}
            className={`flex-1 px-3 py-2 rounded text-sm font-semibold disabled:opacity-50 ${
              isBlocked
                ? "bg-red-800 cursor-not-allowed"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {swap.isPending
              ? "Confirming..."
              : isBlocked
              ? "BLOCKED"
              : `Swap ${inputToken} -> ${outputToken}`}
          </button>
        </div>

        {/* Status */}
        {isSwapConfirming && (
          <p className="text-sm text-yellow-400">Waiting for confirmation...</p>
        )}
        {isSwapSuccess && (
          <p className="text-sm text-green-400">Swap confirmed!</p>
        )}
        {swap.error && (
          <p className="text-sm text-red-400 break-all">
            {swap.error.message.includes("CircuitBreakerTriggered")
              ? "Circuit breaker triggered!"
              : swap.error.message.slice(0, 200)}
          </p>
        )}
      </div>
    </div>
  );
}
