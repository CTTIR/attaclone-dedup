"""Compatibility API for the canonical deterministic, non-overwriting builder."""
import argparse
from pathlib import Path
import runpy

_builder = runpy.run_path(str(Path(__file__).with_name("build_xpi.py")))
FILES = _builder["FILES"]
SOURCE = _builder["ROOT"]


def build(destination=None):
    args = [] if destination is None else ["--output", str(destination)]
    return _builder["main"](args)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    build(parser.parse_args().output)
