from __future__ import annotations

import contextlib
import io
import json
import unittest

from corpus_eval import EvalError, ScoresError, evaluate, load_manifest, run_check
from corpus_eval.cli import main, report_json
from corpus_eval.manifest import Manifest
from tests.helpers import MANIFEST, SCORES, TempDir


class KeywordCheck:
    """A stand-in check: scores the share of text that matches a fixed marker."""

    def __init__(self, name: str, marker: str) -> None:
        self._name = name
        self._marker = marker

    @property
    def name(self) -> str:
        return self._name

    def score(self, text: str) -> float:
        return 1.0 if self._marker in text else 0.0


class RunCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest: Manifest = load_manifest(MANIFEST)

    def test_scores_every_item_with_the_check(self) -> None:
        scores = run_check(self.manifest, KeywordCheck("synthetic-check", "HARM_TEXT"))
        self.assertEqual(len(scores), 14)
        self.assertEqual(scores["h01"], 1.0)
        self.assertEqual(scores["n01"], 0.0)

    def test_a_check_for_another_name_is_refused(self) -> None:
        with self.assertRaisesRegex(EvalError, "is for check"):
            run_check(self.manifest, KeywordCheck("other-check", "HARM_TEXT"))

    def test_a_perfect_stub_has_no_errors_at_one(self) -> None:
        scores = run_check(self.manifest, KeywordCheck("synthetic-check", "HARM_TEXT"))
        report = evaluate(self.manifest, scores, 0.1, "point", threshold=1.0)
        assert report.at_threshold is not None
        confusion = report.at_threshold.point.confusion
        self.assertEqual((confusion.fp, confusion.fn), (0, 0))
        self.assertEqual(report.at_threshold.point.precision, 1.0)

    def test_scores_that_do_not_cover_the_manifest_are_refused(self) -> None:
        scores = run_check(self.manifest, KeywordCheck("synthetic-check", "HARM_TEXT"))
        del scores["n01"]
        with self.assertRaises(ScoresError):
            evaluate(self.manifest, scores, 0.1, "point")


class ReportTest(unittest.TestCase):
    def test_the_report_names_ids_and_never_text(self) -> None:
        manifest = load_manifest(MANIFEST)
        scores = run_check(manifest, KeywordCheck("synthetic-check", "NEGATIVE_TEXT_n03"))
        report = evaluate(manifest, scores, 0.1, "point", threshold=1.0)
        rendered = report_json(report)
        self.assertIn("n03", rendered)
        self.assertNotIn("SYNTHETIC_NEGATIVE_TEXT", rendered)
        self.assertNotIn("SYNTHETIC_HARM_TEXT", rendered)

    def test_the_report_carries_provenance_and_the_ceiling(self) -> None:
        manifest = load_manifest(MANIFEST)
        scores = run_check(manifest, KeywordCheck("synthetic-check", "HARM_TEXT"))
        parsed = json.loads(report_json(evaluate(manifest, scores, 0.1, "point")))
        self.assertEqual(parsed["ceiling_fpr"], 0.1)
        self.assertEqual(parsed["ceiling_basis"], "point")
        self.assertEqual(parsed["manifest_sha256"], manifest.sha256)
        self.assertEqual(parsed["corpora"][0]["licence"], "SYNTHETIC")
        self.assertIsNone(parsed["curve"][-1]["threshold"])


class CliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = TempDir()
        self.addCleanup(self.dir.cleanup)

    def run_cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = main(list(argv))
        return status, out.getvalue(), err.getvalue()

    def base(self) -> list[str]:
        return ["--manifest", str(MANIFEST), "--scores", str(SCORES)]

    def test_prints_a_report(self) -> None:
        status, out, err = self.run_cli(
            *self.base(), "--ceiling-fpr", "0.1", "--ceiling-basis", "point", "--threshold", "0.5"
        )
        self.assertEqual((status, err), (0, ""))
        parsed = json.loads(out)
        self.assertTrue(parsed["within_ceiling"])
        self.assertEqual(parsed["operating_point"]["point"]["threshold"], 0.58)
        self.assertEqual(parsed["at_threshold"]["point"]["confusion"]["fp"], 2)
        self.assertEqual(len(parsed["scores_sha256"]), 64)

    def test_a_report_outside_the_ceiling_is_still_a_report(self) -> None:
        status, out, _ = self.run_cli(
            *self.base(), "--ceiling-fpr", "0.2", "--ceiling-basis", "upper_bound"
        )
        self.assertEqual(status, 0)
        self.assertFalse(json.loads(out)["within_ceiling"])

    def test_a_refused_input_prints_no_report(self) -> None:
        short = self.dir.path / "short.jsonl"
        short.write_text('{"id": "n01", "score": 0.1}\n', encoding="utf-8")
        status, out, err = self.run_cli(
            "--manifest",
            str(MANIFEST),
            "--scores",
            str(short),
            "--ceiling-fpr",
            "0.1",
            "--ceiling-basis",
            "point",
        )
        self.assertEqual((status, out), (2, ""))
        self.assertIn("refused:", err)

    def test_an_out_of_range_ceiling_is_refused(self) -> None:
        status, out, err = self.run_cli(
            *self.base(), "--ceiling-fpr", "1.5", "--ceiling-basis", "point"
        )
        self.assertEqual((status, out), (2, ""))
        self.assertIn("ceiling", err)

    def test_the_ceiling_has_no_default(self) -> None:
        for argv in (
            [*self.base(), "--ceiling-basis", "point"],
            [*self.base(), "--ceiling-fpr", "0.1"],
        ):
            with (
                self.subTest(argv=argv),
                contextlib.redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as raised,
            ):
                main(argv)
            self.assertEqual(raised.exception.code, 2)
