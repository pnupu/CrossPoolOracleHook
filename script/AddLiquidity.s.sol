// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {AddressConstants} from "hookmate/constants/AddressConstants.sol";

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

/// @notice Adds more liquidity to the deployed protected pool
contract AddLiquidity is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // Sepolia addresses
    address constant HOOK = 0x9c981cdc56335664F21448cA4f40c54390B7D0C0;
    address constant WETH = 0x53f646Df4442A1Caca581078Ca63076D882640A4;
    address constant NEWTOKEN = 0x12b067D6755340bd03fdFA370D73A84f7Ad06c19;
    address constant POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant POSITION_MANAGER = 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;

    function run() public {
        IPoolManager poolManager = IPoolManager(POOL_MANAGER);
        IPositionManager positionManager = IPositionManager(POSITION_MANAGER);
        IPermit2 permit2 = IPermit2(AddressConstants.getPermit2Address());

        // Build protected pool key
        (Currency c0, Currency c1) = NEWTOKEN < WETH
            ? (Currency.wrap(NEWTOKEN), Currency.wrap(WETH))
            : (Currency.wrap(WETH), Currency.wrap(NEWTOKEN));

        PoolKey memory protKey = PoolKey(c0, c1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(HOOK));

        // Read current sqrtPrice
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(protKey.toId());
        console.log("Current sqrtPriceX96:", sqrtPriceX96);

        uint128 liquidityToAdd = 1000e18;
        int24 tickLower = TickMath.minUsableTick(60);
        int24 tickUpper = TickMath.maxUsableTick(60);

        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            liquidityToAdd
        );

        console.log("Amount0 needed:", a0);
        console.log("Amount1 needed:", a1);

        vm.startBroadcast();

        // Mint extra tokens if needed
        MockERC20(NEWTOKEN).mint(msg.sender, a0 + 1e18);
        MockERC20(WETH).mint(msg.sender, a1 + 1e18);

        // Approve
        MockERC20(NEWTOKEN).approve(address(permit2), type(uint256).max);
        MockERC20(WETH).approve(address(permit2), type(uint256).max);
        permit2.approve(NEWTOKEN, address(positionManager), type(uint160).max, type(uint48).max);
        permit2.approve(WETH, address(positionManager), type(uint160).max, type(uint48).max);

        // Mint position (add liquidity to existing pool — no initializePool needed)
        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION),
            uint8(Actions.SETTLE_PAIR),
            uint8(Actions.SWEEP),
            uint8(Actions.SWEEP)
        );

        bytes[] memory params = new bytes[](4);
        params[0] = abi.encode(protKey, tickLower, tickUpper, liquidityToAdd, a0 + 1, a1 + 1, msg.sender, "");
        params[1] = abi.encode(protKey.currency0, protKey.currency1);
        params[2] = abi.encode(protKey.currency0, msg.sender);
        params[3] = abi.encode(protKey.currency1, msg.sender);

        positionManager.modifyLiquidities(
            abi.encode(actions, params),
            block.timestamp + 3600
        );

        console.log("Added liquidity:", liquidityToAdd);

        vm.stopBroadcast();
    }
}
