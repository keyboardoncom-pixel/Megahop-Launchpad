import { ethers } from "ethers";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_LENGTHS = {
  collectionName: 120,
  collectionDescription: 2400,
  collectionBannerUrl: 2048,
  collectionWebsite: 512,
  collectionTwitter: 512,
};
const MAX_PROOF_WALLETS = 25_000;
const MAX_PROOF_DEPTH = 40;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;

const usedSignatures = new Map();
const rateLimitBuckets = new Map();

const cspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' data: blob: https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const defaultHeaders = {
  "Content-Security-Policy": cspDirectives,
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-DNS-Prefetch-Control": "off",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
};

const sanitizeString = (value) => (typeof value === "string" ? value.trim() : "");
const clampText = (value, maxLen) => sanitizeString(value).slice(0, maxLen);
const isAddress = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
const isBytes32 = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);
const isLikelySignature = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{130,132}$/.test(value);
const isProofArray = (value) =>
  Array.isArray(value) &&
  value.length <= MAX_PROOF_DEPTH &&
  value.every((item) => typeof item === "string" && isBytes32(item));

const withDefaultHeaders = (response, extraHeaders = {}) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(defaultHeaders)) {
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const json = (body, init = {}) =>
  withDefaultHeaders(
    new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        ...(init.headers || {}),
      },
    }),
  );

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

const buildProofsHash = (proofs) =>
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes(stableStringify(proofs)));

