import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentType, type SVGProps } from "react";
import { ethers } from "ethers";
import Link from "next/link";
import { useActiveAccount, useActiveWalletChain, useActiveWalletConnectionStatus } from "thirdweb/react";
import {
  AdjustmentsHorizontalIcon,
  ArchiveBoxIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  BanknotesIcon,
  BoltIcon,
  CircleStackIcon,
  Cog6ToothIcon,
  CurrencyDollarIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  PauseIcon,
  PhotoIcon,
  QueueListIcon,
  ShieldCheckIcon,
  SignalIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import {
  CONTRACT_ADDRESS,
  formatAddress,
  getReadContract,
  getWriteContract,
  getWriteSigner,
  isSameAddress,
  TARGET_CHAIN_ID,
  withReadRetry,
} from "../lib/contract";
import {
  buildLaunchpadUiPayloadHash,
  buildLaunchpadUiPublishMessage,
  LaunchpadUiDefaults,
  LaunchpadUiSettings,
  getLaunchpadUiStorageKey,
  loadLaunchpadUiSettings,
  normalizeLaunchpadUiDefaults,
  saveLaunchpadUiSettings,
  toLaunchpadUiSettings,
} from "../lib/launchpadUi";
import WalletMenu from "../components/WalletMenu";
import { Phase, formatPhaseWindow, fromInputDateTime, getPhaseStatus, toInputDateTime } from "../lib/phases";

const NETWORK_NAME = process.env.NEXT_PUBLIC_NETWORK_NAME || "MegaETH Testnet";
const NATIVE_SYMBOL = process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH";
const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "Megahop";
const BLOCK_EXPLORER_URL = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "";
const DEFAULT_COLLECTION_NAME = process.env.NEXT_PUBLIC_COLLECTION_NAME || "Megahop";
const DEFAULT_COLLECTION_DESCRIPTION =
  process.env.NEXT_PUBLIC_COLLECTION_DESCRIPTION ||
  "The Megahop NFT collection on MegaETH with phased minting, allowlist control, admin tooling, and launchpad fee support.";
const DEFAULT_COLLECTION_BANNER_URL = process.env.NEXT_PUBLIC_COLLECTION_BANNER_URL || "";
const DEFAULT_COLLECTION_WEBSITE = process.env.NEXT_PUBLIC_COLLECTION_WEBSITE || "";
const DEFAULT_COLLECTION_TWITTER = process.env.NEXT_PUBLIC_COLLECTION_TWITTER || "";
const DEFAULT_BRAND_LOGO_ASSET = "/megaeth-assets/4afa304f-02e0-4249-b5cd-6ee5a6627079.svg";

const LAUNCHPAD_UI_DEFAULTS: LaunchpadUiDefaults = {
  collectionName: DEFAULT_COLLECTION_NAME,
  collectionDescription: DEFAULT_COLLECTION_DESCRIPTION,
  collectionBannerUrl: DEFAULT_COLLECTION_BANNER_URL,
  collectionWebsite: DEFAULT_COLLECTION_WEBSITE,
  collectionTwitter: DEFAULT_COLLECTION_TWITTER,
};
const FALLBACK_SUPPORTED_CHAIN_IDS = [4326, 6343];
const SUPPORTED_CHAIN_IDS = TARGET_CHAIN_ID
  ? [TARGET_CHAIN_ID]
  : FALLBACK_SUPPORTED_CHAIN_IDS;

type TxStatus = {
  type: "pending" | "success" | "error" | "idle";
  message: string;
};

type AdminTab = "dashboard" | "metadata" | "mint_phases" | "settings";

type TxLogItem = {
  id: string;
  label: string;
  status: "success" | "error";
  message: string;
  hash?: string;
  createdAt: number;
};

type ToastItem = {
  id: string;
  type: TxStatus["type"];
  message: string;
};

type ConfirmAction = {
  title: string;
  description: string;
  warning?: string;
  confirmLabel: string;
  tone?: "danger" | "warning" | "neutral";
  onConfirm: () => Promise<void>;
};

const GAS_LIMIT_FALLBACK = 280_000;
const GAS_LIMIT_BUFFER_NUMERATOR = 12;
const GAS_LIMIT_BUFFER_DENOMINATOR = 10;

const isLikelyValidUri = (value: string) => {
  const next = value.trim();
  if (!next) return false;
  return /^ipfs:\/\/.+/i.test(next) || /^https?:\/\/.+/i.test(next);
};

const formatTimeAgo = (timestamp: number) => {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
};

const formatCountdown = (targetUnixSeconds: number, nowMs: number) => {
  if (!targetUnixSeconds || targetUnixSeconds <= 0) return "No schedule";
  const diff = Math.max(targetUnixSeconds - Math.floor(nowMs / 1000), 0);
  if (diff <= 0) return "Now";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const normalizeWalletList = (wallets: string[]) =>
  Array.from(new Set(wallets.map((wallet) => ethers.utils.getAddress(wallet)))).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

const hashAllowlistLeaf = (wallet: string) =>
  ethers.utils.keccak256(ethers.utils.solidityPack(["address"], [wallet]));

const hashMerklePair = (a: string, b: string) => {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return ethers.utils.keccak256(ethers.utils.concat([left, right]));
};

const buildNextMerkleLayer = (layer: string[]) => {
  const next: string[] = [];
  for (let index = 0; index < layer.length; index += 2) {
    if (index + 1 >= layer.length) {
      next.push(layer[index]);
    } else {
      next.push(hashMerklePair(layer[index], layer[index + 1]));
    }
  }
  return next;
};

const buildAllowlistMerkleData = (wallets: string[]) => {
  if (!wallets.length) {
    return { root: ethers.constants.HashZero, proofs: {} as Record<string, string[]> };
  }
  const leaves = wallets.map(hashAllowlistLeaf);
  const proofs: Record<string, string[]> = {};

  wallets.forEach((wallet, originalIndex) => {
    const proof: string[] = [];
    let index = originalIndex;
    let layer = leaves.slice();
    while (layer.length > 1) {
      const pairIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (pairIndex < layer.length) {
        proof.push(layer[pairIndex]);
      }
      layer = buildNextMerkleLayer(layer);
      index = Math.floor(index / 2);
    }
    proofs[wallet.toLowerCase()] = proof;
  });

  let rootLayer = leaves.slice();
  while (rootLayer.length > 1) {
    rootLayer = buildNextMerkleLayer(rootLayer);
  }

  return {
    root: rootLayer[0] || ethers.constants.HashZero,
    proofs,
  };
};

const downloadJsonFile = (filename: string, payload: unknown) => {
  if (typeof window === "undefined") return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const buildProofsHash = (proofs: Record<string, string[]>) =>
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes(stableStringify(proofs)));

const buildAllowlistPublishMessage = (params: {
  contractAddress: string;
  phaseId: number;
  root: string;
  total: number;
  proofsHash: string;
  timestamp: number;
}) =>
  [
    "Megahop Allowlist Publish",
    `contract:${params.contractAddress.toLowerCase()}`,
    `phaseId:${params.phaseId}`,
    `root:${params.root.toLowerCase()}`,
    `total:${params.total}`,
    `proofsHash:${params.proofsHash.toLowerCase()}`,
    `timestamp:${params.timestamp}`,
  ].join("\n");

const extractTxErrorMessage = (error: any) => {
  const candidates = [
    error?.reason,
    error?.shortMessage,
    error?.message,
    error?.error?.reason,
    error?.error?.message,
    error?.data?.message,
    error?.data?.originalError?.message,
    error?.error?.data?.message,
    error?.error?.data?.originalError?.message,
  ];
  const raw = candidates.find((item) => typeof item === "string" && item.trim().length > 0) || "";
  if (!raw) return "Transaction failed";

  const reverted = raw.match(/execution reverted(?::)?\s*(.*)/i);
  if (reverted?.[1]) {
    return reverted[1].trim();
  }

  if (/intrinsic gas too low|gas too low/i.test(raw)) {
    return "Gas limit too low. Retry now (the app sends a higher gas limit automatically).";
  }

  if (/maxfeepergas cannot be less than maxpriorityfeepergas/i.test(raw)) {
    return "Gas fee mismatch detected. Retry now (the app now sends corrected EIP-1559 fees).";
  }

  if (/user rejected|user denied|rejected transaction|cancelled/i.test(raw)) {
    return "Transaction rejected in wallet";
  }

  return raw;
};

const isLikelyRevertReason = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("revert") ||
    normalized.includes("owner") ||
    normalized.includes("metadata frozen") ||
    normalized.includes("must reduce") ||
    normalized.includes("already frozen") ||
    normalized.includes("zero recipient") ||
    normalized.includes("below total supply") ||
    normalized.includes("invalid")
  );
};

type AdminGlyphName =
  | "dashboard"
  | "metadata"
  | "phases"
  | "settings"
  | "operations"
  | "pause"
  | "eye"
  | "shield"
  | "supply"
  | "treasury"
  | "fee"
  | "activity"
  | "health"
  | "preview"
  | "allowlist"
  | "warning"
  | "upload"
  | "merkle"
  | "download";

type AdminGlyphComponent = ComponentType<SVGProps<SVGSVGElement>>;

const ADMIN_GLYPHS: Record<AdminGlyphName, AdminGlyphComponent> = {
  dashboard: Squares2X2Icon,
  metadata: PhotoIcon,
  phases: QueueListIcon,
  settings: Cog6ToothIcon,
  operations: AdjustmentsHorizontalIcon,
  pause: PauseIcon,
  eye: EyeIcon,
  shield: ShieldCheckIcon,
  supply: ArchiveBoxIcon,
  treasury: BanknotesIcon,
  fee: CurrencyDollarIcon,
  activity: BoltIcon,
  health: SignalIcon,
  preview: PhotoIcon,
  allowlist: ShieldCheckIcon,
  warning: ExclamationTriangleIcon,
  upload: ArrowUpTrayIcon,
  merkle: CircleStackIcon,
  download: ArrowDownTrayIcon,
};

function AdminGlyph({ name, className = "" }: { name: AdminGlyphName; className?: string }) {
  const classes = `admin-icon ${className}`.trim();
  const Icon = ADMIN_GLYPHS[name];
  return <Icon className={classes} aria-hidden="true" />;
}

