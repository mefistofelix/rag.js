# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["indra-ocr==0.3.2", "onnxruntime==1.30.0"]
# ///
"""Official full Python pipeline oracle; optional, never a rag.js dependency."""
import json
import hashlib
import platform
import statistics
import time
import sys
from pathlib import Path

import indra_ocr
import onnxruntime

root = Path("build/indra-test")
revision = "ed345c7f158eddbc7dee0c6a7269afb75a94f7e8"
models = root / "cpu/models/indra" / revision
started = time.perf_counter()
converter = indra_ocr.load(path=models, threads=4)
setup_ms = (time.perf_counter() - started) * 1000
manifest_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/fixtures/manifest.json")
output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else root / "python-reference.json"
manifest = json.loads(manifest_path.read_text("utf-8"))
rows = []
for item in manifest:
    if not item.get("image"):
        continue
    samples = []
    for run in range(4):
        started = time.perf_counter()
        pages = list(converter.convert(manifest_path.parent / item["image"]))
        elapsed = (time.perf_counter() - started) * 1000
        samples.append(elapsed)
    rows.append({
        "id": item["id"],
        "imageSha256": hashlib.sha256((manifest_path.parent / item["image"]).read_bytes()).hexdigest(),
        "coldMs": samples[0],
        "warmMedianMs": statistics.median(samples[1:]),
        "text": "\n".join(page.text for _, page in pages),
        "sources": [page.source for _, page in pages],
    })
report = {
    "platform": platform.platform(),
    "python": platform.python_version(),
    "indra": indra_ocr.__version__,
    "onnxruntime": onnxruntime.__version__,
    "modelRevision": revision,
    "setupMs": setup_ms,
    "notes": ["Official full pipeline; includes deskew and learned layout, unlike the experimental JS hook."],
    "rows": rows,
}
output_path.write_text(json.dumps(report, indent=2), "utf-8")
print(json.dumps({"fixtures": len(rows), "setupMs": setup_ms, "python": report["python"]}))
