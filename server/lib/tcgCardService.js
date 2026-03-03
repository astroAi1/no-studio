"use strict";

const fs = require("fs");
const path = require("path");
const { buildTcgCardSpec } = require("./tcgCardBuilder");
const { buildTcgPromptText } = require("./tcgPromptBuilder");
const { getPublicTypeGuides } = require("./tcgTypeGuides");
const { RARITY_BRACKETS } = require("./tcgRarity");

class TcgCardService {
  constructor({ outputRoot, previewRenderer }) {
    this.outputRoot = outputRoot;
    this.previewRenderer = previewRenderer;
    fs.mkdirSync(this.outputRoot, { recursive: true });
  }

  getConfig() {
    return {
      rarityBrackets: RARITY_BRACKETS.map((b) => ({ min: b.min, max: b.max, rarity: b.rarity })),
      typeGuides: getPublicTypeGuides(),
      output: {
        preview: { width: 1024, height: 1432, format: "png" },
        metadata: ["json", "txt"],
      },
      rendererVersion: "tcg-dbz-locked-v1",
    };
  }

  async forgeCard(record, options = {}) {
    const card = buildTcgCardSpec(record, options);
    const promptText = buildTcgPromptText(card);
    const render = await this.previewRenderer.render(card);

    const publicCard = this.#stripInternal(card);
    const jsonPath = path.join(this.outputRoot, render.jsonName);
    const txtPath = path.join(this.outputRoot, render.promptName);

    fs.writeFileSync(jsonPath, JSON.stringify(publicCard, null, 2), "utf8");
    fs.writeFileSync(txtPath, promptText, "utf8");

    this.previewRenderer.rememberFile(render.jsonName, jsonPath);
    this.previewRenderer.rememberFile(render.promptName, txtPath);

    return {
      card: publicCard,
      promptText,
      preview: {
        fileName: render.previewName,
        url: `/api/tcg/files/${encodeURIComponent(render.previewName)}`,
        width: render.width,
        height: render.height,
      },
      exports: {
        jsonFileName: render.jsonName,
        promptFileName: render.promptName,
        jsonUrl: `/api/tcg/files/${encodeURIComponent(render.jsonName)}?download=1`,
        promptUrl: `/api/tcg/files/${encodeURIComponent(render.promptName)}?download=1`,
        previewUrl: `/api/tcg/files/${encodeURIComponent(render.previewName)}?download=1`,
      },
    };
  }

  resolveFile(fileName) {
    return this.previewRenderer.resolveFile(fileName);
  }

  #stripInternal(card) {
    const clone = JSON.parse(JSON.stringify(card));
    delete clone._internal;
    return clone;
  }
}

module.exports = {
  TcgCardService,
};
