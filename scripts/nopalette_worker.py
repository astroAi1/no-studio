#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import sys
from typing import Dict, Iterable, List, Tuple

from PIL import Image


def _hex_to_rgb(hex_str: str) -> Tuple[int, int, int]:
    s = str(hex_str or "").strip().lstrip("#")
    if len(s) != 6:
        raise ValueError(f"invalid hex color: {hex_str}")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return "#{:02X}{:02X}{:02X}".format(rgb[0], rgb[1], rgb[2])


def _load_rgba_24(path: str) -> Image.Image:
    img = Image.open(path).convert("RGBA")
    if img.size != (24, 24):
        img = img.resize((24, 24), Image.Resampling.NEAREST)
    return img


def _image_from_rgba_bytes(rgba_bytes: bytes) -> Image.Image:
    if len(rgba_bytes) != 24 * 24 * 4:
        raise ValueError("invalid rgba24 byte length")
    return Image.frombytes("RGBA", (24, 24), rgba_bytes)


def _inspect(input_path: str) -> Dict:
    img = _load_rgba_24(input_path)
    rgba = img.tobytes()
    pixels = list(img.getdata())
    seen = set()
    palette = []
    for r, g, b, a in pixels:
        if a == 0:
            continue
        key = (r, g, b)
        if key in seen:
            continue
        seen.add(key)
        palette.append(_rgb_to_hex(key))
    return {
        "ok": True,
        "width": 24,
        "height": 24,
        "rgba24B64": base64.b64encode(rgba).decode("ascii"),
        "paletteHex": palette,
        "rgba24Sha256": hashlib.sha256(rgba).hexdigest(),
    }


def _remap_source_pixels(src_pixels: Iterable[Tuple[int, int, int, int]], mapping: Dict[str, str], roles: Dict[str, str]) -> List[Tuple[int, int, int, int]]:
    bg_rgb = _hex_to_rgb(roles.get("backgroundHex") or roles.get("background") or "#000000")
    ol_rgb = _hex_to_rgb(roles.get("outlineHex") or roles.get("outline") or "#040404")
    map_rgb = {}
    for src_hex, dst_hex in (mapping or {}).items():
        map_rgb[str(src_hex).upper()] = _hex_to_rgb(dst_hex)

    remapped = []
    for r, g, b, a in src_pixels:
        if a == 0:
            remapped.append((*bg_rgb, 255))
            continue
        if (r, g, b) == (0, 0, 0):
            remapped.append((*bg_rgb, 255))
            continue
        if (r, g, b) == (4, 4, 4):
            remapped.append((*ol_rgb, 255))
            continue
        key = "#{:02X}{:02X}{:02X}".format(r, g, b)
        dst = map_rgb.get(key, (r, g, b))
        remapped.append((*dst, 255))
    return remapped


def _palette_from_pixels(pixels: Iterable[Tuple[int, int, int, int]]) -> List[str]:
    out_palette = []
    seen = set()
    for r, g, b, a in pixels:
        key = (r, g, b)
        if key in seen:
            continue
        seen.add(key)
        out_palette.append(_rgb_to_hex(key))
    return out_palette


def _write_png(img: Image.Image, output_path: str) -> None:
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    img.save(output_path, format="PNG")


def _noise_at(x: int, y: int, seed: int = 0, salt: int = 0) -> float:
    n = (
        (((x + 1) * 73856093)
         ^ ((y + 1) * 19349663)
         ^ ((seed + 1) * 83492791)
         ^ ((salt + 1) * 2654435761))
        & 0xFFFFFFFF
    )
    n ^= (n << 13) & 0xFFFFFFFF
    n ^= (n >> 17) & 0xFFFFFFFF
    n ^= (n << 5) & 0xFFFFFFFF
    return (n % 10000) / 10000.0


def _parse_occupied_pixels(raw: Iterable[str]) -> set:
    out = set()
    for entry in raw or []:
        try:
            xs, ys = str(entry).split(",", 1)
            x = int(xs)
            y = int(ys)
        except Exception:
            continue
        if 0 <= x < 24 and 0 <= y < 24:
            out.add((x, y))
    return out


def _render(input_path: str, output_path: str, size: int, mapping: Dict[str, str], roles: Dict[str, str], rgba24_b64: str = None) -> Dict:
    if rgba24_b64:
        remap_bytes = base64.b64decode(rgba24_b64)
        remap_img = _image_from_rgba_bytes(remap_bytes)
        remapped = list(remap_img.getdata())
    else:
        img = _load_rgba_24(input_path)
        src_pixels = list(img.getdata())
        remapped = _remap_source_pixels(src_pixels, mapping, roles)
        remap_img = Image.new("RGBA", (24, 24))
        remap_img.putdata(remapped)
        remap_bytes = remap_img.tobytes()

    out_size = int(size or 1024)
    if out_size <= 0:
        out_size = 1024
    upscale = remap_img.resize((out_size, out_size), Image.Resampling.NEAREST)
    _write_png(upscale, output_path)

    output_bytes = upscale.tobytes()
    out_palette = _palette_from_pixels(remapped)

    return {
        "ok": True,
        "outputPath": output_path,
        "width": out_size,
        "height": out_size,
        "output24Sha256": hashlib.sha256(remap_bytes).hexdigest(),
        "output1024Sha256": hashlib.sha256(output_bytes).hexdigest(),
        "paletteHex": out_palette,
    }


