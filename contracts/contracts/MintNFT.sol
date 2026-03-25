// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "erc721a/contracts/ERC721A.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract MintNFT is ERC721A, Ownable, Pausable, ReentrancyGuard {
    using Address for address payable;

    uint256 public maxSupply;
    uint256 public mintPrice;
    uint256 public maxMintPerWallet;
    uint256 public launchpadFee;
    address public feeRecipient;

    string public baseURI;
    string public notRevealedURI;
    string public contractURI;

    bool public revealed;
    bool public transfersLocked;
    bool public metadataFrozen;

    struct Phase {
        string name;
        uint64 startTime;
        uint64 endTime;
        uint128 price;
        uint32 maxPerWallet;
        bool exists;
    }

    Phase[] public phases;
    mapping(uint256 => mapping(address => uint256)) public mintedPerPhase;
    mapping(uint256 => mapping(address => bool)) public phaseAllowlist;
    mapping(uint256 => bool) public phaseAllowlistEnabled;
    mapping(uint256 => bytes32) public phaseMerkleRoot;

    event TransfersLocked(bool locked);
    event PhaseCreated(uint256 indexed phaseId, string name, uint64 startTime, uint64 endTime, uint128 price, uint32 maxPerWallet);
    event PhaseUpdated(uint256 indexed phaseId, string name, uint64 startTime, uint64 endTime, uint128 price, uint32 maxPerWallet);
    event PhaseRemoved(uint256 indexed phaseId);
    event PhaseAllowlistEnabled(uint256 indexed phaseId, bool enabled);
    event PhaseAllowlistUpdated(uint256 indexed phaseId, uint256 count, bool allowed);
    event PhaseMerkleRootSet(uint256 indexed phaseId, bytes32 root);
    event LaunchpadFeeUpdated(uint256 fee);
    event FeeRecipientUpdated(address recipient);
    event MaxSupplyUpdated(uint256 newMaxSupply);
    event MetadataFrozen();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 maxSupply_,
        uint256 mintPrice_,
        uint256 maxMintPerWallet_,
        string memory baseURI_,
        string memory notRevealedURI_,
        string memory contractURI_
    ) ERC721A(name_, symbol_) {
        require(maxSupply_ > 0, "Max supply must be > 0");
        require(maxMintPerWallet_ > 0, "Max mint per wallet must be > 0");

        maxSupply = maxSupply_;
        mintPrice = mintPrice_;
        maxMintPerWallet = maxMintPerWallet_;

        baseURI = baseURI_;
        notRevealedURI = notRevealedURI_;
        contractURI = contractURI_;

        revealed = false;
        transfersLocked = true;
        metadataFrozen = false;
        feeRecipient = msg.sender;
    }

    function _startTokenId() internal pure override returns (uint256) {
        return 1;
    }

    function publicMint(uint256 quantity, bytes32[] calldata proof) external payable nonReentrant whenNotPaused {
        require(quantity > 0, "Quantity must be > 0");
        (bool active, uint256 phaseId) = getActivePhaseId();
        require(active, "No active phase");
        Phase storage phase = phases[phaseId];
        if (phaseAllowlistEnabled[phaseId]) {
            require(_isAllowlisted(phaseId, msg.sender, proof), "Not allowlisted");
        }
        require(totalSupply() + quantity <= maxSupply, "Max supply exceeded");
        require(
            mintedPerPhase[phaseId][msg.sender] + quantity <= phase.maxPerWallet,
            "Max mint per wallet exceeded"
        );
        uint256 totalPrice = uint256(phase.price) * quantity;
        uint256 totalFee = launchpadFee * quantity;
        require(msg.value == totalPrice + totalFee, "Incorrect ETH amount");

        mintedPerPhase[phaseId][msg.sender] += quantity;

        _safeMint(msg.sender, quantity);

        if (totalPrice > 0) {
            payable(owner()).sendValue(totalPrice);
        }
        if (totalFee > 0) {
            address recipient = feeRecipient;
            require(recipient != address(0), "Fee recipient not set");
            payable(recipient).sendValue(totalFee);
        }
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setBaseURI(string memory newBaseURI) external onlyOwner {
        require(!metadataFrozen, "Metadata frozen");
        baseURI = newBaseURI;
    }

    function setNotRevealedURI(string memory newNotRevealedURI) external onlyOwner {
        require(!metadataFrozen, "Metadata frozen");
        notRevealedURI = newNotRevealedURI;
    }

    function setContractURI(string memory newContractURI) external onlyOwner {
        require(!metadataFrozen, "Metadata frozen");
        contractURI = newContractURI;
    }

    function setRevealed(bool value) external onlyOwner {
        require(!metadataFrozen, "Metadata frozen");
        revealed = value;
    }

    function freezeMetadata() external onlyOwner {
        require(!metadataFrozen, "Metadata already frozen");
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function setTransfersLocked(bool locked) external onlyOwner {
        transfersLocked = locked;
        emit TransfersLocked(locked);
    }

    function setLaunchpadFee(uint256 feeWei) external onlyOwner {
        launchpadFee = feeWei;
        emit LaunchpadFeeUpdated(feeWei);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        require(recipient != address(0), "Zero recipient");
        feeRecipient = recipient;
        emit FeeRecipientUpdated(recipient);
    }

    function setMaxSupply(uint256 newMaxSupply) external onlyOwner {
        require(newMaxSupply >= totalSupply(), "Below total supply");
        require(newMaxSupply < maxSupply, "Must reduce");
        maxSupply = newMaxSupply;
        emit MaxSupplyUpdated(newMaxSupply);
    }

    function approve(address to, uint256 tokenId) public payable override {
        require(!transfersLocked, "Transfers locked");
        super.approve(to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) public override {
        require(!transfersLocked, "Transfers locked");
        super.setApprovalForAll(operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view override returns (bool) {
        if (transfersLocked) {
            return false;
        }
        return super.isApprovedForAll(owner, operator);
    }

    function getApproved(uint256 tokenId) public view override returns (address) {
        if (transfersLocked) {
            return address(0);
        }
        return super.getApproved(tokenId);
    }

    function phaseCount() external view returns (uint256) {
        return phases.length;
    }

    function addPhase(
        string memory name,
        uint64 startTime,
        uint64 endTime,
        uint128 price,
        uint32 maxPerWallet
    ) external onlyOwner {
        _addPhase(name, startTime, endTime, price, maxPerWallet);
    }

    function updatePhase(
        uint256 phaseId,
        string memory name,
        uint64 startTime,
        uint64 endTime,
        uint128 price,
        uint32 maxPerWallet
    ) external onlyOwner {
        require(_phaseExists(phaseId), "Phase not found");
        require(bytes(name).length > 0, "Name required");
        require(maxPerWallet > 0, "Max per wallet must be > 0");
        if (endTime > 0) {
            require(endTime > startTime, "End must be after start");
        }

        Phase storage phase = phases[phaseId];
        phase.name = name;
        phase.startTime = startTime;
        phase.endTime = endTime;
        phase.price = price;
        phase.maxPerWallet = maxPerWallet;

        emit PhaseUpdated(phaseId, name, startTime, endTime, price, maxPerWallet);
    }

    function removePhase(uint256 phaseId) external onlyOwner {
        require(_phaseExists(phaseId), "Phase not found");
        phases[phaseId].exists = false;
        emit PhaseRemoved(phaseId);
    }

    function setPhaseAllowlistEnabled(uint256 phaseId, bool enabled) external onlyOwner {
        require(_phaseExists(phaseId), "Phase not found");
        phaseAllowlistEnabled[phaseId] = enabled;
        emit PhaseAllowlistEnabled(phaseId, enabled);
    }

    function setPhaseAllowlist(
        uint256 phaseId,
        address[] calldata wallets,
        bool allowed
    ) external onlyOwner {
        require(_phaseExists(phaseId), "Phase not found");
        require(wallets.length > 0, "Wallets required");
        for (uint256 i = 0; i < wallets.length; i++) {
            address wallet = wallets[i];
            require(wallet != address(0), "Zero address");
            phaseAllowlist[phaseId][wallet] = allowed;
        }
        emit PhaseAllowlistUpdated(phaseId, wallets.length, allowed);
    }

    function setPhaseMerkleRoot(uint256 phaseId, bytes32 root) external onlyOwner {
        require(_phaseExists(phaseId), "Phase not found");
        phaseMerkleRoot[phaseId] = root;
        emit PhaseMerkleRootSet(phaseId, root);
    }

    function getActivePhaseId() public view returns (bool, uint256) {
        uint256 count = phases.length;
        for (uint256 i = 0; i < count; i++) {
            if (!_phaseExists(i)) continue;
            Phase storage phase = phases[i];
            if (phase.startTime > 0 && block.timestamp < phase.startTime) {
                continue;
            }
            if (phase.endTime > 0 && block.timestamp > phase.endTime) {
                continue;
            }
            return (true, i);
        }
        return (false, 0);
    }

    function getActivePhase()
        external
        view
        returns (
            bool active,
            uint256 phaseId,
            string memory name,
            uint256 price,
            uint256 maxPerWallet,
            uint64 startTime,
            uint64 endTime
        )
    {
        (active, phaseId) = getActivePhaseId();
        if (!active) {
            return (false, 0, "", 0, 0, 0, 0);
        }
        Phase storage phase = phases[phaseId];
        return (true, phaseId, phase.name, phase.price, phase.maxPerWallet, phase.startTime, phase.endTime);
    }

    function withdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        payable(owner()).sendValue(balance);
    }

    function withdrawableBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }

    function _phaseExists(uint256 phaseId) internal view returns (bool) {
        return phaseId < phases.length && phases[phaseId].exists;
    }

    function _isAllowlisted(
        uint256 phaseId,
        address wallet,
        bytes32[] calldata proof
    ) internal view returns (bool) {
        if (phaseAllowlist[phaseId][wallet]) {
            return true;
        }
        bytes32 root = phaseMerkleRoot[phaseId];
        if (root == bytes32(0)) {
            return false;
        }
        bytes32 leaf = keccak256(abi.encodePacked(wallet));
        return MerkleProof.verify(proof, root, leaf);
    }

    function _addPhase(
        string memory name,
        uint64 startTime,
        uint64 endTime,
        uint128 price,
        uint32 maxPerWallet
    ) internal returns (uint256) {
        require(bytes(name).length > 0, "Name required");
        require(maxPerWallet > 0, "Max per wallet must be > 0");
        if (endTime > 0) {
            require(endTime > startTime, "End must be after start");
        }

        phases.push(
            Phase({
                name: name,
                startTime: startTime,
                endTime: endTime,
                price: price,
                maxPerWallet: maxPerWallet,
                exists: true
            })
        );

        uint256 phaseId = phases.length - 1;
        emit PhaseCreated(phaseId, name, startTime, endTime, price, maxPerWallet);
        return phaseId;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) {
            revert URIQueryForNonexistentToken();
        }

        if (!revealed) {
            return notRevealedURI;
        }

        string memory base = _baseURI();
        return bytes(base).length != 0
            ? string(abi.encodePacked(base, _toString(tokenId), ".json"))
            : "";
    }

    function _beforeTokenTransfers(
        address from,
        address to,
        uint256 startTokenId,
        uint256 quantity
    ) internal override {
        super._beforeTokenTransfers(from, to, startTokenId, quantity);

        if (transfersLocked && from != address(0) && to != address(0)) {
            revert("Transfers locked");
        }
    }
}
