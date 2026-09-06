from __future__ import annotations

import functools
import re
import subprocess

# OSC 8 hyperlink: ESC ] 8 ; params ; URI ST  text  ESC ] 8 ; ; ST
# ST (string terminator) is ESC \ or BEL. The URI runs to the terminator; the
# visible text may carry its own SGR color codes, stripped out below.
_ST = r"(?:\x1b\\|\x07)"
_HYPERLINK = re.compile(
    rf"\x1b\]8;[^;]*;(?P<uri>[^\x1b\x07]*){_ST}(?P<text>.*?)\x1b\]8;;{_ST}",
    re.DOTALL,
)
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def parse_links(data: str) -> dict[str, str]:
    """Map each hyperlink's visible text to its target URI.

    Text that appears with conflicting URIs is dropped so a lookup never
    resolves to the wrong target.
    """
    found: dict[str, str | None] = {}
    for m in _HYPERLINK.finditer(data):
        text = _ANSI.sub("", m.group("text")).strip()
        uri = m.group("uri").strip()
        if not text or not uri:
            continue
        if text in found and found[text] != uri:
            found[text] = None
        else:
            found.setdefault(text, uri)
    return {text: uri for text, uri in found.items() if uri}


def url_kind(url: str) -> str:
    """Classify a forge URL as 'pr', 'issue', 'commit', or 'other'."""
    if "/pull/" in url or "/merge_requests/" in url:
        return "pr"
    if "/issues/" in url:
        return "issue"
    if "/commit/" in url:
        return "commit"
    return "other"


@functools.lru_cache(maxsize=1)
def _index() -> dict[str, str]:
    try:
        out = subprocess.run(
            ("tmux", "capture-pane", "-p", "-e", "-J", "-S", "-5000"),
            capture_output=True,
            text=True,
            timeout=1.0,
        )
    except Exception:
        return {}
    return parse_links(out.stdout) if out.returncode == 0 else {}


def target_for(text: str) -> str | None:
    """Resolve a matched token to the URL it was hyperlinked to, if any."""
    return _index().get(text)
