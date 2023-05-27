
library Deploy {
    // - bundles, configUri (used only for logs)
    struct TODO {
        bytes32 organizationID;
        string memory projectName;
    }

    struct ConfigContractInfo {
        string referenceName;
        address contractAddress;
    }

    struct OptionalAddress {
        address value;
        bool exists;
    }

    // TODO(bundling): sort by ascending actionIndex, and remove the sort in `executeTask`

    // TODO(test): etherscan verification: https://book.getfoundry.sh/tutorials/solidity-scripting. i'd be
    //   surprised if this works since we deploy contracts in a non-standard way

    // TODO(test): you should throw a helpful error message in foundry/index.ts if reading from
    // state on the in-process node (e.g. in async user config).

    // TODO: spinner

    // TODO(inputs):
    // TODO(overload):
    // - newOwner? (not necessary for `finalizeRegistration`)
    // TODO(docs): this is the plugins deployTask and the deployAbstractTask
    function deploy(string memory _configPath, OptionalAddress _newProjectOwner) internal {
        (bytes32 organizationID, string memory projectName) = ffiGetConfigOptions(_configPath);

        ChugSplashManager manager = getChugSplashManager(organizationID);

        // TODO: what happens to msg.sender when startBroadcast(addr) is used?
        finalizeRegistration(manager, organizationID, msg.sender, false, projectName);

// assertValidBlockGasLimit
//     // Make sure that the external proxy contract exists.
// assertAvailableCreate3Addresses: isContractDeployed, queryfilter
// estimateGas
// isLiveNetwork (parse.ts)
// assertValidDeploymentSize

        (ChugSplashBundles memory bundles, string memory configUri, ConfigContractInfo[] memory configContractInfo) = ffiGetDeploymentInfo(_configPath);

        if (
            bundles.actionBundle.actions.length == 0 &&
            bundles.targetBundle.targets.length == 0
        ) {
            return;
        }

        bytes32 deploymentID = getDeploymentID(bundles, configUri);
        DeploymentState deploymentState = manager.deployments(deploymentID);

        if (deploymentState.status == DeploymentStatus.COMPLETED) {
            completeDeployment(_newProjectOwner);
            return;
        } else if (deploymentState.status == DeploymentStatus.CANCELLED) {
            revert(string.concat(projectName, " was previously cancelled on ", networkName));
        }
    } else if (deploymentState.status == DeploymentStatus.EMPTY) {
        proposeChugSplashDeployment
    }

    function finalizeRegistration(ChugSplashManager _manager, bytes32 _organizationID, address _newProjectOwner, bool _allowManagedProposals, string memory _projectName) internal {
        if (!isProjectClaimed(address(_manager))) {
            bytes memory initializerData = abi.encode(_manager, _organizationID, _allowManagedProposals);

            ChugSplashRegistry registry = getChugSplashRegistry();
            registry.finalizeRegistration(_organizationID, _newProjectOwner, getCurrentChugSplashManagerVersion(), initializerData);
        } else {
            address existingOwnerAddress = getProjectOwnerAddress(address(_manager));
            if (existingOwnerAddress != _newProjectOwner) {
                revert("ChugSplash: project already claimed by another address");
            } else {
                // TODO: spinner
            }
        }
    }

    function completeDeployment(ChugSplashManager _manager, OptionalAddress _newProjectOwner) internal {
        if (_newProjectOwner.exists) {
            transferProjectOwnership(_manager, _newProjectOwner.value);
        }

        ffiCompleteDeployment();
    }

    function transferProjectOwnership(ChugSplashManager _manager, address _newProjectOwner) internal {
        if (_newProjectOwner != _manager.owner()) {
            if (_newProjectOwner == address(0)) {
                _manager.renounceOwnership();
            } else {
                _manager.transferOwnership(_newProjectOwner);
            }
        }
    }
}
