import { PoolCard } from "@/components/PoolCard";
import { SwapPanel } from "@/components/SwapPanel";
import { EventLog } from "@/components/EventLog";
import { ConnectButton } from "@/components/ConnectButton";
import { REFERENCE_POOL_ID, PROTECTED_POOL_ID } from "@/lib/contracts";

export default function Home() {
  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">CrossPoolOracleHook</h1>
          <p className="text-gray-400 text-sm">
            Cross-pool price oracle for manipulation protection
          </p>
        </div>
        <ConnectButton />
      </div>

      {/* How it works */}
      <div className="mb-8 rounded-xl border border-gray-700/50 bg-gray-900/50 p-5">
        <h2 className="text-sm font-semibold text-gray-300 mb-2">
          How it works
        </h2>
        <p className="text-sm text-gray-400 leading-relaxed">
          The hook reads the Reference Pool&apos;s price on every swap in the
          Protected Pool. If the swap&apos;s price impact can&apos;t be explained
          by market-wide movement in the reference pool, the fee increases or the
          swap is blocked entirely. No external oracle needed.
        </p>
      </div>

      {/* Pool cards */}
      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <PoolCard
          title="Reference Pool"
          poolId={REFERENCE_POOL_ID}
          token0Symbol="USDC"
          token1Symbol="WETH"
          isProtected={false}
        />
        <PoolCard
          title="Protected Pool"
          poolId={PROTECTED_POOL_ID}
          token0Symbol="NEW"
          token1Symbol="WETH"
          isProtected={true}
        />
      </div>

      {/* Swap + Events */}
      <div className="grid md:grid-cols-2 gap-4">
        <SwapPanel />
        <EventLog />
      </div>

      {/* Footer */}
      <div className="mt-8 text-center text-xs text-gray-600">
        Sepolia testnet | HackMoney 2026
      </div>
    </main>
  );
}
