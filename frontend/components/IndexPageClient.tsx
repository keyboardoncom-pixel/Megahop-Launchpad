import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { ethers } from "ethers";
import { ArrowPathIcon, CheckBadgeIcon, ClockIcon, MinusCircleIcon } from "@heroicons/react/24/outline";
import {
  CONTRACT_ADDRESS,
  formatAddress,
  getReadContract,
  getWriteContract,
  sendContractTxWithBufferedGas,
  TARGET_CHAIN_ID,
  withReadRetry,
} from "../lib/contract";
import { useWalletAccount, useWalletChain, useWalletConnectionStatus, useWalletState } from "../lib/wallet";
import {
  LAUNCHPAD_UI_SETTINGS_EVENT,
  LaunchpadUiDefaults,
  LaunchpadUiSettings,
  buildDefaultLaunchpadUiSettings,
  getLaunchpadUiStorageKey,
  loadLaunchpadUiSettings,
  saveLaunchpadUiSettings,
  toLaunchpadUiSettings,
} from "../lib/launchpadUi";
import { Phase, formatPhaseWindow, getPhaseStatus } from "../lib/phases";
const WalletMenu = dynamic(() => import("../components/WalletMenu"), {
  ssr: false,
});

const NETWORK_NAME = process.env.NEXT_PUBLIC_NETWORK_NAME || "MegaETH Testnet";
const NATIVE_SYMBOL = process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH";
const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "MEGAHOP";
const BLOCK_EXPLORER_URL = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "";
const DEFAULT_COLLECTION_NAME = process.env.NEXT_PUBLIC_COLLECTION_NAME || "Megahop";
const DEFAULT_COLLECTION_DESCRIPTION =
  process.env.NEXT_PUBLIC_COLLECTION_DESCRIPTION ||
  "The Megahop NFT collection on MegaETH with phased minting, allowlist control, admin tooling, and launchpad fee support.";
const DEFAULT_COLLECTION_BANNER_URL = process.env.NEXT_PUBLIC_COLLECTION_BANNER_URL || "";
const DEFAULT_WEBSITE_URL = process.env.NEXT_PUBLIC_COLLECTION_WEBSITE || "";
const DEFAULT_TWITTER_URL = process.env.NEXT_PUBLIC_COLLECTION_TWITTER || "";
const DEFAULT_HERO_BANNER_ASSET = "/megaeth-assets/home_bg.png";
const DEFAULT_PREVIEW_ASSET = "/megaeth-assets/image_7.png";
const DEFAULT_BRAND_LOGO_ASSET = "/megaeth-assets/4afa304f-02e0-4249-b5cd-6ee5a6627079.svg";
const ETH_ICON_ASSET = "/megaeth-assets/eth.svg";
const FOOTER_EARTH_ASSET = "/megaeth-assets/earth.webm";
const STATS_REFRESH_MS = Math.max(Number(process.env.NEXT_PUBLIC_STATS_REFRESH_MS || 300_000), 60_000);
const LAUNCHPAD_UI_REFRESH_MS = Math.max(Number(process.env.NEXT_PUBLIC_LAUNCHPAD_UI_REFRESH_MS || 900_000), 120_000);
const VISIBILITY_REFRESH_DEBOUNCE_MS = 15_000;

const LAUNCHPAD_UI_DEFAULTS: LaunchpadUiDefaults = {
  collectionName: DEFAULT_COLLECTION_NAME,
  collectionDescription: DEFAULT_COLLECTION_DESCRIPTION,
  collectionBannerUrl: DEFAULT_COLLECTION_BANNER_URL,
  collectionWebsite: DEFAULT_WEBSITE_URL,
  collectionTwitter: DEFAULT_TWITTER_URL,
};

const FALLBACK_SUPPORTED_CHAIN_IDS = [4326, 6343];
const SUPPORTED_CHAIN_IDS = TARGET_CHAIN_ID
  ? [TARGET_CHAIN_ID]
  : FALLBACK_SUPPORTED_CHAIN_IDS;

type TxStatus = {
  type: "pending" | "success" | "error" | "idle";
  message: string;
};

type MintSuccessToast = {
  title: string;
  tokenLine: string;
  explorerTxUrl: string;
  nftUrl: string;
};

const toCountdownParts = (diffMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return {
    days: String(days),
    hours: String(hours).padStart(2, "0"),
    minutes: String(minutes).padStart(2, "0"),
    seconds: String(seconds).padStart(2, "0"),
  };
};

const normalizeMintErrorMessage = (error: any) => {
  const rawParts = [
    error?.reason,
    error?.shortMessage,
    error?.message,
    error?.data?.message,
    error?.error?.message,
    error?.info?.error?.message,
  ]
    .filter(Boolean)
    .map((value) => String(value));

  const raw = rawParts.join(" | ");
  const lower = raw.toLowerCase();

  if (lower.includes("insufficient funds") || lower.includes("overshot")) {
    return `Insufficient ${NATIVE_SYMBOL} balance for mint.`;
  }
  if (error?.code === 4001 || lower.includes("user rejected") || lower.includes("rejected the request")) {
    return "Transaction was rejected in wallet.";
  }
  if (lower.includes("maxfeepergas cannot be less than maxpriorityfeepergas")) {
    return "Wallet gas config mismatch detected. Retry mint now.";
  }
  if (lower.includes("nonce gap too high")) {
    return "Wallet nonce was out of sync. Retry mint now.";
  }
  if (lower.includes("nonce too low") || lower.includes("replacement transaction underpriced")) {
    return "Pending transaction conflict detected. Wait a few seconds, then retry mint.";
  }
  if (lower.includes("paused")) {
    return "Mint is currently paused by admin.";
  }
  if (lower.includes("allowlist")) {
    return "Wallet is not allowlisted for this phase.";
  }
  if (lower.includes("wrong network") || lower.includes("chain")) {
    return `Switch to ${NETWORK_NAME} network.`;
  }

  return "Mint failed. Please try again or check the transaction in your wallet.";
};

