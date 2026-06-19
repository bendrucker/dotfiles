import dataclasses
import re
from collections.abc import Callable

import git_context
import options
from linear import Linear, parse_teams
from references import (
    COMMIT_RE,
    CROSS_REPO_RE,
    ISSUE_RE,
    LOCALHOST_RE,
    MERGE_REQUEST_RE,
    References,
)
from results import Candidate, Link
from tmux_fzf_links.export import OpenerType, SchemeEntry

PreHandler = Callable[[re.Match[str]], Candidate | None]
PostHandler = Callable[[re.Match[str]], Link]


def _pre(handler: PreHandler) -> Callable[[re.Match[str]], dict[str, str] | None]:
    def adapted(m: re.Match[str]) -> dict[str, str] | None:
        result = handler(m)
        return dataclasses.asdict(result) if result is not None else None

    return adapted


def _post(handler: PostHandler) -> Callable[[re.Match[str]], dict[str, str]]:
    def adapted(m: re.Match[str]) -> dict[str, str]:
        return dataclasses.asdict(handler(m))

    return adapted


def build_schemes() -> list[SchemeEntry]:
    refs = References(git_context.current_forge, git_context.commit_exists)
    linear = Linear(
        options.get("@fzf-links-linear-workspace"),
        parse_teams(options.get("@fzf-links-linear-teams")),
    )
    return [
        {
            "tags": ("linear",),
            "opener": OpenerType.BROWSER,
            "pre_handler": _pre(linear.pre),
            "post_handler": _post(linear.post),
            "regex": [linear.regex],
        },
        {
            "tags": ("MR",),
            "opener": OpenerType.BROWSER,
            "pre_handler": _pre(refs.merge_request_pre),
            "post_handler": _post(refs.merge_request_post),
            "regex": [MERGE_REQUEST_RE],
        },
        {
            "tags": ("issue",),
            "opener": OpenerType.BROWSER,
            "pre_handler": _pre(refs.issue_pre),
            "post_handler": _post(refs.issue_post),
            "regex": [ISSUE_RE],
        },
        {
            "tags": ("repo#n",),
            "opener": OpenerType.BROWSER,
            "pre_handler": _pre(refs.cross_repo_pre),
            "post_handler": _post(refs.cross_repo_post),
            "regex": [CROSS_REPO_RE],
        },
        {
            "tags": ("commit",),
            "opener": OpenerType.BROWSER,
            "pre_handler": _pre(refs.commit_pre),
            "post_handler": _post(refs.commit_post),
            "regex": [COMMIT_RE],
        },
        {
            "tags": ("localhost",),
            "opener": OpenerType.BROWSER,
            "pre_handler": _pre(refs.localhost_pre),
            "post_handler": _post(refs.localhost_post),
            "regex": [LOCALHOST_RE],
        },
    ]
