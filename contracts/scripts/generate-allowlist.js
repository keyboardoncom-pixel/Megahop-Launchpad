const fs = require("fs");
const path = require("path");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

const normalizeAddress = (value) => {
  if (!ADDRESS_REGEX.test(value)) {
    throw new Error(`Invalid address: ${value}`);
  }
  return `0x${value.slice(2).toLowerCase()}`;
};

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1];
};

const phaseId = getArg("--phase");
const inputPath = getArg("--input");
const outputPath = getArg("--output");

if (!phaseId || !inputPath || !outputPath) {
  console.error(
    "Usage: node scripts/generate-allowlist.js --phase <id> --input <file> --output <file>"
  );
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf-8");
const matched = raw.match(/0x[a-fA-F0-9]{40}/g) || [];
const unique = Array.from(new Set(matched.map((addr) => normalizeAddress(addr)))).sort((a, b) =>
  a.toLowerCase().localeCompare(b.toLowerCase())
);

if (!unique.length) {
  console.error("No valid wallet address found in input file.");
  process.exit(1);
}
const leaves = unique.map((addr) => {
  return keccak256(Buffer.from(addr.slice(2), "hex"));
});

const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
const root = tree.getHexRoot();

const proofs = {};
unique.forEach((addr, idx) => {
  const leaf = leaves[idx];
  proofs[addr.toLowerCase()] = tree.getHexProof(leaf);
});

const payload = {
  phaseId: Number(phaseId),
  root,
  mode: "address-only-merkle",
  total: unique.length,
  generatedAt: new Date().toISOString(),
  proofs,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));

console.log("Allowlist generated");
console.log("Phase:", phaseId);
console.log("Wallets:", unique.length);
console.log("Root:", root);
console.log("Output:", outputPath);
