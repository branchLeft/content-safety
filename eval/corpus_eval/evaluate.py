"""Running a check over a manifest and assembling the report."""

from __future__ import annotations

from typing import Protocol

from corpus_eval.errors import EvalError
from corpus_eval.manifest import Manifest, validate_scores
from corpus_eval.metrics import (
    Basis,
    Report,
    check_ceiling,
    choose_operating_point,
    describe_point,
    point_at,
    precision_curve,
)


class Check(Protocol):
    """A moderation check as the harness sees it: a name and a score, higher meaning flag.

    A check that cannot produce a score must raise; the harness never substitutes
    one, because a made-up score would be counted in a rate.
    """

    @property
    def name(self) -> str: ...

    def score(self, text: str) -> float: ...


def run_check(manifest: Manifest, check: Check) -> dict[str, float]:
    if check.name != manifest.check:
        raise EvalError(
            f"the manifest is for check {manifest.check!r} but the check is {check.name!r}"
        )
    return {item.item_id: check.score(item.text) for item in manifest.items}


def evaluate(
    manifest: Manifest,
    scores: dict[str, float],
    ceiling_fpr: float,
    basis: Basis,
    scores_sha256: str | None = None,
    threshold: float | None = None,
) -> Report:
    """Measure one check against one manifest under a ceiling agreed beforehand.

    The ceiling has no default. The report says whether any threshold keeps the
    check within it; it does not say a check may enforce, which is the gate's call.
    `threshold`, when given, adds the counts at that fixed threshold, for a check
    that answers yes or no.
    """
    check_ceiling(ceiling_fpr, basis)
    validate_scores(scores, manifest)
    curve = precision_curve(manifest, scores)
    chosen, reason = choose_operating_point(curve, ceiling_fpr, basis)
    return Report(
        check=manifest.check,
        manifest_sha256=manifest.sha256,
        scores_sha256=scores_sha256,
        corpora=manifest.corpora,
        negatives=curve[0].confusion.fp + curve[0].confusion.tn,
        positives=curve[0].confusion.tp + curve[0].confusion.fn,
        ceiling_fpr=ceiling_fpr,
        ceiling_basis=basis,
        curve=curve,
        within_ceiling=chosen is not None,
        reason=reason,
        operating_point=None if chosen is None else describe_point(manifest, scores, chosen),
        at_threshold=(
            None
            if threshold is None
            else describe_point(manifest, scores, point_at(manifest, scores, threshold))
        ),
    )
