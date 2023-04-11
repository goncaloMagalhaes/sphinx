import * as path from 'path'
import * as fs from 'fs'

import * as semver from 'semver'
import {
  utils,
  constants,
  Signer,
  Wallet,
  Contract,
  providers,
  ethers,
  PayableOverrides,
  BigNumber,
} from 'ethers'
import { Fragment } from 'ethers/lib/utils'
import {
  ProxyArtifact,
  ChugSplashRegistryABI,
  ChugSplashManagerABI,
  ProxyABI,
  ChugSplashManagerProxyArtifact,
} from '@chugsplash/contracts'
import { TransactionRequest } from '@ethersproject/abstract-provider'
import { add0x, remove0x } from '@eth-optimism/core-utils'
import chalk from 'chalk'
import {
  ProxyDeployment,
  StorageLayout,
  UpgradeableContract,
  ValidationOptions,
  withValidationDefaults,
} from '@openzeppelin/upgrades-core'
import {
  ParsedTypeDetailed,
  StorageItem,
} from '@openzeppelin/upgrades-core/dist/storage/layout'
import {
  StorageField,
  StorageLayoutComparator,
  stripContractSubstrings,
} from '@openzeppelin/upgrades-core/dist/storage/compare'
import { CompilerInput, SolcBuild } from 'hardhat/types'
import { Compiler, NativeCompiler } from 'hardhat/internal/solidity/compiler'

import {
  CanonicalChugSplashConfig,
  CanonicalConfigArtifacts,
  ExternalContractKind,
  externalContractKinds,
  ParsedChugSplashConfig,
  ParsedContractConfig,
  ContractKind,
  UserConfigVariable,
  UserConfigVariables,
  UserContractConfig,
} from './config/types'
import { ChugSplashActionBundle, ChugSplashActionType } from './actions/types'
import {
  CHUGSPLASH_MANAGER_V1_ADDRESS,
  CHUGSPLASH_REGISTRY_ADDRESS,
  Integration,
} from './constants'
import 'core-js/features/array/at'
import { ChugSplashRuntimeEnvironment, FoundryContractArtifact } from './types'
import {
  ContractArtifact,
  BuildInfo,
  CompilerOutput,
  ArtifactPaths,
} from './languages/solidity/types'
import { chugsplashFetchSubtask } from './config/fetch'
import { getSolcBuild } from './languages'

export const computeBundleId = (
  actionRoot: string,
  targetRoot: string,
  numActions: number,
  numTargets: number,
  configUri: string
): string => {
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32', 'uint256', 'uint256', 'string'],
      [actionRoot, targetRoot, numActions, numTargets, configUri]
    )
  )
}

export const writeSnapshotId = async (
  provider: ethers.providers.JsonRpcProvider,
  networkName: string,
  deploymentFolderPath: string
) => {
  const snapshotId = await provider.send('evm_snapshot', [])
  const networkPath = path.join(deploymentFolderPath, networkName)
  if (!fs.existsSync(networkPath)) {
    fs.mkdirSync(networkPath, { recursive: true })
  }
  const snapshotIdPath = path.join(networkPath, '.snapshotId')
  fs.writeFileSync(snapshotIdPath, snapshotId)
}

export const writeDeploymentFolderForNetwork = (
  networkName: string,
  deploymentFolderPath: string
) => {
  const networkPath = path.join(deploymentFolderPath, networkName)
  if (!fs.existsSync(networkPath)) {
    fs.mkdirSync(networkPath, { recursive: true })
  }
}

export const writeDeploymentArtifact = (
  networkName: string,
  deploymentFolderPath: string,
  artifact: any,
  referenceName: string
) => {
  const artifactPath = path.join(
    deploymentFolderPath,
    networkName,
    `${referenceName}.json`
  )
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, '\t'))
}

/**
 * Returns the address of a default proxy used by ChugSplash, which is calculated as a function of
 * the organizationID and the corresponding contract's reference name. Note that a default proxy will
 * NOT be used if the user defines their own proxy address in the ChugSplash config via the `proxy`
 * attribute.
 *
 * @param organizationID ID of the organization.
 * @param referenceName Reference name of the contract that corresponds to the proxy.
 * @returns Address of the default EIP-1967 proxy used by ChugSplash.
 */
export const getDefaultProxyAddress = (
  claimer: string,
  organizationID: string,
  projectName: string,
  referenceName: string
): string => {
  const chugSplashManagerAddress = getChugSplashManagerAddress(
    claimer,
    organizationID
  )

  const salt = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['string', 'string'],
      [projectName, referenceName]
    )
  )

  return utils.getCreate2Address(
    chugSplashManagerAddress,
    salt,
    utils.solidityKeccak256(
      ['bytes', 'bytes'],
      [
        ProxyArtifact.bytecode,
        utils.defaultAbiCoder.encode(['address'], [chugSplashManagerAddress]),
      ]
    )
  )
}

