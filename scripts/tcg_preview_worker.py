#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
TRANSPARENT_ROOT = REPO_ROOT / "transparent"


def _read_payload() -> Dict[str, Any]:
  raw = sys.stdin.read()
  if not raw.strip():
    raise ValueError("Missing payload")
  payload = json.loads(raw)
  if not isinstance(payload, dict):
    raise ValueError("Payload must be object")
  return payload


def _theme_for_rarity(rarity: str) -> Dict[str, Tuple[int, int, int]]:
  rarity = str(rarity or "Common")
  themes = {
    "Common": {
      "frame": (178, 182, 190),
      "frame2": (120, 124, 132),
      "aura": (210, 214, 222),
      "bgA": (42, 44, 52),
      "bgB": (16, 18, 24),
      "text": (245, 246, 250),
      "dim": (180, 184, 192),
    },
    "Uncommon": {
      "frame": (70, 164, 255),
      "frame2": (45, 118, 196),
      "aura": (88, 232, 196),
      "bgA": (14, 44, 76),
      "bgB": (8, 16, 32),
      "text": (245, 249, 255),
      "dim": (180, 205, 230),
    },
    "Rare": {
      "frame": (170, 86, 255),
      "frame2": (121, 52, 184),
      "aura": (255, 74, 132),
      "bgA": (55, 16, 72),
      "bgB": (18, 10, 28),
      "text": (255, 245, 252),
      "dim": (226, 184, 220),
    },
    "Legendary": {
      "frame": (255, 214, 84),
      "frame2": (198, 148, 38),
      "aura": (255, 244, 168),
      "bgA": (92, 52, 12),
      "bgB": (22, 16, 8),
      "text": (255, 252, 236),
      "dim": (245, 222, 170),
    },
    "Cursed": {
      "frame": (185, 22, 38),
      "frame2": (58, 6, 10),
      "aura": (255, 56, 76),
      "bgA": (36, 0, 6),
      "bgB": (5, 5, 8),
      "text": (255, 238, 242),
      "dim": (220, 150, 156),
    },
  }
  return themes.get(rarity, themes["Common"])


def _clamp(v: int) -> int:
  return max(0, min(255, int(v)))


def _mix(a: Tuple[int, int, int], b: Tuple[int, int, int], t: float) -> Tuple[int, int, int]:
  return (
    _clamp(round(a[0] * (1.0 - t) + b[0] * t)),
    _clamp(round(a[1] * (1.0 - t) + b[1] * t)),
    _clamp(round(a[2] * (1.0 - t) + b[2] * t)),
  )


def _lighten(c: Tuple[int, int, int], amt: float) -> Tuple[int, int, int]:
  return _mix(c, (255, 255, 255), amt)


def _darken(c: Tuple[int, int, int], amt: float) -> Tuple[int, int, int]:
  return _mix(c, (0, 0, 0), amt)


def _load_font(size: int, bold: bool = False):
  from PIL import ImageFont

  candidates = []
  if bold:
    candidates.extend([
      "DejaVuSerif-Bold.ttf",
      "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
      "/Library/Fonts/Georgia Bold.ttf",
    ])
  else:
    candidates.extend([
      "DejaVuSerif.ttf",
      "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
      "/Library/Fonts/Georgia.ttf",
    ])
  for c in candidates:
    try:
      return ImageFont.truetype(c, size)
    except Exception:
      continue
  return ImageFont.load_default()


def _fit_font(draw, text: str, max_width: int, start: int, bold: bool = False, min_size: int = 14):
  size = start
  while size > min_size:
    fnt = _load_font(size, bold=bold)
    bbox = draw.textbbox((0, 0), text, font=fnt)
    if (bbox[2] - bbox[0]) <= max_width:
      return fnt
    size -= 2
  return _load_font(min_size, bold=bold)


def _draw_vertical_gradient(img, box, top_rgb, bottom_rgb):
  from PIL import Image

  x0, y0, x1, y1 = box
  w = max(1, x1 - x0)
  h = max(1, y1 - y0)
  grad = Image.new("RGB", (w, h))
  px = grad.load()
  for y in range(h):
    t = y / max(1, h - 1)
    r = round(top_rgb[0] * (1 - t) + bottom_rgb[0] * t)
    g = round(top_rgb[1] * (1 - t) + bottom_rgb[1] * t)
    b = round(top_rgb[2] * (1 - t) + bottom_rgb[2] * t)
    for x in range(w):
      px[x, y] = (r, g, b)
  img.paste(grad, (x0, y0))


