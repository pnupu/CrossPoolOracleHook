"use client";

import { useMemo, useState } from "react";
import { useAccount, useEnsAddress, useEnsName } from "wagmi";
import { mainnet } from "wagmi/chains";
import { isAddress } from "viem";
import { normalize } from "viem/ens";
import { shortenAddress } from "@/lib/utils";

function normalizeEnsName(value: string) {
  try {
    return normalize(value);
  } catch {
    return null;
  }
}

export function EnsPanel() {
  const { address } = useAccount();
  const [input, setInput] = useState("");

  const trimmed = input.trim();
  const isInputAddress = trimmed.length > 0 && isAddress(trimmed);
  const normalizedName = useMemo(() => {
    if (trimmed.length === 0 || isInputAddress) return null;
    return normalizeEnsName(trimmed);
  }, [trimmed, isInputAddress]);

  const {
    data: resolvedAddress,
    isLoading: isResolvingName,
    isError: isNameError,
  } = useEnsAddress({
    chainId: mainnet.id,
    name: normalizedName ?? undefined,
    query: { enabled: !!normalizedName },
  });

  const {
    data: resolvedName,
    isLoading: isResolvingAddress,
    isError: isAddressError,
  } = useEnsName({
    chainId: mainnet.id,
    address: isInputAddress ? (trimmed as `0x${string}`) : undefined,
    query: { enabled: isInputAddress },
  });

  const {
    data: walletEnsName,
    isLoading: isResolvingWallet,
  } = useEnsName({
    chainId: mainnet.id,
    address: address,
    query: { enabled: !!address },
  });

  return (
    <div className="mb-8 rounded-xl border border-gray-700/50 bg-gray-900/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300">ENS Resolver</h2>
        <span className="text-xs text-gray-500">Mainnet lookup</span>
      </div>

      <label className="block text-xs text-gray-500 mb-2">
        Enter ENS name or address
      </label>
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        placeholder="vitalik.eth or 0xabc..."
        className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
      />

      <div className="mt-3 text-sm text-gray-300 space-y-1">
        {normalizedName && (
          <div>
            Name: <span className="font-mono">{normalizedName}</span>
          </div>
        )}

        {normalizedName && (
          <div>
            Address:{" "}
            {isResolvingName
              ? "Resolving..."
              : resolvedAddress
                ? shortenAddress(resolvedAddress)
                : isNameError
                  ? "Lookup failed"
                  : "Not found"}
          </div>
        )}

        {isInputAddress && (
          <div>
            ENS name:{" "}
            {isResolvingAddress
              ? "Resolving..."
              : resolvedName
                ? resolvedName
                : isAddressError
                  ? "Lookup failed"
                  : "Not set"}
          </div>
        )}
      </div>

      <div className="mt-4 text-xs text-gray-500">
        Connected wallet:{" "}
        {address ? (
          isResolvingWallet ? (
            "Resolving..."
          ) : walletEnsName ? (
            walletEnsName
          ) : (
            shortenAddress(address)
          )
        ) : (
          "Not connected"
        )}
      </div>
    </div>
  );
}
