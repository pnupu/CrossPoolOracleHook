// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager, SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";

/// @title CrossPoolOracleHook
/// @notice A Uniswap v4 hook that reads a reference pool's price to implement
/// dynamic fees and circuit breakers on a protected pool — no external oracle needed.
///
/// The reference pool (e.g. ETH/USDC with deep liquidity) acts as a free, trustless,
/// same-block price feed. The hook uses this to detect manipulation on thinner pools
/// and adjust fees accordingly.
contract CrossPoolOracleHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ============ Errors ============
    error CircuitBreakerTriggered(uint256 impactBps);
    error PoolNotRegistered();
    error OnlyOwner();

    // ============ Events ============
    event PoolRegistered(PoolId indexed protectedPoolId, PoolId indexed referencePoolId, PoolConfig config);
    event CircuitBreakerHit(PoolId indexed poolId, uint256 impactBps, uint160 refSqrtPrice);
    event DynamicFeeApplied(PoolId indexed poolId, uint24 fee, uint256 impactBps);

    // ============ Structs ============
    struct PoolConfig {
        PoolId referencePoolId;      // The deep liquidity pool to read price from
        bool referenceZeroForOne;    // Which direction in reference pool gives us the base asset price
        uint24 baseFee;              // Normal fee (e.g. 3000 = 0.3%)
        uint24 highImpactFee;        // Fee when price impact is elevated (e.g. 10000 = 1%)
        uint256 highImpactThresholdBps; // Price impact that triggers elevated fee (e.g. 200 = 2%)
        uint256 circuitBreakerBps;   // Price impact that blocks the swap entirely (e.g. 1000 = 10%)
    }

    // ============ State ============
    mapping(PoolId => PoolConfig) public poolConfigs;
    mapping(PoolId => uint160) public lastReferenceSqrtPrice; // Track reference price changes
    address public owner;

    constructor(IPoolManager _poolManager, address _owner) BaseHook(_poolManager) {
        owner = _owner;
    }

    // ============ Hook Permissions ============
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,       // Store initial reference price
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,            // Dynamic fee + circuit breaker
            afterSwap: true,             // Update reference price tracking
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ============ Admin ============

    /// @notice Register a protected pool with its reference pool and thresholds
    /// @dev Must be called before the protected pool is initialized
    function registerPool(
        PoolKey calldata protectedPoolKey,
        PoolId referencePoolId,
        bool referenceZeroForOne,
        uint24 baseFee,
        uint24 highImpactFee,
        uint256 highImpactThresholdBps,
        uint256 circuitBreakerBps
    ) external {
        if (msg.sender != owner) revert OnlyOwner();

        PoolId protectedPoolId = protectedPoolKey.toId();
        poolConfigs[protectedPoolId] = PoolConfig({
            referencePoolId: referencePoolId,
            referenceZeroForOne: referenceZeroForOne,
            baseFee: baseFee,
            highImpactFee: highImpactFee,
            highImpactThresholdBps: highImpactThresholdBps,
            circuitBreakerBps: circuitBreakerBps
        });

        emit PoolRegistered(protectedPoolId, referencePoolId, poolConfigs[protectedPoolId]);
    }

    // ============ Hook Callbacks ============

    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
        returns (bytes4)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = poolConfigs[poolId];

        // Store the initial reference price
        if (PoolId.unwrap(config.referencePoolId) != bytes32(0)) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolId);
            lastReferenceSqrtPrice[poolId] = refSqrtPrice;
        }

        return BaseHook.afterInitialize.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = poolConfigs[poolId];

        if (PoolId.unwrap(config.referencePoolId) == bytes32(0)) {
            revert PoolNotRegistered();
        }

        // Read current reference pool price (cross-pool read — the key innovation)
        (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolId);

        // Read current protected pool price
        (uint160 protectedSqrtPrice,,,) = poolManager.getSlot0(poolId);

        // Calculate how much the reference price has moved since we last checked
        uint256 refPriceChangeBps = _calculatePriceChangeBps(
            lastReferenceSqrtPrice[poolId], refSqrtPrice
        );

        // Calculate the expected price impact of this swap on the protected pool
        uint256 swapImpactBps = _estimateSwapImpactBps(params, protectedSqrtPrice, key);

        // Determine the "unexplained" price impact:
        // If the reference asset moved 5% and the protected pool moves 7%,
        // only 2% is unexplained (potentially manipulation)
        uint256 unexplainedImpactBps;
        if (swapImpactBps > refPriceChangeBps) {
            unexplainedImpactBps = swapImpactBps - refPriceChangeBps;
        }

        // Circuit breaker: block swaps with extreme unexplained impact
        if (unexplainedImpactBps >= config.circuitBreakerBps) {
            emit CircuitBreakerHit(poolId, unexplainedImpactBps, refSqrtPrice);
            revert CircuitBreakerTriggered(unexplainedImpactBps);
        }

        // Dynamic fee: elevated fee for high unexplained impact
        uint24 fee;
        if (unexplainedImpactBps >= config.highImpactThresholdBps) {
            fee = config.highImpactFee;
        } else {
            fee = config.baseFee;
        }

        emit DynamicFeeApplied(poolId, fee, unexplainedImpactBps);

        // Return the fee override (requires DYNAMIC_FEE_FLAG on the pool)
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = poolConfigs[poolId];

        // Update reference price tracking for next swap comparison
        if (PoolId.unwrap(config.referencePoolId) != bytes32(0)) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolId);
            lastReferenceSqrtPrice[poolId] = refSqrtPrice;
        }

        return (BaseHook.afterSwap.selector, 0);
    }

    // ============ Internal Price Math ============

    /// @notice Calculate basis points change between two sqrtPriceX96 values
    /// @dev sqrtPrice is sqrt(price) * 2^96. Price = (sqrtPrice / 2^96)^2
    ///      We compare prices by comparing sqrtPrice^2 values to avoid overflow
    function _calculatePriceChangeBps(uint160 oldSqrtPrice, uint160 newSqrtPrice)
        internal
        pure
        returns (uint256)
    {
        if (oldSqrtPrice == 0) return 0;

        // Use sqrtPrice ratio to approximate price change
        // price_ratio = (newSqrt / oldSqrt)^2
        // We compute |1 - price_ratio| in bps
        // Simplified: |(newSqrt^2 - oldSqrt^2)| / oldSqrt^2 * 10000
        uint256 oldSq = uint256(oldSqrtPrice);
        uint256 newSq = uint256(newSqrtPrice);

        // Use the sqrt prices directly for a simpler approximation:
        // price change ≈ 2 * |sqrtPrice change| / sqrtPrice (for small changes)
        uint256 diff;
        if (newSq > oldSq) {
            diff = newSq - oldSq;
        } else {
            diff = oldSq - newSq;
        }

        // 2 * diff / oldSq * 10000 (in bps, factor of 2 because sqrt)
        return (2 * diff * 10000) / oldSq;
    }

    /// @notice Estimate the price impact of a swap in basis points
    /// @dev Uses a simplified model: impact ≈ amountIn / poolLiquidity
    ///      For a more accurate estimate, we'd need to walk the tick bitmap
    function _estimateSwapImpactBps(
        SwapParams calldata params,
        uint160,
        PoolKey calldata key
    ) internal view returns (uint256) {
        // Get pool liquidity at current tick
        uint128 liquidity = poolManager.getLiquidity(key.toId());

        if (liquidity == 0) return 10000; // Max impact for empty pool

        // amountSpecified is negative for exactInput, positive for exactOutput
        uint256 absAmount;
        if (params.amountSpecified < 0) {
            absAmount = uint256(-params.amountSpecified);
        } else {
            absAmount = uint256(params.amountSpecified);
        }

        // Simplified impact: amount / liquidity * 10000 bps
        // This is a rough estimate — real impact depends on tick concentration
        // For concentrated liquidity, this underestimates impact of large trades
        // and overestimates impact of small trades, which is acceptable
        // (we err on the side of caution for large trades)
        if (absAmount >= liquidity) return 10000;

        return (absAmount * 10000) / uint256(liquidity);
    }
}