export const checkIsUpgrade = async (
  provider: ethers.providers.Provider,
  parsedConfig: ParsedChugSplashConfig
): Promise<boolean | string> => {
  for (const [referenceName, contractConfig] of Object.entries(
    parsedConfig.contracts
  )) {
    if (await isContractDeployed(contractConfig.proxy, provider)) {
      return referenceName
    }
  }
  return false
}

export const getChugSplashManagerAddress = (
  claimer: string,
  organizationID: string
) => {
  const salt = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['address', 'bytes32'],
      [claimer, organizationID]
    )
  )

  return utils.getCreate2Address(
    CHUGSPLASH_REGISTRY_ADDRESS,
    salt,
    utils.solidityKeccak256(
      ['bytes', 'bytes'],
      [
        ChugSplashManagerProxyArtifact.bytecode,
        utils.defaultAbiCoder.encode(
          ['address', 'address'],
          [CHUGSPLASH_REGISTRY_ADDRESS, CHUGSPLASH_REGISTRY_ADDRESS]
        ),
      ]
    )
  )
}

/**
 * Claims a new ChugSplash project.
 *
 * @param Provider Provider corresponding to the signer that will execute the transaction.
 * @param organizationID ID of the organization.
 * @param newOwnerAddress Owner of the ChugSplashManager contract deployed by this call.
 * @returns True if the project was claimed for the first time in this call, and false if the
 * project was already claimed by the caller.
 */
export const claimChugSplashProject = async (
  provider: providers.JsonRpcProvider,
  claimer: Signer,
  organizationID: string,
  newOwnerAddress: string,
  allowManagedProposals: boolean
): Promise<boolean> => {
  const ChugSplashRegistry = getChugSplashRegistry(claimer)
  const claimerAddress = await claimer.getAddress()

  if (
    (await ChugSplashRegistry.projects(claimerAddress, organizationID)) ===
    constants.AddressZero
  ) {
    // Encode the initialization arguments for the ChugSplashManager contract.
    // Note: Future versions of ChugSplash may require different arguments encoded in this way.
    const initializerData = ethers.utils.defaultAbiCoder.encode(
      ['address', 'bytes32', 'bool'],
      [newOwnerAddress, organizationID, allowManagedProposals]
    )

    await (
      await ChugSplashRegistry.claim(
        organizationID,
        newOwnerAddress,
        CHUGSPLASH_MANAGER_V1_ADDRESS,
        initializerData,
        await getGasPriceOverrides(provider)
      )
    ).wait()
    return true
  } else {
    const existingOwnerAddress = await getProjectOwnerAddress(
      getChugSplashManager(provider, claimerAddress, organizationID)
    )
    if (existingOwnerAddress !== newOwnerAddress) {
      throw new Error(`Project already owned by: ${existingOwnerAddress}.`)
    } else {
      return false
    }
  }
}

export const getProjectOwnerAddress = async (
  ChugSplashManager: ethers.Contract
): Promise<string> => {
  const ownershipTransferredEvents = await ChugSplashManager.queryFilter(
    ChugSplashManager.filters.OwnershipTransferred()
  )

  const latestEvent = ownershipTransferredEvents.at(-1)

  if (latestEvent === undefined) {
    throw new Error(`Could not find OwnershipTransferred event.`)
  } else if (latestEvent.args === undefined) {
    throw new Error(`No args found for OwnershipTransferred event.`)
  }

  // Get the most recent owner from the list of events
  const projectOwner = latestEvent.args.newOwner

  return projectOwner
}

export const getChugSplashRegistry = (
  signerOrProvider: Signer | providers.Provider
): Contract => {
  return new Contract(
    // CHUGSPLASH_REGISTRY_ADDRESS,
    CHUGSPLASH_REGISTRY_ADDRESS,
    ChugSplashRegistryABI,
    signerOrProvider
  )
}

export const getChugSplashManager = (
  signerOrProvider: Signer | providers.Provider,
  claimer: string,
  organizationID: string
) => {
  return new Contract(
    getChugSplashManagerAddress(claimer, organizationID),
    ChugSplashManagerABI,
    signerOrProvider
  )
}

export const chugsplashLog = (
  logLevel: 'warning' | 'error' = 'warning',
  title: string,
  lines: string[],
  silent: boolean,
  stream: NodeJS.WritableStream
): void => {
  if (silent) {
    return
  }

  const prefix = logLevel.charAt(0).toUpperCase() + logLevel.slice(1)

  const chalkColor = logLevel === 'warning' ? chalk.yellow : chalk.red

  const parts = ['\n' + chalkColor.bold(prefix + ':') + ' ' + title]

  if (lines.length > 0) {
    parts.push(lines.map((l) => l + '\n').join(''))
  }

  stream.write(parts.join('\n') + '\n')
}

export const displayProposerTable = (proposerAddresses: string[]) => {
  const proposers = {}
  proposerAddresses.forEach((address, i) => {
    proposers[i + 1] = {
      Address: address,
    }
  })
  console.table(proposers)
}

