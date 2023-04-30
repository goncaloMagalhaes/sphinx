/* Imports: External */
import * as path from 'path'

import * as Handlebars from 'handlebars'
import { BigNumber, ethers, providers } from 'ethers'
import {
  astDereferencer,
  ASTDereferencer,
  srcDecoder,
  isNodeType,
  findAll,
} from 'solidity-ast/utils'
import { remove0x } from '@eth-optimism/core-utils'
import { Fragment } from 'ethers/lib/utils'
import {
  assertStorageUpgradeSafe,
  StorageLayout,
  UpgradeableContract,
  UpgradeableContractErrorReport,
} from '@openzeppelin/upgrades-core'
import { OZ_UUPS_UPDATER_ADDRESS, ProxyABI } from '@chugsplash/contracts'
import { getDetailedLayout } from '@openzeppelin/upgrades-core/dist/storage/layout'
import yesno from 'yesno'
import { ContractDefinition } from 'solidity-ast'

import {
  ArtifactPaths,
  ContractArtifact,
  SolidityStorageLayout,
  SolidityStorageObj,
  SolidityStorageType,
  CompilerOutput,
} from '../languages/solidity/types'
import {
  getDefaultProxyAddress,
  isExternalContractKind,
  readContractArtifact,
  readBuildInfo,
  getChugSplashManagerAddress,
  getEIP1967ProxyAdminAddress,
  getPreviousStorageLayoutOZFormat,
  getOpenZeppelinUpgradableContract,
  isEqualType,
  getOpenZeppelinValidationOpts,
  chugsplashLog,
  getContractAddress,
  isDataHexString,
  isLiveNetwork,
  isContractDeployed,
  assertValidBlockGasLimit,
} from '../utils'
import {
  UserChugSplashConfig,
  ParsedChugSplashConfig,
  ParsedConfigVariable,
  UserContractConfig,
  UserConfigVariable,
  UserConfigVariables,
  ParsedConfigVariables,
  ParsedContractConfig,
} from './types'
import {
  CONTRACT_SIZE_LIMIT,
  Integration,
  Keyword,
  keywords,
} from '../constants'
import {
  getStorageType,
  extendStorageLayout,
  isKeyword,
  variableContainsKeyword,
} from '../languages'
import {
  recursiveLayoutIterator,
  VariableHandlers,
  VariableHandler,
  VariableHandlerProps,
  buildMappingStorageObj,
} from '../languages/solidity/iterator'
import { ChugSplashRuntimeEnvironment } from '../types'
import { getStorageLayout } from '../actions/artifacts'

class InputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputError'
  }
}

let validationErrors = false

const logValidationError = (
  logLevel: 'warning' | 'error',
  title: string,
  lines: string[],
  silent: boolean,
  stream: NodeJS.WritableStream
) => {
  validationErrors = true
  chugsplashLog(logLevel, title, lines, silent, stream)
}

/**
 * Reads a ChugSplash config file and completes full parsing and validation on it.
 *
 * @param configPath Path to the ChugSplash config file.
 * @returns The parsed ChugSplash config file.
 */
export const readValidatedChugSplashConfig = async (
  provider: providers.JsonRpcProvider,
  configPath: string,
  artifactPaths: ArtifactPaths,
  integration: Integration,
  cre: ChugSplashRuntimeEnvironment,
  exitOnFailure: boolean = true
): Promise<ParsedChugSplashConfig> => {
  const userConfig = await readUnvalidatedChugSplashConfig(configPath)
  return parseAndValidateChugSplashConfig(
    provider,
    userConfig,
    artifactPaths,
    integration,
    cre,
    exitOnFailure
  )
}

export const readUnvalidatedChugSplashConfig = async (
  configPath: string
): Promise<UserChugSplashConfig> => {
  delete require.cache[require.resolve(path.resolve(configPath))]

  let config
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let exported = require(path.resolve(configPath))
  exported = exported.default || exported
  if (typeof exported === 'function') {
    config = await exported()
  } else if (typeof exported === 'object') {
    config = exported
  } else {
    throw new Error(
      'Config file must export either a config object, or a function which resolves to one.'
    )
  }
  return config
}

export const isEmptyChugSplashConfig = (configFileName: string): boolean => {
  delete require.cache[require.resolve(path.resolve(configFileName))]
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require(path.resolve(configFileName))
  return Object.keys(config).length === 0
}

/**
 * Validates a ChugSplash config file.
 *
 * @param config Config file to validate.
 */
export const assertValidUserConfigFields = async (
  config: UserChugSplashConfig,
  provider: providers.Provider,
  cre: ChugSplashRuntimeEnvironment,
  exitOnFailure: boolean
) => {
  const proxyReferenceNames: string[] = []
  const noProxyReferenceNames: string[] = []
  for (const [refName, contract] of Object.entries(config.contracts)) {
    if (contract.kind === 'no-proxy') {
      noProxyReferenceNames.push(refName)
    } else {
      proxyReferenceNames.push(refName)
    }
  }

  if (!ethers.utils.isHexString(config.options.organizationID, 32)) {
    logValidationError(
      'error',
      `Organization ID must be a 32-byte hex string. Instead, got: ${config.options.organizationID}`,
      [],
      cre.silent,
      cre.stream
    )
  }

  for (const [referenceName, contractConfig] of Object.entries(
    config.contracts
  )) {
    // Block people from accidentally using templates in contract names.
    if (referenceName.includes('{') || referenceName.includes('}')) {
      logValidationError(
        'error',
        `Cannot use template strings in reference names: ${referenceName}`,
        [],
        cre.silent,
        cre.stream
      )
    }

    // Block people from accidentally using templates in contract names.
    if (
      contractConfig.contract.includes('{') ||
      contractConfig.contract.includes('}')
    ) {
      logValidationError(
        'error',
        `Cannot use template strings in contract name: ${contractConfig.contract}`,
        [],
        cre.silent,
        cre.stream
      )
    }

    // Make sure addresses are fixed and are actually addresses.
    if (
      contractConfig.externalProxy !== undefined &&
      !ethers.utils.isAddress(contractConfig.externalProxy)
    ) {
      logValidationError(
        'error',
        `External proxy address is not a valid address: ${contractConfig.externalProxy}`,
        [],
        cre.silent,
        cre.stream
      )
    }

    // Make sure that the external proxy contract exists.
    if (
      contractConfig.externalProxy !== undefined &&
      (await provider.getCode(contractConfig.externalProxy)) === '0x'
    ) {
      logValidationError(
        'error',
        `Entered a proxy address that does not exist: ${contractConfig.externalProxy}`,
        [],
        cre.silent,
        cre.stream
      )
    }

    // Make sure that the external proxy type is valid.
    if (
      contractConfig.kind !== undefined &&
      isExternalContractKind(contractConfig.kind) === false
    ) {
      logValidationError(
        'error',
        `External proxy type is not valid ${contractConfig.kind}`,
        [],
        cre.silent,
        cre.stream
      )
    }

    // The user must include both `externalProxy` and `kind` field, or neither.
    // If the user sets kind to no-proxy, then they must not include an externalProxy.
    if (
      contractConfig.externalProxy !== undefined &&
      contractConfig.kind === undefined
    ) {
      logValidationError(
        'error',
        `User included an 'externalProxy' field, but did not include an 'kind'\nfield for ${contractConfig.contract}. Please include both or neither.`,
        [],
        cre.silent,
        cre.stream
      )
    } else if (
      contractConfig.externalProxy === undefined &&
      contractConfig.kind !== undefined &&
      contractConfig.kind !== 'no-proxy'
    ) {
      logValidationError(
        'error',
        `User included an 'kind' field, but did not include an 'externalProxy'\nfield for ${contractConfig.contract}. Please include both or neither.`,
        [],
        cre.silent,
        cre.stream
      )
    } else if (
      // if the contract is non-proxied than it should not have an external proxy defined
      contractConfig.kind === 'no-proxy' &&
      contractConfig.externalProxy !== undefined
    ) {
      logValidationError(
        'error',
        `User included a 'kind' field and an 'externalProxy' field for ${contractConfig.contract}. If you want to deploy a non-proxied contract, please remove the 'externalProxy' field.`,
        [],
        cre.silent,
        cre.stream
      )
    }

    if (
      contractConfig.previousBuildInfo !== undefined &&
      contractConfig.previousFullyQualifiedName === undefined
    ) {
      logValidationError(
        'error',
        `User included a 'previousBuildInfo' field in the ChugSplash config file for ${contractConfig.contract}, but\ndid not include a 'previousFullyQualifiedName' field. Please include both or neither.`,
        [],
        cre.silent,
        cre.stream
      )
    } else if (
      contractConfig.previousBuildInfo === undefined &&
      contractConfig.previousFullyQualifiedName !== undefined
    ) {
      logValidationError(
        'error',
        `User included a 'previousFullyQualifiedName' field in the ChugSplash config file for ${contractConfig.contract}, but\ndid not include a 'previousBuildInfo' field. Please include both or neither.`,
        [],
        cre.silent,
        cre.stream
      )
    }

    if (contractConfig.variables !== undefined) {
      // Check that all contract references in variables are valid.
      assertValidContractReferences(
        contractConfig,
        contractConfig.variables,
        proxyReferenceNames,
        noProxyReferenceNames,
        cre
      )
    }

    if (contractConfig.constructorArgs !== undefined) {
      // Check that all contract references in constructor args are valid.
      assertValidContractReferences(
        contractConfig,
        contractConfig.constructorArgs,
        proxyReferenceNames,
        noProxyReferenceNames,
        cre
      )
    }

    if (contractConfig.constructorArgs !== undefined) {
      // Check that the user did not use the 'preserve' keyword for constructor args.
      if (
        variableContainsKeyword(
          contractConfig.constructorArgs,
          keywords.preserve
        )
      ) {
        logValidationError(
          'error',
          `Detected the '{preserve}' keyword in the 'constructorArgs' field of your ChugSplash config file. This \nkeyword can only be used in the 'variables' field. Please remove all instances of it in 'constructorArgs'.`,
          [],
          cre.silent,
          cre.stream
        )
      }
    }
  }

  if (validationErrors && exitOnFailure) {
    process.exit(1)
  }
}

