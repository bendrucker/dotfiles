import re

import references
from git_context import Forge
from references import References
from results import Link

GITHUB = Forge(host="github.com", path="bendrucker/dotfiles", kind="github")
GITLAB = Forge(host="gitlab.com", path="group/proj", kind="gitlab")


def refs(
    forge: Forge | None = None,
    commit=lambda _: False,
    links: dict[str, str] | None = None,
) -> References:
    return References(
        get_forge=lambda: forge,
        commit_exists=commit,
        link_target=lambda text: (links or {}).get(text),
    )


def find(regex: re.Pattern[str], text: str) -> re.Match[str]:
    m = regex.search(text)
    assert m is not None
    return m


def all_matches(regex: re.Pattern[str], text: str) -> list[str]:
    return [m.group(0) for m in regex.finditer(text)]


# --- issue / PR (#N) ---


def test_issue_regex_matches_bare_hash_only():
    text = "Merge pull request #454 from foo (#453) bare#99 a/b#1 color #1a2b"
    assert all_matches(references.ISSUE_RE, text) == ["#454", "#453"]


def test_issue_kept_in_repo():
    m = find(references.ISSUE_RE, "see #454")
    candidate = refs(GITHUB).issue_pre(m)
    assert candidate is not None and candidate.tag == "issue"
    assert refs(GITHUB).issue_post(m) == Link(
        "https://github.com/bendrucker/dotfiles/issues/454"
    )


def test_issue_dropped_outside_repo():
    m = find(references.ISSUE_RE, "see #454")
    assert refs(None).issue_pre(m) is None


# --- issue/PR resolved from an OSC 8 hyperlink target ---


def test_issue_labeled_pr_from_link_target():
    pr = "https://github.com/bendrucker/dotfiles/pull/497"
    m = find(references.ISSUE_RE, "shipped #497")
    r = refs(GITHUB, links={"#497": pr})
    candidate = r.issue_pre(m)
    assert candidate is not None and candidate.tag == "PR"
    assert r.issue_post(m) == Link(pr)


def test_issue_uses_exact_link_target_when_an_issue():
    url = "https://github.com/bendrucker/dotfiles/issues/12"
    m = find(references.ISSUE_RE, "see #12")
    r = refs(GITHUB, links={"#12": url})
    candidate = r.issue_pre(m)
    assert candidate is not None and candidate.tag == "issue"
    assert r.issue_post(m) == Link(url)


def test_issue_kept_when_hyperlinked_outside_repo():
    pr = "https://github.com/some/repo/pull/3"
    m = find(references.ISSUE_RE, "see #3")
    r = refs(None, links={"#3": pr})
    candidate = r.issue_pre(m)
    assert candidate is not None and candidate.tag == "PR"
    assert r.issue_post(m) == Link(pr)


# --- gitlab merge request (!N) ---


def test_merge_request_kept_on_gitlab():
    m = find(references.MERGE_REQUEST_RE, "see !42")
    candidate = refs(GITLAB).merge_request_pre(m)
    assert candidate is not None and candidate.tag == "MR"
    assert refs(GITLAB).merge_request_post(m) == Link(
        "https://gitlab.com/group/proj/merge_requests/42"
    )


def test_merge_request_dropped_on_github():
    m = find(references.MERGE_REQUEST_RE, "see !42")
    assert refs(GITHUB).merge_request_pre(m) is None


# --- cross-repo (owner/repo#N) ---


def test_cross_repo_defaults_to_github():
    m = find(references.CROSS_REPO_RE, "fixed alberti42/tmux-fzf-links#12")
    assert refs(None).cross_repo_post(m) == Link(
        "https://github.com/alberti42/tmux-fzf-links/issues/12"
    )


def test_cross_repo_uses_gitlab_host_when_present():
    m = find(references.CROSS_REPO_RE, "see a/b#3")
    assert (
        refs(GITLAB)
        .cross_repo_post(m)
        .url.startswith("https://gitlab.com/a/b/issues/3")
    )


def test_cross_repo_prefers_link_target():
    pr = "https://github.com/alberti42/tmux-fzf-links/pull/12"
    m = find(references.CROSS_REPO_RE, "fixed alberti42/tmux-fzf-links#12")
    r = refs(None, links={"alberti42/tmux-fzf-links#12": pr})
    assert r.cross_repo_post(m) == Link(pr)


# --- commit SHA ---


def test_commit_validated_against_repo():
    r = refs(GITHUB, commit=lambda sha: sha == "c91b594c5fa")
    text = "good c91b594c5fa fake deadbeef1234 number 12345678"
    kept = [
        m.group("sha") for m in references.COMMIT_RE.finditer(text) if r.commit_pre(m)
    ]
    assert kept == ["c91b594c5fa"]


def test_commit_dropped_outside_repo():
    m = find(references.COMMIT_RE, "c91b594c5fa")
    assert refs(None).commit_pre(m) is None


def test_commit_kept_when_hyperlinked():
    url = "https://github.com/some/repo/commit/c91b594c5fa"
    m = find(references.COMMIT_RE, "c91b594c5fa")
    r = refs(None, links={"c91b594c5fa": url})
    assert r.commit_pre(m) is not None
    assert r.commit_post(m) == Link(url)


# --- localhost ---


def test_localhost_requires_port():
    assert all_matches(references.LOCALHOST_RE, "localhost alone") == []
    assert all_matches(
        references.LOCALHOST_RE, "on localhost:3000 and 127.0.0.1:8080"
    ) == [
        "localhost:3000",
        "127.0.0.1:8080",
    ]


def test_localhost_post_builds_http_url():
    m = find(references.LOCALHOST_RE, "localhost:3000")
    assert refs().localhost_post(m) == Link("http://localhost:3000")
