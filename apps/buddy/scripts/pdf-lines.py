"""Extract text lines with geometry from a PDF, for datasheets laid out as label/value
rows without ruled table borders. Words are grouped into lines by their vertical
position; a line keeps every word's x-range so a caller can tell label from value
by column instead of guessing at whitespace. No OCR or model inference.
"""
import json
import sys
import pdfplumber

if pdfplumber.__version__ != "0.11.9":
    raise RuntimeError("Use pdfplumber==0.11.9 for reproducible extraction")

result = []
with pdfplumber.open(sys.argv[1]) as document:
    for number, page in enumerate(document.pages, 1):
        words = page.extract_words(x_tolerance=2, y_tolerance=3, keep_blank_chars=False)
        lines = []
        for word in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
            if lines and abs(lines[-1]["top"] - word["top"]) <= 3:
                lines[-1]["words"].append({"text": word["text"], "x0": round(word["x0"], 1), "x1": round(word["x1"], 1)})
            else:
                lines.append({"top": round(word["top"], 1), "words": [{"text": word["text"], "x0": round(word["x0"], 1), "x1": round(word["x1"], 1)}]})
        for line in lines:
            line["words"].sort(key=lambda w: w["x0"])
            line["text"] = " ".join(w["text"] for w in line["words"])
        result.append({"page": number, "width": round(page.width, 1), "lines": lines})
json.dump(result, sys.stdout, ensure_ascii=False)
