"""Shared test scaffolding: synthetic manifests and scores written to a temp directory."""

from __future__ import annotations

import json
import tempfile
from collections.abc import Sequence
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"
MANIFEST = FIXTURES / "synthetic-manifest.jsonl"
SCORES = FIXTURES / "synthetic-scores.jsonl"

CORPUS: dict[str, str] = {
    "id": "SYNTHETIC_CORPUS",
    "version": "0",
    "licence": "SYNTHETIC",
    "source_url": "https://example.invalid/synthetic",
}

HEADER: dict[str, object] = {
    "manifest_version": 1,
    "check": "synthetic-check",
    "corpora": [CORPUS],
}


def item(item_id: str, population: str, stratum: str = "plain") -> dict[str, object]:
    return {
        "id": item_id,
        "text": f"SYNTHETIC_TEXT_{item_id}",
        "population": population,
        "corpus": "SYNTHETIC_CORPUS",
        "stratum": stratum,
    }


def write_lines(directory: Path, name: str, rows: Sequence[object]) -> Path:
    path = directory / name
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    return path


class TempDir:
    """A temporary directory; a test registers `cleanup` with `addCleanup`."""

    def __init__(self) -> None:
        self._handle = tempfile.TemporaryDirectory()
        self.path = Path(self._handle.name)

    def cleanup(self) -> None:
        self._handle.cleanup()
