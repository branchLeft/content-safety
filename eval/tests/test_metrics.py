from __future__ import annotations

import math
import unittest

from corpus_eval import CeilingError, Confusion, evaluate, load_manifest, load_scores
from corpus_eval.metrics import (
    Basis,
    choose_operating_point,
    point_at,
    precision_curve,
    wilson_upper,
)
from tests.helpers import MANIFEST, SCORES


class ConfusionTest(unittest.TestCase):
    def test_rates_are_read_over_their_own_population(self) -> None:
        confusion = Confusion(tp=3, fp=2, fn=1, tn=8)
        self.assertAlmostEqual(confusion.precision or 0.0, 0.6)
        self.assertAlmostEqual(confusion.recall, 0.75)
        self.assertAlmostEqual(confusion.false_positive_rate, 0.2)
        self.assertAlmostEqual(confusion.false_negative_rate, 0.25)

    def test_precision_is_undefined_when_nothing_is_flagged(self) -> None:
        self.assertIsNone(Confusion(tp=0, fp=0, fn=4, tn=10).precision)

    def test_wilson_upper_bound(self) -> None:
        self.assertAlmostEqual(wilson_upper(0, 100), 0.0370, places=3)
        self.assertAlmostEqual(wilson_upper(0, 10), 0.2775, places=3)
        self.assertEqual(wilson_upper(0, 0), 1.0)
        self.assertAlmostEqual(wilson_upper(10, 10), 1.0)


class FixtureMeasurementTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = load_manifest(MANIFEST)
        self.scores = load_scores(SCORES, self.manifest)

    def test_counts_at_a_fixed_threshold(self) -> None:
        point = point_at(self.manifest, self.scores, 0.5)
        self.assertEqual(point.confusion, Confusion(tp=3, fp=2, fn=1, tn=8))

    def test_the_blended_rate_is_not_what_is_reported(self) -> None:
        point = point_at(self.manifest, self.scores, 0.5)
        blended_error = (point.confusion.fp + point.confusion.fn) / 14
        self.assertNotAlmostEqual(point.false_positive_rate, blended_error)
        self.assertAlmostEqual(point.false_positive_rate, 2 / 10)
        self.assertAlmostEqual(point.false_negative_rate, 1 / 4)

    def test_the_curve_runs_from_flag_everything_to_flag_nothing(self) -> None:
        curve = precision_curve(self.manifest, self.scores)
        first, last = curve[0], curve[-1]
        self.assertEqual(first.confusion, Confusion(tp=4, fp=10, fn=0, tn=0))
        self.assertTrue(math.isinf(last.threshold))
        self.assertEqual(last.confusion, Confusion(tp=0, fp=0, fn=4, tn=10))
        recalls = [point.recall for point in curve]
        self.assertEqual(recalls, sorted(recalls, reverse=True))

    def test_operating_point_is_the_most_recall_within_the_ceiling(self) -> None:
        report = evaluate(self.manifest, self.scores, 0.1, "point")
        self.assertTrue(report.within_ceiling)
        assert report.operating_point is not None
        chosen = report.operating_point.point
        self.assertEqual(chosen.threshold, 0.58)
        self.assertEqual(chosen.confusion, Confusion(tp=3, fp=1, fn=1, tn=9))
        self.assertEqual(report.operating_point.false_positive_ids, ("n03",))
        self.assertEqual(report.operating_point.false_negative_ids, ("h03",))
        self.assertEqual(report.operating_point.negative_strata["quoted-in-news"].flagged, 1)
        self.assertEqual(report.operating_point.negative_strata["plain"].flagged, 0)
        self.assertEqual(report.operating_point.harm_strata["harm-b"].flagged, 1)

    def test_a_tighter_ceiling_gives_up_recall(self) -> None:
        report = evaluate(self.manifest, self.scores, 0.05, "point")
        assert report.operating_point is not None
        self.assertEqual(report.operating_point.point.threshold, 0.7)
        self.assertAlmostEqual(report.operating_point.point.recall, 0.5)

    def test_the_upper_bound_basis_refuses_what_a_small_corpus_cannot_show(self) -> None:
        report = evaluate(self.manifest, self.scores, 0.2, "upper_bound")
        self.assertFalse(report.within_ceiling)
        self.assertIsNone(report.operating_point)
        self.assertIn("no threshold", report.reason)

    def test_the_upper_bound_basis_admits_a_clean_point_under_a_looser_ceiling(self) -> None:
        report = evaluate(self.manifest, self.scores, 0.3, "upper_bound")
        assert report.operating_point is not None
        self.assertEqual(report.operating_point.point.confusion.fp, 0)

    def test_a_fixed_threshold_is_reported_alongside(self) -> None:
        report = evaluate(self.manifest, self.scores, 0.1, "point", threshold=0.5)
        assert report.at_threshold is not None
        self.assertEqual(report.at_threshold.point.confusion.fp, 2)
        self.assertEqual(report.at_threshold.false_positive_ids, ("n03", "n10"))

    def test_population_sizes_are_in_the_report(self) -> None:
        report = evaluate(self.manifest, self.scores, 0.1, "point")
        self.assertEqual((report.negatives, report.positives), (10, 4))


class CatchesNothingTest(unittest.TestCase):
    """The control case: a check that flags nothing has a perfect false-positive rate."""

    def test_a_silent_check_earns_nothing(self) -> None:
        manifest = load_manifest(MANIFEST)
        silent = {item.item_id: 0.0 for item in manifest.items}
        report = evaluate(manifest, silent, 0.5, "point")
        self.assertFalse(report.within_ceiling)
        self.assertIsNone(report.operating_point)
        self.assertIn("flags no genuine harm", report.reason)

    def test_a_check_that_flags_everything_is_over_any_ceiling(self) -> None:
        manifest = load_manifest(MANIFEST)
        loud = {item.item_id: 1.0 for item in manifest.items}
        report = evaluate(manifest, loud, 0.5, "point")
        self.assertFalse(report.within_ceiling)


class CeilingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = load_manifest(MANIFEST)
        self.scores = load_scores(SCORES, self.manifest)

    def test_refuses_a_ceiling_out_of_range(self) -> None:
        for bad in (0.0, 1.0, -0.1, 1.5, math.nan):
            with self.subTest(ceiling=bad), self.assertRaises(CeilingError):
                evaluate(self.manifest, self.scores, bad, "point")

    def test_refuses_a_ceiling_that_is_not_a_float(self) -> None:
        with self.assertRaises(CeilingError):
            evaluate(self.manifest, self.scores, 1, "point")

    def test_refuses_an_unknown_basis(self) -> None:
        unknown: Basis = "mean"  # type: ignore[assignment]
        with self.assertRaises(CeilingError):
            evaluate(self.manifest, self.scores, 0.1, unknown)

    def test_choose_refuses_without_a_valid_ceiling_too(self) -> None:
        curve = precision_curve(self.manifest, self.scores)
        with self.assertRaises(CeilingError):
            choose_operating_point(curve, 2.0, "point")