def _draw_diagonal_gradient(img, box, c1, c2, c3):
  from PIL import Image

  x0, y0, x1, y1 = box
  w = max(1, x1 - x0)
  h = max(1, y1 - y0)
  grad = Image.new("RGB", (w, h))
  px = grad.load()
  for y in range(h):
    for x in range(w):
      tx = x / max(1, w - 1)
      ty = y / max(1, h - 1)
      d = (tx * 0.68) + (ty * 0.32)
      base = _mix(c1, c2, d)
      ridge = max(0.0, 1.0 - abs((tx - ty) - 0.08) * 3.2)
      px[x, y] = _mix(base, c3, ridge * 0.22)
  img.paste(grad, (x0, y0))


def _draw_gloss_overlay(img, box, color, alpha=50):
  from PIL import Image, ImageDraw, ImageFilter

  x0, y0, x1, y1 = box
  w = max(1, x1 - x0)
  h = max(1, y1 - y0)
  overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
  d = ImageDraw.Draw(overlay)
  d.polygon(
    [
      (int(w * 0.08), 0),
      (int(w * 0.54), 0),
      (int(w * 0.34), h),
      (0, h),
    ],
    fill=(color[0], color[1], color[2], alpha),
  )
  d.polygon(
    [
      (int(w * 0.62), 0),
      (w, 0),
      (w, int(h * 0.18)),
      (int(w * 0.74), int(h * 0.28)),
    ],
    fill=(255, 255, 255, max(12, alpha // 2)),
  )
  overlay = overlay.filter(ImageFilter.GaussianBlur(2))
  img.alpha_composite(overlay, (x0, y0))


def _draw_corner_plate(draw, x, y, w, h, theme, invert=False):
  a = theme["frame2"] if not invert else theme["frame"]
  b = theme["frame"] if not invert else theme["frame2"]
  draw.rounded_rectangle((x, y, x + w, y + h), radius=6, fill=(8, 8, 10), outline=a, width=2)
  draw.line([(x + 6, y + 5), (x + w - 6, y + 5)], fill=_lighten(b, 0.35), width=1)
  draw.line([(x + 6, y + h - 5), (x + w - 6, y + h - 5)], fill=_darken(a, 0.15), width=1)


def _draw_energy_bg(img, box, theme, rarity):
  from PIL import Image, ImageDraw, ImageFilter

  x0, y0, x1, y1 = box
  w = x1 - x0
  h = y1 - y0
  layer = Image.new("RGBA", (w, h), (0, 0, 0, 255))
  _draw_diagonal_gradient(layer, (0, 0, w, h), theme["bgA"], theme["bgB"], _lighten(theme["aura"], 0.35))
  draw = ImageDraw.Draw(layer)

  # impact rays
  cx = w // 2
  cy = int(h * 0.42)
  ray_color = _lighten(theme["aura"], 0.35)
  for i in range(34):
    ang = (i / 34.0) * math.pi * 2.0
    r1 = int(min(w, h) * 0.1)
    r2 = int(min(w, h) * (0.55 + (0.12 * math.sin(i * 1.7))))
    p1 = (cx + int(math.cos(ang) * r1), cy + int(math.sin(ang) * r1))
    p2 = (cx + int(math.cos(ang) * r2), cy + int(math.sin(ang) * r2))
    draw.line([p1, p2], fill=(*ray_color, 255), width=1)

  # speed lines
  line_color = _lighten(theme["frame"], 0.18)
  for i in range(22):
    off = (i * 47) % max(1, w)
    width = 1 + (i % 3 == 0)
    draw.line([(off - 110, h), (off + 220, 0)], fill=line_color, width=width)

  # burst glow
  glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
  gd = ImageDraw.Draw(glow)
  lcx = w // 2
  lcy = int(h * 0.45)
  aura = theme["aura"]
  for r in [int(min(w, h) * p) for p in (0.16, 0.24, 0.34, 0.48, 0.62)]:
    alpha = max(12, 150 - r // 5)
    gd.ellipse([(lcx - r, lcy - r), (lcx + r, lcy + r)], fill=(aura[0], aura[1], aura[2], alpha))
  glow = glow.filter(ImageFilter.GaussianBlur(16))
  layer.alpha_composite(glow)

  # energy arcs / streaks
  arc_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
  ad = ImageDraw.Draw(arc_layer)
  for i in range(8):
    px = int(w * (0.14 + (i * 0.1)))
    py = int(h * (0.16 + ((i % 3) * 0.13)))
    sx = int(w * 0.26)
    sy = int(h * 0.2)
    start = (i * 19) % 360
    end = start + 96 + (i % 3) * 14
    ad.arc([(px, py), (px + sx, py + sy)], start=start, end=end, fill=(*_lighten(aura, 0.2), 150), width=3)
  arc_layer = arc_layer.filter(ImageFilter.GaussianBlur(1))
  layer.alpha_composite(arc_layer)

  # sparkle / foil dots
  sparkle = _lighten(theme["aura"], 0.2)
  step = 44 if rarity != "Legendary" else 30
  for y in range(18, h - 18, step):
    for x in range(18, w - 18, step):
      if ((x + y) // step) % 3 == 0:
        draw.point((x, y), fill=sparkle)
        if rarity in ("Legendary", "Cursed") and (x + y) % (step * 2) == 0:
          draw.point((x + 1, y), fill=(255, 255, 255))

  # subtle scan bars to add motion feel without clutter
  for y in range(0, h, 24):
    shade = 9 if (y // 24) % 2 == 0 else 0
    if shade:
      draw.rectangle([(0, y), (w, min(h, y + 1))], fill=(255, 255, 255, 10))

  img.alpha_composite(layer, (x0, y0))


def _load_and_place_punk(img, art_box, token_id, theme):
  from PIL import Image, ImageDraw, ImageFilter

  x0, y0, x1, y1 = art_box
  path = TRANSPARENT_ROOT / f"{token_id}.png"
  if not path.exists():
    return
  punk = Image.open(path).convert("RGBA")
  target = int(min((x1 - x0), (y1 - y0)) * 0.78)
  punk = punk.resize((target, target), Image.NEAREST)

  # aura halo behind artwork
  halo = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
  hd = ImageDraw.Draw(halo)
  aura = theme["aura"]
  cx = (x1 - x0) // 2
  cy = int((y1 - y0) * 0.52)
  for r in [target // 3, target // 2, int(target * 0.66)]:
    hd.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=(aura[0], aura[1], aura[2], 45))
  halo = halo.filter(ImageFilter.GaussianBlur(14))
  img.alpha_composite(halo, (x0, y0))

  ox = x0 + ((x1 - x0) - target) // 2
  oy = y0 + ((y1 - y0) - target) // 2 + 8

  # ghost after-images for motion/energy feel
  alpha = punk.split()[3]
  for dx, dy, fade in [(-18, -8, 58), (16, 10, 42)]:
    ghost = Image.new("RGBA", punk.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(ghost)
    gd.bitmap((0, 0), alpha, fill=(aura[0], aura[1], aura[2], fade))
    ghost = ghost.filter(ImageFilter.GaussianBlur(2))
    img.alpha_composite(ghost, (ox + dx, oy + dy))

  # drop shadow
  shadow = Image.new("RGBA", punk.size, (0, 0, 0, 0))
  sd = ImageDraw.Draw(shadow)
  sd.bitmap((0, 0), alpha, fill=(0, 0, 0, 120))
  shadow = shadow.filter(ImageFilter.GaussianBlur(5))
  img.alpha_composite(shadow, (ox + 10, oy + 14))

  img.alpha_composite(punk, (ox, oy))

  # rim light
  rim = Image.new("RGBA", punk.size, (0, 0, 0, 0))
  rd = ImageDraw.Draw(rim)
  rd.rectangle([(0, 0), (punk.size[0] - 1, punk.size[1] - 1)], outline=(255, 255, 255, 20), width=2)
  rim = rim.filter(ImageFilter.GaussianBlur(2))
  img.alpha_composite(rim, (ox, oy))

  # white flare slash
  flare = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
  fd = ImageDraw.Draw(flare)
  fd.polygon(
    [
      (int((x1 - x0) * 0.18), int((y1 - y0) * 0.2)),
      (int((x1 - x0) * 0.38), int((y1 - y0) * 0.16)),
      (int((x1 - x0) * 0.7), int((y1 - y0) * 0.78)),
      (int((x1 - x0) * 0.52), int((y1 - y0) * 0.82)),
    ],
    fill=(255, 255, 255, 28),
  )
  flare = flare.filter(ImageFilter.GaussianBlur(3))
  img.alpha_composite(flare, (x0, y0))


def _wrap_lines(draw, text: str, font, max_width: int, max_lines: int = 2) -> List[str]:
  words = str(text or "").split()
  if not words:
    return [""]
  lines: List[str] = []
  current = words[0]
  for w in words[1:]:
    candidate = f"{current} {w}"
    bbox = draw.textbbox((0, 0), candidate, font=font)
    if (bbox[2] - bbox[0]) <= max_width:
      current = candidate
    else:
      lines.append(current)
      current = w
      if len(lines) >= max_lines - 1:
        break
  lines.append(current)
  if len(lines) > max_lines:
    lines = lines[:max_lines]
  if len(words) > 1 and len(lines) == max_lines:
    # clip final line if needed
    last = lines[-1]
    while last:
      bbox = draw.textbbox((0, 0), f"{last}...", font=font)
      if (bbox[2] - bbox[0]) <= max_width:
        lines[-1] = f"{last}..."
        break
      parts = last.split()
      last = " ".join(parts[:-1]) if len(parts) > 1 else last[:-1]
  return lines


def _render_card(card: Dict[str, Any], out_path: Path):
  from PIL import Image, ImageDraw, ImageFilter

  W = int(card.get("layout", {}).get("width", 1024))
  H = int(card.get("layout", {}).get("height", 1432))
  rarity = str(card.get("rarity") or "Common")
  theme = _theme_for_rarity(rarity)

  img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
  draw = ImageDraw.Draw(img)

  # outside card backdrop (still inside image) - keep restrained so the card itself dominates
  _draw_vertical_gradient(img, (0, 0, W, H), (0, 0, 0), (6, 6, 8))
  vignette = Image.new("RGBA", (W, H), (0, 0, 0, 0))
  vd = ImageDraw.Draw(vignette)
  vd.ellipse([(-120, -80), (W + 120, H + 160)], fill=(255, 255, 255, 12))
  vignette = vignette.filter(ImageFilter.GaussianBlur(60))
  img.alpha_composite(vignette)

  # Card bounds
  card_box = (24, 24, W - 24, H - 24)
  inner_box = (40, 40, W - 40, H - 40)
  # card drop shadow
  shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
  sd = ImageDraw.Draw(shadow)
  sd.rounded_rectangle((36, 40, W - 12, H - 8), radius=20, fill=(0, 0, 0, 150))
  shadow = shadow.filter(ImageFilter.GaussianBlur(18))
  img.alpha_composite(shadow)

  _draw_diagonal_gradient(img, card_box, (7, 7, 9), (12, 12, 16), _lighten(theme["frame2"], 0.2))
  draw.rounded_rectangle(card_box, radius=18, fill=None, outline=_darken(theme["frame"], 0.18), width=10)
  draw.rounded_rectangle((28, 28, W - 28, H - 28), radius=17, fill=None, outline=theme["frame"], width=4)
  draw.rounded_rectangle(inner_box, radius=14, fill=None, outline=_lighten(theme["frame"], 0.16), width=2)
  draw.rounded_rectangle((48, 48, W - 48, H - 48), radius=12, fill=(6, 6, 8), outline=_darken(theme["frame2"], 0.2), width=2)
  _draw_gloss_overlay(img, (24, 24, W - 24, 230), _lighten(theme["aura"], 0.4), alpha=34)
  # foil speckle within the card frame
  for y in range(36, H - 36, 18):
    for x in range(36, W - 36, 18):
      if ((x * 3 + y * 5) % 97) == 0:
        draw.point((x, y), fill=(*_lighten(theme["aura"], 0.2),))

  # corner metallic plates
  _draw_corner_plate(draw, 42, 42, 84, 30, theme)
  _draw_corner_plate(draw, W - 126, 42, 84, 30, theme)
  _draw_corner_plate(draw, 42, H - 72, 84, 30, theme, invert=True)
  _draw_corner_plate(draw, W - 126, H - 72, 84, 30, theme, invert=True)

  # Header bar
  hx0, hy0, hx1, hy1 = 54, 54, W - 54, 140
  _draw_diagonal_gradient(img, (hx0, hy0, hx1, hy1), _lighten(theme["frame2"], 0.12), _darken(theme["frame2"], 0.12), _lighten(theme["frame"], 0.18))
  draw.rounded_rectangle((hx0, hy0, hx1, hy1), radius=10, outline=theme["frame"], width=3)
  draw.rounded_rectangle((hx0 + 4, hy0 + 4, hx1 - 4, hy1 - 4), radius=8, outline=_lighten(theme["frame"], 0.12), width=1)
  draw.line([(hx0 + 10, hy0 + 10), (hx1 - 10, hy0 + 10)], fill=_lighten(theme["aura"], 0.45), width=2)
  draw.line([(hx0 + 14, hy1 - 11), (hx1 - 14, hy1 - 11)], fill=_darken(theme["frame2"], 0.25), width=2)

  # HP segment (top-right)
  hp_box = (hx1 - 196, hy0 + 10, hx1 - 10, hy1 - 10)
  _draw_vertical_gradient(img, hp_box, _darken(theme["frame2"], 0.32), (10, 10, 12))
  draw.rounded_rectangle(hp_box, radius=8, fill=None, outline=theme["frame"], width=2)
  draw.line([(hp_box[0] + 6, hp_box[1] + 6), (hp_box[2] - 6, hp_box[1] + 6)], fill=_lighten(theme["aura"], 0.25), width=1)

  # Artwork frame
  ax0, ay0, ax1, ay1 = 68, 168, W - 68, 932
  _draw_energy_bg(img, (ax0, ay0, ax1, ay1), theme, rarity)
  draw.rounded_rectangle((ax0, ay0, ax1, ay1), radius=14, outline=_darken(theme["frame"], 0.08), width=7)
  draw.rounded_rectangle((ax0 + 4, ay0 + 4, ax1 - 4, ay1 - 4), radius=12, outline=theme["frame"], width=2)
  draw.rounded_rectangle((ax0 + 10, ay0 + 10, ax1 - 10, ay1 - 10), radius=10, outline=_lighten(theme["aura"], 0.25), width=2)
  draw.rounded_rectangle((ax0 + 16, ay0 + 16, ax1 - 16, ay1 - 16), radius=8, outline=(255, 255, 255, 28), width=1)
  # corner brackets
  ccol = _lighten(theme["frame"], 0.22)
  for (cx, cy, sx, sy) in [(ax0 + 18, ay0 + 18, 1, 1), (ax1 - 18, ay0 + 18, -1, 1), (ax0 + 18, ay1 - 18, 1, -1), (ax1 - 18, ay1 - 18, -1, -1)]:
    draw.line([(cx, cy), (cx + sx * 24, cy)], fill=ccol, width=3)
    draw.line([(cx, cy), (cx, cy + sy * 24)], fill=ccol, width=3)
  _load_and_place_punk(img, (ax0 + 22, ay0 + 22, ax1 - 22, ay1 - 22), int(card.get("tokenId", 0)), theme)
  _draw_gloss_overlay(img, (ax0 + 12, ay0 + 12, ax1 - 12, ay0 + int((ay1 - ay0) * 0.46)), _lighten(theme["aura"], 0.4), alpha=42)
  # art frame inner shimmer rails
  for k in range(6):
    yy = ay0 + 40 + (k * 18)
    draw.line([(ax0 + 28, yy), (ax1 - 28, yy)], fill=(255, 255, 255, 10), width=1)

  # Rarity label bottom-right of artwork frame
  rarity_text = rarity.upper()
  rarity_font = _load_font(22, bold=True)
  rbbox = draw.textbbox((0, 0), rarity_text, font=rarity_font)
  rw = (rbbox[2] - rbbox[0]) + 28
  rh = (rbbox[3] - rbbox[1]) + 16
  rbox = (ax1 - rw - 14, ay1 - rh - 14, ax1 - 14, ay1 - 14)
  _draw_diagonal_gradient(img, rbox, (10, 10, 12), _darken(theme["frame2"], 0.2), _lighten(theme["frame"], 0.2))
  draw.rounded_rectangle(rbox, radius=8, fill=None, outline=theme["frame"], width=2)
  draw.text((rbox[0] + 14, rbox[1] + 7), rarity_text, fill=theme["text"], font=rarity_font)

  # Attack boxes (identical + aligned)
  attack1_box = (68, 962, W - 68, 1158)
  attack2_box = (68, 1178, W - 68, 1374)
  for box in (attack1_box, attack2_box):
    x0, y0, x1, y1 = box
    _draw_diagonal_gradient(img, box, (20, 20, 24), (10, 10, 12), _lighten(theme["frame2"], 0.18))
    draw.rounded_rectangle(box, radius=12, outline=_darken(theme["frame2"], 0.08), width=4)
    draw.rounded_rectangle((x0 + 4, y0 + 4, x1 - 4, y1 - 4), radius=10, outline=theme["frame2"], width=2)
    draw.rounded_rectangle((x0 + 10, y0 + 10, x1 - 10, y1 - 10), radius=8, outline=(240, 240, 245, 35), width=1)
    # left energy emblem socket
    draw.ellipse((x0 + 14, y0 + 16, x0 + 46, y0 + 48), fill=_darken(theme["frame2"], 0.28), outline=theme["frame"], width=2)
    draw.ellipse((x0 + 22, y0 + 24, x0 + 38, y0 + 40), fill=_lighten(theme["aura"], 0.22))
    draw.line([(x0 + 58, y0 + 20), (x0 + 58, y1 - 20)], fill=_darken(theme["frame2"], 0.1), width=2)
    _draw_gloss_overlay(img, (x0 + 6, y0 + 6, x1 - 6, y0 + 48), _lighten(theme["aura"], 0.45), alpha=18)
    # angled foil stroke
    draw.line([(x0 + 90, y0 + 10), (x0 + 180, y1 - 10)], fill=(255, 255, 255, 14), width=2)

  # Typography
  name_text = str(card.get("displayName") or card.get("name") or f"NOPUNK #{card.get('tokenId', 0)}")
  name_font = _fit_font(draw, name_text, (hp_box[0] - hx0) - 48, 42, bold=True, min_size=22)
  nb = draw.textbbox((0, 0), name_text, font=name_font)
  nx = hx0 + ((hp_box[0] - hx0) - (nb[2] - nb[0])) // 2
  ny = hy0 + ((hy1 - hy0) - (nb[3] - nb[1])) // 2 - 2
  draw.text((nx + 1, ny + 1), name_text, fill=(0, 0, 0), font=name_font)
  draw.text((nx, ny), name_text, fill=theme["text"], font=name_font)

  hp_label_font = _load_font(20, bold=False)
  hp_value_font = _load_font(34, bold=True)
  draw.text((hp_box[0] + 14, hp_box[1] + 10), "HP", fill=_lighten(theme["dim"], 0.1), font=hp_label_font)
  hp_value = str(int(card.get("hp") or 0))
  hb = draw.textbbox((0, 0), hp_value, font=hp_value_font)
  hx = hp_box[2] - (hb[2] - hb[0]) - 14
  hy = hp_box[1] + 6
  draw.text((hx + 1, hy + 1), hp_value, fill=(0, 0, 0), font=hp_value_font)
  draw.text((hx, hy), hp_value, fill=theme["text"], font=hp_value_font)

  token_font = _load_font(18, bold=False)
  token_text = f"#{int(card.get('tokenId', 0))}"
  draw.text((ax0 + 18, ay0 + 14), token_text, fill=_lighten(theme["dim"], 0.05), font=token_font)
  # subtle type chip in art frame (within layout, non-disruptive)
  type_text = str(((card.get("source") or {}).get("type")) or "Unknown").upper()
  type_font = _load_font(16, bold=True)
  tb = draw.textbbox((0, 0), type_text, font=type_font)
  tbox = (ax0 + 88, ay0 + 10, ax0 + 88 + (tb[2] - tb[0]) + 24, ay0 + 38)
  _draw_diagonal_gradient(img, tbox, (10, 10, 12), _darken(theme["frame2"], 0.25), _lighten(theme["frame"], 0.1))
  draw.rounded_rectangle(tbox, radius=6, fill=None, outline=theme["frame2"], width=1)
  draw.text((tbox[0] + 12, tbox[1] + 5), type_text, fill=theme["dim"], font=type_font)

  # Attacks text layout
  attacks = card.get("attacks") or []
  for idx, box in enumerate((attack1_box, attack2_box)):
    attack = attacks[idx] if idx < len(attacks) else {"name": "Attack", "damage": 0, "flavor": ""}
    x0, y0, x1, y1 = box
    top_pad = 20
    left_pad = 68
    right_pad = 22
    title_font = _fit_font(draw, str(attack.get("name") or "Attack"), (x1 - x0) - 220, 30, bold=True, min_size=18)
    dmg_font = _load_font(28, bold=True)
    dmg_text = f"{int(attack.get('damage') or 0)} DMG"

    title_y = y0 + top_pad
    attack_name = str(attack.get("name") or "Attack")
    draw.text((x0 + left_pad + 1, title_y + 1), attack_name, fill=(0, 0, 0), font=title_font)
    draw.text((x0 + left_pad, title_y), attack_name, fill=theme["text"], font=title_font)
    db = draw.textbbox((0, 0), dmg_text, font=dmg_font)
    dmg_x = x1 - right_pad - (db[2] - db[0])
    draw.text((dmg_x + 1, title_y - 1), dmg_text, fill=(0, 0, 0), font=dmg_font)
    draw.text((dmg_x, title_y - 2), dmg_text, fill=_lighten(theme["frame"], 0.1), font=dmg_font)

    divider_y = title_y + 44
    draw.line([(x0 + left_pad, divider_y), (x1 - right_pad, divider_y)], fill=theme["frame2"], width=2)
    draw.line([(x0 + left_pad, divider_y + 3), (x1 - right_pad, divider_y + 3)], fill=_darken(theme["frame2"], 0.35), width=1)

    flavor_font = _load_font(20, bold=False)
    flavor_lines = _wrap_lines(draw, str(attack.get("flavor") or ""), flavor_font, (x1 - x0) - (left_pad + right_pad), max_lines=2)
    fy = divider_y + 14
    for line in flavor_lines[:2]:
      draw.text((x0 + left_pad, fy), line, fill=_lighten(theme["dim"], 0.02), font=flavor_font)
      fy += 28

    # energy stripe + small pattern
    stripe_color = _lighten(theme["frame2"], 0.08)
    draw.rectangle([(x0 + 10, y1 - 12), (x1 - 10, y1 - 8)], fill=stripe_color)
    for px in range(x0 + 16, x1 - 20, 30):
      draw.rectangle([(px, y1 - 18), (px + 10, y1 - 14)], fill=_darken(theme["frame2"], 0.15))

  # foil/sparkle overlay on frame
  for i in range(0, W, 24):
    if (i // 24) % 5 == 0:
      draw.point((i + 12, 36), fill=theme["aura"])
      draw.point((W - i - 18, H - 36), fill=theme["aura"])
      if rarity in ("Legendary", "Cursed"):
        draw.point((i + 11, 37), fill=(255, 255, 255))

  # final prismatic sheen across full card
  _draw_gloss_overlay(img, (30, 30, W - 30, H - 30), _lighten(theme["aura"], 0.35), alpha=18)

  out_path.parent.mkdir(parents=True, exist_ok=True)
  img.convert("RGB").save(out_path, "PNG", optimize=True)
  return W, H


def main() -> int:
  try:
    payload = _read_payload()
    card = payload.get("card")
    out_path = Path(str(payload.get("outPath") or "")).resolve()
    if not isinstance(card, dict):
      raise ValueError("Missing card object")
    if not str(out_path):
      raise ValueError("Missing outPath")
    width, height = _render_card(card, out_path)
    sys.stdout.write(json.dumps({"ok": True, "width": width, "height": height, "file": out_path.name}))
    return 0
  except Exception as exc:
    sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}))
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
