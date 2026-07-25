"""
Njia RAG — Step 3: Retrieve grounding context for a question.

This is the module Blessed's proxy imports. Given the user's question
(and optionally the page context from the extension), it returns a
formatted context block to prepend to the Claude system prompt.

Default retriever: BM25 (rank_bm25). Zero downloads, instant, explainable.
Optional: set USE_EMBEDDINGS=1 to add sentence-transformers reranking
(needs a ~90MB model download — decide early, not at 2 AM on venue wifi).

CLI test:  python retrieve.py "how much does a passport cost?"
"""

import json
import os
import re
import sys
from functools import lru_cache
from pathlib import Path

from rank_bm25 import BM25Okapi

INDEX_FILE = Path(__file__).parent / "data" / "index" / "chunks.json"
TOP_K = 4
USE_EMBEDDINGS = os.environ.get("USE_EMBEDDINGS") == "1"

_word = re.compile(r"[a-z0-9]+")


def _stem(token: str) -> str:
    """Crude suffix stripping so cost/costs, pay/payment/paying match.
    Not linguistically pure — good enough for a small English corpus."""
    for suffix in ("ments", "ment", "ings", "ing", "ies", "es", "s", "ed"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            return token[: -len(suffix)]
    return token


def tokenize(text: str):
    return [_stem(t) for t in _word.findall(text.lower())]


@lru_cache(maxsize=1)
def load_index():
    chunks = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    bm25 = BM25Okapi([tokenize(c["text"]) for c in chunks])
    embedder = emb_matrix = None
    if USE_EMBEDDINGS:
        from sentence_transformers import SentenceTransformer
        embedder = SentenceTransformer("all-MiniLM-L6-v2")
        emb_matrix = embedder.encode([c["text"] for c in chunks],
                                     normalize_embeddings=True)
    return chunks, bm25, embedder, emb_matrix


def search(question: str, page_context: str = "", k: int = TOP_K):
    """page_context: sanitized page structure from the extension —
    concatenated into the query so retrieval is step-aware."""
    chunks, bm25, embedder, emb_matrix = load_index()
    query = f"{question} {page_context}".strip()
    scores = bm25.get_scores(tokenize(query))
    ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)

    if embedder is not None:
        # blend: BM25 shortlist of 3k, rerank by cosine similarity
        shortlist = ranked[: k * 3]
        q_vec = embedder.encode([query], normalize_embeddings=True)[0]
        shortlist.sort(key=lambda i: float(emb_matrix[i] @ q_vec), reverse=True)
        ranked = shortlist

    hits = [chunks[i] for i in ranked[:k] if scores[i] > 0] or [chunks[ranked[0]]]
    return hits


def grounding_block(question: str, page_context: str = "") -> str:
    """The string Blessed prepends to the system prompt."""
    hits = search(question, page_context)
    parts = ["<verified_knowledge>"]
    for h in hits:
        parts.append(
            f'<fact source="{h["source"]}" verified="{h["verified"]}">\n'
            f'{h["text"]}\n</fact>'
        )
    parts.append("</verified_knowledge>")
    parts.append(
        "Answer ONLY from the verified knowledge above. Cite the verification "
        "date when stating fees or requirements. If the knowledge does not "
        "cover the question, say so plainly and point the user to "
        "immigration.go.ke or the eCitizen portal — never guess a fee, "
        "document requirement, or timeline from memory."
    )
    return "\n".join(parts)


if __name__ == "__main__":
    q = " ".join(sys.argv[1:]) or "how much does a passport cost?"
    print(grounding_block(q))
