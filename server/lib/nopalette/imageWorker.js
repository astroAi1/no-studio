"use strict";

const { spawn } = require("child_process");

function runNoPaletteWorker(workerScriptPath, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [workerScriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `No-Palette worker exited with code ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (!parsed || parsed.ok === false) {
          return reject(new Error((parsed && parsed.error) || "No-Palette worker failed"));
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Invalid No-Palette worker JSON: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(payload || {}));
    child.stdin.end();
  });
}

async function inspectNoPunkImage({ workerScriptPath, inputPath }) {
  return runNoPaletteWorker(workerScriptPath, {
    command: "inspect",
    inputPath,
  });
}

async function renderNoPaletteImage({ workerScriptPath, inputPath, outputPath, size, mapping, roles, rgba24Bytes }) {
  return runNoPaletteWorker(workerScriptPath, {
    command: "render",
    inputPath,
    outputPath,
    size,
    mapping,
    roles,
    rgba24B64: Buffer.isBuffer(rgba24Bytes) ? rgba24Bytes.toString("base64") : undefined,
  });
}

async function renderNoPaletteGrid({ workerScriptPath, outputPath, cellSize, columns, rows, frames }) {
  return runNoPaletteWorker(workerScriptPath, {
    command: "render_grid",
    outputPath,
    cellSize,
    columns,
    rows,
    frames: (frames || []).map((frame) => (Buffer.isBuffer(frame) ? frame.toString("base64") : String(frame || ""))),
  });
}

async function renderNoPaletteNoiseGif({ workerScriptPath, outputPath, size, rgba24Bytes, noiseMask, grain, frames, durationMs }) {
  return runNoPaletteWorker(workerScriptPath, {
    command: "render_noise_gif",
    outputPath,
    size,
    frames,
    durationMs,
    rgba24B64: Buffer.isBuffer(rgba24Bytes) ? rgba24Bytes.toString("base64") : String(rgba24Bytes || ""),
    noiseMask: Array.isArray(noiseMask) ? noiseMask : [],
    grain: grain || {},
  });
}

module.exports = {
  inspectNoPunkImage,
  renderNoPaletteGrid,
  renderNoPaletteImage,
  renderNoPaletteNoiseGif,
};