export const displayDeploymentTable = (
  parsedConfig: ParsedChugSplashConfig,
  artifactPaths: ArtifactPaths,
  integration: Integration,
  silent: boolean
) => {
  const managerAddress = getChugSplashManagerAddress(
    parsedConfig.options.claimer,
    parsedConfig.options.organizationID
  )
  if (!silent) {
    const deployments = {}
    Object.entries(parsedConfig.contracts).forEach(
      ([referenceName, contractConfig], i) => {
        // if contract is an unproxied, then we must resolve it's true address
        const address =
          contractConfig.kind !== 'no-proxy'
            ? contractConfig.proxy
            : getContractAddress(
                managerAddress,
                referenceName,
                parsedConfig.contracts[referenceName].constructorArgs,
                { integration, artifactPaths }
              )

        const contractName = contractConfig.contract.includes(':')
          ? contractConfig.contract.split(':').at(-1)
          : contractConfig.contract
        deployments[i + 1] = {
          'Reference Name': referenceName,
          Contract: contractName,
          Address: address,
        }
      }
    )
    console.table(deployments)
  }
}

export const generateFoundryTestArtifacts = (
  parsedConfig: ParsedChugSplashConfig
): FoundryContractArtifact[] => {
  const artifacts: {
    referenceName: string
    contractName: string
    contractAddress: string
  }[] = []
  Object.entries(parsedConfig.contracts).forEach(
    ([referenceName, contractConfig], i) =>
      (artifacts[i] = {
        referenceName,
        contractName: contractConfig.contract.split(':')[1],
        contractAddress: contractConfig.proxy,
      })
  )
  return artifacts
}

export const claimExecutorPayment = async (
  executor: Wallet,
  ChugSplashManager: Contract
) => {
  const executorDebt = await ChugSplashManager.executorDebt(executor.address)
  if (executorDebt.gt(0)) {
    await (
      await ChugSplashManager.claimExecutorPayment(
        await getGasPriceOverrides(executor.provider)
      )
    ).wait()
  }
}

export const getProxyAt = (signer: Signer, proxyAddress: string): Contract => {
  return new Contract(proxyAddress, ProxyABI, signer)
}

export const getCurrentChugSplashActionType = (
  bundle: ChugSplashActionBundle,
  actionsExecuted: ethers.BigNumber
): ChugSplashActionType => {
  return bundle.actions[actionsExecuted.toNumber()].action.actionType
}

export const isContractDeployed = async (
  address: string,
  provider: providers.Provider
): Promise<boolean> => {
  return (await provider.getCode(address)) !== '0x'
}

export const formatEther = (
  amount: ethers.BigNumber,
  decimals: number
): string => {
  return parseFloat(ethers.utils.formatEther(amount)).toFixed(decimals)
}

export const readCanonicalConfig = async (
  provider: providers.Provider,
  canonicalConfigFolderPath: string,
  configUri: string
): Promise<CanonicalChugSplashConfig> => {
  const ipfsHash = configUri.replace('ipfs://', '')

  const network = await provider.getNetwork()

  // Check that the file containing the canonical config exists.
  const configFilePath = path.join(
    canonicalConfigFolderPath,
    network.name,
    `${ipfsHash}.json`
  )
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`Could not find local canonical config file at:
${configFilePath}`)
  }

  return JSON.parse(fs.readFileSync(configFilePath, 'utf8'))
}

export const writeCanonicalConfig = async (
  provider: providers.Provider,
  canonicalConfigFolderPath: string,
  configUri: string,
  canonicalConfig: CanonicalChugSplashConfig
) => {
  const ipfsHash = configUri.replace('ipfs://', '')

  const network = await provider.getNetwork()

  const networkFolderPath = path.join(canonicalConfigFolderPath, network.name)

  // Create the canonical config network folder if it doesn't already exist.
  if (!fs.existsSync(networkFolderPath)) {
    fs.mkdirSync(networkFolderPath, { recursive: true })
  }

  // Write the canonical config to the local file system. It will exist in a JSON file that has the
  // config URI as its name.
  fs.writeFileSync(
    path.join(networkFolderPath, `${ipfsHash}.json`),
    JSON.stringify(canonicalConfig, null, 2)
  )
}

export const getEIP1967ProxyImplementationAddress = async (
  provider: providers.Provider,
  proxyAddress: string
): Promise<string> => {
  // keccak256('eip1967.proxy.implementation')) - 1
  // See: https://eips.ethereum.org/EIPS/eip-1967#specification
  const implStorageKey =
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

  const encodedImplAddress = await provider.getStorageAt(
    proxyAddress,
    implStorageKey
  )
  const [decoded] = ethers.utils.defaultAbiCoder.decode(
    ['address'],
    encodedImplAddress
  )
  return decoded
}

export const getEIP1967ProxyAdminAddress = async (
  provider: providers.Provider,
  proxyAddress: string
): Promise<string> => {
  // See: https://eips.ethereum.org/EIPS/eip-1967#specification
  const ownerStorageKey =
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

  const [ownerAddress] = ethers.utils.defaultAbiCoder.decode(
    ['address'],
    await provider.getStorageAt(proxyAddress, ownerStorageKey)
  )
  return ownerAddress
}

