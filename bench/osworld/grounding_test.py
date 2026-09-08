# -*- coding: utf-8 -*-
"""Measure how well a model can point at a widget, before trusting it to drive a GUI.

A model can describe a screenshot correctly and still be unable to say *where* to
click, and those two abilities fail independently. OSWorld needs the second one,
so it gets its own check on a synthetic screen whose true coordinates are known
exactly -- no VM boot, no task, about a minute per model.

    OPENAI_BASE_URL=... OPENAI_API_KEY=... python grounding_test.py --model <id>
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import urllib.request

from PIL import Image, ImageDraw


def build_screen(width=1920, height=1080):
    """A spreadsheet-like screen, plus the ground-truth centre of every target."""
    img = Image.new("RGB", (width, height), (250, 250, 250))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, width, 60], fill=(60, 90, 150))
    for i, label in enumerate(["File", "Edit", "View", "Insert", "Format", "Tools", "Data"]):
        draw.text((20 + i * 90, 22), label, fill=(255, 255, 255))

    x0, y0, cw, chh = 80, 120, 150, 34
    headers = ["Name", "Hours", "Rate", "Total", "Dept", "Date", "Note", "Flag"]
    truth = {}
    for row in range(12):
        for col in range(8):
            x, y = x0 + col * cw, y0 + row * chh
            draw.rectangle([x, y, x + cw, y + chh], outline=(180, 180, 180))
            name = "%s%d" % (chr(65 + col), row + 1)
            truth[name] = (x + cw // 2, y + chh // 2)
            draw.text((x + 8, y + 10), headers[col] if row == 0 else name,
                      fill=(0, 0, 0) if row == 0 else (120, 120, 120))
    draw.rectangle([1500, 900, 1750, 960], fill=(70, 140, 70))
    draw.text((1580, 922), "Save", fill=(255, 255, 255))
    truth["the green Save button"] = (1625, 930)
    return img, truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--tolerance", type=int, default=40)
    a = ap.parse_args()

    base = os.environ["OPENAI_BASE_URL"].rstrip("/")
    url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    head = {"Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]}

    img, truth = build_screen()
    buf = io.BytesIO()
    img.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    targets = ["C5", "A1", "H12", "D8", "the green Save button"]
    errors = []
    for target in targets:
        question = ("This is a 1920x1080 spreadsheet screenshot. Reply with ONLY the pixel "
                    "coordinate to click the centre of %s, formatted as x,y" % target)
        body = json.dumps({"model": a.model, "max_tokens": 4000, "temperature": 0, "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": question},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]}]}).encode()
        try:
            req = urllib.request.Request(url, data=body, headers=head)
            with urllib.request.urlopen(req, timeout=180) as r:
                text = (json.loads(r.read().decode())["choices"][0]["message"].get("content") or "")
        except Exception as exc:  # noqa: BLE001
            print("%-24s ERROR %s" % (target, str(exc)[:70]))
            continue
        pairs = re.findall(r"(\d{1,4})\s*[, ]\s*(\d{1,4})", text)
        if not pairs:
            print("%-24s no coordinate in %r" % (target, text.strip()[:60]))
            continue
        gx, gy = int(pairs[-1][0]), int(pairs[-1][1])
        tx, ty = truth[target]
        err = ((gx - tx) ** 2 + (gy - ty) ** 2) ** 0.5
        errors.append(err)
        print("%-24s guess=(%4d,%4d) truth=(%4d,%4d) err=%5.0fpx %s"
              % (target, gx, gy, tx, ty, err, "HIT" if err < a.tolerance else ""))

    if errors:
        median = sorted(errors)[len(errors) // 2]
        hits = sum(e < a.tolerance for e in errors)
        print("\n%s: median error %.0fpx, hits %d/%d" % (a.model, median, hits, len(errors)))
    else:
        print("\n%s: produced no usable coordinates at all" % a.model)


if __name__ == "__main__":
    main()