const collectMintedTokenIds = (receipt: any, contract: any, recipient?: string) => {
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : [];
  const iface = contract?.interface;
  if (!iface) {
    return [] as string[];
  }

  const normalizedRecipient = (recipient || "").toLowerCase();
  const seen = new Set<string>();
  for (const log of logs) {
    if (!log?.topics || !log?.address) continue;
    if (CONTRACT_ADDRESS && String(log.address).toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (!parsed || parsed.name !== "Transfer") continue;
      const from = String(parsed.args?.from || "").toLowerCase();
      const to = String(parsed.args?.to || "").toLowerCase();
      if (from !== ethers.constants.AddressZero.toLowerCase()) continue;
      if (normalizedRecipient && to !== normalizedRecipient) continue;
      const tokenId = parsed.args?.tokenId?.toString?.();
      if (tokenId) {
        seen.add(tokenId);
      }
    } catch {
      // ignore unknown logs
    }
  }

  return Array.from(seen).sort((a, b) => {
    try {
      const left = BigInt(a);
      const right = BigInt(b);
      return left < right ? -1 : left > right ? 1 : 0;
    } catch {
      return a.localeCompare(b);
    }
  });
};

const formatMintedTokenLine = (tokenIds: string[]) => {
  if (!tokenIds.length) {
    return "Token minted successfully";
  }
  if (tokenIds.length === 1) {
    return `Token ID #${tokenIds[0]}`;
  }

  let isConsecutive = true;
  for (let index = 1; index < tokenIds.length; index += 1) {
    if (BigInt(tokenIds[index]) !== BigInt(tokenIds[index - 1]) + 1n) {
      isConsecutive = false;
      break;
    }
  }
  if (isConsecutive) {
    return `Token IDs #${tokenIds[0]} - #${tokenIds[tokenIds.length - 1]}`;
  }
  return `Token IDs #${tokenIds[0]} +${tokenIds.length - 1} more`;
};

const resolveMediaUri = (uri: string) => {
  if (!uri) return uri;
  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.replace("ipfs://", "")}`;
  }
  return uri;
};

const normalizeExternalUrl = (raw: string) => {
  const value = raw.trim();
  if (!value) return "";

  if (value.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${value.replace("ipfs://", "")}`;
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

type MintGlyphName = "refresh" | "clock" | "circle" | "check";

type MintGlyphComponent = ComponentType<SVGProps<SVGSVGElement>>;

const MINT_GLYPHS: Record<MintGlyphName, MintGlyphComponent> = {
  refresh: ArrowPathIcon,
  clock: ClockIcon,
  circle: MinusCircleIcon,
  check: CheckBadgeIcon,
};