const stringifyVariableType = (variable: UserConfigVariable) => {
  return Array.isArray(variable) ? 'array' : typeof variable
}

/**
 * Parses and validates the elements of an array. This function is used whenever the encoding of
 * the array is `inplace` (for fixed size arrays) or `dynamic_array`, but not `bytes`, which is
 * used for dynamic bytes and strings. Works recursively with the `parseAndValidateVariable` function.
 *
 * @param array Array to parse and validate.
 * @param storageObj Solidity compiler JSON output describing the layout for this array.
 * @param storageTypes Full list of storage types allowed.
 * @param nestedSlotOffset Not used, only included here because of the shared recursiveLayoutIterator structure.
 * @returns Array with it's elements converted into the correct type for the parsed chugsplash config.
 */
export const parseArrayElements = (
  array: Array<UserConfigVariable>,
  storageObj: SolidityStorageObj,
  storageTypes: {
    [name: string]: SolidityStorageType
  },
  nestedSlotOffset: string,
  dereferencer: ASTDereferencer
): Array<ParsedConfigVariable> => {
  const elementType = getStorageType(
    storageObj.type,
    storageTypes,
    dereferencer
  ).base

  if (elementType === undefined) {
    throw new Error(
      `Could not encode array elements for: ${storageObj.label}. Please report this error to the developers, this should never happen.`
    )
  }

  // Arrays always start at a new storage slot with an offset of zero.
  const bytesOffset = 0

  // Iterate over the array and encode each element in it.
  const parsedArray: Array<ParsedConfigVariable> = []
  for (const element of array) {
    parsedArray.push(
      parseAndValidateVariable(
        element,
        {
          astId: storageObj.astId,
          contract: storageObj.contract,
          label: storageObj.label,
          offset: bytesOffset,
          slot: '0',
          type: elementType,
        },
        storageTypes,
        nestedSlotOffset,
        dereferencer
      )
    )
  }
  return parsedArray
}

/**
 * Handles parsing and validating fixed-size arrays
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceArray: VariableHandler<
  UserConfigVariable,
  Array<ParsedConfigVariable>
> = (
  props: VariableHandlerProps<UserConfigVariable, Array<ParsedConfigVariable>>
): Array<ParsedConfigVariable> => {
  const { storageObj, variable, storageTypes, nestedSlotOffset, dereferencer } =
    props

  if (!Array.isArray(variable)) {
    throw new InputError(
      `Expected array for ${storageObj.label} but got ${typeof variable}`
    )
  }

  // array object types come in the format: t_array(t_<type>)<size>_storage)
  // when nested, the format is repeated: t_array(t_array(t_<type>)<size>_storage)<size>_storage)
  // So to get the size of the array, we split on the ')' character, remove the first element (which is the type),
  // remove the _storage suffix, and parse the remaining element as an integer.
  let stringSizes = storageObj.type.split(')')
  stringSizes = stringSizes.map((el) => el.replace('_storage', ''))
  stringSizes.shift()
  const sizes = stringSizes.map((el) => parseInt(el, 10))

  if (sizes.length === 0) {
    throw new InputError(
      `Failed to parse expected array size for ${storageObj.label}, this should never happen please report this error to the developers.`
    )
  }

  if (sizes[sizes.length - 1] !== variable.length) {
    throw new InputError(
      `Expected array of size ${sizes[sizes.length - 1]} for ${
        storageObj.label
      } but got ${JSON.stringify(variable)}`
    )
  }

  return parseArrayElements(
    variable,
    storageObj,
    storageTypes,
    nestedSlotOffset,
    dereferencer
  )
}

/**
 * Interface for parsing addresses and contracts during variable validation.
 * Calls the generic `parseAddress` function below which has a more slimmed down interface
 * to make it usable for both variables and constructor args.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceAddress: VariableHandler<
  UserConfigVariable,
  string
> = (props: VariableHandlerProps<UserConfigVariable, string>): string => {
  const { variable, storageObj } = props

  // convert to checksum address
  return parseAddress(variable, storageObj.label)
}

/**
 * Handles parsing addresses and contracts for both variables and constructor args.
 *
 * @param variable Variable to parse.
 * @param label Label to use in error messages.
 * @returns parsed variable string
 */
const parseAddress = (variable: UserConfigVariable, label: string) => {
  if (typeof variable !== 'string') {
    throw new InputError(
      `invalid input type for ${label}: ${variable}, expected address string but got ${stringifyVariableType(
        variable
      )}`
    )
  }

  if (!ethers.utils.isAddress(variable)) {
    throw new Error(`invalid address for ${label}: ${variable}`)
  }

  // convert to checksum address
  return ethers.utils.getAddress(variable)
}

/**
 * Interface for parsing booleans during variable validation. Calls the generic `parseAddress`
 * function below which has a more slimmed down interface to make it usable for both variables
 * and constructor args.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceBool: VariableHandler<UserConfigVariable, boolean> = (
  props: VariableHandlerProps<UserConfigVariable, boolean>
): boolean => {
  const { variable, storageObj } = props

  return parseBool(variable, storageObj.label)
}

/**
 * Handles parsing and validating booleans for both variables and constructor args.
 *
 * @param variable Variable to parse.
 * @param label Label to use in error messages.
 * @returns true or false
 */
const parseBool = (variable: UserConfigVariable, label: string) => {
  if (typeof variable !== 'boolean') {
    throw new InputError(
      `invalid input type for variable ${label}, expected boolean but got ${stringifyVariableType(
        variable
      )}`
    )
  }

  return variable
}

/**
 * Interface for parsing in place bytes during variable validation. Calls the generic `parseBytes`
 * function below which has a more slimmed down interface to make it usable for both variables
 * and constructor args.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceBytes: VariableHandler<UserConfigVariable, string> = (
  props: VariableHandlerProps<string, string>
): string => {
  const { variable, variableType, storageObj } = props

  return parseBytes(
    variable,
    variableType.label,
    storageObj.label,
    variableType.numberOfBytes
  )
}

/**
 * Handles parsing and validating fixed size bytes for both variables and constructor args.
 *
 * @param variable Variable to parse.
 * @param label Label to use in error messages.
 * @returns DataHexString
 */