const buildAllowlistPublishMessage = ({ contractAddress, phaseId, root, total, proofsHash, timestamp }) =>
  [
    "Megahop Allowlist Publish",
    `contract:${sanitizeString(contractAddress).toLowerCase()}`,
    `phaseId:${phaseId}`,
    `root:${sanitizeString(root).toLowerCase()}`,
    `total:${total}`,
    `proofsHash:${sanitizeString(proofsHash).toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join("\n");

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

const buildFallbackDefaults = (env) => ({
  collectionName: env.NEXT_PUBLIC_COLLECTION_NAME || "Megahop",
  collectionDescription:
    env.NEXT_PUBLIC_COLLECTION_DESCRIPTION ||
    "The Megahop NFT collection on MegaETH with phased minting, allowlist control, admin tooling, and launchpad fee support.",
  collectionBannerUrl: env.NEXT_PUBLIC_COLLECTION_BANNER_URL || "",
  collectionWebsite: env.NEXT_PUBLIC_COLLECTION_WEBSITE || "",
  collectionTwitter: env.NEXT_PUBLIC_COLLECTION_TWITTER || "",
});

const getStorageKey = (contractAddress, chainId) =>
  `launchpad-ui:${contractAddress.toLowerCase()}:${chainId}`;

const getAllowlistKvKey = (contractAddress, chainId, phaseId) =>
  `allowlist-proof:${contractAddress.toLowerCase()}:${chainId}:${phaseId}`;

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
          return json(
            { ok: true, settings: toSettings(JSON.parse(raw), fallbackDefaults), source: "kv" },
            {
              headers: {
                "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
              },
            },
          );
        } catch {
          // fall through
        }
      }
    }
    return json(
      { ok: true, settings: { ...fallbackDefaults, updatedAt: 0 }, source: "defaults" },
      {
        headers: {
          "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=86400",
        },
      },
    );
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

  if (!isAddress(signer)) return json({ ok: false, error: "Missing signer." }, { status: 401 });
  if (!isBytes32(payloadHash)) return json({ ok: false, error: "Missing payload hash." }, { status: 401 });
  if (!Number.isFinite(timestamp)) return json({ ok: false, error: "Missing timestamp." }, { status: 401 });
  if (!isLikelySignature(signature)) return json({ ok: false, error: "Missing signature." }, { status: 401 });
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

  let recovered = "";
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

const resolveRequestIp = (request) =>
  sanitizeString(request.headers.get("cf-connecting-ip")) ||
  sanitizeString(request.headers.get("x-forwarded-for")).split(",")[0] ||
  "unknown";

const cleanupRateLimitBuckets = (now) => {
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
};

const isRateLimited = (request) => {
  const now = Date.now();
  cleanupRateLimitBuckets(now);
  const ip = resolveRequestIp(request);
  const current = rateLimitBuckets.get(ip);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false, retryAfterSec: 0 };
  }
  current.count += 1;
  if (current.count > RATE_LIMIT_MAX_REQUESTS) {
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  return { limited: false, retryAfterSec: 0 };
};

const cleanupUsedSignatures = () => {
  const now = Date.now();
  for (const [key, value] of usedSignatures.entries()) {
    if (now - value > MAX_SIGNATURE_AGE_MS) {
      usedSignatures.delete(key);
    }
  }
};

const handleAllowlistProof = async (request, env) => {
  const contractAddress = env.NEXT_PUBLIC_CONTRACT_ADDRESS || "";
  const chainId = Number(env.NEXT_PUBLIC_CHAIN_ID || 0);
  if (request.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
  }
  if (!isAddress(contractAddress) || !Number.isInteger(chainId) || chainId <= 0) {
    return json({ ok: false, error: "Server contract address is not configured." }, { status: 500 });
  }

  const url = new URL(request.url);
  const phaseId = Number(url.searchParams.get("phaseId"));
  if (!Number.isInteger(phaseId) || phaseId < 0) {
    return json({ ok: false, error: "Invalid phaseId" }, { status: 400 });
  }

  const key = getAllowlistKvKey(contractAddress, chainId, phaseId);
  if (env.LAUNCHPAD_UI_KV?.get) {
    try {
      const raw = await env.LAUNCHPAD_UI_KV.get(key);
      if (typeof raw === "string" && raw.trim()) {
        return json(JSON.parse(raw));
      }
    } catch {
      // fall through
    }
  }

  const assetUrl = new URL(`/allowlists/phase-${phaseId}.json`, url.origin);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  if (assetResponse.ok) {
    return withDefaultHeaders(assetResponse, { "Cache-Control": "no-store, max-age=0" });
  }

  return json({ ok: false, error: "Allowlist proof not found" }, { status: 404 });
};

const handleAllowlistUpsert = async (request, env) => {
  const contractAddress = env.NEXT_PUBLIC_CONTRACT_ADDRESS || "";
  const chainId = Number(env.NEXT_PUBLIC_CHAIN_ID || 0);

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: { Allow: "POST" } });
  }
  if (!isAddress(contractAddress) || !Number.isInteger(chainId) || chainId <= 0) {
    return json({ ok: false, error: "Server contract address is not configured." }, { status: 500 });
  }
  if (!env.LAUNCHPAD_UI_KV?.put) {
    return json({ ok: false, error: "Server storage is not configured." }, { status: 503 });
  }

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json({ ok: false, error: "Content-Type must be application/json." }, { status: 415 });
  }

  const rateLimitState = isRateLimited(request);
  if (rateLimitState.limited) {
    return json(
      { ok: false, error: "Too many requests. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimitState.retryAfterSec) } },
    );
  }

  const body = await request.json().catch(() => null);
  const phaseId = Number(body?.phaseId);
  const root = body?.root;
  const proofs = body?.proofs;
  const total = Number(body?.total || 0);
  const mode = typeof body?.mode === "string" ? body.mode : "address-only-merkle";
  const generatedAt =
    typeof body?.generatedAt === "string" && body.generatedAt.length > 0
      ? body.generatedAt
      : new Date().toISOString();
  const signer = body?.signer;
  const proofsHash = body?.proofsHash;
  const timestamp = Number(body?.timestamp);
  const signature = body?.signature;

  if (!Number.isInteger(phaseId) || phaseId < 0) {
    return json({ ok: false, error: "Invalid phaseId" }, { status: 400 });
  }
  if (!isBytes32(root)) {
    return json({ ok: false, error: "Invalid merkle root" }, { status: 400 });
  }
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) {
    return json({ ok: false, error: "Invalid proofs payload" }, { status: 400 });
  }

  const proofEntries = Object.entries(proofs);
  if (proofEntries.length > MAX_PROOF_WALLETS) {
    return json(
      { ok: false, error: `Proof payload too large. Max ${MAX_PROOF_WALLETS} wallets.` },
      { status: 413 },
    );
  }

  const normalizedProofs = {};
  for (const [wallet, proof] of proofEntries) {
    if (!isAddress(wallet) || !isProofArray(proof)) {
      return json({ ok: false, error: "Invalid proofs entry" }, { status: 400 });
    }
    normalizedProofs[wallet.toLowerCase()] = proof;
  }

  if (!isAddress(signer)) return json({ ok: false, error: "Missing signer" }, { status: 401 });
  if (!isBytes32(proofsHash)) return json({ ok: false, error: "Missing proofs hash" }, { status: 401 });
  if (!Number.isFinite(timestamp)) return json({ ok: false, error: "Missing timestamp" }, { status: 401 });
  if (!isLikelySignature(signature)) return json({ ok: false, error: "Missing signature" }, { status: 401 });

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return json({ ok: false, error: "Expired signature" }, { status: 401 });
  }

  const normalizedTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : proofEntries.length;
  if (normalizedTotal < proofEntries.length) {
    return json({ ok: false, error: "Invalid total count for proofs payload." }, { status: 400 });
  }

  const computedProofsHash = buildProofsHash(normalizedProofs);
  if (computedProofsHash.toLowerCase() !== String(proofsHash).toLowerCase()) {
    return json({ ok: false, error: "Proof hash mismatch" }, { status: 401 });
  }

  const message = buildAllowlistPublishMessage({
    contractAddress,
    phaseId,
    root,
    total: normalizedTotal,
    proofsHash: computedProofsHash,
    timestamp,
  });

  let recovered = "";
  try {
    recovered = ethers.utils.getAddress(ethers.utils.verifyMessage(message, signature));
  } catch {
    return json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }
  if (recovered !== ethers.utils.getAddress(signer)) {
    return json({ ok: false, error: "Signature signer mismatch" }, { status: 403 });
  }

  cleanupUsedSignatures();
  const signatureKey = signature.toLowerCase();
  if (usedSignatures.has(signatureKey)) {
    return json({ ok: false, error: "Replay detected" }, { status: 409 });
  }

  let ownerAddress = "";
  try {
    ownerAddress = await getOwnerFromChain(env, contractAddress);
  } catch (error) {
    return json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to resolve contract owner" },
      { status: 500 },
    );
  }
  if (recovered !== ownerAddress) {
    return json({ ok: false, error: "Only contract owner can publish proof" }, { status: 403 });
  }

  const payload = {
    phaseId,
    root,
    total: normalizedTotal,
    generatedAt,
    mode,
    proofs: normalizedProofs,
  };

  const key = getAllowlistKvKey(contractAddress, chainId, phaseId);
  await env.LAUNCHPAD_UI_KV.put(key, JSON.stringify(payload));
  usedSignatures.set(signatureKey, now);
  return json({ ok: true, path: `/api/allowlists/proof?phaseId=${phaseId}` });
};

const fetchStaticAsset = async (request, env) => {
  const url = new URL(request.url);
  const candidates = [url.pathname];

  if (url.pathname === "/") {
    candidates.push("/index.html");
  } else if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
    candidates.push(`${url.pathname}.html`);
    candidates.push(`${url.pathname.replace(/\/$/, "")}/index.html`);
  }

  for (const candidate of candidates) {
    const candidateUrl = new URL(request.url);
    candidateUrl.pathname = candidate;
    const response = await env.ASSETS.fetch(new Request(candidateUrl.toString(), request));
    if (response.ok) {
      return withDefaultHeaders(response);
    }
  }

  const fallbackUrl = new URL(request.url);
  fallbackUrl.pathname = "/404.html";
  const fallbackResponse = await env.ASSETS.fetch(new Request(fallbackUrl.toString(), request));
  if (fallbackResponse.ok) {
    return withDefaultHeaders(fallbackResponse, { "Cache-Control": "no-store, max-age=0" });
  }
  return withDefaultHeaders(new Response("Not found", { status: 404 }), {
    "Cache-Control": "no-store, max-age=0",
  });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/launchpad-ui") {
      return handleLaunchpadUi(request, env);
    }
    if (url.pathname === "/api/allowlists/proof") {
      return handleAllowlistProof(request, env);
    }
    if (url.pathname === "/api/allowlists/upsert") {
      return handleAllowlistUpsert(request, env);
    }

    return fetchStaticAsset(request, env);
  },
};
