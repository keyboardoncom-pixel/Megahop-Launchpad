import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const rawLayerCache = new Map();

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cleanLabel(value) {
  return value
    .replace(/\.png$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function emptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function getNormalizedRawLayer(filePath, width, height) {
  const cacheKey = `${filePath}:${width}x${height}`;
  if (rawLayerCache.has(cacheKey)) {
    return rawLayerCache.get(cacheKey);
  }

  const rawBuffer = await sharp(filePath)
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer();
  rawLayerCache.set(cacheKey, rawBuffer);
  return rawBuffer;
}

async function getDirectories(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function resolveLayerDirectory(sourceDir, layerName) {
  const target = layerName.trim().toLowerCase();
  const dirs = await getDirectories(sourceDir);
  const match = dirs.find((dir) => dir.trim().toLowerCase() === target);
  if (!match) {
    throw new Error(`Layer directory not found for "${layerName}" in ${sourceDir}`);
  }
  return path.join(sourceDir, match);
}

async function loadLayerItems(sourceDir, layerName) {
  const layerDir = await resolveLayerDirectory(sourceDir, layerName);
  const entries = await fs.readdir(layerDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => ({
      fileName: entry.name,
      filePath: path.join(layerDir, entry.name),
      value: cleanLabel(entry.name),
    }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, "en"));

  if (!files.length) {
    throw new Error(`No PNG files in layer directory ${layerDir}`);
  }

  return {
    traitType: cleanLabel(layerName),
    files,
  };
}

function toAttributes(combo, traits) {
  return combo.map((pickedIndex, idx) => ({
    trait_type: traits[idx].traitType,
    value: traits[idx].files[pickedIndex].value,
  }));
}

function pickUniqueCombinations(traits, totalSupply, rand) {
  const maxUnique = traits.reduce((acc, trait) => acc * trait.files.length, 1);
  if (totalSupply > maxUnique) {
    throw new Error(
      `Requested totalSupply=${totalSupply} exceeds max unique combinations=${maxUnique}`
    );
  }

  const combinations = [];
  const seen = new Set();
  let guard = 0;
  const maxAttempts = totalSupply * 1000;

  while (combinations.length < totalSupply) {
    guard += 1;
    if (guard > maxAttempts) {
      throw new Error("Failed to generate enough unique combinations");
    }

    const picks = traits.map((trait) => Math.floor(rand() * trait.files.length));
    const key = picks.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    combinations.push(picks);
  }

  return combinations;
}

async function composeImage(outputPath, combo, traits) {
  const basePath = traits[0].files[combo[0]].filePath;
  const baseMetadata = await sharp(basePath).metadata();
  const baseWidth = baseMetadata.width || 1024;
  const baseHeight = baseMetadata.height || 1024;
  let current = await sharp({
    create: {
      width: baseWidth,
      height: baseHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .raw()
    .toBuffer();
  for (let i = 0; i < combo.length; i += 1) {
    const layerBuffer = await getNormalizedRawLayer(
      traits[i].files[combo[i]].filePath,
      baseWidth,
      baseHeight
    );
    current = await sharp(current, {
      raw: { width: baseWidth, height: baseHeight, channels: 4 },
    })
      .composite([
        {
          input: layerBuffer,
          raw: { width: baseWidth, height: baseHeight, channels: 4 },
          left: 0,
          top: 0,
        },
      ])
      .raw()
      .toBuffer();
  }
  await sharp(current, {
    raw: { width: baseWidth, height: baseHeight, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

async function composeImageWithTargetSize(outputPath, combo, traits, options) {
  const basePath = traits[0].files[combo[0]].filePath;
  const baseMetadata = await sharp(basePath).metadata();
  const baseWidth = baseMetadata.width || 1024;
  const baseHeight = baseMetadata.height || 1024;
  let current = await sharp({
    create: {
      width: baseWidth,
      height: baseHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .raw()
    .toBuffer();
  for (let i = 0; i < combo.length; i += 1) {
    const layerBuffer = await getNormalizedRawLayer(
      traits[i].files[combo[i]].filePath,
      baseWidth,
      baseHeight
    );
    current = await sharp(current, {
      raw: { width: baseWidth, height: baseHeight, channels: 4 },
    })
      .composite([
        {
          input: layerBuffer,
          raw: { width: baseWidth, height: baseHeight, channels: 4 },
          left: 0,
          top: 0,
        },
      ])
      .raw()
      .toBuffer();
  }

  const maxImageSizeKb = Math.max(0, Number(options?.maxImageSizeKb) || 0);
  if (!maxImageSizeKb) {
    await composeImage(outputPath, combo, traits);
    const stats = await fs.stat(outputPath);
    return { sizeBytes: stats.size, width: null, quality: null };
  }

  const resizeWidths =
    Array.isArray(options?.resizeWidths) && options.resizeWidths.length
      ? options.resizeWidths
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0)
      : [1024, 896, 768, 640, 512];
  const pngQualitySteps =
    Array.isArray(options?.pngQualitySteps) && options.pngQualitySteps.length
      ? options.pngQualitySteps
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0 && value <= 100)
      : [90, 82, 74, 66, 58, 50];

  let bestBuffer = null;
  let bestAttempt = null;

  for (const width of resizeWidths) {
    for (const quality of pngQualitySteps) {
      const buffer = await sharp(current, {
        raw: { width: baseWidth, height: baseHeight, channels: 4 },
      })
        .resize(width, width, { fit: "fill" })
        .png({
          compressionLevel: 9,
          effort: 10,
          adaptiveFiltering: true,
          palette: true,
          quality,
          colors: 256,
          dither: 0.8,
        })
        .toBuffer();

      const sizeBytes = buffer.byteLength;
      if (!bestBuffer || sizeBytes < bestBuffer.byteLength) {
        bestBuffer = buffer;
        bestAttempt = { sizeBytes, width, quality };
      }

      if (sizeBytes <= maxImageSizeKb * 1024) {
        await fs.writeFile(outputPath, buffer);
        return { sizeBytes, width, quality };
      }
    }
  }

  await fs.writeFile(outputPath, bestBuffer);
  return bestAttempt;
}

async function writeJson(filePath, content) {
  await fs.writeFile(filePath, JSON.stringify(content, null, 2));
}

async function main() {
  const configPath = path.resolve("config.json");
  if (!(await fileExists(configPath))) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  const configRaw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(configRaw);
  const {
    sourceDir,
    outputDir,
    totalSupply,
    collectionName,
    description,
    imageBaseUri,
    externalUrl,
    sellerFeeBasisPoints,
    feeRecipient,
    seed,
    layers,
    maxImageSizeKb,
    resizeWidths,
    pngQualitySteps,
  } = config;

  if (!sourceDir || !outputDir || !totalSupply || !collectionName || !description || !layers?.length) {
    throw new Error("Invalid config.json. Required: sourceDir, outputDir, totalSupply, collectionName, description, layers");
  }

  const imagesDir = path.join(outputDir, "images");
  const metadataDir = path.join(outputDir, "metadata");
  await emptyDir(imagesDir);
  await emptyDir(metadataDir);

  const traits = [];
  for (const layerName of layers) {
    const trait = await loadLayerItems(sourceDir, layerName);
    traits.push(trait);
  }

  const rand = mulberry32(Number(seed) || Date.now());
  const combos = pickUniqueCombinations(traits, Number(totalSupply), rand);

  for (let tokenId = 1; tokenId <= combos.length; tokenId += 1) {
    const combo = combos[tokenId - 1];
    const imageOut = path.join(imagesDir, `${tokenId}.png`);
    await composeImageWithTargetSize(imageOut, combo, traits, {
      maxImageSizeKb,
      resizeWidths,
      pngQualitySteps,
    });

    const attributes = toAttributes(combo, traits);
    const metadata = {
      name: `${collectionName} #${tokenId}`,
      description,
      image: `${imageBaseUri}${tokenId}.png`,
      attributes,
    };
    if (externalUrl && String(externalUrl).trim()) {
      metadata.external_url = String(externalUrl).trim();
    }

    await writeJson(path.join(metadataDir, `${tokenId}.json`), metadata);

    if (tokenId % 100 === 0 || tokenId === combos.length) {
      console.log(`Generated ${tokenId}/${combos.length}`);
    }
  }

  const contractMetadata = {
    name: collectionName,
    description,
    image: `${imageBaseUri}collection.png`,
    seller_fee_basis_points: Number(sellerFeeBasisPoints) || 0,
    fee_recipient: feeRecipient || "0x0000000000000000000000000000000000000000",
  };

  if (externalUrl && String(externalUrl).trim()) {
    contractMetadata.external_link = String(externalUrl).trim();
  }

  await writeJson(path.join(outputDir, "contract.json"), contractMetadata);
  await writeJson(path.join(outputDir, "mint-plan.json"), {
    generatedAt: new Date().toISOString(),
    totalSupply: combos.length,
    sourceDir,
    outputDir,
    layers: traits.map((trait) => ({
      traitType: trait.traitType,
      count: trait.files.length,
    })),
    imageBaseUri,
    seed,
    maxImageSizeKb,
    resizeWidths,
    pngQualitySteps,
  });

  console.log("Done.");
  console.log(`Images: ${imagesDir}`);
  console.log(`Metadata: ${metadataDir}`);
  console.log(`Contract metadata: ${path.join(outputDir, "contract.json")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
