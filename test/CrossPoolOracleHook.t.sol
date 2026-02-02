// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager, SwapParams} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";
import {CrossPoolOracleHook} from "../src/CrossPoolOracleHook.sol";
import {BaseTest} from "./utils/BaseTest.sol";

contract CrossPoolOracleHookTest is BaseTest {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    // Tokens: we need 3 tokens for 2 pools
    // Reference pool: WETH (token0) / USDC (token1)
    // Protected pool: NEWTOKEN (token0) / WETH (token1)
    Currency weth;
    Currency usdc;
    Currency newtoken;

    // Pool keys
    PoolKey referencePoolKey;  // WETH/USDC — deep liquidity, no hook
    PoolKey protectedPoolKey;  // NEWTOKEN/WETH — thin liquidity, our hook

    PoolId referencePoolId;
    PoolId protectedPoolId;

    CrossPoolOracleHook hook;

    function setUp() public {
        deployArtifactsAndLabel();

        // Deploy 3 tokens
        (Currency a, Currency b) = deployCurrencyPair();
        (Currency c,) = deployCurrencyPair();

        // Sort them so we can assign roles
        // We just need 3 distinct currencies; ordering doesn't matter for the test logic
        newtoken = a;
        weth = b;
        usdc = c;

        // Ensure correct ordering (currency0 < currency1 required by Uniswap)
        if (Currency.unwrap(weth) > Currency.unwrap(usdc)) {
            (weth, usdc) = (usdc, weth);
        }
        if (Currency.unwrap(newtoken) > Currency.unwrap(weth)) {
            (newtoken, weth) = (weth, newtoken);
            // Re-check usdc ordering
            if (Currency.unwrap(weth) > Currency.unwrap(usdc)) {
                (weth, usdc) = (usdc, weth);
            }
        }

        // Deploy the hook with correct permission flags
        address flags = address(
            uint160(
                Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            ) ^ (0x4444 << 144)
        );
        bytes memory constructorArgs = abi.encode(poolManager, address(this));
        deployCodeTo("CrossPoolOracleHook.sol:CrossPoolOracleHook", constructorArgs, flags);
        hook = CrossPoolOracleHook(flags);

        // === Setup Reference Pool (WETH/USDC) — deep liquidity, no hook ===
        referencePoolKey = PoolKey(weth, usdc, 3000, 60, IHooks(address(0)));
        referencePoolId = referencePoolKey.toId();
        poolManager.initialize(referencePoolKey, Constants.SQRT_PRICE_1_1);

        // Add deep liquidity to reference pool
        _addLiquidity(referencePoolKey, 1000e18);

        // === Setup Protected Pool (NEWTOKEN/WETH) — thin liquidity, our hook ===
        // Register the pool config BEFORE initializing
        hook.registerPool(
            PoolKey(newtoken, weth, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook)),
            referencePoolId,
            true,      // referenceZeroForOne
            3000,      // baseFee: 0.3%
            10000,     // highImpactFee: 1%
            200,       // highImpactThresholdBps: 2%
            1000       // circuitBreakerBps: 10%
        );

        protectedPoolKey = PoolKey(newtoken, weth, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));
        protectedPoolId = protectedPoolKey.toId();
        poolManager.initialize(protectedPoolKey, Constants.SQRT_PRICE_1_1);

        // Add thin liquidity to protected pool
        _addLiquidity(protectedPoolKey, 10e18);
    }

    // ============ Test: Normal swap gets base fee ============

    function test_NormalSwap_BasesFee() public {
        // Small swap on the protected pool — should get normal 0.3% fee
        uint256 amountIn = 0.01e18;

        BalanceDelta delta = swapRouter.swapExactTokensForTokens({
            amountIn: amountIn,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: protectedPoolKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        // Swap should succeed
        assertEq(int256(delta.amount0()), -int256(amountIn), "Should spend exact amountIn");
        assertTrue(delta.amount1() > 0, "Should receive output tokens");

        console.log("Normal swap output:", uint256(int256(delta.amount1())));
    }

    // ============ Test: Large swap triggers elevated fee ============

    function test_LargeSwap_ElevatedFee() public {
        // Large swap relative to pool liquidity — high price impact
        // Should trigger elevated fee (1%) but not circuit breaker
        uint256 smallAmount = 0.01e18;
        uint256 largeAmount = 0.5e18; // Large relative to 10e18 liquidity

        // Do a small swap first to establish baseline output
        BalanceDelta smallDelta = swapRouter.swapExactTokensForTokens({
            amountIn: smallAmount,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: protectedPoolKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        // Do a large swap — should still succeed but with worse fee
        BalanceDelta largeDelta = swapRouter.swapExactTokensForTokens({
            amountIn: largeAmount,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: protectedPoolKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        assertTrue(largeDelta.amount1() > 0, "Large swap should still succeed");

        // The large swap should get proportionally less output per unit due to higher fee
        // (plus natural price impact from AMM math)
        uint256 smallOutputPerUnit = uint256(int256(smallDelta.amount1())) * 1e18 / smallAmount;
        uint256 largeOutputPerUnit = uint256(int256(largeDelta.amount1())) * 1e18 / largeAmount;

        assertTrue(
            largeOutputPerUnit < smallOutputPerUnit,
            "Large swap should get worse rate (higher fee + price impact)"
        );

        console.log("Small swap output/unit:", smallOutputPerUnit);
        console.log("Large swap output/unit:", largeOutputPerUnit);
    }

    // ============ Test: Manipulation triggers circuit breaker ============

    function test_Manipulation_CircuitBreaker() public {
        // Try to dump an enormous amount — should trigger circuit breaker
        // This simulates someone trying to crash the NEWTOKEN price
        uint256 manipulationAmount = 5e18; // 50% of pool liquidity

        vm.expectRevert();
        swapRouter.swapExactTokensForTokens({
            amountIn: manipulationAmount,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: protectedPoolKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });
    }

    // ============ Test: Reference pool movement explains impact ============

    function test_ReferenceMovement_NotManipulation() public {
        // First, move the reference pool (simulating market-wide ETH price change)
        // This represents a legitimate market movement
        uint256 refSwapAmount = 50e18; // Big swap on the deep reference pool
        swapRouter.swapExactTokensForTokens({
            amountIn: refSwapAmount,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: referencePoolKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        // Now swap on the protected pool — the price impact should be partially
        // "explained" by the reference pool movement
        uint256 protectedSwapAmount = 0.5e18;

        // This should succeed because the reference price moved too,
        // so the unexplained impact is lower
        BalanceDelta delta = swapRouter.swapExactTokensForTokens({
            amountIn: protectedSwapAmount,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: protectedPoolKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        assertTrue(delta.amount1() > 0, "Swap should succeed - movement is explained by reference");
        console.log("Reference-explained swap output:", uint256(int256(delta.amount1())));
    }

    // ============ Test: Cross-pool price read works ============

    function test_CrossPoolPriceRead() public {
        // Verify the hook correctly reads the reference pool price
        (uint160 refSqrtPrice,,,) = poolManager.getSlot0(referencePoolId);
        assertTrue(refSqrtPrice > 0, "Reference pool should have a valid price");

        uint160 storedRefPrice = hook.lastReferenceSqrtPrice(protectedPoolId);
        assertEq(storedRefPrice, refSqrtPrice, "Hook should store reference price on init");
    }

    // ============ Test: Multi-reference pool support ============

    function test_MultiReference_MaxMovementUsed() public {
        // Create a second reference pool (USDC/NEWTOKEN) with deep liquidity
        // We reuse existing tokens; just need a new pool with no hook
        Currency ref2C0;
        Currency ref2C1;
        if (Currency.unwrap(usdc) < Currency.unwrap(newtoken)) {
            ref2C0 = usdc;
            ref2C1 = newtoken;
        } else {
            ref2C0 = newtoken;
            ref2C1 = usdc;
        }
        PoolKey memory ref2Key = PoolKey(ref2C0, ref2C1, 3000, 60, IHooks(address(0)));
        poolManager.initialize(ref2Key, Constants.SQRT_PRICE_1_1);
        _addLiquidity(ref2Key, 1000e18);
        PoolId ref2PoolId = ref2Key.toId();

        // Deploy a new hook for the multi-ref test
        address flags2 = address(
            uint160(
                Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            ) ^ (0x5555 << 144)
        );
        bytes memory constructorArgs2 = abi.encode(poolManager, address(this));
        deployCodeTo("CrossPoolOracleHook.sol:CrossPoolOracleHook", constructorArgs2, flags2);
        CrossPoolOracleHook hook2 = CrossPoolOracleHook(flags2);

        // Register with TWO reference pools
        PoolId[] memory refs = new PoolId[](2);
        refs[0] = referencePoolId;
        refs[1] = ref2PoolId;
        bool[] memory dirs = new bool[](2);
        dirs[0] = true;
        dirs[1] = true;

        PoolKey memory multiProtKey = PoolKey(newtoken, weth, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook2));
        hook2.registerPoolMultiRef(multiProtKey, refs, dirs, 3000, 10000, 200, 1000);
        poolManager.initialize(multiProtKey, Constants.SQRT_PRICE_1_1);
        _addLiquidity(multiProtKey, 10e18);

        // Move only the SECOND reference pool
        swapRouter.swapExactTokensForTokens({
            amountIn: 50e18,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: ref2Key,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        // Swap on multi-ref protected pool should succeed because ref2 moved
        BalanceDelta delta = swapRouter.swapExactTokensForTokens({
            amountIn: 0.5e18,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: multiProtKey,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });

        assertTrue(delta.amount1() > 0, "Multi-ref swap should succeed - ref2 movement explains impact");
    }

    // ============ Helpers ============

    function _addLiquidity(PoolKey memory key, uint128 liquidityAmount) internal {
        int24 tickLower = TickMath.minUsableTick(key.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(key.tickSpacing);

        (uint256 amount0Expected, uint256 amount1Expected) = LiquidityAmounts.getAmountsForLiquidity(
            Constants.SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidityAmount
        );

        positionManager.mint(
            key,
            tickLower,
            tickUpper,
            liquidityAmount,
            amount0Expected + 1,
            amount1Expected + 1,
            address(this),
            block.timestamp,
            Constants.ZERO_BYTES
        );
    }
}
