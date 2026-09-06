# The old host's option store. tmux is gone, so `get` now always takes the
# exception path and returns "", which drops every scheme that needs an option.
# A port replaces this module with its host's equivalent.
import functools
import subprocess


@functools.cache
def get(name: str) -> str:
    try:
        out = subprocess.run(
            ["tmux", "show-option", "-gqv", name],
            capture_output=True,
            text=True,
            timeout=1.0,
        )
    except Exception:
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""
