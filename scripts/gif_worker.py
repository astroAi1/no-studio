#!/usr/bin/env python3
"""
No-Meta GIF worker (local MVP).

Reads JSON from stdin and writes a JSON result to stdout:
{
  "ok": true,
  "files": [{"name":"...", "kind":"gif|png", "bytes":123, "width":1024, "height":1024}],
  "logs": [...]
}
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import random
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple


REPO_ROOT = Path(__file__).resolve().parents[3]
TRANSPARENT_ROOT = REPO_ROOT / "transparent"
TONE_STEP = 4


def _read_payload() -> Dict[str, Any]:
  raw = sys.stdin.read()
  if not raw.strip():
    raise ValueError("Missing worker payload")
  payload = json.loads(raw)
  if not isinstance(payload, dict):
    raise ValueError("Worker payload must be an object")
  return payload


def _clamp_byte(v: int) -> int:
  return max(0, min(255, int(v)))


def _rgb_hex(rgb: Tuple[int, int, int]) -> str:
  return f"#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}"


def _collect_palette(img) -> List[Dict[str, int]]:
  counts: Dict[Tuple[int, int, int], int] = {}
  rgba = img.convert("RGBA")
  data = list(rgba.getdata())
  for r, g, b, a in data:
    if a <= 0:
      continue
    key = (int(r), int(g), int(b))
    counts[key] = counts.get(key, 0) + int(a)

  palette = []
  for (r, g, b), weight in counts.items():
    luma = (0.2126 * r) + (0.7152 * g) + (0.0722 * b)
    mx = max(r, g, b)
    mn = min(r, g, b)
    palette.append({
      "r": r,
      "g": g,
      "b": b,
      "weight": weight,
      "luma": luma,
      "chroma": mx - mn,
      "is_dark": (luma <= 20 or mx <= 20),
    })
  palette.sort(key=lambda item: item["weight"], reverse=True)
  return palette


def _pick_nometa_background(palette: List[Dict[str, int]], rng: random.Random) -> Tuple[int, int, int]:
  non_dark = [c for c in palette if not c["is_dark"]]
  exact_safe = [
    c for c in non_dark
    if c["r"] <= 255 - TONE_STEP and c["g"] <= 255 - TONE_STEP and c["b"] <= 255 - TONE_STEP
  ]
  vibrant_exact = [c for c in exact_safe if int(c.get("chroma", 0)) >= 14]
  vibrant = [c for c in non_dark if int(c.get("chroma", 0)) >= 14]

  pool = vibrant_exact or exact_safe or vibrant or non_dark or palette
  if not pool:
    return (8, 8, 8)

  def pick_weight(c: Dict[str, int]) -> float:
    chroma_boost = 1.0 + min(2.4, float(c.get("chroma", 0)) / 18.0)
    luma_penalty = 0.65 if float(c.get("luma", 0)) > 230 else 1.0
    return max(1.0, float(c.get("weight", 1)) * chroma_boost * luma_penalty)

  total = sum(pick_weight(c) for c in pool)
  pick = rng.uniform(0, total)
  acc = 0.0
  for c in pool:
    acc += pick_weight(c)
    if acc >= pick:
      return (int(c["r"]), int(c["g"]), int(c["b"]))
  last = pool[-1]
  return (int(last["r"]), int(last["g"]), int(last["b"]))


def _nometa_two_tone_mask(punk_rgba, tone1: Tuple[int, int, int], tone2: Tuple[int, int, int]):
  from PIL import Image

  src = punk_rgba.convert("RGBA")
  out = Image.new("RGB", src.size, tone1)
  src_px = src.load()
  out_px = out.load()
  w, h = src.size
  for y in range(h):
    for x in range(w):
      _, _, _, a = src_px[x, y]
      out_px[x, y] = tone2 if a > 0 else tone1
  return out


def _load_punk_rgba(punk_id: int):
  from PIL import Image

  path = TRANSPARENT_ROOT / f"{punk_id}.png"
  if not path.exists():
    raise FileNotFoundError(f"Missing transparent NoPunk asset: {path}")
  return Image.open(path).convert("RGBA")


def _build_no_meta_signal(style_id: str, token_ids: Sequence[int], out_dir: Path, seed: int | None):
  from PIL import Image, ImageDraw

  punk_id = int(token_ids[0])
  rng = random.Random(seed if seed is not None else punk_id)
  punk = _load_punk_rgba(punk_id)
  palette = _collect_palette(punk)
  tone1 = _pick_nometa_background(palette, rng)
  tone2 = tuple(_clamp_byte(c + TONE_STEP) for c in tone1)

  mask24 = _nometa_two_tone_mask(punk, tone1, tone2)
  scale = 32  # 24 * 32 = 768
  stage_size = 24 * scale
  mask768 = mask24.resize((stage_size, stage_size), Image.NEAREST)

  frames = []
  frame_count = 24
  for idx in range(frame_count):
    canvas = Image.new("RGB", (1024, 1024), tone1)
    draw = ImageDraw.Draw(canvas)
    phase = idx / frame_count

    # Moving scanline bars using tone2 only (keeps two-tone palette).
    band_y = int((phase * (1024 + 160)) - 80)
    for y in range(max(0, band_y - 2), min(1024, band_y + 2)):
      draw.rectangle([(0, y), (1024, y)], fill=tone2)
    for y in range(0, 1024, 32):
      if ((y // 32) + idx) % 9 == 0:
        draw.rectangle([(0, y), (1024, min(1023, y))], fill=tone2)

    # Shadowplate frame (still two tones).
    margin = 92
    draw.rectangle([(margin, margin), (1024 - margin, 1024 - margin)], outline=tone2, width=4)
    draw.rectangle([(margin + 16, margin + 16), (1024 - margin - 16, 1024 - margin - 16)], outline=tone2, width=2)

    # Corner ticks instead of label text/bars.
    tick = 20 + (idx % 5)
    corners = [
      (margin + 12, margin + 12, 1, 1),
      (1024 - margin - 12, margin + 12, -1, 1),
      (margin + 12, 1024 - margin - 12, 1, -1),
      (1024 - margin - 12, 1024 - margin - 12, -1, -1),
    ]
    for cx, cy, sx, sy in corners:
      x2 = cx + (sx * tick)
      y2 = cy + (sy * 2)
      draw.rectangle([(min(cx, x2), min(cy, y2)), (max(cx, x2), max(cy, y2))], fill=tone2)
      x3 = cx + (sx * 2)
      y3 = cy + (sy * tick)
      draw.rectangle([(min(cx, x3), min(cy, y3)), (max(cx, x3), max(cy, y3))], fill=tone2)

    # Center stage.
    offset_x = (1024 - stage_size) // 2
    offset_y = (1024 - stage_size) // 2
    canvas.paste(mask768, (offset_x, offset_y))

    frames.append(canvas)

  gif_name = f"{style_id}-{punk_id}.gif"
  png_name = f"{style_id}-{punk_id}.png"
  gif_path = out_dir / gif_name
  png_path = out_dir / png_name

  # Import generate_social lazily after env is set; reuse its GIF save and cover export helpers.
  import generate_social as gs  # type: ignore

  gs.save_gif(frames, str(gif_path), duration=74, loop=0)
  gs.export_gif_cover(str(gif_path), str(png_path), frame_ratio=0.45)
  return {
    "files": [
      {"path": str(gif_path), "name": gif_name, "kind": "gif"},
      {"path": str(png_path), "name": png_name, "kind": "png"},
    ],
    "logs": [
      f"no-meta-signal #{punk_id}",
      f"tone1={_rgb_hex(tone1)} tone2={_rgb_hex(tone2)}",
    ],
  }


def _ease_out_cubic(t: float) -> float:
  t = max(0.0, min(1.0, float(t)))
  return 1.0 - pow(1.0 - t, 3)


def _build_sleek_reveal_clean(style_id: str, token_ids: Sequence[int], out_dir: Path, seed: int | None):
  from PIL import Image, ImageDraw

  punk_id = int(token_ids[0])
  punk = _load_punk_rgba(punk_id)
  accent = (34, 34, 34)
  ghost = (12, 12, 12)

  stage_px = 768
  stage = punk.resize((stage_px, stage_px), Image.NEAREST).convert("RGBA")
  stage_rgb = stage.convert("RGB")
  stage_mask = stage.split()[3]
  ox = (1024 - stage_px) // 2
  oy = (1024 - stage_px) // 2

  frames = []
  frame_count = 34
  for idx in range(frame_count):
    canvas = Image.new("RGB", (1024, 1024), (0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    t = idx / max(1, frame_count - 1)
    reveal_progress = 0.03 + (0.97 * _ease_out_cubic(t))
    reveal_h = max(0, min(stage_px, int(round(stage_px * reveal_progress))))

    # Subtle structure (no text).
    for x in range(0, 1024, 128):
      shade = 7 if (x // 128) % 2 == 0 else 10
      draw.rectangle([(x, 0), (min(1023, x + 1), 1023)], fill=(shade, shade, shade))

    margin = 92
    draw.rectangle([(margin, margin), (1024 - margin, 1024 - margin)], outline=(18, 18, 18), width=2)
    draw.rectangle([(margin + 18, margin + 18), (1024 - margin - 18, 1024 - margin - 18)], outline=(10, 10, 10), width=1)

    if reveal_h > 0:
      crop_rgb = stage_rgb.crop((0, 0, stage_px, reveal_h))
      crop_mask = stage_mask.crop((0, 0, stage_px, reveal_h))
      canvas.paste(crop_rgb, (ox, oy), crop_mask)
      draw = ImageDraw.Draw(canvas)

    # Scanline reveal edge.
    scan_y = oy + min(stage_px, reveal_h)
    if scan_y < oy + stage_px:
      draw.rectangle([(ox - 12, max(0, scan_y - 1)), (ox + stage_px + 12, min(1023, scan_y))], fill=accent)
      draw.rectangle([(ox - 8, min(1023, scan_y + 3)), (ox + stage_px + 8, min(1023, scan_y + 3))], fill=ghost)

    frames.append(canvas)

  if frames:
    for _ in range(12):
      frames.append(frames[-1].copy())

  gif_name = f"{style_id}-{punk_id}.gif"
  png_name = f"{style_id}-{punk_id}.png"
  gif_path = out_dir / gif_name
  png_path = out_dir / png_name

  import generate_social as gs  # type: ignore
  gs.save_gif(frames, str(gif_path), duration=72, loop=0)
  gs.export_gif_cover(str(gif_path), str(png_path), frame_ratio=0.55)
  return {
    "files": [
      {"path": str(gif_path), "name": gif_name, "kind": "gif"},
      {"path": str(png_path), "name": png_name, "kind": "png"},
    ],
    "logs": [f"sleek-reveal #{punk_id} (textless)"],
  }


def _run_generate_social_style(style_id: str, token_ids: Sequence[int], out_dir: Path, seed: int | None):
  # Import after env variables are set.
  import generate_social as gs  # type: ignore

  gs.OUT = str(out_dir)
  if seed is not None:
    random.seed(int(seed))
    try:
      gs.random.seed(int(seed))
    except Exception:
      pass

  single_styles = {
    "glitch": lambda pid: gs.glitch_gif(pid),
    "sleek-dissolve": lambda pid: gs.sleek_dissolve_gif(pid, out_path=str(out_dir / f"sleek-dissolve-{pid}.gif")),
    "sleek-pulse": lambda pid: gs.sleek_pulse_gif(pid, out_path=str(out_dir / f"sleek-pulse-{pid}.gif")),
  }

  logs_buffer = io.StringIO()
  with contextlib.redirect_stdout(logs_buffer):
    if style_id == "sleek-morph":
      out_name = f"sleek-morph-{'_'.join(str(i) for i in token_ids[:4])}.gif"
      gif_path = gs.sleek_morph_gif(list(token_ids), out_path=str(out_dir / out_name))
    elif style_id in single_styles:
      gif_path = single_styles[style_id](int(token_ids[0]))
    else:
      raise ValueError(f"Unsupported style: {style_id}")

  if not gif_path:
    raise RuntimeError(f"Style {style_id} did not return an output GIF path")

  gif_path = Path(gif_path)
  if not gif_path.exists():
    raise FileNotFoundError(f"GIF not found after render: {gif_path}")

  png_path = gif_path.with_suffix(".png")
  gs.export_gif_cover(str(gif_path), str(png_path), frame_ratio=0.5)

  files = [{"path": str(gif_path), "name": gif_path.name, "kind": "gif"}]
  if png_path.exists():
    files.append({"path": str(png_path), "name": png_path.name, "kind": "png"})

  logs = [line.strip() for line in logs_buffer.getvalue().splitlines() if line.strip()]
  return {"files": files, "logs": logs[-40:]}


def _with_dimensions(files: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
  from PIL import Image

  out: List[Dict[str, Any]] = []
  for file in files:
    p = Path(file["path"])
    if not p.exists():
      continue
    width = 1024
    height = 1024
    try:
      with Image.open(p) as im:
        width, height = im.size
    except Exception:
      pass

    out.append({
      "name": file["name"],
      "kind": file["kind"],
      "bytes": p.stat().st_size,
      "width": int(width),
      "height": int(height),
    })
  return out


def _fit_to_square_rgb(img, size: int = 1024, bg: Tuple[int, int, int] = (0, 0, 0)):
  from PIL import Image

  src = img.convert("RGB")
  canvas = Image.new("RGB", (size, size), bg)
  iw, ih = src.size
  if iw <= 0 or ih <= 0:
    return canvas
  scale = min(size / iw, size / ih)
  tw = max(1, int(round(iw * scale)))
  th = max(1, int(round(ih * scale)))
  resized = src.resize((tw, th), Image.NEAREST)
  ox = (size - tw) // 2
  oy = (size - th) // 2
  canvas.paste(resized, (ox, oy))
  return canvas


def _normalize_outputs_to_square(files: List[Dict[str, Any]], size: int = 1024):
  from PIL import Image

  for file in files:
    p = Path(file["path"])
    if not p.exists():
      continue
    kind = str(file.get("kind") or "").lower()
    if kind == "png":
      with Image.open(p) as im:
        if im.size == (size, size):
          continue
        square = _fit_to_square_rgb(im, size=size)
        square.save(p, "PNG", optimize=True)
      continue

    if kind == "gif":
      with Image.open(p) as im:
        if im.size == (size, size):
          continue
        frames = []
        durations = []
        n_frames = max(1, int(getattr(im, "n_frames", 1)))
        for idx in range(n_frames):
          im.seek(idx)
          frame = im.convert("RGB")
          frames.append(_fit_to_square_rgb(frame, size=size))
          durations.append(int(im.info.get("duration", 80)))
      if not frames:
        continue
      avg_duration = max(16, int(round(sum(durations) / len(durations)))) if durations else 80
      import generate_social as gs  # type: ignore
      gs.save_gif(frames, str(p), duration=avg_duration, loop=0)


def main() -> int:
  try:
    payload = _read_payload()
    style_id = str(payload.get("styleId") or "").strip()
    token_ids = [int(x) for x in (payload.get("tokenIds") or [])]
    out_dir = Path(payload.get("outDir") or "").resolve()
    if not style_id:
      raise ValueError("Missing styleId")
    if not token_ids:
      raise ValueError("Missing tokenIds")
    if not str(out_dir):
      raise ValueError("Missing outDir")

    out_dir.mkdir(parents=True, exist_ok=True)

    # Lock square export size for v1.
    os.environ["NOPUNKS_GIF_SIZE"] = "1024"
    os.environ.setdefault("NOPUNKS_GIF_MAX_MB", "14.8")

    # Add assets/ to path after env is set so generate_social reads the right env defaults.
    assets_dir = REPO_ROOT / "assets"
    sys.path.insert(0, str(assets_dir))

    seed = payload.get("seed")
    seed = int(seed) if seed is not None and str(seed) != "" else None

    if style_id == "sleek-reveal":
      result = _build_sleek_reveal_clean(style_id, token_ids, out_dir, seed)
    else:
      result = _run_generate_social_style(style_id, token_ids, out_dir, seed)

    _normalize_outputs_to_square(result.get("files", []), size=1024)

    response = {
      "ok": True,
      "files": _with_dimensions(result.get("files", [])),
      "logs": result.get("logs", []),
    }
    sys.stdout.write(json.dumps(response))
    return 0
  except Exception as exc:
    sys.stdout.write(json.dumps({
      "ok": False,
      "error": str(exc),
    }))
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
