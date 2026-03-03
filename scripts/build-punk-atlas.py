#!/usr/bin/env python3

from pathlib import Path
from PIL import Image


TILE = 24
COLS = 100
ROWS = 100


def main() -> None:
    app_dir = Path(__file__).resolve().parent.parent
    repo_root = app_dir.parent.parent
    source_dir = repo_root / "transparent"
    output_dir = app_dir / "static"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "punks-atlas.png"

    atlas = Image.new("RGBA", (COLS * TILE, ROWS * TILE), (0, 0, 0, 0))

    for token_id in range(COLS * ROWS):
        src = source_dir / f"{token_id}.png"
        if not src.exists():
            continue
        with Image.open(src) as image:
            tile = image.convert("RGBA")
        x = (token_id % COLS) * TILE
        y = (token_id // COLS) * TILE
        atlas.paste(tile, (x, y))

    atlas.save(output_path, format="PNG", optimize=True)
    print(output_path)


if __name__ == "__main__":
    main()
