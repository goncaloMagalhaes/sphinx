// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import { Proxy } from "./libraries/Proxy.sol";
import { ChugSplashRegistry } from "./ChugSplashRegistry.sol";
import { IChugSplashManager } from "./interfaces/IChugSplashManager.sol";
import { IChugSplashRegistry } from "./interfaces/IChugSplashRegistry.sol";

/**
 * @title ChugSplashManagerProxy
 * @notice Designed to be upgradable only by the end user and to allow upgrades only to
 *         new manager versions that whitelisted by the ChugSplashRegistry.
 */
contract ChugSplashManagerProxy is Proxy {
    /**
     * @notice Address of the ChugSplashRegistry.
     */
    ChugSplashRegistry public immutable registry;

    /**
     * @param _registry              The ChugSplashRegistry's address.
     * @param _admin                 Owner of this contract.
     */
    constructor(ChugSplashRegistry _registry, address _admin) payable Proxy(_admin) {
        registry = _registry;
    }

    modifier isNotExecuting() {
        require(
            _getImplementation() == address(0) ||
                IChugSplashManager(_getImplementation()).isExecuting() == false,
            "ChugSplashManagerProxy: execution in progress"
        );
        _;
    }

    modifier isApprovedImplementation(address _implementation) {
        require(
            registry.versions(_implementation) == true,
            "ChugSplashManagerProxy: unapproved manager"
        );
        _;
    }

    /**
     * @inheritdoc Proxy
     */
    function upgradeTo(
        address _implementation
    ) public override proxyCallIfNotAdmin isNotExecuting isApprovedImplementation(_implementation) {
        super.upgradeTo(_implementation);
    }

    /**
     * @inheritdoc Proxy
     */
    function upgradeToAndCall(
        address _implementation,
        bytes calldata _data
    )
        public
        payable
        override
        proxyCallIfNotAdmin
        isNotExecuting
        isApprovedImplementation(_implementation)
        returns (bytes memory)
    {
        return super.upgradeToAndCall(_implementation, _data);
    }
}
