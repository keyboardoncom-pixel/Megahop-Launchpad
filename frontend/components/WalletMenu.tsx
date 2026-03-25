import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { ArrowRightOnRectangleIcon, WalletIcon } from "@heroicons/react/24/outline";
import { getReadContract, withReadRetry } from "../lib/contract";
import { useWalletState } from "../lib/wallet";

const EYE_ICON_ASSET = "/megaeth-assets/34d21957-44d3-485b-aaa8-cceeb44fa0a2.svg";
const COPY_ICON_ASSET = "/megaeth-assets/0565fe0f-b764-430e-a8a3-c58ef5b4d7a4.svg";
const OPEN_ICON_ASSET = "/megaeth-assets/f4b712b6-c4bd-4012-98d8-b04a6b57bab1.svg";
const MEGAETH_LOGO_ASSET = "/megaeth-assets/4afa304f-02e0-4249-b5cd-6ee5a6627079.svg";
const EARTH_VIDEO_ASSET = "/megaeth-assets/earth.webm";
const DEFAULT_WALLET_ICON_ASSET = "/wallets/more.svg";
const NFT_CARD_FALLBACK_IMAGE = "/megaeth-assets/image_7.png";
const DEPLOY_BLOCK = Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || 0);
const MINT_EVENT_QUERY_BLOCK_CHUNK = 40_000;
const NFT_PREVIEW_LIMIT = 8;
const WALLET_ICON_BY_ID: Record<string, string> = {
  "io.metamask": "/wallets/metamask.svg",
  "com.coinbase.wallet": "/wallets/coinbase.svg",
  "app.phantom": "/wallets/phantom.svg",
  "io.rabby": "/wallets/rabby.svg",
  "com.okx.wallet": "/wallets/okx.svg",
  "com.trustwallet": "/wallets/trust.svg",
  "me.rainbow": "/wallets/more.svg",
  "io.zerion.wallet": "/wallets/more.svg",
  walletConnect: "/wallets/walletconnect.svg",
  "com.base.wallet": "/wallets/base.svg",
  "xyz.abs.privy": "/wallets/abstract.svg",
};

type WalletOption = {
  id:
    | "io.metamask"
    | "app.phantom"
    | "io.rabby"
    | "com.coinbase.wallet"
    | "com.okx.wallet"
    | "com.trustwallet";
  label: string;
  subtitle: string;
  fallbackIcon: string;
};

