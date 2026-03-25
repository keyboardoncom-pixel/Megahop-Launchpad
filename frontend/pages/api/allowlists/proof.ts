import type { NextApiRequest, NextApiResponse } from "next";
import { promises as fs } from "fs";
import path from "path";

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || "";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 0);
const KV_REST_API_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

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

const loadFromFile = async (phaseId: number) => {
  const filePath = path.join(process.cwd(), "public", "allowlists", `phase-${phaseId}.json`);
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
};

const loadFromKv = async (phaseId: number) => {
  if (!kvConfigured()) return null;
  const raw = await callKv(["GET", getAllowlistKvKey(phaseId)]);
  if (typeof raw !== "string" || !raw.trim()) return null;
  return JSON.parse(raw);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAddress(CONTRACT_ADDRESS)) {
    return res.status(500).json({ ok: false, error: "Server contract address is not configured." });
  }

  const phaseId = Number(req.query.phaseId);
  if (!Number.isInteger(phaseId) || phaseId < 0) {
    return res.status(400).json({ ok: false, error: "Invalid phaseId" });
  }

  try {
    const fromKv = await loadFromKv(phaseId);
    if (fromKv) {
      return res.status(200).json(fromKv);
    }
  } catch {
    // fallback to static file
  }

  try {
    const fromFile = await loadFromFile(phaseId);
    return res.status(200).json(fromFile);
  } catch {
    // keep generic 404 for client fallback behavior
  }

  return res.status(404).json({ ok: false, error: "Allowlist proof not found" });
}
