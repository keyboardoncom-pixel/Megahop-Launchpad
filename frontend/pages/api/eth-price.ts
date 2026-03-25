import type { NextApiRequest, NextApiResponse } from "next";

type EthPriceResponse =
  | { ok: true; usd: number; source: string }
  | { ok: false; error: string };

const ETH_USD_RATE_SOURCES = [
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    pick: (payload: any) => Number(payload?.data?.amount),
  },
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
    pick: (payload: any) => Number(payload?.price),
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    pick: (payload: any) => Number(payload?.ethereum?.usd),
  },
] as const;

const REQUEST_TIMEOUT_MS = 4000;

const fetchWithTimeout = async (url: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
  } finally {
    clearTimeout(timer);
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<EthPriceResponse>
) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  for (const source of ETH_USD_RATE_SOURCES) {
    try {
      const response = await fetchWithTimeout(source.url);
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      const usd = source.pick(payload);
      if (Number.isFinite(usd) && usd > 0) {
        return res.status(200).json({ ok: true, usd, source: source.name });
      }
    } catch {
      // Try the next provider.
    }
  }

  return res.status(503).json({ ok: false, error: "ETH/USD price unavailable" });
}