/**
 * Overrides an object's gas price settings to support EIP-1559 transactions if EIP-1559 is
 * supported by the network. This only overrides the default behavior on Goerli, where transactions
 * sent via Alchemy or Infura do not yet support EIP-1559 gas pricing, despite the fact that
 * `maxFeePerGas` and `maxPriorityFeePerGas` are defined.
 *
 * @param provider Provider object.
 * @param overridden The object whose gas price settings will be overridden.
 * @returns The object whose gas price settings will be overridden.
 */
export const getGasPriceOverrides = async (
  provider: ethers.providers.Provider,
  overridden: PayableOverrides | TransactionRequest = {}
): Promise<PayableOverrides | TransactionRequest> => {
  const { maxFeePerGas, maxPriorityFeePerGas } = await provider.getFeeData()

  if (
    BigNumber.isBigNumber(maxFeePerGas) &&
    BigNumber.isBigNumber(maxPriorityFeePerGas)
  ) {
    overridden.maxFeePerGas = maxFeePerGas
    overridden.maxPriorityFeePerGas = maxPriorityFeePerGas
  }

  return overridden
}

export const isProjectClaimed = async (
  signerOrProvider: Signer | providers.Provider,
  managerAddress: string
) => {
  const ChugSplashRegistry = new ethers.Contract(
    CHUGSPLASH_REGISTRY_ADDRESS,
    ChugSplashRegistryABI,
    signerOrProvider
  )
  const isClaimed: boolean = await ChugSplashRegistry.managers(managerAddress)
  return isClaimed
}

export const isInternalDefaultProxy = async (
  provider: providers.Provider,
  proxyAddress: string
): Promise<boolean> => {
  const ChugSplashRegistry = new Contract(
    CHUGSPLASH_REGISTRY_ADDRESS,
    ChugSplashRegistryABI,
    provider
  )

  const actionExecutedEvents = await ChugSplashRegistry.queryFilter(
    ChugSplashRegistry.filters.EventAnnouncedWithData(
      'DefaultProxyDeployed',
      null,
      proxyAddress
    )
  )

  return actionExecutedEvents.length === 1
}

/**
 * Since both UUPS and Transparent proxies use the same interface we use a helper function to check that. This wrapper is intended to
 * keep the code clear by providing separate functions for checking UUPS and Transparent proxies.
 *
 * @param provider JSON RPC provider corresponding to the current project owner.
 * @param contractAddress Address of the contract to check the interface of
 * @returns
 */
export const isTransparentProxy = async (
  provider: providers.Provider,
  proxyAddress: string
): Promise<boolean> => {
  // We don't consider default proxies to be transparent proxies, even though they share the same
  // interface.
  if ((await isInternalDefaultProxy(provider, proxyAddress)) === true) {
    return false
  }

  // Check if the contract bytecode contains the expected interface
  const bytecode = await provider.getCode(proxyAddress)
  if (!(await bytecodeContainsEIP1967Interface(bytecode))) {
    return false
  }

  // Fetch proxy owner address from storage slot defined by EIP-1967
  const ownerAddress = await getEIP1967ProxyAdminAddress(provider, proxyAddress)

  // If proxy owner is not a valid address, then proxy type is incompatible
  if (!ethers.utils.isAddress(ownerAddress)) {
    return false
  }

  return true
}

/**
 * Checks if the passed in proxy contract points to an implementation address which implements the minimum requirements to be
 * a ChugSplash compatible UUPS proxy.
 *
 * @param provider JSON RPC provider corresponding to the current project owner.
 * @param proxyAddress Address of the proxy contract. Since this is a UUPS proxy, we check the interface of the implementation function.
 * @returns
 */
export const isUUPSProxy = async (
  provider: providers.Provider,
  proxyAddress: string
): Promise<boolean> => {
  const implementationAddress = await getEIP1967ProxyImplementationAddress(
    provider,
    proxyAddress
  )

  // Check if the contract bytecode contains the expected interface
  const bytecode = await provider.getCode(implementationAddress)
  if (!(await bytecodeContainsUUPSInterface(bytecode))) {
    return false
  }

  // Fetch proxy owner address from storage slot defined by EIP-1967
  const ownerAddress = await getEIP1967ProxyAdminAddress(
    provider,
    implementationAddress
  )

  // If proxy owner is not a valid address, then proxy type is incompatible
  if (!ethers.utils.isAddress(ownerAddress)) {
    return false
  }

  return true
}

const bytecodeContainsUUPSInterface = async (
  bytecode: string
): Promise<boolean> => {
  return bytecodeContainsInterface(bytecode, ['upgradeTo'])
}

const bytecodeContainsEIP1967Interface = async (
  bytecode: string
): Promise<boolean> => {
  return bytecodeContainsInterface(bytecode, [
    'implementation',
    'admin',
    'upgradeTo',
    'changeAdmin',
  ])
}

