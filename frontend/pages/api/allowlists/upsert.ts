import type { NextApiRequest, NextApiResponse } from "next";
import { promises as fs } from "fs";
import path from "path";
import { ethers } from "ethers";

type UpsertResponse =
  | { ok: true; path: string }
  | { ok: false; error: string };

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb",
    },
  },
};

const isBytes32 = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value);

const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

const isLikelySignature = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{130,132}$/.test(value);

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || "";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0);
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "";
const RPC_FALLBACK_URLS = (process.env.NEXT_PUBLIC_RPC_FALLBACK_URLS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_PROOF_WALLETS = Math.max(1, Number(process.env.ALLOWLIST_MAX_WALLETS || 25000));
const MAX_PROOF_DEPTH = Math.max(1, Number(process.env.ALLOWLIST_MAX_PROOF_DEPTH || 40));
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.ALLOWLIST_RATE_LIMIT_WINDOW_MS || 60_000));
const RATE_LIMIT_MAX_REQUESTS = Math.max(1, Number(process.env.ALLOWLIST_RATE_LIMIT_MAX_REQUESTS || 30));
const ALLOWLIST_API_ORIGINS = (process.env.ALLOWLIST_API_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    try {
      return new URL(value).origin.toLowerCase();
    } catch {
      return "";
    }
  })
  .filter(Boolean);
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const usedSignatures = new Map<string, number>();
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const isProofArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_PROOF_DEPTH &&
  value.every((item) => typeof item === "string" && isBytes32(item));

const resolveRequestIp = (req: NextApiRequest) => {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
};

const cleanupRateLimitBuckets = (now: number) => {
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
};

const isRateLimited = (req: NextApiRequest) => {
  const now = Date.now();
  cleanupRateLimitBuckets(now);
  const ip = resolveRequestIp(req);
  const current = rateLimitBuckets.get(ip);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false, retryAfterSec: 0 };
  }
  current.count += 1;
  if (current.count > RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    return { limited: true, retryAfterSec };
  }
  return { limited: false, retryAfterSec: 0 };
};

const inferRequestOrigin = (req: NextApiRequest) => {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protoRaw = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const proto =
    typeof protoRaw === "string" && protoRaw.trim().length > 0 ? protoRaw.split(",")[0].trim() : "https";

  const forwardedHost = req.headers["x-forwarded-host"];
  const hostRaw = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const hostSource = typeof hostRaw === "string" && hostRaw.trim().length > 0 ? hostRaw : req.headers.host || "";
  const host = hostSource.split(",")[0].trim();

  if (!host) return "";
  return `${proto}://${host}`.toLowerCase();
};

const isAllowedOrigin = (req: NextApiRequest, originHeader: string | undefined) => {
  if (!originHeader) {
    return true;
  }

  let origin = "";
  try {
    origin = new URL(originHeader).origin.toLowerCase();
  } catch {
    return false;
  }

  if (ALLOWLIST_API_ORIGINS.length) {
    return ALLOWLIST_API_ORIGINS.includes(origin);
  }

  const requestOrigin = inferRequestOrigin(req);
  if (!requestOrigin) {
    return false;
  }
  return origin === requestOrigin;
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

const getOwnerFromChain = async () => {
  const candidates = [RPC_URL, ...RPC_FALLBACK_URLS].filter(Boolean);
  if (!CONTRACT_ADDRESS || !candidates.length) {
    throw new Error("Server RPC/contract is not configured.");
  }
  const provider = new ethers.providers.StaticJsonRpcProvider(candidates[0]);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ["function owner() view returns (address)"], provider);
  const owner = await contract.owner();
  return ethers.utils.getAddress(owner);
};

const cleanupUsedSignatures = () => {
  const now = Date.now();
  for (const [key, value] of usedSignatures.entries()) {
    if (now - value > MAX_SIGNATURE_AGE_MS) {
      usedSignatures.delete(key);
    }
  }
};

const kvConfigured = () => KV_REST_API_URL.length > 0 && KV_REST_API_TOKEN.length > 0;

