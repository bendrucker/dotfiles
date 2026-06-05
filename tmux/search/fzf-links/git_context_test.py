import pytest

from git_context import Forge, forge_from_url


@pytest.mark.parametrize(
    "url, host, path, kind",
    [
        (
            "git@github.com:bendrucker/dotfiles.git",
            "github.com",
            "bendrucker/dotfiles",
            "github",
        ),
        (
            "https://github.com/bendrucker/dotfiles.git",
            "github.com",
            "bendrucker/dotfiles",
            "github",
        ),
        (
            "https://github.com/bendrucker/dotfiles",
            "github.com",
            "bendrucker/dotfiles",
            "github",
        ),
        (
            "git@gitlab.com:group/subgroup/proj.git",
            "gitlab.com",
            "group/subgroup/proj",
            "gitlab",
        ),
        (
            "https://gitlab.example.com/team/app.git",
            "gitlab.example.com",
            "team/app",
            "gitlab",
        ),
        (
            "ssh://git@gitlab.example.com:2222/team/sub/app.git",
            "gitlab.example.com",
            "team/sub/app",
            "gitlab",
        ),
    ],
)
def test_forge_from_url_extracts_path(url, host, path, kind):
    forge = forge_from_url(url)
    assert forge == Forge(host=host, path=path, kind=kind)


@pytest.mark.parametrize(
    "url",
    [
        "git@bitbucket.org:foo/bar.git",  # unsupported platform
        "not a url",
        "https://example.com/",
        "",
    ],
)
def test_forge_from_url_rejects_unsupported(url):
    assert forge_from_url(url) is None


def test_forge_builds_urls():
    forge = Forge(host="github.com", path="bendrucker/dotfiles", kind="github")
    assert forge.issue_url("42") == "https://github.com/bendrucker/dotfiles/issues/42"
    assert (
        forge.commit_url("abc123")
        == "https://github.com/bendrucker/dotfiles/commit/abc123"
    )


def test_gitlab_subgroup_merge_request_url():
    forge = Forge(host="gitlab.com", path="group/subgroup/proj", kind="gitlab")
    assert (
        forge.merge_request_url("7")
        == "https://gitlab.com/group/subgroup/proj/merge_requests/7"
    )
