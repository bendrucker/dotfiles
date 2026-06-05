import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from schemes import build_schemes  # noqa: E402

user_schemes = build_schemes()
rm_default_schemes: list[str] = []

__all__ = ["user_schemes", "rm_default_schemes"]
