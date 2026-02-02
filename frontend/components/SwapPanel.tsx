"use client";

import { useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from "wagmi";
import { parseEther } from "viem";
import {
  ADDRESSES,
  PROTECTED_POOL_KEY,
  erc20Abi,
  permit2Abi,
  swapRouterAbi,
} from "@/lib/contracts";

export function SwapPanel() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("0.01");
  const [direction, setDirection] = useState<"buy" | "sell">("sell");

  const approve = useWriteContract();
  const permit2 = useWriteContract();
  const swap = useWriteContract();

  const { isLoading: isSwapConfirming, isSuccess: isSwapSuccess } =
    useWaitForTransactionReceipt({ hash: swap.data });

  // Check balances
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

  const zeroForOne = direction === "sell";
  // Protected pool: currency0=NEWTOKEN, currency1=WETH
  // zeroForOne=true means selling NEWTOKEN for WETH
  const inputToken = zeroForOne ? "NEW" : "WETH";
  const outputToken = zeroForOne ? "WETH" : "NEW";

  function handleApprove() {
    const token = zeroForOne ? ADDRESSES.newtoken : ADDRESSES.weth;
    approve.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [ADDRESSES.permit2, parseEther("1000000")],
    });
  }

  function handlePermit2Approve() {
    const token = zeroForOne ? ADDRESSES.newtoken : ADDRESSES.weth;
    permit2.writeContract({
      address: ADDRESSES.permit2,
      abi: permit2Abi,
      functionName: "approve",
      args: [
        token,
        ADDRESSES.swapRouter,
        BigInt("1461501637330902918203684832716283019655932542975"),
        281474976710655,
      ],
    });
  }

  function handleSwap() {
    if (!address) return;
    const amountIn = parseEther(amount);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    swap.writeContract({
      address: ADDRESSES.swapRouter,
      abi: swapRouterAbi,
      functionName: "swapExactTokensForTokens",
      args: [
        amountIn,
        0n,
        zeroForOne,
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

        {/* Amount input */}
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
            WETH balance:{" "}
            {wethBalance !== undefined
              ? (Number(wethBalance) / 1e18).toFixed(4)
              : "..."}
          </p>
          <p>
            NEW balance:{" "}
            {newtokenBalance !== undefined
              ? (Number(newtokenBalance) / 1e18).toFixed(4)
              : "..."}
          </p>
        </div>

        {/* Fee tier hint */}
        <div className="text-xs bg-gray-800/50 rounded p-2">
          <p className="text-gray-400">Expected fee tier based on amount:</p>
          <p className="font-mono text-yellow-400">
            {Number(amount) < 0.1
              ? "Base (0.30%)"
              : Number(amount) < 2
              ? "Elevated (1.00%)"
              : "Circuit breaker (BLOCKED)"}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            disabled={approve.isPending}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
          >
            {approve.isPending ? "..." : approve.isSuccess ? "1. Approved" : "1. Approve"}
          </button>
          <button
            onClick={handlePermit2Approve}
            disabled={permit2.isPending}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm disabled:opacity-50"
          >
            {permit2.isPending ? "..." : permit2.isSuccess ? "2. Done" : "2. Permit2"}
          </button>
          <button
            onClick={handleSwap}
            disabled={swap.isPending}
            className="flex-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-sm font-semibold disabled:opacity-50"
          >
            {swap.isPending
              ? "Confirming..."
              : `3. Swap ${inputToken} -> ${outputToken}`}
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
              ? "Circuit breaker triggered - swap too large!"
              : swap.error.message.slice(0, 200)}
          </p>
        )}
        {approve.error && (
          <p className="text-sm text-red-400 break-all">
            Approve failed: {approve.error.message.slice(0, 150)}
          </p>
        )}
        {permit2.error && (
          <p className="text-sm text-red-400 break-all">
            Permit2 failed: {permit2.error.message.slice(0, 150)}
          </p>
        )}
      </div>
    </div>
  );
}
