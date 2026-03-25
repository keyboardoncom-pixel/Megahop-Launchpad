import fs from "node:fs";
import { ethers } from "ethers";

const parseEnvFile = (filePath) =>
  Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
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

const buildLaunchpadUiPayloadHash = (settings) =>
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes(stableStringify(settings)));

const buildLaunchpadUiPublishMessage = ({ contractAddress, chainId, payloadHash, timestamp }) =>
  [
    "Megahop Launchpad UI Publish",
    `contract:${String(contractAddress).trim().toLowerCase()}`,
    `chainId:${chainId}`,
    `payloadHash:${String(payloadHash).trim().toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join("\n");

const contractsEnv = parseEnvFile("/Users/yafiiviviana/Documents/Megahop-Launchpad/contracts/.env");
const frontendEnv = parseEnvFile("/Users/yafiiviviana/Documents/Megahop-Launchpad/frontend/.env.local");

const wallet = new ethers.Wallet(contractsEnv.PRIVATE_KEY);
const apiBaseUrl = process.argv[2] || "https://megahop-launchpad.brianlarrystorn.workers.dev";
const settings = {
  collectionName: frontendEnv.NEXT_PUBLIC_COLLECTION_NAME || "Megahop",
  collectionDescription:
    frontendEnv.NEXT_PUBLIC_COLLECTION_DESCRIPTION ||
    "The Megahop NFT collection on MegaETH with phased minting, allowlist control, admin tooling, and launchpad fee support.",
  collectionBannerUrl: frontendEnv.NEXT_PUBLIC_COLLECTION_BANNER_URL || "",
  collectionWebsite: frontendEnv.NEXT_PUBLIC_COLLECTION_WEBSITE || "",
  collectionTwitter: frontendEnv.NEXT_PUBLIC_COLLECTION_TWITTER || "",
};

const payloadHash = buildLaunchpadUiPayloadHash(settings);
const timestamp = Date.now();
const message = buildLaunchpadUiPublishMessage({
  contractAddress: frontendEnv.NEXT_PUBLIC_CONTRACT_ADDRESS,
  chainId: Number(frontendEnv.NEXT_PUBLIC_CHAIN_ID),
  payloadHash,
  timestamp,
});

const signature = await wallet.signMessage(message);

const saveResponse = await fetch(`${apiBaseUrl}/api/launchpad-ui`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  },
  body: JSON.stringify({
    settings,
    signer: wallet.address,
    payloadHash,
    timestamp,
    signature,
  }),
});

const savePayload = await saveResponse.json().catch(() => null);

const readResponse = await fetch(`${apiBaseUrl}/api/launchpad-ui`, {
  headers: {
    "Cache-Control": "no-cache",
  },
});
const readPayload = await readResponse.json().catch(() => null);

console.log(
  JSON.stringify(
    {
      saveStatus: saveResponse.status,
      saveOk: saveResponse.ok,
      saveSource: savePayload?.source ?? null,
      saveError: savePayload?.error ?? null,
      readStatus: readResponse.status,
      readOk: readResponse.ok,
      readSource: readPayload?.source ?? null,
      readUpdatedAt: readPayload?.settings?.updatedAt ?? null,
    },
    null,
    2,
  ),
);
