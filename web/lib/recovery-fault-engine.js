const TAU = Math.PI * 2;

function mulberry32(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let z = Math.imul(state ^ (state >>> 15), 1 | state);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - (2 * t));
}

function band(t, start, end, feather = 0.04) {
  if (end < start) {
    return Math.max(band(t, start, 1, feather), band(t, 0, end, feather));
  }
  const rise = smoothstep(start - feather, start + feather, t);
  const fall = 1 - smoothstep(end - feather, end + feather, t);
  return clamp(rise * fall, 0, 1);
}

function hexToRgb(hex) {
  const raw = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return { r: 0, g: 0, b: 0 };
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function rgba(hex, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function createBufferCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, dpr };
}

function buildScene(featurePack) {
  const render = featurePack?.render || {};
  const scaffold = featurePack?.scaffold || {};
  const palette = featurePack?.palette || {};
  const points = Array.isArray(scaffold.points) ? scaffold.points : [];
  const rows = Array.isArray(scaffold.rowWeights) ? scaffold.rowWeights : [];
  const cols = Array.isArray(scaffold.colWeights) ? scaffold.colWeights : [];
  const centroid = scaffold.centroid || { nx: 0.5, ny: 0.5 };
  const bbox = scaffold.bbox || { width: 12, height: 12 };
  const seeds = render.seedStreams || {};
  const rngComp = mulberry32(seeds.composition || 1);
  const rngMotion = mulberry32(seeds.motion || 2);
  const rngCorrupt = mulberry32(seeds.corruption || 3);

  const focus = render.focus || { x: 0.5, y: 0.5 };
  const scaffoldScale = 340 + (render.overflowPressure || 50) * 2.4;
  const aspectX = 0.72 + ((bbox.width || 12) / 24) * 0.9;
  const aspectY = 0.72 + ((bbox.height || 12) / 24) * 0.9;

  const fragments = points.map((point, index) => {
    const px = (point.nx - centroid.nx) * scaffoldScale * aspectX;
    const py = (point.ny - centroid.ny) * scaffoldScale * aspectY;
    const size = 4 + (rngComp() * 14);
    const length = 12 + (rngComp() * 44);
    const phase = rngMotion() * TAU;
    const drift = 6 + (rngMotion() * 38);
    const rotation = rngComp() * TAU;
    const color = point.luminance > 0.2
      ? palette.accent || "#ffffff"
      : palette.structure?.[index % Math.max(1, palette.structure?.length || 1)] || "#7f8a9b";
    return {
      px,
      py,
      size,
      length,
      phase,
      drift,
      rotation,
      color,
      point,
      index,
    };
  });

  const hotRows = [...rows]
    .filter((row) => (row?.count || 0) > 0)
    .sort((a, b) => (b.weight - a.weight) || (b.count - a.count))
    .slice(0, 8);

  const hotCols = [...cols]
    .filter((col) => (col?.count || 0) > 0)
    .sort((a, b) => (b.weight - a.weight) || (b.count - a.count))
    .slice(0, 8);

  const rails = [];
  const railTotal = clamp(Number(render.packetRailCount) || 4, 2, 12);
  for (let i = 0; i < railTotal; i += 1) {
    const vertical = i % 2 === 0;
    const source = vertical ? hotCols[i % Math.max(1, hotCols.length)] : hotRows[i % Math.max(1, hotRows.length)];
    const anchor = source ? (source.index / 23) : rngComp();
    rails.push({
      vertical,
      anchor,
      width: 2 + Math.floor(rngComp() * 4),
      speed: 0.35 + (rngMotion() * 0.95),
      phase: rngMotion() * TAU,
      offset: ((rngComp() * 2) - 1) * 0.08,
    });
  }

  const swarmCount = clamp(Number(render.grainField) || 180, 120, 420);
  const swarm = Array.from({ length: swarmCount }, (_, index) => {
    const point = fragments[index % Math.max(1, fragments.length)] || {
      px: 0,
      py: 0,
      point: { nx: rngComp(), ny: rngComp() },
    };
    return {
      px: point.px,
      py: point.py,
      rx: 10 + (rngMotion() * 80),
      ry: 6 + (rngMotion() * 44),
      phase: rngMotion() * TAU,
      speed: 0.6 + (rngMotion() * 2.2),
      size: 0.8 + (rngComp() * 2.4),
      brightness: 0.12 + (rngComp() * 0.45),
      hueBias: index % 4,
    };
  });

  const corruptionBands = Array.from({ length: clamp(Number(render.corruptionZones) || 3, 2, 5) }, () => ({
    y: rngCorrupt(),
    h: 0.04 + (rngCorrupt() * 0.11),
    phase: rngCorrupt() * TAU,
    amplitude: 8 + (rngCorrupt() * 44),
  }));

  return {
    featurePack,
    palette,
    render,
    focus,
    fragments,
    rails,
    swarm,
    hotRows,
    hotCols,
    corruptionBands,
    ghostCopies: clamp(Number(render.ghostCopies) || 2, 1, 5),
    loopMs: clamp(Number(render.loopMs) || 5200, 2400, 8000),
  };
}

