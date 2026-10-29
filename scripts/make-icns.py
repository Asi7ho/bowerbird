#!/usr/bin/env python3
"""Build a macOS .icns file from a 1024px PNG, without iconutil.

Used by scripts/package-mac.sh on Linux, where iconutil does not
exist. On a Mac, iconutil from the .iconset is still the preferred
path and produces the same sizes; this generator uses PNG data for
every size, which macOS accepts for icp4/icp5/icp6/ic07/ic08/ic09/ic10.

Usage: make-icns.py assets/icon.png assets/icon.icns
"""
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required (pip install Pillow)")

SIZES = [
    ("icp4", 16),
    ("icp5", 32),
    ("icp6", 64),
    ("ic07", 128),
    ("ic08", 256),
    ("ic09", 512),
    ("ic10", 1024),
]


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    im = Image.open(src).convert("RGBA")
    if im.size != (1024, 1024):
        print(f"warning: icon is {im.size}, expected 1024x1024")
    body = bytearray()
    for ostype, size in SIZES:
        resized = im.resize((size, size), Image.LANCZOS)
        buf = __import__("io").BytesIO()
        resized.save(buf, format="PNG")
        data = buf.getvalue()
        body += ostype.encode("ascii")
        body += struct.pack(">I", 8 + len(data))
        body += data
    total = 8 + len(body)
    out = b"icns" + struct.pack(">I", total) + bytes(body)
    dst.write_bytes(out)
    print(f"wrote {dst} ({total} bytes, {len(SIZES)} sizes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
