"""Reading a corpus manifest and a check's scores.

A manifest is JSON Lines. The first line is a header naming the check and each
corpus the items came from; every later line is one item. The expected outcome
of an item is its population: text that must not be flagged, or text that must.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from corpus_eval.errors import ManifestError, ScoresError

NEGATIVE: Final = "challenging_benign"
HARM: Final = "genuine_harm"
POPULATIONS: Final = frozenset({NEGATIVE, HARM})
MANIFEST_VERSION: Final = 1


@dataclass(frozen=True)
class CorpusRef:
    """Where a set of items came from. Carried into the report so a rate names its source."""

    corpus_id: str
    version: str
    licence: str
    source_url: str


@dataclass(frozen=True)
class Item:
    item_id: str
    text: str
    population: str
    corpus_id: str
    stratum: str


@dataclass(frozen=True)
class Manifest:
    check: str
    corpora: tuple[CorpusRef, ...]
    items: tuple[Item, ...]
    sha256: str

    def population(self, name: str) -> tuple[Item, ...]:
        return tuple(item for item in self.items if item.population == name)


def _object(line: str, where: str) -> dict[str, object]:
    try:
        parsed: object = json.loads(line)
    except json.JSONDecodeError as error:
        raise ManifestError(f"{where}: not JSON") from error
    if not isinstance(parsed, dict):
        raise ManifestError(f"{where}: not a JSON object")
    return {str(key): value for key, value in parsed.items()}


def _text(fields: dict[str, object], key: str, where: str) -> str:
    value = fields.get(key)
    if not isinstance(value, str) or value == "":
        raise ManifestError(f"{where}: {key} must be a non-empty string")
    return value


def _corpus_ref(raw: object, where: str) -> CorpusRef:
    if not isinstance(raw, dict):
        raise ManifestError(f"{where}: a corpus entry must be an object")
    fields = {str(key): value for key, value in raw.items()}
    return CorpusRef(
        corpus_id=_text(fields, "id", where),
        version=_text(fields, "version", where),
        licence=_text(fields, "licence", where),
        source_url=_text(fields, "source_url", where),
    )


def _header(line: str) -> tuple[str, tuple[CorpusRef, ...]]:
    fields = _object(line, "header")
    if fields.get("manifest_version") != MANIFEST_VERSION:
        raise ManifestError(f"header: manifest_version must be {MANIFEST_VERSION}")
    check = _text(fields, "check", "header")
    raw_corpora = fields.get("corpora")
    if not isinstance(raw_corpora, list) or not raw_corpora:
        raise ManifestError("header: corpora must be a non-empty list")
    corpora = tuple(_corpus_ref(raw, "header corpora") for raw in raw_corpora)
    ids = [corpus.corpus_id for corpus in corpora]
    if len(set(ids)) != len(ids):
        raise ManifestError("header: a corpus id is declared twice")
    return check, corpora


def _item(line: str, number: int, corpus_ids: frozenset[str]) -> Item:
    where = f"line {number}"
    fields = _object(line, where)
    population = _text(fields, "population", where)
    if population not in POPULATIONS:
        raise ManifestError(f"{where}: population must be one of {sorted(POPULATIONS)}")
    corpus_id = _text(fields, "corpus", where)
    if corpus_id not in corpus_ids:
        raise ManifestError(f"{where}: corpus {corpus_id!r} is not declared in the header")
    stratum = fields.get("stratum", "unstratified")
    if not isinstance(stratum, str) or stratum == "":
        raise ManifestError(f"{where}: stratum must be a non-empty string when present")
    return Item(
        item_id=_text(fields, "id", where),
        text=_text(fields, "text", where),
        population=population,
        corpus_id=corpus_id,
        stratum=stratum,
    )


def load_manifest(path: Path) -> Manifest:
    """Read a manifest, refusing one that cannot measure both failure directions.

    A manifest with no genuine-harm items would let a check that catches nothing
    show a perfect false-positive rate, so both populations must be present.

    Raises:
        ManifestError: the file is not a well-formed manifest of both populations.
    """
    raw = path.read_bytes()
    try:
        lines = [line for line in raw.decode("utf-8").splitlines() if line.strip() != ""]
    except UnicodeDecodeError as error:
        raise ManifestError("manifest is not UTF-8") from error
    if len(lines) < 2:
        raise ManifestError("manifest needs a header line and at least one item")
    check, corpora = _header(lines[0])
    corpus_ids = frozenset(corpus.corpus_id for corpus in corpora)
    items = tuple(_item(line, number, corpus_ids) for number, line in enumerate(lines[1:], 2))
    ids = [item.item_id for item in items]
    if len(set(ids)) != len(ids):
        raise ManifestError("an item id appears twice")
    manifest = Manifest(
        check=check,
        corpora=corpora,
        items=items,
        sha256=hashlib.sha256(raw).hexdigest(),
    )
    for population in sorted(POPULATIONS):
        if not manifest.population(population):
            raise ManifestError(f"the manifest has no {population} items")
    return manifest


def load_scores(path: Path, manifest: Manifest) -> dict[str, float]:
    """Read a check's scores: one JSON object per line with `id` and `score`.

    Higher means more likely to be flagged. The ids must be exactly the
    manifest's: a missing score would silently shrink the population measured.

    Raises:
        ScoresError: a line is malformed, or the ids differ from the manifest's.
    """
    scores: dict[str, float] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip() == "":
            continue
        try:
            fields = _object(line, f"scores line {number}")
        except ManifestError as error:
            raise ScoresError(str(error)) from error
        item_id = fields.get("id")
        score = fields.get("score")
        if not isinstance(item_id, str) or item_id == "":
            raise ScoresError(f"scores line {number}: id must be a non-empty string")
        if isinstance(score, bool) or not isinstance(score, int | float):
            raise ScoresError(f"scores line {number}: score must be a number")
        if not math.isfinite(score):
            raise ScoresError(f"scores line {number}: score must be finite")
        if item_id in scores:
            raise ScoresError(f"scores line {number}: id {item_id!r} appears twice")
        scores[item_id] = float(score)
    validate_scores(scores, manifest)
    return scores


def validate_scores(scores: dict[str, float], manifest: Manifest) -> None:
    """Refuse scores that do not cover the manifest exactly, or that are not finite.

    Every path into the measurement goes through here, the library path included,
    so a non-finite score (a NaN, which compares false against any threshold and
    would be counted as below it) can never reach a rate.

    Raises:
        ScoresError: the ids differ from the manifest's, or a score is not finite.
    """
    expected = {item.item_id for item in manifest.items}
    missing = sorted(expected - scores.keys())
    extra = sorted(scores.keys() - expected)
    if missing:
        raise ScoresError(f"{len(missing)} manifest items have no score, first: {missing[0]!r}")
    if extra:
        raise ScoresError(f"{len(extra)} scores name no manifest item, first: {extra[0]!r}")
    for item_id in sorted(scores):
        if not math.isfinite(scores[item_id]):
            raise ScoresError(f"the score for {item_id!r} must be finite")
