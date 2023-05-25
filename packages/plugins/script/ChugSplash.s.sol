// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "forge-std/Script.sol";
import "../foundry-contracts/ChugSplash.sol";
import "../contracts/Storage.sol";
import { SimpleStorage } from "../contracts/SimpleStorage.sol";

contract ChugSplashDeploy is Script {
    function run() public {
        ChugSplash chugsplash = new ChugSplash();
    }
}
