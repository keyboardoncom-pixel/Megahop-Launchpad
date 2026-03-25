"use client";

import { useState, type ReactNode } from "react";
import { metaMaskWallet, phantomWallet, rabbyWallet } from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig } from "wagmi";
import { defineChain, http } from "viem";
import { WalletProvider } from "../lib/wallet";

type ClientThirdwebProviderProps = {
  children: ReactNode;
};

const TARGET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 4326);
const TARGET_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.megaeth.com/rpc";
const TARGET_NETWORK_NAME = process.env.NEXT_PUBLIC_NETWORK_NAME || "MegaETH Mainnet";
const TARGET_EXPLORER_URL = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "https://mega.etherscan.io";
const TARGET_NATIVE_SYMBOL = process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH";
const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "Megahop";
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

const megaEthChain = defineChain({
  id: TARGET_CHAIN_ID,
  name: TARGET_NETWORK_NAME,
  nativeCurrency: {
    name: TARGET_NATIVE_SYMBOL,
    symbol: TARGET_NATIVE_SYMBOL,
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [TARGET_RPC_URL],
    },
    public: {
      http: [TARGET_RPC_URL],
    },
  },
  blockExplorers: TARGET_EXPLORER_URL
    ? {
        default: {
          name: "MegaETH Explorer",
          url: TARGET_EXPLORER_URL,
        },
      }
    : undefined,
});

const recommendedWallets = [metaMaskWallet, phantomWallet, rabbyWallet].map((createWallet, index) => {
  const wallet = createWallet({
    projectId: WALLETCONNECT_PROJECT_ID,
    walletConnectParameters: {
      metadata: {
        name: BRAND_NAME,
        description: `${BRAND_NAME} official mint`,
        url: "https://megahop-launchpad.brianlarrystorn.workers.dev",
        icons: [],
      },
    },
  } as any);

  return wallet.createConnector({
    rkDetails: {
      id: wallet.id,
      name: wallet.name,
      rdns: wallet.rdns,
      iconUrl: wallet.iconUrl,
      iconAccent: wallet.iconAccent,
      iconBackground: wallet.iconBackground,
      installed: wallet.installed,
      downloadUrls: wallet.downloadUrls,
      mobile: wallet.mobile,
      desktop: wallet.desktop,
      qrCode: wallet.qrCode,
      extension: wallet.extension,
      shortName: wallet.shortName,
      groupIndex: 0,
      index,
      groupName: "Recommended",
      isRainbowKitConnector: true,
    } as any,
  });
});

const wagmiConfig = createConfig({
  chains: [megaEthChain],
  connectors: recommendedWallets,
  transports: {
    [megaEthChain.id]: http(TARGET_RPC_URL),
  },
  ssr: false,
});

export default function ClientThirdwebProvider({ children }: ClientThirdwebProviderProps) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>{children}</WalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
