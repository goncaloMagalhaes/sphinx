import path from 'path'

import {
  ChugSplashConfig,
  parseChugSplashConfig,
  writeSnapshotId,
} from '@chugsplash/core'
import { TASK_COMPILE, TASK_CLEAN } from 'hardhat/builtin-tasks/task-names'

export const writeHardhatSnapshotId = async (hre: any) => {
  const networkName = hre.network.name === 'localhost' ? 'localhost' : 'hardhat'
  await writeSnapshotId(
    networkName,
    hre.config.paths.deployed,
    await hre.network.provider.send('evm_snapshot', [])
  )
}

/**
 * Clean the artifacts directory and re-compile it to ensure that we have the latest artifacts.
 *
 * @param hre Hardhat runtime environment
 */
export const cleanAndCompile = async (hre: any) => {
  // Clean the artifacts to ensure that we're working with the latest build info.
  await hre.run(TASK_CLEAN, {
    quiet: true,
  })
  // Make sure we have the latest compiled code.
  await hre.run(TASK_COMPILE, {
    quiet: true,
  })
}

/**
 * Loads a ChugSplash config file synchronously.
 *
 * @param configPath Path to the ChugSplash config file.
 */
export const loadParsedChugSplashConfig = (
  configPath: string
): ChugSplashConfig => {
  delete require.cache[require.resolve(path.resolve(configPath))]

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let config = require(path.resolve(configPath))
  config = config.default || config
  return parseChugSplashConfig(config, process.env)
}
