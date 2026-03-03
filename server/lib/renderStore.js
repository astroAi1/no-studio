"use strict";

const fs = require("fs");
const path = require("path");

class RenderStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  ensureJobDir(jobId) {
    const dir = path.join(this.rootDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  resolveJobFile(jobId, fileName) {
    const safeName = path.basename(String(fileName || ""));
    if (!safeName || safeName !== fileName) return null;
    const candidate = path.resolve(this.rootDir, jobId, safeName);
    const root = path.resolve(this.rootDir, jobId);
    if (!candidate.startsWith(root + path.sep) && candidate !== root) return null;
    return candidate;
  }

  statJobFile(jobId, fileName) {
    const filePath = this.resolveJobFile(jobId, fileName);
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { filePath, stat };
  }
}

module.exports = {
  RenderStore,
};