const normalizeMediaUri = (uri: string) => {
  if (!uri) return uri;
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.replace("ipfs://", "")}`;
  }
  return uri;
};

const shouldChunkLogQuery = (error: any) => {
  const message = String(
    error?.message || error?.reason || error?.data?.message || error?.error?.message || ""
  ).toLowerCase();
  return (
    message.includes("block range") ||
    message.includes("query returned more than") ||
    message.includes("too many results") ||
    message.includes("response size") ||
    message.includes("limit exceeded")
  );
};

const queryMintEventsWithFallback = async (
  contract: any,
  ownerAddress: string,
  fromBlock: number,
  toBlock: number
) => {
  const mintFilter = contract.filters.Transfer(ethers.constants.AddressZero, ownerAddress);
  try {
    return await withReadRetry<any[]>(() => contract.queryFilter(mintFilter, fromBlock, toBlock));
  } catch (error: any) {
    if (!shouldChunkLogQuery(error)) {
      throw error;
    }
  }

  const events: any[] = [];
  for (let start = fromBlock; start <= toBlock; start += MINT_EVENT_QUERY_BLOCK_CHUNK) {
    const end = Math.min(toBlock, start + MINT_EVENT_QUERY_BLOCK_CHUNK - 1);
    const partial = await withReadRetry<any[]>(() => contract.queryFilter(mintFilter, start, end));
    events.push(...partial);
  }
  return events;
};

const CONNECT_WALLET_OPTIONS: WalletOption[] = [
  {
    id: "io.metamask",
    label: "MetaMask",
    subtitle: "Browser & Mobile",
    fallbackIcon: WALLET_ICON_BY_ID["io.metamask"],
  },
  {
    id: "app.phantom",
    label: "Phantom",
    subtitle: "Browser Wallet",
    fallbackIcon: WALLET_ICON_BY_ID["app.phantom"],
  },
  {
    id: "io.rabby",
    label: "Rabby",
    subtitle: "Browser Wallet",
    fallbackIcon: WALLET_ICON_BY_ID["io.rabby"],
  },
  {
    id: "com.coinbase.wallet",
    label: "Coinbase Wallet",
    subtitle: "Browser & Mobile",
    fallbackIcon: WALLET_ICON_BY_ID["com.coinbase.wallet"],
  },
  {
    id: "com.okx.wallet",
    label: "OKX Wallet",
    subtitle: "Browser Wallet",
    fallbackIcon: WALLET_ICON_BY_ID["com.okx.wallet"],
  },
  {
    id: "com.trustwallet",
    label: "Trust Wallet",
    subtitle: "Browser & Mobile",
    fallbackIcon: WALLET_ICON_BY_ID["com.trustwallet"],
  },
];

type Status = {
  type: "pending" | "success" | "error" | "idle";
  message: string;
};

type WalletMenuProps = {
  onStatus?: (status: Status) => void;
};

export default function WalletMenu({ onStatus }: WalletMenuProps) {
  const {
    account,
    wallet,
    chain,
    provider,
    connectionStatus,
    connectWallet,
    disconnectWallet,
  } = useWalletState();
  const isConnecting = connectionStatus === "connecting";
  const rootRef = useRef<HTMLDivElement | null>(null);
  const copiedTimeoutRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectingWalletId, setConnectingWalletId] = useState<WalletOption["id"] | null>(null);
  const [memberSince, setMemberSince] = useState("");
  const [txCount, setTxCount] = useState(0);
  const [mintedTokenIds, setMintedTokenIds] = useState<string[]>([]);
  const [mintedNftLoading, setMintedNftLoading] = useState(false);
  const [mintedNftError, setMintedNftError] = useState("");
  const [nftTileImage, setNftTileImage] = useState(NFT_CARD_FALLBACK_IMAGE);
  const [nativeBalanceText, setNativeBalanceText] = useState("0 ETH");

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    if (!account?.address || typeof window === "undefined") {
      setMemberSince("");
      setTxCount(0);
      setMintedTokenIds([]);
      setMintedNftError("");
      setMintedNftLoading(false);
      setNftTileImage(NFT_CARD_FALLBACK_IMAGE);
      return;
    }

    const normalizedAddress = account.address.toLowerCase();
    const sinceKey = `megahop-launchpad.wallet-since.${normalizedAddress}`;
    const txKey = `megahop-launchpad.wallet-tx-count.${normalizedAddress}`;
    const today = new Date();
    const isoDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;
    const existingSince = window.localStorage.getItem(sinceKey);
    if (existingSince) {
      setMemberSince(existingSince);
    } else {
      window.localStorage.setItem(sinceKey, isoDate);
      setMemberSince(isoDate);
    }
    const storedTx = Number(window.localStorage.getItem(txKey) || "0");
    setTxCount(Number.isFinite(storedTx) && storedTx > 0 ? Math.floor(storedTx) : 0);
  }, [account?.address]);

  useEffect(() => {
    let cancelled = false;
    const loadMintedNfts = async () => {
      if (!open || !account?.address) return;
      setMintedNftLoading(true);
      setMintedNftError("");
      try {
        const contract = getReadContract();
        const provider = contract.provider;
        const latestBlock = await withReadRetry<number>(() => provider.getBlockNumber());
        const fromBlock = Number.isFinite(DEPLOY_BLOCK) && DEPLOY_BLOCK > 0 ? DEPLOY_BLOCK : Math.max(0, latestBlock - 1_500_000);
        const [events, notRevealedUriRaw] = await Promise.all([
          queryMintEventsWithFallback(contract, account.address, fromBlock, latestBlock),
          withReadRetry<string>(() => contract.notRevealedURI()).catch(() => ""),
        ]);
        const mintedIds = Array.from(
          new Set(
            events
              .map((event: any) => event?.args?.tokenId)
              .filter(Boolean)
              .map((tokenId: any) => tokenId.toString())
          )
        ).sort((a, b) => Number(b) - Number(a));

        if (cancelled) return;
        setMintedTokenIds(mintedIds);
        const resolvedImage = normalizeMediaUri(String(notRevealedUriRaw || ""));
        setNftTileImage(resolvedImage || NFT_CARD_FALLBACK_IMAGE);
      } catch {
        if (cancelled) return;
        setMintedTokenIds([]);
        setNftTileImage(NFT_CARD_FALLBACK_IMAGE);
        setMintedNftError("Unable to load minted NFTs right now.");
      } finally {
        if (!cancelled) {
          setMintedNftLoading(false);
        }
      }
    };
    void loadMintedNfts();
    return () => {
      cancelled = true;
    };
  }, [open, account?.address]);

  const activeDays = useMemo(() => {
    if (!memberSince) return 1;
    const joinedAt = new Date(`${memberSince}T00:00:00`);
    if (Number.isNaN(joinedAt.getTime())) return 1;
    const diffMs = Date.now() - joinedAt.getTime();
    return Math.max(1, Math.floor(diffMs / 86_400_000) + 1);
  }, [memberSince]);

  const shortAddress = useMemo(() => {
    const value = account?.address;
    if (!value) return "";
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }, [account?.address]);

  useEffect(() => {
    let cancelled = false;
    const loadNativeBalance = async () => {
      if (!account?.address || !provider) {
        setNativeBalanceText("0 ETH");
        return;
      }
      try {
        const web3Provider = new ethers.providers.Web3Provider(provider, "any");
        const balance = await web3Provider.getBalance(account.address);
        const symbol = process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH";
        const value = Number(ethers.utils.formatEther(balance));
        if (!cancelled) {
          const decimals = value >= 1 ? 4 : 6;
          setNativeBalanceText(`${value.toFixed(decimals)} ${symbol}`);
        }
      } catch {
        if (!cancelled) {
          setNativeBalanceText(`0 ${process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH"}`);
        }
      }
    };
    void loadNativeBalance();
    return () => {
      cancelled = true;
    };
  }, [account?.address, chain?.id, provider]);

  const explorerUrl = useMemo(() => {
    const baseUrl = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "";
    if (!baseUrl || !account?.address) return "";
    return `${baseUrl.replace(/\/$/, "")}/address/${account.address}`;
  }, [account?.address]);

  const walletIconSrc = useMemo(() => {
    const walletId = wallet?.id || "";
    return WALLET_ICON_BY_ID[walletId] || wallet?.icon || DEFAULT_WALLET_ICON_ASSET;
  }, [wallet?.icon, wallet?.id]);

  const mintedPreviewIds = useMemo(() => mintedTokenIds.slice(0, NFT_PREVIEW_LIMIT), [mintedTokenIds]);
  const mintedRemainderCount = Math.max(0, mintedTokenIds.length - mintedPreviewIds.length);

  const handleConnectWallet = async (option: WalletOption) => {
    try {
      setConnectingWalletId(option.id);
      onStatus?.({ type: "pending", message: `Connecting ${option.label}...` });
      await connectWallet(option.id);
      setOpen(false);
      onStatus?.({ type: "success", message: "Wallet connected." });
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      const reason = typeof error?.message === "string" && error.message.toLowerCase().includes("user rejected")
        ? "Wallet connection canceled."
        : "Failed to connect wallet.";
      onStatus?.({ type: "error", message: reason });
    } finally {
      setConnectingWalletId(null);
    }
  };

  const handleDisconnect = () => {
    if (!wallet) return;
    disconnectWallet();
    setOpen(false);
    onStatus?.({ type: "idle", message: "Wallet disconnected." });
  };

  const handleCopyAddress = async () => {
    if (!account?.address) return;
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      if (copiedTimeoutRef.current) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 1600);
      onStatus?.({ type: "success", message: "Address copied." });
    } catch {
      onStatus?.({ type: "error", message: "Unable to copy address." });
    }
  };

  const handleOpenExplorer = () => {
    if (!explorerUrl) return;
    window.open(explorerUrl, "_blank", "noopener,noreferrer");
    setOpen(false);
  };

  if (!account) {
    return (
      <div className="wallet-menu-root" ref={rootRef}>
        <button
          className={`wallet-connect-btn ${open ? "is-open" : ""}`}
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={isConnecting}
        >
          <WalletIcon className="wallet-connect-btn-icon" aria-hidden="true" />
          <span>{isConnecting ? "CONNECTING..." : "CONNECT WALLET"}</span>
        </button>

        {open ? (
          <div className="wallet-popover wallet-connect-popover">
            <div className="wallet-popover-grid">
              <section className="wallet-pop-column wallet-connect-wallets">
                <header className="wallet-pop-heading wallet-connect-heading">
                  <h3>Connect Wallet</h3>
                </header>
                <div className="wallet-connect-list">
                  {CONNECT_WALLET_OPTIONS.map((option) => {
                    const isOptionConnecting = isConnecting && connectingWalletId === option.id;
                    const optionIcon = option.fallbackIcon;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className="wallet-connect-item"
                        onClick={() => handleConnectWallet(option)}
                        disabled={isConnecting}
                      >
                        <span className="wallet-connect-item-icon">
                          <img src={optionIcon} alt="" aria-hidden className="wallet-connect-item-icon-img" />
                        </span>
                        <span className="wallet-connect-item-meta">
                          <span className="wallet-connect-item-label">{option.label}</span>
                          <span className="wallet-connect-item-subtitle">
                            {isOptionConnecting ? "CONNECTING..." : option.subtitle}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="wallet-pop-column wallet-connect-panel">
                <div className="wallet-connect-panel-inner">
                  <div className="wallet-connect-globe-wrap" aria-hidden>
                    <video className="wallet-connect-globe-video" autoPlay muted loop playsInline>
                      <source src={EARTH_VIDEO_ASSET} type="video/webm" />
                    </video>
                  </div>
                  <p className="wallet-connect-panel-title">Your gateway to the decentralized world</p>
                  <p className="wallet-connect-panel-copy">
                    {isConnecting ? "Approve the request in your wallet." : "Connect a wallet to get started."}
                  </p>
                  <p className="wallet-connect-panel-hint">
                    MetaMask, Phantom, Rabby, Coinbase Wallet, OKX Wallet, and Trust Wallet supported.
                  </p>
                </div>
              </section>
            </div>

            <footer className="wallet-pop-footer wallet-connect-footer">
              <img src={MEGAETH_LOGO_ASSET} alt="Megahop logo" className="wallet-pop-brand-logo" />
              <div className="wallet-connect-footer-actions">
                <a
                  href="https://mega.etherscan.io/"
                  target="_blank"
                  rel="noreferrer"
                  className="wallet-powered-by"
                  aria-label="Open MegaETH Explorer"
                >
                  <span className="wallet-powered-by-text">Explorer</span>
                  <img src="/megaeth-assets/scan.png" alt="MegaETH Explorer" className="wallet-powered-by-logo" />
                </a>
                <button type="button" className="wallet-disconnect-btn" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </footer>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wallet-menu-root" ref={rootRef}>
      <button className={`wallet-trigger ${open ? "is-open" : ""}`} type="button" onClick={() => setOpen((v) => !v)}>
        <span className="wallet-trigger-avatar">
          <img src={walletIconSrc} alt="" aria-hidden className="wallet-trigger-avatar-img" />
        </span>
          <span className="wallet-trigger-info">
            <span className="wallet-trigger-address">{shortAddress}</span>
            <span className="wallet-trigger-balance">{nativeBalanceText}</span>
          </span>
        </button>

      {open ? (
        <div className="wallet-popover wallet-profile-popover">
          <div className="wallet-popover-grid">
            <section className="wallet-pop-column wallet-pop-assets">
              <header className="wallet-pop-heading">
                <h3>Assets</h3>
                <span className="wallet-pop-icon">
                  <img src={EYE_ICON_ASSET} alt="" aria-hidden className="wallet-pop-icon-img" />
                </span>
              </header>
              <div className="wallet-asset-list">
                <div className="wallet-asset-row">
                  <span className="wallet-asset-icon wallet-asset-icon-usdm">U</span>
                  <div className="wallet-asset-meta">
                    <div className="wallet-asset-name-line">
                      <span className="wallet-asset-name">USDm</span>
                      <span className="wallet-asset-tag">STABLECOIN</span>
                    </div>
                    <div className="wallet-asset-value">0.00</div>
                  </div>
                </div>

                <div className="wallet-asset-row">
                  <img src="/megaeth-assets/eth.svg" alt="ETH" className="wallet-asset-icon wallet-asset-icon-image" />
                  <div className="wallet-asset-meta">
                    <div className="wallet-asset-name-line">
                      <span className="wallet-asset-name">ETH</span>
                      <span className="wallet-asset-tag">GAS TOKEN</span>
                    </div>
                    <div className="wallet-asset-value">{nativeBalanceText}</div>
                  </div>
                </div>

                <div className="wallet-asset-row">
                  <img src="/megaeth-assets/mega.svg" alt="MEGA" className="wallet-asset-icon wallet-asset-icon-image" />
                  <div className="wallet-asset-meta">
                    <div className="wallet-asset-name-line">
                      <span className="wallet-asset-name">MEGA</span>
                      <span className="wallet-asset-tag">ECOSYSTEM</span>
                    </div>
                    <div className="wallet-asset-value wallet-asset-soon">COMING SOON -&gt;</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="wallet-pop-column wallet-pop-nfts">
              <header className="wallet-pop-heading wallet-pop-nfts-heading">
                <h3>Minted NFTs</h3>
                <span className="wallet-pop-nfts-count">{mintedTokenIds.length}</span>
              </header>
              <div className="wallet-nft-grid">
                {mintedNftLoading
                  ? Array.from({ length: NFT_PREVIEW_LIMIT }).map((_, index) => (
                      <div key={`loading-${index}`} className="wallet-nft-card wallet-nft-card-loading" />
                    ))
                  : mintedPreviewIds.map((tokenId) => (
                      <div key={tokenId} className="wallet-nft-card" title={`Token #${tokenId}`}>
                        <img src={nftTileImage} alt={`NFT #${tokenId}`} className="wallet-nft-card-image" />
                        <span className="wallet-nft-card-id">#{tokenId}</span>
                      </div>
                    ))}
                {!mintedNftLoading && mintedPreviewIds.length === 0 ? (
                  <div className="wallet-nft-empty">No minted NFT yet</div>
                ) : null}
              </div>
              <p className="wallet-nft-meta">
                {mintedNftLoading
                  ? "Loading minted NFTs..."
                  : mintedRemainderCount > 0
                  ? `+${mintedRemainderCount} more minted`
                  : mintedTokenIds.length > 0
                  ? "Latest minted tokens"
                  : "Mint your first NFT to fill this board."}
              </p>
              {mintedNftError ? <p className="wallet-nft-error">{mintedNftError}</p> : null}
            </section>

            <section className="wallet-pop-column wallet-pop-profile">
              <header className="wallet-pop-heading wallet-pop-profile-head">
                <div className="wallet-profile-title-wrap">
                  <span className="wallet-profile-badge">
                    <img src={walletIconSrc} alt="" aria-hidden className="wallet-profile-badge-img" />
                  </span>
                  <h3>My Profile</h3>
                </div>
                <div className="wallet-profile-actions">
                  <button
                    type="button"
                    className={`wallet-profile-action-btn ${copied ? "is-copied" : ""}`}
                    onClick={handleCopyAddress}
                    title="Copy wallet address"
                  >
                    <img src={COPY_ICON_ASSET} alt="" aria-hidden className="wallet-profile-action-icon" />
                  </button>
                  <button
                    type="button"
                    className="wallet-profile-action-btn"
                    onClick={handleOpenExplorer}
                    title="Open explorer"
                    disabled={!explorerUrl}
                  >
                    <img src={OPEN_ICON_ASSET} alt="" aria-hidden className="wallet-profile-action-icon" />
                  </button>
                </div>
              </header>

              <div className="wallet-profile-stats">
                <div className="wallet-profile-row">
                  <span>Transactions</span>
                  <span>{txCount}</span>
                </div>
                <div className="wallet-profile-row">
                  <span>Total Active Days</span>
                  <span>{activeDays}</span>
                </div>
                <div className="wallet-profile-row wallet-profile-row-stacked">
                  <span>On MegaETH Since</span>
                  <span>{memberSince.replaceAll("-", "/")}</span>
                </div>
              </div>
              <div className="wallet-profile-address">{shortAddress}</div>
              {explorerUrl ? (
                <a href={explorerUrl} target="_blank" rel="noreferrer" className="wallet-profile-link">
                  View on Explorer -&gt;
                </a>
              ) : null}
            </section>
          </div>

          <footer className="wallet-pop-footer">
            <img
              src="/megaeth-assets/4afa304f-02e0-4249-b5cd-6ee5a6627079.svg"
              alt="Megahop logo"
              className="wallet-pop-brand-logo"
            />
            <button type="button" className="wallet-disconnect-btn wallet-disconnect-btn-danger" onClick={handleDisconnect}>
              <ArrowRightOnRectangleIcon className="wallet-disconnect-btn-icon" aria-hidden="true" />
              <span>Disconnect Wallet</span>
            </button>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
