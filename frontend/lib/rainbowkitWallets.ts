"use client";

import { metaMaskWallet, phantomWallet, rabbyWallet } from "@rainbow-me/rainbowkit/wallets";

export type BrowserWalletId = "io.metamask" | "app.phantom" | "io.rabby";

export type WalletDescriptor = {
  id: BrowserWalletId;
  label: string;
  subtitle: string;
  icon: string;
};

const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "Megahop";
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

const baseWallets = [
  {
    id: "io.metamask" as const,
    createWallet: metaMaskWallet,
    fallbackLabel: "MetaMask",
    fallbackSubtitle: "Browser & Mobile",
    fallbackIcon: "/wallets/metamask.svg",
  },
  {
    id: "app.phantom" as const,
    createWallet: phantomWallet,
    fallbackLabel: "Phantom",
    fallbackSubtitle: "Browser Wallet",
    fallbackIcon: "/wallets/phantom.svg",
  },
  {
    id: "io.rabby" as const,
    createWallet: rabbyWallet,
    fallbackLabel: "Rabby Wallet",
    fallbackSubtitle: "Browser Wallet",
    fallbackIcon: "/wallets/rabby.png",
  },
] as const;

const createRainbowWallet = (createWallet: (params?: any) => any) =>
  createWallet({
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

export const rainbowkitWallets = baseWallets.map((item) => {
  const wallet = createRainbowWallet(item.createWallet);
  const iconSource = wallet.iconUrl;

  return {
    id: item.id,
    rkId: wallet.id,
    label: wallet.name || item.fallbackLabel,
    subtitle: item.fallbackSubtitle,
    icon: typeof iconSource === "string" ? iconSource : item.fallbackIcon,
    iconLoader:
      typeof iconSource === "function"
        ? async () => {
            try {
              return await iconSource();
            } catch {
              return item.fallbackIcon;
            }
          }
        : undefined,
    createWallet: item.createWallet,
  };
});

export const buildWalletDescriptors = (): WalletDescriptor[] =>
  rainbowkitWallets.map((wallet) => ({
    id: wallet.id,
    label: wallet.label,
    subtitle: wallet.subtitle,
    icon: wallet.icon,
  }));

export const loadRainbowKitWalletIcons = async () => {
  const entries = await Promise.all(
    rainbowkitWallets.map(async (wallet) => [
      wallet.id,
      wallet.iconLoader ? await wallet.iconLoader() : wallet.icon,
    ]),
  );
  return Object.fromEntries(entries) as Record<BrowserWalletId, string>;
};
