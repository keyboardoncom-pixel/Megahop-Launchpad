import type { NextApiRequest, NextApiResponse } from "next";
import { ethers } from "ethers";
import {
  LaunchpadUiDefaults,
  LaunchpadUiSettings,
  buildDefaultLaunchpadUiSettings,
  buildLaunchpadUiPayloadHash,
  buildLaunchpadUiPublishMessage,
  normalizeLaunchpadUiDefaults,
  toLaunchpadUiSettings,
} from "../../lib/launchpadUi";

type LaunchpadUiApiResponse =
  | { ok: true; settings: LaunchpadUiSettings; source: "kv" | "defaults" }
  | { ok: false; error: string };

type KvLikeBinding = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || "";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0);
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const RPC_FALLBACK_URLS = (process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const DEFAULT_UI_VALUES: LaunchpadUiDefaults = {
  collectionName: process.env.NEXT_PUBLIC_COLLECTION_NAME || "Megahop",
  collectionDescription:
    process.env.NEXT_PUBLIC_COLLECTION_DESCRIPTION ||
    "The Megahop NFT collection on MegaETH with phased minting, allowlist control, admin tooling, and launchpad fee support.",
  collectionBannerUrl: process.env.NEXT_PUBLIC_COLLECTION_BANNER_URL || "",
  collectionWebsite: process.env.NEXT_PUBLIC_COLLECTION_WEBSITE || "",
  collectionTwitter: process.env.NEXT_PUBLIC_COLLECTION_TWITTER || "",
};

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);

const isBytes32 = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);

const isLikelySignature = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{130,132}$/.test(value);

const getStorageKey = () => `launchpad-ui:${CONTRACT_ADDRESS.toLowerCase()}:${CHAIN_ID}`;

const kvConfigured = () => KV_REST_API_URL.length > 0 && KV_REST_API_TOKEN.length > 0;

const getCloudflareKvBinding = async (): Promise<KvLikeBinding | null> => {
  const contextFromGlobal = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("__cloudflare-context__")] as
    | { env?: Record<string, unknown> }
    | undefined;
  const globalBinding = contextFromGlobal?.env?.LAUNCHPAD_UI_KV as KvLikeBinding | undefined;
  if (globalBinding && typeof globalBinding.get === "function" && typeof globalBinding.put === "function") {
    return globalBinding;
  }

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = await getCloudflareContext({ async: true });
    const binding = (context?.env as Record<string, unknown> | undefined)?.LAUNCHPAD_UI_KV as
      | KvLikeBinding
      | undefined;
    if (binding && typeof binding.get === "function" && typeof binding.put === "function") {
      return binding;
    }
  } catch {
    // Ignore and fall back to REST/local behavior.
  }
  return null;
};

const normalizeStoredSettings = (raw: unknown): LaunchpadUiSettings => {
  const parsed =
    raw && typeof raw === "object" ? (raw as Partial<LaunchpadUiSettings>) : ({} as Partial<LaunchpadUiSettings>);
  return toLaunchpadUiSettings(parsed, DEFAULT_UI_VALUES);
};

const callKv = async (command: (string | number)[]) => {
  const response = await fetch(KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`KV request failed (${response.status}): ${body || "unknown error"}`);
  }

  const payload = (await response.json()) as { result?: unknown; error?: string };
  if (typeof payload?.error === "string" && payload.error) {
    throw new Error(payload.error);
  }
  return payload?.result;
};

const loadFromKv = async (): Promise<LaunchpadUiSettings | null> => {
  const cfKv = await getCloudflareKvBinding();
  if (cfKv) {
    const raw = await cfKv.get(getStorageKey());
    if (typeof raw === "string" && raw.trim()) {
      try {
        return normalizeStoredSettings(JSON.parse(raw));
      } catch {
        return null;
      }
    }
  }

  if (kvConfigured()) {
    const raw = await callKv(["GET", getStorageKey()]);
    if (typeof raw !== "string" || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      return normalizeStoredSettings(parsed);
    } catch {
      return null;
    }
  }

  return null;
};

