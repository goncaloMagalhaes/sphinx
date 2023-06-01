// SPDX-License-Identifier: MIT
pragma solidity ^0.8.15;

import { ChugSplashActionBundle, ChugSplashTargetBundle } from "@chugsplash/contracts/contracts/ChugSplashDataTypes.sol";
import {
    ConfigCache,
    MinimalParsedConfig
} from "./ChugSplashPluginTypes.sol";

contract ChugSplashUtils {
    // These provide an easy way to get structs off-chain via the ABI.
    function actionBundle() external pure returns (ChugSplashActionBundle memory) {}
    function targetBundle() external pure returns (ChugSplashTargetBundle memory) {}
    function configCache() external pure returns (ConfigCache memory) {}
    function minimalParsedConfig() external pure returns (MinimalParsedConfig memory) {}

    function slice(bytes calldata _data, uint256 _start, uint256 _end) external pure returns (bytes memory) {
        return _data[_start:_end];
    }

    // Provides an easy way to get the actual msg.sender in Forge scripts. When a user specifies a
    // msg.sender in a Forge script, the address is only available in the context of the contracts
    // that are called by the script, and not within the script itself. The easiest way to reliably
    // retrieve the address is to call an external function on another contract that returns the
    // msg.sender.
    function msgSender() external view returns (address) {
        return msg.sender;
    }
}
