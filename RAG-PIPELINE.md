# Njia RAG pipeline

Three steps, three files. Corpus is tiny by design — targeted pages, not a crawl.

## Setup
    pip install requests beautifulsoup4 rank_bm25

## Run
    python scrape.py        # fetches targeted immigration.go.ke pages -> data/raw/
    # >>> MANUALLY REVIEW data/raw/*.md — delete junk, fix facts. This IS the
    # >>> "verified on build night" step from the brief. Add knowledge-pack.md
    # >>> with the fee table / doc list you verify tonight.
    python build_index.py   # chunks + writes data/index/chunks.json
    python retrieve.py "how much does a passport cost?"   # smoke test

## Wiring into Blessed's proxy
    from retrieve import grounding_block

    system_prompt = BASE_SYSTEM_PROMPT + "\n\n" + grounding_block(
        question=user_question,
        page_context=sanitized_page_structure,   # from the extension
    )
    # then call the Anthropic API as normal

`page_context` is folded into the retrieval query, so answers are step-aware
(payment-page context pulls fee/invoice chunks) — the differentiator from the brief.

## Optional embeddings
    pip install sentence-transformers
    USE_EMBEDDINGS=1 python retrieve.py "..."
BM25 shortlists, MiniLM reranks. ~90MB model download — decide before midnight,
not at 2 AM on venue wifi. For this corpus size BM25 alone is usually enough.

## Gotchas
- immigration.go.ke is Elementor/WordPress: heavy boilerplate. scrape.py strips
  nav/footer, but eyeball every file — some pages may need selector tweaks.
- If a page extracts <200 chars, the content is probably in a different
  container; inspect and add a selector to extract_main().
- Fee schedules may live in PDFs/notices — if so, copy the numbers by hand into
  knowledge-pack.md with the source URL. Hand-curated beats badly-parsed.
- chunks.json is committed state; BM25 rebuilds from it in <1s at import time.
