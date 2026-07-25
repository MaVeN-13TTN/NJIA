"""Bridge between the Node proxy and Adiel's RAG pipeline (repo root).

Reads {"question": ..., "page_context": ...} as JSON on stdin, prints the
grounding block (verified knowledge + answer rules) on stdout. Imports
retrieve.py exactly as RAG-PIPELINE.md documents — no changes to the pipeline.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from retrieve import grounding_block  # noqa: E402

payload = json.load(sys.stdin)
print(grounding_block(payload.get("question", ""), payload.get("page_context", "")))
