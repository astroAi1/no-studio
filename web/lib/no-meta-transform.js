import { tone2FromBackground } from "./palette.js";

export const PIXEL_SIZE = 24;

export function drawSourceOnBlack(ctx, img, offscreenCanvas) {
  const offCtx = offscreenCanvas.getContext("2d", { willReadFrequently: true });
  offCtx.imageSmoothingEnabled = false;
  offCtx.clearRect(0, 0, PIXEL_SIZE, PIXEL_SIZE);
  offCtx.drawImage(img, 0, 0, PIXEL_SIZE, PIXEL_SIZE);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(offscreenCanvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  return offCtx.getImageData(0, 0, PIXEL_SIZE, PIXEL_SIZE);
}

export function applyNoMetaTwoToneMask(imageData, background) {
  const tone2 = tone2FromBackground(background);
  const out = new ImageData(imageData.width, imageData.height);
  const src = imageData.data;
  const dst = out.data;
  for (let i = 0; i < src.length; i += 4) {
    const visible = src[i + 3] > 0;
    const tone = visible ? tone2 : background;
    dst[i] = tone.r;
    dst[i + 1] = tone.g;
    dst[i + 2] = tone.b;
    dst[i + 3] = 255;
  }
  return out;
}

export function imageDataToCanvas(imageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function drawNearestScaled(ctx, sourceCanvas) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(sourceCanvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}
