#!/usr/bin/env python3
"""Generate clean wheel/stick layers from the banner pinwheel via fal.ai image edit.

Usage: FAL_KEY=... python3 site/gen-pinwheel-layers.py
Writes site/assets/gen-wheel-raw.png and site/assets/gen-stick-raw.png.
"""
import base64
import json
import os
import sys
import urllib.request

KEY = os.environ.get("FAL_KEY")
if not KEY:
    sys.exit("FAL_KEY env var not set")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "assets", "banner.png")

with open(SRC, "rb") as f:
    data_uri = "data:image/png;base64," + base64.b64encode(f.read()).decode()

JOBS = {
    "gen-wheel-raw.png": (
        "From this banner, extract only the pinwheel wheel — the four "
        "curled paper blades (magenta, red, yellow, purple) and the small yellow pin at "
        "the center — perfectly centered in the frame, no stick, no text, no logo, floating on a "
        "plain flat cream background (#FFF0D7). Keep the exact same pinwheel, same "
        "colors, same lighting, same soft shadow style."
    ),
    "gen-stick-raw.png": (
        "From this banner, extract only the pinwheel's plain wooden stick — full length "
        "including the rounded top end that was hidden behind the blades — no blades, no "
        "text, no logo, centered on a plain flat cream background (#FFF0D7). Same "
        "lighting and soft shadow."
    ),
}

for out_name, prompt in JOBS.items():
    req = urllib.request.Request(
        "https://fal.run/fal-ai/nano-banana/edit",
        data=json.dumps({
            "prompt": prompt,
            "image_urls": [data_uri],
            "num_images": 1,
            "output_format": "png",
        }).encode(),
        headers={"Authorization": "Key " + KEY, "Content-Type": "application/json"},
    )
    print("generating", out_name, "...")
    with urllib.request.urlopen(req, timeout=300) as r:
        result = json.load(r)
    url = result["images"][0]["url"]
    out_path = os.path.join(HERE, "assets", out_name)
    if url.startswith("data:"):
        payload = base64.b64decode(url.split(",", 1)[1])
        with open(out_path, "wb") as f:
            f.write(payload)
    else:
        urllib.request.urlretrieve(url, out_path)
    print("  saved", out_path)
