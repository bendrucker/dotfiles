import functools
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    import pygit2

ForgeKind = Literal["github", "gitlab"]


@dataclass(frozen=True)
class Forge:
    host: str
    path: str  # owner[/subgroups…]/repo
    kind: ForgeKind

    def issue_url(self, number: str) -> str:
        return f"https://{self.host}/{self.path}/issues/{number}"

    def merge_request_url(self, number: str) -> str:
        return f"https://{self.host}/{self.path}/merge_requests/{number}"

    def commit_url(self, sha: str) -> str:
        return f"https://{self.host}/{self.path}/commit/{sha}"


def forge_from_url(url: str) -> Forge | None:
    import giturlparse

    parsed = giturlparse.parse(url)
    if not getattr(parsed, "valid", False):
        return None
    if parsed.platform not in ("github", "gitlab"):
        return None
    segments = [parsed.owner, *parsed.groups, parsed.repo]
    if not all(segments):
        return None
    return Forge(host=parsed.host, path="/".join(segments), kind=parsed.platform)


@functools.lru_cache(maxsize=1)
def _repo() -> pygit2.Repository | None:
    import pygit2

    try:
        path = pygit2.discover_repository(os.getcwd())
        return pygit2.Repository(path) if path else None
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def current_forge() -> Forge | None:
    repo = _repo()
    if repo is None:
        return None
    for remote in ("origin", "upstream"):
        try:
            url = repo.remotes[remote].url
        except KeyError:
            continue
        forge = forge_from_url(url)
        if forge:
            return forge
    return None


@functools.lru_cache(maxsize=256)
def commit_exists(sha: str) -> bool:
    repo = _repo()
    if repo is None:
        return False
    try:
        repo.revparse_single(sha)
        return True
    except Exception:
        return False
