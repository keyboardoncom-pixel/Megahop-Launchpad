# Cloudflare Deploy Notes

This frontend should be deployed to **Cloudflare Workers Builds**, not static Cloudflare Pages.

Why:
- The app uses Next.js Pages Router with server API routes under `pages/api/*`.
- Static Pages export would drop or break those features.

## Recommended Cloudflare project settings

- Product: `Workers Builds`
- Repository root directory: `frontend`
- Install command: `npm install`
- Deploy command: `npm run deploy`
- Node version: `22`

Cloudflare runtime config is already committed in `wrangler.jsonc`.

## Required environment variables

Public runtime config:
- `NEXT_PUBLIC_CONTRACT_ADDRESS`
- `NEXT_PUBLIC_RPC_URL`
- `NEXT_PUBLIC_RPC_FALLBACK_URLS`
- `NEXT_PUBLIC_RPC_TIMEOUT_MS`
- `NEXT_PUBLIC_RPC_READ_RETRY_ATTEMPTS`
- `NEXT_PUBLIC_RPC_READ_RETRY_DELAY_MS`
- `NEXT_PUBLIC_STATS_REFRESH_MS`
- `NEXT_PUBLIC_PHASES_REFRESH_MS`
- `NEXT_PUBLIC_REFRESH_JITTER_MS`
- `NEXT_PUBLIC_CHAIN_ID`
- `NEXT_PUBLIC_NETWORK_NAME`
- `NEXT_PUBLIC_NATIVE_SYMBOL`
- `NEXT_PUBLIC_BLOCK_EXPLORER_URL`
- `NEXT_PUBLIC_BRAND_NAME`
- `NEXT_PUBLIC_COLLECTION_NAME`
- `NEXT_PUBLIC_COLLECTION_DESCRIPTION`
- `NEXT_PUBLIC_COLLECTION_BANNER_URL`
- `NEXT_PUBLIC_COLLECTION_WEBSITE`
- `NEXT_PUBLIC_COLLECTION_TWITTER`
- `NEXT_PUBLIC_DEPLOY_BLOCK`
- `NEXT_PUBLIC_ENABLE_MINTERS`
- `NEXT_PUBLIC_MINTERS_LOOKBACK_BLOCKS`

Server-side API config:
- `LAUNCHPAD_UI_KV` Cloudflare KV binding for persisted mint-page settings
- `ALLOWLIST_API_ORIGINS`
- `ALLOWLIST_RATE_LIMIT_WINDOW_MS`
- `ALLOWLIST_RATE_LIMIT_MAX_REQUESTS`
- `ALLOWLIST_MAX_WALLETS`
- `ALLOWLIST_MAX_PROOF_DEPTH`
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

## Local validation commands

Use Node 22 when available.

```bash
cd frontend
npm install
npm run cf:build
npx wrangler dev
```

## Current status

- The frontend is deployed successfully on Cloudflare Workers/OpenNext.
- Runtime wallet support is now limited to injected EVM wallets used by this project: `MetaMask`, `Phantom`, and `Rabby`.
- `npm run deploy` includes an automatic post-build patch for the OpenNext single-package path bug that can generate `process.chdir("")` in the worker bundle.
- Mint page settings can persist in Cloudflare KV via the `LAUNCHPAD_UI_KV` binding, with REST KV fallback still supported for environments outside Cloudflare.
