import { expect } from "chai";
import { ethers } from "hardhat";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";

const buildLeaf = (address: string) => {
  const packed = ethers.solidityPacked(["address"], [address]);
  return keccak256(Buffer.from(packed.slice(2), "hex"));
};

describe("MintNFT", function () {
  async function deployFixture() {
    const [owner, user, other] = await ethers.getSigners();
    const MintNFT = await ethers.getContractFactory("MintNFT");
    const baseURI = "ipfs://base/";
    const notRevealed = "ipfs://hidden.json";
    const contractURI = "ipfs://contract.json";

    const contract = await MintNFT.deploy(
      "Lapinoz",
      "CHILL",
      111n,
      ethers.parseEther("0.01"),
      3n,
      baseURI,
      notRevealed,
      contractURI
    );

    await contract.waitForDeployment();
    await contract.addPhase("Public", 0, 0, ethers.parseEther("0.01"), 3);

    return { contract, owner, user, other, baseURI, notRevealed };
  }

  it("mints in active phase", async () => {
    const { contract, user } = await deployFixture();
    await expect(
      contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.not.be.reverted;
    expect(await contract.totalSupply()).to.equal(1n);
  });

  it("enforces max per wallet per phase", async () => {
    const { contract, user } = await deployFixture();
    await contract.connect(user).publicMint(3, [], { value: ethers.parseEther("0.03") });
    await expect(
      contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.be.revertedWith("Max mint per wallet exceeded");
  });

  it("supports manual allowlist", async () => {
    const { contract, user, other } = await deployFixture();
    await contract.setPhaseAllowlistEnabled(0, true);
    await contract.setPhaseAllowlist(0, [user.address], true);

    await expect(
      contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.not.be.reverted;

    await expect(
      contract.connect(other).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.be.revertedWith("Not allowlisted");
  });

  it("supports merkle allowlist", async () => {
    const { contract, user, other } = await deployFixture();
    const leaves = [user.address].map(buildLeaf);
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = tree.getHexRoot();
    const proof = tree.getHexProof(leaves[0]);

    await contract.setPhaseAllowlistEnabled(0, true);
    await contract.setPhaseMerkleRoot(0, root);

    await expect(
      contract.connect(user).publicMint(1, proof, { value: ethers.parseEther("0.01") })
    ).to.not.be.reverted;

    await expect(
      contract.connect(other).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.be.revertedWith("Not allowlisted");
  });

  it("blocks transfers when frozen", async () => {
    const { contract, user, other } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    await expect(
      contract
        .connect(user)
        ["safeTransferFrom(address,address,uint256)"](user.address, other.address, 1)
    ).to.be.revertedWith("Transfers locked");
  });

  it("allows transfer when unfrozen", async () => {
    const { contract, user, other } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    await contract.setTransfersLocked(false);
    await expect(
      contract
        .connect(user)
        ["safeTransferFrom(address,address,uint256)"](user.address, other.address, 1)
    ).to.not.be.reverted;
  });

  it("blocks approvals when frozen", async () => {
    const { contract, user, other } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    await expect(contract.connect(user).approve(other.address, 1)).to.be.revertedWith(
      "Transfers locked"
    );
    await expect(
      contract.connect(user).setApprovalForAll(other.address, true)
    ).to.be.revertedWith("Transfers locked");
    expect(await contract.isApprovedForAll(user.address, other.address)).to.equal(false);
  });

  it("allows approvals when unfrozen", async () => {
    const { contract, user, other } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    await contract.setTransfersLocked(false);
    await expect(contract.connect(user).approve(other.address, 1)).to.not.be.reverted;
    await expect(contract.connect(user).setApprovalForAll(other.address, true)).to.not.be
      .reverted;
    expect(await contract.isApprovedForAll(user.address, other.address)).to.equal(true);
  });

  it("hides prior approvals while frozen", async () => {
    const { contract, user, other } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    await contract.setTransfersLocked(false);
    await contract.connect(user).approve(other.address, 1);
    await contract.connect(user).setApprovalForAll(other.address, true);
    expect(await contract.getApproved(1)).to.equal(other.address);
    expect(await contract.isApprovedForAll(user.address, other.address)).to.equal(true);
    await contract.setTransfersLocked(true);
    expect(await contract.getApproved(1)).to.equal(ethers.ZeroAddress);
    expect(await contract.isApprovedForAll(user.address, other.address)).to.equal(false);
  });

  it("respects pause", async () => {
    const { contract, user } = await deployFixture();
    await contract.pause();
    await expect(
      contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.be.revertedWith("Pausable: paused");
    await contract.unpause();
    await expect(
      contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") })
    ).to.not.be.reverted;
  });

  it("reveals metadata when toggled", async () => {
    const { contract, user, baseURI, notRevealed } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    expect(await contract.tokenURI(1)).to.equal(notRevealed);
    await contract.setRevealed(true);
    expect(await contract.tokenURI(1)).to.equal(`${baseURI}1.json`);
  });

  it("freezes metadata only once", async () => {
    const { contract } = await deployFixture();
    await expect(contract.freezeMetadata()).to.emit(contract, "MetadataFrozen");
    expect(await contract.metadataFrozen()).to.equal(true);
    await expect(contract.freezeMetadata()).to.be.revertedWith("Metadata already frozen");
  });

  it("blocks metadata updates after freeze", async () => {
    const { contract } = await deployFixture();
    await contract.freezeMetadata();

    await expect(contract.setBaseURI("ipfs://new-base/")).to.be.revertedWith("Metadata frozen");
    await expect(contract.setContractURI("ipfs://new-contract.json")).to.be.revertedWith(
      "Metadata frozen"
    );
    await expect(contract.setNotRevealedURI("ipfs://new-hidden.json")).to.be.revertedWith(
      "Metadata frozen"
    );
    await expect(contract.setRevealed(true)).to.be.revertedWith("Metadata frozen");
  });

  it("keeps tokenURI immutable after metadata freeze", async () => {
    const { contract, user, baseURI } = await deployFixture();
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    await contract.setRevealed(true);
    expect(await contract.tokenURI(1)).to.equal(`${baseURI}1.json`);

    await contract.freezeMetadata();
    await expect(contract.setBaseURI("ipfs://other/")).to.be.revertedWith("Metadata frozen");
    expect(await contract.tokenURI(1)).to.equal(`${baseURI}1.json`);
  });

  it("pays owner immediately on mint", async () => {
    const { contract, owner, user } = await deployFixture();
    const before = await ethers.provider.getBalance(owner.address);
    await contract.connect(user).publicMint(1, [], { value: ethers.parseEther("0.01") });
    const after = await ethers.provider.getBalance(owner.address);
    expect(after - before).to.equal(ethers.parseEther("0.01"));
  });

  it("withdraw reverts when no ETH is held", async () => {
    const { contract } = await deployFixture();
    await expect(contract.withdraw()).to.be.revertedWith("No ETH to withdraw");
  });

  it("charges launchpad fee and pays recipient", async () => {
    const { contract, owner, user, other } = await deployFixture();
    await contract.setFeeRecipient(other.address);
    await contract.setLaunchpadFee(ethers.parseEther("0.005"));

    const ownerBefore = await ethers.provider.getBalance(owner.address);
    const recipientBefore = await ethers.provider.getBalance(other.address);

    await contract
      .connect(user)
      .publicMint(1, [], { value: ethers.parseEther("0.015") });

    const ownerAfter = await ethers.provider.getBalance(owner.address);
    const recipientAfter = await ethers.provider.getBalance(other.address);

    expect(ownerAfter - ownerBefore).to.equal(ethers.parseEther("0.01"));
    expect(recipientAfter - recipientBefore).to.equal(ethers.parseEther("0.005"));
  });
});