const parseBytes = (
  variable: UserConfigVariable,
  variableType: string,
  label: string,
  numberOfBytes: number
) => {
  // Check that the user entered a string
  if (typeof variable !== 'string') {
    throw new InputError(
      `invalid input type for ${label}: ${variable}, expected DataHexString but got ${stringifyVariableType(
        variable
      )}`
    )
  }

  if (variableType.startsWith('bytes')) {
    if (!ethers.utils.isHexString(variable)) {
      throw new InputError(
        `invalid input format for variable ${label}, expected DataHexString but got ${variable}`
      )
    }

    // Check that the HexString is the correct length
    if (!ethers.utils.isHexString(variable, numberOfBytes)) {
      throw new Error(
        `invalid length for bytes${numberOfBytes} variable ${label}: ${variable}`
      )
    }
  }

  return variable
}

/**
 * Interface for parsing uints during variable validation. Calls the generic `parseUnsignedInteger`
 * function below which has a more slimmed down interface to make it usable for both
 * variables and constructor args.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceUint: VariableHandler<UserConfigVariable, string> = (
  props: VariableHandlerProps<UserConfigVariable, string>
): string => {
  const { variable, variableType, storageObj } = props

  return parseUnsignedInteger(
    variable,
    storageObj.label,
    variableType.numberOfBytes
  )
}

/**
 * Handles parsing and validating uints
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
const parseUnsignedInteger = (
  variable: UserConfigVariable,
  label: string,
  numberOfBytes: number
) => {
  if (
    typeof variable !== 'number' &&
    typeof variable !== 'string' &&
    !(
      typeof variable === 'object' &&
      'type' in variable &&
      variable.type === 'BigNumber'
    )
  ) {
    throw new InputError(
      `invalid input type for variable ${label} expected number, string, or BigNumber but got ${stringifyVariableType(
        variable
      )}`
    )
  }

  const maxValue = BigNumber.from(2)
    .pow(8 * numberOfBytes)
    .sub(1)

  if (
    remove0x(BigNumber.from(variable).toHexString()).length / 2 >
    numberOfBytes
  ) {
    throw new Error(
      `invalid value for ${label}: ${variable}, outside valid range: [0:${maxValue}]`
    )
  }

  return BigNumber.from(variable).toString()
}

/**
 * Interface for parsing ints during variable validation. Calls the generic `parseInteger`
 * function below which has a more slimmed down interface to make it usable for both
 * variables and constructor args.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceInt: VariableHandler<UserConfigVariable, string> = (
  props: VariableHandlerProps<UserConfigVariable, string>
): string => {
  const { variable, variableType, storageObj } = props

  return parseInteger(variable, storageObj.label, variableType.numberOfBytes)
}

/**
 * Handles parsing integers for both variables and constructor args.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
const parseInteger = (
  variable: UserConfigVariable,
  label: string,
  numberOfBytes: number
) => {
  if (
    typeof variable !== 'number' &&
    typeof variable !== 'string' &&
    !(
      typeof variable === 'object' &&
      'type' in variable &&
      variable.type === 'BigNumber'
    )
  ) {
    throw new InputError(
      `invalid input type for variable ${label} expected number, string, or BigNumber but got ${stringifyVariableType(
        variable
      )}`
    )
  }

  // Calculate the minimum and maximum values of the int to ensure that the variable fits within
  // these bounds.
  const minValue = BigNumber.from(2)
    .pow(8 * numberOfBytes)
    .div(2)
    .mul(-1)
  const maxValue = BigNumber.from(2)
    .pow(8 * numberOfBytes)
    .div(2)
    .sub(1)
  if (
    BigNumber.from(variable).lt(minValue) ||
    BigNumber.from(variable).gt(maxValue)
  ) {
    throw new Error(
      `invalid value for ${label}: ${variable}, outside valid range: [${minValue}:${maxValue}]`
    )
  }

  return BigNumber.from(variable).toString()
}

/**
 * Handles parsing and validating structs
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseInplaceStruct: VariableHandler<
  UserConfigVariable,
  ParsedConfigVariables
> = (
  props: VariableHandlerProps<UserConfigVariable, ParsedConfigVariables>
): ParsedConfigVariables => {
  const {
    variable,
    variableType,
    nestedSlotOffset,
    storageTypes,
    storageObj,
    dereferencer,
  } = props

  if (typeof variable !== 'object') {
    throw new InputError(
      `invalid input type for variable ${
        storageObj.label
      } expected object but got ${stringifyVariableType(variable)}`
    )
  }

  // Structs are encoded recursively, as defined by their `members` field.
  const parsedVariable: ParsedConfigVariables = {}
  if (variableType.members === undefined) {
    // The Solidity compiler prevents defining structs without any members, so this should
    // never occur.
    throw new Error(
      `Could not find any members in ${variableType.label}. Should never happen.`
    )
  }
  for (const [varName, varVal] of Object.entries(variable)) {
    const memberStorageObj = variableType.members.find((member) => {
      return member.label === varName
    })
    if (memberStorageObj === undefined) {
      throw new InputError(
        `User entered incorrect member in ${variableType.label}: ${varName}`
      )
    }
    parsedVariable[varName] = parseAndValidateVariable(
      varVal,
      memberStorageObj,
      storageTypes,
      nestedSlotOffset,
      dereferencer
    )
  }

  return parsedVariable
}

/**
 * Handles parsing and validating dynamic bytes
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseDynamicBytes: VariableHandler<UserConfigVariable, string> = (
  props: VariableHandlerProps<UserConfigVariable, string>
): string => {
  const { variable, variableType, storageObj } = props

  if (typeof variable !== 'string') {
    throw new InputError(
      `invalid input type for ${
        storageObj.label
      }, expected DataHexString but got ${stringifyVariableType(variable)}`
    )
  }

  if (variableType.label.startsWith('bytes')) {
    if (!isDataHexString(variable)) {
      throw new InputError(
        `invalid input type for variable ${storageObj.label}, expected DataHexString but got ${variable}`
      )
    }
  }

  // The Solidity compiler uses the "bytes" encoding for strings and dynamic bytes.
  // ref: https://docs.soliditylang.org/en/v0.8.4/internals/layout_in_storage.html#bytes-and-string
  if (storageObj.offset !== 0) {
    // Strings and dynamic bytes are *not* packed by Solidity.
    throw new Error(
      `Got offset for string/bytes type, should never happen. Please report this to the developers.`
    )
  }

  return variable
}

/**
 * Handles parsing and validating mappings
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseMapping: VariableHandler<
  UserConfigVariable,
  ParsedConfigVariables
> = (
  props: VariableHandlerProps<UserConfigVariable, ParsedConfigVariables>
): ParsedConfigVariables => {
  const {
    variable,
    storageObj,
    storageTypes,
    variableType,
    nestedSlotOffset,
    dereferencer,
  } = props

  // Iterate over every key/value in the mapping to get the storage slot pair for each one.
  const mapping: ParsedConfigVariables = {}
  for (const [mappingKey, mappingVal] of Object.entries(variable)) {
    const mappingValStorageObj = buildMappingStorageObj(
      storageTypes,
      variableType,
      mappingKey,
      '0x',
      storageObj,
      dereferencer
    )
    // Encode the storage slot key/value for the mapping value. Note that we set
    // `nestedSlotOffset` to '0' because it isn't used when calculating the storage slot
    // key (we already calculated the storage slot key above).
    mapping[mappingKey] = parseAndValidateVariable(
      mappingVal,
      mappingValStorageObj,
      storageTypes,
      nestedSlotOffset,
      dereferencer
    )
  }
  return mapping
}

/**
 * Handles parsing and validating dynamically-sized arrays
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parseDynamicArray: VariableHandler<
  UserConfigVariable,
  Array<ParsedConfigVariable>
> = (
  props: VariableHandlerProps<UserConfigVariable, Array<ParsedConfigVariable>>
): Array<ParsedConfigVariable> => {
  const { variable, storageObj, storageTypes, nestedSlotOffset, dereferencer } =
    props

  if (!Array.isArray(variable)) {
    throw new InputError(
      `invalid array ${variable}, expected array but got ${typeof variable}`
    )
  }

  // For dynamic arrays, the current storage slot stores the number of elements in the array (byte
  // arrays and strings are an exception since they use the encoding 'bytes').
  const array: any[] = parseArrayElements(
    variable,
    storageObj,
    storageTypes,
    nestedSlotOffset,
    dereferencer
  )

  return array
}

/**
 * Handles parsing and validating preserved variables
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns
 */
export const parsePreserve: VariableHandler<string, string> = (
  props: VariableHandlerProps<string, string>
): string => {
  const { variable } = props

  return variable
}

