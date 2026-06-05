from linear import Linear, parse_teams
from results import Link


def test_dropped_without_workspace():
    linear = Linear(workspace="", teams=("ENG",))
    m = linear.regex.search("ticket ENG-1234")
    assert m is not None
    assert linear.pre(m) is None


def test_kept_with_workspace():
    linear = Linear(workspace="acme", teams=("ENG",))
    m = linear.regex.search("ticket eng-42")
    assert m is not None
    candidate = linear.pre(m)
    assert candidate is not None and candidate.tag == "linear"
    assert linear.post(m) == Link("https://linear.app/acme/issue/ENG-42")


def test_no_teams_matches_nothing():
    linear = Linear(workspace="acme", teams=())
    assert linear.regex.search("ENG-1") is None


def test_parse_teams():
    assert parse_teams("eng, foo bar") == ("ENG", "FOO", "BAR")
    assert parse_teams("") == ()
