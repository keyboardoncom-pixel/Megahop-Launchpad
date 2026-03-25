# Megahop-Launchpad — MegaETH NFT Launchpad (Immutable Metadata Freeze)

This repository contains the **Megahop-Launchpad** NFT launchpad stack for **MegaETH**:
- Smart contract: Solidity + Hardhat + ERC721A
- Frontend: Next.js + thirdweb + ethers

The contract supports phased minting, allowlists (manual + Merkle), transfer lock, and irreversible metadata freeze.

## Features

- Phase-based minting (`addPhase`, `updatePhase`, `getActivePhase`)
- Max supply and max mint per wallet
- Price per phase (native token on MegaETH: ETH)
- Pause / unpause minting
- Owner withdraw
- Optional launchpad fee + fee recipient
- Allowlist modes:
  - on-chain wallet allowlist
  - Merkle root allowlist
- Transfer lock for freeze collection flow
- Irreversible metadata freeze (`freezeMetadata()`)

## Network Defaults (MegaETH)

Contract + frontend are configured for MegaETH by default:

- Mainnet: chain id `4326`, RPC `https://mainnet.megaeth.com/rpc`
- Testnet: chain id `6343`, RPC `https://carrot.megaeth.com/rpc`

## Project Structure

```text
.
├── contracts
│   ├── contracts/MintNFT.sol
│   ├── scripts/deploy.ts
│   ├── scripts/verify.ts
│   ├── hardhat.config.ts
│   ├── .env.example
│   └── package.json
├── frontend
│   ├── pages/index.tsx
│   ├── pages/admin.tsx
│   ├── components/WalletMenu.tsx
│   ├── lib/contract.ts
│   ├── lib/thirdweb.ts
│   ├── .env.example
│   └── package.json
└── README.md
```

## Contract Setup (Hardhat)

> Runtime requirement: use **Node.js 20** (`nvm use 20`) for stable Hardhat behavior.

### 1) Install dependencies

```bash
cd contracts
npm ci
```

### 2) Configure environment

```bash
cp .env.example .env
```

Set required values in `.env`:

- `MEGAETH_MAINNET_RPC_URL` and/or `MEGAETH_TESTNET_RPC_URL`
- `PRIVATE_KEY` (deployer)
- Deploy args:
  - `NAME`, `SYMBOL`
  - `MAX_SUPPLY`, `MINT_PRICE_ETH`, `MAX_MINT_PER_WALLET`
  - `BASE_URI`, `NOT_REVEALED_URI`, `CONTRACT_URI`
- Default phase:
  - `DEFAULT_PHASE_*`

Optional for verify:

- `MEGAETH_ETHERSCAN_API_KEY`
- `MEGAETH_TESTNET_EXPLORER_API_KEY`
- `CONTRACT_ADDRESS`

### 3) Compile

```bash
npm run compile
```

### 4) Deploy

Deploy to MegaETH mainnet:

```bash
npm run deploy:megaeth
```

Deploy to MegaETH testnet:

```bash
npm run deploy:megaeth-testnet
```

### 5) Verify (optional)

After deployment, set `CONTRACT_ADDRESS` in `.env`.

```bash
npm run verify:megaeth
# or
npm run verify:megaeth-testnet
```

### 6) Transfer Ownership to Multisig (recommended)

After deployment and validation, move ownership from deployer EOA to your multisig.

1. Set values in `contracts/.env`:
   - `CONTRACT_ADDRESS` = deployed contract
   - `NEW_OWNER` = multisig wallet address
2. Run:

```bash
npm run transfer-ownership:megaeth
# or
npm run transfer-ownership:megaeth-testnet
```

3. Verify owner:
   - check `owner()` on explorer
   - confirm Admin page shows multisig as owner

## Frontend Setup (Next.js)

### 1) Install dependencies

```bash
cd frontend
npm ci
```

### 2) Configure environment

```bash
cp .env.example .env.local
```

Set at minimum:

- `NEXT_PUBLIC_CONTRACT_ADDRESS`
- `NEXT_PUBLIC_RPC_URL`
- `NEXT_PUBLIC_CHAIN_ID` (`4326` mainnet or `6343` testnet)
- `NEXT_PUBLIC_NETWORK_NAME`
- `NEXT_PUBLIC_NATIVE_SYMBOL` (default `ETH`)
- `NEXT_PUBLIC_THIRDWEB_CLIENT_ID`

Optional UI/runtime settings:

- `NEXT_PUBLIC_BRAND_NAME`
- `NEXT_PUBLIC_BLOCK_EXPLORER_URL`
- `NEXT_PUBLIC_RPC_FALLBACK_URLS`
- `NEXT_PUBLIC_DEPLOY_BLOCK`

### 3) Run app

```bash
npm run dev
```

Routes:

- `/` → mint page
- `/admin` → owner controls

## Allowlist (Merkle) Workflow

1. Put one wallet per line in:

```text
contracts/allowlists/phase-0.txt
```

2. Generate Merkle proof file:

```bash
cd contracts
node scripts/generate-allowlist.js --phase 0 --input allowlists/phase-0.txt --output ../frontend/public/allowlists/phase-0.json
```

3. Copy generated root into Admin page (`Set Merkle Root`).
4. Enable allowlist for that phase.

## Security Notes

- `freezeMetadata()` is permanent and cannot be undone.
- Transfer lock (`setTransfersLocked`) blocks approvals/transfers while enabled.
- Owner permissions are enforced on-chain; frontend checks are convenience only.
- Keep private keys only in local env files and never commit them.
- Restrict admin operations to owner wallet on the correct network only.
- Use multisig ownership for production contracts.
- By default the allowlist API accepts same-origin requests only. Set `ALLOWLIST_API_ORIGINS` in `frontend/.env.local` if you need an explicit origin allowlist.