/**
 * @param bytecode The bytecode of the contract to check the interface of.
 * @returns True if the contract contains the expected interface and false if not.
 */
const bytecodeContainsInterface = async (
  bytecode: string,
  checkFunctions: string[]
): Promise<boolean> => {
  // Fetch proxy bytecode and check if it contains the expected EIP-1967 function definitions
  const iface = new ethers.utils.Interface(ProxyABI)
  for (const func of checkFunctions) {
    const sigHash = remove0x(iface.getSighash(func))
    if (!bytecode.includes(sigHash)) {
      return false
    }
  }
  return true
}

export const isExternalContractKind = (
  contractKind: string
): contractKind is ExternalContractKind => {
  return externalContractKinds.includes(contractKind)
}

/**
 * Retrieves an artifact by name from the local file system.
 */
export const readContractArtifact = (
  contractArtifactPath: string,
  integration: Integration
): ContractArtifact => {
  const artifact: ContractArtifact = JSON.parse(
    fs.readFileSync(contractArtifactPath, 'utf8')
  )

  if (integration === 'hardhat') {
    return artifact
  } else if (integration === 'foundry') {
    return parseFoundryArtifact(artifact)
  } else {
    throw new Error('Unknown integration')
  }
}

/**
 * Reads the build info from the local file system.
 *
 * @param buildInfoPath Path to the build info file.
 * @returns BuildInfo object.
 */
export const readBuildInfo = (buildInfoPath: string): BuildInfo => {
  const buildInfo: BuildInfo = JSON.parse(
    fs.readFileSync(buildInfoPath, 'utf8')
  )

  if (!semver.satisfies(buildInfo.solcVersion, '>0.5.x <0.9.x')) {
    throw new Error(
      `Storage layout for Solidity version ${buildInfo.solcVersion} not yet supported. Sorry!`
    )
  }

  if (
    !buildInfo.input.settings.outputSelection['*']['*'].includes(
      'storageLayout'
    )
  ) {
    throw new Error(
      `Storage layout not found. Did you forget to set the "storageLayout" compiler option in your\n` +
        `Hardhat/Foundry config file?\n\n` +
        `If you're using Hardhat, see how to configure your project here:\n` +
        `https://github.com/chugsplash/chugsplash/blob/develop/docs/hardhat/setup-project.md#setup-chugsplash-using-typescript\n\n` +
        `If you're using Foundry, see how to configure your project here:\n` +
        `https://github.com/chugsplash/chugsplash/blob/develop/docs/foundry/getting-started.md#3-configure-your-foundrytoml-file`
    )
  }

  return buildInfo
}

/**
 * Retrieves artifact info from foundry artifacts and returns it in hardhat compatible format.
 *
 * @param artifact Raw artifact object.
 * @returns ContractArtifact
 */
export const parseFoundryArtifact = (artifact: any): ContractArtifact => {
  const abi = artifact.abi
  const bytecode = artifact.bytecode.object

  const compilationTarget = artifact.metadata.settings.compilationTarget
  const sourceName = Object.keys(compilationTarget)[0]
  const contractName = compilationTarget[sourceName]

  return { abi, bytecode, sourceName, contractName }
}

export const isEqualType = (
  prevStorageObj: StorageItem<ParsedTypeDetailed>,
  newStorageObj: StorageItem<ParsedTypeDetailed>
): boolean => {
  // Copied from OpenZeppelin's core upgrades package:
  // https://github.com/OpenZeppelin/openzeppelin-upgrades/blob/13c072776e381d33cf285f8953127023b664de64/packages/core/src/storage/compare.ts#L197-L202
  const isRetypedFromOriginal = (
    original: StorageField,
    updated: StorageField
  ): boolean => {
    const originalLabel = stripContractSubstrings(original.type.item.label)
    const updatedLabel = stripContractSubstrings(updated.retypedFrom?.trim())

    return originalLabel === updatedLabel
  }

  const layoutComparator = new StorageLayoutComparator(false, false)

  // Copied from OpenZeppelin's core upgrades package:
  // https://github.com/OpenZeppelin/openzeppelin-upgrades/blob/13c072776e381d33cf285f8953127023b664de64/packages/core/src/storage/compare.ts#L171-L173
  const isEqual =
    !isRetypedFromOriginal(prevStorageObj, newStorageObj) &&
    !layoutComparator.getTypeChange(prevStorageObj.type, newStorageObj.type, {
      allowAppend: false,
    })

  return isEqual
}

/**
 * Returns the Create2 address of a contract deployed by ChugSplash, which is calculated as a
 * function of the organizationID and the corresponding contract's reference name. Note that the
 * contract may not yet be deployed at this address since it's calculated via Create2.
 *
 * @param organizationID ID of the organization.
 * @param referenceName Reference name of the contract that corresponds to the proxy.
 * @param constructorArgs Constructor arguments for the contract.
 * @param maybeArtifact Contract artifact, or an object containing the artifactPaths and the
 * integration so the artifact can be resolved.
 * @returns Address of the contract.
 */