const saveToKv = async (settings: LaunchpadUiSettings) => {
  const cfKv = await getCloudflareKvBinding();
  if (cfKv) {
    await cfKv.put(getStorageKey(), JSON.stringify(settings));
    return;
  }

  if (!kvConfigured()) {
    throw new Error("Server storage is not configured. Add Cloudflare KV binding or KV_REST_API_*.");
  }

  await callKv(["SET", getStorageKey(), JSON.stringify(settings)]);
};

const getOwnerFromChain = async () => {
  const rpcCandidates = [RPC_URL, ...RPC_FALLBACK_URLS].filter(Boolean);
  if (!isAddress(CONTRACT_ADDRESS) || !rpcCandidates.length) {
    throw new Error("Server RPC/contract is not configured.");
  }
  const provider = new ethers.providers.StaticJsonRpcProvider(rpcCandidates[0]);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ["function owner() view returns (address)"], provider);
  const owner = await contract.owner();
  return ethers.utils.getAddress(owner);
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LaunchpadUiApiResponse>
) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "GET") {
    try {
      const stored = await loadFromKv();
      if (stored) {
        return res.status(200).json({ ok: true, settings: stored, source: "kv" });
      }
    } catch {
      // Fall through to defaults to keep mint page operational.
    }
    return res
      .status(200)
      .json({ ok: true, settings: buildDefaultLaunchpadUiSettings(DEFAULT_UI_VALUES), source: "defaults" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAddress(CONTRACT_ADDRESS)) {
    return res.status(500).json({ ok: false, error: "Server contract address is not configured." });
  }
  if (!Number.isInteger(CHAIN_ID) || CHAIN_ID <= 0) {
    return res.status(500).json({ ok: false, error: "Server chain id is not configured." });
  }
  if (!kvConfigured()) {
    return res.status(503).json({ ok: false, error: "Server storage is not configured (KV_REST_API_*)." });
  }

  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return res.status(415).json({ ok: false, error: "Content-Type must be application/json." });
  }

  const signer = req.body?.signer;
  const payloadHash = req.body?.payloadHash;
  const timestamp = Number(req.body?.timestamp);
  const signature = req.body?.signature;
  const settingsPayload = req.body?.settings;

  if (!isAddress(signer)) {
    return res.status(401).json({ ok: false, error: "Missing signer." });
  }
  if (!isBytes32(payloadHash)) {
    return res.status(401).json({ ok: false, error: "Missing payload hash." });
  }
  if (!Number.isFinite(timestamp)) {
    return res.status(401).json({ ok: false, error: "Missing timestamp." });
  }
  if (!isLikelySignature(signature)) {
    return res.status(401).json({ ok: false, error: "Missing signature." });
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return res.status(401).json({ ok: false, error: "Expired signature." });
  }

  const normalizedDefaults = normalizeLaunchpadUiDefaults(settingsPayload, DEFAULT_UI_VALUES);
  const computedPayloadHash = buildLaunchpadUiPayloadHash(normalizedDefaults);
  if (computedPayloadHash.toLowerCase() !== String(payloadHash).toLowerCase()) {
    return res.status(401).json({ ok: false, error: "Payload hash mismatch." });
  }

  const message = buildLaunchpadUiPublishMessage({
    contractAddress: CONTRACT_ADDRESS,
    chainId: CHAIN_ID,
    payloadHash: computedPayloadHash,
    timestamp,
  });

  let recovered: string;
  try {
    recovered = ethers.utils.getAddress(ethers.utils.verifyMessage(message, signature));
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid signature." });
  }

  if (recovered !== ethers.utils.getAddress(signer)) {
    return res.status(403).json({ ok: false, error: "Signature signer mismatch." });
  }

  let ownerAddress = "";
  try {
    ownerAddress = await getOwnerFromChain();
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "Failed to resolve contract owner." });
  }

  if (recovered !== ownerAddress) {
    return res.status(403).json({ ok: false, error: "Only contract owner can update launchpad settings." });
  }

  const settingsToStore: LaunchpadUiSettings = {
    ...normalizedDefaults,
    updatedAt: now,
  };

  try {
    await saveToKv(settingsToStore);
    return res.status(200).json({ ok: true, settings: settingsToStore, source: "kv" });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "Failed to save settings." });
  }
}