export const parseGap = (
  storageObj: SolidityStorageObj,
  variableType: SolidityStorageType
): [] => {
  if (
    variableType.encoding === 'inplace' &&
    storageObj.type.startsWith('t_array')
  ) {
    return []
  }

  throw new InputError(
    `invalid use of { gap } keyword, only allowed for fixed-size arrays`
  )
}

/**
 * Handles parsing and validating functions, in practice this function does nothing because
 * functions should not be defined in the ChugSplash config.
 *
 * @param props standard VariableHandler props. See ./iterator.ts for more information.
 * @returns undefined
 */
export const parseFunction: VariableHandler<string, string> = (
  props: VariableHandlerProps<string, string>
): string => {
  return props.variable
}

export const handleParseOnlyKeywords = (
  storageObj: SolidityStorageObj,
  variableType: SolidityStorageType,
  keyword: Keyword
): ParsedConfigVariable => {
  switch (keyword) {
    case keywords.gap:
      return parseGap(storageObj, variableType)
    case keywords.preserve:
      return keywords.preserve
    default:
      throw Error(`parsing for keyword ${keyword} not implemented`)
  }
}

/**
 * Parses and validates a single variable. Works recursively with complex data types using the recursiveLayoutIterator.
 * See ./iterator.ts for more information on the recursive iterator pattern.
 *
 * @param variable Variable to encode as key/value slot pairs.
 * @param storageObj Solidity compiler JSON output describing the layout for this variable.
 * @param storageTypes Full list of storage types allowed for this encoding.
 * @param nestedSlotOffset Not used, only included here because of the shared recursiveLayoutIterator structure.
 * @returns Variable parsed into the format expected by the parsed chugsplash config.
 */
export const parseAndValidateVariable = (
  variable: UserConfigVariable,
  storageObj: SolidityStorageObj,
  storageTypes: {
    [name: string]: SolidityStorageType
  },
  nestedSlotOffset: string,
  dereferencer: ASTDereferencer
): ParsedConfigVariable => {
  if (variable === undefined) {
    return variable
  }

  const typeHandlers: VariableHandlers<ParsedConfigVariable> = {
    inplace: {
      array: parseInplaceArray,
      address: parseInplaceAddress,
      bool: parseInplaceBool,
      bytes: parseInplaceBytes,
      uint: parseInplaceUint,
      int: parseInplaceInt,
      struct: parseInplaceStruct,
    },
    bytes: parseDynamicBytes,
    mapping: parseMapping,
    dynamic_array: parseDynamicArray,
    preserve: parsePreserve,
    function: parseFunction,
  }

  // Handle any keywords that are only used for parsing, not encoding.
  for (const keyword of Object.values(keywords)) {
    if (isKeyword(variable, keyword)) {
      const variableType = getStorageType(
        storageObj.type,
        storageTypes,
        dereferencer
      )

      return handleParseOnlyKeywords(storageObj, variableType, keyword)
    }
  }

  return recursiveLayoutIterator<ParsedConfigVariable>(
    variable,
    storageObj,
    storageTypes,
    nestedSlotOffset,
    typeHandlers,
    dereferencer
  )
}

/**
 * Parses and validates all variables in a config file.
 *
 * @param contractConfig Unparsed User-defined contract definition in a ChugSplash config.
 * @param storageLayout Storage layout returned by the solidity compiler for the relevant contract.
 * @param compilerOutput Complete compiler output.
 * @returns complete set of variables parsed into the format expected by the parsed chugsplash config.
 */
const parseContractVariables = (
  contractConfig: UserContractConfig,
  storageLayout: SolidityStorageLayout,
  compilerOutput: CompilerOutput,
  cre: ChugSplashRuntimeEnvironment
): ParsedConfigVariables => {
  const parsedConfigVariables: ParsedConfigVariables = {}

  const userConfigVariables: UserConfigVariables =
    contractConfig.variables ?? {}

  const dereferencer = astDereferencer(compilerOutput)
  const extendedLayout = extendStorageLayout(storageLayout, dereferencer)

  const inputErrors: string[] = []
  const unnecessarilyDefinedVariables: string[] = []
  const missingVariables: string[] = []

  for (const variableName of Object.keys(userConfigVariables)) {
    const existsInLayout = extendedLayout.storage.some(
      (storageObj) => storageObj.configVarName === variableName
    )

    if (existsInLayout === false) {
      unnecessarilyDefinedVariables.push(variableName)
    }
  }

  for (const storageObj of Object.values(extendedLayout.storage)) {
    const configVarValue = userConfigVariables[storageObj.configVarName]
    if (
      configVarValue === undefined &&
      !storageObj.type.startsWith('t_function')
    ) {
      missingVariables.push(storageObj.configVarName)
    } else if (
      configVarValue !== undefined &&
      storageObj.type.startsWith('t_function')
    ) {
      inputErrors.push(
        `Detected value for ${storageObj.configVarName} which is a function. Function variables should be ommitted from your ChugSplash config.`
      )
    }

    try {
      parsedConfigVariables[storageObj.configVarName] =
        parseAndValidateVariable(
          configVarValue,
          storageObj,
          extendedLayout.types,
          '0',
          dereferencer
        )
    } catch (e) {
      inputErrors.push((e as Error).message)
    }
  }

  if (
    inputErrors.length > 0 ||
    unnecessarilyDefinedVariables.length > 0 ||
    missingVariables.length > 0
  ) {
    if (inputErrors.length > 0) {
      const lines: string[] = []

      for (const error of inputErrors) {
        lines.push(error)
      }

      logValidationError(
        'error',
        'Detected incorrectly defined variables:',
        lines,
        cre.silent,
        cre.stream
      )
    }

    if (unnecessarilyDefinedVariables.length > 0) {
      const lines: string[] = []

      for (const variable of unnecessarilyDefinedVariables) {
        lines.push(`${variable}`)
      }
      lines.push(
        `- If any of these variables are immutable, please remove their definition in the 'variables' section of the ChugSplash config file and use the 'constructorArgs' field instead.`
      )
      lines.push(
        `- If any of these variables are meant to be mutable, please remove their definition in the ChugSplash config file.`
      )
      lines.push(
        `- If this problem persists, delete your cache folder then try again.`
      )

      logValidationError(
        'error',
        `Detected variables defined in the ChugSplash config file that do not exist in the contract ${contractConfig.contract}:`,
        lines,
        cre.silent,
        cre.stream
      )
    }

    if (missingVariables.length > 0) {
      const lines: string[] = []

      for (const variable of missingVariables) {
        lines.push(variable)
      }
      lines.push(
        '- Every variable defined in your contracts must be assigned a value in your ChugSplash config file.'
      )
      lines.push(
        '- Please define the variable in your ChugSplash config file then run this command again.'
      )
      lines.push(
        '- If this problem persists, delete your cache folder then try again.'
      )

      logValidationError(
        'error',
        `The following variables were defined in the contract ${contractConfig.contract} (or one of its parent contracts) but were not defined in the ChugSplash config file:`,
        lines,
        cre.silent,
        cre.stream
      )
    }
  }

  return parsedConfigVariables
}

/**
 * Parses and validates constructor args for a single contract in a config file.
 *
 * @param userContractConfig Unparsed User-defined contract definition in a ChugSplash config.
 * @param referenceName Name of the contract as it appears in the ChugSplash config file.
 * @param abi ABI of the contract.
 * @param contractReferences Map of contract names to their addresses used to resolve contract references.
 * @returns complete set of variables parsed into the format expected by the parsed chugsplash config.
 */
