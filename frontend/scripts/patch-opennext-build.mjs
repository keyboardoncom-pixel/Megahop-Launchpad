import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const openNextDir = path.join(rootDir, ".open-next");

const targets = [
  path.join(openNextDir, "server-functions", "default", "index.mjs"),
  path.join(openNextDir, "server-functions", "default", "handler.mjs"),
];

const sourceSnippet = 'function setNextjsServerWorkingDirectory(){process.chdir("")}';
const replacementSnippet =
  'function setNextjsServerWorkingDirectory(){if(globalThis.monorepoPackagePath){process.chdir(globalThis.monorepoPackagePath)}}';

let patchedFiles = 0;

for (const filePath of targets) {
  if (!fs.existsSync(filePath)) {
    continue;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  if (!contents.includes(sourceSnippet)) {
    continue;
  }

  fs.writeFileSync(
    filePath,
    contents.replace(sourceSnippet, replacementSnippet),
    "utf8",
  );
  patchedFiles += 1;
}

if (patchedFiles === 0) {
  console.warn("No OpenNext worker files needed patching.");
} else {
  console.log(`Patched ${patchedFiles} OpenNext worker file(s).`);
}
