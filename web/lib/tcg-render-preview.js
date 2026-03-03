export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

export function drawNoirCardPlaceholder(canvas, options = {}) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#090909");
  grad.addColorStop(1, "#020202");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const card = { x: 26, y: 26, w: w - 52, h: h - 52 };
  roundRect(ctx, card.x, card.y, card.w, card.h, 16, "#060606", "#1a1a1a", 4);
  roundRect(ctx, card.x + 14, card.y + 14, card.w - 28, card.h - 28, 12, null, "#101010", 2);

  const header = { x: card.x + 28, y: card.y + 28, w: card.w - 56, h: 62 };
  roundRect(ctx, header.x, header.y, header.w, header.h, 9, "#0b0b0b", "#202020", 2);
  roundRect(ctx, header.x + header.w - 150, header.y + 8, 142, header.h - 16, 8, "#070707", "#242424", 2);

  const art = { x: card.x + 40, y: header.y + header.h + 22, w: card.w - 80, h: 456 };
  const ag = ctx.createLinearGradient(art.x, art.y, art.x, art.y + art.h);
  ag.addColorStop(0, "#0c0c0c");
  ag.addColorStop(1, "#040404");
  roundRect(ctx, art.x, art.y, art.w, art.h, 12, ag, "#222", 3);
  roundRect(ctx, art.x + 10, art.y + 10, art.w - 20, art.h - 20, 9, null, "#1a1a1a", 1);

  for (let i = 0; i < 18; i += 1) {
    const x = art.x + ((i * 71) % art.w);
    ctx.strokeStyle = i % 2 ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.025)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 40, art.y + art.h);
    ctx.lineTo(x + 90, art.y);
    ctx.stroke();
  }

  if (options.sourceImage) {
    drawPunkPreview(ctx, options.sourceImage, art);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.font = '12px "GeistMono", monospace';
    ctx.textAlign = "center";
    ctx.fillText("TCG PREVIEW", art.x + (art.w / 2), art.y + (art.h / 2));
  }

  drawLabelBar(ctx, header.x + 18, header.y + 20, 320, 10);
  drawLabelBar(ctx, header.x + header.w - 136, header.y + 21, 64, 9);
  roundRect(ctx, art.x + art.w - 140, art.y + art.h - 42, 122, 28, 6, "#080808", "#2d2d2d", 2);

  const atk1 = { x: art.x, y: art.y + art.h + 24, w: art.w, h: 132 };
  const atk2 = { x: art.x, y: atk1.y + atk1.h + 14, w: art.w, h: 132 };
  for (const b of [atk1, atk2]) {
    roundRect(ctx, b.x, b.y, b.w, b.h, 10, "#080808", "#1d1d1d", 2);
    drawLabelBar(ctx, b.x + 18, b.y + 18, b.w - 180, 10);
    drawLabelBar(ctx, b.x + b.w - 120, b.y + 18, 84, 10);
    ctx.strokeStyle = "#1b1b1b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x + 18, b.y + 52);
    ctx.lineTo(b.x + b.w - 18, b.y + 52);
    ctx.stroke();
    drawLabelBar(ctx, b.x + 18, b.y + 70, b.w - 36, 8);
    drawLabelBar(ctx, b.x + 18, b.y + 92, Math.floor((b.w - 36) * 0.78), 8);
  }
}

function drawPunkPreview(ctx, img, art) {
  const side = Math.floor(Math.min(art.w, art.h) * 0.68);
  const x = art.x + Math.floor((art.w - side) / 2);
  const y = art.y + Math.floor((art.h - side) / 2) + 10;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  const rg = ctx.createRadialGradient(art.x + art.w / 2, art.y + art.h / 2, 30, art.x + art.w / 2, art.y + art.h / 2, art.w / 2);
  rg.addColorStop(0, "rgba(255,255,255,0.10)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(art.x + 10, art.y + 10, art.w - 20, art.h - 20);
  ctx.drawImage(img, x, y, side, side);
  ctx.restore();
}

function drawLabelBar(ctx, x, y, w, h) {
  ctx.fillStyle = "#222";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#2c2c2c";
  ctx.fillRect(x, y, Math.max(12, Math.floor(w * 0.38)), h);
}

function roundRect(ctx, x, y, w, h, r, fill, stroke, lineWidth = 1) {
  ctx.save();
  ctx.beginPath();
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
  ctx.restore();
}
