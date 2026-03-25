import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS || "";
  const newOwnerRaw = process.env.NEW_OWNER || "";

  if (!ethers.isAddress(contractAddress)) {
    throw new Error("Invalid CONTRACT_ADDRESS in contracts/.env");
  }
  if (!ethers.isAddress(newOwnerRaw)) {
    throw new Error("Invalid NEW_OWNER in contracts/.env");
  }

  const newOwner = ethers.getAddress(newOwnerRaw);
  const contract = await ethers.getContractAt("MintNFT", contractAddress);
  const currentOwner = ethers.getAddress(await contract.owner());
  const [signer] = await ethers.getSigners();
  const signerAddress = ethers.getAddress(await signer.getAddress());

  if (currentOwner !== signerAddress) {
    throw new Error(
      `Connected signer (${signerAddress}) is not the current owner (${currentOwner}).`
    );
  }

  if (currentOwner === newOwner) {
    console.log(`Ownership already set to ${newOwner}`);
    return;
  }

  console.log(`Transferring ownership of ${contractAddress}...`);
  console.log(`Current owner: ${currentOwner}`);
  console.log(`New owner    : ${newOwner}`);

  const tx = await contract.transferOwnership(newOwner);
  console.log(`Submitted tx: ${tx.hash}`);
  await tx.wait();

  const ownerAfter = ethers.getAddress(await contract.owner());
  if (ownerAfter !== newOwner) {
    throw new Error(`Ownership transfer verification failed. Current owner is ${ownerAfter}`);
  }

  console.log(`Ownership transfer complete. New owner: ${ownerAfter}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
