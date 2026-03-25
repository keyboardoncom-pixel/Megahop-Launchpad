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
import { useAccount, useConnect, useDisconnect } from "wagmi";
import {
  BrowserWalletId,
  WalletDescriptor,
  buildWalletDescriptors,
  loadRainbowKitWalletIcons,
} from "./rainbowkitWallets";

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

type ConnectorLike = {
  id?: string;
  name?: string;
  rdns?: string;
  getProvider?: () => Promise<any>;
};

const WALLET_OPTIONS: WalletDescriptor[] = buildWalletDescriptors();

const TARGET_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0);
const TARGET_CHAIN_NAME = process.env.NEXT_PUBLIC_NETWORK_NAME || "MegaETH";
const TARGET_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const TARGET_EXPLORER_URL = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "";
const STORAGE_KEY = "megahop-launchpad.selected-wallet";

const WalletContext = createContext<WalletContextValue | null>(null);

const normalizeHexChainId = (chainId: number) => `0x${chainId.toString(16)}`;

const getWalletById = (walletId: BrowserWalletId | null) =>
  WALLET_OPTIONS.find((wallet) => wallet.id === walletId) || null;

const buildAccount = (address: string, provider: any): WalletAccount => ({
  address,
  async signMessage(message: string) {
    const web3Provider = new ethers.providers.Web3Provider(provider, "any");
    const signer = web3Provider.getSigner();
    return signer.signMessage(message);
  },
});

const getWalletIdFromConnector = (connector: ConnectorLike | null | undefined): BrowserWalletId | null => {
  if (!connector) return null;

  const rdns = String(connector.rdns || "").toLowerCase();
  const id = String(connector.id || "").toLowerCase();
  const name = String(connector.name || "").toLowerCase();

  if (rdns === "io.metamask" || id === "metamask" || id === "metaMask" || name.includes("metamask")) {
    return "io.metamask";
  }
  if (rdns === "app.phantom" || id === "phantom" || name.includes("phantom")) {
    return "app.phantom";
  }
  if (rdns === "io.rabby" || id === "rabby" || name.includes("rabby")) {
    return "io.rabby";
  }
  if (rdns === "com.coinbase.wallet" || id === "coinbasewallet" || id === "coinbase" || name.includes("coinbase")) {
    return "com.coinbase.wallet";
  }
  if (rdns === "me.rainbow" || id === "rainbow" || name.includes("rainbow")) {
    return "me.rainbow";
  }
  if (rdns === "io.zerion.wallet" || id === "zerion" || name.includes("zerion")) {
    return "io.zerion.wallet";
  }
  if (rdns === "com.okx.wallet" || id === "okxwallet" || id === "okx" || name.includes("okx")) {
    return "com.okx.wallet";
  }
  return null;
};

const getConnectorForWallet = (connectors: readonly ConnectorLike[], walletId: BrowserWalletId) =>
  connectors.find((connector) => getWalletIdFromConnector(connector) === walletId) || null;

export function WalletProvider({ children }: { children: ReactNode }) {
  const { address, chainId, connector, status } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const [provider, setProvider] = useState<any | null>(null);
  const [manualStatus, setManualStatus] = useState<"connecting" | null>(null);
  const [walletOptions, setWalletOptions] = useState<WalletDescriptor[]>(WALLET_OPTIONS);
  const [selectedWalletId, setSelectedWalletId] = useState<BrowserWalletId | null>(null);
  const activeProviderRef = useRef<any | null>(null);

  const connectorWalletId = useMemo(
    () => getWalletIdFromConnector(connector as ConnectorLike | null),
    [connector],
  );
  const walletId = selectedWalletId || connectorWalletId;
  const connectionStatus = useMemo<"disconnected" | "connecting" | "connected">(() => {
    if (manualStatus === "connecting" || status === "connecting" || status === "reconnecting") {
      return "connecting";
    }
    if (status === "connected" && address) {
      return "connected";
    }
    return "disconnected";
  }, [address, manualStatus, status]);

  useEffect(() => {
    let cancelled = false;
    const hydrateWalletIcons = async () => {
      const icons = await loadRainbowKitWalletIcons();
      if (cancelled) return;
      setWalletOptions((current) =>
        current.map((wallet) => ({
          ...wallet,
          icon: icons[wallet.id] || wallet.icon,
        })),
      );
    };
    void hydrateWalletIcons();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedWalletId = window.localStorage.getItem(STORAGE_KEY);
    if (!storedWalletId) return;
    if (!WALLET_OPTIONS.some((wallet) => wallet.id === storedWalletId)) return;
    setSelectedWalletId(storedWalletId as BrowserWalletId);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (connectionStatus === "disconnected") {
      setSelectedWalletId(null);
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }

    if (!selectedWalletId && connectorWalletId) {
      setSelectedWalletId(connectorWalletId);
      window.localStorage.setItem(STORAGE_KEY, connectorWalletId);
    }
  }, [connectionStatus, connectorWalletId, selectedWalletId]);

  useEffect(() => {
    let cancelled = false;

    if (!connector || !address || status !== "connected") {
      activeProviderRef.current = null;
      setProvider(null);
      return;
    }

    const loadProvider = async () => {
      try {
        const nextProvider = await (connector as ConnectorLike).getProvider?.();
        if (cancelled) return;
        activeProviderRef.current = nextProvider ?? null;
        setProvider(nextProvider ?? null);
      } catch {
        if (cancelled) return;
        activeProviderRef.current = null;
        setProvider(null);
      }
    };

    void loadProvider();
    return () => {
      cancelled = true;
    };
  }, [address, connector, status]);

  const disconnectWallet = () => {
    activeProviderRef.current = null;
    setProvider(null);
    setManualStatus(null);
    setSelectedWalletId(null);
    disconnect();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  };

  const switchToTargetChain = async () => {
    const activeProvider = activeProviderRef.current || provider;
    if (!activeProvider || !TARGET_CHAIN_ID) return;
    const targetChainHex = normalizeHexChainId(TARGET_CHAIN_ID);

    try {
      await activeProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainHex }],
      });
    } catch (error: any) {
      if (error?.code !== 4902 || !TARGET_RPC_URL) {
        throw error;
      }
      await activeProvider.request({
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
    const nextConnector = getConnectorForWallet(connectors as readonly ConnectorLike[], nextWalletId);
    if (!nextConnector) {
      throw new Error("Wallet extension not found in this browser.");
    }

    setManualStatus("connecting");
    try {
      setSelectedWalletId(nextWalletId);
      await connectAsync({ connector: nextConnector as any });
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, nextWalletId);
      }
    } catch (error) {
      setSelectedWalletId(null);
      throw error;
    } finally {
      setManualStatus(null);
    }
  };

  const value = useMemo<WalletContextValue>(() => {
    const account = address && provider ? buildAccount(address, provider) : null;
    const chain = chainId ? { id: chainId, name: TARGET_CHAIN_NAME } : null;
    return {
      account,
      chain,
      connectionStatus,
      wallet: walletOptions.find((entry) => entry.id === walletId) || null,
      provider,
      walletOptions,
      connectWallet,
      disconnectWallet,
      switchToTargetChain,
    };
  }, [address, chainId, connectionStatus, provider, walletId, walletOptions]);

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
