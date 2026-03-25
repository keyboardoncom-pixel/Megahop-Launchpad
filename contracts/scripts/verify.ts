import { run } from "hardhat";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const {
    CONTRACT_ADDRESS,
    NAME,
    SYMBOL,
    MAX_SUPPLY,
    MINT_PRICE_ETH,
    MAX_MINT_PER_WALLET,
    BASE_URI,
    NOT_REVEALED_URI,
    CONTRACT_URI,
  } = process.env;

  if (
    !CONTRACT_ADDRESS ||
    !NAME ||
    !SYMBOL ||
    !MAX_SUPPLY ||
    !MINT_PRICE_ETH ||
    !MAX_MINT_PER_WALLET
  ) {
    throw new Error("Missing required env vars. Check contracts/.env.example");
  }

  const maxSupply = BigInt(MAX_SUPPLY);
  const maxMintPerWallet = BigInt(MAX_MINT_PER_WALLET);
  const mintPrice = ethers.parseEther(MINT_PRICE_ETH);
  const args = [
    NAME,
    SYMBOL,
    maxSupply,
    mintPrice,
    maxMintPerWallet,
    BASE_URI || "",
    NOT_REVEALED_URI || "",
    CONTRACT_URI || "",
  ];

  await run("verify:verify", {
    address: CONTRACT_ADDRESS,
    constructorArguments: args,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