export const getContractAddress = (
  managerAddress: string,
  referenceName: string,
  constructorArgs: UserConfigVariables,
  maybeArtifact:
    | ContractArtifact
    | {
        integration: Integration
        artifactPaths: ArtifactPaths
      }
): string => {
  // Resolve the artifact either from the maybeArtifcat object itself, or from the artifactPaths
  const { abi, bytecode } =
    'abi' in maybeArtifact
      ? maybeArtifact
      : readContractArtifact(
          maybeArtifact.artifactPaths[referenceName].contractArtifactPath,
          maybeArtifact.integration
        )

  const creationCodeWithConstructorArgs = getCreationCodeWithConstructorArgs(
    bytecode,
    constructorArgs ?? {},
    referenceName,
    abi
  )

  return utils.getCreate2Address(
    managerAddress,
    ethers.constants.HashZero,
    utils.solidityKeccak256(['bytes'], [creationCodeWithConstructorArgs])
  )
}

export const getConstructorArgs = (
  constructorArgs: UserConfigVariables,
  referenceName: string,
  abi: Array<Fragment>
): {
  constructorArgTypes: Array<string>
  constructorArgValues: UserConfigVariable[]
} => {
  const constructorArgTypes: Array<string> = []
  const constructorArgValues: Array<UserConfigVariable> = []

  const constructorFragment = abi.find(
    (fragment) => fragment.type === 'constructor'
  )

  if (constructorFragment === undefined) {
    return { constructorArgTypes, constructorArgValues }
  }

  constructorFragment.inputs.forEach((input) => {
    const constructorArgValue = constructorArgs[input.name]
    constructorArgTypes.push(input.type)
    constructorArgValues.push(constructorArgValue)
  })

  return { constructorArgTypes, constructorArgValues }
}

export const getCreationCodeWithConstructorArgs = (
  bytecode: string,
  constructorArgs: UserConfigVariables,
  referenceName: string,
  abi: any
): string => {
  const { constructorArgTypes, constructorArgValues } = getConstructorArgs(
    constructorArgs,
    referenceName,
    abi
  )

  const creationCodeWithConstructorArgs = bytecode.concat(
    remove0x(
      utils.defaultAbiCoder.encode(constructorArgTypes, constructorArgValues)
    )
  )

  return creationCodeWithConstructorArgs
}

/**
 *
 * @param promise A promise to wrap in a timeout
 * @param timeLimit The amount of time to wait for the promise to resolve
 * @returns The result of the promise, or an error due to the timeout being reached
 */
export const callWithTimeout = async <T>(
  promise: Promise<T>,
  timeout: number,
  errorMessage: string
): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(errorMessage)), timeout)
  })

  return Promise.race([promise, timeoutPromise]).then((result) => {
    clearTimeout(timeoutHandle)
    return result
  })
}

export const toOpenZeppelinContractKind = (
  contractKind: ContractKind
): ProxyDeployment['kind'] => {
  if (
    contractKind === 'internal-default' ||
    contractKind === 'external-default' ||
    contractKind === 'oz-transparent'
  ) {
    return 'transparent'
  } else if (
    contractKind === 'oz-ownable-uups' ||
    contractKind === 'oz-access-control-uups'
  ) {
    return 'uups'
  } else {
    throw new Error(
      `Attempted to convert "${contractKind}" to an OpenZeppelin proxy type`
    )
  }
}

export const getOpenZeppelinValidationOpts = (
  contractKind: ContractKind,
  contractConfig: UserContractConfig
): Required<ValidationOptions> => {
  type UnsafeAllow = Required<ValidationOptions>['unsafeAllow']

  const unsafeAllow: UnsafeAllow = [
    'state-variable-assignment',
    'constructor',
    'state-variable-immutable',
  ]
  if (contractConfig.unsafeAllow?.delegatecall) {
    unsafeAllow.push('delegatecall')
  }
  if (contractConfig.unsafeAllow?.selfdestruct) {
    unsafeAllow.push('selfdestruct')
  }
  if (contractConfig.unsafeAllow?.missingPublicUpgradeTo) {
    unsafeAllow.push('missing-public-upgradeto')
  }

  const options = {
    kind: toOpenZeppelinContractKind(contractKind),
    unsafeAllow,
    unsafeAllowRenames: contractConfig.unsafeAllowRenames,
    unsafeSkipStorageCheck: contractConfig.unsafeSkipStorageCheck,
  }

  return withValidationDefaults(options)
}

export const getOpenZeppelinUpgradableContract = (
  fullyQualifiedName: string,
  compilerInput: CompilerInput,
  compilerOutput: CompilerOutput,
  contractKind: ContractKind,
  contractConfig: UserContractConfig
): UpgradeableContract => {
  const options = getOpenZeppelinValidationOpts(contractKind, contractConfig)

  const contract = new UpgradeableContract(
    fullyQualifiedName,
    compilerInput,
    // Without converting the `compilerOutput` type to `any`, OpenZeppelin throws an error due
    // to the `SolidityStorageLayout` type that we've added to Hardhat's `CompilerOutput` type.
    // Converting this type to `any` shouldn't impact anything since we use Hardhat's default
    // `CompilerOutput`, which is what OpenZeppelin expects.
    compilerOutput as any,
    options
  )

  return contract
}

