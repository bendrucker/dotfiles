from dataclasses import dataclass


@dataclass(frozen=True)
class Candidate:
    display_text: str
    tag: str


@dataclass(frozen=True)
class Link:
    url: str