function paintGround(ctx, width, height, scene, phaseState) {
  const { palette } = scene;
  ctx.fillStyle = palette.ground || "#050608";
  ctx.fillRect(0, 0, width, height);

  const wash = ctx.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, rgba(palette.structure?.[0] || "#1e2630", 0.18));
  wash.addColorStop(0.45, rgba(palette.void || "#020304", 0.0));
  wash.addColorStop(1, rgba(palette.structure?.[2] || palette.structure?.[1] || "#3c4452", 0.2));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(
    width * scene.focus.x,
    height * scene.focus.y,
    0,
    width * scene.focus.x,
    height * scene.focus.y,
    Math.max(width, height) * (0.42 + (phaseState.align * 0.08))
  );
  glow.addColorStop(0, rgba(palette.structure?.[1] || "#556273", 0.18 + (phaseState.repair * 0.08)));
  glow.addColorStop(1, rgba(palette.ground || "#050608", 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

function paintMacroField(ctx, width, height, scene, phaseState) {
  const { palette, hotRows, hotCols } = scene;
  const focusX = width * scene.focus.x;
  const focusY = height * scene.focus.y;

  ctx.save();
  ctx.globalCompositeOperation = "screen";

  hotCols.forEach((col, index) => {
    const x = focusX + ((col.index / 23) - 0.5) * width * 0.74;
    const w = 6 + (col.weight * 22);
    ctx.fillStyle = rgba(palette.structure?.[index % Math.max(1, palette.structure?.length || 1)] || "#47515f", 0.11 + (col.weight * 0.08));
    ctx.fillRect(x - (w / 2), 0, w, height);
  });

  hotRows.forEach((row, index) => {
    const y = focusY + ((row.index / 23) - 0.5) * height * 0.74;
    const h = 4 + (row.weight * 18);
    ctx.fillStyle = rgba(palette.structure?.[(index + 1) % Math.max(1, palette.structure?.length || 1)] || "#47515f", 0.08 + (row.weight * 0.06));
    ctx.fillRect(0, y - (h / 2), width, h);
  });

  const orbitCount = 3;
  for (let i = 0; i < orbitCount; i += 1) {
    const radius = width * (0.12 + (i * 0.06)) * (1 + (phaseState.overflow * 0.12));
    ctx.strokeStyle = rgba(palette.structure?.[i % Math.max(1, palette.structure?.length || 1)] || "#57606f", 0.12 + (phaseState.align * 0.08));
    ctx.lineWidth = 1 + i;
    ctx.setLineDash([2 + (i * 2), 8 + (i * 4)]);
    ctx.beginPath();
    ctx.arc(focusX, focusY, radius, 0, TAU);
    ctx.stroke();
  }

  ctx.restore();
}

function paintFragments(ctx, width, height, scene, phaseState, t01) {
  const { palette, fragments } = scene;
  const focusX = width * scene.focus.x;
  const focusY = height * scene.focus.y;
  const repairPull = 1 - (phaseState.overflow * 0.6);
  const rollbackKick = phaseState.rollback * 28;
  const collapse = phaseState.overflow * 42;

  ctx.save();
  for (const fragment of fragments) {
    const orbit = Math.sin((t01 * TAU * 2) + fragment.phase) * fragment.drift;
    const shear = Math.cos((t01 * TAU) + fragment.phase) * fragment.drift * 0.6;
    const x = focusX + (fragment.px * repairPull) + orbit + (phaseState.rollback * fragment.px * 0.08);
    const y = focusY + (fragment.py * repairPull) + shear;
    const w = fragment.length + (phaseState.align * 16) - collapse;
    const h = fragment.size + (phaseState.repair * 4);
    const rotation = fragment.rotation + (Math.sin((t01 * TAU) + fragment.phase) * 0.5) + (phaseState.rollback * 0.8);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.fillStyle = rgba(fragment.color, 0.24 + (phaseState.repair * 0.28));
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = rgba(palette.structure?.[1] || "#8390a0", 0.28 + (phaseState.align * 0.16));
    ctx.lineWidth = 1;
    ctx.strokeRect((-w / 2) + rollbackKick * 0.02, -h / 2, Math.max(2, w * 0.72), h);
    ctx.restore();
  }
  ctx.restore();
}

function paintRepairSwarm(ctx, width, height, scene, phaseState, t01) {
  const { palette, swarm } = scene;
  const focusX = width * scene.focus.x;
  const focusY = height * scene.focus.y;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const particle of swarm) {
    const x = focusX + particle.px + Math.cos((t01 * TAU * particle.speed) + particle.phase) * particle.rx;
    const y = focusY + particle.py + Math.sin((t01 * TAU * (particle.speed * 0.8)) + particle.phase) * particle.ry;
    const size = particle.size * (1 + (phaseState.repair * 0.4));
    const alpha = particle.brightness * (0.55 + (phaseState.repair * 0.85));
    const color = particle.hueBias % 3 === 0
      ? palette.accent
      : particle.hueBias % 3 === 1
        ? palette.corruption
        : palette.structure?.[2] || palette.structure?.[1] || palette.accent;
    ctx.fillStyle = rgba(color, alpha);
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

function paintGhosts(ctx, width, height, scene, phaseState, t01) {
  const { palette, fragments, ghostCopies } = scene;
  const focusX = width * scene.focus.x;
  const focusY = height * scene.focus.y;
  const ghostAlpha = 0.08 + (phaseState.rollback * 0.18) + (phaseState.overflow * 0.1);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let copy = 1; copy <= ghostCopies; copy += 1) {
    const shiftX = (copy * 16) * Math.cos((t01 * TAU) + (copy * 0.8));
    const shiftY = (copy * 12) * Math.sin((t01 * TAU * 1.2) + (copy * 0.9));
    ctx.strokeStyle = rgba(copy % 2 === 0 ? palette.corruption : palette.accent, ghostAlpha / copy);
    ctx.lineWidth = Math.max(1, 3 - copy);
    ctx.beginPath();
    fragments.forEach((fragment, index) => {
      const x = focusX + fragment.px + shiftX;
      const y = focusY + fragment.py + shiftY;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }
  ctx.restore();
}

function paintRails(ctx, width, height, scene, phaseState, t01) {
  const { palette, rails } = scene;
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  rails.forEach((rail, index) => {
    const alpha = 0.18 + (phaseState.align * 0.12) + (phaseState.overflow * 0.18);
    const pulse = ((t01 * rail.speed) + (rail.phase / TAU)) % 1;
    const position = rail.anchor + rail.offset + (Math.sin((t01 * TAU) + rail.phase) * 0.025);
    ctx.strokeStyle = rgba(index % 2 === 0 ? palette.corruption : palette.accent, alpha);
    ctx.lineWidth = rail.width;
    ctx.setLineDash([6 + (rail.width * 2), 18 + (rail.width * 4)]);
    ctx.lineDashOffset = -pulse * 120;
    ctx.beginPath();
    if (rail.vertical) {
      const x = width * clamp(position, 0.08, 0.92);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    } else {
      const y = height * clamp(position, 0.08, 0.92);
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  });

  ctx.restore();
}

function paintCorruption(ctx, baseCanvas, width, height, scene, phaseState, t01) {
  const { palette, corruptionBands } = scene;
  if (phaseState.overflow <= 0.001 && phaseState.rollback <= 0.001) return;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const band of corruptionBands) {
    const y = band.y * height;
    const h = Math.max(8, band.h * height);
    const shift = Math.sin((t01 * TAU * 2) + band.phase) * band.amplitude * (0.25 + phaseState.overflow + (phaseState.rollback * 0.6));
    ctx.drawImage(baseCanvas, 0, y, width, h, shift, y, width, h);
    ctx.fillStyle = rgba(palette.corruption, 0.08 + (phaseState.overflow * 0.16));
    ctx.fillRect(0, y, width, h * 0.48);
  }
  ctx.restore();
}

function paintOverlay(ctx, width, height, scene, phaseState) {
  const { palette } = scene;
  ctx.save();

  const vignette = ctx.createRadialGradient(
    width * scene.focus.x,
    height * scene.focus.y,
    Math.min(width, height) * 0.08,
    width * 0.5,
    height * 0.5,
    Math.max(width, height) * 0.75
  );
  vignette.addColorStop(0, rgba(palette.void || palette.ground || "#020304", 0));
  vignette.addColorStop(1, rgba(palette.void || palette.ground || "#020304", 0.72));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = rgba(palette.accent || "#ffffff", 0.03 + (phaseState.align * 0.02));
  for (let i = 0; i < 48; i += 1) {
    const y = (i / 48) * height;
    ctx.fillRect(0, y, width, 1);
  }

  ctx.restore();
}

function phaseStateForT(t01) {
  return {
    boot: band(t01, 0.0, 0.18),
    align: band(t01, 0.12, 0.34),
    repair: band(t01, 0.28, 0.58),
    overflow: band(t01, 0.52, 0.8),
    rollback: Math.max(band(t01, 0.76, 1.0), band(t01, 0.0, 0.08)),
  };
}

export function mountRecoveryFaultEngine(canvas, featurePack) {
  if (!canvas) throw new Error("Recovery Fault engine requires a canvas");
  let currentFeaturePack = featurePack;
  let scene = buildScene(featurePack);
  let rafId = 0;
  let destroyed = false;
  let originTime = performance.now();
  let baseCanvas = createBufferCanvas(1, 1);
  let baseCtx = baseCanvas.getContext("2d");

  function ensureBuffers(width, height) {
    if (baseCanvas.width !== width || baseCanvas.height !== height) {
      baseCanvas = createBufferCanvas(width, height);
      baseCtx = baseCanvas.getContext("2d");
    }
  }

  function renderFrame(now) {
    if (destroyed) return;
    const { width, height } = resizeCanvas(canvas);
    ensureBuffers(width, height);
    const ctx = canvas.getContext("2d");
    const loopMs = scene.loopMs;
    const t01 = ((now - originTime) % loopMs) / loopMs;
    const phaseState = phaseStateForT(t01);

    baseCtx.clearRect(0, 0, width, height);
    paintGround(baseCtx, width, height, scene, phaseState);
    paintMacroField(baseCtx, width, height, scene, phaseState);
    paintFragments(baseCtx, width, height, scene, phaseState, t01);
    paintRepairSwarm(baseCtx, width, height, scene, phaseState, t01);
    paintGhosts(baseCtx, width, height, scene, phaseState, t01);
    paintRails(baseCtx, width, height, scene, phaseState, t01);

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(baseCanvas, 0, 0);
    paintCorruption(ctx, baseCanvas, width, height, scene, phaseState, t01);
    paintOverlay(ctx, width, height, scene, phaseState);

    rafId = window.requestAnimationFrame(renderFrame);
  }

  function restart(nextFeaturePack = currentFeaturePack) {
    currentFeaturePack = nextFeaturePack;
    scene = buildScene(nextFeaturePack);
    originTime = performance.now();
  }

  const onResize = () => {
    resizeCanvas(canvas);
  };

  window.addEventListener("resize", onResize);
  rafId = window.requestAnimationFrame(renderFrame);

  return {
    update(nextFeaturePack) {
      restart(nextFeaturePack);
    },
    snapshotDataUrl() {
      return canvas.toDataURL("image/png");
    },
    destroy() {
      destroyed = true;
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
    },
  };
}
