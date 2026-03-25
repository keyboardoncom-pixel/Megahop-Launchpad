import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const {
  MEGAETH_MAINNET_RPC_URL,
  MEGAETH_TESTNET_RPC_URL,
  PRIVATE_KEY,
  MEGAETH_ETHERSCAN_API_KEY,
  MEGAETH_TESTNET_EXPLORER_API_KEY,
} = process.env;

const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    megaeth: {
      url: MEGAETH_MAINNET_RPC_URL || "https://mainnet.megaeth.com/rpc",
      accounts,
      chainId: 4326,
    },
    megaethTestnet: {
      url: MEGAETH_TESTNET_RPC_URL || "https://carrot.megaeth.com/rpc",
      accounts,
      chainId: 6343,
    },
  },
  etherscan: {
    apiKey: MEGAETH_ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "megaeth",
        chainId: 4326,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://mega.etherscan.io",
        },
      },
      {
        network: "megaethTestnet",
        chainId: 6343,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://megaeth-testnet-v2.blockscout.com",
        },
      },
    ],
  },
};

export default config;
