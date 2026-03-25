"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ethers } from "ethers";

declare global {
  interface Window {
    ethereum?: any;
    phantom?: {
      ethereum?: any;
    };
  }
}

export type BrowserWalletId =
  | "io.metamask"
  | "app.phantom"
  | "io.rabby"
  | "com.coinbase.wallet"
  | "com.okx.wallet"
  | "com.trustwallet";

type WalletDescriptor = {
  id: BrowserWalletId;
  label: string;
  subtitle: string;
  icon: string;
};

type WalletAccount = {
  address: string;
  signMessage: (message: string) => Promise<string>;
};

type WalletChain = {
  id: number;
  name?: string;
};

type WalletContextValue = {
  account: WalletAccount | null;
  chain: WalletChain | null;
  connectionStatus: "disconnected" | "connecting" | "connected";
  wallet: WalletDescriptor | null;
  provider: any | null;
  walletOptions: WalletDescriptor[];
  connectWallet: (walletId: BrowserWalletId) => Promise<void>;
  disconnectWallet: () => void;
  switchToTargetChain: () => Promise<void>;
};

const WALLET_OPTIONS: WalletDescriptor[] = [
  {
    id: "io.metamask",
    label: "MetaMask",
    subtitle: "Browser & Mobile",
    icon: "/wallets/metamask.svg",
  },
  {
    id: "app.phantom",
    label: "Phantom",
    subtitle: "Browser Wallet",
    icon: "/wallets/phantom.svg",
  },
  {
    id: "io.rabby",
    label: "Rabby",
    subtitle: "Browser Wallet",
    icon: "/wallets/rabby.svg",
  },
  {
    id: "com.coinbase.wallet",
    label: "Coinbase Wallet",
    subtitle: "Browser & Mobile",
    icon: "/wallets/coinbase.svg",
  },
  {
    id: "com.okx.wallet",
    label: "OKX Wallet",
    subtitle: "Browser Wallet",
    icon: "/wallets/okx.svg",
  },
  {
    id: "com.trustwallet",
    label: "Trust Wallet",
    subtitle: "Browser & Mobile",
    icon: "/wallets/trust.svg",
  },
];

const TARGET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0);
const TARGET_CHAIN_NAME = process.env.NEXT_PUBLIC_NETWORK_NAME || "MegaETH";
const TARGET_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const TARGET_EXPLORER_URL = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "";
const STORAGE_KEY = "megahop-launchpad.selected-wallet";

const WalletContext = createContext<WalletContextValue | null>(null);

const normalizeHexChainId = (chainId: number) => `0x${chainId.toString(16)}`;

const getWalletProvider = (walletId: BrowserWalletId): any | null => {
  if (typeof window === "undefined") return null;

  const providers: any[] = Array.isArray(window.ethereum?.providers)
    ? window.ethereum.providers
    : window.ethereum
    ? [window.ethereum]
    : [];

  if (walletId === "app.phantom") {
    if (window.phantom?.ethereum) {
      return window.phantom.ethereum;
    }
    return providers.find((provider) => provider?.isPhantom) || null;
  }

  if (walletId === "com.coinbase.wallet") {
    return providers.find((provider) => provider?.isCoinbaseWallet) || null;
  }

  if (walletId === "io.rabby") {
    return providers.find((provider) => provider?.isRabby) || null;
  }

  if (walletId === "com.okx.wallet") {
    return (
      providers.find(
        (provider) => provider?.isOkxWallet || provider?.isOKXWallet || provider?.isOkexWallet || provider?.isOKExWallet
      ) || null
    );
  }

  if (walletId === "com.trustwallet") {
    return providers.find((provider) => provider?.isTrust || provider?.isTrustWallet) || null;
  }

  if (walletId === "io.metamask") {
    return (
      providers.find(
        (provider) => provider?.isMetaMask && !provider?.isRabby && !provider?.isPhantom
      ) ||
      providers.find((provider) => provider?.isMetaMask) ||
      null
    );
  }

  return null;
};

const getWalletById = (walletId: BrowserWalletId | null) =>
  WALLET_OPTIONS.find((wallet) => wallet.id === walletId) || null;

const getChainIdNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }
  return 0;
};

const buildAccount = (address: string, provider: any): WalletAccount => ({
  address,
  async signMessage(message: string) {
    const web3Provider = new ethers.providers.Web3Provider(provider, "any");
    const signer = web3Provider.getSigner();
    return signer.signMessage(message);
  },
});

