import { ethers } from 'ethers'

import {
  ProxyArtifact,
  DefaultAdapterArtifact,
  ChugSplashBootLoaderArtifact,
  ChugSplashRegistryArtifact,
  ChugSplashManagerArtifact,
  ChugSplashManagerProxyArtifact,
  ChugSplashManagerABI,
  ProxyABI,
  ProxyInitializerArtifact,
  ProxyInitializerABI,
  OZUUPSAdapterArtifact,
  DefaultUpdaterArtifact,
  OZUUPSUpdaterArtifact,
  OZTransparentAdapterArtifact,
} from './ifaces'

export const OWNER_MULTISIG_ADDRESS =
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
export const EXECUTOR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

export const CHUGSPLASH_PROXY_ADMIN_ADDRESS_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes('chugsplash.proxy.admin')
)

export const EXTERNAL_DEFAULT_PROXY_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes('external-default')
)
export const OZ_TRANSPARENT_PROXY_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes('oz-transparent')
)
export const OZ_UUPS_PROXY_TYPE_HASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes('oz-uups')
)

export const CHUGSPLASH_SALT = '0x' + '12'.repeat(32)

const chugsplashRegistrySourceName = ChugSplashRegistryArtifact.sourceName
const chugsplashBootLoaderSourceName = ChugSplashBootLoaderArtifact.sourceName
const chugsplashManagerProxySourceName =
  ChugSplashManagerProxyArtifact.sourceName
const chugsplashManagerSourceName = ChugSplashManagerArtifact.sourceName
const chugsplashRegistyProxySourceName = ProxyArtifact.sourceName
const proxyInitializerSourceName = ProxyInitializerArtifact.sourceName
const defaultAdapterSourceName = DefaultAdapterArtifact.sourceName
const OZUUPSAdapterSourceName = OZUUPSAdapterArtifact.sourceName
const defaultUpdaterSourceName = DefaultUpdaterArtifact.sourceName
const OZUUPSUpdaterSourceName = OZUUPSUpdaterArtifact.sourceName
const OZTransparentAdapterSourceName = OZTransparentAdapterArtifact.sourceName

const [proxyInitializerConstructorFragment] = ProxyInitializerABI.filter(
  (fragment) => fragment.type === 'constructor'
)
const proxyInitializerConstructorArgTypes =
  proxyInitializerConstructorFragment.inputs.map((input) => input.type)
const proxyInitializerConstructorArgValues = [
  OWNER_MULTISIG_ADDRESS,
  CHUGSPLASH_SALT,
]

const [chugsplashManagerConstructorFragment] = ChugSplashManagerABI.filter(
  (fragment) => fragment.type === 'constructor'
)
const chugsplashManagerConstructorArgTypes =
  chugsplashManagerConstructorFragment.inputs.map((input) => input.type)

export const DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS =
  '0x4e59b44847b379578588920ca78fbf26c0b4956c'
export const OWNER_BOND_AMOUNT = ethers.utils.parseEther('0.001')
export const EXECUTION_LOCK_TIME = 15 * 60
export const EXECUTOR_PAYMENT_PERCENTAGE = 20

export const CHUGSPLASH_BOOTLOADER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes'],
    [ChugSplashBootLoaderArtifact.bytecode]
  )
)

export const DEFAULT_UPDATER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(['bytes'], [DefaultUpdaterArtifact.bytecode])
)

export const DEFAULT_ADAPTER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      DefaultAdapterArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        ['address'],
        [DEFAULT_UPDATER_ADDRESS]
      ),
    ]
  )
)

export const OZ_UUPS_UPDATER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(['bytes'], [OZUUPSUpdaterArtifact.bytecode])
)

export const OZ_UUPS_ADAPTER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      OZUUPSAdapterArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        ['address'],
        [OZ_UUPS_UPDATER_ADDRESS]
      ),
    ]
  )
)

export const OZ_TRANSPARENT_ADAPTER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      OZTransparentAdapterArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        ['address'],
        [DEFAULT_UPDATER_ADDRESS]
      ),
    ]
  )
)

export const PROXY_INITIALIZER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      ProxyInitializerArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        proxyInitializerConstructorArgTypes,
        proxyInitializerConstructorArgValues
      ),
    ]
  )
)

const [registryProxyConstructorFragment] = ProxyABI.filter(
  (fragment) => fragment.type === 'constructor'
)
const registryProxyConstructorArgTypes =
  registryProxyConstructorFragment.inputs.map((input) => input.type)
