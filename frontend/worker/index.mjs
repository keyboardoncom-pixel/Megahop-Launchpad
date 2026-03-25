import { ethers } from "ethers";
import openNextWorker from "../.open-next/worker.js";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_LENGTHS = {
  collectionName: 120,
  collectionDescription: 2400,
  collectionBannerUrl: 2048,
  collectionWebsite: 512,
  collectionTwitter: 512,
};

const sanitizeString = (value) => (typeof value === "string" ? value.trim() : "");
const clampText = (value, maxLen) => sanitizeString(value).slice(0, maxLen);

const normalizeDefaults = (raw, fallback) => ({
  collectionName:
    clampText(raw?.collectionName, MAX_LENGTHS.collectionName) ||
    clampText(fallback.collectionName, MAX_LENGTHS.collectionName),
  collectionDescription:
    clampText(raw?.collectionDescription, MAX_LENGTHS.collectionDescription) ||
    clampText(fallback.collectionDescription, MAX_LENGTHS.collectionDescription),
  collectionBannerUrl: clampText(raw?.collectionBannerUrl, MAX_LENGTHS.collectionBannerUrl),
  collectionWebsite: clampText(raw?.collectionWebsite, MAX_LENGTHS.collectionWebsite),
  collectionTwitter: clampText(raw?.collectionTwitter, MAX_LENGTHS.collectionTwitter),
});

const toSettings = (raw, fallback) => {
  const normalized = normalizeDefaults(raw, fallback);
  const updatedAt = Number(raw?.updatedAt);
  return {
    ...normalized,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.floor(updatedAt) : 0,
  };
};

const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const buildPayloadHash = (settings) =>
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes(stableStringify(settings)));

const buildPublishMessage = ({ contractAddress, chainId, payloadHash, timestamp }) =>
  [
    "Megahop Launchpad UI Publish",
    `contract:${sanitizeString(contractAddress).toLowerCase()}`,
    `chainId:${chainId}`,
    `payloadHash:${sanitizeString(payloadHash).toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join("\n");

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      ...(init.headers || {}),
    },
  });

const isAddress = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
const isBytes32 = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
const isLikelySignature = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{130,132}$/.test(value);

const getStorageKey = (contractAddress, chainId) =>
  `launchpad-ui:${contractAddress.toLowerCase()}:${chainId}`;

const buildFallbackDefaults = (env) => ({
  collectionName: env.NEXT_PUBLIC_COLLECTION_NAME || "Megahop",
  collectionDescription:
    env.NEXT_PUBLIC_COLLECTION_DESCRIPTION ||
    "The Megahop NFT collection on MegaETH with phased minting, allowlist control, admin tooling, and launchpad fee support.",
  collectionBannerUrl: env.NEXT_PUBLIC_COLLECTION_BANNER_URL || "",
  collectionWebsite: env.NEXT_PUBLIC_COLLECTION_WEBSITE || "",
  collectionTwitter: env.NEXT_PUBLIC_COLLECTION_TWITTER || "",
});

const getOwnerFromChain = async (env, contractAddress) => {
  const rpcCandidates = [env.NEXT_PUBLIC_RPC_URL, env.NEXT_PUBLIC_RPC_FALLBACK_URLS]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (!rpcCandidates.length) {
    throw new Error("Server RPC is not configured.");
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(rpcCandidates[0]);
  const contract = new ethers.Contract(contractAddress, ["function owner() view returns (address)"], provider);
  return ethers.utils.getAddress(await contract.owner());
};

const handleLaunchpadUi = async (request, env) => {
  const contractAddress = env.NEXT_PUBLIC_CONTRACT_ADDRESS || "";
  const chainId = Number(env.NEXT_PUBLIC_CHAIN_ID || 0);
  const fallbackDefaults = buildFallbackDefaults(env);
  const kv = env.LAUNCHPAD_UI_KV;

  if (!isAddress(contractAddress) || !Number.isInteger(chainId) || chainId <= 0) {
    return json({ ok: false, error: "Server launchpad config is incomplete." }, { status: 500 });
  }

  const storageKey = getStorageKey(contractAddress, chainId);

  if (request.method === "GET") {
    if (kv && typeof kv.get === "function") {
      const raw = await kv.get(storageKey);
      if (typeof raw === "string" && raw.trim()) {
        try {
          return json({ ok: true, settings: toSettings(JSON.parse(raw), fallbackDefaults), source: "kv" });
        } catch {
          // fall through to defaults
        }
      }
    }
    return json({ ok: true, settings: { ...fallbackDefaults, updatedAt: 0 }, source: "defaults" });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: { Allow: "GET, POST" } });
  }

  if (!kv || typeof kv.put !== "function") {
    return json({ ok: false, error: "Server storage is not configured." }, { status: 503 });
  }

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json({ ok: false, error: "Content-Type must be application/json." }, { status: 415 });
  }

  const body = await request.json().catch(() => null);
  const signer = body?.signer;
  const payloadHash = body?.payloadHash;
  const timestamp = Number(body?.timestamp);
  const signature = body?.signature;

  if (!isAddress(signer)) {
    return json({ ok: false, error: "Missing signer." }, { status: 401 });
  }
  if (!isBytes32(payloadHash)) {
    return json({ ok: false, error: "Missing payload hash." }, { status: 401 });
  }
  if (!Number.isFinite(timestamp)) {
    return json({ ok: false, error: "Missing timestamp." }, { status: 401 });
  }
  if (!isLikelySignature(signature)) {
    return json({ ok: false, error: "Missing signature." }, { status: 401 });
  }
  if (Math.abs(Date.now() - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return json({ ok: false, error: "Expired signature." }, { status: 401 });
  }

  const normalizedDefaults = normalizeDefaults(body?.settings, fallbackDefaults);
  const computedPayloadHash = buildPayloadHash(normalizedDefaults);
  if (computedPayloadHash.toLowerCase() !== String(payloadHash).toLowerCase()) {
    return json({ ok: false, error: "Payload hash mismatch." }, { status: 401 });
  }

  const message = buildPublishMessage({
    contractAddress,
    chainId,
    payloadHash: computedPayloadHash,
    timestamp,
  });

  let recovered;
  try {
    recovered = ethers.utils.getAddress(ethers.utils.verifyMessage(message, signature));
  } catch {
    return json({ ok: false, error: "Invalid signature." }, { status: 401 });
  }

  if (recovered !== ethers.utils.getAddress(signer)) {
    return json({ ok: false, error: "Signature signer mismatch." }, { status: 403 });
  }

  let ownerAddress = "";
  try {
    ownerAddress = await getOwnerFromChain(env, contractAddress);
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to resolve contract owner." },
      { status: 500 },
    );
  }

  if (recovered !== ownerAddress) {
    return json({ ok: false, error: "Only contract owner can update launchpad settings." }, { status: 403 });
  }

  const settingsToStore = {
    ...normalizedDefaults,
    updatedAt: Date.now(),
  };

  await kv.put(storageKey, JSON.stringify(settingsToStore));
  return json({ ok: true, settings: settingsToStore, source: "kv" });
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/launchpad-ui") {
      return handleLaunchpadUi(request, env, ctx);
    }

    return openNextWorker.fetch(request, env, ctx);
  },
};
