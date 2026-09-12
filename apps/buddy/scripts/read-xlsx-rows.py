"""Read-only extraction of every worksheet row of an XLSX file, first sheet only, as JSON."""
import datetime
import json
import sys
import openpyxl

if openpyxl.__version__ != "3.1.5":
    raise RuntimeError("This reader requires openpyxl==3.1.5")
workbook = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True, keep_links=False)
try:
    sheet = workbook.worksheets[0]
    # A read-only sheet iterates to its declared dimension, which can be far past the last
    # value; stop after a long run of empty rows instead of reading the declared size.
    rows, empty = [], 0
    for row in sheet.iter_rows(values_only=True):
        if all(cell is None for cell in row):
            empty += 1
            if empty > 200:
                break
            continue
        empty = 0
        rows.append([cell.isoformat()[:10] if isinstance(cell, (datetime.datetime, datetime.date)) else cell for cell in row])
        if len(rows) > 20000:
            raise ValueError("Unexpected worksheet size")
    print(json.dumps(rows, ensure_ascii=False, default=str))
finally:
    workbook.close()