const registryProxyConstructorArgValues = [PROXY_INITIALIZER_ADDRESS]

export const CHUGSPLASH_REGISTRY_PROXY_ADDRESS = ethers.utils.getCreate2Address(
  PROXY_INITIALIZER_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      ProxyArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        registryProxyConstructorArgTypes,
        registryProxyConstructorArgValues
      ),
    ]
  )
)

export const ROOT_CHUGSPLASH_MANAGER_PROXY_ADDRESS =
  ethers.utils.getCreate2Address(
    CHUGSPLASH_BOOTLOADER_ADDRESS,
    CHUGSPLASH_SALT,
    ethers.utils.solidityKeccak256(
      ['bytes', 'bytes'],
      [
        ChugSplashManagerProxyArtifact.bytecode,
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'address'],
          [CHUGSPLASH_REGISTRY_PROXY_ADDRESS, CHUGSPLASH_BOOTLOADER_ADDRESS]
        ),
      ]
    )
  )

const chugsplashManagerConstructorArgValues = [
  CHUGSPLASH_REGISTRY_PROXY_ADDRESS,
  EXECUTION_LOCK_TIME,
  OWNER_BOND_AMOUNT,
  EXECUTOR_PAYMENT_PERCENTAGE,
]

export const CHUGSPLASH_MANAGER_ADDRESS = ethers.utils.getCreate2Address(
  DETERMINISTIC_DEPLOYMENT_PROXY_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      ChugSplashManagerArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        chugsplashManagerConstructorArgTypes,
        chugsplashManagerConstructorArgValues
      ),
    ]
  )
)

export const CHUGSPLASH_REGISTRY_ADDRESS = ethers.utils.getCreate2Address(
  CHUGSPLASH_BOOTLOADER_ADDRESS,
  CHUGSPLASH_SALT,
  ethers.utils.solidityKeccak256(
    ['bytes', 'bytes'],
    [
      ChugSplashRegistryArtifact.bytecode,
      ethers.utils.defaultAbiCoder.encode(
        ['uint256', 'uint256', 'uint256', 'address'],
        [
          OWNER_BOND_AMOUNT,
          EXECUTION_LOCK_TIME,
          EXECUTOR_PAYMENT_PERCENTAGE,
          CHUGSPLASH_MANAGER_ADDRESS,
        ]
      ),
    ]
  )
)

export const CHUGSPLASH_CONSTRUCTOR_ARGS = {}
CHUGSPLASH_CONSTRUCTOR_ARGS[chugsplashRegistrySourceName] = [
  OWNER_BOND_AMOUNT,
  EXECUTION_LOCK_TIME,
  EXECUTOR_PAYMENT_PERCENTAGE,
  CHUGSPLASH_MANAGER_ADDRESS,
]
CHUGSPLASH_CONSTRUCTOR_ARGS[chugsplashBootLoaderSourceName] = []
CHUGSPLASH_CONSTRUCTOR_ARGS[chugsplashManagerProxySourceName] = [
  CHUGSPLASH_REGISTRY_PROXY_ADDRESS,
  CHUGSPLASH_BOOTLOADER_ADDRESS,
]
CHUGSPLASH_CONSTRUCTOR_ARGS[chugsplashManagerSourceName] =
  chugsplashManagerConstructorArgValues
CHUGSPLASH_CONSTRUCTOR_ARGS[defaultAdapterSourceName] = [
  DEFAULT_UPDATER_ADDRESS,
]
CHUGSPLASH_CONSTRUCTOR_ARGS[OZUUPSAdapterSourceName] = [OZ_UUPS_UPDATER_ADDRESS]
CHUGSPLASH_CONSTRUCTOR_ARGS[OZTransparentAdapterSourceName] = [
  DEFAULT_UPDATER_ADDRESS,
]
CHUGSPLASH_CONSTRUCTOR_ARGS[defaultUpdaterSourceName] = []
CHUGSPLASH_CONSTRUCTOR_ARGS[OZUUPSUpdaterSourceName] = []
CHUGSPLASH_CONSTRUCTOR_ARGS[chugsplashRegistyProxySourceName] =
  registryProxyConstructorArgValues
CHUGSPLASH_CONSTRUCTOR_ARGS[proxyInitializerSourceName] =
  proxyInitializerConstructorArgValues
