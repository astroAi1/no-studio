"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runPythonJsonWorker } = require("./pythonRunner");

class TcgPreviewRenderer {
  constructor({ appRoot, workerScriptPath, outputRoot }) {
    this.appRoot = appRoot;
    this.workerScriptPath = workerScriptPath;
    this.outputRoot = outputRoot;
    fs.mkdirSync(this.outputRoot, { recursive: true });
    this.allowed = new Map();
  }

  async render(card) {
    if (!card || typeof card !== "object") throw new Error("Missing TCG card payload");
    const stamp = Date.now();
    const suffix = crypto.randomBytes(3).toString("hex");
    const base = `tcg-${card.tokenId}-${stamp}-${suffix}`;
    const previewName = `${base}.png`;
    const jsonName = `${base}.json`;
    const promptName = `${base}.txt`;
    const previewPath = path.join(this.outputRoot, previewName);

    const result = await runPythonJsonWorker({
      workerScriptPath: this.workerScriptPath,
      cwd: this.appRoot,
      payload: {
        card,
        outPath: previewPath,
      },
      timeoutMs: 60_000,
    });

    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || "TCG preview render failed");
    }

    this.allowed.set(previewName, previewPath);
    return {
      previewName,
      previewPath,
      jsonName,
      promptName,
      width: Number(result.width) || 1024,
      height: Number(result.height) || 1432,
    };
  }

  rememberFile(fileName, filePath) {
    this.allowed.set(path.basename(fileName), filePath);
  }

  resolveFile(fileName) {
    const safeName = path.basename(String(fileName || ""));
    if (!safeName || safeName !== fileName) return null;
    const filePath = this.allowed.get(safeName);
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { filePath, stat, fileName: safeName };
  }
}

module.exports = {
  TcgPreviewRenderer,
};
