import pytest

from osc8 import parse_links, url_kind

ESC = "\x1b"
ST = f"{ESC}\\"


def link(uri: str, text: str, params: str = "") -> str:
    return f"{ESC}]8;{params};{uri}{ST}{text}{ESC}]8;;{ST}"


def test_parse_extracts_text_to_uri():
    pr = "https://github.com/bendrucker/dotfiles/pull/497"
    data = f"shipped {link(pr, 'bendrucker/dotfiles#497', params='id=7jn05')} today"
    assert parse_links(data) == {"bendrucker/dotfiles#497": pr}


def test_parse_strips_sgr_codes_inside_text():
    pr = "https://github.com/o/r/pull/497"
    # Claude Code wraps the visible text in color codes and leaves a trailing
    # reset before the closing OSC 8 sequence.
    data = f"{ESC}[94m{link(pr, f'#497{ESC}[0m{ESC}[38;5;246m')}"
    assert parse_links(data) == {"#497": pr}


def test_parse_drops_ambiguous_text():
    a = link("https://x/issues/1", "#1")
    b = link("https://x/pull/1", "#1")
    assert parse_links(a + b) == {}


def test_parse_accepts_bel_terminator():
    bel = "\x07"
    uri = "https://example.com/issues/9"
    data = f"{ESC}]8;;{uri}{bel}#9{ESC}]8;;{bel}"
    assert parse_links(data) == {"#9": uri}


def test_parse_ignores_plain_text():
    assert parse_links("no links here #123") == {}


@pytest.mark.parametrize(
    ("url", "kind"),
    [
        ("https://github.com/o/r/pull/497", "pr"),
        ("https://gitlab.com/g/p/-/merge_requests/7", "pr"),
        ("https://github.com/o/r/issues/12", "issue"),
        ("https://github.com/o/r/commit/c91b594", "commit"),
        ("https://example.com/whatever", "other"),
    ],
)
def test_url_kind(url: str, kind: str):
    assert url_kind(url) == kind