export const parseContractConstructorArgs = (
  userContractConfig: UserContractConfig,
  referenceName: string,
  abi: Array<Fragment>,
  cre: ChugSplashRuntimeEnvironment
): ParsedConfigVariables => {
  const userConstructorArgs: UserConfigVariables =
    userContractConfig.constructorArgs ?? {}

  const parsedConstructorArgs: ParsedConfigVariables = {}

  const constructorFragment = abi.find(
    (fragment) => fragment.type === 'constructor'
  )

  if (constructorFragment === undefined) {
    if (Object.keys(userConstructorArgs).length > 0) {
      throw new InputError(
        `User entered constructor arguments in the ChugSplash config file for ${referenceName}, but\n` +
          `no constructor exists in the contract.`
      )
    } else {
      return parsedConstructorArgs
    }
  }

  const constructorArgNames = constructorFragment.inputs.map(
    (input) => input.name
  )
  const incorrectConstructorArgNames = Object.keys(userConstructorArgs).filter(
    (argName) => !constructorArgNames.includes(argName)
  )
  const undefinedConstructorArgNames: string[] = []
  const inputFormatErrors: string[] = []

  constructorFragment.inputs.forEach((input) => {
    const constructorArgValue = userConstructorArgs[input.name]
    if (constructorArgValue === undefined) {
      undefinedConstructorArgNames.push(input.name)
      return
    }

    const constructorArgType = input.type
    try {
      if (
        constructorArgType.startsWith('uint') ||
        constructorArgType.startsWith('int')
      ) {
        // Since the number of bytes is not easily accessible, we parse it from the type string.
        const suffix = constructorArgType.replace(/u?int/g, '')
        const bits = parseInt(suffix, 10)
        const numberOfBytes = bits / 8

        if (constructorArgType.startsWith('int')) {
          parsedConstructorArgs[input.name] = parseInteger(
            constructorArgValue,
            input.name,
            numberOfBytes
          )
        } else {
          const returnVal = parseUnsignedInteger(
            constructorArgValue,
            input.name,
            numberOfBytes
          )
          parsedConstructorArgs[input.name] = returnVal
        }
      } else if (constructorArgType.startsWith('address')) {
        // if the value is a contract reference, then we don't parse it and assume it is correct given
        // that we handle validating contract references elsewhere.
        // Note that references to any proxied contracts will have already been resolved at this point,
        // so any references here will be those to no-proxied contracts which must be resolve separately
        // after we've parsed the constructor args.
        if (
          typeof constructorArgValue === 'string' &&
          constructorArgValue.startsWith('{{') &&
          constructorArgValue.endsWith('}}')
        ) {
          parsedConstructorArgs[input.name] = constructorArgValue
        } else {
          parsedConstructorArgs[input.name] = parseAddress(
            constructorArgValue,
            input.name
          )
        }
      } else if (constructorArgType === 'bool') {
        parsedConstructorArgs[input.name] = parseBool(
          constructorArgValue,
          input.name
        )
      } else if (constructorArgType.startsWith('bytes')) {
        const suffix = constructorArgType.replace(/bytes/g, '')
        const numberOfBytes = parseInt(suffix, 10)

        parsedConstructorArgs[input.name] = parseBytes(
          constructorArgValue,
          constructorArgType,
          input.name,
          numberOfBytes
        )
      } else {
        // throw or log error
        throw new InputError(
          `Unsupported constructor argument type: ${input.type} for argument ${input.name}`
        )
      }
    } catch (e) {
      inputFormatErrors.push((e as Error).message)
    }
  })

  if (inputFormatErrors.length > 0) {
    const lines: string[] = []

    for (const error of inputFormatErrors) {
      lines.push(error)
    }

    logValidationError(
      'error',
      'Detected incorrectly defined constructor arguments:',
      lines,
      cre.silent,
      cre.stream
    )
  }

  if (
    incorrectConstructorArgNames.length > 0 ||
    undefinedConstructorArgNames.length > 0
  ) {
    if (incorrectConstructorArgNames.length > 0) {
      const lines: string[] = []
      lines.push(
        `${incorrectConstructorArgNames.map((argName) => `${argName}`)}`
      )

      logValidationError(
        'error',
        `The following constructor arguments were found in your config for ${referenceName},\nbut are not present in the contract constructor:`,
        lines,
        cre.silent,
        cre.stream
      )
    }

    if (undefinedConstructorArgNames.length > 0) {
      const lines: string[] = []
      lines.push(
        `${undefinedConstructorArgNames.map((argName) => `${argName}`)}`
      )

      logValidationError(
        'error',
        `The following constructor arguments are required by the constructor for ${referenceName},\nbut were not found in your config:`,
        lines,
        cre.silent,
        cre.stream
      )
    }
  }

  return parsedConstructorArgs
}

export const assertStorageCompatiblePreserveKeywords = (
  contractConfig: ParsedContractConfig,
  prevStorageLayout: StorageLayout,
  newStorageLayout: StorageLayout,
  cre: ChugSplashRuntimeEnvironment
) => {
  const prevDetailedLayout = getDetailedLayout(prevStorageLayout)
  const newDetailedLayout = getDetailedLayout(newStorageLayout)

  const errorMessages: Array<string> = []
  for (const newStorageObj of newDetailedLayout) {
    if (
      variableContainsKeyword(
        contractConfig.variables[newStorageObj.label],
        keywords.preserve
      )
    ) {
      const validPreserveKeyword = prevDetailedLayout.some(
        (prevObj) =>
          prevObj.label === newStorageObj.label &&
          prevObj.slot === newStorageObj.slot &&
          prevObj.offset === newStorageObj.offset &&
          isEqualType(prevObj, newStorageObj)
      )

      if (!validPreserveKeyword) {
        errorMessages.push(newStorageObj.label)
      }
    }
  }

  if (errorMessages.length > 0) {
    logValidationError(
      'error',
      'Invalid use of preserve keyword.',
      [
        'The following variables contain the preserve keyword, but do not exist in the previous',
        'storage layout at the same slot position with the same variable type. Please fix this',
        'or remove the preserve keyword from these variables:',
        ...errorMessages,
      ],
      cre.silent,
      cre.stream
    )
  }
}

/**
 * Throws an error if the given variable contains any invalid contract references. Specifically,
 * it'll throw an error if any of the following conditions occur:
 *
 * 1. There are any leading spaces before '{{', or any trailing spaces after '}}'. This ensures the
 * template string converts into a valid address when it's parsed. If there are any leading or
 * trailing spaces in an address, `ethers.utils.isAddress` will return false.
 *
 * 2. The contract reference is not included in the array of valid contract references.
 *
 * @param variable Config variable defined by the user.
 * @param referenceNames Valid reference names for this ChugSplash config file.
 */
export const assertValidContractReferences = (
  contract: UserContractConfig,
  variable: UserConfigVariable,
  proxyReferenceNames: string[],
  noProxyReferenceNames: string[],
  cre: ChugSplashRuntimeEnvironment
) => {
  if (
    typeof variable === 'string' &&
    variable.includes('{{') &&
    variable.includes('}}')
  ) {
    if (!variable.startsWith('{{')) {
      logValidationError(
        'error',
        `Contract reference cannot contain leading spaces before '{{' : ${variable}`,
        [],
        cre.silent,
        cre.stream
      )
    }
    if (!variable.endsWith('}}')) {
      logValidationError(
        'error',
        `Contract reference cannot contain trailing spaces: ${variable}`,
        [],
        cre.silent,
        cre.stream
      )
    }

    const contractReference = variable.substring(2, variable.length - 2).trim()

    if (
      noProxyReferenceNames.includes(contractReference) &&
      contract.kind === 'no-proxy'
    ) {
      logValidationError(
        'error',
        `Invalid contract reference: ${variable}. Contract references to no-proxy contracts are not allowed in other no-proxy contracts.\n`,
        [],
        cre.silent,
        cre.stream
      )
    } else if (
      !proxyReferenceNames.includes(contractReference) &&
      !noProxyReferenceNames.includes(contractReference)
    ) {
      logValidationError(
        'error',
        `Invalid contract reference: ${variable}.\nDid you misspell this contract reference, or forget to define a contract with this reference name?`,
        [],
        cre.silent,
        cre.stream
      )
    }
  } else if (Array.isArray(variable)) {
    for (const element of variable) {
      assertValidContractReferences(
        contract,
        element,
        proxyReferenceNames,
        noProxyReferenceNames,
        cre
      )
    }
  } else if (typeof variable === 'object') {
    for (const [varName, varValue] of Object.entries(variable)) {
      assertValidContractReferences(
        contract,
        varName,
        proxyReferenceNames,
        noProxyReferenceNames,
        cre
      )
      assertValidContractReferences(
        contract,
        varValue,
        proxyReferenceNames,
        noProxyReferenceNames,
        cre
      )
    }
  } else if (
    typeof variable === 'boolean' ||
    typeof variable === 'number' ||
    typeof variable === 'string'
  ) {
    return
  } else {
    logValidationError(
      'error',
      `Detected unknown variable type, ${typeof variable}, for variable: ${variable}.`,
      [],
      cre.silent,
      cre.stream
    )
  }
}

