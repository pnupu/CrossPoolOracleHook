"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { mainnet } from "wagmi/chains";
import { parseAbiItem } from "viem";
import { ADDRESSES, PROTECTED_POOL_ID } from "@/lib/contracts";
import { bpsToPercent, feeToPercent } from "@/lib/utils";

interface LogEntry {
  id: string;
  type: "fee" | "breaker";
  fee?: number;
  impactBps: bigint;
  refMoveBps?: bigint;
  txHash: string;
  blockNumber: bigint;
  sender?: `0x${string}`;
}

const feeEvent = parseAbiItem(
  "event DynamicFeeApplied(bytes32 indexed poolId, uint24 fee, uint256 impactBps)"
);
const breakerEvent = parseAbiItem(
  "event CircuitBreakerHit(bytes32 indexed poolId, uint256 impactBps, uint256 refPriceChangeBps)"
);

export function EventLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [ensByAddress, setEnsByAddress] = useState<Record<string, string>>({});
  const client = usePublicClient();
  const ensClient = usePublicClient({ chainId: mainnet.id });

  useEffect(() => {
    if (!client) return;

    let cancelled = false;

    async function fetchLogs() {
      if (!client || cancelled) return;

      try {
        const currentBlock = await client.getBlockNumber();
        // Look back ~1000 blocks
        const fromBlock = currentBlock > 1000n ? currentBlock - 1000n : 0n;

        const [feeLogs, breakerLogs] = await Promise.all([
          client.getLogs({
            address: ADDRESSES.hook,
            event: feeEvent,
            args: { poolId: PROTECTED_POOL_ID },
            fromBlock,
            toBlock: currentBlock,
          }),
          client.getLogs({
            address: ADDRESSES.hook,
            event: breakerEvent,
            args: { poolId: PROTECTED_POOL_ID },
            fromBlock,
            toBlock: currentBlock,
          }),
        ]);

        if (cancelled) return;

        const entries: LogEntry[] = [
          ...feeLogs.map((log) => ({
            id: `${log.transactionHash}-${log.logIndex}`,
            type: "fee" as const,
            fee: Number(log.args.fee ?? 0),
            impactBps: log.args.impactBps ?? 0n,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          })),
          ...breakerLogs.map((log) => ({
            id: `${log.transactionHash}-${log.logIndex}`,
            type: "breaker" as const,
            impactBps: log.args.impactBps ?? 0n,
            refMoveBps: log.args.refPriceChangeBps ?? 0n,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
          })),
        ];

        entries.sort((a, b) => Number(b.blockNumber - a.blockNumber));
        const sliced = entries.slice(0, 50);

        // Fetch senders for unique transactions
        const uniqueTx = Array.from(new Set(sliced.map((entry) => entry.txHash)));
        const txs = await Promise.all(
          uniqueTx.map((hash) =>
            client
              .getTransaction({ hash })
              .then((tx) => ({ hash, from: tx.from }))
              .catch(() => ({ hash, from: undefined }))
          )
        );

        const senderByTx: Record<string, `0x${string}`> = {};
        const senders = new Set<string>();
        for (const tx of txs) {
          if (tx.from) {
            senderByTx[tx.hash] = tx.from;
            senders.add(tx.from.toLowerCase());
          }
        }

        const withSenders = sliced.map((entry) => ({
          ...entry,
          sender: senderByTx[entry.txHash],
        }));

        // Resolve ENS names on mainnet
        if (ensClient) {
          const missing = Array.from(senders).filter(
            (addr) => !ensByAddress[addr]
          );
          if (missing.length > 0) {
            const resolved = await Promise.all(
              missing.map((addr) =>
                ensClient
                  .getEnsName({ address: addr as `0x${string}` })
                  .then((name) => ({ addr, name }))
                  .catch(() => ({ addr, name: null }))
              )
            );
            if (!cancelled) {
              setEnsByAddress((prev) => {
                const next = { ...prev };
                for (const item of resolved) {
                  if (item.name) next[item.addr] = item.name;
                }
                return next;
              });
            }
          }
        }

        setLogs(withSenders);
      } catch {
        // RPC may not support large ranges; silently ignore
      }
    }

    fetchLogs();
    const interval = setInterval(fetchLogs, 15000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, ensClient, ensByAddress]);

  return (
    <div className="rounded-xl border border-gray-700 p-6">
      <h2 className="text-lg font-semibold mb-4">Hook Events</h2>
      {logs.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No recent events. Swap on the protected pool to generate events.
        </p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {logs.map((log) => (
            <div
              key={log.id}
              className={`text-sm px-3 py-2 rounded ${
                log.type === "breaker"
                  ? "bg-red-900/30 border border-red-700/50"
                  : "bg-gray-800/50 border border-gray-700/50"
              }`}
            >
              {log.type === "fee" ? (
                <span>
                  Fee:{" "}
                  <span className="font-mono text-yellow-400">
                    {feeToPercent(log.fee!)}
                  </span>{" "}
                  | Impact:{" "}
                  <span className="font-mono">
                    {bpsToPercent(log.impactBps)}
                  </span>
                </span>
              ) : (
                <span className="text-red-400">
                  CIRCUIT BREAKER | Impact:{" "}
                  <span className="font-mono">
                    {bpsToPercent(log.impactBps)}
                  </span>
                  {" "} | Ref move:{" "}
                  <span className="font-mono">
                    {bpsToPercent(log.refMoveBps ?? 0n)}
                  </span>
                </span>
              )}
              {log.sender && (
                <span className="ml-2 text-xs text-gray-500">
                  Sender:{" "}
                  <span className="font-mono">
                    {ensByAddress[log.sender.toLowerCase()] ??
                      `${log.sender.slice(0, 6)}…${log.sender.slice(-4)}`}
                  </span>
                </span>
              )}
              <a
                href={`https://sepolia.etherscan.io/tx/${log.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 ml-2 text-xs hover:text-gray-300"
              >
                block {log.blockNumber.toString()}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
