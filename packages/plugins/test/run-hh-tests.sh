#!/bin/bash

# kill $(lsof -t -i:8545) # TODO: rm

# This setting ensures that this script will exit if any subsequent command in this script fails.
# Without this, the CI process will pass even if tests in this script fail.
set -e

# anvil --silent &
npx hardhat test test/ValidateTask.spec.ts
# kill $(lsof -t -i:8545)

# TODO
# npx hardhat test test/ManagerUpgrade.spec.ts --config-path \
#   sphinx/manager-upgrade.config.ts --signer 8 &&
# npx hardhat test test/Validation.spec.ts test/ContractReferences.spec.ts test/Create3.spec.ts
# npx hardhat test test/Storage.spec.ts --log --config-path sphinx/Storage.config.ts --signer 0

# # We spin up a few nodes to simulate a multi-chain deployment
# anvil --silent &
# anvil --silent --chain-id 5 --port 42005 &
# anvil --silent --chain-id 420 --port 42420 &
# anvil --silent --chain-id 10200 --port 42200 &
# anvil --silent --chain-id 421613 --port 42613 &
# anvil --silent --chain-id 84531 --port 42531 &
# npx hardhat test test/MultiChain.spec.ts
# yarn test:kill

# # We spin up a few nodes to test multi-chain overrides
# anvil --silent &
# anvil --silent --chain-id 5 --port 42005 &
# anvil --silent --chain-id 420 --port 42420 &
# anvil --silent --chain-id 10200 --port 42200 &
# anvil --silent --chain-id 421613 --port 42613 &
# anvil --silent --chain-id 84531 --port 42531 &
# npx hardhat test test/ChainOverrides.spec.ts
# yarn test:kill

# # Spin up a few nodes to test post-deployment actions
# anvil --silent &
# anvil --silent --chain-id 5 --port 42005 &
# anvil --silent --chain-id 420 --port 42420 &
# anvil --silent --chain-id 10200 --port 42200 &
# anvil --silent --chain-id 421613 --port 42613 &
# anvil --silent --chain-id 84531 --port 42531 &
# npx hardhat test test/PostDeploymentActions.spec.ts
# yarn test:kill
