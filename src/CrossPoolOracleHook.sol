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
/// @notice A Uniswap v4 hook that reads reference pools' prices to implement
/// dynamic fees and circuit breakers on a protected pool — no external oracle needed.
///
/// Reference pools (e.g. ETH/USDC, ETH/DAI with deep liquidity) act as free,
/// trustless, same-block price feeds. The hook uses the maximum price movement
/// across all references to detect manipulation on thinner pools.
contract CrossPoolOracleHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ============ Errors ============
    error CircuitBreakerTriggered(uint256 impactBps);
    error PoolNotRegistered();
    error OnlyOwner();
    error TooManyReferences();
    error EmptyReferences();

    // ============ Events ============
    event PoolRegistered(PoolId indexed protectedPoolId, uint256 referenceCount);
    event CircuitBreakerHit(PoolId indexed poolId, uint256 impactBps, uint256 refPriceChangeBps);
    event DynamicFeeApplied(PoolId indexed poolId, uint24 fee, uint256 impactBps);

    // ============ Constants ============
    uint256 constant MAX_REFERENCES = 5;

    // ============ Structs ============
    struct PoolConfig {
        PoolId[] referencePoolIds;       // Deep liquidity pools to read price from
        bool[] referenceZeroForOne;      // Direction for each reference pool
        uint24 baseFee;                  // Normal fee (e.g. 3000 = 0.3%)
        uint24 highImpactFee;            // Fee when price impact is elevated (e.g. 10000 = 1%)
        uint256 highImpactThresholdBps;  // Price impact that triggers elevated fee (e.g. 200 = 2%)
        uint256 circuitBreakerBps;       // Price impact that blocks the swap entirely (e.g. 1000 = 10%)
    }

    // ============ State ============
    mapping(PoolId => PoolConfig) internal _poolConfigs;
    // Track last reference price per protected pool per reference index
    mapping(PoolId => mapping(uint256 => uint160)) public lastReferenceSqrtPrices;
    // Keep single-reference getter for backwards compatibility
    mapping(PoolId => uint160) public lastReferenceSqrtPrice;
    address public owner;

    constructor(IPoolManager _poolManager, address _owner) BaseHook(_poolManager) {
        owner = _owner;
    }

    // ============ Hook Permissions ============
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ============ View ============

    /// @notice Get the full config for a protected pool
    function getPoolConfig(PoolId poolId) external view returns (
        PoolId[] memory referencePoolIds,
        bool[] memory referenceZeroForOne,
        uint24 baseFee,
        uint24 highImpactFee,
        uint256 highImpactThresholdBps,
        uint256 circuitBreakerBps
    ) {
        PoolConfig storage config = _poolConfigs[poolId];
        return (
            config.referencePoolIds,
            config.referenceZeroForOne,
            config.baseFee,
            config.highImpactFee,
            config.highImpactThresholdBps,
            config.circuitBreakerBps
        );
    }

    /// @notice Legacy single-reference view for backwards compatibility
    function poolConfigs(PoolId poolId) external view returns (
        PoolId referencePoolId,
        bool referenceZeroForOne,
        uint24 baseFee,
        uint24 highImpactFee,
        uint256 highImpactThresholdBps,
        uint256 circuitBreakerBps
    ) {
        PoolConfig storage config = _poolConfigs[poolId];
        return (
            config.referencePoolIds.length > 0 ? config.referencePoolIds[0] : PoolId.wrap(bytes32(0)),
            config.referenceZeroForOne.length > 0 ? config.referenceZeroForOne[0] : false,
            config.baseFee,
            config.highImpactFee,
            config.highImpactThresholdBps,
            config.circuitBreakerBps
        );
    }

    // ============ Admin ============

    /// @notice Register a protected pool with a single reference pool (backwards compatible)
    function registerPool(
        PoolKey calldata protectedPoolKey,
        PoolId referencePoolId,
        bool referenceZeroForOne,
        uint24 baseFee,
        uint24 highImpactFee,
        uint256 highImpactThresholdBps,
        uint256 circuitBreakerBps
    ) external {
        PoolId[] memory refs = new PoolId[](1);
        refs[0] = referencePoolId;
        bool[] memory dirs = new bool[](1);
        dirs[0] = referenceZeroForOne;

        _registerPool(protectedPoolKey, refs, dirs, baseFee, highImpactFee, highImpactThresholdBps, circuitBreakerBps);
    }

    /// @notice Register a protected pool with multiple reference pools
    function registerPoolMultiRef(
        PoolKey calldata protectedPoolKey,
        PoolId[] calldata referencePoolIds,
        bool[] calldata referenceZeroForOne,
        uint24 baseFee,
        uint24 highImpactFee,
        uint256 highImpactThresholdBps,
        uint256 circuitBreakerBps
    ) external {
        _registerPool(protectedPoolKey, referencePoolIds, referenceZeroForOne, baseFee, highImpactFee, highImpactThresholdBps, circuitBreakerBps);
    }

    function _registerPool(
        PoolKey calldata protectedPoolKey,
        PoolId[] memory referencePoolIds,
        bool[] memory referenceZeroForOne,
        uint24 baseFee,
        uint24 highImpactFee,
        uint256 highImpactThresholdBps,
        uint256 circuitBreakerBps
    ) internal {
        if (msg.sender != owner) revert OnlyOwner();
        if (referencePoolIds.length == 0) revert EmptyReferences();
        if (referencePoolIds.length > MAX_REFERENCES) revert TooManyReferences();
        require(referencePoolIds.length == referenceZeroForOne.length, "Array length mismatch");

        PoolId protectedPoolId = protectedPoolKey.toId();
        PoolConfig storage config = _poolConfigs[protectedPoolId];
        config.referencePoolIds = referencePoolIds;
        config.referenceZeroForOne = referenceZeroForOne;
        config.baseFee = baseFee;
        config.highImpactFee = highImpactFee;
        config.highImpactThresholdBps = highImpactThresholdBps;
        config.circuitBreakerBps = circuitBreakerBps;

        emit PoolRegistered(protectedPoolId, referencePoolIds.length);
    }

    // ============ Hook Callbacks ============

    function _afterInitialize(address, PoolKey calldata key, uint160, int24)
        internal
        override
        returns (bytes4)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = _poolConfigs[poolId];

        // Store initial reference prices
        for (uint256 i = 0; i < config.referencePoolIds.length; i++) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolIds[i]);
            lastReferenceSqrtPrices[poolId][i] = refSqrtPrice;
        }
        // Also set legacy single-reference field
        if (config.referencePoolIds.length > 0) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolIds[0]);
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
        PoolConfig storage config = _poolConfigs[poolId];

        if (config.referencePoolIds.length == 0) {
            revert PoolNotRegistered();
        }

        // Find the maximum reference price change across all reference pools
        // This is the most generous interpretation: if ANY reference moved,
        // we credit that movement as "explained"
        uint256 maxRefPriceChangeBps = 0;
        for (uint256 i = 0; i < config.referencePoolIds.length; i++) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolIds[i]);
            uint256 changeBps = _calculatePriceChangeBps(
                lastReferenceSqrtPrices[poolId][i], refSqrtPrice
            );
            if (changeBps > maxRefPriceChangeBps) {
                maxRefPriceChangeBps = changeBps;
            }
        }

        // Read current protected pool price
        (uint160 protectedSqrtPrice,,,) = poolManager.getSlot0(poolId);

        // Calculate the expected price impact of this swap
        uint256 swapImpactBps = _estimateSwapImpactBps(params, protectedSqrtPrice, key);

        // Unexplained impact = swap impact minus the maximum reference movement
        uint256 unexplainedImpactBps;
        if (swapImpactBps > maxRefPriceChangeBps) {
            unexplainedImpactBps = swapImpactBps - maxRefPriceChangeBps;
        }

        // Circuit breaker
        if (unexplainedImpactBps >= config.circuitBreakerBps) {
            emit CircuitBreakerHit(poolId, unexplainedImpactBps, maxRefPriceChangeBps);
            revert CircuitBreakerTriggered(unexplainedImpactBps);
        }

        // Dynamic fee
        uint24 fee;
        if (unexplainedImpactBps >= config.highImpactThresholdBps) {
            fee = config.highImpactFee;
        } else {
            fee = config.baseFee;
        }

        emit DynamicFeeApplied(poolId, fee, unexplainedImpactBps);

        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId poolId = key.toId();
        PoolConfig storage config = _poolConfigs[poolId];

        // Update all reference prices
        for (uint256 i = 0; i < config.referencePoolIds.length; i++) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolIds[i]);
            lastReferenceSqrtPrices[poolId][i] = refSqrtPrice;
        }
        // Update legacy field
        if (config.referencePoolIds.length > 0) {
            (uint160 refSqrtPrice,,,) = poolManager.getSlot0(config.referencePoolIds[0]);
            lastReferenceSqrtPrice[poolId] = refSqrtPrice;
        }

        return (BaseHook.afterSwap.selector, 0);
    }

    // ============ Internal Price Math ============

    /// @notice Calculate basis points change between two sqrtPriceX96 values
    function _calculatePriceChangeBps(uint160 oldSqrtPrice, uint160 newSqrtPrice)
        internal
        pure
        returns (uint256)
    {
        if (oldSqrtPrice == 0) return 0;

        uint256 oldSq = uint256(oldSqrtPrice);
        uint256 newSq = uint256(newSqrtPrice);

        uint256 diff;
        if (newSq > oldSq) {
            diff = newSq - oldSq;
        } else {
            diff = oldSq - newSq;
        }

        return (2 * diff * 10000) / oldSq;
    }

    /// @notice Estimate the price impact of a swap in basis points
    /// @dev Uses sqrtPrice-based math for accurate estimation.
    function _estimateSwapImpactBps(
        SwapParams calldata params,
        uint160 currentSqrtPrice,
        PoolKey calldata key
    ) internal view returns (uint256) {
        uint128 liquidity = poolManager.getLiquidity(key.toId());

        if (liquidity == 0 || currentSqrtPrice == 0) return 10000;

        uint256 absAmount;
        if (params.amountSpecified < 0) {
            absAmount = uint256(-params.amountSpecified);
        } else {
            absAmount = uint256(params.amountSpecified);
        }

        uint256 L = uint256(liquidity);
        uint256 sqrtP = uint256(currentSqrtPrice);
        uint256 newSqrtP;

        if (params.zeroForOne) {
            if (absAmount >= L) return 10000;
            newSqrtP = (sqrtP * L) / (L + absAmount);
        } else {
            uint256 delta = (absAmount << 96) / L;
            newSqrtP = sqrtP + delta;
        }

        uint256 diff;
        if (newSqrtP > sqrtP) {
            diff = newSqrtP - sqrtP;
        } else {
            diff = sqrtP - newSqrtP;
        }

        uint256 impactBps = (2 * diff * 10000) / sqrtP;
        if (impactBps > 10000) return 10000;
        return impactBps;
    }
}
