#!/usr/bin/env python3
"""Build a macOS .icns file from a 1024px PNG, without iconutil.

Used by scripts/package-mac.sh on Linux, where iconutil does not
exist. On a Mac, iconutil from the .iconset is still the preferred
path and produces the same structure; this generator follows the
same chunk list and order as iconutil (see png2icons, which
documents that order from iconutil 10.14 output).

Why this shape, and not just one PNG per size:
- icp4/icp5/icp6 (PNG for 16/32/64) look fine in Preview but do
  NOT work in Finder, and on macOS 10.15+ PNG small sizes in a
  .app display scrambled. They are deliberately omitted.
- The small sizes Finder actually uses are PackBits RGB plus a
  separate uncompressed alpha mask: is32+s8mk (16) and
  il32+l8mk (32).
- The large and retina sizes are PNG: ic12 (32@2x=64), ic07
  (128), ic13 (128@2x=256), ic08 (256), ic14 (256@2x=512),
  ic09 (512), ic10 (512@2x=1024), ic11 (16@2x=32). Note ic13
  and ic08 share the same 256px PNG, as do ic14 and ic09 at
  512px — that duplication is what iconutil produces too.

Usage: make-icns.py assets/icon.png assets/icon.icns
"""
import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required (pip install Pillow)")


def packbits(data: bytes) -> bytes:
    """PackBits encode one channel, as used by is32/il32.

    Lead byte 0..127: the next (lead+1) bytes are literal.
    Lead byte 128..255: the next byte repeats (lead-128+3) times.
    Runs shorter than 3 are encoded as literals.
    """
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        run = 1
        while i + run < n and data[i + run] == data[i] and run < 130:
            run += 1
        if run >= 3:
            out.append(0x80 + run - 3)
            out.append(data[i])
            i += run
        else:
            start = i
            lit = 0
            while i < n and lit < 128:
                r = 1
                while i + r < n and data[i + r] == data[i] and r < 130:
                    r += 1
                if r >= 3:
                    break
                i += 1
                lit += 1
            out.append(lit - 1)
            out.extend(data[start:start + lit])
    return bytes(out)


def unpackbits(data: bytes, expected: int) -> bytes:
    """Decode PackBits, for the self-check below only."""
    out = bytearray()
    i = 0
    while i < len(data):
        lead = data[i]
        i += 1
        if lead < 0x80:
            out.extend(data[i:i + lead + 1])
            i += lead + 1
        else:
            out.extend([data[i]] * (lead - 0x80 + 3))
            i += 1
    assert len(out) == expected, f"PackBits decode: {len(out)} != {expected}"
    return bytes(out)


def png_bytes(im: Image.Image, size: int) -> bytes:
    buf = io.BytesIO()
    im.resize((size, size), Image.LANCZOS).save(buf, format="PNG")
    return buf.getvalue()


def rgb_and_mask(im: Image.Image, size: int) -> tuple[bytes, bytes]:
    """PackBits RGB (R, then G, then B) and raw alpha mask."""
    resized = im.resize((size, size), Image.LANCZOS).convert("RGBA")
    raw = resized.tobytes()
    r, g, b, a = raw[0::4], raw[1::4], raw[2::4], raw[3::4]
    rgb = b"".join(packbits(ch) for ch in (r, g, b))
    # Self-check: decoding must reproduce the channels exactly,
    # otherwise the small icons would ship scrambled.
    off = 0
    for ch in (r, g, b):
        # Re-encode length is not stored; decode by walking the
        # encoded stream for this channel alone.
        enc = packbits(ch)
        assert unpackbits(enc, size * size) == ch
        off += len(enc)
    assert off == len(rgb)
    return rgb, a


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    im = Image.open(src).convert("RGBA")
    if im.size != (1024, 1024):
        print(f"warning: icon is {im.size}, expected 1024x1024")

    # Chunk list in iconutil order. Each entry is (OSType, data).
    png64 = png_bytes(im, 64)
    png128 = png_bytes(im, 128)
    png256 = png_bytes(im, 256)
    png512 = png_bytes(im, 512)
    png1024 = png_bytes(im, 1024)
    png32 = png_bytes(im, 32)
    rgb32, mask32 = rgb_and_mask(im, 32)
    rgb16, mask16 = rgb_and_mask(im, 16)

    chunks: list[tuple[str, bytes]] = [
        ("ic12", png64),
        ("ic07", png128),
        ("ic13", png256),
        ("ic08", png256),
        ("ic14", png512),
        ("ic09", png512),
        ("ic10", png1024),
        ("ic11", png32),
        ("il32", rgb32),
        ("l8mk", mask32),
        ("is32", rgb16),
        ("s8mk", mask16),
    ]
    body = bytearray()
    for ostype, data in chunks:
        body += ostype.encode("ascii")
        body += struct.pack(">I", 8 + len(data))
        body += data
    out = b"icns" + struct.pack(">I", 8 + len(body)) + bytes(body)
    dst.write_bytes(out)
    print(f"wrote {dst} ({len(out)} bytes, {len(chunks)} entries: "
          + ", ".join(t for t, _ in chunks) + ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