const syncProviderState = async (provider: any) => {
  const [accounts, chainIdRaw] = await Promise.all([
    provider.request({ method: "eth_accounts" }).catch(() => []),
    provider.request({ method: "eth_chainId" }).catch(() => "0x0"),
  ]);

  const address =
    Array.isArray(accounts) && accounts.length > 0 && typeof accounts[0] === "string"
      ? accounts[0]
      : "";

  const chainId =
    typeof chainIdRaw === "string" ? parseInt(chainIdRaw, 16) : getChainIdNumber(chainIdRaw);

  return {
    address,
    chainId: Number.isFinite(chainId) ? chainId : 0,
  };
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [walletId, setWalletId] = useState<BrowserWalletId | null>(null);
  const [provider, setProvider] = useState<any | null>(null);
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const activeProviderRef = useRef<any | null>(null);

  const disconnectWallet = () => {
    activeProviderRef.current = null;
    setWalletId(null);
    setProvider(null);
    setAddress("");
    setChainId(0);
    setConnectionStatus("disconnected");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  };

  const attachProvider = async (nextWalletId: BrowserWalletId, nextProvider: any) => {
    activeProviderRef.current = nextProvider;
    setWalletId(nextWalletId);
    setProvider(nextProvider);

    const update = async () => {
      const state = await syncProviderState(nextProvider);
      setAddress(state.address);
      setChainId(state.chainId);
      setConnectionStatus(state.address ? "connected" : "disconnected");
    };

    const handleAccountsChanged = (accounts: string[]) => {
      const nextAddress = Array.isArray(accounts) && accounts.length > 0 ? String(accounts[0]) : "";
      setAddress(nextAddress);
      setConnectionStatus(nextAddress ? "connected" : "disconnected");
    };

    const handleChainChanged = (nextChainId: string | number) => {
      const parsed =
        typeof nextChainId === "string"
          ? parseInt(nextChainId, 16)
          : getChainIdNumber(nextChainId);
      setChainId(Number.isFinite(parsed) ? parsed : 0);
    };

    const handleDisconnect = () => {
      disconnectWallet();
    };

    nextProvider.removeListener?.("accountsChanged", handleAccountsChanged);
    nextProvider.removeListener?.("chainChanged", handleChainChanged);
    nextProvider.removeListener?.("disconnect", handleDisconnect);

    nextProvider.on?.("accountsChanged", handleAccountsChanged);
    nextProvider.on?.("chainChanged", handleChainChanged);
    nextProvider.on?.("disconnect", handleDisconnect);

    await update();
  };

  const switchToTargetChain = async () => {
    if (!provider || !TARGET_CHAIN_ID) return;
    const targetChainHex = normalizeHexChainId(TARGET_CHAIN_ID);

    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainHex }],
      });
    } catch (error: any) {
      if (error?.code !== 4902 || !TARGET_RPC_URL) {
        throw error;
      }
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: targetChainHex,
            chainName: TARGET_CHAIN_NAME,
            nativeCurrency: {
              name: "ETH",
              symbol: process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH",
              decimals: 18,
            },
            rpcUrls: [TARGET_RPC_URL],
            blockExplorerUrls: TARGET_EXPLORER_URL ? [TARGET_EXPLORER_URL] : [],
          },
        ],
      });
    }
  };

  const connectWallet = async (nextWalletId: BrowserWalletId) => {
    const nextProvider = getWalletProvider(nextWalletId);
    if (!nextProvider) {
      throw new Error("Wallet extension not found in this browser.");
    }

    setConnectionStatus("connecting");
    try {
      await nextProvider.request({ method: "eth_requestAccounts" });
      await attachProvider(nextWalletId, nextProvider);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, nextWalletId);
      }
    } catch (error) {
      setConnectionStatus("disconnected");
      throw error;
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedWalletId = window.localStorage.getItem(STORAGE_KEY) as BrowserWalletId | null;
    if (!storedWalletId) return;

    const storedProvider = getWalletProvider(storedWalletId);
    if (!storedProvider) return;

    void attachProvider(storedWalletId, storedProvider).catch(() => {
      disconnectWallet();
    });
  }, []);

  const value = useMemo<WalletContextValue>(() => {
    const account = address && provider ? buildAccount(address, provider) : null;
    const chain = chainId ? { id: chainId, name: TARGET_CHAIN_NAME } : null;
    return {
      account,
      chain,
      connectionStatus,
      wallet: getWalletById(walletId),
      provider,
      walletOptions: WALLET_OPTIONS,
      connectWallet,
      disconnectWallet,
      switchToTargetChain,
    };
  }, [address, chainId, connectionStatus, provider, walletId]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

const useWalletContext = () => {
  const value = useContext(WalletContext);
  if (!value) {
    throw new Error("WalletProvider is missing");
  }
  return value;
};

export const useWalletAccount = () => useWalletContext().account;
export const useWalletChain = () => useWalletContext().chain;
export const useWalletConnectionStatus = () => useWalletContext().connectionStatus;
export const useWalletState = () => useWalletContext();
