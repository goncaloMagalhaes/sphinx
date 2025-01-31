import { SphinxSystemConfig } from '../src'

// Used to deploy on:
// Goerli, Optimism Goerli, Arbitrum Goerli, Gnosis Chaido, Matic Mumbai, Binance Smart Chain Testnet

const config: SphinxSystemConfig = {
  executors: [
    '0x42761FAcF5e6091fcA0e38F450adfB1E22bD8c3C',
    '0x4F2107d09B095B92f80ecd5b66C4004B87DC2652',
    '0x791Cf9e43E0ca66b470E2a82Ec103d9e712623e2',
  ],
  relayers: [
    '0xC034550B542b83BA1De312b21d1C94a9a52B1595',
    '0x808923399391944164220074Ef3Cc6ad4701526f',
    '0xb7e97060DE2DFfDcB39d765079A3ddd07d6E30A2',
  ],
  funders: [
    '0xC034550B542b83BA1De312b21d1C94a9a52B1595',
    '0x808923399391944164220074Ef3Cc6ad4701526f',
    '0xb7e97060DE2DFfDcB39d765079A3ddd07d6E30A2',
  ],
}

export default config
