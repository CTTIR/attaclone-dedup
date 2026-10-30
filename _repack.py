"""Compatibility entry point for the development package builder."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parent / "tools" / "build.py"), run_name="__main__")
