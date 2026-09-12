"""Extract geometric table cells with pdfplumber; retain merged-cell bounds.

Run with a Python environment containing pdfplumber. Original PDF hashes are
validated by the caller. No OCR or model inference is performed here.
"""
import json
import sys
import pdfplumber

if pdfplumber.__version__ != "0.11.9":
    raise RuntimeError("Use pdfplumber==0.11.9 for reproducible table extraction")

result = []
with pdfplumber.open(sys.argv[1]) as document:
    for number, page in enumerate(document.pages, 1):
        for table in page.find_tables():
            rows = []
            for row in table.rows:
                cells = []
                for bounds in row.cells:
                    if bounds is not None:
                        value = page.crop(bounds).extract_text(x_tolerance=2) or ""
                        cells.append({"bounds": list(bounds), "text": " ".join(value.split())})
                rows.append(cells)
            result.append({"page": number, "rows": rows})
json.dump(result, sys.stdout, ensure_ascii=False)
