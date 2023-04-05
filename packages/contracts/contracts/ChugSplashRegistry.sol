// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import { ChugSplashManager } from "./ChugSplashManager.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/**
 * @title ChugSplashRegistry
 * @notice The ChugSplashRegistry is the root contract for the ChugSplash deployment system. All
 *         deployments must be first registered with this contract, which allows clients to easily
 *         find and index these deployments.
 */
contract ChugSplashRegistry is Ownable, Initializable {
    /**
     * @notice Emitted whenever a new project is registered.
     *
     * @param organizationID Organization ID.
     * @param creator         Address of the creator of the project.
     * @param manager         Address of the ChugSplashManager for this project.
     * @param owner           Address of the initial owner of the project.
     */
    event ChugSplashProjectRegistered(
        bytes32 indexed organizationID,
        address indexed creator,
        address indexed manager,
        address owner
    );

    /**
     * @notice Emitted when an executor is added.
     *
     * @param executor Address of the added executor.
     */
    event ExecutorAdded(address indexed executor);

    /**
     * @notice Emitted when an executor is removed.
     *
     * @param executor Address of the removed executor.
     */
    event ExecutorRemoved(address indexed executor);

    event ManagedProposerAdded(address indexed proposer);

    event ManagedProposerRemoved(address indexed proposer);

    event ProtocolPaymentRecipientAdded(address indexed executor);

    event ProtocolPaymentRecipientRemoved(address indexed executor);

    /**
     * @notice Emitted whenever a ChugSplashManager contract wishes to announce an event on the
     *         registry. We use this to avoid needing a complex indexing system when we're trying
     *         to find events emitted by the various manager contracts.
     *
     * @param eventNameHash Hash of the name of the event being announced.
     * @param manager       Address of the ChugSplashManager announcing an event.
     * @param eventName     Name of the event being announced.
     */
    event EventAnnounced(string indexed eventNameHash, address indexed manager, string eventName);

    /**
     * @notice Emitted whenever a ChugSplashManager contract wishes to announce an event on the
     *         registry, including a field for arbitrary data. We use this to avoid needing a
     *         complex indexing system when we're trying to find events emitted by the various
     *         manager contracts.
     *
     * @param eventNameHash Hash of the name of the event being announced.
     * @param manager       Address of the ChugSplashManager announcing an event.
     * @param dataHash      Hash of the extra data.
     * @param eventName     Name of the event being announced.
     * @param data          The extra data.
     */
    event EventAnnouncedWithData(
        string indexed eventNameHash,
        address indexed manager,
        bytes indexed dataHash,
        string eventName,
        bytes data
    );

    /**
     * @notice Emitted whenever a new proxy type is added.
     *
     * @param proxyTypeHash Hash representing the proxy type.
     * @param adapter   Address of the adapter for the proxy.
     */
    event ProxyTypeAdded(bytes32 proxyTypeHash, address adapter);

    /**
     * @notice Mapping of project names to ChugSplashManager contracts.
     */
    mapping(bytes32 => ChugSplashManager) public projects;

    /**
     * @notice Mapping of created manager contracts.
     */
    mapping(ChugSplashManager => bool) public managers;

    /**
     * @notice Addresses that can execute bundles.
     */
    mapping(address => bool) public executors;

    /**
     * @notice Mapping of proxy types to adapters.
     */
    mapping(bytes32 => address) public adapters;

    mapping(address => bool) public managedProposers;

    mapping(address => bool) public protocolPaymentRecipients;

    /**
     * @notice Amount that must be deposited in the ChugSplashManager in order to execute a bundle.
     */
    uint256 public immutable ownerBondAmount;

    /**
     * @notice Amount of time for an executor to completely execute a bundle after claiming it.
     */
    uint256 public immutable executionLockTime;

    /**
     * @notice Amount that executors are paid, denominated as a percentage of the cost of execution.
     */
    uint256 public immutable executorPaymentPercentage;

    uint256 public immutable protocolPaymentPercentage;

    /**
     * @param _ownerBondAmount           Amount that must be deposited in the ChugSplashManager in
     *                                   order to execute a bundle.
     * @param _executionLockTime         Amount of time for an executor to completely execute a
     *                                   bundle after claiming it.
     * @param _executorPaymentPercentage Amount that an executor will earn from completing a bundle,
     *                                   denominated as a percentage.
     */
    constructor(
        address _owner,
        uint256 _ownerBondAmount,
        uint256 _executionLockTime,
        uint256 _executorPaymentPercentage,
        uint256 _protocolPaymentPercentage
    ) {
        ownerBondAmount = _ownerBondAmount;
        executionLockTime = _executionLockTime;
        executorPaymentPercentage = _executorPaymentPercentage;
        protocolPaymentPercentage = _protocolPaymentPercentage;

        _transferOwnership(_owner);
    }

    /**
     * @param _executors        Array of executors to add.
     */
    function initialize(address[] memory _executors) public initializer {
        for (uint i = 0; i < _executors.length; i++) {
            executors[_executors[i]] = true;
        }
    }

    /**
     * @notice Registers a new project.
     *
     * @param _organizationID ID of the new ChugSplash project.
     * @param _owner     Initial owner for the new project.
     */
    function register(address _owner, bytes32 _organizationID, bool _allowManagedProposals) public {
        require(
            address(projects[_organizationID]) == address(0),
            "ChugSplashRegistry: organization ID already registered"
        );

        // Deploy the ChugSplashManager.
        ChugSplashManager manager = new ChugSplashManager{ salt: _organizationID }(
            this,
            executionLockTime,
            ownerBondAmount,
            executorPaymentPercentage,
            protocolPaymentPercentage
        );
        manager.initialize(_owner, _organizationID, _allowManagedProposals);

        projects[_organizationID] = ChugSplashManager(payable(address(manager)));
        managers[ChugSplashManager(payable(address(manager)))] = true;

        emit ChugSplashProjectRegistered(_organizationID, msg.sender, address(manager), _owner);
    }

    /**
     * @notice Allows ChugSplashManager contracts to announce events.
     *
     * @param _event Name of the event to announce.
     */
    function announce(string memory _event) public {
        require(
            managers[ChugSplashManager(payable(msg.sender))] == true,
            "ChugSplashRegistry: events can only be announced by ChugSplashManager contracts"
        );

        emit EventAnnounced(_event, msg.sender, _event);
    }

    /**
     * @notice Allows ChugSplashManager contracts to announce events, including a field for
     *         arbitrary data.
     *
     * @param _event Name of the event to announce.
     * @param _data  Arbitrary data to include in the announced event.
     */
    function announceWithData(string memory _event, bytes memory _data) public {
        require(
            managers[ChugSplashManager(payable(msg.sender))] == true,
            "ChugSplashRegistry: events can only be announced by ChugSplashManager contracts"
        );

        emit EventAnnouncedWithData(_event, msg.sender, _data, _event, _data);
    }

    /**
     * @notice Adds a new proxy type with a corresponding adapter.
     *
     * @param _proxyTypeHash Hash representing the proxy type
     * @param _adapter   Address of the adapter for this proxy type.
     */
    function addContractKind(bytes32 _proxyTypeHash, address _adapter) external {
        require(
            adapters[_proxyTypeHash] == address(0),
            "ChugSplashRegistry: proxy type has an existing adapter"
        );

        adapters[_proxyTypeHash] = _adapter;

        emit ProxyTypeAdded(_proxyTypeHash, _adapter);
    }

    /**
     * @notice Add an executor, which can execute bundles on behalf of users. Only callable by the
     *         owner of this contract.
     *
     * @param _executor Address of the executor to add.
     */
    function addExecutor(address _executor) external onlyOwner {
        require(executors[_executor] == false, "ChugSplashRegistry: executor already added");
        executors[_executor] = true;
        emit ExecutorAdded(_executor);
    }

    /**
     * @notice Remove an executor. Only callable by the owner of this contract.
     *
     * @param _executor Address of the executor to remove.
     */
    function removeExecutor(address _executor) external onlyOwner {
        require(executors[_executor] == true, "ChugSplashRegistry: executor already removed");
        executors[_executor] = false;
        emit ExecutorRemoved(_executor);
    }

    function addManagedProposer(address _proposer) external onlyOwner {
        require(managedProposers[_proposer] == false, "ChugSplashRegistry: proposer already added");
        managedProposers[_proposer] = true;
        emit ManagedProposerAdded(_proposer);
    }

    function removeManagedProposer(address _proposer) external onlyOwner {
        require(
            managedProposers[_proposer] == true,
            "ChugSplashRegistry: proposer already removed"
        );
        managedProposers[_proposer] = false;
        emit ManagedProposerRemoved(_proposer);
    }

    function addProtocolPaymentRecipient(address _recipient) external onlyOwner {
        require(
            protocolPaymentRecipients[_recipient] == false,
            "ChugSplashRegistry: recipient already added"
        );
        protocolPaymentRecipients[_recipient] = true;
        emit ProtocolPaymentRecipientAdded(_recipient);
    }

    function removeProtocolPaymentRecipient(address _recipient) external onlyOwner {
        require(
            protocolPaymentRecipients[_recipient] == true,
            "ChugSplashRegistry: recipient already removed"
        );
        protocolPaymentRecipients[_recipient] = false;
        emit ProtocolPaymentRecipientRemoved(_recipient);
    }
}