/**
 * Get the most recent storage layout for the given reference name. Uses OpenZeppelin's
 * StorageLayout format for consistency.
 *
 * When retrieving the storage layout, this function uses the following order of priority (from
 * highest to lowest):
 * 1. The 'previousBuildInfo' and 'previousFullyQualifiedName' fields if both have been declared by
 * the user.
 * 2. The latest deployment in the ChugSplash system for the proxy address that corresponds to the
 * reference name.
 * 3. OpenZeppelin's Network File if the proxy is an OpenZeppelin proxy type
 *
 * If (1) and (2) above are both satisfied, we log a warning to the user and default to using the
 * storage layout located at 'previousBuildInfo'.
 */
export const getPreviousStorageLayoutOZFormat = async (
  provider: providers.Provider,
  referenceName: string,
  parsedContractConfig: ParsedContractConfig,
  userContractConfig: UserContractConfig,
  remoteExecution: boolean,
  canonicalConfigFolderPath: string,
  cre: ChugSplashRuntimeEnvironment
): Promise<StorageLayout> => {
  if ((await provider.getCode(parsedContractConfig.proxy)) === '0x') {
    throw new Error(
      `Proxy has not been deployed for the contract: ${referenceName}.`
    )
  }

  const previousCanonicalConfig = await getPreviousCanonicalConfig(
    provider,
    parsedContractConfig.proxy,
    remoteExecution,
    canonicalConfigFolderPath
  )

  if (
    userContractConfig.previousFullyQualifiedName !== undefined &&
    userContractConfig.previousBuildInfo !== undefined
  ) {
    const { input, output } = readBuildInfo(
      userContractConfig.previousBuildInfo
    )

    if (previousCanonicalConfig !== undefined) {
      console.warn(
        '\x1b[33m%s\x1b[0m', // Display message in yellow
        `\nUsing the "previousBuildInfo" and "previousFullyQualifiedName" field to get the storage layout for\n` +
          `the contract: ${referenceName}. If you'd like to use the storage layout from your most recent\n` +
          `ChugSplash deployment instead, please remove these two fields from your ChugSplash config file.`
      )
    }

    return getOpenZeppelinUpgradableContract(
      userContractConfig.previousFullyQualifiedName,
      input,
      output,
      parsedContractConfig.kind,
      userContractConfig
    ).layout
  } else if (previousCanonicalConfig !== undefined) {
    const prevCanonicalConfigArtifacts = await getCanonicalConfigArtifacts(
      previousCanonicalConfig
    )
    const { sourceName, contractName, compilerInput, compilerOutput } =
      prevCanonicalConfigArtifacts[referenceName]
    return getOpenZeppelinUpgradableContract(
      `${sourceName}:${contractName}`,
      compilerInput,
      compilerOutput,
      parsedContractConfig.kind,
      userContractConfig
    ).layout
  } else if (cre.hre !== undefined) {
    const openzeppelinStorageLayout = await cre.importOpenZeppelinStorageLayout(
      cre.hre,
      parsedContractConfig
    )
    if (!openzeppelinStorageLayout) {
      throw new Error(
        'Should not attempt to import OpenZeppelin storage layout for non-OpenZeppelin proxy type. Please report this to the developers.'
      )
    }

    return openzeppelinStorageLayout
  } else {
    throw new Error(
      `Could not find the previous storage layout for the contract: ${referenceName}. Please include\n` +
        `a "previousBuildInfo" and "previousFullyQualifiedName" field for this contract in your ChugSplash config file.`
    )
  }
}