export const assertValidParsedChugSplashFile = async (
  provider: providers.Provider,
  parsedConfig: ParsedChugSplashConfig,
  userConfig: UserChugSplashConfig,
  artifactPaths: ArtifactPaths,
  cre: ChugSplashRuntimeEnvironment
): Promise<boolean> => {
  const { canonicalConfigPath } = cre

  // Determine if the deployment is an upgrade
  const chugSplashManagerAddress = getChugSplashManagerAddress(
    parsedConfig.options.claimer,
    parsedConfig.options.organizationID
  )
  const requiresOwnershipTransfer: {
    name: string
    proxyAddress: string
    currentAdminAddress: string
  }[] = []
  let isUpgrade: boolean = false
  for (const [referenceName, contractConfig] of Object.entries(
    parsedConfig.contracts
  )) {
    if ((await provider.getCode(contractConfig.address)) !== '0x') {
      isUpgrade = true

      if (
        contractConfig.kind === 'oz-ownable-uups' ||
        contractConfig.kind === 'oz-access-control-uups'
      ) {
        // We must manually check that the ChugSplashManager can call the UUPS proxy's `upgradeTo`
        // function because OpenZeppelin UUPS proxies can implement arbitrary access control
        // mechanisms.
        const chugsplashManager = new ethers.VoidSigner(
          chugSplashManagerAddress,
          provider
        )
        const UUPSProxy = new ethers.Contract(
          contractConfig.address,
          ProxyABI,
          chugsplashManager
        )
        try {
          // Attempt to staticcall the `upgradeTo` function on the proxy from the
          // ChugSplashManager's address. Note that it's necessary for us to set the proxy's
          // implementation to an OpenZeppelin UUPS ProxyUpdater contract to ensure that:
          // 1. The new implementation is deployed on every network. Otherwise, the call will revert
          //    due to this check:
          //    https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/proxy/ERC1967/ERC1967Upgrade.sol#L44
          // 2. The new implementation has a public `proxiableUUID()` function. Otherwise, the call
          //    will revert due to this check:
          //    https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/blob/dd8ca8adc47624c5c5e2f4d412f5f421951dcc25/contracts/proxy/ERC1967/ERC1967UpgradeUpgradeable.sol#L91
          await UUPSProxy.callStatic.upgradeTo(OZ_UUPS_UPDATER_ADDRESS)
        } catch (e) {
          // The ChugSplashManager does not have permission to call the `upgradeTo` function on the
          // proxy, which means the user must grant it permission via whichever access control
          // mechanism the UUPS proxy uses.
          requiresOwnershipTransfer.push({
            name: referenceName,
            proxyAddress: contractConfig.address,
            currentAdminAddress: 'unknown',
          })
        }
      } else {
        const proxyAdmin = await getEIP1967ProxyAdminAddress(
          provider,
          contractConfig.address
        )

        if (proxyAdmin !== chugSplashManagerAddress) {
          requiresOwnershipTransfer.push({
            name: referenceName,
            proxyAddress: contractConfig.address,
            currentAdminAddress: proxyAdmin,
          })
        }
      }
    }
  }

  if (requiresOwnershipTransfer.length > 0) {
    logValidationError(
      'error',
      `Detected proxy contracts which are not managed by ChugSplash:`,
      [
        `${requiresOwnershipTransfer.map(
          ({ name, proxyAddress, currentAdminAddress }) =>
            `\n${name}: ${proxyAddress} | Current admin: ${currentAdminAddress}`
        )}
If you are using any Transparent proxies, you must transfer ownership of each to ChugSplash using the following command:
npx hardhat chugsplash-import --network <network> --config-path <path> --proxy <proxyAddress>
If you are using any UUPS proxies, you must give your ChugSplashManager contract ${chugSplashManagerAddress}
permission to call the 'upgradeTo' function on each of them.
    `,
      ],
      cre.silent,
      cre.stream
    )
  }

  for (const [referenceName, contractConfig] of Object.entries(
    parsedConfig.contracts
  )) {
    const { input, output } = readBuildInfo(
      artifactPaths[referenceName].buildInfoPath
    )
    const userContractConfig = userConfig.contracts[referenceName]

    // First we do some validation on the contract that doesn't depend on whether or not we're performing an upgrade
    // the validation happens automatically when we call `getOpenZeppelinUpgradableContract`.
    // We store the contract in a variable so that we can use it later to run the storage slot checker.
    let upgradableContract: UpgradeableContract | undefined

    // We skip this validation for 'no-proxy' contracts because the checks aren't relevant to them.
    if (contractConfig.kind !== 'no-proxy') {
      upgradableContract = getOpenZeppelinUpgradableContract(
        contractConfig.contract,
        input,
        output,
        contractConfig.kind,
        userContractConfig
      )

      // throw validation errors if detected
      if (upgradableContract.errors.length > 0) {
        logValidationError(
          'error',
          `Contract ${contractConfig.contract} is not upgrade safe`,
          [
            new UpgradeableContractErrorReport(
              upgradableContract.errors
            ).explain(),
          ],
          false,
          cre.stream
        )
      }
    }

    if (isUpgrade) {
      // Perform upgrade specific validation

      const isProxyDeployed =
        (await provider.getCode(contractConfig.address)) !== '0x'
      if (isProxyDeployed) {
        // If the deployment an upgrade, then the contract must be proxied and therfore upgradableContract
        // will always be defined so we can safely assert it.
        const newStorageLayout = upgradableContract!.layout

        const previousStorageLayout = await getPreviousStorageLayoutOZFormat(
          provider,
          referenceName,
          contractConfig,
          userContractConfig,
          canonicalConfigPath,
          cre
        )

        assertStorageCompatiblePreserveKeywords(
          contractConfig,
          previousStorageLayout,
          newStorageLayout,
          cre
        )

        if (
          // If the user has disabled storage checks for this contract
          userConfig.contracts[referenceName].unsafeSkipStorageCheck !== true
        ) {
          assertStorageUpgradeSafe(
            previousStorageLayout,
            newStorageLayout,
            getOpenZeppelinValidationOpts(
              contractConfig.kind,
              userContractConfig
            )
          )
        }
      }
    } else {
      // Perform initial deployment specific validation

      // Throw an error if the 'preserve' keyword is set to a variable's value in the
      // ChugSplash config file. This keyword is only allowed for upgrades.
      if (
        variableContainsKeyword(contractConfig.variables, keywords.preserve)
      ) {
        logValidationError(
          'error',
          'Detected the "{preserve}" keyword in a fresh deployment.',
          [
            'This keyword is reserved for upgrades only. Please remove all instances of it in your ChugSplash config file.',
          ],
          cre.silent,
          cre.stream
        )
      }
    }
  }

  return isUpgrade
}

