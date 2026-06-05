import functools
import subprocess


@functools.lru_cache(maxsize=None)
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
