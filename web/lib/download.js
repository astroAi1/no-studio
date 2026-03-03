export function triggerDownload(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
}

export function exportCanvasPng(canvas, fileName) {
  triggerDownload(canvas.toDataURL("image/png"), fileName);
}

export function buildExportCanvasFromPixelCanvas(pixelCanvas, backgroundHex, size = 1024) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = backgroundHex || "#000000";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(pixelCanvas, 0, 0, size, size);
  return canvas;
}