export const assertValidContracts = (
  parsedConfig: ParsedChugSplashConfig,
  artifactPaths: ArtifactPaths,
  cre: ChugSplashRuntimeEnvironment
) => {
  for (const [referenceName, contractConfig] of Object.entries(
    parsedConfig.contracts
  )) {
    // Get the source name and contract name from its fully qualified name
    const [sourceName, contractName] = contractConfig.contract.split(':')

    const buildInfoPath = artifactPaths[referenceName].buildInfoPath
    const buildInfo = readBuildInfo(buildInfoPath)

    const sourceUnit = buildInfo.output.sources[sourceName].ast
    const decodeSrc = srcDecoder(buildInfo.input, buildInfo.output)
    const dereferencer = astDereferencer(buildInfo.output)

    // Get the ContractDefinition node for this `contractName`. There should only be one
    // ContractDefinition since we filter by the `contractName`, which is unique within a SourceUnit.
    const childContractDefs = sourceUnit.nodes
      .filter(isNodeType('ContractDefinition'))
      .filter((contractDef: ContractDefinition) => {
        return contractDef.name === contractName
      })

    if (childContractDefs.length !== 1) {
      throw new Error(
        `Found ${childContractDefs.length} ContractDefinition nodes instead of 1 for ${contractName}. Should never happen.`
      )
    }

    const childContractDef = childContractDefs[0]

    // Get the base (i.e. parent) ContractDefinition nodes for the child contract.
    const baseContractDefs = childContractDef.linearizedBaseContracts
      .map(dereferencer('ContractDefinition'))
      // Filter out the child ContractDefinition node, which is included in `linearizedBaseContracts`
      .filter((node: ContractDefinition) => node.id !== childContractDef.id)

    // Iterate over the child ContractDefinition node and its parent ContractDefinition nodes.
    for (const contractDef of baseContractDefs.concat(childContractDef)) {
      for (const node of contractDef.nodes) {
        if (
          isNodeType('FunctionDefinition', node) &&
          node.kind === 'constructor' &&
          node?.body?.statements
        ) {
          for (const statementNode of node.body.statements) {
            if (
              !isNodeType('ExpressionStatement', statementNode) ||
              !isNodeType('Assignment', statementNode.expression) ||
              !isNodeType(
                'Identifier',
                statementNode.expression.leftHandSide
              ) ||
              typeof statementNode.expression.leftHandSide
                .referencedDeclaration !== 'number' ||
              dereferencer(
                'VariableDeclaration',
                statementNode.expression.leftHandSide.referencedDeclaration
              ).mutability !== 'immutable' ||
              isNodeType('FunctionCall', statementNode.expression.rightHandSide)
            ) {
              logValidationError(
                'error',
                `Detected an unallowed expression in the constructor at: ${decodeSrc(
                  node
                )}.`,
                [
                  'Only immutable variable assignments are allowed in the constructor to ensure that ChugSplash',
                  'can deterministically deploy your contracts.',
                ],
                cre.silent,
                cre.stream
              )
            }
          }
        } else if (isNodeType('VariableDeclaration', node)) {
          if (node.mutability === 'mutable' && node.value) {
            logValidationError(
              'error',
              `Attempted to assign a value to a non-immutable state variable '${
                node.name
              }' at: ${decodeSrc(node)}`,
              [
                'This is not allowed because the value will not exist in the upgradeable contract.',
                'Please remove the value in the contract and define it in your ChugSplash file instead',
                `Alternatively, you can also set '${node.name}' to be a constant or immutable variable.`,
              ],
              cre.silent,
              cre.stream
            )
          } else if (
            node.mutability === 'immutable' &&
            node.value &&
            isNodeType('FunctionCall', node.value)
          ) {
            logValidationError(
              'error',
              `Attempted to assign the immutable variable '${
                node.name
              }' to the return value of a function call at: ${decodeSrc(
                node
              )}.`,
              [
                'This is not allowed to ensure that ChugSplash is deterministic. Please remove the function call.',
              ],
              cre.silent,
              cre.stream
            )
          }
        }
      }

      if (!contractConfig.unsafeAllowEmptyPush) {
        for (const memberAccessNode of findAll('MemberAccess', contractDef)) {
          const typeIdentifier =
            memberAccessNode.expression.typeDescriptions.typeIdentifier
          const isDynamicBytesOrArray =
            typeof typeIdentifier === 'string' &&
            (typeIdentifier === 't_bytes_storage' ||
              typeIdentifier.endsWith('dyn_storage'))

          // Log an error if calling `push()` with no parameters on a dynamic array or dynamic bytes.
          if (
            isDynamicBytesOrArray &&
            memberAccessNode.memberName === 'push' &&
            memberAccessNode.argumentTypes &&
            memberAccessNode.argumentTypes.length === 0
          ) {
            logValidationError(
              'error',
              `Detected the member function 'push()' at ${decodeSrc(
                memberAccessNode
              )}.`,
              [`Please use 'push(x)' instead.`],
              cre.silent,
              cre.stream
            )
          }
        }
      }
    }
  }
}

const logUnsafeOptions = (
  userConfig: UserChugSplashConfig,
  silent: boolean,
  stream: NodeJS.WritableStream
) => {
  for (const [referenceName, contractConfig] of Object.entries(
    userConfig.contracts
  )) {
    const lines: string[] = []
    if (contractConfig.unsafeAllow?.delegatecall) {
      lines.push('You are using the unsafe option `unsafeAllow.delegatecall`')
    }
    if (contractConfig.unsafeAllow?.selfdestruct) {
      lines.push('You are using the unsafe option `unsafeAllow.selfdestruct`')
    }
    if (contractConfig.unsafeAllow?.missingPublicUpgradeTo) {
      lines.push(
        'You are using the unsafe option`unsafeAllow.missingPublicUpgradeTo`'
      )
    }
    if (contractConfig.unsafeAllowRenames) {
      lines.push('You are using the unsafe option `unsafeAllowRenames`')
    }
    if (contractConfig.unsafeSkipStorageCheck) {
      lines.push('You are using the unsafe option `unsafeSkipStorageCheck`')
    }

    if (lines.length > 0) {
      chugsplashLog(
        'warning',
        `Potentially unsafe deployment of ${referenceName}`,
        lines,
        silent,
        stream
      )
    }
  }
}

export const assertValidConstructorArgs = (
  userConfig: UserChugSplashConfig,
  artifactPaths: ArtifactPaths,
  cre: ChugSplashRuntimeEnvironment,
  exitOnFailure: boolean,
  integration: Integration
): {
  cachedCompilerOutput: { [referenceName: string]: CompilerOutput }
  cachedConstructorArgs: { [referenceName: string]: ParsedConfigVariables }
  cachedArtifacts: { [referenceName: string]: ContractArtifact }
  contractReferences: { [referenceName: string]: string }
} => {
  const { projectName, organizationID, claimer } = userConfig.options
  const managerAddress = getChugSplashManagerAddress(claimer, organizationID)
  // We cache the compiler output, constructor args, and other artifacts so we don't have to read them multiple times.
  const cachedCompilerOutput = {}
  const cachedConstructorArgs = {}
  const contractReferences: { [referenceName: string]: string } = {}
  const cachedArtifacts = {}

  // Determine the addresses for all proxied contracts and cache the artifacts.
  for (const [referenceName, userContractConfig] of Object.entries(
    userConfig.contracts
  )) {
    const { externalProxy, kind } = userContractConfig

    const artifact = readContractArtifact(
      artifactPaths[referenceName].contractArtifactPath,
      integration
    )
    cachedArtifacts[referenceName] = artifact

    if (kind === 'no-proxy') {
      // prevents references to no-proxy contracts from being resolved to '' during the first pass compilation
      contractReferences[referenceName] = `{{ ${referenceName} }}`
      continue
    }

    // Set the proxy address to the user-defined value if it exists, otherwise set it to the default proxy
    // used by ChugSplash.
    const proxy =
      externalProxy ||
      getDefaultProxyAddress(
        claimer,
        organizationID,
        projectName,
        referenceName
      )

    contractReferences[referenceName] = proxy
  }

  userConfig = JSON.parse(
    Handlebars.compile(JSON.stringify(userConfig))({
      ...contractReferences,
    })
  )

  // Parse and validate all the constructor arguments, resolving any references to proxied contracts
  for (const [referenceName, userContractConfig] of Object.entries(
    userConfig.contracts
  )) {
    const { output } = readBuildInfo(artifactPaths[referenceName].buildInfoPath)
    cachedCompilerOutput[referenceName] = output

    const artifact = cachedArtifacts[referenceName]
    const { abi } = artifact

    const args = parseContractConstructorArgs(
      userContractConfig,
      referenceName,
      abi,
      cre
    )
    cachedConstructorArgs[referenceName] = args
  }

  // Resolve any no-proxy contract addresses that are left
  // We have do this separately b/c we need to parse all the constructor args and resolve all the proxied contract addresses
  // before we can resolve the addresses of no-proxy contracts which might include contract references in their contructor args
  for (const [referenceName, userContractConfig] of Object.entries(
    userConfig.contracts
  )) {
    const { kind } = userContractConfig

    if (kind !== 'no-proxy') {
      continue
    }

    const artifact = cachedArtifacts[referenceName]

    contractReferences[referenceName] = getContractAddress(
      managerAddress,
      cachedConstructorArgs[referenceName],
      artifact
    )
  }

  // Finally we compile the entire config to resolve references to all contracts throughout the entire config
  const compiledConstructorArgs = JSON.parse(
    Handlebars.compile(JSON.stringify(cachedConstructorArgs))({
      ...contractReferences,
    })
  )

  // Exit if any validation errors were detected up to this point. We exit early here because invalid
  // constructor args can cause the rest of the parsing logic to fail with cryptic errors
  if (validationErrors && exitOnFailure) {
    process.exit(1)
  }

  // We return the cached values so we can use them in later steps without rereading the files
  return {
    cachedCompilerOutput,
    cachedConstructorArgs: compiledConstructorArgs,
    cachedArtifacts,
    contractReferences,
  }
}

