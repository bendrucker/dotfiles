from __future__ import annotations

import re

from format import PURPLE, colorize
from results import Candidate, Link


def parse_teams(raw: str) -> tuple[str, ...]:
    return tuple(t.upper() for t in re.split(r"[,\s]+", raw) if t)


def _regex(teams: tuple[str, ...]) -> re.Pattern[str]:
    if not teams:
        return re.compile(r"(?!)")  # no teams configured: match nothing
    alternation = "|".join(re.escape(t) for t in teams)
    return re.compile(rf"\b(?P<id>(?:{alternation})-\d+)\b", re.IGNORECASE)


class Linear:
    def __init__(self, workspace: str, teams: tuple[str, ...]) -> None:
        self.workspace = workspace
        self.regex = _regex(teams)

    def pre(self, m: re.Match[str]) -> Candidate | None:
        if not self.workspace:
            return None
        return Candidate(colorize(m.group("id").upper(), PURPLE), "linear")

    def post(self, m: re.Match[str]) -> Link:
        ident = m.group("id").upper()
        return Link(f"https://linear.app/{self.workspace}/issue/{ident}")
