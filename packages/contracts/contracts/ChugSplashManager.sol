// SPDX-License-Identifier: MIT
pragma solidity ^0.8.15;

import {
    DeploymentState,
    RawChugSplashAction,
    ChugSplashTarget,
    ChugSplashActionType,
    DeploymentStatus
} from "./ChugSplashDataTypes.sol";
import {
    OwnableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Proxy } from "@eth-optimism/contracts-bedrock/contracts/universal/Proxy.sol";
import { ChugSplashRegistry } from "./ChugSplashRegistry.sol";
import { IChugSplashManager } from "./interfaces/IChugSplashManager.sol";
import { IProxyAdapter } from "./interfaces/IProxyAdapter.sol";
import {
    Lib_MerkleTree as MerkleTree
} from "@eth-optimism/contracts/libraries/utils/Lib_MerkleTree.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { Semver, Version } from "./Semver.sol";
import { IGasPriceCalculator } from "./interfaces/IGasPriceCalculator.sol";
import {
    ERC2771ContextUpgradeable
} from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import {
    ContextUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { ChugSplashManagerEvents } from "./ChugSplashManagerEvents.sol";

/**
 * @title ChugSplashManager
 * @custom:version 1.0.0
 * @notice This contract contains the logic for managing the entire lifecycle of a project's
   deployments. It contains the functionality for proposing, approving, and executing deployments,
   paying remote executors, and exporting proxies out of the ChugSplash system if desired. It exists
   as a single implementation contract behind ChugSplashManagerProxy contracts.

   After a deployment is approved, it is executed in the following steps, which must occur in order.
    1. Execute all of the `DEPLOY_CONTRACT` actions using the `executeActions` function. This is
       first because it's possible for the constructor of a deployed contract to revert. If this
       happens, we cancel the deployment before the proxies are modified in any way.
    2. The `initiateProxies` function.
    3. Execute all of the `SET_STORAGE` actions using the `executeActions` function.
    4. The `completeUpgrade` function.
 */
contract ChugSplashManager is
    OwnableUpgradeable,
    Semver,
    IChugSplashManager,
    ERC2771ContextUpgradeable,
    ChugSplashManagerEvents
{
    /**
     * @notice Role required to be a remote executor for a deployment.
     */
    bytes32 internal constant REMOTE_EXECUTOR_ROLE = keccak256("REMOTE_EXECUTOR_ROLE");

    /**
     * @notice Role required to propose deployments through the ManagedService contract.
     */
    bytes32 internal constant MANAGED_PROPOSER_ROLE = keccak256("MANAGED_PROPOSER_ROLE");

    /**
     * @notice Address of the ChugSplashRegistry.
     */
    ChugSplashRegistry public immutable registry;

    /**
     * @notice Address of the GasPriceCalculator contract.
     */
    IGasPriceCalculator public immutable gasPriceCalculator;

    /**
     * @notice Address of the ManagedService contract.
     */
    IAccessControl public immutable managedService;

    /**
     * @notice Amount that must be stored in this contract in order to remotely execute a
       deployment. It is not necessary to deposit this amount if the owner is self-executing their
       deployment. The bond can be deposited by any account.

       The owner can withdraw this amount whenever a deployment is not active. However, this amount
       will be forfeited if the owner cancels a deployment that is in progress and within the
       `executionLockTime`. This is necessary to prevent owners from trolling the remote executor by
       immediately cancelling and withdrawing funds.
     */
    uint256 public immutable ownerBondAmount;

    /**
     * @notice Amount of time for a remote executor to finish executing a deployment once they have
       claimed it.
     */
    uint256 public immutable executionLockTime;

    /**
     * @notice Percentage that the remote executor profits from a deployment. This is denominated as
       a percentage of the cost of execution. For example, if a deployment costs 1 gwei to execute
       and the executorPaymentPercentage is 10, then the executor will profit 0.1 gwei.
     */
    uint256 public immutable executorPaymentPercentage;

    /**
     * @notice Percentage that the protocol creators profit during a remotely executed deployment.
       This is denominated as a percentage of the cost of execution. For example, if a deployment
       costs 1 gwei to execute and the protocolPaymentPercentage is 10, then the protocol will
       profit 0.1 gwei. Note that the protocol does not profit during a self-executed deployment.
     */
    uint256 public immutable protocolPaymentPercentage;

    /**
     * @notice Mapping of executor addresses to the ETH amount stored in this contract that is
     *         owed to them.
     */
    mapping(address => uint256) public executorDebt;

    /**
     * @notice Maps an address to a boolean indicating if the address has been approved by the owner
       to propose deployments. Note that this does include proposers from the managed service (see
       `isProposer`).
     */
    mapping(address => bool) public proposers;

    /**
     * @notice Mapping of deployment IDs to deployment state.
     */
    mapping(bytes32 => DeploymentState) internal _deployments;

    /**
     * @notice Organization ID for this contract.
     */
    bytes32 public organizationID;

    /**
     * @notice ID of the currently active deployment.
     */
    bytes32 public activeDeploymentId;

    /**
     * @notice Total ETH amount stored in this contract that is owed to remote executors.
     */
    uint256 public totalExecutorDebt;

    /**
     * @notice Total ETH amount stored in this contract that is owed to the protocol creators.
     */
    uint256 public totalProtocolDebt;

    /**
     * @notice A boolean indicating if the owner of this contract has approved the ManagedService
       contract to propose deployments on their behalf.
     */
    bool public allowManagedProposals;

    /**
     * @notice Modifier that reverts if the caller is not a remote executor.
     */
    modifier onlyExecutor() {
        if (!managedService.hasRole(REMOTE_EXECUTOR_ROLE, _msgSender())) {
            revert CallerIsNotRemoteExecutor();
        }
        _;
    }

    /**
     * @param _registry                  Address of the ChugSplashRegistry.
     * @param _gasPriceCalculator        Address of the GasPriceCalculator contract.
     * @param _managedService            Address of the ManagedService contract.
     * @param _executionLockTime         Amount of time for a remote executor to completely execute
       a deployment after claiming it.
     * @param _ownerBondAmount           Amount that must be deposited in this contract in order to
     *                                   remote execute a deployment.
     * @param _executorPaymentPercentage Percentage that an executor will profit from completing a
       deployment.
     * @param _protocolPaymentPercentage Percentage that the protocol creators will profit from
         completing a deployment.
     * @param _version                   Version of this contract.
     */
    constructor(
        ChugSplashRegistry _registry,
        IGasPriceCalculator _gasPriceCalculator,
        IAccessControl _managedService,
        uint256 _executionLockTime,
        uint256 _ownerBondAmount,
        uint256 _executorPaymentPercentage,
        uint256 _protocolPaymentPercentage,
        Version memory _version,
        address _trustedForwarder
    )
        Semver(_version.major, _version.minor, _version.patch)
        ERC2771ContextUpgradeable(_trustedForwarder)
    {
        registry = _registry;
        gasPriceCalculator = _gasPriceCalculator;
        managedService = _managedService;
        executionLockTime = _executionLockTime;
        ownerBondAmount = _ownerBondAmount;
        executorPaymentPercentage = _executorPaymentPercentage;
        protocolPaymentPercentage = _protocolPaymentPercentage;
    }

    /**
     * @notice Allows anyone to send ETH to this contract.
     */
    receive() external payable {
        emit ETHDeposited(_msgSender(), msg.value);
        registry.announce("ETHDeposited");
    }

    /**
     * @inheritdoc IChugSplashManager
     *
     * @param _data Initialization data. We expect the following data, ABI-encoded:
     *              - address _owner: Address of the owner of this contract.
     *              - bytes32 _organizationID: Organization ID for this contract.
     *              - bool _allowManagedProposals: Whether or not to allow upgrade proposals from
     *                the ManagedService contract.
     *
     * @return Empty bytes.
     */
    function initialize(bytes memory _data) external initializer returns (bytes memory) {
        (address _owner, bytes32 _organizationID, bool _allowManagedProposals) = abi.decode(
            _data,
            (address, bytes32, bool)
        );

        organizationID = _organizationID;
        allowManagedProposals = _allowManagedProposals;

        __ReentrancyGuard_init();
        __Ownable_init();
        _transferOwnership(_owner);

        return "";
    }

    /**
     * @notice Propose a new deployment. No action can be taken on the deployment until it is
       approved via the `approve` function. Only callable by the owner of this contract, a proposer
       that has been approved by the owner, or the ManagedService contract, if
       `allowManagedProposals` is true. These permissions prevent spam.
     *
     * @param _actionRoot Root of the Merkle tree containing the actions for the deployment.
     * This may be `bytes32(0)` if there are no actions in the deployment.
     * @param _targetRoot Root of the Merkle tree containing the targets for the deployment.
     * This may be `bytes32(0)` if there are no targets in the deployment.
     * @param _numNonProxyContracts Number of non-proxy contracts in the deployment.
     * @param _numActions Number of actions in the deployment.
     * @param _numTargets Number of targets in the deployment.
     * @param _configUri  URI pointing to the config file for the deployment.
     * @param _remoteExecution Whether or not to allow remote execution of the deployment.
     */
    function propose(
        bytes32 _actionRoot,
        bytes32 _targetRoot,
        uint256 _numActions,
        uint256 _numTargets,
        uint256 _numNonProxyContracts,
        string memory _configUri,
        bool _remoteExecution
    ) public {
        if (!isProposer(_msgSender())) {
            revert CallerIsNotProposer();
        }

        // Compute the deployment ID.
        bytes32 deploymentId = keccak256(
            abi.encode(
                _actionRoot,
                _targetRoot,
                _numActions,
                _numTargets,
                _numNonProxyContracts,
                _configUri
            )
        );

        DeploymentState storage deployment = _deployments[deploymentId];

        DeploymentStatus status = deployment.status;
        if (
            status != DeploymentStatus.EMPTY &&
            status != DeploymentStatus.COMPLETED &&
            status != DeploymentStatus.CANCELLED &&
            status != DeploymentStatus.FAILED
        ) {
            revert DeploymentStateIsNotProposable();
        }

        deployment.status = DeploymentStatus.PROPOSED;
        deployment.actionRoot = _actionRoot;
        deployment.targetRoot = _targetRoot;
        deployment.numNonProxyContracts = _numNonProxyContracts;
        deployment.actions = new bool[](_numActions);
        deployment.targets = _numTargets;
        deployment.remoteExecution = _remoteExecution;
        deployment.configUri = _configUri;

        emit ChugSplashDeploymentProposed(
            deploymentId,
            _actionRoot,
            _targetRoot,
            _numActions,
            _numTargets,
            _numNonProxyContracts,
            _configUri,
            _remoteExecution,
            _msgSender()
        );
        registry.announceWithData("ChugSplashDeploymentProposed", abi.encodePacked(_msgSender()));
    }

    /**
     * @notice Wrapper on the propose function which allows for a gasless proposal where the cost of
     *         the using proposal is added to the protocol debt. This allows us to provide gasless
     *         proposals using meta transactions while collecting the cost from the user after
     *         execution completes.
     */
    function gaslesslyPropose(
        bytes32 _actionRoot,
        bytes32 _targetRoot,
        uint256 _numActions,
        uint256 _numTargets,
        uint256 _numNonProxyContracts,
        string memory _configUri,
        bool _remoteExecution
    ) external {
        uint256 initialGasLeft = gasleft();

        propose(
            _actionRoot,
            _targetRoot,
            _numActions,
            _numTargets,
            _numNonProxyContracts,
            _configUri,
            _remoteExecution
        );

        // Get the gas price
        uint256 gasPrice = gasPriceCalculator.getGasPrice();
        // Estimate the cost of the call data
        uint256 calldataGasUsed = _msgData().length * 16;
        // Calculate the gas used for the entire transaction, and add a buffer of 50k.
        uint256 estGasUsed = 100_000 + calldataGasUsed + initialGasLeft - gasleft();
        uint256 proposalCost = gasPrice * estGasUsed;

        // Add the cost of the proposal to the protocol debt
        totalProtocolDebt += proposalCost;
    }

    /**
     * @notice Allows the owner to approve a deployment to be executed. If remote execution is
       enabled, there must be at least `ownerBondAmount` deposited in this contract before the
       deployment can be approved. The deployment must be proposed before it can be approved.
     *
     * @param _deploymentId ID of the deployment to approve
     */
    function approve(bytes32 _deploymentId) external onlyOwner {
        DeploymentState storage deployment = _deployments[_deploymentId];

        if (
            deployment.remoteExecution &&
            address(this).balance > totalDebt() &&
            address(this).balance - totalDebt() < ownerBondAmount
        ) {
            revert InsufficientOwnerBond();
        }

        if (deployment.status != DeploymentStatus.PROPOSED) {
            revert DeploymentIsNotProposed();
        }

        if (activeDeploymentId != bytes32(0)) {
            revert AnotherDeploymentInProgress();
        }

        activeDeploymentId = _deploymentId;
        deployment.status = DeploymentStatus.APPROVED;

        emit ChugSplashDeploymentApproved(_deploymentId);
        registry.announce("ChugSplashDeploymentApproved");
    }

    /**
     * @notice Helper function that executes an entire upgrade in a single transaction. This allows
       the proxies in smaller upgrades to have zero downtime. This must occur after all of the
       `DEPLOY_CONTRACT` actions have been executed.

     * @param _targets Array of ChugSplashTarget structs containing the targets for the deployment.
     * @param _targetProofs Array of Merkle proofs for the targets.
     * @param _actions Array of RawChugSplashAction structs containing the actions for the
     *                 deployment.
     * @param _actionIndexes Array of indexes into the actions array for each target.
     * @param _actionProofs Array of Merkle proofs for the actions.
     */
    function executeEntireUpgrade(
        ChugSplashTarget[] memory _targets,
        bytes32[][] memory _targetProofs,
        RawChugSplashAction[] memory _actions,
        uint256[] memory _actionIndexes,
        bytes32[][] memory _actionProofs
    ) external {
        initiateUpgrade(_targets, _targetProofs);

        // Execute the `SET_STORAGE` actions if there are any.
        if (_actions.length > 0) {
            executeActions(_actions, _actionIndexes, _actionProofs);
        }

        finalizeUpgrade(_targets, _targetProofs);
    }

    /**
     * @notice **WARNING**: Cancellation is a potentially dangerous action and should not be
     *         executed unless in an emergency.
     *
     *         Allows the owner to cancel an active deployment that was approved. If an executor has
               not claimed the deployment, the owner is simply allowed to withdraw their bond via a
               subsequent call to `withdrawOwnerETH`. Otherwise, cancelling a deployment will cause
               the owner to forfeit their bond to the executor. This is necessary to prevent owners
               from trolling the remote executor by immediately cancelling and withdrawing funds.
     */
    function cancelActiveChugSplashDeployment() external onlyOwner {
        if (activeDeploymentId == bytes32(0)) {
            revert NoActiveDeployment();
        }

        DeploymentState storage deployment = _deployments[activeDeploymentId];

        if (
            deployment.remoteExecution &&
            deployment.timeClaimed + executionLockTime >= block.timestamp
        ) {
            // Give the owner's bond to the executor if the deployment is cancelled within the
            // `executionLockTime` window.
            executorDebt[_msgSender()] += ownerBondAmount;
            totalExecutorDebt += ownerBondAmount;
        }

        bytes32 cancelledDeploymentId = activeDeploymentId;
        activeDeploymentId = bytes32(0);
        deployment.status = DeploymentStatus.CANCELLED;

        emit ChugSplashDeploymentCancelled(
            cancelledDeploymentId,
            _msgSender(),
            deployment.actionsExecuted
        );
        registry.announce("ChugSplashDeploymentCancelled");
    }

    /**
     * @notice Allows a remote executor to claim the sole right to execute a deployment over a
               period of `executionLockTime`. Only the first executor to post a bond gains this
               right. Executors must finish executing the deployment within `executionLockTime` or
               else another executor may claim the deployment.
     */
    function claimDeployment() external onlyExecutor {
        if (activeDeploymentId == bytes32(0)) {
            revert NoActiveDeployment();
        }

        DeploymentState storage deployment = _deployments[activeDeploymentId];

        if (!deployment.remoteExecution) {
            revert RemoteExecutionDisabled();
        }

        if (block.timestamp <= deployment.timeClaimed + executionLockTime) {
            revert DeploymentAlreadyClaimed();
        }

        deployment.timeClaimed = block.timestamp;
        deployment.selectedExecutor = _msgSender();

        emit ChugSplashDeploymentClaimed(activeDeploymentId, _msgSender());
        registry.announce("ChugSplashDeploymentClaimed");
    }

    /**
     * @notice Allows an executor to claim its ETH payment that was earned by completing a
       deployment. Executors may only withdraw an amount less than or equal to the amount of ETH
       owed to them by this contract. We allow the executor to withdraw less than the amount owed to
       them because it's possible that the executor's debt exceeds the amount of ETH stored in this
       contract. This situation can occur when the executor completes an underfunded deployment.

     * @param _amount Amount of ETH to withdraw.
     */
    function claimExecutorPayment(uint256 _amount) external onlyExecutor {
        if (_amount == 0) {
            revert AmountMustBeGreaterThanZero();
        }
        if (executorDebt[_msgSender()] < _amount) {
            revert InsufficientExecutorDebt();
        }
        if (_amount + totalProtocolDebt > address(this).balance) {
            revert InsufficientFunds();
        }

        executorDebt[_msgSender()] -= _amount;
        totalExecutorDebt -= _amount;

        emit ExecutorPaymentClaimed(_msgSender(), _amount, executorDebt[_msgSender()]);

        (bool paidExecutor, ) = payable(_msgSender()).call{ value: _amount }(new bytes(0));
        if (!paidExecutor) {
            revert WithdrawalFailed();
        }

        (bool paidProtocol, ) = payable(address(managedService)).call{ value: totalProtocolDebt }(
            new bytes(0)
        );
        if (!paidProtocol) {
            revert WithdrawalFailed();
        }

        registry.announce("ExecutorPaymentClaimed");
    }

    /**
     * @notice Transfers ownership of a proxy away from this contract to a specified address. Only
       callable by the owner. Note that this function allows the owner to send ownership of their
       proxy to address(0), which would make their proxy non-upgradeable.
     *
     * @param _proxy  Address of the proxy to transfer ownership of.
     * @param _contractKindHash  Hash of the contract kind, which represents the proxy type.
     * @param _newOwner  Address of the owner to receive ownership of the proxy.
     */
    function exportProxy(
        address payable _proxy,
        bytes32 _contractKindHash,
        address _newOwner
    ) external onlyOwner {
        if (_proxy.code.length == 0) {
            revert ContractDoesNotExist();
        }

        if (activeDeploymentId != bytes32(0)) {
            revert AnotherDeploymentInProgress();
        }

        // Get the adapter that corresponds to this contract type.
        address adapter = registry.adapters(_contractKindHash);
        if (adapter == address(0)) {
            revert InvalidContractKind();
        }

        emit ProxyExported(_proxy, _contractKindHash, _newOwner);

        // Delegatecall the adapter to change ownership of the proxy.
        // slither-disable-next-line controlled-delegatecall
        (bool success, ) = adapter.delegatecall(
            abi.encodeCall(IProxyAdapter.changeProxyAdmin, (_proxy, _newOwner))
        );
        if (!success) {
            revert ProxyExportFailed();
        }

        registry.announce("ProxyExported");
    }

    /**
     * @notice Allows the owner to withdraw all funds in this contract minus the debt
     *         owed to the executor and protocol. Cannot be called when there is an active
               deployment, as this would rug the remote executor.
     */
    function withdrawOwnerETH() external onlyOwner {
        if (activeDeploymentId != bytes32(0)) {
            revert AnotherDeploymentInProgress();
        }

        uint256 amount = address(this).balance - totalDebt();

        emit OwnerWithdrewETH(_msgSender(), amount);

        (bool success, ) = payable(_msgSender()).call{ value: amount }(new bytes(0));
        if (!success) {
            revert WithdrawalFailed();
        }

        registry.announce("OwnerWithdrewETH");
    }

    /**
     * @notice Allows the owner of this contract to add or remove a proposer.
     *
     * @param _proposer Address of the proposer to add or remove.
     * @param _isProposer Whether or not the proposer should be added or removed.
     */
    function setProposer(address _proposer, bool _isProposer) external onlyOwner {
        proposers[_proposer] = _isProposer;

        emit ProposerSet(_proposer, _isProposer, _msgSender());
        registry.announceWithData("ProposerSet", abi.encodePacked(_isProposer));
    }

    /**
     * @notice Allows the owner to toggle whether or not proposals via the ManagedService contract
       is allowed.
     */
    function toggleAllowManagedProposals() external onlyOwner {
        allowManagedProposals = !allowManagedProposals;

        emit ToggledManagedProposals(allowManagedProposals, _msgSender());
        registry.announceWithData(
            "ToggledManagedProposals",
            abi.encodePacked(allowManagedProposals)
        );
    }

    /**
     * @notice Gets the DeploymentState struct for a given deployment ID. Note that we explicitly
     *         define this function because the getter function auto-generated by Solidity doesn't
               return
     *         array members of structs: https://github.com/ethereum/solidity/issues/12792. Without
     *         this function, we wouldn't be able to retrieve the full `DeploymentState.actions`
               array.
     *
     * @param _deploymentId Deployment ID.
     *
     * @return DeploymentState struct.
     */
    function deployments(bytes32 _deploymentId) external view returns (DeploymentState memory) {
        return _deployments[_deploymentId];
    }

    /**
     * @inheritdoc IChugSplashManager
     */
    function isExecuting() external view returns (bool) {
        return activeDeploymentId != bytes32(0);
    }

    /**
     * @notice Deploys non-proxy contracts and sets proxy state variables. If the deployment does
       not contain any proxies, it will be completed after all of the non-proxy contracts have been
       deployed in this function.
     *
     * @param _actions Array of RawChugSplashAction structs containing the actions for the
     *                 deployment.
     * @param _actionIndexes Array of action indexes.
     * @param _proofs Array of Merkle proofs for the actions.
     */
    function executeActions(
        RawChugSplashAction[] memory _actions,
        uint256[] memory _actionIndexes,
        bytes32[][] memory _proofs
    ) public {

    }

    /**
     * @notice Initiate the proxies in an upgrade. This must be called after the contracts are
       deployment is approved, and before the rest of the execution process occurs. In this
       function, all of the proxies in the deployment are disabled by setting their implementations
       to a contract that can only be called by the team's ChugSplashManagerProxy. This must occur
       in a single transaction to make the process atomic, which means the proxies are upgraded as a
       single unit.

     * @param _targets Array of ChugSplashTarget structs containing the targets for the deployment.
     * @param _proofs Array of Merkle proofs for the targets.
     */
    function initiateUpgrade(
        ChugSplashTarget[] memory _targets,
        bytes32[][] memory _proofs
    ) public {
   }

    /**
     * @notice Finalizes the upgrade by upgrading all proxies to their new implementations. This
     *         occurs in a single transaction to ensure that the upgrade is atomic.
     *
     * @param _targets Array of ChugSplashTarget structs containing the targets for the deployment.
     * @param _proofs Array of Merkle proofs for the targets.
     */
    function finalizeUpgrade(
        ChugSplashTarget[] memory _targets,
        bytes32[][] memory _proofs
    ) public {

    }

    /**
     * @notice Determines if a given address is allowed to propose deployments.
     *
     * @param _addr Address to check.
     *
     * @return True if the address is allowed to propose deployments, otherwise false.
     */
    function isProposer(address _addr) public view returns (bool) {
        return
            (allowManagedProposals && managedService.hasRole(MANAGED_PROPOSER_ROLE, _addr)) ||
            proposers[_addr] ||
            _addr == owner();
    }

    /**
     * @notice Returns the total debt owed to executors and the protocol creators.
     *
     * @return Total debt owed to executors and the protocol creators.
     */
    function totalDebt() public view returns (uint256) {
        return totalExecutorDebt + totalProtocolDebt;
    }

    /**
     * @notice Queries the selected executor for a given project/deployment. This will return
       address(0) if the deployment is being self-executed by the owner.
     *
     * @param _deploymentId ID of the deployment to query.
     *
     * @return Address of the selected executor.
     */
    function getSelectedExecutor(bytes32 _deploymentId) public view returns (address) {
        DeploymentState storage deployment = _deployments[_deploymentId];
        return deployment.selectedExecutor;
    }

    /**
     * @notice If the deployment is being executed remotely, this function will check that the
     * caller is the selected executor. If the deployment is being executed locally, this function
     * will check that the caller is the owner. Throws an error otherwise.

       @param _remoteExecution True if the deployment is being executed remotely, otherwise false.

     */
    function _assertCallerIsOwnerOrSelectedExecutor(bool _remoteExecution) internal view {
        if (_remoteExecution == true && getSelectedExecutor(activeDeploymentId) != _msgSender()) {
            revert CallerIsNotSelectedExecutor();
        } else if (_remoteExecution == false && owner() != _msgSender()) {
            revert CallerIsNotOwner();
        }
    }

    /**
     * @notice Use the ERC2771Recipient implementation to get the sender of the current call.
     */
    function _msgSender()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (address sender)
    {
        sender = ERC2771ContextUpgradeable._msgSender();
    }

    /**
     * @notice Use the ERC2771Recipient implementation to get the data of the current call.
     */
    function _msgData()
        internal
        view
        override(ContextUpgradeable, ERC2771ContextUpgradeable)
        returns (bytes calldata)
    {
        return ERC2771ContextUpgradeable._msgData();
    }
}
