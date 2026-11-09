"""Command line: measure one check's scores against a manifest and print a JSON report.

Exit status: 0 the report was produced (whether or not the check is within the
ceiling), 2 an input was refused. A refusal prints one line and no report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path

from corpus_eval.errors import EvalError
from corpus_eval.evaluate import evaluate
from corpus_eval.manifest import load_manifest, load_scores
from corpus_eval.metrics import BASES, Basis, Report


def _plain(value: object) -> object:
    """JSON has no infinity: the threshold that flags nothing is written as null."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _plain(inner) for key, inner in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(inner) for inner in value]
    return value


def report_json(report: Report) -> str:
    return json.dumps(_plain(asdict(report)), indent=2, sort_keys=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="corpus_eval", description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--scores", type=Path, required=True)
    parser.add_argument(
        "--ceiling-fpr",
        type=float,
        required=True,
        help="false-positive ceiling agreed before the run; there is no default",
    )
    parser.add_argument("--ceiling-basis", choices=BASES, required=True)
    parser.add_argument("--threshold", type=float, default=None)
    return parser


def main(argv: list[str]) -> int:
    args = _parser().parse_args(argv)
    basis: Basis = args.ceiling_basis
    try:
        manifest = load_manifest(args.manifest)
        scores = load_scores(args.scores, manifest)
        report = evaluate(
            manifest,
            scores,
            args.ceiling_fpr,
            basis,
            scores_sha256=hashlib.sha256(args.scores.read_bytes()).hexdigest(),
            threshold=args.threshold,
        )
    except EvalError as error:
        sys.stderr.write(f"refused: {error}\n")
        return 2
    sys.stdout.write(report_json(report) + "\n")
    return 0