def _render_grid(output_path: str, cell_size: int, columns: int, rows: int, frames: List[str]) -> Dict:
    width = int(columns) * int(cell_size)
    height = int(rows) * int(cell_size)
    if width <= 0 or height <= 0:
        raise ValueError("invalid grid size")

    sheet = Image.new("RGBA", (width, height), (0, 0, 0, 255))
    used_frames = []
    raw_frames = []
    for index, frame_b64 in enumerate(frames or []):
        if index >= int(columns) * int(rows):
            break
        rgba_bytes = base64.b64decode(frame_b64)
        img24 = _image_from_rgba_bytes(rgba_bytes)
        raw_frames.append(rgba_bytes)
        panel = img24.resize((int(cell_size), int(cell_size)), Image.Resampling.NEAREST)
        x = (index % int(columns)) * int(cell_size)
        y = (index // int(columns)) * int(cell_size)
        sheet.paste(panel, (x, y))
        used_frames.append({
            "index": index,
            "x": x,
            "y": y,
        })

    _write_png(sheet, output_path)
    output_bytes = sheet.tobytes()
    return {
        "ok": True,
        "outputPath": output_path,
        "width": width,
        "height": height,
        "panelCount": len(used_frames),
        "framesSha256": [hashlib.sha256(frame).hexdigest() for frame in raw_frames],
        "outputSha256": hashlib.sha256(output_bytes).hexdigest(),
    }


def _render_noise_gif(output_path: str, rgba24_b64: str, occupied_pixels: List[str], grain: Dict, size: int, frames: int, duration_ms: int) -> Dict:
    if not rgba24_b64:
        raise ValueError("rgba24B64 is required")

    grain_cfg = grain or {}
    amount = max(0.0, min(1.0, float(grain_cfg.get("amount") or 0.0)))
    enabled = bool(grain_cfg.get("enabled", True)) and amount > 0
    if not enabled:
        raise ValueError("Animated GIF export requires active grain")

    target = str(grain_cfg.get("target") or "background")
    active_hex = str(grain_cfg.get("activeHex") or "").strip().upper() or None
    seed = max(0, int(grain_cfg.get("seed") or 0))

    out_size = int(size or 1024)
    if out_size <= 0:
        out_size = 1024
    frame_count = max(8, min(24, int(frames or 12)))
    total_duration = max(200, int(duration_ms or 1000))
    frame_duration = max(20, round(total_duration / frame_count))

    base24 = _image_from_rgba_bytes(base64.b64decode(rgba24_b64)).convert("RGBA")
    base = base24.resize((out_size, out_size), Image.Resampling.NEAREST).convert("RGBA")
    base24_pixels = list(base24.getdata())
    occupied = _parse_occupied_pixels(occupied_pixels)
    pixel_scale = out_size / 24.0

    frames_out = []
    salt = len(target)
    for frame_idx in range(frame_count):
        frame = base.copy()
        px = frame.load()
        frame_seed = seed + (frame_idx * 17)

        for gy in range(out_size):
            sy = min(23, int(gy / pixel_scale))
            for gx in range(out_size):
                sx = min(23, int(gx / pixel_scale))
                is_occupied = (sx, sy) in occupied

                if target == "background":
                    if is_occupied:
                        continue
                elif target == "figure":
                    if not is_occupied:
                        continue
                else:
                    if not is_occupied or not active_hex:
                        continue
                    br, bg, bb, _ = base24_pixels[(sy * 24) + sx]
                    if _rgb_to_hex((br, bg, bb)) != active_hex:
                        continue

                n = _noise_at(gx, gy, frame_seed, salt + frame_idx)
                centered = (n - 0.5) * 2.0
                intensity = abs(centered) * (0.08 + (amount * 0.22))
                if intensity < 0.012:
                    continue

                alpha = max(0.0, min(1.0, intensity))
                r, g, b, _a = px[gx, gy]
                if centered > 0:
                    nr = int(round(r + ((255 - r) * alpha)))
                    ng = int(round(g + ((255 - g) * alpha)))
                    nb = int(round(b + ((255 - b) * alpha)))
                else:
                    nr = int(round(r * (1.0 - alpha)))
                    ng = int(round(g * (1.0 - alpha)))
                    nb = int(round(b * (1.0 - alpha)))
                px[gx, gy] = (max(0, min(255, nr)), max(0, min(255, ng)), max(0, min(255, nb)), 255)

        frames_out.append(frame)

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    first, rest = frames_out[0], frames_out[1:]
    first.save(
        output_path,
        format="GIF",
        save_all=True,
        append_images=rest,
        duration=frame_duration,
        loop=0,
        optimize=False,
        disposal=2,
    )

    file_bytes = os.path.getsize(output_path)
    with open(output_path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()

    return {
        "ok": True,
        "outputPath": output_path,
        "width": out_size,
        "height": out_size,
        "frames": frame_count,
        "durationMs": frame_duration * frame_count,
        "bytes": file_bytes,
        "outputSha256": digest,
    }


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"invalid json: {e}"}))
        return 1

    command = req.get("command")
    try:
        if command == "inspect":
            result = _inspect(req["inputPath"])
        elif command == "render":
            result = _render(
                req.get("inputPath"),
                req["outputPath"],
                int(req.get("size") or 1024),
                req.get("mapping") or {},
                req.get("roles") or {},
                req.get("rgba24B64"),
            )
        elif command == "render_grid":
            result = _render_grid(
                req["outputPath"],
                int(req.get("cellSize") or 512),
                int(req.get("columns") or 3),
                int(req.get("rows") or 2),
                req.get("frames") or [],
            )
        elif command == "render_noise_gif":
            result = _render_noise_gif(
                req["outputPath"],
                req.get("rgba24B64"),
                req.get("occupiedPixels") or [],
                req.get("grain") or {},
                int(req.get("size") or 1024),
                int(req.get("frames") or 12),
                int(req.get("durationMs") or 1000),
            )
        else:
            raise ValueError("unknown command")
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
