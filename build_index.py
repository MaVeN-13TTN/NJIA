"""
Njia RAG — Step 2: Chunk the scraped/curated pages and build a BM25 index.

Reads:  data/raw/*.md  (from scrape.py, PLUS any hand-written pack files —
        drop your verified fee table / document list in here as e.g.
        knowledge-pack.md with the same ---source/verified--- header)
Writes: data/index/chunks.json  (chunks + metadata; BM25 is rebuilt at load
        time in retrieve.py — it's instant for a corpus this small)

Run:  python build_index.py
"""

import json
import re
from pathlib import Path

RAW_DIR = Path(__file__).parent / "data" / "raw"
INDEX_DIR = Path(__file__).parent / "data" / "index"

MAX_CHUNK_CHARS = 1200   # ~300 tokens; small chunks = precise retrieval
OVERLAP_CHARS = 150


def parse_file(path: Path):
    text = path.read_text(encoding="utf-8")
    meta = {"source": str(path.name), "verified": "unknown"}
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip()
        text = text[m.end():]
    return meta, text.strip()


def split_by_headings(text: str):
    """Split on markdown headings so chunks respect topical boundaries."""
    parts = re.split(r"(?m)^(#{1,4} .+)$", text)
    sections = []
    current_heading = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if re.match(r"^#{1,4} ", part):
            current_heading = part.lstrip("# ").strip()
        else:
            sections.append((current_heading, part))
    return sections or [("", text)]


def chunk_section(heading: str, body: str):
    """Window long sections; short ones pass through whole."""
    if len(body) <= MAX_CHUNK_CHARS:
        return [body]
    chunks, start = [], 0
    while start < len(body):
        end = start + MAX_CHUNK_CHARS
        # try to break on a sentence/line boundary
        if end < len(body):
            brk = max(body.rfind("\n", start, end), body.rfind(". ", start, end))
            if brk > start + 200:
                end = brk + 1
        chunks.append(body[start:end].strip())
        start = max(end - OVERLAP_CHARS, start + 1)
    return chunks


def build():
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    all_chunks = []
    files = sorted(p for p in RAW_DIR.glob("*.md"))
    if not files:
        raise SystemExit(f"No .md files in {RAW_DIR} — run scrape.py first "
                         "or drop your knowledge-pack files there.")
    for path in files:
        meta, text = parse_file(path)
        for heading, body in split_by_headings(text):
            for piece in chunk_section(heading, body):
                content = f"{heading}\n{piece}" if heading else piece
                all_chunks.append({
                    "id": len(all_chunks),
                    "text": content,
                    "heading": heading,
                    "source": meta.get("source", path.name),
                    "verified": meta.get("verified", "unknown"),
                })
    out = INDEX_DIR / "chunks.json"
    out.write_text(json.dumps(all_chunks, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Built {len(all_chunks)} chunks from {len(files)} files -> {out}")


if __name__ == "__main__":
    build()
