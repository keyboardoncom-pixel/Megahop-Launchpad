import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const {
    NAME,
    SYMBOL,
    MAX_SUPPLY,
    MINT_PRICE_ETH,
    MAX_MINT_PER_WALLET,
    BASE_URI,
    NOT_REVEALED_URI,
    CONTRACT_URI,
    DEFAULT_PHASE_NAME,
    DEFAULT_PHASE_START,
    DEFAULT_PHASE_END,
    DEFAULT_PHASE_PRICE_ETH,
    DEFAULT_PHASE_MAX_PER_WALLET,
    DEFAULT_PHASE_ALLOWLIST_ENABLED,
    DEFAULT_PHASE_MERKLE_ROOT,
  } = process.env;

  if (!NAME || !SYMBOL || !MAX_SUPPLY || !MINT_PRICE_ETH || !MAX_MINT_PER_WALLET) {
    throw new Error("Missing required env vars. Check contracts/.env.example");
  }

  const maxSupply = BigInt(MAX_SUPPLY);
  const maxMintPerWallet = BigInt(MAX_MINT_PER_WALLET);
  const mintPrice = ethers.parseEther(MINT_PRICE_ETH);
  const defaultPhaseName =
    DEFAULT_PHASE_NAME && DEFAULT_PHASE_NAME.trim().length > 0
      ? DEFAULT_PHASE_NAME
      : "Public stage";
  const defaultPhaseStart = Number(DEFAULT_PHASE_START || 0);
  const defaultPhaseEnd = Number(DEFAULT_PHASE_END || 0);
  const defaultPhasePriceEth = DEFAULT_PHASE_PRICE_ETH || MINT_PRICE_ETH;
  const defaultPhasePrice = ethers.parseEther(defaultPhasePriceEth);
  const defaultPhaseMaxPerWallet = BigInt(DEFAULT_PHASE_MAX_PER_WALLET || MAX_MINT_PER_WALLET);
  const defaultPhaseAllowlistEnabled =
    (DEFAULT_PHASE_ALLOWLIST_ENABLED || "").toLowerCase() === "true";
  const defaultPhaseMerkleRoot = DEFAULT_PHASE_MERKLE_ROOT || "";

  if (!Number.isFinite(defaultPhaseStart) || defaultPhaseStart < 0) {
    throw new Error("DEFAULT_PHASE_START must be a valid unix timestamp");
  }
  if (!Number.isFinite(defaultPhaseEnd) || defaultPhaseEnd < 0) {
    throw new Error("DEFAULT_PHASE_END must be a valid unix timestamp");
  }

  const MintNFT = await ethers.getContractFactory("MintNFT");
  const contract = await MintNFT.deploy(
    NAME,
    SYMBOL,
    maxSupply,
    mintPrice,
    maxMintPerWallet,
    BASE_URI || "",
    NOT_REVEALED_URI || "",
    CONTRACT_URI || ""
  );

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("MintNFT deployed to:", address);

  const phaseId = Number(await contract.phaseCount());
  const addTx = await contract.addPhase(
    defaultPhaseName,
    defaultPhaseStart,
    defaultPhaseEnd,
    defaultPhasePrice,
    defaultPhaseMaxPerWallet
  );
  await addTx.wait();

  if (defaultPhaseAllowlistEnabled) {
    const allowTx = await contract.setPhaseAllowlistEnabled(phaseId, true);
    await allowTx.wait();
  }

  if (defaultPhaseMerkleRoot) {
    const rootTx = await contract.setPhaseMerkleRoot(phaseId, defaultPhaseMerkleRoot);
    await rootTx.wait();
  }

  console.log(
    `Default phase created (id=${phaseId}) ${defaultPhaseName} | price=${defaultPhasePriceEth} ETH`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