const assertValidContractVariables = (
  userConfig: UserChugSplashConfig,
  cachedCompilerOutput: {
    [referenceName: string]: CompilerOutput
  },
  cachedArtifacts: {
    [referenceName: string]: ContractArtifact
  },
  contractReferences: { [referenceName: string]: string },
  cre: ChugSplashRuntimeEnvironment
): { [referenceName: string]: ParsedConfigVariables } => {
  const parsedVariables: { [referenceName: string]: ParsedConfigVariables } = {}
  for (const [referenceName, userContractConfig] of Object.entries(
    userConfig.contracts
  )) {
    if (userContractConfig.kind === 'no-proxy') {
      if (
        userContractConfig.variables &&
        Object.entries(userContractConfig.variables).length > 0
      ) {
        logValidationError(
          'error',
          `Detected variables for contract '${referenceName}', but variables are not supported for non-proxied contracts.`,
          [],
          cre.silent,
          cre.stream
        )
      }
      parsedVariables[referenceName] = {}
    } else {
      const artifact = cachedArtifacts[referenceName]
      const { sourceName, contractName } = artifact

      const compilerOutput = cachedCompilerOutput[referenceName]
      const storageLayout = getStorageLayout(
        compilerOutput,
        sourceName,
        contractName
      )

      const parsedContractVariables = parseContractVariables(
        JSON.parse(
          Handlebars.compile(JSON.stringify(userContractConfig))({
            ...contractReferences,
          })
        ),
        storageLayout,
        compilerOutput,
        cre
      )

      parsedVariables[referenceName] = parsedContractVariables
    }
  }

  return parsedVariables
}

const constructParsedConfig = (
  userConfig: UserChugSplashConfig,
  cachedArtifacts: {
    [referenceName: string]: ContractArtifact
  },
  contractReferences: { [referenceName: string]: string },
  parsedVariables: { [referenceName: string]: ParsedConfigVariables },
  cachedConstructorArgs: { [referenceName: string]: ParsedConfigVariables }
): ParsedChugSplashConfig => {
  const parsedConfig: ParsedChugSplashConfig = {
    options: userConfig.options,
    contracts: {},
  }
  for (const [referenceName, userContractConfig] of Object.entries(
    userConfig.contracts
  )) {
    // Change the `contract` fields to be a fully qualified name. This ensures that it's easy for the
    // executor to create the `ConfigArtifacts` when it eventually compiles the canonical
    // config.
    const artifact = cachedArtifacts[referenceName]
    const { sourceName, contractName } = artifact
    const contractFullyQualifiedName = `${sourceName}:${contractName}`

    parsedConfig.contracts[referenceName] = {
      contract: contractFullyQualifiedName,
      address: contractReferences[referenceName],
      kind: userContractConfig.kind ?? 'internal-default',
      variables: parsedVariables[referenceName],
      constructorArgs: cachedConstructorArgs[referenceName],
    }
  }

  return parsedConfig
}

/**
 * Parses a ChugSplash config file from the config file given by the user.
 *
 * @param userConfig Unparsed config file to parse.
 * @param env Environment variables to inject into the file.
 * @return Parsed config file with template variables replaced.
 */
export const parseAndValidateChugSplashConfig = async (
  provider: providers.JsonRpcProvider,
  userConfig: UserChugSplashConfig,
  artifactPaths: ArtifactPaths,
  integration: Integration,
  cre: ChugSplashRuntimeEnvironment,
  exitOnFailure: boolean = true
): Promise<ParsedChugSplashConfig> => {
  // Just in case, we reset the global validation errors flag before parsing
  validationErrors = false

  // If the user disabled some safety checks, log warnings related to that
  logUnsafeOptions(userConfig, cre.silent, cre.stream)

  await assertValidBlockGasLimit(provider)

  // Validate top level config and contract options
  await assertValidUserConfigFields(userConfig, provider, cre, exitOnFailure)

  // Parse and validate contract constructor args
  // During this function, we also resolve all contract references throughout the entire config b/c constructor args may impact contract addresses
  // We also cache the compiler output, parsed constructor args, and other artifacts so we don't have to re-read them later
  const {
    cachedCompilerOutput,
    cachedConstructorArgs,
    cachedArtifacts,
    contractReferences,
  } = assertValidConstructorArgs(
    userConfig,
    artifactPaths,
    cre,
    exitOnFailure,
    integration
  )

  // Parse and validate contract variables
  const parsedVariables = assertValidContractVariables(
    userConfig,
    cachedCompilerOutput,
    cachedArtifacts,
    contractReferences,
    cre
  )

  // Construct the parsed config
  const parsedConfig = constructParsedConfig(
    userConfig,
    cachedArtifacts,
    contractReferences,
    parsedVariables,
    cachedConstructorArgs
  )

  // Validate the contracts
  assertValidContracts(parsedConfig, artifactPaths, cre)

  if (await isLiveNetwork(provider)) {
    await assertContractsBelowSizeLimit(parsedConfig, cachedArtifacts, cre)
  }

  await assertValidDeploymentSize(provider, parsedConfig, cre)

  // Complete misc pre-deploy validation
  // I.e run storage slot checker + other safety checks, detect if the deployment is an upgrade, etc
  const upgrade = await assertValidParsedChugSplashFile(
    provider,
    parsedConfig,
    userConfig,
    artifactPaths,
    cre
  )

  // Exit if validation errors are detected
  // We also allow the user to disable this behavior by setting `exitOnFailure` to false.
  // This is useful for testing.
  if (validationErrors && exitOnFailure) {
    process.exit(1)
  }

  // Confirm upgrade with user
  if (!cre.autoConfirm && upgrade) {
    const userConfirmed = await yesno({
      question: `Prior deployment(s) detected for project ${userConfig.options.projectName}. Would you like to perform an upgrade? (y/n)`,
    })
    if (!userConfirmed) {
      throw new Error(`User denied upgrade.`)
    }
  }

  return parsedConfig
}

/**
 * Asserts that the ChugSplash config can be initiated in a single transaction.
 */
export const assertValidDeploymentSize = async (
  provider: providers.Provider,
  parsedConfig: ParsedChugSplashConfig,
  cre: ChugSplashRuntimeEnvironment
) => {
  const { gasLimit: blockGasLimit } = await provider.getBlock('latest')

  const deployedProxyPromises = Object.values(parsedConfig.contracts).map(
    async (contract) =>
      contract.kind === 'internal-default' &&
      !(await isContractDeployed(contract.address, provider))
        ? ethers.BigNumber.from(550_000)
        : ethers.BigNumber.from(0)
  )

  const resolvedPromises = await Promise.all(deployedProxyPromises)

  const defaultProxyGasCosts = resolvedPromises.reduce(
    (a, b) => a.add(b),
    ethers.BigNumber.from(0)
  )

  const numTargets = Object.values(parsedConfig.contracts).filter(
    (contract) => contract.kind !== 'no-proxy'
  ).length
  const initiationGasCost = ethers.BigNumber.from(100_000).mul(numTargets)

  const totalInitiationGasCost = defaultProxyGasCosts.add(initiationGasCost)
  const costWithBuffer = totalInitiationGasCost.mul(12).div(10)

  if (costWithBuffer.gt(blockGasLimit)) {
    logValidationError(
      'error',
      `Too many contracts in your ChugSplash config.`,
      [],
      cre.silent,
      cre.stream
    )
  }
}

/**
 * Asserts that the contracts in the parsed config are below the contract size limit (24576 bytes).
 */
export const assertContractsBelowSizeLimit = async (
  parsedConfig: ParsedChugSplashConfig,
  artifacts: {
    [referenceName: string]: ContractArtifact
  },
  cre: ChugSplashRuntimeEnvironment
) => {
  const tooLarge: string[] = []
  for (const [referenceName, contractConfig] of Object.entries(
    parsedConfig.contracts
  )) {
    const deployedBytecode = artifacts[referenceName].deployedBytecode

    const numBytes = (deployedBytecode.length - 2) / 2
    if (numBytes > CONTRACT_SIZE_LIMIT) {
      tooLarge.push(contractConfig.contract)
    }
  }

  if (tooLarge.length > 0) {
    const uniqueNames = [...new Set(tooLarge)]
    logValidationError(
      'error',
      `The following contracts are too large to be deployed on a live network:`,
      uniqueNames.map((name) => `  - ${name}`),
      cre.silent,
      cre.stream
    )
  }
}