const getAllowlistKvKey = (phaseId: number) => {
  const chainSegment = Number.isInteger(CHAIN_ID) && CHAIN_ID > 0 ? String(CHAIN_ID) : "unknown";
  return `allowlist-proof:${CONTRACT_ADDRESS.toLowerCase()}:${chainSegment}:${phaseId}`;
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

const saveAllowlistToKv = async (phaseId: number, serializedPayload: string) => {
  if (!kvConfigured()) {
    throw new Error("KV_REST_API_* is not configured.");
  }
  await callKv(["SET", getAllowlistKvKey(phaseId), serializedPayload]);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<UpsertResponse>) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAddress(CONTRACT_ADDRESS)) {
    return res.status(500).json({ ok: false, error: "Server contract address is not configured." });
  }
  if (!isAllowedOrigin(req, typeof req.headers.origin === "string" ? req.headers.origin : undefined)) {
    return res.status(403).json({ ok: false, error: "Origin not allowed." });
  }
  const rateLimitState = isRateLimited(req);
  if (rateLimitState.limited) {
    res.setHeader("Retry-After", String(rateLimitState.retryAfterSec));
    return res.status(429).json({ ok: false, error: "Too many requests. Try again later." });
  }
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return res.status(415).json({ ok: false, error: "Content-Type must be application/json." });
  }

  const phaseId = Number(req.body?.phaseId);
  const root = req.body?.root;
  const proofs = req.body?.proofs;
  const total = Number(req.body?.total || 0);
  const mode = typeof req.body?.mode === "string" ? req.body.mode : "address-only-merkle";
  const generatedAt =
    typeof req.body?.generatedAt === "string" && req.body.generatedAt.length > 0
      ? req.body.generatedAt
      : new Date().toISOString();
  const signer = req.body?.signer;
  const proofsHash = req.body?.proofsHash;
  const timestamp = Number(req.body?.timestamp);
  const signature = req.body?.signature;

  if (!Number.isInteger(phaseId) || phaseId < 0) {
    return res.status(400).json({ ok: false, error: "Invalid phaseId" });
  }
  if (!isBytes32(root)) {
    return res.status(400).json({ ok: false, error: "Invalid merkle root" });
  }
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) {
    return res.status(400).json({ ok: false, error: "Invalid proofs payload" });
  }

  const proofEntries = Object.entries(proofs as Record<string, unknown>);
  if (proofEntries.length > MAX_PROOF_WALLETS) {
    return res
      .status(413)
      .json({ ok: false, error: `Proof payload too large. Max ${MAX_PROOF_WALLETS} wallets.` });
  }

  const normalizedProofs: Record<string, string[]> = {};
  for (const [wallet, proof] of proofEntries) {
    if (!isAddress(wallet) || !isProofArray(proof)) {
      return res.status(400).json({ ok: false, error: "Invalid proofs entry" });
    }
    normalizedProofs[wallet.toLowerCase()] = proof;
  }
  if (!isAddress(signer)) {
    return res.status(401).json({ ok: false, error: "Missing signer" });
  }
  if (!isBytes32(proofsHash)) {
    return res.status(401).json({ ok: false, error: "Missing proofs hash" });
  }
  if (!Number.isFinite(timestamp)) {
    return res.status(401).json({ ok: false, error: "Missing timestamp" });
  }
  if (!isLikelySignature(signature)) {
    return res.status(401).json({ ok: false, error: "Missing signature" });
  }

  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return res.status(401).json({ ok: false, error: "Expired signature" });
  }

  const normalizedTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : proofEntries.length;
  if (normalizedTotal < proofEntries.length) {
    return res.status(400).json({ ok: false, error: "Invalid total count for proofs payload." });
  }

  const payload = {
    phaseId,
    root,
    total: normalizedTotal,
    generatedAt,
    mode,
    proofs: normalizedProofs,
  };
  const computedProofsHash = buildProofsHash(normalizedProofs);
  if (computedProofsHash.toLowerCase() !== String(proofsHash).toLowerCase()) {
    return res.status(401).json({ ok: false, error: "Proof hash mismatch" });
  }

  const message = buildAllowlistPublishMessage({
    contractAddress: CONTRACT_ADDRESS,
    phaseId: payload.phaseId,
    root: payload.root,
    total: payload.total,
    proofsHash: computedProofsHash,
    timestamp,
  });

  let recovered: string;
  try {
    recovered = ethers.utils.getAddress(ethers.utils.verifyMessage(message, signature));
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid signature" });
  }
  if (recovered !== ethers.utils.getAddress(signer)) {
    return res.status(403).json({ ok: false, error: "Signature signer mismatch" });
  }

  cleanupUsedSignatures();
  const signatureKey = signature.toLowerCase();
  if (usedSignatures.has(signatureKey)) {
    return res.status(409).json({ ok: false, error: "Replay detected" });
  }

  let ownerAddress = "";
  try {
    ownerAddress = await getOwnerFromChain();
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "Failed to resolve contract owner" });
  }
  if (recovered !== ownerAddress) {
    return res.status(403).json({ ok: false, error: "Only contract owner can publish proof" });
  }

  const serialized = JSON.stringify(payload, null, 2);
  let savedToFile = false;
  let savedToKv = false;
  let fileError = "";
  let kvError = "";

  try {
    const allowlistDir = path.join(process.cwd(), "public", "allowlists");
    await fs.mkdir(allowlistDir, { recursive: true });
    const filePath = path.join(allowlistDir, `phase-${phaseId}.json`);
    try {
      const existing = await fs.readFile(filePath, "utf-8");
      if (existing.trim() === serialized.trim()) {
        savedToFile = true;
      }
    } catch {
      // File not found is expected for a new phase.
    }

    if (!savedToFile) {
      await fs.writeFile(filePath, serialized, "utf-8");
      savedToFile = true;
    }
  } catch (error: any) {
    fileError = error?.message || "Failed to write proof file on server";
  }

  if (kvConfigured()) {
    try {
      await saveAllowlistToKv(phaseId, serialized);
      savedToKv = true;
    } catch (error: any) {
      kvError = error?.message || "Failed to write proof payload to KV";
    }
  }

  if (!savedToFile && !savedToKv) {
    if (!kvConfigured()) {
      return res
        .status(500)
        .json({ ok: false, error: `${fileError || "Failed to write proof file on server"}. Configure KV_REST_API_* for auto-publish on serverless.` });
    }
    return res
      .status(500)
      .json({ ok: false, error: `${fileError || "Failed to write proof file on server"}; ${kvError || "Failed to write proof payload to KV"}` });
  }

  usedSignatures.set(signatureKey, now);

  if (savedToKv) {
    return res.status(200).json({ ok: true, path: `/api/allowlists/proof?phaseId=${phaseId}` });
  }

  return res.status(200).json({ ok: true, path: `/allowlists/phase-${phaseId}.json` });
}
