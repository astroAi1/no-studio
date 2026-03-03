"use strict";

const { spawn } = require("child_process");

function runPythonJsonWorker({ pythonExec = "python3", workerScriptPath, payload, cwd, timeoutMs = 10 * 60 * 1000, extraEnv = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExec, [workerScriptPath], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("GIF worker timed out"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(new Error(`GIF worker exited with code ${code}\n${stderr || stdout}`.trim()));
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        return reject(new Error("GIF worker returned empty output"));
      }

      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return reject(new Error(`GIF worker returned invalid JSON\n${trimmed}`));
      }

      resolve({
        ...parsed,
        _stderr: stderr,
      });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

function runPythonGifWorker({ pythonExec = "python3", workerScriptPath, payload, cwd, timeoutMs = 10 * 60 * 1000 }) {
  return runPythonJsonWorker({
    pythonExec,
    workerScriptPath,
    payload,
    cwd,
    timeoutMs,
    extraEnv: {
      NOPUNKS_GIF_SIZE: "1024",
    },
  });
}

module.exports = {
  runPythonJsonWorker,
  runPythonGifWorker,
};