function MintGlyph({ name, className = "" }: { name: MintGlyphName; className?: string }) {
  const Icon = MINT_GLYPHS[name];
  return <Icon className={`mint-ui-glyph ${className}`.trim()} aria-hidden="true" />;
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const account = useWalletAccount();
  const chain = useWalletChain();
  const connectionStatus = useWalletConnectionStatus();
  const { provider, switchToTargetChain } = useWalletState();
  const address = account?.address;
  const isConnected = connectionStatus === "connected" && !!address;

  const [totalSupply, setTotalSupply] = useState("0");
  const [maxSupply, setMaxSupply] = useState("0");
  const [launchpadFee, setLaunchpadFee] = useState("0");
  const [paused, setPaused] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingEligibility, setCheckingEligibility] = useState(false);
  const [status, setStatus] = useState<TxStatus>({ type: "idle", message: "" });
  const [mintSuccessToast, setMintSuccessToast] = useState<MintSuccessToast | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [allowlistEligible, setAllowlistEligible] = useState<boolean | null>(null);
  const [notRevealedURI, setNotRevealedURI] = useState("");
  const [uiSettings, setUiSettings] = useState(() =>
    buildDefaultLaunchpadUiSettings(LAUNCHPAD_UI_DEFAULTS)
  );
  const lastRefreshAllAtRef = useRef(0);
  const lastUiSyncAtRef = useRef(0);
  const lastVisibilityRefreshAtRef = useRef(0);

  const isSupportedChain = !chain || SUPPORTED_CHAIN_IDS.includes(chain.id);
  const isTargetChain = TARGET_CHAIN_ID ? !!chain && chain.id === TARGET_CHAIN_ID : true;
  const isCorrectChain = isSupportedChain && isTargetChain;
  const isWrongNetwork = isConnected && !isCorrectChain;
  const launchpadUiStorageKey = useMemo(
    () => getLaunchpadUiStorageKey(CONTRACT_ADDRESS, TARGET_CHAIN_ID || chain?.id),
    [chain?.id]
  );

  const refreshInfo = async () => {
    try {
      const contract = getReadContract();
      if (!contract) return;
      const [total, max, isPaused, hiddenUri, fee] = await withReadRetry(() =>
        Promise.all([
          contract.totalSupply(),
          contract.maxSupply(),
          contract.paused(),
          contract.notRevealedURI(),
          contract.launchpadFee(),
        ])
      );
      setTotalSupply(total.toString());
      setMaxSupply(max.toString());
      setPaused(isPaused);
      setNotRevealedURI(hiddenUri || "");
      setLaunchpadFee(ethers.utils.formatEther(fee));
    } catch (e) {
      console.error(e);
    }
  };

  const refreshPhases = async () => {
    try {
      const contract = getReadContract();
      if (!contract) return;
      const count = await withReadRetry<any>(() => contract.phaseCount());
      const items = await Promise.all(
        Array.from({ length: Number(count) }).map(async (_, index) => {
          const phase = await withReadRetry<any>(() => contract.phases(index));
          const exists = phase.exists ?? phase[5];
          if (!exists) return null;
          const [allowlist, root] = await withReadRetry(() =>
            Promise.all([contract.phaseAllowlistEnabled(index), contract.phaseMerkleRoot(index)])
          );
          return {
            id: index,
            name: phase.name,
            priceEth: ethers.utils.formatEther(phase.price),
            limitPerWallet: Number(phase.maxPerWallet?.toString?.() || phase.maxPerWallet),
            startsAt: Number(phase.startTime),
            endsAt: Number(phase.endTime),
            allowlistEnabled: Boolean(allowlist),
            allowlistRoot: root,
          } as Phase;
        })
      );
      setPhases(items.filter(Boolean) as Phase[]);
    } catch {
      setPhases([]);
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refreshInfo(), refreshPhases()]);
      lastRefreshAllAtRef.current = Date.now();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!mounted) return;
    void refreshAll();
  }, [mounted, address, chain?.id]);

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;

    const syncUiSettingsFromLocal = () => {
      setUiSettings(loadLaunchpadUiSettings(launchpadUiStorageKey, LAUNCHPAD_UI_DEFAULTS));
    };

    const syncUiSettingsFromServer = async () => {
      try {
        const response = await fetch("/api/launchpad-ui", { method: "GET" });
        const payload = (await response.json().catch(() => null)) as
          | { ok: true; settings?: Partial<LaunchpadUiSettings> }
          | { ok: false; error?: string }
          | null;
        if (!response.ok || !payload?.ok) {
          return;
        }
        const remote = toLaunchpadUiSettings(payload.settings, LAUNCHPAD_UI_DEFAULTS);
        const local = loadLaunchpadUiSettings(launchpadUiStorageKey, LAUNCHPAD_UI_DEFAULTS);
        const remoteIsNewer = (remote.updatedAt || 0) >= (local.updatedAt || 0);
        if (remoteIsNewer) {
          saveLaunchpadUiSettings(launchpadUiStorageKey, remote);
          setUiSettings(remote);
          lastUiSyncAtRef.current = Date.now();
          return;
        }
        setUiSettings(local);
        lastUiSyncAtRef.current = Date.now();
      } catch {
        // Keep local cache if server settings are unavailable.
      }
    };

    syncUiSettingsFromLocal();
    const initialLocalSettings = loadLaunchpadUiSettings(launchpadUiStorageKey, LAUNCHPAD_UI_DEFAULTS);
    const shouldSyncImmediately =
      !initialLocalSettings.updatedAt || Date.now() - initialLocalSettings.updatedAt >= LAUNCHPAD_UI_REFRESH_MS;
    if (shouldSyncImmediately) {
      void syncUiSettingsFromServer();
    }

    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === launchpadUiStorageKey) {
        syncUiSettingsFromLocal();
      }
    };
    const onSettingsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ key?: string }>;
      if (!customEvent.detail?.key || customEvent.detail.key === launchpadUiStorageKey) {
        syncUiSettingsFromLocal();
      }
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(LAUNCHPAD_UI_SETTINGS_EVENT, onSettingsUpdated as EventListener);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void syncUiSettingsFromServer();
    }, LAUNCHPAD_UI_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LAUNCHPAD_UI_SETTINGS_EVENT, onSettingsUpdated as EventListener);
    };
  }, [mounted, launchpadUiStorageKey]);

  useEffect(() => {
    if (!mounted) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshAll();
    }, STATS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;

    const syncUiSettingsFromServer = async () => {
      try {
        const response = await fetch("/api/launchpad-ui", { method: "GET" });
        const payload = (await response.json().catch(() => null)) as
          | { ok: true; settings?: Partial<LaunchpadUiSettings> }
          | { ok: false; error?: string }
          | null;
        if (!response.ok || !payload?.ok) {
          return;
        }
        const remote = toLaunchpadUiSettings(payload.settings, LAUNCHPAD_UI_DEFAULTS);
        const local = loadLaunchpadUiSettings(launchpadUiStorageKey, LAUNCHPAD_UI_DEFAULTS);
        const remoteIsNewer = (remote.updatedAt || 0) >= (local.updatedAt || 0);
        if (remoteIsNewer) {
          saveLaunchpadUiSettings(launchpadUiStorageKey, remote);
          setUiSettings(remote);
        } else {
          setUiSettings(local);
        }
        lastUiSyncAtRef.current = Date.now();
      } catch {
        // Keep local cache if server settings are unavailable.
      }
    };

    const maybeRefreshVisibleState = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefreshAtRef.current < VISIBILITY_REFRESH_DEBOUNCE_MS) return;
      lastVisibilityRefreshAtRef.current = now;

      if (now - lastRefreshAllAtRef.current >= 30_000) {
        void refreshAll();
      }
      if (now - lastUiSyncAtRef.current >= 60_000) {
        void syncUiSettingsFromServer();
      }
    };

    window.addEventListener("focus", maybeRefreshVisibleState);
    document.addEventListener("visibilitychange", maybeRefreshVisibleState);
    return () => {
      window.removeEventListener("focus", maybeRefreshVisibleState);
      document.removeEventListener("visibilitychange", maybeRefreshVisibleState);
    };
  }, [mounted, launchpadUiStorageKey]);

  const fetchAllowlistProof = useCallback(async (phaseId: number, wallet: string) => {
    const walletKey = wallet.toLowerCase();
    const extractProof = (data: any) => {
      const proof = data?.proofs?.[walletKey];
      return Array.isArray(proof) ? proof : [];
    };

    try {
      const apiRes = await fetch(`/api/allowlists/proof?phaseId=${phaseId}`, { cache: "no-store" });
      if (apiRes.ok) {
        const apiData = await apiRes.json();
        const apiProof = extractProof(apiData);
        if (apiProof.length) return apiProof;
      }
    } catch {
      // fallback to static file
    }

    try {
      const staticRes = await fetch(`/allowlists/phase-${phaseId}.json`, { cache: "no-store" });
      if (!staticRes.ok) return [];
      const staticData = await staticRes.json();
      return extractProof(staticData);
    } catch {
      return [];
    }
  }, []);

  const resolveAllowlistEligibility = useCallback(
    async (phase: Phase, wallet: string) => {
      const contract = getReadContract();
      const allowed = await withReadRetry<any>(() => contract.phaseAllowlist(phase.id, wallet));
      if (allowed) {
        return true;
      }
      if (phase.allowlistRoot && phase.allowlistRoot !== ethers.constants.HashZero) {
        const proof = await fetchAllowlistProof(phase.id, wallet);
        return proof.length > 0;
      }
      return false;
    },
    [fetchAllowlistProof]
  );

  const handleCheckEligibility = async () => {
    if (checkingEligibility || isMinting) {
      return;
    }
    if (!isConnected || !address) {
      setStatus({ type: "error", message: "Connect a wallet first to check eligibility." });
      return;
    }
    if (!activePhase) {
      setStatus({ type: "error", message: "No active phase available to check." });
      return;
    }
    if (!activePhase.allowlistEnabled) {
      setAllowlistEligible(true);
      setStatus({ type: "success", message: "Current phase is public. This wallet can mint." });
      return;
    }
    try {
      setCheckingEligibility(true);
      setStatus({ type: "pending", message: "Checking eligibility..." });
      const eligible = await resolveAllowlistEligibility(activePhase, address);
      setAllowlistEligible(eligible);
      setStatus({
        type: eligible ? "success" : "error",
        message: eligible
          ? "Wallet is eligible for current allowlist phase."
          : "Wallet is not eligible for current allowlist phase.",
      });
    } catch {
      setAllowlistEligible(false);
      setStatus({ type: "error", message: "Failed to check eligibility. Please try again." });
    } finally {
      setCheckingEligibility(false);
    }
  };

  const handleMint = async () => {
    if (status.type === "pending") {
      return;
    }
    setMintSuccessToast(null);
    if (!isConnected) {
      setStatus({ type: "error", message: "Connect a wallet first" });
      return;
    }
    if (!isCorrectChain) {
      setStatus({ type: "error", message: `Switch to ${NETWORK_NAME} network` });
      return;
    }

    try {
      setStatus({ type: "pending", message: "Waiting for wallet confirmation" });
      const contract = await getWriteContract(provider);
      const [active, phaseId, , price] = await contract.getActivePhase();
      const fee = await contract.launchpadFee();
      if (!active) {
        setStatus({ type: "error", message: "No active phase available" });
        return;
      }
      if (maxMintable <= 0) {
        setStatus({ type: "error", message: "Mint is sold out for this phase." });
        return;
      }
      if (quantity > maxMintable) {
        setStatus({ type: "error", message: `Max mint right now is ${maxMintable}.` });
        return;
      }
      const allowlistEnabled = await contract.phaseAllowlistEnabled(phaseId);
      let proof: string[] = [];
      if (allowlistEnabled) {
        if (!address) {
          setStatus({ type: "error", message: "Connect a wallet to check allowlist" });
          return;
        }
        const allowed = await contract.phaseAllowlist(phaseId, address);
        if (!allowed) {
          proof = await fetchAllowlistProof(phaseId, address);
          if (!proof.length) {
            setStatus({ type: "error", message: "Wallet is not allowlisted for this phase" });
            return;
          }
        }
      }
      const totalValue = price.mul(quantity).add(fee.mul(quantity));
      const tx = await sendContractTxWithBufferedGas(
        contract,
        "publicMint",
        [quantity, proof],
        {
          value: totalValue,
          fallbackGasLimit: 360_000,
          maxAttempts: 4,
        }
      );
      setStatus({ type: "pending", message: "Transaction submitted..." });
      const receipt = await tx.wait();
      const mintedTokenIds = collectMintedTokenIds(receipt, contract, address || undefined);
      const tokenLine = formatMintedTokenLine(mintedTokenIds);
      const primaryTokenId = mintedTokenIds[0] || "";
      const explorerBase = BLOCK_EXPLORER_URL.replace(/\/$/, "");
      const explorerTxUrl = explorerBase && tx?.hash ? `${explorerBase}/tx/${tx.hash}` : "";
      const nftUrl =
        explorerBase && primaryTokenId && CONTRACT_ADDRESS
          ? `${explorerBase}/token/${CONTRACT_ADDRESS}?a=${primaryTokenId}`
          : "";
      setMintSuccessToast({
        title: "🎉 Mint Successful!",
        tokenLine,
        explorerTxUrl,
        nftUrl,
      });
      if (typeof window !== "undefined" && address) {
        const txKey = `megahop-launchpad.wallet-tx-count.${address.toLowerCase()}`;
        const currentTxCount = Number(window.localStorage.getItem(txKey) || "0");
        const nextTxCount = Number.isFinite(currentTxCount) && currentTxCount > 0 ? currentTxCount + 1 : 1;
        window.localStorage.setItem(txKey, String(nextTxCount));
      }
      setStatus({ type: "idle", message: "" });
      await refreshAll();
    } catch (error: any) {
      setStatus({
        type: "error",
        message: normalizeMintErrorMessage(error),
      });
    }
  };

  const handleSwitchNetwork = async () => {
    try {
      setStatus({ type: "pending", message: `Switching wallet to ${NETWORK_NAME}...` });
      await switchToTargetChain();
      setStatus({ type: "success", message: `Wallet switched to ${NETWORK_NAME}.` });
      await refreshAll();
    } catch (error: any) {
      const message = String(error?.message || error?.reason || "");
      const lower = message.toLowerCase();
      setStatus({
        type: "error",
        message:
          error?.code === 4001 || lower.includes("user rejected")
            ? `Switch to ${NETWORK_NAME} in your wallet to continue.`
            : `Unable to switch automatically. Please switch to ${NETWORK_NAME} in your wallet.`,
      });
    }
  };

  const maxNum = Number(maxSupply) || 0;
  const totalNum = Number(totalSupply) || 0;
  const progressPercent = maxNum > 0 ? (totalNum / maxNum) * 100 : 0;

  const activePhase = phases.find((phase) => getPhaseStatus(phase) === "live") || phases[0];
  const phaseLive = activePhase ? getPhaseStatus(activePhase) === "live" : false;
  const nextUpcomingPhase = useMemo(() => {
    const upcoming = phases
      .map((phase) => ({
        phase,
        startTs: Number(phase.startsAt || 0),
      }))
      .filter((entry) => Number.isFinite(entry.startTs) && entry.startTs > 0 && entry.startTs * 1000 > clockMs)
      .sort((a, b) => a.startTs - b.startTs);
    return upcoming[0]?.phase || null;
  }, [phases, clockMs]);
  const nextMintCountdown = useMemo(() => {
    if (!nextUpcomingPhase?.startsAt) return null;
    const diffMs = Number(nextUpcomingPhase.startsAt) * 1000 - clockMs;
    return toCountdownParts(diffMs);
  }, [nextUpcomingPhase, clockMs]);
  const showUpcomingCountdown = !paused && !phaseLive && !!nextMintCountdown;
  const allowlistRequired = Boolean(activePhase?.allowlistEnabled);
  const allowlistOk = !allowlistRequired || Boolean(allowlistEligible);
  const remainingSupply = Math.max(maxNum - totalNum, 0);
  const progressPercentRounded = Math.max(0, Math.round(progressPercent));
  const progressMintedText = totalNum.toLocaleString("en-US");
  const progressMaxText = maxNum > 0 ? maxNum.toLocaleString("en-US") : "?";
  const progressRemainingText = maxNum > 0 ? remainingSupply.toLocaleString("en-US") : "?";
  const phaseLimit = activePhase?.limitPerWallet || 1;
  const maxMintable = Math.max(0, Math.min(phaseLimit, remainingSupply || phaseLimit));
  const mintPricePerNft = Number(activePhase?.priceEth || 0);
  const feePerNft = Number(launchpadFee || 0);
  const mintCost = mintPricePerNft * quantity;
  const feeCost = feePerNft * quantity;
  const totalCost = mintCost + feeCost;

  const websiteUrl = useMemo(
    () => normalizeExternalUrl(uiSettings.collectionWebsite),
    [uiSettings.collectionWebsite]
  );
  const twitterUrl = useMemo(
    () => normalizeExternalUrl(uiSettings.collectionTwitter),
    [uiSettings.collectionTwitter]
  );
  const canIncreaseQuantity = maxMintable > 0 && quantity < maxMintable;
  const isMinting = status.type === "pending";
  const mintStatusText = paused
    ? "Paused"
    : phaseLive
    ? "Live Minting"
    : showUpcomingCountdown
    ? "Minting In"
    : "Closed";
  const mintStatusClass = paused
    ? "mint-ui-pill mint-ui-pill-paused"
    : phaseLive
    ? "mint-ui-pill mint-ui-pill-live"
    : showUpcomingCountdown
    ? "mint-ui-pill mint-ui-pill-upcoming"
    : "mint-ui-pill";
  const canMint = useMemo(() => {
    return (
      isConnected &&
      isCorrectChain &&
      phaseLive &&
      !paused &&
      allowlistOk &&
      quantity <= maxMintable &&
      !isMinting
    );
  }, [isConnected, isCorrectChain, phaseLive, paused, allowlistOk, quantity, maxMintable, isMinting]);
  const bannerSource = resolveMediaUri(
    uiSettings.collectionBannerUrl || notRevealedURI || DEFAULT_HERO_BANNER_ASSET
  );
  const previewSource = resolveMediaUri(notRevealedURI || DEFAULT_PREVIEW_ASSET);

  useEffect(() => {
    if (quantity <= 0) {
      setQuantity(1);
      return;
    }
    if (maxMintable > 0 && quantity > maxMintable) {
      setQuantity(maxMintable);
    }
  }, [quantity, maxMintable]);

  useEffect(() => {
    if (!mounted || !address || !activePhase) {
      setAllowlistEligible(null);
      return;
    }
    if (!activePhase.allowlistEnabled) {
      setAllowlistEligible(true);
      return;
    }
    const loadEligibility = async () => {
      try {
        const eligible = await resolveAllowlistEligibility(activePhase, address);
        setAllowlistEligible(eligible);
      } catch {
        setAllowlistEligible(false);
      }
    };
    loadEligibility();
  }, [mounted, address, activePhase, resolveAllowlistEligibility]);

  const handleShare = async () => {
    try {
      const shareUrl = typeof window !== "undefined" ? window.location.href : "";
      if (!shareUrl) return;
      if (navigator.share) {
        await navigator.share({ title: uiSettings.collectionName, url: shareUrl });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setStatus({ type: "success", message: "Launchpad link copied to clipboard." });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        return;
      }
      setStatus({ type: "error", message: "Unable to share link from this browser." });
    }
  };

  useEffect(() => {
    if (!status.message || status.type === "pending") return;
    const timeout = window.setTimeout(() => {
      setStatus((prev) =>
        prev.message === status.message && prev.type === status.type ? { type: "idle", message: "" } : prev
      );
    }, 3200);
    return () => window.clearTimeout(timeout);
  }, [status.message, status.type]);

  useEffect(() => {
    if (!mintSuccessToast) return;
    const timeout = window.setTimeout(() => {
      setMintSuccessToast(null);
    }, 9000);
    return () => window.clearTimeout(timeout);
  }, [mintSuccessToast]);

  useEffect(() => {
    if (!isWrongNetwork || status.type === "pending") return;
    setStatus({ type: "error", message: `Switch to ${NETWORK_NAME} in your wallet to mint.` });
  }, [isWrongNetwork, status.type]);

  if (!mounted) {
    return <div className="bg-hero min-h-screen text-white" />;
  }

  return (
    <div className="mint-ui-page bg-hero min-h-screen text-white">
      <header className="mint-ui-nav">
        <div className="mint-ui-brand">
          <img src={DEFAULT_BRAND_LOGO_ASSET} alt={`${BRAND_NAME} logo`} className="mint-ui-brand-logo" />
          <span className="mint-ui-brand-subtext">Launchpad</span>
        </div>
        <div className="mint-ui-nav-wallet">
          <WalletMenu onStatus={setStatus} />
        </div>
      </header>

      <main className="mint-ui-shell">
        <section
          className="mint-ui-hero"
          style={bannerSource ? { backgroundImage: `url(${bannerSource})` } : undefined}
        >
          <div className="mint-ui-hero-noise" />
          <div className="mint-ui-hero-scan" />
          <div className="mint-ui-hero-content">
            <div className="mint-ui-hero-focus">
              <div className="mint-ui-hero-thumb">
                {previewSource ? (
                  <img src={previewSource} alt="Collection preview" className="mint-ui-hero-thumb-image" />
                ) : (
                  <div className="mint-ui-hero-thumb-placeholder">NO PREVIEW</div>
                )}
              </div>
              <div className="mint-ui-hero-copy">
                <p className="mint-ui-eyebrow">{BRAND_NAME} LAUNCHPAD</p>
                <h1 className="mint-ui-title">{uiSettings.collectionName}</h1>
                <div className="mint-ui-links">
                  {websiteUrl ? (
                    <a
                      href={websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mint-ui-icon-link"
                      aria-label="Open website"
                      title="Website"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" className="mint-ui-link-icon">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M3 12h18" />
                        <path d="M12 3c2.8 2.4 4.5 5.6 4.5 9s-1.7 6.6-4.5 9c-2.8-2.4-4.5-5.6-4.5-9s1.7-6.6 4.5-9z" />
                      </svg>
                    </a>
                  ) : null}
                {twitterUrl ? (
                  <a
                    href={twitterUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mint-ui-icon-link"
                    aria-label="Open X"
                    title="X"
                  >
                    <span
                      aria-hidden="true"
                      className="mint-ui-link-icon mint-ui-link-icon-x mint-ui-link-icon-twitter"
                    />
                  </a>
                ) : null}
                  <button className="mint-ui-link-btn" type="button" onClick={handleShare}>
                    Share
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mint-ui-grid">
          <div className="mint-ui-left">
            <article className="mint-ui-card mint-ui-card-about">
              <h2 className="mint-ui-section-title">About Collection</h2>
              <p className="mint-ui-description">{uiSettings.collectionDescription}</p>
            </article>

            <article className="mint-ui-card">
              <h2 className="mint-ui-section-title">Details</h2>
              <div className="mint-ui-details-grid">
                <div className="mint-ui-detail">
                  <span className="mint-ui-detail-label">Contract</span>
                  <div className="mint-ui-detail-row">
                    <span>{CONTRACT_ADDRESS ? formatAddress(CONTRACT_ADDRESS) : "N/A"}</span>
                    {BLOCK_EXPLORER_URL && CONTRACT_ADDRESS ? (
                      <a
                        href={`${BLOCK_EXPLORER_URL.replace(/\/$/, "")}/address/${CONTRACT_ADDRESS}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mint-ui-detail-link"
                      >
                        View
                      </a>
                    ) : null}
                  </div>
                </div>
                <div className="mint-ui-detail">
                  <span className="mint-ui-detail-label">Blockchain</span>
                  <div className="mint-ui-detail-value mint-ui-detail-value-network">
                    <img
                      src="/megaeth-assets/mega-light.svg"
                      alt=""
                      aria-hidden="true"
                      className="mint-ui-network-icon"
                    />
                    <span>{NETWORK_NAME}</span>
                  </div>
                </div>
                <div className="mint-ui-detail">
                  <span className="mint-ui-detail-label">Token Standard</span>
                  <span className="mint-ui-detail-value">ERC-721A</span>
                </div>
              </div>
            </article>

            <article className="mint-ui-card">
              <div className="mint-ui-card-head">
                <h2 className="mint-ui-section-title">Phase Schedule</h2>
                <div className="mint-ui-card-actions">
                  <button
                    className="mint-ui-refresh-btn"
                    onClick={() => void handleCheckEligibility()}
                    disabled={checkingEligibility || refreshing || isMinting}
                  >
                    <MintGlyph
                      name="check"
                      className={`mint-ui-refresh-icon ${checkingEligibility ? "is-spinning" : ""}`}
                    />
                    <span>{checkingEligibility ? "Checking..." : "Check Eligibility"}</span>
                  </button>
                  <button
                    className="mint-ui-refresh-btn"
                    onClick={() => void refreshAll()}
                    disabled={refreshing || checkingEligibility || isMinting}
                  >
                    <MintGlyph
                      name="refresh"
                      className={`mint-ui-refresh-icon ${refreshing ? "is-spinning" : ""}`}
                    />
                    <span>{refreshing ? "Refreshing..." : "Refresh"}</span>
                  </button>
                </div>
              </div>
              <div className="mint-ui-phase-list">
                {phases.length === 0 ? (
                  <div className="mint-ui-empty">No phases configured.</div>
                ) : (
                  phases.map((phase) => {
                    const phaseStatus = getPhaseStatus(phase);
                    const isLivePhase = phaseStatus === "live";
                    return (
                      <div key={phase.id} className={`mint-ui-phase mint-ui-phase-${phaseStatus}`}>
                        <div className="mint-ui-phase-top">
                          <span
                            className={`mint-ui-phase-marker mint-ui-phase-marker-${phaseStatus}`}
                            aria-hidden="true"
                          >
                            {isLivePhase ? (
                              <MintGlyph name="clock" className="mint-ui-phase-marker-glyph" />
                            ) : (
                              <MintGlyph name="circle" className="mint-ui-phase-marker-glyph" />
                            )}
                          </span>
                          <div className="mint-ui-phase-content">
                            <div className="mint-ui-phase-head">
                              <span className="mint-ui-phase-name">{phase.name}</span>
                              <span className="mint-ui-phase-status">{phaseStatus.toUpperCase()}</span>
                            </div>
                            <div className="mint-ui-phase-meta">{formatPhaseWindow(phase)}</div>
                            <div className="mint-ui-phase-meta">
                              {phase.priceEth} {NATIVE_SYMBOL} | LIMIT {phase.limitPerWallet}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </article>
          </div>

          <aside className="mint-ui-right">
            <article className="mint-ui-card mint-ui-progress-card">
              <div className="mint-ui-progress">
                <div className="mint-ui-progress-head">
                  <span className="mint-ui-progress-label">MINT PROGRESS</span>
                </div>
                <p className="mint-ui-progress-count">
                  <span>{progressMintedText}</span>
                  <span className="mint-ui-progress-count-divider">/</span>
                  <span>{progressMaxText}</span>
                  <span className="mint-ui-progress-count-suffix">Minted</span>
                </p>
                <div className="mint-ui-progress-track">
                  <div className="mint-ui-progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mint-ui-progress-meta">
                  <span>{progressPercentRounded}% Completed</span>
                  <span aria-hidden="true">•</span>
                  <span>{progressRemainingText} Remaining</span>
                </p>
              </div>
            </article>

            <article className="mint-ui-card mint-ui-mint-panel">
              <div className={`mint-ui-mint-top${showUpcomingCountdown ? " mint-ui-mint-top-with-countdown" : ""}`}>
                <div className="mint-ui-status-box">
                  <p className="mint-ui-mini-label">Status</p>
                  <p className={mintStatusClass}>{mintStatusText}</p>
                  {showUpcomingCountdown && nextMintCountdown && nextUpcomingPhase ? (
                    <div className="mint-ui-status-countdown">
                      <p className="mint-ui-status-countdown-phase">{nextUpcomingPhase.name || "Next phase"}</p>
                      <div className="mint-ui-status-countdown-grid">
                        <div className="mint-ui-status-countdown-item">
                          <span className="mint-ui-status-countdown-value">{nextMintCountdown.days}</span>
                          <span className="mint-ui-status-countdown-unit">Days</span>
                        </div>
                        <div className="mint-ui-status-countdown-item">
                          <span className="mint-ui-status-countdown-value">{nextMintCountdown.hours}</span>
                          <span className="mint-ui-status-countdown-unit">Hours</span>
                        </div>
                        <div className="mint-ui-status-countdown-item">
                          <span className="mint-ui-status-countdown-value">{nextMintCountdown.minutes}</span>
                          <span className="mint-ui-status-countdown-unit">Mins</span>
                        </div>
                        <div className="mint-ui-status-countdown-item">
                          <span className="mint-ui-status-countdown-value">{nextMintCountdown.seconds}</span>
                          <span className="mint-ui-status-countdown-unit">Secs</span>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="mint-ui-price-box">
                  <p className="mint-ui-mini-label">Price</p>
                  <div className="mint-ui-price-row">
                    <img src={ETH_ICON_ASSET} alt={`${NATIVE_SYMBOL} icon`} className="mint-ui-price-icon" />
                    <p className="mint-ui-price">
                      {activePhase ? `${activePhase.priceEth} ${NATIVE_SYMBOL}` : "-"}
                    </p>
                  </div>
                </div>
              </div>

            <div className="mint-ui-qty-box">
              <span className="mint-ui-mini-label">Quantity</span>
              <div className="mint-ui-qty-control">
                <button
                  className="mint-ui-qty-btn"
                  disabled={quantity <= 1 || isMinting}
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                >
                  −
                </button>
                <span className="mint-ui-qty-value">{quantity}</span>
                <button
                  className="mint-ui-qty-btn"
                  disabled={!canIncreaseQuantity || isMinting}
                  onClick={() => setQuantity((q) => q + 1)}
                >
                  +
                </button>
              </div>
            </div>

            <div className="mint-ui-breakdown">
              <div className="mint-ui-breakdown-row">
                <span>Phase</span>
                <span>{activePhase?.name || "None"}</span>
              </div>
              <div className="mint-ui-breakdown-row">
                <span>Limit per wallet</span>
                <span>{activePhase?.limitPerWallet || "-"}</span>
              </div>
              <div className="mint-ui-breakdown-row">
                <span>Mint Cost</span>
                <span>{mintCost.toFixed(4)} {NATIVE_SYMBOL}</span>
              </div>
            </div>

            <div className="mint-ui-footer-meta">
              {maxMintable > 0 ? (
                <span>Max now: {maxMintable}</span>
              ) : (
                <span className="mint-ui-text-danger">Sold out</span>
              )}
            </div>

            {isWrongNetwork ? (
              <div className="admin-alert admin-alert-warn" style={{ marginBottom: 12 }}>
                Wrong network detected. Switch to {NETWORK_NAME} to mint.
              </div>
            ) : null}

            <button
              className="mint-ui-submit"
              disabled={isMinting || (!canMint && !isWrongNetwork)}
              onClick={isWrongNetwork ? () => void handleSwitchNetwork() : handleMint}
            >
              {isMinting
                ? "PROCESSING..."
                : isWrongNetwork
                ? `SWITCH TO ${NETWORK_NAME.toUpperCase()}`
                : canMint
                ? "MINT NOW"
                : isConnected && isCorrectChain && allowlistRequired && allowlistEligible === false
                ? "NOT ELIGIBLE"
                : isConnected
                ? "LOCKED"
                : "CONNECT WALLET TO PARTICIPATE"}
            </button>

              <div className="mint-ui-note">
                Verified smart contract on {NETWORK_NAME}. Launchpad fee per NFT: {feePerNft.toFixed(4)} {NATIVE_SYMBOL}.
              </div>
            </article>
          </aside>
        </section>
      </main>

      <footer className="mint-ui-site-footer">
        <section className="mint-ui-footer-join">
          <div className="mint-ui-footer-earth">
            <video className="mint-ui-footer-earth-video" autoPlay muted loop playsInline>
              <source src={FOOTER_EARTH_ASSET} type="video/webm" />
            </video>
          </div>
          <p className="mint-ui-footer-join-line">
            <span className="mint-ui-footer-join-tag">[JOIN US]</span>
            <strong>BUILD THE WORLD IN REAL TIME</strong>
          </p>
        </section>

        <section className="mint-ui-footer-panel">
          <div className="mint-ui-footer-meta-row">
            <p className="mint-ui-footer-copyright">© 2026 MEGAHOP. ALL RIGHTS RESERVED.</p>
          </div>
          <img src={DEFAULT_BRAND_LOGO_ASSET} alt="Megahop" className="mint-ui-footer-wordmark-logo" />
        </section>
      </footer>

      {mintSuccessToast || status.message ? (
        <div className="admin-toast-stack mint-ui-toast-stack">
          {mintSuccessToast ? (
            <div className="admin-toast is-success mint-ui-success-toast">
              <p className="mint-ui-success-toast-title">{mintSuccessToast.title}</p>
              <p className="mint-ui-success-toast-token">{mintSuccessToast.tokenLine}</p>
              <div className="mint-ui-success-toast-links">
                {mintSuccessToast.explorerTxUrl ? (
                  <a
                    href={mintSuccessToast.explorerTxUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mint-ui-success-toast-link"
                  >
                    View on Explorer
                  </a>
                ) : null}
                {mintSuccessToast.nftUrl ? (
                  <a
                    href={mintSuccessToast.nftUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mint-ui-success-toast-link"
                  >
                    View NFT
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}
          {status.message ? (
            <div
              className={`admin-toast ${
                status.type === "success" ? "is-success" : status.type === "error" ? "is-error" : "is-pending"
              }`}
            >
              {status.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