export const getPreviousCanonicalConfig = async (
  provider: providers.Provider,
  proxyAddress: string,
  remoteExecution: boolean,
  canonicalConfigFolderPath: string
): Promise<CanonicalChugSplashConfig | undefined> => {
  const ChugSplashRegistry = new Contract(
    CHUGSPLASH_REGISTRY_ADDRESS,
    ChugSplashRegistryABI,
    provider
  )

  const actionExecutedEvents = await ChugSplashRegistry.queryFilter(
    ChugSplashRegistry.filters.EventAnnouncedWithData(
      'ChugSplashActionExecuted',
      null,
      proxyAddress
    )
  )

  if (actionExecutedEvents.length === 0) {
    return undefined
  }

  const latestRegistryEvent = actionExecutedEvents.at(-1)

  if (latestRegistryEvent === undefined) {
    return undefined
  } else if (latestRegistryEvent.args === undefined) {
    throw new Error(`ChugSplashActionExecuted event has no args.`)
  }

  const ChugSplashManager = new Contract(
    latestRegistryEvent.args.manager,
    ChugSplashManagerABI,
    provider
  )

  const latestExecutionEvent = (
    await ChugSplashManager.queryFilter(
      ChugSplashManager.filters.ChugSplashActionExecuted(null, proxyAddress)
    )
  ).at(-1)

  if (latestExecutionEvent === undefined) {
    throw new Error(
      `ChugSplashActionExecuted event detected in registry but not in manager contract`
    )
  } else if (latestExecutionEvent.args === undefined) {
    throw new Error(`ChugSplashActionExecuted event has no args.`)
  }

  const latestProposalEvent = (
    await ChugSplashManager.queryFilter(
      ChugSplashManager.filters.ChugSplashBundleProposed(
        latestExecutionEvent.args.bundleId
      )
    )
  ).at(-1)

  if (latestProposalEvent === undefined) {
    throw new Error(
      `ChugSplashManager emitted a ChugSplashActionExecuted event but not a ChugSplashBundleProposed event`
    )
  } else if (latestProposalEvent.args === undefined) {
    throw new Error(`ChugSplashBundleProposed event does not have args`)
  }

  if (remoteExecution) {
    return callWithTimeout<CanonicalChugSplashConfig>(
      chugsplashFetchSubtask({ configUri: latestProposalEvent.args.configUri }),
      30000,
      'Failed to fetch config file from IPFS'
    )
  } else {
    return readCanonicalConfig(
      provider,
      canonicalConfigFolderPath,
      latestProposalEvent.args.configUri
    )
  }
}

export const getCanonicalConfigArtifacts = async (
  canonicalConfig: CanonicalChugSplashConfig
): Promise<CanonicalConfigArtifacts> => {
  const solcArray: {
    compilerInput: CompilerInput
    compilerOutput: CompilerOutput
  }[] = []
  // Get the compiler output for each compiler input.
  for (const chugsplashInput of canonicalConfig.inputs) {
    const solcBuild: SolcBuild = await getSolcBuild(chugsplashInput.solcVersion)
    let compilerOutput: CompilerOutput
    if (solcBuild.isSolcJs) {
      const compiler = new Compiler(solcBuild.compilerPath)
      compilerOutput = await compiler.compile(chugsplashInput.input)
    } else {
      const compiler = new NativeCompiler(solcBuild.compilerPath)
      compilerOutput = await compiler.compile(chugsplashInput.input)
    }

    if (compilerOutput.errors) {
      const formattedErrorMessages: string[] = []
      compilerOutput.errors.forEach((error) => {
        // Ignore warnings thrown by the compiler.
        if (error.type.toLowerCase() !== 'warning') {
          formattedErrorMessages.push(error.formattedMessage)
        }
      })

      if (formattedErrorMessages.length > 0) {
        throw new Error(
          `Failed to compile. Please report this error to ChugSplash.\n` +
            `${formattedErrorMessages}`
        )
      }
    }

    solcArray.push({
      compilerInput: chugsplashInput.input,
      compilerOutput,
    })
  }

  const artifacts: CanonicalConfigArtifacts = {}
  // Generate an artifact for each contract in the ChugSplash config.
  for (const [referenceName, contractConfig] of Object.entries(
    canonicalConfig.contracts
  )) {
    // Split the contract's fully qualified name into its source name and contract name.
    const [sourceName, contractName] = contractConfig.contract.split(':')

    for (const { compilerInput, compilerOutput } of solcArray) {
      const contractOutput =
        compilerOutput.contracts?.[sourceName]?.[contractName]

      if (contractOutput !== undefined) {
        const creationCodeWithConstructorArgs =
          getCreationCodeWithConstructorArgs(
            add0x(contractOutput.evm.bytecode.object),
            contractConfig.constructorArgs,
            referenceName,
            contractOutput.abi
          )

        artifacts[referenceName] = {
          creationCodeWithConstructorArgs,
          abi: contractOutput.abi,
          compilerInput,
          compilerOutput,
          sourceName,
          contractName,
          bytecode: add0x(contractOutput.evm.bytecode.object),
        }
      }
    }
  }
  return artifacts
}

export const getDeploymentEvents = async (
  ChugSplashManager: ethers.Contract,
  bundleId: string
): Promise<ethers.Event[]> => {
  const [approvalEvent] = await ChugSplashManager.queryFilter(
    ChugSplashManager.filters.ChugSplashBundleApproved(bundleId)
  )
  const [completedEvent] = await ChugSplashManager.queryFilter(
    ChugSplashManager.filters.ChugSplashBundleCompleted(bundleId)
  )

  const proxyDeployedEvents = await ChugSplashManager.queryFilter(
    ChugSplashManager.filters.DefaultProxyDeployed(null, null, bundleId),
    approvalEvent.blockNumber,
    completedEvent.blockNumber
  )

  const contractDeployedEvents = await ChugSplashManager.queryFilter(
    ChugSplashManager.filters.ContractDeployed(null, null, bundleId),
    approvalEvent.blockNumber,
    completedEvent.blockNumber
  )

  return proxyDeployedEvents.concat(contractDeployedEvents)
}

export const getChainId = async (
  provider: ethers.providers.Provider
): Promise<number> => {
  const network = await provider.getNetwork()
  return network.chainId
}
