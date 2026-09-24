#!/usr/bin/env python3
"""Publish a firmware build with the web page: copies the hex to web/firmware/ and writes
web/firmware/manifest.json, which the page's firmware dialog offers to install.

    tools/fwrelease.py [firmware/app/build/dsoq_app1.hex]
"""
import binascii
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/dsoq'))
from protocol import hex_to_image  # noqa: E402

src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'firmware/app/build/dsoq_app1.hex')
image = hex_to_image(src.read_text())
m = re.search(rb'\d+\.\d+\.\d+[\w.-]*\+[0-9a-f]{7,}(?:-dirty)?-\d{8}', image)
if not m:
    sys.exit('no version string in the image')
fw = m.group().decode()
if '-dirty' in fw:
    sys.exit(f'{fw}: built from uncommitted changes; commit and rebuild first')
out = ROOT / 'web/firmware'
out.mkdir(exist_ok=True)
shutil.copy(src, out / 'dsoq_app1.hex')
manifest = {'fw': fw, 'file': 'dsoq_app1.hex', 'size': len(image), 'crc32': f'{binascii.crc32(image):08x}'}
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'web/firmware: {fw} ({len(image)} bytes)')
