#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");
const distDir = path.join(appDir, "dist");
const webDir = path.join(appDir, "web");

const REQUIRED_STATIC_ASSETS = [
  path.join(webDir, "data", "trait_db.json"),
  path.join(webDir, "data", "punks-atlas.png"),
  path.join(webDir, "fonts", "GeistMono-Regular.otf"),
  path.join(webDir, "fonts", "GeistMono-Medium.otf"),
  path.join(webDir, "fonts", "GeistMono-Bold.otf"),
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirContents(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFile(srcPath, destPath);
    }
  }
}

function assertBundledStaticAssets() {
  const missing = REQUIRED_STATIC_ASSETS.filter((filePath) => !fs.existsSync(filePath));
  if (!missing.length) {
    return;
  }
  const rel = missing.map((filePath) => path.relative(appDir, filePath)).join(", ");
  throw new Error(
    `[No-Studio] Missing bundled static assets: ${rel}. ` +
    "This repo now expects the Vercel build to be self-contained. Commit the web/data and web/fonts assets before deploying.",
  );
}

function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  ensureDir(distDir);
  assertBundledStaticAssets();

  copyDirContents(webDir, distDir);

  const indexSrc = path.join(webDir, "index.html");
  copyFile(indexSrc, path.join(distDir, "404.html"));

  const routeAliases = [
    "tools/no-studio",
    "tools/no-palette",
    "tools/no-generate",
    "tools/gif-lab",
    "tools/tcg-forge",
  ];

  for (const routePath of routeAliases) {
    copyFile(indexSrc, path.join(distDir, routePath, "index.html"));
  }

  console.log("[No-Studio] Static build complete:", distDir);
}

main();
