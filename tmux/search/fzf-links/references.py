import re
from collections.abc import Callable

from format import AMBER, BLUE, GREEN, LOCAL, ORANGE, colorize
from git_context import Forge
from results import Candidate, Link

ISSUE_RE = re.compile(r"(?<![\w/#!])#(?P<num>\d+)\b")
MERGE_REQUEST_RE = re.compile(r"(?<![\w/#!])!(?P<num>\d+)\b")
CROSS_REPO_RE = re.compile(
    r"\b(?P<owner>[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)/(?P<repo>[A-Za-z0-9][\w.-]*)#(?P<num>\d+)\b"
)
COMMIT_RE = re.compile(r"(?<!\w)(?P<sha>[0-9a-f]{7,40})(?!\w)")
LOCALHOST_RE = re.compile(
    r"(?<![\w.])(?P<host>localhost|127\.0\.0\.1):(?P<port>\d+)(?![\w.])"
)

ForgeProvider = Callable[[], Forge | None]
CommitChecker = Callable[[str], bool]


class References:
    def __init__(self, get_forge: ForgeProvider, commit_exists: CommitChecker) -> None:
        self._get_forge = get_forge
        self._commit_exists = commit_exists

    def issue_pre(self, m: re.Match[str]) -> Candidate | None:
        forge = self._get_forge()
        if not forge:
            return None
        return Candidate(colorize(f"{forge.path}#{m.group('num')}", BLUE), "issue")

    def issue_post(self, m: re.Match[str]) -> Link:
        forge = self._get_forge()
        assert forge  # issue_pre kept this match, so the forge resolved
        return Link(forge.issue_url(m.group("num")))

    def merge_request_pre(self, m: re.Match[str]) -> Candidate | None:
        forge = self._get_forge()
        if not forge or forge.kind != "gitlab":
            return None
        return Candidate(colorize(f"{forge.path}!{m.group('num')}", ORANGE), "MR")

    def merge_request_post(self, m: re.Match[str]) -> Link:
        forge = self._get_forge()
        assert forge
        return Link(forge.merge_request_url(m.group("num")))

    def cross_repo_pre(self, m: re.Match[str]) -> Candidate | None:
        ref = f"{m.group('owner')}/{m.group('repo')}#{m.group('num')}"
        return Candidate(colorize(ref, GREEN), "repo#n")

    def cross_repo_post(self, m: re.Match[str]) -> Link:
        forge = self._get_forge()
        host = forge.host if forge and forge.kind == "gitlab" else "github.com"
        owner, repo, num = m.group("owner"), m.group("repo"), m.group("num")
        return Link(f"https://{host}/{owner}/{repo}/issues/{num}")

    def commit_pre(self, m: re.Match[str]) -> Candidate | None:
        if not self._get_forge():
            return None
        sha = m.group("sha")
        if not self._commit_exists(sha):
            return None
        return Candidate(colorize(sha[:10], AMBER), "commit")

    def commit_post(self, m: re.Match[str]) -> Link:
        forge = self._get_forge()
        assert forge
        return Link(forge.commit_url(m.group("sha")))

    def localhost_pre(self, m: re.Match[str]) -> Candidate | None:
        return Candidate(colorize(m.group(0), LOCAL), "localhost")

    def localhost_post(self, m: re.Match[str]) -> Link:
        return Link(f"http://{m.group('host')}:{m.group('port')}")
