// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {AddressConstants} from "hookmate/constants/AddressConstants.sol";

import {CrossPoolOracleHook} from "../src/CrossPoolOracleHook.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Deploys the CrossPoolOracleHook to a testnet with demo pools
contract DeployCrossPoolOracle is Script {
    using PoolIdLibrary for PoolKey;

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    // Set during run()
    IPoolManager poolManager;
    IPositionManager positionManager;
    IPermit2 permit2;

    function run() public {
        poolManager = IPoolManager(getPoolManager());
        positionManager = IPositionManager(getPositionManager());
        permit2 = IPermit2(AddressConstants.getPermit2Address());

        vm.startBroadcast();

        // Deploy test tokens
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 18);
        MockERC20 newtoken = new MockERC20("New Token", "NEW", 18);

        weth.mint(msg.sender, 1_000_000e18);
        usdc.mint(msg.sender, 1_000_000e18);
        newtoken.mint(msg.sender, 1_000_000e18);

        console.log("WETH:", address(weth));
        console.log("USDC:", address(usdc));
        console.log("NEWTOKEN:", address(newtoken));

        // Deploy hook
        CrossPoolOracleHook hook = _deployHook();

        // Approve tokens
        _approveTokens(address(weth), address(usdc), address(newtoken));

        // Create reference pool
        (Currency refC0, Currency refC1) = _sortCurrencies(address(weth), address(usdc));
        PoolKey memory refKey = PoolKey(refC0, refC1, 3000, 60, IHooks(address(0)));
        _createPoolWithLiquidity(refKey, 1000e18);
        console.log("Reference pool created");

        // Register + create protected pool
        (Currency protC0, Currency protC1) = _sortCurrencies(address(newtoken), address(weth));
        PoolKey memory protKey = PoolKey(protC0, protC1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(hook));

        hook.registerPool(protKey, refKey.toId(), true, 3000, 10000, 200, 1000);
        _createPoolWithLiquidity(protKey, 10e18);
        console.log("Protected pool created");

        vm.stopBroadcast();

        console.log("=== DEPLOYMENT SUMMARY ===");
        console.log("Hook:", address(hook));
        console.log("WETH:", address(weth));
        console.log("USDC:", address(usdc));
        console.log("NEWTOKEN:", address(newtoken));
    }

    function _deployHook() internal returns (CrossPoolOracleHook) {
        uint160 flags = uint160(
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory constructorArgs = abi.encode(address(poolManager), msg.sender);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(CrossPoolOracleHook).creationCode, constructorArgs);

        CrossPoolOracleHook hook = new CrossPoolOracleHook{salt: salt}(poolManager, msg.sender);
        require(address(hook) == hookAddress, "Hook address mismatch");
        console.log("Hook deployed at:", address(hook));
        return hook;
    }

    function _approveTokens(address weth, address usdc, address newtoken) internal {
        MockERC20(weth).approve(address(permit2), type(uint256).max);
        MockERC20(usdc).approve(address(permit2), type(uint256).max);
        MockERC20(newtoken).approve(address(permit2), type(uint256).max);

        permit2.approve(weth, address(positionManager), type(uint160).max, type(uint48).max);
        permit2.approve(usdc, address(positionManager), type(uint160).max, type(uint48).max);
        permit2.approve(newtoken, address(positionManager), type(uint160).max, type(uint48).max);
    }

    function _createPoolWithLiquidity(PoolKey memory key, uint128 liquidity) internal {
        int24 tickLower = TickMath.minUsableTick(key.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(key.tickSpacing);

        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            SQRT_PRICE_1_1,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidity
        );

        bytes[] memory multicallParams = new bytes[](2);
        multicallParams[0] = abi.encodeWithSelector(
            positionManager.initializePool.selector, key, SQRT_PRICE_1_1, ""
        );
        multicallParams[1] = abi.encodeWithSelector(
            positionManager.modifyLiquidities.selector,
            abi.encode(
                abi.encodePacked(
                    uint8(Actions.MINT_POSITION),
                    uint8(Actions.SETTLE_PAIR),
                    uint8(Actions.SWEEP),
                    uint8(Actions.SWEEP)
                ),
                _mintParams(key, tickLower, tickUpper, liquidity, a0 + 1, a1 + 1, msg.sender)
            ),
            block.timestamp + 3600
        );
        positionManager.multicall(multicallParams);
    }

    function _sortCurrencies(address a, address b) internal pure returns (Currency, Currency) {
        if (a < b) return (Currency.wrap(a), Currency.wrap(b));
        return (Currency.wrap(b), Currency.wrap(a));
    }

    function _mintParams(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Max,
        uint256 amount1Max,
        address recipient
    ) internal pure returns (bytes[] memory params) {
        params = new bytes[](4);
        params[0] = abi.encode(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient, "");
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(key.currency0, recipient);
        params[3] = abi.encode(key.currency1, recipient);
    }

    function getPoolManager() internal view returns (address) {
        if (block.chainid == 11155111) return 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
        revert("Unsupported chain");
    }

    function getPositionManager() internal view returns (address) {
        if (block.chainid == 11155111) return 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
        revert("Unsupported chain");
    }
}
