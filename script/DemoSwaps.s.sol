// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";

import {CrossPoolOracleHook} from "../src/CrossPoolOracleHook.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Demo script: shows normal swap, elevated fee, and circuit breaker on Sepolia
contract DemoSwaps is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // === Sepolia deployment addresses ===
    address constant HOOK = 0x9c981cdc56335664F21448cA4f40c54390B7D0C0;
    address constant WETH = 0x53f646Df4442A1Caca581078Ca63076D882640A4;
    address constant USDC = 0x0B2B7b0fa0ad02D6A2bbE5d93cAE06045f849C8A;
    address constant NEWTOKEN = 0x12b067D6755340bd03fdFA370D73A84f7Ad06c19;

    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address payable constant SWAP_ROUTER = payable(0xf13D190e9117920c703d79B5F33732e10049b115);
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    IUniswapV4Router04 router = IUniswapV4Router04(SWAP_ROUTER);
    IPoolManager poolManager = IPoolManager(POOL_MANAGER);

    function run() public {
        // Build pool keys (currencies must be sorted)
        (Currency refC0, Currency refC1) = _sort(WETH, USDC);
        (Currency protC0, Currency protC1) = _sort(NEWTOKEN, WETH);

        PoolKey memory refKey = PoolKey(refC0, refC1, 3000, 60, IHooks(address(0)));
        PoolKey memory protKey = PoolKey(protC0, protC1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(HOOK));

        vm.startBroadcast();

        // Approve tokens to router via Permit2
        _approveAll();

        console.log("=== DEMO 1: Normal small swap (expect base 0.3% fee) ===");
        _doSwap(protKey, 0.01e18, "Small swap");

        console.log("");
        console.log("=== DEMO 2: Larger swap (expect elevated 1% fee) ===");
        _doSwap(protKey, 0.5e18, "Large swap");

        console.log("");
        console.log("=== DEMO 3: Reference pool movement, then protected swap ===");
        console.log("Moving reference pool price (big WETH/USDC swap)...");
        _doSwap(refKey, 50e18, "Reference pool swap");
        console.log("Now swapping on protected pool (should succeed - movement is explained)...");
        _doSwap(protKey, 0.5e18, "Protected swap after ref move");

        vm.stopBroadcast();

        // Demo 4 uses vm.prank instead of broadcast because the tx reverts
        // (circuit breaker blocks it) and forge can't broadcast reverted txs
        console.log("");
        console.log("=== DEMO 4: Manipulation attempt (expect circuit breaker revert) ===");
        console.log("Attempting massive swap on protected pool...");
        console.log("(simulated locally - this tx would revert on-chain)");
        vm.prank(msg.sender);
        try router.swapExactTokensForTokens({
            amountIn: 5e18,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: protKey,
            hookData: "",
            receiver: msg.sender,
            deadline: block.timestamp + 3600
        }) returns (BalanceDelta) {
            console.log("ERROR: Swap should have been blocked!");
        } catch {
            console.log("CIRCUIT BREAKER TRIGGERED - swap blocked (as expected)");
        }

        console.log("");
        console.log("=== DEMO COMPLETE ===");
    }

    function _doSwap(PoolKey memory key, uint256 amountIn, string memory label) internal {
        // Read price before
        PoolId id = key.toId();
        (uint160 sqrtPriceBefore,,,) = poolManager.getSlot0(id);

        BalanceDelta delta = router.swapExactTokensForTokens({
            amountIn: amountIn,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: key,
            hookData: "",
            receiver: msg.sender,
            deadline: block.timestamp + 3600
        });

        // Read price after
        (uint160 sqrtPriceAfter,,,) = poolManager.getSlot0(id);

        int256 spent = delta.amount0();
        int256 received = delta.amount1();

        console.log(label);
        console.log("  In: ", uint256(-spent));
        console.log("  Out:", uint256(received));
        console.log("  Price before (sqrtX96):", uint256(sqrtPriceBefore));
        console.log("  Price after  (sqrtX96):", uint256(sqrtPriceAfter));
    }

    function _approveAll() internal {
        // Approve tokens to Permit2
        MockERC20(WETH).approve(PERMIT2, type(uint256).max);
        MockERC20(USDC).approve(PERMIT2, type(uint256).max);
        MockERC20(NEWTOKEN).approve(PERMIT2, type(uint256).max);

        // Permit2 allowances for swap router
        IPermit2(PERMIT2).approve(WETH, SWAP_ROUTER, type(uint160).max, type(uint48).max);
        IPermit2(PERMIT2).approve(USDC, SWAP_ROUTER, type(uint160).max, type(uint48).max);
        IPermit2(PERMIT2).approve(NEWTOKEN, SWAP_ROUTER, type(uint160).max, type(uint48).max);

        // Direct ERC20 approvals to swap router (it does transferFrom directly)
        MockERC20(WETH).approve(SWAP_ROUTER, type(uint256).max);
        MockERC20(USDC).approve(SWAP_ROUTER, type(uint256).max);
        MockERC20(NEWTOKEN).approve(SWAP_ROUTER, type(uint256).max);
    }

    function _sort(address a, address b) internal pure returns (Currency, Currency) {
        if (a < b) return (Currency.wrap(a), Currency.wrap(b));
        return (Currency.wrap(b), Currency.wrap(a));
    }
}