export default function Admin() {
  const [mounted, setMounted] = useState(false);
  const account = useActiveAccount();
  const chain = useActiveWalletChain();
  const connectionStatus = useActiveWalletConnectionStatus();
  const address = account?.address;
  const isConnected = connectionStatus === "connected" && !!address;

  const [owner, setOwner] = useState<string>("");
  const [baseURI, setBaseURI] = useState<string>("");
  const [notRevealedURI, setNotRevealedURI] = useState<string>("");
  const [mintPrice, setMintPrice] = useState("0");
  const [maxSupply, setMaxSupply] = useState("0");
  const [maxSupplyInput, setMaxSupplyInput] = useState("");
  const [maxMintPerWallet, setMaxMintPerWallet] = useState("0");
  const [withdrawableBalance, setWithdrawableBalance] = useState("0");
  const [launchpadFee, setLaunchpadFee] = useState("0");
  const [feeRecipient, setFeeRecipient] = useState<string>("");
  const [feeRecipientInput, setFeeRecipientInput] = useState("");
  const [launchpadFeeInput, setLaunchpadFeeInput] = useState("");
  const [paused, setPaused] = useState(false);
  const [transfersLocked, setTransfersLocked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [metadataFrozen, setMetadataFrozen] = useState(false);
  const [totalSupply, setTotalSupply] = useState("0");
  const [status, setStatus] = useState<TxStatus>({ type: "idle", message: "" });
  const [phases, setPhases] = useState<Phase[]>([]);
  const [editingPhaseId, setEditingPhaseId] = useState<number | null>(null);
  const [phaseForm, setPhaseForm] = useState({
    name: "",
    priceEth: "",
    limitPerWallet: "",
    startsAt: "",
    endsAt: "",
  });
  const [allowlistEnabled, setAllowlistEnabled] = useState(false);
  const [allowlistWallets, setAllowlistWallets] = useState("");
  const [allowlistRoot, setAllowlistRoot] = useState("");
  const [allowlistSaved, setAllowlistSaved] = useState<string[]>([]);
  const [allowlistDirty, setAllowlistDirty] = useState(false);
  const [allowlistProofDownloaded, setAllowlistProofDownloaded] = useState(false);
  const allowlistCsvInputRef = useRef<HTMLInputElement | null>(null);
  const [activePhaseInfo, setActivePhaseInfo] = useState<{ id: number; name: string } | null>(null);
  const [launchpadUiForm, setLaunchpadUiForm] = useState<LaunchpadUiDefaults>(LAUNCHPAD_UI_DEFAULTS);
  const [launchpadUiSavedAt, setLaunchpadUiSavedAt] = useState<number | null>(null);
  const [appearanceSaveState, setAppearanceSaveState] = useState<"saved" | "saving" | "unsaved">("saved");
  const [activeTab, setActiveTab] = useState<AdminTab>("dashboard");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPhasesLoading, setIsPhasesLoading] = useState(false);
  const [phaseEditorOpen, setPhaseEditorOpen] = useState(false);
  const [draggingPhaseId, setDraggingPhaseId] = useState<number | null>(null);
  const [phaseOrder, setPhaseOrder] = useState<number[]>([]);
  const [metadataUpdatedAt, setMetadataUpdatedAt] = useState<number | null>(null);
  const [lastMetadataTxHash, setLastMetadataTxHash] = useState("");
  const [lastWithdrawAt, setLastWithdrawAt] = useState<number | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [txHistory, setTxHistory] = useState<TxLogItem[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [clockMs, setClockMs] = useState(Date.now());

  const isSupportedChain = !chain || SUPPORTED_CHAIN_IDS.includes(chain.id);
  const isTargetChain = TARGET_CHAIN_ID ? !!chain && chain.id === TARGET_CHAIN_ID : true;
  const isCorrectChain = isSupportedChain && isTargetChain;
  const launchpadUiStorageKey = useMemo(
    () => getLaunchpadUiStorageKey(CONTRACT_ADDRESS, TARGET_CHAIN_ID || chain?.id),
    [chain?.id]
  );

  const getAdminReadContract = () => {
    // Always use the shared fallback RPC provider for reads.
    // Using wallet signer/provider for reads can hit single-endpoint rate limits (429).
    return getReadContract();
  };

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      const contract = getAdminReadContract();
      const [
        ownerAddress,
        isPaused,
        locked,
        isRevealed,
        isMetadataFrozen,
        currentBaseURI,
        currentNotRevealedURI,
        price,
        supply,
        maxPerWallet,
        fee,
        recipient,
      ] = await withReadRetry(() =>
        Promise.all([
          contract.owner(),
          contract.paused(),
          contract.transfersLocked(),
          contract.revealed(),
          contract.metadataFrozen(),
          contract.baseURI(),
          contract.notRevealedURI(),
          contract.mintPrice(),
          contract.maxSupply(),
          contract.maxMintPerWallet(),
          contract.launchpadFee(),
          contract.feeRecipient(),
        ])
      );
      setOwner(ownerAddress);
      setPaused(isPaused);
      setTransfersLocked(locked);
      setRevealed(isRevealed);
      setMetadataFrozen(isMetadataFrozen);
      setBaseURI(currentBaseURI || "");
      setNotRevealedURI(currentNotRevealedURI || "");
      setMintPrice(ethers.utils.formatEther(price));
      setMaxSupply(supply.toString());
      if (!maxSupplyInput) {
        setMaxSupplyInput(supply.toString());
      }
      setMaxMintPerWallet(maxPerWallet.toString());
      setLaunchpadFee(ethers.utils.formatEther(fee));
      setFeeRecipient(recipient || "");
      setLaunchpadFeeInput(ethers.utils.formatEther(fee));
      setFeeRecipientInput(recipient || "");
      try {
        const minted = await withReadRetry(() => contract.totalSupply());
        setTotalSupply(minted?.toString?.() || "0");
      } catch {
        setTotalSupply("0");
      }
      try {
        const balance = await withReadRetry(() => contract.provider.getBalance(CONTRACT_ADDRESS));
        setWithdrawableBalance(ethers.utils.formatEther(balance));
      } catch {
        setWithdrawableBalance("0");
      }
      if (status.type === "error") {
        setStatus({ type: "idle", message: "" });
      }
    } catch (error: any) {
      setStatus({ type: "error", message: error?.message || "Failed to load" });
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!mounted) return;
    refresh();
  }, [mounted, address, chain?.id]);

  const refreshPhases = async () => {
    setIsPhasesLoading(true);
    try {
      const contract = getAdminReadContract();
      const [count, active] = await withReadRetry(() =>
        Promise.all([contract.phaseCount(), contract.getActivePhase()])
      );
      if (active?.[0]) {
        setActivePhaseInfo({ id: Number(active[1]), name: active[2] });
      } else {
        setActivePhaseInfo(null);
      }
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
      const filtered = items.filter(Boolean) as Phase[];
      setPhases(filtered);
    } catch (error: any) {
      setStatus({ type: "error", message: error?.message || "Failed to load phases" });
    } finally {
      setIsPhasesLoading(false);
    }
  };

  useEffect(() => {
    if (!mounted) return;
    refreshPhases();
  }, [mounted]);

  // (moved below helper definitions)


  const isOwner = useMemo(() => {
    return isSameAddress(address, owner);
  }, [address, owner]);

  const canManage = isConnected && isOwner && isCorrectChain;
  const isBusy = status.type === "pending";

  const appendTxLog = (entry: Omit<TxLogItem, "id" | "createdAt">) => {
    setTxHistory((prev) => [
      {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        createdAt: Date.now(),
      },
      ...prev,
    ].slice(0, 12));
  };

  const requestConfirm = (
    config: Omit<ConfirmAction, "onConfirm">,
    onConfirm: () => Promise<void>
  ) => {
    setConfirmAction({ ...config, onConfirm });
  };

  const ensureReady = () => {
    if (!isConnected) {
      setStatus({ type: "error", message: "Connect a wallet first" });
      return false;
    }
    if (!isSupportedChain) {
      setStatus({ type: "error", message: `Switch to ${NETWORK_NAME} network` });
      return false;
    }
    if (!isTargetChain) {
      setStatus({ type: "error", message: `Switch to ${NETWORK_NAME} network` });
      return false;
    }
    if (!isOwner) {
      setStatus({ type: "error", message: "Owner wallet required" });
      return false;
    }
    return true;
  };

  const withTx = async (
    label: string,
    fn: () => Promise<string | void>
  ) => {
    try {
      setStatus({ type: "pending", message: "Waiting for confirmation" });
      const hash = await fn();
      setStatus({ type: "success", message: "Transaction confirmed" });
      appendTxLog({
        label,
        status: "success",
        hash: hash || undefined,
        message: "Transaction confirmed",
      });
      await refresh();
      await refreshPhases();
      return hash;
    } catch (error: any) {
      const message = extractTxErrorMessage(error);
      setStatus({
        type: "error",
        message,
      });
      appendTxLog({
        label,
        status: "error",
        message,
      });
      return undefined;
    }
  };

  const sendTxWithBufferedGas = async (
    contract: any,
    methodName: string,
    args: any[] = [],
    fallbackGasLimit = GAS_LIMIT_FALLBACK
  ) => {
    const method = contract?.[methodName];
    if (typeof method !== "function") {
      throw new Error(`Contract method not found: ${methodName}`);
    }

    const txOverrides: Record<string, any> = {};

    let gasLimit = ethers.BigNumber.from(fallbackGasLimit);
    const estimateMethod = contract?.estimateGas?.[methodName];
    if (typeof estimateMethod === "function") {
      try {
        const estimated = await estimateMethod(...args);
        gasLimit = estimated
          .mul(GAS_LIMIT_BUFFER_NUMERATOR)
          .div(GAS_LIMIT_BUFFER_DENOMINATOR);
      } catch (estimateError: any) {
        const estimateMessage = extractTxErrorMessage(estimateError);
        if (isLikelyRevertReason(estimateMessage)) {
          throw new Error(estimateMessage);
        }
      }
    }
    txOverrides.gasLimit = gasLimit;

    const provider = contract?.provider || contract?.signer?.provider;
    if (provider?.getFeeData) {
      try {
        const feeData = await provider.getFeeData();
        if (feeData?.maxFeePerGas && feeData?.maxPriorityFeePerGas) {
          let maxPriorityFeePerGas = ethers.BigNumber.from(feeData.maxPriorityFeePerGas);
          let maxFeePerGas = ethers.BigNumber.from(feeData.maxFeePerGas);

          if (maxPriorityFeePerGas.lte(0)) {
            maxPriorityFeePerGas = ethers.utils.parseUnits("1", "gwei");
          }
          if (maxFeePerGas.lt(maxPriorityFeePerGas)) {
            maxFeePerGas = maxPriorityFeePerGas.mul(2);
          }

          txOverrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
          txOverrides.maxFeePerGas = maxFeePerGas;
        } else if (feeData?.gasPrice) {
          txOverrides.gasPrice = feeData.gasPrice;
        }
      } catch {
        // Ignore fee override and let wallet/provider decide.
      }
    }

    const tx = await method(...args, txOverrides);
    await tx.wait();
    return tx?.hash as string | undefined;
  };

  const handleSetBaseURI = async () => {
    if (!ensureReady()) return;
    if (metadataFrozen) {
      setStatus({ type: "error", message: "Metadata is frozen and cannot be changed" });
      return;
    }
    if (!baseURI.trim()) {
      setStatus({ type: "error", message: "Base URI cannot be empty" });
      return;
    }
    const hash = await withTx("Update Base URI", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, "setBaseURI", [baseURI.trim()]);
    });
    if (hash) {
      setMetadataUpdatedAt(Date.now());
      setLastMetadataTxHash(hash);
    }
  };

  const handleSetNotRevealedURI = async () => {
    if (!ensureReady()) return;
    if (metadataFrozen) {
      setStatus({ type: "error", message: "Metadata is frozen and cannot be changed" });
      return;
    }
    if (!notRevealedURI.trim()) {
      setStatus({ type: "error", message: "Reveal image URI cannot be empty" });
      return;
    }
    const hash = await withTx("Update Reveal Image URI", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, "setNotRevealedURI", [notRevealedURI.trim()]);
    });
    if (hash) {
      setMetadataUpdatedAt(Date.now());
      setLastMetadataTxHash(hash);
    }
  };

  const handleSetMaxSupply = async () => {
    if (!ensureReady()) return;
    const nextValue = Number(maxSupplyInput);
    const currentValue = Number(maxSupply);
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      setStatus({ type: "error", message: "Enter a valid max supply" });
      return;
    }
    if (nextValue >= currentValue) {
      setStatus({ type: "error", message: "Cut supply must be lower than current max supply" });
      return;
    }
    await withTx("Cut Max Supply", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, "setMaxSupply", [nextValue]);
    });
  };

  const handlePauseToggle = async () => {
    if (!ensureReady()) return;
    await withTx(paused ? "Resume Minting" : "Pause New Mints", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, paused ? "unpause" : "pause", []);
    });
  };

  const handleWithdraw = async () => {
    if (!ensureReady()) return;
    const hash = await withTx("Withdraw Treasury", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, "withdraw", []);
    });
    if (hash) {
      setLastWithdrawAt(Date.now());
    }
  };

  const handleToggleTransfers = async () => {
    if (!ensureReady()) return;
    await withTx(
      transfersLocked ? "Unfreeze Transfers" : "Freeze Transfers",
      async () => {
        const contract = await getWriteContract(account, chain);
        return sendTxWithBufferedGas(contract, "setTransfersLocked", [!transfersLocked]);
      }
    );
  };

  const handleToggleReveal = async () => {
    if (!ensureReady()) return;
    if (metadataFrozen) {
      setStatus({ type: "error", message: "Metadata is frozen and reveal state cannot be changed" });
      return;
    }
    const hash = await withTx(revealed ? "Hide Metadata" : "Reveal Metadata", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, "setRevealed", [!revealed]);
    });
    if (hash) {
      setMetadataUpdatedAt(Date.now());
      setLastMetadataTxHash(hash);
    }
  };

  const handleFreezeMetadata = async () => {
    if (!ensureReady()) return;
    if (metadataFrozen) {
      setStatus({ type: "error", message: "Metadata is already frozen" });
      return;
    }
    const hash = await withTx("Freeze Metadata", async () => {
      const contract = await getWriteContract(account, chain);
      return sendTxWithBufferedGas(contract, "freezeMetadata", []);
    });
    if (hash) {
      setMetadataUpdatedAt(Date.now());
      setLastMetadataTxHash(hash);
    }
  };

  const handleUpdateLaunchpadFee = async () => {
    if (!ensureReady()) return;
    if (!feeRecipientInput || !ethers.utils.isAddress(feeRecipientInput)) {
      setStatus({ type: "error", message: "Enter a valid fee recipient address" });
      return;
    }
    let feeWei;
    try {
      feeWei = ethers.utils.parseEther(launchpadFeeInput || "0");
    } catch {
      setStatus({ type: "error", message: "Invalid fee amount" });
      return;
    }

    const currentFeeWei = ethers.utils.parseEther(launchpadFee || "0");
    const recipientChanged =
      feeRecipientInput && !isSameAddress(feeRecipientInput, feeRecipient);
    const feeChanged = !currentFeeWei.eq(feeWei);

    if (!recipientChanged && !feeChanged) {
      setStatus({ type: "success", message: "Launchpad fee already up to date" });
      return;
    }

    await withTx("Update Launchpad Fee", async () => {
      const contract = await getWriteContract(account, chain);
      let hash = "";
      if (recipientChanged) {
        hash = (await sendTxWithBufferedGas(contract, "setFeeRecipient", [feeRecipientInput])) || hash;
      }
      if (feeChanged) {
        hash = (await sendTxWithBufferedGas(contract, "setLaunchpadFee", [feeWei])) || hash;
      }
      return hash;
    });
  };


  const handleCopyContract = async () => {
    if (!CONTRACT_ADDRESS) return;
    try {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
      setStatus({ type: "success", message: "Contract address copied" });
    } catch (error: any) {
      setStatus({ type: "error", message: "Failed to copy address" });
    }
  };

  const resetPhaseForm = () => {
    setEditingPhaseId(null);
    setAllowlistEnabled(false);
    setAllowlistRoot("");
    setAllowlistWallets("");
    setAllowlistSaved([]);
    setAllowlistDirty(false);
    setAllowlistProofDownloaded(false);
    setPhaseForm({
      name: "",
      priceEth: "",
      limitPerWallet: "",
      startsAt: "",
      endsAt: "",
    });
  };

  const publishAllowlistProofJson = async (
    phaseId: number,
    root: string,
    proofs: Record<string, string[]>,
    total: number
  ) => {
    if (!address) {
      throw new Error("Owner wallet not connected for proof publish signature.");
    }
    const proofsHash = buildProofsHash(proofs);
    const timestamp = Date.now();
    const message = buildAllowlistPublishMessage({
      contractAddress: CONTRACT_ADDRESS,
      phaseId,
      root,
      total,
      proofsHash,
      timestamp,
    });

    let signature = "";
    try {
      if (typeof account?.signMessage === "function") {
        const signed = await account.signMessage({ message } as any);
        signature = typeof signed === "string" ? signed : "";
        if (!signature) {
          signature = await account.signMessage(message as any);
        }
      } else {
        const contract = await getWriteContract(account, chain);
        signature = await contract.signer.signMessage(message);
      }
    } catch (error: any) {
      throw new Error(error?.message || "Signature rejected. Cannot publish proof.");
    }

    const response = await fetch("/api/allowlists/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phaseId,
        root,
        proofs,
        total,
        mode: "address-only-merkle",
        generatedAt: new Date().toISOString(),
        signer: address,
        proofsHash,
        timestamp,
        signature,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || "Failed to publish allowlist proof.");
    }
    return payload as { ok: boolean; path?: string };
  };

  const handleSavePhase = async () => {
    if (!ensureReady()) return;
    if (!phaseForm.name.trim()) {
      setStatus({ type: "error", message: "Phase name is required" });
      return;
    }
    const priceInput = phaseForm.priceEth.trim() || mintPrice || "0";
    const limitInput = Number(phaseForm.limitPerWallet || maxMintPerWallet || 0);
    if (!Number.isFinite(limitInput) || limitInput <= 0) {
      setStatus({ type: "error", message: "Limit per wallet must be greater than 0" });
      return;
    }
    const startTime = fromInputDateTime(phaseForm.startsAt);
    const endTime = fromInputDateTime(phaseForm.endsAt);
    if (endTime && startTime && endTime <= startTime) {
      setStatus({ type: "error", message: "End date must be after start date" });
      return;
    }
    if (allowlistEnabled && allowlistDirty) {
      setStatus({ type: "error", message: "Whitelist changed. Generate merkle root again before saving." });
      return;
    }
    let resolvedRoot = allowlistRoot.trim();
    const parsedAllowlist = parseWallets(allowlistWallets);
    const normalizedAllowlistWallets = normalizeWalletList(parsedAllowlist.valid);
    const generatedMerkle =
      normalizedAllowlistWallets.length > 0 ? buildAllowlistMerkleData(normalizedAllowlistWallets) : null;
    if (allowlistEnabled && !resolvedRoot && generatedMerkle) {
      resolvedRoot = generatedMerkle.root;
      setAllowlistRoot(resolvedRoot);
    }
    if (allowlistEnabled && !resolvedRoot) {
      setStatus({ type: "error", message: "Allowlist root is required when Allowlist mode is enabled." });
      return;
    }
    if (
      allowlistEnabled &&
      generatedMerkle &&
      resolvedRoot &&
      resolvedRoot.toLowerCase() !== generatedMerkle.root.toLowerCase()
    ) {
      setStatus({
        type: "error",
        message: "Merkle root does not match wallet list. Regenerate root or clear wallet list.",
      });
      return;
    }
    if (allowlistEnabled && !ethers.utils.isHexString(resolvedRoot, 32)) {
      setStatus({ type: "error", message: "Allowlist root must be a valid 32-byte hex string." });
      return;
    }
    let savedPhaseId: number | null = null;
    await withTx(editingPhaseId !== null ? "Update Phase + Eligibility" : "Add Phase + Eligibility", async () => {
      const contract = await getWriteContract(account, chain);
      const priceWei = ethers.utils.parseEther(priceInput);
      let phaseId = editingPhaseId;
      let hash = "";
      if (editingPhaseId !== null) {
        hash =
          (await sendTxWithBufferedGas(contract, "updatePhase", [
            editingPhaseId,
            phaseForm.name.trim(),
            startTime,
            endTime,
            priceWei,
            limitInput,
          ])) || hash;
      } else {
        const countBefore = await contract.phaseCount();
        hash =
          (await sendTxWithBufferedGas(contract, "addPhase", [
            phaseForm.name.trim(),
            startTime,
            endTime,
            priceWei,
            limitInput,
          ])) || hash;
        phaseId = Number(countBefore?.toString?.() || "0");
      }

      if (phaseId === null || !Number.isFinite(phaseId)) {
        throw new Error("Failed to resolve phase ID");
      }
      savedPhaseId = phaseId;

      if (allowlistEnabled) {
        const currentRoot = await contract.phaseMerkleRoot(phaseId);
        if (currentRoot.toLowerCase() !== resolvedRoot.toLowerCase()) {
          hash = (await sendTxWithBufferedGas(contract, "setPhaseMerkleRoot", [phaseId, resolvedRoot])) || hash;
        }
      }

      const currentAllowlistEnabled = await contract.phaseAllowlistEnabled(phaseId);
      if (Boolean(currentAllowlistEnabled) !== allowlistEnabled) {
        hash =
          (await sendTxWithBufferedGas(contract, "setPhaseAllowlistEnabled", [phaseId, allowlistEnabled])) || hash;
      }

      if (normalizedAllowlistWallets.length > 0) {
        saveAllowlistToStorage(phaseId, normalizedAllowlistWallets);
      }

      return hash;
    });
    if (allowlistEnabled && savedPhaseId !== null && generatedMerkle && normalizedAllowlistWallets.length > 0) {
      try {
        const result = await publishAllowlistProofJson(
          savedPhaseId,
          generatedMerkle.root,
          generatedMerkle.proofs,
          normalizedAllowlistWallets.length
        );
        setAllowlistProofDownloaded(true);
        setStatus({
          type: "success",
          message: `Phase saved. Proof published automatically to ${result.path || `/allowlists/phase-${savedPhaseId}.json`}.`,
        });
      } catch (error: any) {
        const fallbackPayload = {
          phaseId: savedPhaseId,
          root: generatedMerkle.root,
          total: normalizedAllowlistWallets.length,
          generatedAt: new Date().toISOString(),
          mode: "address-only-merkle",
          proofs: generatedMerkle.proofs,
        };
        downloadJsonFile(`phase-${savedPhaseId}.json`, fallbackPayload);
        setAllowlistProofDownloaded(true);
        setStatus({
          type: "success",
          message:
            error?.message
              ? `Phase saved. Auto-publish unavailable (${error.message}). Fallback download started for phase-${savedPhaseId}.json.`
              : `Phase saved. Auto-publish unavailable, fallback download started for phase-${savedPhaseId}.json.`,
        });
      }
    }
    resetPhaseForm();
    setPhaseEditorOpen(false);
  };

  const handleEditPhase = (phase: Phase) => {
    setEditingPhaseId(phase.id);
    setAllowlistEnabled(Boolean(phase.allowlistEnabled));
    setAllowlistRoot(phase.allowlistRoot || "");
    const storedWallets = loadAllowlistFromStorage(phase.id);
    setAllowlistWallets(storedWallets.join("\n"));
    setAllowlistSaved(storedWallets);
    setAllowlistDirty(false);
    setAllowlistProofDownloaded(true);
    setPhaseForm({
      name: phase.name,
      priceEth: phase.priceEth,
      limitPerWallet: phase.limitPerWallet ? String(phase.limitPerWallet) : "",
      startsAt: toInputDateTime(phase.startsAt),
      endsAt: toInputDateTime(phase.endsAt),
    });
    setPhaseEditorOpen(true);
  };

  const handleDeletePhase = (phaseId: number) => {
    if (!ensureReady()) return;
    void (async () => {
      await withTx("Remove Phase", async () => {
        const contract = await getWriteContract(account, chain);
        return sendTxWithBufferedGas(contract, "removePhase", [phaseId]);
      });
      if (editingPhaseId === phaseId) {
        resetPhaseForm();
        setPhaseEditorOpen(false);
      }
    })();
  };

  const parseWallets = (input: string) => {
    const raw = input
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const unique = new Set<string>();
    const invalid: string[] = [];
    for (const value of raw) {
      if (!ethers.utils.isAddress(value)) {
        invalid.push(value);
        continue;
      }
      unique.add(ethers.utils.getAddress(value));
    }
    return { valid: Array.from(unique), invalid };
  };

  const parseWalletsFromCsv = (input: string) => {
    const matched = input.match(/0x[a-f0-9]{40}/gi) || [];
    const unique = new Set<string>();
    const invalid: string[] = [];
    for (const value of matched) {
      if (!ethers.utils.isAddress(value)) {
        invalid.push(value);
        continue;
      }
      unique.add(ethers.utils.getAddress(value));
    }
    return { valid: Array.from(unique), invalid };
  };

  const getAllowlistStorageKey = (phaseId: number | null) => {
    if (phaseId === null) return "";
    const chainId = chain?.id ?? "unknown";
    return `allowlist:${CONTRACT_ADDRESS}:${chainId}:${phaseId}`;
  };

  const loadAllowlistFromStorage = (phaseId: number | null) => {
    if (typeof window === "undefined") return [];
    const key = getAllowlistStorageKey(phaseId);
    if (!key) return [];
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const saveAllowlistToStorage = (phaseId: number | null, wallets: string[]) => {
    if (typeof window === "undefined") return;
    const key = getAllowlistStorageKey(phaseId);
    if (!key) return;
    window.localStorage.setItem(key, JSON.stringify(wallets));
  };

  const applyLaunchpadUiForm = (loaded: LaunchpadUiSettings) => {
    const nextValues = normalizeLaunchpadUiDefaults(loaded, LAUNCHPAD_UI_DEFAULTS);
    setLaunchpadUiForm(nextValues);
    setLaunchpadUiSavedAt(loaded.updatedAt || Date.now());
    setAppearanceSaveState("saved");
  };

  const fetchLaunchpadUiFromServer = async () => {
    const response = await fetch("/api/launchpad-ui", { method: "GET", cache: "no-store" });
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; settings?: Partial<LaunchpadUiSettings> }
      | { ok: false; error?: string }
      | null;
    if (!response.ok || !payload?.ok) {
      const error =
        payload && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Failed to load launchpad settings from server.";
      throw new Error(error);
    }
    return toLaunchpadUiSettings(payload.settings, LAUNCHPAD_UI_DEFAULTS);
  };

  const publishLaunchpadUiToServer = async (nextValues: LaunchpadUiDefaults) => {
    const chainIdForSignature = TARGET_CHAIN_ID || chain?.id;
    if (!chainIdForSignature) {
      throw new Error("Missing chain id for launchpad settings signature.");
    }

    const signer = await getWriteSigner(account, chain);
    const signerAddress = await signer.getAddress();
    const payloadHash = buildLaunchpadUiPayloadHash(nextValues);
    const timestamp = Date.now();
    const message = buildLaunchpadUiPublishMessage({
      contractAddress: CONTRACT_ADDRESS,
      chainId: chainIdForSignature,
      payloadHash,
      timestamp,
    });
    const signature = await signer.signMessage(message);

    const response = await fetch("/api/launchpad-ui", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        settings: nextValues,
        signer: signerAddress,
        payloadHash,
        timestamp,
        signature,
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; settings?: Partial<LaunchpadUiSettings> }
      | { ok: false; error?: string }
      | null;
    if (!response.ok || !payload?.ok) {
      const error =
        payload && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Failed to save launchpad settings on server.";
      throw new Error(error);
    }
    return toLaunchpadUiSettings(payload.settings, LAUNCHPAD_UI_DEFAULTS);
  };

  const loadLaunchpadUiForm = async () => {
    const local = loadLaunchpadUiSettings(launchpadUiStorageKey, LAUNCHPAD_UI_DEFAULTS);
    applyLaunchpadUiForm(local);

    try {
      const remote = await fetchLaunchpadUiFromServer();
      const remoteIsNewer = (remote.updatedAt || 0) >= (local.updatedAt || 0);
      if (remoteIsNewer) {
        applyLaunchpadUiForm(remote);
        saveLaunchpadUiSettings(launchpadUiStorageKey, remote);
      }
    } catch {
      // Keep local snapshot if server settings are unavailable.
    }
  };

  useEffect(() => {
    if (!mounted) return;
    void loadLaunchpadUiForm();
  }, [mounted, launchpadUiStorageKey]);

  const handleSaveLaunchpadUi = async () => {
    if (!ensureReady()) return;
    const nextValues = normalizeLaunchpadUiDefaults(launchpadUiForm, LAUNCHPAD_UI_DEFAULTS);
    setAppearanceSaveState("saving");
    try {
      const persisted = await publishLaunchpadUiToServer(nextValues);
      saveLaunchpadUiSettings(launchpadUiStorageKey, persisted);
      applyLaunchpadUiForm(persisted);
      setStatus({ type: "success", message: "Launchpad appearance saved for all devices." });
    } catch (error: any) {
      setAppearanceSaveState("unsaved");
      setStatus({ type: "error", message: error?.message || "Failed to save launchpad appearance." });
    }
  };

  const handleResetLaunchpadUi = async () => {
    if (!ensureReady()) return;
    setAppearanceSaveState("saving");
    try {
      const defaults = normalizeLaunchpadUiDefaults(LAUNCHPAD_UI_DEFAULTS, LAUNCHPAD_UI_DEFAULTS);
      const persisted = await publishLaunchpadUiToServer(defaults);
      saveLaunchpadUiSettings(launchpadUiStorageKey, persisted);
      applyLaunchpadUiForm(persisted);
      setStatus({ type: "success", message: "Launchpad appearance reset for all devices." });
    } catch (error: any) {
      setAppearanceSaveState("unsaved");
      setStatus({
        type: "error",
        message: error?.message || "Failed to reset launchpad appearance.",
      });
    }
  };

  const handleAllowlistCsvChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const parsed = parseWalletsFromCsv(content);
      if (parsed.valid.length === 0) {
        setStatus({
          type: "error",
          message: "No valid wallet address found in CSV file.",
        });
        return;
      }
      const wallets = normalizeWalletList(parsed.valid);
      const { root } = buildAllowlistMerkleData(wallets);
      setAllowlistWallets(wallets.join("\n"));
      setAllowlistSaved(wallets);
      setAllowlistRoot(root);
      setAllowlistDirty(false);
      setAllowlistProofDownloaded(false);
      const baseMessage = `CSV loaded: ${wallets.length} valid wallet${wallets.length > 1 ? "s" : ""}. Root generated.`;
      if (!parsed.invalid.length) {
        setStatus({ type: "success", message: baseMessage });
        return;
      }
      const sample = parsed.invalid.slice(0, 3).join(", ");
      const suffix = parsed.invalid.length > 3 ? ` (+${parsed.invalid.length - 3} more)` : "";
      setStatus({
        type: "success",
        message: `${baseMessage} Skipped ${parsed.invalid.length} invalid: ${sample}${suffix}`,
      });
    } catch {
      setStatus({
        type: "error",
        message: "Failed to read CSV file.",
      });
    } finally {
      event.target.value = "";
    }
  };

  const handleGenerateAllowlistRoot = () => {
    const parsed = parseWallets(allowlistWallets);
    const wallets = normalizeWalletList(parsed.valid);
    if (!wallets.length) {
      setStatus({ type: "error", message: "Add at least one valid wallet to generate merkle root." });
      return;
    }
    const { root } = buildAllowlistMerkleData(wallets);
    setAllowlistWallets(wallets.join("\n"));
    setAllowlistSaved(wallets);
    setAllowlistRoot(root);
    setAllowlistDirty(false);
    setAllowlistProofDownloaded(false);
    if (!parsed.invalid.length) {
      setStatus({
        type: "success",
        message: `Merkle root generated for ${wallets.length} wallet${wallets.length > 1 ? "s" : ""}.`,
      });
      return;
    }
    const sample = parsed.invalid.slice(0, 3).join(", ");
    const suffix = parsed.invalid.length > 3 ? ` (+${parsed.invalid.length - 3} more)` : "";
    setStatus({
      type: "success",
      message: `Root generated for ${wallets.length} wallet${wallets.length > 1 ? "s" : ""}. Skipped ${parsed.invalid.length} invalid: ${sample}${suffix}`,
    });
  };

  const handleDownloadAllowlistProof = () => {
    const parsed = parseWallets(allowlistWallets);
    const wallets = normalizeWalletList(parsed.valid);
    if (!wallets.length) {
      setStatus({ type: "error", message: "Upload or paste wallet addresses first." });
      return;
    }
    const merkle = buildAllowlistMerkleData(wallets);
    const payload = {
      phaseId: editingPhaseId,
      root: merkle.root,
      total: wallets.length,
      generatedAt: new Date().toISOString(),
      proofs: merkle.proofs,
    };
    const phaseLabel = editingPhaseId !== null ? String(editingPhaseId) : "new";
    downloadJsonFile(`phase-${phaseLabel}.json`, payload);
    if (!allowlistRoot.trim()) {
      setAllowlistRoot(merkle.root);
    }
    setAllowlistSaved(wallets);
    setAllowlistProofDownloaded(true);
    setStatus({
      type: "success",
      message: `Proof file downloaded for ${wallets.length} wallet${wallets.length > 1 ? "s" : ""}.`,
    });
  };

  const normalizedLaunchpadUiForm = useMemo<LaunchpadUiDefaults>(() => {
    return {
      collectionName: launchpadUiForm.collectionName.trim() || LAUNCHPAD_UI_DEFAULTS.collectionName,
      collectionDescription:
        launchpadUiForm.collectionDescription.trim() || LAUNCHPAD_UI_DEFAULTS.collectionDescription,
      collectionBannerUrl: launchpadUiForm.collectionBannerUrl.trim(),
      collectionWebsite: launchpadUiForm.collectionWebsite.trim(),
      collectionTwitter: launchpadUiForm.collectionTwitter.trim(),
    };
  }, [launchpadUiForm]);

  const contractAddressShort = CONTRACT_ADDRESS ? formatAddress(CONTRACT_ADDRESS) : "Not set";
  const ownerShort = owner ? formatAddress(owner) : "Loading...";
  const walletShort = address ? formatAddress(address) : "Not connected";
  const contractExplorerUrl =
    CONTRACT_ADDRESS && BLOCK_EXPLORER_URL
      ? `${BLOCK_EXPLORER_URL.replace(/\/$/, "")}/address/${CONTRACT_ADDRESS}`
      : "";

  const mintedNum = Number(totalSupply) || 0;
  const maxSupplyNum = Number(maxSupply) || 0;
  const supplyProgress = maxSupplyNum > 0 ? Math.min((mintedNum / maxSupplyNum) * 100, 100) : 0;

  const metadataStateLabel = metadataFrozen ? "Frozen" : revealed ? "Revealed" : "Hidden";

  const activePhase = useMemo(() => {
    const livePhase = phases.find((phase) => getPhaseStatus(phase) === "live");
    if (livePhase) return livePhase;
    if (activePhaseInfo) {
      const byId = phases.find((phase) => phase.id === activePhaseInfo.id);
      if (byId) return byId;
    }
    return phases.find((phase) => getPhaseStatus(phase) === "upcoming") || null;
  }, [phases, activePhaseInfo]);

  const activePhaseStatus = activePhase ? getPhaseStatus(activePhase) : "inactive";
  const activePhaseCountdown =
    activePhaseStatus === "live"
      ? `Ends in ${formatCountdown(activePhase?.endsAt || 0, clockMs)}`
      : activePhaseStatus === "upcoming"
      ? `Starts in ${formatCountdown(activePhase?.startsAt || 0, clockMs)}`
      : "No live phase";

  const statusTone = metadataFrozen || transfersLocked ? "critical" : paused ? "warning" : "active";
  const statusLabel =
    statusTone === "critical" ? "Frozen" : statusTone === "warning" ? "Paused" : "Active";

  const feePreview = (() => {
    const mint = Number(mintPrice || 0);
    const fee = Number(launchpadFeeInput || launchpadFee || 0);
    const total = mint + fee;
    return {
      mint: Number.isFinite(mint) ? mint : 0,
      fee: Number.isFinite(fee) ? fee : 0,
      total: Number.isFinite(total) ? total : 0,
    };
  })();
  const nextCutSupply = Number(maxSupplyInput || 0);
  const cutBelowMinted = Number.isFinite(nextCutSupply) && nextCutSupply > 0 && nextCutSupply < mintedNum;

  const orderedPhases = useMemo(() => {
    if (!phaseOrder.length) return phases;
    const byId = new Map(phases.map((phase) => [phase.id, phase]));
    const ordered = phaseOrder
      .map((phaseId) => byId.get(phaseId))
      .filter(Boolean) as Phase[];
    const leftovers = phases.filter((phase) => !phaseOrder.includes(phase.id));
    return [...ordered, ...leftovers];
  }, [phases, phaseOrder]);

  const baseUriState = baseURI.trim() ? (isLikelyValidUri(baseURI) ? "valid" : "invalid") : "empty";
  const revealUriState = notRevealedURI.trim()
    ? isLikelyValidUri(notRevealedURI)
      ? "valid"
      : "invalid"
    : "empty";
  const allowlistProofPathHint =
    editingPhaseId !== null
      ? `/public/allowlists/phase-${editingPhaseId}.json`
      : "/public/allowlists/phase-<new-id>.json";

  const previewBanner = normalizedLaunchpadUiForm.collectionBannerUrl || notRevealedURI;

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!status.message || status.type === "idle") return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, type: status.type, message: status.message }].slice(-4));
    const timeout = window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4200);
    return () => window.clearTimeout(timeout);
  }, [status.message, status.type]);

  useEffect(() => {
    setPhaseOrder((prev) => {
      const nextIds = phases.map((phase) => phase.id);
      if (!prev.length) return nextIds;
      const preserved = prev.filter((phaseId) => nextIds.includes(phaseId));
      const additions = nextIds.filter((phaseId) => !preserved.includes(phaseId));
      return [...preserved, ...additions];
    });
  }, [phases]);

  const handlePhaseDrop = (targetPhaseId: number) => {
    if (draggingPhaseId === null || draggingPhaseId === targetPhaseId) return;
    setPhaseOrder((prev) => {
      const next = prev.slice();
      const fromIndex = next.indexOf(draggingPhaseId);
      const toIndex = next.indexOf(targetPhaseId);
      if (fromIndex === -1 || toIndex === -1) return prev;
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setDraggingPhaseId(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    setConfirmBusy(true);
    try {
      await confirmAction.onConfirm();
      setConfirmAction(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const updateLaunchpadUiField = (field: keyof LaunchpadUiDefaults, value: string) => {
    setAppearanceSaveState("unsaved");
    setLaunchpadUiForm((prev) => ({ ...prev, [field]: value }));
  };

  if (!mounted) {
    return <div className="mint-ui-page bg-hero min-h-screen text-white" />;
  }

  return (
    <div className="mint-ui-page bg-hero min-h-screen text-white">
      <header className="mint-ui-nav">
        <div className="mint-ui-brand">
          <img src={DEFAULT_BRAND_LOGO_ASSET} alt={`${BRAND_NAME} logo`} className="mint-ui-brand-logo" />
          <span className="mint-ui-brand-subtext">Launchpad</span>
        </div>
        <nav className="mint-ui-nav-links">
          <Link href="/" className="mint-ui-nav-item">
            Mint
          </Link>
          <span className="mint-ui-nav-item active">Admin</span>
        </nav>
        <div className="mint-ui-nav-wallet">
          <WalletMenu onStatus={setStatus} />
        </div>
      </header>

      <div className="mint-ui-shell admin-ui-shell admin-dashboard-shell">
        <section className="admin-dashboard-topbar">
          <div className="admin-top-left">
            <div>
              <p className="admin-top-label">Collection</p>
              <h1 className="admin-top-title">{normalizedLaunchpadUiForm.collectionName}</h1>
            </div>
            <span className="admin-badge admin-badge-info">{NETWORK_NAME}</span>
            <button type="button" className="admin-chip-btn" onClick={handleCopyContract}>
              {contractAddressShort}
            </button>
          </div>
          <div className="admin-top-right">
            <div className="admin-top-chip">
              Owner <strong>{ownerShort}</strong>
            </div>
            <div className="admin-top-chip">
              Wallet <strong>{walletShort}</strong>
            </div>
            <div className="admin-top-chip">
              Balance <strong>{withdrawableBalance} {NATIVE_SYMBOL}</strong>
            </div>
            <div className={`admin-status-pill is-${statusTone}`}>
              <span className="admin-status-dot" />
              {statusLabel}
            </div>
          </div>
        </section>

        {!isSupportedChain && isConnected ? (
          <div className="admin-alert admin-alert-warn">Wrong network. Switch to {NETWORK_NAME}.</div>
        ) : null}
        {isSupportedChain && !isTargetChain && isConnected ? (
          <div className="admin-alert admin-alert-warn">
            Wrong network. Switch to {NETWORK_NAME} to manage this contract.
          </div>
        ) : null}
        {isConnected && !isOwner ? (
          <div className="admin-alert admin-alert-error">Connected wallet is not the contract owner.</div>
        ) : null}

        <div className="admin-tab-row">
          <button
            type="button"
            className={`admin-tab-btn ${activeTab === "dashboard" ? "is-active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <span className="admin-tab-btn-content">
              <AdminGlyph name="dashboard" />
              Dashboard
            </span>
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${activeTab === "metadata" ? "is-active" : ""}`}
            onClick={() => setActiveTab("metadata")}
          >
            <span className="admin-tab-btn-content">
              <AdminGlyph name="metadata" />
              Metadata
            </span>
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${activeTab === "mint_phases" ? "is-active" : ""}`}
            onClick={() => setActiveTab("mint_phases")}
          >
            <span className="admin-tab-btn-content">
              <AdminGlyph name="phases" />
              Mint Phases
            </span>
          </button>
          <button
            type="button"
            className={`admin-tab-btn ${activeTab === "settings" ? "is-active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            <span className="admin-tab-btn-content">
              <AdminGlyph name="settings" />
              Settings
            </span>
          </button>
        </div>

        {canManage ? (
          <>
            {activeTab === "dashboard" ? (
              <>
                <section className="admin-overview-grid">
                  <article className="admin-overview-card">
                    <p className="admin-overview-label">Mint Status</p>
                    <p className="admin-overview-value">{paused ? "Paused" : "Active"}</p>
                    <span className={`admin-badge ${paused ? "admin-badge-warn" : "admin-badge-success"}`}>
                      {paused ? "Warning" : "Healthy"}
                    </span>
                  </article>
                  <article className="admin-overview-card">
                    <p className="admin-overview-label">Metadata Status</p>
                    <p className="admin-overview-value">{metadataStateLabel}</p>
                    <span
                      className={`admin-badge ${
                        metadataFrozen
                          ? "admin-badge-danger"
                          : revealed
                          ? "admin-badge-info"
                          : "admin-badge-muted"
                      }`}
                    >
                      {metadataFrozen ? "Frozen" : revealed ? "Revealed" : "Hidden"}
                    </span>
                  </article>
                  <article className="admin-overview-card">
                    <p className="admin-overview-label">Current Supply</p>
                    <p className="admin-overview-value">
                      {isRefreshing ? (
                        <span className="admin-skeleton-value" />
                      ) : (
                        `${mintedNum} / ${maxSupplyNum || "-"}`
                      )}
                    </p>
                    <div className="admin-progress">
                      <span className="admin-progress-bar" style={{ width: `${supplyProgress}%` }} />
                    </div>
                  </article>
                  <article className="admin-overview-card">
                    <p className="admin-overview-label">Active Phase</p>
                    <p className="admin-overview-value">{activePhase ? activePhase.name : "No phase"}</p>
                    <p className="admin-overview-helper">
                      {activePhase
                        ? `${activePhase.priceEth} ${NATIVE_SYMBOL} • ${activePhaseCountdown}`
                        : "Create a phase"}
                    </p>
                  </article>
                </section>

                <main className="admin-work-grid admin-work-grid-dashboard">
                  <section className="admin-main-col">
                    <article className="admin-surface-card">
                      <div className="admin-card-head">
                        <div>
                          <h2 className="admin-title-with-icon">
                            <AdminGlyph name="operations" />
                            Mint Operations
                          </h2>
                          <p>Manage high-level collection state and visibility.</p>
                        </div>
                      </div>
                      <div className="admin-risk-grid admin-risk-grid-three">
                        <div className="admin-risk-card">
                          <div className="admin-risk-copy">
                            <p className="admin-subtitle-with-icon">
                              <AdminGlyph name="pause" />
                              Pause New Mints
                            </p>
                            <span>Temporarily stop all minting activity across active phases.</span>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={paused}
                            disabled={isBusy}
                            className={`toggle ${paused ? "toggle-on" : ""}`}
                            onClick={() =>
                              requestConfirm(
                                {
                                  title: paused ? "Resume minting?" : "Pause new mints?",
                                  description: paused
                                    ? "Minting will open immediately for all eligible wallets."
                                    : "Minting will be paused for all phases until resumed.",
                                  confirmLabel: paused ? "Resume" : "Pause",
                                  tone: "warning",
                                },
                                handlePauseToggle
                              )
                            }
                          >
                            <span className="toggle-label">{paused ? "ON" : "OFF"}</span>
                            <span className="toggle-thumb" />
                          </button>
                        </div>
                        <div className="admin-risk-card">
                          <div className="admin-risk-copy">
                            <p className="admin-subtitle-with-icon">
                              <AdminGlyph name="eye" />
                              Reveal Metadata
                            </p>
                            <span>Switch from pre-reveal image to final on-chain metadata.</span>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={revealed}
                            disabled={isBusy || metadataFrozen}
                            className={`toggle ${revealed ? "toggle-on" : ""}`}
                            onClick={() =>
                              requestConfirm(
                                {
                                  title: revealed ? "Hide metadata again?" : "Reveal metadata now?",
                                  description: revealed
                                    ? "Tokens will return to hidden preview mode."
                                    : "All minted tokens will display final metadata.",
                                  confirmLabel: revealed ? "Hide metadata" : "Reveal now",
                                },
                                handleToggleReveal
                              )
                            }
                          >
                            <span className="toggle-label">{revealed ? "ON" : "OFF"}</span>
                            <span className="toggle-thumb" />
                          </button>
                        </div>
                        <div className="admin-risk-card admin-risk-card-danger">
                          <div className="admin-risk-copy">
                            <p className="admin-subtitle-with-icon">
                              <AdminGlyph name="shield" />
                              Freeze Transfers
                            </p>
                            <span>Disables secondary trading. This is high-risk action.</span>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={transfersLocked}
                            disabled={isBusy}
                            className={`toggle ${transfersLocked ? "toggle-on" : ""}`}
                            onClick={() =>
                              requestConfirm(
                                {
                                  title: transfersLocked ? "Unfreeze transfers?" : "Freeze transfers?",
                                  description: transfersLocked
                                    ? "Secondary trading will be enabled again."
                                    : "Secondary transfers will be blocked for all holders.",
                                  warning: "Ensure this is aligned with your launch policy before confirming.",
                                  confirmLabel: transfersLocked ? "Unfreeze" : "Freeze transfers",
                                  tone: "danger",
                                },
                                handleToggleTransfers
                              )
                            }
                          >
                            <span className="toggle-label">{transfersLocked ? "ON" : "OFF"}</span>
                            <span className="toggle-thumb" />
                          </button>
                        </div>
                      </div>
                    </article>

                    <article className="admin-surface-card">
                      <div className="admin-card-head">
                        <div>
                          <h2 className="admin-title-with-icon">
                            <AdminGlyph name="supply" />
                            Supply Controls
                          </h2>
                          <p>Manage the total capacity of your collection.</p>
                        </div>
                        <span className="admin-badge admin-badge-danger">Irreversible</span>
                      </div>
                      <div className="admin-supply-panel">
                        <div className="admin-supply-progress-card">
                          <div className="admin-supply-progress-head">
                            <div className="admin-supply-progress-labels">
                              <span className="admin-supply-progress-title">Mint Progress</span>
                              <span className="admin-supply-progress-count">
                                {mintedNum} of {maxSupplyNum || "-"} minted
                              </span>
                            </div>
                            <span className="admin-supply-progress-percent">
                              {Math.round(supplyProgress)}%
                            </span>
                          </div>
                          <div className="admin-progress">
                            <span className="admin-progress-bar" style={{ width: `${supplyProgress}%` }} />
                          </div>
                        </div>

                        <label className="phase-field">
                          <span className="phase-label">New max supply</span>
                        </label>

                        <div className="admin-supply-input-row">
                          <input
                            className="phase-input"
                            type="number"
                            min="1"
                            value={maxSupplyInput}
                            onChange={(e) => setMaxSupplyInput(e.target.value)}
                          />
                          <button
                            type="button"
                            className="admin-btn admin-btn-danger"
                            onClick={() =>
                              requestConfirm(
                                {
                                  title: "Cut max supply?",
                                  description:
                                    "This will permanently reduce max supply and cannot be increased later.",
                                  warning:
                                    "Contract will reject values below minted supply. Review the number before confirming.",
                                  confirmLabel: "Cut supply",
                                  tone: "danger",
                                },
                                handleSetMaxSupply
                              )
                            }
                            disabled={isBusy}
                          >
                            Cut Supply
                          </button>
                        </div>

                        <p className={`admin-supply-note ${cutBelowMinted ? "is-error" : ""}`}>
                          <AdminGlyph name="warning" className="admin-supply-note-icon" />
                          Supply can only be reduced and cannot go below the current minted count ({mintedNum}).
                        </p>
                      </div>
                    </article>
                  </section>

                  <aside className="admin-side-col">
                    <article className="admin-surface-card admin-treasury-card">
                      <div className="admin-card-head">
                        <div>
                          <h2 className="admin-title-with-icon">
                            <AdminGlyph name="treasury" />
                            Treasury
                          </h2>
                          <p>Withdrawable balance and payout control.</p>
                        </div>
                        <span className="admin-badge admin-badge-muted">Treasury</span>
                      </div>
                      <p className="admin-treasury-balance">{withdrawableBalance} {NATIVE_SYMBOL}</p>
                      <p className="admin-overview-helper">
                        Last withdrawal: {lastWithdrawAt ? new Date(lastWithdrawAt).toLocaleString() : "No withdrawals yet"}
                      </p>
                      <button
                        type="button"
                        className="admin-btn admin-btn-primary admin-btn-full"
                        onClick={() =>
                          requestConfirm(
                            {
                              title: "Withdraw treasury balance?",
                              description: "Funds will be transferred to the owner wallet.",
                              warning: "Gas fee will be charged by your wallet for this transaction.",
                              confirmLabel: `Withdraw ${NATIVE_SYMBOL}`,
                            },
                            handleWithdraw
                          )
                        }
                        disabled={isBusy}
                      >
                        {isBusy ? (
                          <span className="admin-btn-inline">
                            <span className="admin-spinner" />
                            Processing...
                          </span>
                        ) : (
                          `Withdraw ${NATIVE_SYMBOL}`
                        )}
                      </button>
                    </article>

                    <article className="admin-surface-card">
                      <div className="admin-card-head">
                        <div>
                          <h2 className="admin-title-with-icon">
                            <AdminGlyph name="fee" />
                            Launchpad Fee
                          </h2>
                          <p>Configure fee amount and recipient.</p>
                        </div>
                      </div>
                      <div className="admin-fee-grid admin-fee-grid-compact">
                        <div className="admin-fee-col">
                          <label className="phase-field">
                            <span className="phase-label">Fee amount ({NATIVE_SYMBOL})</span>
                            <input
                              className="phase-input"
                              type="number"
                              step="0.0001"
                              value={launchpadFeeInput}
                              onChange={(e) => setLaunchpadFeeInput(e.target.value)}
                            />
                          </label>
                        </div>
                        <div className="admin-fee-col">
                          <label className="phase-field">
                            <span className="phase-label">Fee recipient</span>
                            <input
                              className="phase-input"
                              value={feeRecipientInput}
                              onChange={(e) => setFeeRecipientInput(e.target.value)}
                              placeholder="0x..."
                            />
                          </label>
                        </div>
                      </div>
                      <p className="admin-overview-helper">
                        If mint price = {feePreview.mint.toFixed(4)} {NATIVE_SYMBOL}, user pays {feePreview.total.toFixed(4)} {NATIVE_SYMBOL}.
                      </p>
                      <button
                        type="button"
                        className="admin-btn admin-btn-primary admin-btn-full"
                        onClick={handleUpdateLaunchpadFee}
                        disabled={isBusy}
                      >
                        Update Fee Config
                      </button>
                    </article>

                    <article className="admin-surface-card">
                      <div className="admin-card-head">
                        <div>
                          <h2 className="admin-title-with-icon">
                            <AdminGlyph name="activity" />
                            Activity Log
                          </h2>
                          <p>Recent transaction outcomes and receipts.</p>
                        </div>
                        <button
                          type="button"
                          className="admin-btn admin-btn-ghost admin-btn-tight"
                          onClick={() => setTxHistory([])}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="admin-tx-log">
                        {txHistory.length === 0 ? (
                          <p className="admin-overview-helper">No recent activity.</p>
                        ) : (
                          txHistory.map((entry) => (
                            <div key={entry.id} className={`admin-tx-item is-${entry.status}`}>
                              <div className="admin-tx-head">
                                <strong>{entry.label}</strong>
                                <span>{formatTimeAgo(entry.createdAt)}</span>
                              </div>
                              <p>{entry.message}</p>
                              {entry.hash ? <span className="admin-overview-helper">{formatAddress(entry.hash)}</span> : null}
                            </div>
                          ))
                        )}
                      </div>
                    </article>

                    <article className="admin-system-footer-card">
                      <div className="admin-card-head">
                        <div>
                          <h2 className="admin-title-with-icon">
                            <AdminGlyph name="health" />
                            System Health
                          </h2>
                          <p>Contract state at a glance.</p>
                        </div>
                      </div>
                      <div className="admin-status-grid">
                        <div className="admin-status-item">
                          <span>Paused</span>
                          <strong>{paused ? "YES" : "NO"}</strong>
                        </div>
                        <div className="admin-status-item">
                          <span>Revealed</span>
                          <strong>{revealed ? "YES" : "NO"}</strong>
                        </div>
                        <div className="admin-status-item">
                          <span>Metadata Frozen</span>
                          <strong>{metadataFrozen ? "YES" : "NO"}</strong>
                        </div>
                        <div className="admin-status-item">
                          <span>Transfers Frozen</span>
                          <strong>{transfersLocked ? "YES" : "NO"}</strong>
                        </div>
                      </div>
                      <div className="admin-system-links">
                        <button type="button" className="admin-btn admin-btn-ghost" onClick={handleCopyContract}>
                          Copy {contractAddressShort}
                        </button>
                        {contractExplorerUrl ? (
                          <a href={contractExplorerUrl} target="_blank" rel="noreferrer" className="admin-btn admin-btn-ghost">
                            Etherscan ↗
                          </a>
                        ) : null}
                      </div>
                    </article>
                  </aside>
                </main>
              </>
            ) : null}

            {activeTab === "metadata" ? (
              <main className="admin-work-grid admin-work-grid-single">
                <section className="admin-main-col">
                  <article className="admin-surface-card">
                    <div className="admin-card-head">
                      <div>
                        <h2 className="admin-title-with-icon">
                          <AdminGlyph name="metadata" />
                          Metadata Configuration
                        </h2>
                        <p>Set Base URI and reveal assets with validation and preview.</p>
                      </div>
                    </div>
                    <div className="admin-metadata-grid">
                      <div className="admin-metadata-form">
                        <div className="admin-metadata-field-block">
                          <label className="phase-field">
                            <span className="phase-label">Base URI (IPFS)</span>
                          </label>
                          <div className="admin-metadata-input-row">
                            <input
                              className="phase-input"
                              value={baseURI}
                              onChange={(e) => setBaseURI(e.target.value)}
                              placeholder="ipfs://CID/"
                            />
                            <button
                              type="button"
                              className="admin-btn admin-btn-primary"
                              onClick={handleSetBaseURI}
                              disabled={isBusy || metadataFrozen}
                            >
                              Update
                            </button>
                          </div>
                          <div className="admin-metadata-meta-row">
                            <span
                              className={`admin-badge ${
                                baseUriState === "valid"
                                  ? "admin-badge-success"
                                  : baseUriState === "invalid"
                                  ? "admin-badge-danger"
                                  : "admin-badge-muted"
                              }`}
                            >
                              {baseUriState === "valid" ? "Valid URI" : baseUriState === "invalid" ? "Invalid URI" : "Empty"}
                            </span>
                            <span className="admin-overview-helper">Last updated: {metadataUpdatedAt ? new Date(metadataUpdatedAt).toLocaleString() : "Not yet"}</span>
                          </div>
                        </div>

                        <div className="admin-metadata-field-block">
                          <label className="phase-field">
                            <span className="phase-label">Reveal Image URI (IPFS/PNG)</span>
                          </label>
                          <div className="admin-metadata-input-row">
                            <input
                              className="phase-input"
                              value={notRevealedURI}
                              onChange={(e) => setNotRevealedURI(e.target.value)}
                              placeholder="ipfs://CID/preview.png"
                            />
                            <button
                              type="button"
                              className="admin-btn admin-btn-primary"
                              onClick={handleSetNotRevealedURI}
                              disabled={isBusy || metadataFrozen}
                            >
                              Update
                            </button>
                          </div>
                          <div className="admin-metadata-meta-row">
                            <span
                              className={`admin-badge ${
                                revealUriState === "valid"
                                  ? "admin-badge-success"
                                  : revealUriState === "invalid"
                                  ? "admin-badge-danger"
                                  : "admin-badge-muted"
                              }`}
                            >
                              {revealUriState === "valid" ? "Valid URI" : revealUriState === "invalid" ? "Invalid URI" : "Empty"}
                            </span>
                            <span className="admin-overview-helper">Shown on mint page before reveal.</span>
                          </div>
                        </div>

                        <div className="admin-risk-card admin-risk-card-danger">
                          <div className="admin-risk-copy">
                            <p className="admin-subtitle-with-icon">
                              <AdminGlyph name="shield" />
                              Freeze Metadata
                            </p>
                            <span>Permanent action. Base URI and reveal URI cannot be changed after this.</span>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={metadataFrozen}
                            disabled={isBusy || metadataFrozen}
                            className={`toggle ${metadataFrozen ? "toggle-on" : ""}`}
                            onClick={() =>
                              requestConfirm(
                                {
                                  title: "Freeze metadata permanently?",
                                  description:
                                    "This action cannot be undone after metadata is frozen.",
                                  warning:
                                    "After confirmation, metadata edits and reveal switching are blocked forever.",
                                  confirmLabel: "Freeze metadata",
                                  tone: "danger",
                                },
                                handleFreezeMetadata
                              )
                            }
                          >
                            <span className="toggle-label">{metadataFrozen ? "LOCKED" : "OFF"}</span>
                            <span className="toggle-thumb" />
                          </button>
                        </div>
                        {metadataFrozen ? (
                          <p className="admin-inline-error">This action cannot be undone after metadata is frozen.</p>
                        ) : null}
                      </div>

                      <aside className="admin-metadata-preview">
                        <p className="admin-overview-label">Asset preview</p>
                        <div className="admin-preview-media">
                          {notRevealedURI ? <img src={notRevealedURI} alt="Reveal preview" /> : <span>No preview</span>}
                        </div>
                        <div className="admin-preview-meta">
                          <p>
                            <strong>Status:</strong> {metadataStateLabel}
                          </p>
                          <p>
                            <strong>Last update:</strong>{" "}
                            {metadataUpdatedAt ? new Date(metadataUpdatedAt).toLocaleString() : "Not yet"}
                          </p>
                          <p>
                            <strong>Tx hash:</strong> {lastMetadataTxHash ? formatAddress(lastMetadataTxHash) : "No transaction yet"}
                          </p>
                        </div>
                        <div className="admin-metadata-mock">
                          <div className="admin-inline-row">
                            <p className="admin-overview-label">Metadata mock</p>
                            <span className="admin-badge admin-badge-info">JSON</span>
                          </div>
                          <pre className="admin-metadata-json">
                            {JSON.stringify(
                              {
                                name: `${normalizedLaunchpadUiForm.collectionName} #1`,
                                description: normalizedLaunchpadUiForm.collectionDescription,
                                image:
                                  baseURI.trim().length > 0
                                    ? `${baseURI.trim()}1`
                                    : notRevealedURI || "ipfs://CID/1.png",
                                attributes: [
                                  { trait_type: "Origin", value: "Void" },
                                  { trait_type: "Power", value: "999" },
                                ],
                              },
                              null,
                              2
                            )}
                          </pre>
                        </div>
                      </aside>
                    </div>
                  </article>
                </section>
              </main>
            ) : null}

            {activeTab === "mint_phases" ? (
              <main className="admin-work-grid admin-work-grid-single">
                <section className="admin-main-col">
                  <article className="admin-surface-card">
                    <div className="admin-card-head">
                      <div>
                        <h2 className="admin-title-with-icon">
                          <AdminGlyph name="phases" />
                          Mint Phases
                        </h2>
                        <p>Schedule and configure different minting stages.</p>
                      </div>
                      <button
                        type="button"
                        className="admin-btn admin-btn-primary"
                        onClick={() => {
                          resetPhaseForm();
                          setPhaseEditorOpen(true);
                        }}
                      >
                        + Add New Phase
                      </button>
                    </div>
                    <div className="admin-phase-timeline">
                      {isPhasesLoading ? (
                        <div className="admin-skeleton-line" />
                      ) : orderedPhases.length === 0 ? (
                        <p className="admin-overview-helper">No phases yet. Add your first phase.</p>
                      ) : (
                        orderedPhases.map((phase, index) => {
                          const phaseStatus = getPhaseStatus(phase);
                          const phaseCountdown =
                            phaseStatus === "live"
                              ? `Ends in ${formatCountdown(phase.endsAt || 0, clockMs)}`
                              : phaseStatus === "upcoming"
                              ? `Starts in ${formatCountdown(phase.startsAt || 0, clockMs)}`
                              : "Ended";
                          return (
                            <details
                              key={phase.id}
                              className={`admin-phase-item is-${phaseStatus}`}
                              draggable
                              onDragStart={() => setDraggingPhaseId(phase.id)}
                              onDragOver={(event) => event.preventDefault()}
                              onDragEnd={() => setDraggingPhaseId(null)}
                              onDrop={() => handlePhaseDrop(phase.id)}
                            >
                              <summary>
                                <div className="admin-phase-left">
                                  <span className="admin-phase-index">{index + 1}</span>
                                  <div>
                                    <p className="admin-phase-title">{phase.name}</p>
                                    <p className="admin-overview-helper">{formatPhaseWindow(phase)}</p>
                                  </div>
                                </div>
                                <div className="admin-phase-right">
                                  <span className={`admin-badge ${phaseStatus === "live" ? "admin-badge-success" : phaseStatus === "upcoming" ? "admin-badge-info" : "admin-badge-muted"}`}>
                                    {phaseStatus}
                                  </span>
                                  <span className="admin-overview-helper">{phaseCountdown}</span>
                                </div>
                              </summary>
                              <div className="admin-phase-body">
                                <div className="phase-meta-row">
                                  <span className="phase-meta-item">Price {phase.priceEth} {NATIVE_SYMBOL}</span>
                                  <span className="phase-meta-item">Limit {phase.limitPerWallet} / wallet</span>
                                  <span className="phase-meta-item">{phase.allowlistEnabled ? "Allowlist" : "Public"}</span>
                                </div>
                                <div className="admin-phase-actions">
                                  <button type="button" className="admin-btn admin-btn-ghost" onClick={() => handleEditPhase(phase)}>
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="admin-btn admin-btn-danger"
                                    onClick={() =>
                                      requestConfirm(
                                        {
                                          title: "Delete phase?",
                                          description: `Phase "${phase.name}" will be removed from contract schedule.`,
                                          confirmLabel: "Delete phase",
                                          tone: "danger",
                                        },
                                        async () => handleDeletePhase(phase.id)
                                      )
                                    }
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </details>
                          );
                        })
                      )}
                    </div>
                  </article>

                </section>
              </main>
            ) : null}

            {activeTab === "settings" ? (
              <main className="admin-work-grid admin-work-grid-settings">
                <section className="admin-main-col">
                  <article className="admin-surface-card">
                    <div className="admin-card-head">
                      <div>
                        <h2 className="admin-title-with-icon">
                          <AdminGlyph name="settings" />
                          Mint Page Settings
                        </h2>
                        <p>Customize how your collection appears to minters.</p>
                      </div>
                      <div className="admin-save-indicator">
                        <span
                          className={`admin-badge ${
                            appearanceSaveState === "saved"
                              ? "admin-badge-success"
                              : appearanceSaveState === "saving"
                              ? "admin-badge-info"
                              : "admin-badge-warn"
                          }`}
                        >
                          {appearanceSaveState === "saved"
                            ? "Saved"
                            : appearanceSaveState === "saving"
                            ? "Saving..."
                            : "Unsaved changes"}
                        </span>
                        <span className="admin-overview-helper">
                          {launchpadUiSavedAt ? `Updated ${formatTimeAgo(launchpadUiSavedAt)}` : "Not saved yet"}
                        </span>
                      </div>
                    </div>
                    <div className="admin-settings-grid">
                      <label className="phase-field">
                        <span className="phase-label">Collection Name</span>
                        <input
                          className="phase-input"
                          value={launchpadUiForm.collectionName}
                          onChange={(e) => updateLaunchpadUiField("collectionName", e.target.value)}
                        />
                      </label>
                      <label className="phase-field">
                        <span className="phase-label">Banner URL</span>
                        <input
                          className="phase-input"
                          value={launchpadUiForm.collectionBannerUrl}
                          onChange={(e) => updateLaunchpadUiField("collectionBannerUrl", e.target.value)}
                          placeholder="ipfs://CID/banner.png"
                        />
                      </label>
                      <label className="phase-field">
                        <span className="phase-label">Website</span>
                        <input
                          className="phase-input"
                          value={launchpadUiForm.collectionWebsite}
                          onChange={(e) => updateLaunchpadUiField("collectionWebsite", e.target.value)}
                          placeholder="https://yourproject.xyz"
                        />
                      </label>
                      <label className="phase-field">
                        <span className="phase-label">Twitter / X</span>
                        <input
                          className="phase-input"
                          value={launchpadUiForm.collectionTwitter}
                          onChange={(e) => updateLaunchpadUiField("collectionTwitter", e.target.value)}
                          placeholder="https://x.com/yourproject"
                        />
                      </label>
                      <label className="phase-field phase-field-full">
                        <span className="phase-label">Description</span>
                        <textarea
                          className="phase-input"
                          rows={5}
                          value={launchpadUiForm.collectionDescription}
                          onChange={(e) => updateLaunchpadUiField("collectionDescription", e.target.value)}
                        />
                      </label>
                    </div>
                    <div className="admin-phase-actions">
                      <button
                        type="button"
                        className="admin-btn admin-btn-primary"
                        onClick={() => void handleSaveLaunchpadUi()}
                        disabled={appearanceSaveState === "saving"}
                      >
                        Save Appearance
                      </button>
                      <button
                        type="button"
                        className="admin-btn admin-btn-ghost"
                        onClick={() => void handleResetLaunchpadUi()}
                        disabled={appearanceSaveState === "saving"}
                      >
                        Reset Default
                      </button>
                    </div>
                  </article>
                </section>
                <aside className="admin-side-col">
                  <article className="admin-surface-card">
                    <div className="admin-card-head">
                      <div>
                        <h2 className="admin-title-with-icon">
                          <AdminGlyph name="preview" />
                          Live Preview
                        </h2>
                        <p>Preview of your mint page card.</p>
                      </div>
                    </div>
                    <div className="admin-preview-card">
                      <div className="admin-preview-banner">
                        {previewBanner ? <img src={previewBanner} alt="Banner preview" /> : <span>No banner set</span>}
                      </div>
                      <h3>{normalizedLaunchpadUiForm.collectionName}</h3>
                      <p>{normalizedLaunchpadUiForm.collectionDescription}</p>
                      <div className="admin-preview-links">
                        <span>{normalizedLaunchpadUiForm.collectionWebsite || "Website not set"}</span>
                        <span>{normalizedLaunchpadUiForm.collectionTwitter || "Twitter not set"}</span>
                      </div>
                    </div>
                  </article>
                </aside>
              </main>
            ) : null}
          </>
        ) : (
          <section className="admin-surface-card">
            <div className="admin-card-head">
              <div>
                <h2>Admin Access Required</h2>
                <p>Connect the owner wallet on {NETWORK_NAME} to manage contract settings.</p>
              </div>
            </div>
            {status.message ? (
              <div
                className={`admin-alert ${
                  status.type === "success"
                    ? "admin-alert-success"
                    : status.type === "error"
                    ? "admin-alert-error"
                    : "admin-alert-idle"
                }`}
              >
                {status.message}
              </div>
            ) : null}
          </section>
        )}
      </div>

      {phaseEditorOpen ? (
        <div className="admin-overlay">
          <div className="admin-slideover">
            <div className="admin-slideover-header">
              <div className="admin-slideover-title-wrap">
                <h2 className="admin-slideover-title admin-slideover-title-main">
                  <AdminGlyph name="phases" className="admin-slideover-title-icon" />
                  <span>{editingPhaseId !== null ? "Edit Phase" : "Add Phase"}</span>
                </h2>
                <p className="admin-slideover-subtitle">Configure schedule, pricing, and per-wallet limits.</p>
              </div>
              <button type="button" className="admin-btn admin-btn-ghost" onClick={() => setPhaseEditorOpen(false)}>
                Close
              </button>
            </div>

            <section className="admin-slideover-panel">
              <div className="admin-slideover-panel-head">
                <h3>Basic Settings</h3>
                <p>Configure phase name, pricing, wallet limit, and schedule.</p>
              </div>
              <div className="phase-grid admin-slideover-grid">
                <label className="phase-field">
                  <span className="phase-label">Phase name</span>
                  <input
                    className="phase-input"
                    value={phaseForm.name}
                    onChange={(e) => setPhaseForm((prev) => ({ ...prev, name: e.target.value }))}
                  />
                </label>
                <label className="phase-field">
                  <span className="phase-label">Price {NATIVE_SYMBOL}</span>
                  <input
                    className="phase-input"
                    type="number"
                    step="0.0001"
                    value={phaseForm.priceEth}
                    onChange={(e) => setPhaseForm((prev) => ({ ...prev, priceEth: e.target.value }))}
                  />
                </label>
                <label className="phase-field phase-field-full">
                  <span className="phase-label">Limit per wallet</span>
                  <input
                    className="phase-input"
                    type="number"
                    value={phaseForm.limitPerWallet}
                    onChange={(e) => setPhaseForm((prev) => ({ ...prev, limitPerWallet: e.target.value }))}
                  />
                </label>
              </div>

              <div className="admin-slideover-panel-head admin-slideover-panel-head-sub">
                <h4>
                  Schedule{" "}
                  <span className="admin-badge admin-badge-muted">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
                </h4>
              </div>
              <div className="phase-grid admin-slideover-grid">
                <label className="phase-field">
                  <span className="phase-label">Start</span>
                  <input
                    className="phase-input"
                    type="datetime-local"
                    value={phaseForm.startsAt}
                    onChange={(e) => setPhaseForm((prev) => ({ ...prev, startsAt: e.target.value }))}
                  />
                </label>
                <label className="phase-field">
                  <span className="phase-label">End</span>
                  <input
                    className="phase-input"
                    type="datetime-local"
                    value={phaseForm.endsAt}
                    onChange={(e) => setPhaseForm((prev) => ({ ...prev, endsAt: e.target.value }))}
                  />
                </label>
              </div>
            </section>

            <section className="admin-slideover-panel">
              <div className="admin-slideover-panel-head">
                <h3>Eligibility</h3>
                <p>Configure whitelist mode and Merkle proof data for this phase.</p>
              </div>
              <div className="admin-risk-card">
                <div className="admin-risk-copy">
                  <p className="admin-subtitle-with-icon">
                    <AdminGlyph name="allowlist" />
                    Allowlist Mode
                  </p>
                  <span>Configure whitelist via Merkle root for this phase.</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={allowlistEnabled}
                  className={`toggle ${allowlistEnabled ? "toggle-on" : ""}`}
                  disabled={isBusy}
                  onClick={() =>
                    setAllowlistEnabled((prev) => {
                      const next = !prev;
                      if (!next) {
                        setAllowlistProofDownloaded(false);
                      }
                      return next;
                    })
                  }
                >
                  <span className="toggle-label">{allowlistEnabled ? "ON" : "OFF"}</span>
                  <span className="toggle-thumb" />
                </button>
              </div>
              {allowlistEnabled ? (
                <div className="admin-metadata-form">
                  <label className="phase-field">
                    <span className="phase-label">Merkle Root</span>
                    <input
                      className="phase-input"
                      value={allowlistRoot}
                      onChange={(event) => {
                        setAllowlistRoot(event.target.value);
                        setAllowlistProofDownloaded(false);
                      }}
                      placeholder="0x... (32-byte hash)"
                    />
                  </label>
                  <label className="phase-field">
                    <span className="phase-label">Whitelist Wallets</span>
                    <textarea
                      className="phase-input"
                      rows={5}
                      value={allowlistWallets}
                      onChange={(event) => {
                        setAllowlistWallets(event.target.value);
                        setAllowlistDirty(true);
                        setAllowlistProofDownloaded(false);
                      }}
                      placeholder="0xabc...\n0xdef..."
                    />
                  </label>
                  <div className="admin-inline-row admin-eligibility-actions">
                    <input
                      ref={allowlistCsvInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="admin-hidden-input"
                      onChange={handleAllowlistCsvChange}
                    />
                    <button
                      type="button"
                      className="admin-btn admin-btn-ghost admin-eligibility-action-btn"
                      onClick={() => allowlistCsvInputRef.current?.click()}
                    >
                      <AdminGlyph name="upload" />
                      <span>Upload CSV</span>
                    </button>
                    <button
                      type="button"
                      className="admin-btn admin-btn-ghost admin-eligibility-action-btn"
                      onClick={handleGenerateAllowlistRoot}
                    >
                      <AdminGlyph name="merkle" />
                      <span>Generate Root</span>
                    </button>
                    <button
                      type="button"
                      className="admin-btn admin-btn-ghost admin-eligibility-action-btn"
                      onClick={handleDownloadAllowlistProof}
                    >
                      <AdminGlyph name="download" />
                      <span>Download Proof JSON</span>
                    </button>
                  </div>
                  <div className="admin-inline-row admin-eligibility-meta">
                    <span className="admin-eligibility-note admin-eligibility-note-muted">
                      {allowlistSaved.length} wallet{allowlistSaved.length === 1 ? "" : "s"} prepared.
                    </span>
                    <span
                      className={`admin-badge ${allowlistProofDownloaded ? "admin-badge-success" : "admin-badge-warn"}`}
                    >
                      {allowlistProofDownloaded ? "Proof downloaded" : "Proof not downloaded"}
                    </span>
                  </div>
                  <div className="admin-inline-row">
                    <p className="admin-eligibility-note">
                      Save phase to apply root on-chain, then place proof file at{" "}
                      <code className="admin-eligibility-path">{allowlistProofPathHint}</code>.
                    </p>
                  </div>
                  {allowlistDirty ? (
                    <p className="admin-inline-error admin-eligibility-note">
                      Whitelist changed. Regenerate root before saving.
                    </p>
                  ) : null}
                  {!allowlistProofDownloaded ? (
                    <p className="admin-warning-copy admin-eligibility-note">
                      Proof file will be auto-published on save. Use download as backup.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </section>

            <div className="admin-slideover-actions">
              <button
                type="button"
                className="admin-btn admin-btn-primary"
                onClick={() => {
                  void handleSavePhase();
                }}
                disabled={isBusy}
              >
                {editingPhaseId !== null ? "Update Phase" : "Add Phase"}
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-ghost"
                onClick={() => {
                  resetPhaseForm();
                  setPhaseEditorOpen(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmAction ? (
        <div className="admin-overlay">
          <div className="admin-confirm-modal">
            <h3>{confirmAction.title}</h3>
            <p>{confirmAction.description}</p>
            {confirmAction.warning ? <p className="admin-warning-copy">{confirmAction.warning}</p> : null}
            <div className="admin-confirm-actions">
              <button type="button" className="admin-btn admin-btn-ghost" onClick={() => setConfirmAction(null)} disabled={confirmBusy}>
                Cancel
              </button>
              <button
                type="button"
                className={`admin-btn ${
                  confirmAction.tone === "danger"
                    ? "admin-btn-danger"
                    : confirmAction.tone === "warning"
                    ? "admin-btn-warn"
                    : "admin-btn-primary"
                }`}
                onClick={handleConfirmAction}
                disabled={confirmBusy}
              >
                {confirmBusy ? "Processing..." : confirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="admin-toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`admin-toast is-${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
