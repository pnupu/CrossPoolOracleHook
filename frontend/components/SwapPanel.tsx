"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  usePublicClient,
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
  const [simStatus, setSimStatus] = useState<
    "idle" | "ok" | "circuit-breaker" | "error"
  >("idle");
  const [simError, setSimError] = useState("");

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

  // Check ERC20 allowance to Permit2
  const { data: erc20Allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [address!, ADDRESSES.permit2],
    query: { enabled: !!address },
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

  // Approve: ERC20 -> Permit2, then Permit2 -> Router
  const isApproving =
    approveErc20.isPending ||
    isApproveConfirming ||
    approvePermit2.isPending ||
    isPermitConfirming;

  async function handleApprove() {
    // Step 1: ERC20 approve to Permit2
    approveErc20.writeContract(
      {
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDRESSES.permit2, parseEther("1000000")],
      },
      {
        onSuccess: () => {
          // Step 2: Permit2 approve to swap router
          approvePermit2.writeContract(
            {
              address: ADDRESSES.permit2,
              abi: permit2Abi,
              functionName: "approve",
              args: [
                tokenAddress,
                ADDRESSES.swapRouter,
                BigInt(
                  "1461501637330902918203684832716283019655932542975"
                ),
                281474976710655,
              ],
            },
            {
              onSuccess: () => {
                refetchAllowance();
              },
            }
          );
        },
      }
    );
  }

  // Simulate swap before sending
  const simulateSwap = useCallback(async () => {
    if (!client || !address || amountIn === 0n) return;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    try {
      await client.simulateContract({
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
        account: address,
      });
      setSimStatus("ok");
      setSimError("");
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("CircuitBreakerTriggered")) {
        setSimStatus("circuit-breaker");
        setSimError("");
      } else {
        // Ignore allowance-related errors — those are expected before approval
        setSimStatus("ok");
        setSimError("");
      }
    }
  }, [client, address, amountIn, zeroForOne]);

  // Run simulation when amount changes
  useEffect(() => {
    setSimStatus("idle");
    if (amountIn > 0n) {
      simulateSwap();
    }
  }, [amountIn, zeroForOne, simulateSwap]);

  function handleSwap() {
    if (!address || simStatus === "circuit-breaker") return;
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

        {/* Circuit breaker warning */}
        {simStatus === "circuit-breaker" && (
          <div className="bg-red-900/40 border border-red-600/50 rounded p-3 text-sm text-red-300">
            Circuit breaker triggered — this swap would be blocked by the hook.
            Reduce the amount or wait for reference pool movement.
          </div>
        )}

        {/* Action buttons */}
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
            disabled={
              swap.isPending || simStatus === "circuit-breaker"
            }
            className={`flex-1 px-3 py-2 rounded text-sm font-semibold disabled:opacity-50 ${
              simStatus === "circuit-breaker"
                ? "bg-red-800 cursor-not-allowed"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {swap.isPending
              ? "Confirming..."
              : simStatus === "circuit-breaker"
              ? "BLOCKED"
              : `Swap ${inputToken} -> ${outputToken}`}
          </button>
        </div>

        {/* Status */}
        {isSwapConfirming && (
          <p className="text-sm text-yellow-400">
            Waiting for confirmation...
          </p>
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
      </div>
    </div>
  );
}
