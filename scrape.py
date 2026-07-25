"""
Njia RAG — Step 1: Scrape targeted pages from immigration.go.ke
Saves each page as clean markdown-ish text in data/raw/ with metadata header.

Run:  python scrape.py
"""

import json
import re
import time
from datetime import date
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# ── Targeted pages only. Do NOT crawl the whole site at a hackathon. ──
PAGES = {
    "passport-section": "https://immigration.go.ke/passport-section/",
    "faqs": "https://immigration.go.ke/faqs/",
    "service-charter": "https://immigration.go.ke/our-service-charter/",
    "processing-centres": "https://immigration.go.ke/passports-processing-centres/",
    "contact": "https://immigration.go.ke/contact/",
    # add more as you find them, e.g. fee schedule PDFs / notices
}

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept": ("text/html,application/xhtml+xml,application/xml;"
               "q=0.9,*/*;q=0.8"),
    "Accept-Language": "en-US,en;q=0.9",
}
RAW_DIR = Path(__file__).parent / "data" / "raw"

# Elements that are boilerplate on every Elementor/WP page
STRIP_SELECTORS = [
    "nav", "header", "footer", "script", "style", "noscript",
    ".elementor-location-header", ".elementor-location-footer",
    "#masthead", "#colophon", ".menu", ".site-footer", ".widget",
]


def extract_main(soup: BeautifulSoup) -> BeautifulSoup:
    """Prefer the page's main content container; fall back to body."""
    for sel in ["main", ".elementor-location-single", "#content", "article"]:
        node = soup.select_one(sel)
        if node:
            return node
    return soup.body or soup


def clean_text(node: BeautifulSoup) -> str:
    """Convert content to text, keeping heading structure as markdown."""
    lines = []
    for el in node.find_all(["h1", "h2", "h3", "h4", "p", "li", "td", "th"]):
        text = el.get_text(" ", strip=True)
        if not text or len(text) < 3:
            continue
        if el.name in ("h1", "h2", "h3", "h4"):
            level = int(el.name[1])
            lines.append(f"\n{'#' * level} {text}\n")
        elif el.name == "li":
            lines.append(f"- {text}")
        else:
            lines.append(text)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)          # collapse blank runs
    text = re.sub(r"(?m)^(.*)\n\1$", r"\1", text)    # drop consecutive dupes
    return text.strip()


def scrape():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    for slug, url in PAGES.items():
        print(f"Fetching {url} ...")
        r = None
        for attempt in range(3):
            try:
                r = requests.get(url, headers=HEADERS, timeout=30)
                r.raise_for_status()
                break
            except requests.RequestException as e:
                print(f"  attempt {attempt + 1} failed: {e}")
                time.sleep(2 ** attempt * 2)  # 2s, 4s, 8s
        if r is None or not r.ok:
            print("  !! FAILED after retries — skipping")
            continue
        soup = BeautifulSoup(r.text, "html.parser")
        for sel in STRIP_SELECTORS:
            for tag in soup.select(sel):
                tag.decompose()
        text = clean_text(extract_main(soup))
        if len(text) < 200:
            print(f"  ?? Only {len(text)} chars extracted — check selectors for this page")
        header = (
            f"---\nsource: {url}\nslug: {slug}\n"
            f"verified: {date.today().isoformat()}\n---\n\n"
        )
        out = RAW_DIR / f"{slug}.md"
        out.write_text(header + text, encoding="utf-8")
        manifest.append({"slug": slug, "url": url, "chars": len(text)})
        print(f"  -> {out.name} ({len(text)} chars)")
        time.sleep(1)  # be polite to the government server

    (RAW_DIR / "_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nDone. {len(manifest)} pages saved to {RAW_DIR}")
    print("NOW: open each file and sanity-check the content — this is your")
    print("'verified on build night' discipline from the brief. Delete junk lines.")


if __name__ == "__main__":
    scrape()
