#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const distDir = path.join(appDir, "dist");
const webDir = path.join(appDir, "web");

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

function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  ensureDir(distDir);

  execFileSync("python3", [path.join(appDir, "scripts", "build-punk-atlas.py")], {
    stdio: "ignore",
  });

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

  copyDirContents(path.join(repoRoot, "assets", "fonts"), path.join(distDir, "fonts"));
  copyFile(path.join(repoRoot, "scripts", "trait_db.json"), path.join(distDir, "data", "trait_db.json"));
  copyFile(path.join(appDir, "static", "punks-atlas.png"), path.join(distDir, "data", "punks-atlas.png"));

  console.log("[No-Studio] Static build complete:", distDir);
}

main();
