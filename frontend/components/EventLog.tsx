"use client";

import { useWatchContractEvent } from "wagmi";
import { useState } from "react";
import { ADDRESSES, hookAbi, PROTECTED_POOL_ID } from "@/lib/contracts";
import { bpsToPercent, feeToPercent } from "@/lib/utils";

interface LogEntry {
  id: number;
  type: "fee" | "breaker";
  fee?: number;
  impactBps: bigint;
  timestamp: Date;
}

export function EventLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  let nextId = 0;

  useWatchContractEvent({
    address: ADDRESSES.hook,
    abi: hookAbi,
    eventName: "DynamicFeeApplied",
    onLogs(eventLogs) {
      const newEntries = eventLogs
        .filter((log) => log.args.poolId === PROTECTED_POOL_ID)
        .map((log) => ({
          id: nextId++,
          type: "fee" as const,
          fee: Number(log.args.fee ?? 0),
          impactBps: log.args.impactBps ?? 0n,
          timestamp: new Date(),
        }));
      if (newEntries.length > 0) {
        setLogs((prev) => [...newEntries, ...prev].slice(0, 50));
      }
    },
  });

  useWatchContractEvent({
    address: ADDRESSES.hook,
    abi: hookAbi,
    eventName: "CircuitBreakerHit",
    onLogs(eventLogs) {
      const newEntries = eventLogs
        .filter((log) => log.args.poolId === PROTECTED_POOL_ID)
        .map((log) => ({
          id: nextId++,
          type: "breaker" as const,
          impactBps: log.args.impactBps ?? 0n,
          timestamp: new Date(),
        }));
      if (newEntries.length > 0) {
        setLogs((prev) => [...newEntries, ...prev].slice(0, 50));
      }
    },
  });

  return (
    <div className="rounded-xl border border-gray-700 p-6">
      <h2 className="text-lg font-semibold mb-4">Hook Events</h2>
      {logs.length === 0 ? (
        <p className="text-gray-500 text-sm">
          Watching for DynamicFeeApplied and CircuitBreakerHit events...
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
                  Fee applied:{" "}
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
                </span>
              )}
              <span className="text-gray-500 ml-2 text-xs">
                {log.timestamp.toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
