import hre, { ethers } from 'hardhat'
import '../dist' // Imports Sphinx type extensions for Hardhat
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import {
  FailureAction,
  UserSphinxConfig,
  ensureSphinxInitialized,
  getAuthAddress,
  getParsedConfig,
  getParsedConfigWithOptions,
  getSphinxManagerAddress,
  readUserConfig,
  readUserConfigWithOptions,
  REFERENCE_NAME_CANNOT_BE_SPHINX_MANAGER,
} from '@sphinx-labs/core'
import '@nomicfoundation/hardhat-ethers'

import { createSphinxRuntime } from '../src/cre'
import { makeGetConfigArtifacts } from '../src/hardhat/artifacts'

chai.use(chaiAsPromised)
const expect = chai.expect

const validationConfigPath = './sphinx/validation/Validation.config.ts'
const constructorArgValidationConfigPath =
  './sphinx/validation/ConstructorArgValidation.config.ts'
const reverterConfigPath = './sphinx/validation/Reverter.config.ts'
const overriddenConfigPath =
  './sphinx/validation/OverrideArgValidation.config.ts'

describe('Validate', () => {
  let validationOutput = ''

  const cre = createSphinxRuntime(
    'hardhat',
    false,
    hre.config.networks.hardhat.allowUnlimitedContractSize,
    true,
    hre.config.paths.compilerConfigs,
    hre,
    false,
    process.stderr
  )
  const provider = hre.ethers.provider

  before(async () => {
    const signer = await provider.getSigner()
    const signerAddress = await signer.getAddress()
    process.stderr.write = (message: string) => {
      validationOutput += message
      return true
    }

    await ensureSphinxInitialized(provider, signer)

    try {
      await getParsedConfig(
        await readUserConfig(validationConfigPath),
        provider,
        cre,
        makeGetConfigArtifacts(hre),
        signerAddress,
        FailureAction.THROW
      )
    } catch (e) {
      /* empty */
    }

    try {
      await getParsedConfig(
        await readUserConfig(constructorArgValidationConfigPath),
        provider,
        cre,
        makeGetConfigArtifacts(hre),
        signerAddress,
        FailureAction.THROW
      )
    } catch (e) {
      /* empty */
    }

    try {
      await getParsedConfig(
        await readUserConfig(reverterConfigPath),
        provider,
        cre,
        makeGetConfigArtifacts(hre),
        signerAddress,
        FailureAction.THROW
      )
    } catch (e) {
      /* empty */
    }

    try {
      const userConfig = await readUserConfigWithOptions(overriddenConfigPath)
      const authAddress = getAuthAddress(
        userConfig.options.owners,
        userConfig.options.ownerThreshold,
        userConfig.projectName
      )
      const managerAddress = getSphinxManagerAddress(
        authAddress,
        userConfig.projectName
      )

      await getParsedConfigWithOptions(
        userConfig,
        managerAddress,
        true,
        provider,
        cre,
        makeGetConfigArtifacts(hre),
        FailureAction.THROW
      )
    } catch (e) {
      /* empty */
    }
  })

  it('did catch invalid variable arrayInt8', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable arrayInt8 expected number, string, or BigNumber but got array'
    )
  })

  it('did catch invalid variable int8OutsideRange', async () => {
    expect(validationOutput).to.have.string(
      'invalid value for int8OutsideRange: 255, outside valid range: [-128:127]'
    )
  })

  it('did catch invalid variable uint8OutsideRange', async () => {
    expect(validationOutput).to.have.string(
      'invalid value for uint8OutsideRange: 256, outside valid range: [0:255]'
    )
  })

  it('did catch invalid variable intAddress', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for intAddress: 1, expected address string but got number'
    )
  })

  it('did catch invalid variable arrayAddress', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for arrayAddress: 0x00000000, expected address string but got array'
    )
  })

  it('did catch invalid variable shortAddress', async () => {
    expect(validationOutput).to.have.string(
      'invalid address for shortAddress: 0x00000000'
    )
  })

  it('did catch invalid variable intBytes32', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for intBytes32: 1, expected DataHexString but got number'
    )
  })

  it('did catch invalid variable arrayBytes32', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for arrayBytes32: 1, expected DataHexString but got array'
    )
  })

  it('did catch invalid variable shortBytes32', async () => {
    expect(validationOutput).to.have.string(
      'invalid length for bytes32 variable shortBytes32: 0x00000000'
    )
  })

  it('did catch invalid variable longBytes8', async () => {
    expect(validationOutput).to.have.string(
      'invalid length for bytes8 variable longBytes8: 0x1111111111111111111111111111111111111111111111111111111111111111'
    )
  })

  it('did catch invalid variable malformedBytes16', async () => {
    expect(validationOutput).to.have.string(
      'invalid input format for variable malformedBytes16, expected DataHexString but got 11111111111111111111111111111111'
    )
  })

  it('did catch invalid variable intBoolean', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable intBoolean, expected boolean but got number'
    )
  })

  it('did catch invalid variable stringBoolean', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable stringBoolean, expected boolean but got string'
    )
  })

  it('did catch invalid variable arrayBoolean', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable arrayBoolean, expected boolean but got array'
    )
  })

  it('did catch odd fixed bytes variable', async () => {
    expect(validationOutput).to.have.string(
      'invalid input format for variable oddStaticBytes, expected DataHexString but got'
    )
  })

  it('did catch invalid constructor arg _arrayInt8', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable _arrayInt8 expected number, string, or BigNumber but got array'
    )
  })

  it('did catch invalid constructor arg _int8OutsideRange', async () => {
    expect(validationOutput).to.have.string(
      'invalid value for _int8OutsideRange: 255, outside valid range: [-128:127]'
    )
  })

  it('did catch invalid constructor arg _uint8OutsideRange', async () => {
    expect(validationOutput).to.have.string(
      'invalid value for _uint8OutsideRange: 256, outside valid range: [0:255]'
    )
  })

  it('did catch invalid constructor arg _intAddress', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for _intAddress: 1, expected address string but got number'
    )
  })

  it('did catch invalid constructor arg _arrayAddress', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for _arrayAddress: 0x00000000, expected address string but got array'
    )
  })

  it('did catch invalid constructor arg _shortAddress', async () => {
    expect(validationOutput).to.have.string(
      'invalid address for _shortAddress: 0x00000000'
    )
  })

  it('did catch invalid constructor arg _intBytes32', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for _intBytes32: 1, expected DataHexString but got number'
    )
  })

  it('did catch invalid constructor arg _arrayBytes32', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for _arrayBytes32: 1, expected DataHexString but got array'
    )
  })

  it('did catch invalid constructor arg _shortBytes32', async () => {
    expect(validationOutput).to.have.string(
      'invalid length for bytes32 variable _shortBytes32: 0x00000000'
    )
  })

  it('did catch invalid constructor arg _longBytes8', async () => {
    expect(validationOutput).to.have.string(
      'invalid length for bytes8 variable _longBytes8: 0x1111111111111111111111111111111111111111111111111111111111111111'
    )
  })

  it('did catch invalid constructor arg _malformedBytes16', async () => {
    expect(validationOutput).to.have.string(
      'invalid input format for variable _malformedBytes16, expected DataHexString but got 11111111111111111111111111111111'
    )
  })

  it('did catch invalid constructor arg _intBoolean', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable _intBoolean, expected boolean but got number'
    )
  })

  it('did catch invalid constructor arg _stringBoolean', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable _stringBoolean, expected boolean but got string'
    )
  })

  it('did catch invalid constructor arg _arrayBoolean', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable _arrayBoolean, expected boolean but got array'
    )
  })

  it('did catch odd fixed bytes constructor arg', async () => {
    expect(validationOutput).to.have.string(
      'invalid input format for variable _oddStaticBytes, expected DataHexString but got'
    )
  })

  it('did catch invalid oversizedArray', async () => {
    expect(validationOutput).to.have.string(
      'Expected array of size 2 for oversizedArray but got [1,2,3]'
    )
  })

  it('did catch invalid oversizedNestedArray', async () => {
    expect(validationOutput).to.have.string(
      'Expected array of size 2 for oversizedNestedArray but got [[1,2],[1,2],[1,2]]'
    )
  })

  it('did catch invalid invalidBoolArray', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable invalidBoolArray, expected boolean but got string'
    )
  })

  it('did catch invalid invalidBytes32Array', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for invalidBytes32Array: 1, expected DataHexString but got number'
    )
  })

  it('did catch invalid invalidAddressArray', async () => {
    expect(validationOutput).to.have.string(
      'invalid address for invalidAddressArray: 0x00000000'
    )
  })

  it('did catch invalid invalidStringStringMapping', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for invalidStringStringMapping, expected DataHexString but got number'
    )
  })

  it('did catch invalid invalidStringIntMapping', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable invalidStringIntMapping expected number, string, or BigNumber but got boolean'
    )
  })

  it('did catch invalid invalidNestedStringIntBoolMapping', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable invalidNestedStringIntBoolMapping expected number, string, or BigNumber but got boolean'
    )
  })

  it('did catch struct with extra member', async () => {
    expect(validationOutput).to.have.string(
      'Extra member(s) detected in struct VariableValidation.SimpleStruct, extraMemberStruct: c'
    )
  })

  it('did catch struct with missing member', async () => {
    expect(validationOutput).to.have.string(
      'Missing member(s) in struct struct VariableValidation.SimpleStruct, missingMemberStruct: a'
    )
  })

  it('did catch missing variables', async () => {
    expect(validationOutput).to.have.string(
      'were not defined in the Sphinx config file'
    )
    expect(validationOutput).to.have.string('notSetUint')
    expect(validationOutput).to.have.string('notSetString')
  })

  it('did catch extra variables', async () => {
    expect(validationOutput).to.have.string(
      'defined in the Sphinx config file which do not exist in the contract'
    )
    expect(validationOutput).to.have.string('extraVar')
    expect(validationOutput).to.have.string('anotherExtraVar')
  })

  it('did catch odd dynamic bytes', async () => {
    expect(validationOutput).to.have.string(
      'invalid input type for variable oddDynamicBytes, expected DataHexString but got'
    )
  })

  it('did catch extra constructor argument', async () => {
    expect(validationOutput).to.have.string(
      `The config contains arguments in the constructor of ConstructorArgsValidationPartOne which do not exist in the contract:\n` +
        `_immutableUint`
    )
    expect(validationOutput).to.have.string('_immutableUint')
  })

  it('did catch missing constructor argument', async () => {
    expect(validationOutput).to.have.string(
      `The config is missing the following arguments for the constructor of ConstructorArgsValidationPartOne:\n` +
        `_immutableBytes`
    )
  })

  it('did catch variables in immutable contract', async () => {
    expect(validationOutput).to.have.string(
      `Detected variables for contract 'Stateless', but variables are not supported for non-proxied contracts.`
    )
  })

  it('did catch invalid definition of function type', async () => {
    expect(validationOutput).to.have.string(
      `Detected value for functionType which is a function. Function variables should be ommitted from your Sphinx config.`
    )
  })

  it('did catch invalid array base type in constructor arg', async () => {
    expect(validationOutput).to.have.string(
      `invalid value for _invalidBaseTypeArray, expected a valid number but got: hello`
    )
  })

  it('did catch invalid nested array base type in constructor arg', async () => {
    expect(validationOutput).to.have.string(
      `invalid value for _invalidNestedBaseTypeArray, expected a valid number but got: hello`
    )
  })

  it('did catch incorrect array size in constructor arg', async () => {
    expect(validationOutput).to.have.string(
      `Expected array of length 2 for _incorrectlySizedArray but got array of length 5`
    )
  })

  it('did catch incorrect nested array size in constructor arg', async () => {
    expect(validationOutput).to.have.string(
      `Expected array of length 2 for _incorrectlySizedNestedArray but got array of length 3`
    )
  })

  it('did catch incorrect member in constructor arg struct', async () => {
    expect(validationOutput).to.have.string(
      `Extra member(s) in struct _structMissingMembers: z`
    )
  })

  it('did catch struct with missing members in constructor arg', async () => {
    expect(validationOutput).to.have.string(
      `Missing member(s) in struct _structMissingMembers: b`
    )
  })

  it('did catch non-proxy contract constructor reverting', async () => {
    expect(validationOutput).to.have.string(
      `The following constructors will revert:`
    )
    expect(validationOutput).to.have.string(
      `- Reverter1. Reason: 'Reverter: revert'`
    )
    expect(validationOutput).to.have.string(
      `- Reverter2. Reason: 'Reverter: revert'`
    )
  })

  it('did catch missing contract kind field', async () => {
    expect(validationOutput).to.have.string(
      `Missing contract 'kind' field for VariableValidation`
    )
  })

  it('did catch incorrect overridden contructor args', async () => {
    expect(validationOutput).to.have.string(
      `The config contains argument overrides in the constructor of IncorrectConstructorArgOverrides which do not exist in the contract.`
    )
    expect(validationOutput).to.have.string(
      `incorrectOverrideArg on network: anvil`
    )
    expect(validationOutput).to.have.string(
      `otherIncorrectOverrideArg on network: anvil`
    )
  })

  it('did catch reference name called SphinxManager', async () => {
    const invalidUserConfig: UserSphinxConfig = {
      projectName: 'Validation',
      contracts: {
        SphinxManager: {
          contract: 'MyCntract1',
          kind: 'immutable',
        },
      },
    }

    try {
      await getParsedConfig(
        invalidUserConfig,
        provider,
        cre,
        makeGetConfigArtifacts(hre),
        ethers.ZeroAddress,
        FailureAction.THROW
      )
    } catch {
      // Do nothing.
    }

    expect(validationOutput).to.have.string(
      REFERENCE_NAME_CANNOT_BE_SPHINX_MANAGER
    )
  })
})
