"use strict";

const crypto = require("crypto");
const path = require("path");

class GifJobService {
  constructor({ appRoot, renderStore, workerScriptPath, runWorker }) {
    this.appRoot = appRoot;
    this.renderStore = renderStore;
    this.workerScriptPath = workerScriptPath;
    this.runWorker = runWorker;
    this.jobs = new Map();
    this.queue = Promise.resolve();
  }

  createJob(spec) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const outDir = this.renderStore.ensureJobDir(id);

    const job = {
      id,
      styleId: spec.styleId,
      tokenIds: [...spec.tokenIds],
      seed: spec.seed ?? null,
      size: 1024,
      options: spec.options || {},
      status: "queued",
      stage: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      error: null,
      logs: [],
      files: null,
      outDir,
    };

    this.jobs.set(id, job);
    this.queue = this.queue
      .then(() => this.#runJob(job))
      .catch((error) => {
        // Keep queue alive even if one job fails unexpectedly.
        job.status = "failed";
        job.stage = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = error && error.message ? error.message : "Unexpected GIF job error";
      });

    return this.#publicJob(job);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return this.#publicJob(job);
  }

  resolveServableFile(jobId, fileName) {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "ready" || !Array.isArray(job.files)) return null;
    const match = job.files.find((file) => file.name === fileName);
    if (!match) return null;
    const statInfo = this.renderStore.statJobFile(jobId, fileName);
    if (!statInfo) return null;
    return { job, file: match, filePath: statInfo.filePath, stat: statInfo.stat };
  }

  async #runJob(job) {
    job.status = "running";
    job.stage = "rendering";
    job.startedAt = new Date().toISOString();

    const workerResult = await this.runWorker({
      workerScriptPath: this.workerScriptPath,
      cwd: this.appRoot,
      payload: {
        styleId: job.styleId,
        tokenIds: job.tokenIds,
        seed: job.seed,
        size: 1024,
        outDir: job.outDir,
      },
    });

    if (!workerResult || workerResult.ok !== true) {
      throw new Error((workerResult && workerResult.error) || "GIF worker failed");
    }

    job.stage = "optimizing";
    if (Array.isArray(workerResult.logs)) {
      job.logs = workerResult.logs.slice(-40);
    }

    const files = [];
    for (const file of workerResult.files || []) {
      const fileName = path.basename(String(file.name || ""));
      const statInfo = this.renderStore.statJobFile(job.id, fileName);
      if (!statInfo) continue;
      files.push({
        name: fileName,
        kind: file.kind === "png" ? "png" : "gif",
        bytes: Number(file.bytes) || statInfo.stat.size,
        width: 1024,
        height: 1024,
        url: `/api/gif/files/${job.id}/${encodeURIComponent(fileName)}`,
      });
    }

    if (!files.length) {
      throw new Error("GIF worker did not produce downloadable files");
    }

    job.files = files;
    job.status = "ready";
    job.stage = "ready";
    job.finishedAt = new Date().toISOString();
  }

  #publicJob(job) {
    return {
      id: job.id,
      styleId: job.styleId,
      tokenIds: [...job.tokenIds],
      size: job.size,
      seed: job.seed,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      logs: Array.isArray(job.logs) ? [...job.logs] : [],
      files: job.files ? job.files.map((file) => ({ ...file })) : null,
    };
  }
}

module.exports = {
  GifJobService,
};
