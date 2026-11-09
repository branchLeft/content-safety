"""The arithmetic: confusion counts, rates, the precision curve and the operating point.

Two populations are never blended. A negative is text that must not be flagged
(the challenging-topic corpus); a positive is text that must be (the genuine-harm
set). The false-positive rate is read over the negatives alone and the
false-negative rate over the positives alone.
"""

from __future__ import annotations

import math
from bisect import bisect_left
from dataclasses import dataclass
from typing import Final, Literal

from corpus_eval.errors import CeilingError
from corpus_eval.manifest import HARM, NEGATIVE, CorpusRef, Item, Manifest

Basis = Literal["point", "upper_bound"]
BASES: Final[tuple[Basis, ...]] = ("point", "upper_bound")
WILSON_Z: Final = 1.959964


@dataclass(frozen=True)
class Confusion:
    tp: int
    fp: int
    fn: int
    tn: int

    @property
    def precision(self) -> float | None:
        flagged = self.tp + self.fp
        return None if flagged == 0 else self.tp / flagged

    @property
    def recall(self) -> float:
        return self.tp / (self.tp + self.fn)

    @property
    def false_positive_rate(self) -> float:
        return self.fp / (self.fp + self.tn)

    @property
    def false_negative_rate(self) -> float:
        return self.fn / (self.tp + self.fn)


def wilson_upper(successes: int, trials: int) -> float:
    """Upper end of the 95% Wilson interval, so a small corpus cannot flatter a rate."""
    if trials == 0:
        return 1.0
    p = successes / trials
    z2 = WILSON_Z**2
    centre = p + z2 / (2 * trials)
    margin = WILSON_Z * math.sqrt(p * (1 - p) / trials + z2 / (4 * trials**2))
    return min(1.0, (centre + margin) / (1 + z2 / trials))


@dataclass(frozen=True)
class CurvePoint:
    """Flag an item when its score is at or above `threshold`."""

    threshold: float
    confusion: Confusion
    precision: float | None
    recall: float
    false_positive_rate: float
    false_positive_rate_upper: float
    false_negative_rate: float


@dataclass(frozen=True)
class StratumCount:
    total: int
    flagged: int


@dataclass(frozen=True)
class OperatingPoint:
    point: CurvePoint
    false_positive_ids: tuple[str, ...]
    false_negative_ids: tuple[str, ...]
    negative_strata: dict[str, StratumCount]
    harm_strata: dict[str, StratumCount]


@dataclass(frozen=True)
class Report:
    check: str
    manifest_sha256: str
    scores_sha256: str | None
    corpora: tuple[CorpusRef, ...]
    negatives: int
    positives: int
    ceiling_fpr: float
    ceiling_basis: Basis
    curve: tuple[CurvePoint, ...]
    within_ceiling: bool
    reason: str
    operating_point: OperatingPoint | None = None
    at_threshold: OperatingPoint | None = None


def _split(manifest: Manifest, scores: dict[str, float]) -> tuple[list[float], list[float]]:
    negatives = sorted(scores[item.item_id] for item in manifest.population(NEGATIVE))
    positives = sorted(scores[item.item_id] for item in manifest.population(HARM))
    return negatives, positives


def _point(threshold: float, negatives: list[float], positives: list[float]) -> CurvePoint:
    fp = len(negatives) - bisect_left(negatives, threshold)
    tp = len(positives) - bisect_left(positives, threshold)
    confusion = Confusion(
        tp=tp,
        fp=fp,
        fn=len(positives) - tp,
        tn=len(negatives) - fp,
    )
    return CurvePoint(
        threshold=threshold,
        confusion=confusion,
        precision=confusion.precision,
        recall=confusion.recall,
        false_positive_rate=confusion.false_positive_rate,
        false_positive_rate_upper=wilson_upper(fp, len(negatives)),
        false_negative_rate=confusion.false_negative_rate,
    )


def precision_curve(manifest: Manifest, scores: dict[str, float]) -> tuple[CurvePoint, ...]:
    """One point per distinct score, plus the point that flags nothing."""
    negatives, positives = _split(manifest, scores)
    thresholds = sorted({*negatives, *positives, math.inf})
    return tuple(_point(threshold, negatives, positives) for threshold in thresholds)


def point_at(manifest: Manifest, scores: dict[str, float], threshold: float) -> CurvePoint:
    negatives, positives = _split(manifest, scores)
    return _point(threshold, negatives, positives)


def _strata(
    items: tuple[Item, ...], scores: dict[str, float], threshold: float
) -> dict[str, StratumCount]:
    totals: dict[str, int] = {}
    flagged: dict[str, int] = {}
    for item in items:
        totals[item.stratum] = totals.get(item.stratum, 0) + 1
        if scores[item.item_id] >= threshold:
            flagged[item.stratum] = flagged.get(item.stratum, 0) + 1
    return {
        stratum: StratumCount(total=totals[stratum], flagged=flagged.get(stratum, 0))
        for stratum in sorted(totals)
    }


def describe_point(
    manifest: Manifest, scores: dict[str, float], point: CurvePoint
) -> OperatingPoint:
    """Attach the ids that were wrong and the per-stratum counts. Ids only, never text."""
    negatives = manifest.population(NEGATIVE)
    positives = manifest.population(HARM)
    return OperatingPoint(
        point=point,
        false_positive_ids=tuple(
            sorted(item.item_id for item in negatives if scores[item.item_id] >= point.threshold)
        ),
        false_negative_ids=tuple(
            sorted(item.item_id for item in positives if scores[item.item_id] < point.threshold)
        ),
        negative_strata=_strata(negatives, scores, point.threshold),
        harm_strata=_strata(positives, scores, point.threshold),
    )


def check_ceiling(ceiling_fpr: float, basis: Basis) -> None:
    if not isinstance(ceiling_fpr, float) or not 0.0 < ceiling_fpr < 1.0:
        raise CeilingError("the ceiling must be a number strictly between 0 and 1")
    if basis not in BASES:
        raise CeilingError(f"the ceiling basis must be one of {list(BASES)}")


def choose_operating_point(
    curve: tuple[CurvePoint, ...], ceiling_fpr: float, basis: Basis
) -> tuple[CurvePoint | None, str]:
    """The point with the most recall whose false-positive rate is within the ceiling.

    A point that flags no genuine harm is never chosen: a check that catches
    nothing has a perfect false-positive rate and has earned nothing.
    """
    check_ceiling(ceiling_fpr, basis)

    def rate(point: CurvePoint) -> float:
        return point.false_positive_rate if basis == "point" else point.false_positive_rate_upper

    within = [point for point in curve if rate(point) <= ceiling_fpr]
    if not within:
        return None, "no threshold keeps the false-positive rate within the ceiling"
    useful = [point for point in within if point.confusion.tp > 0]
    if not useful:
        return None, "every threshold within the ceiling flags no genuine harm"
    best = max(useful, key=lambda point: (point.recall, point.threshold))
    return best, "a threshold within the ceiling flags genuine harm"
