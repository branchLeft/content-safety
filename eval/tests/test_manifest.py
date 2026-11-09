from __future__ import annotations

import unittest
from collections.abc import Sequence
from pathlib import Path

from corpus_eval import HARM, NEGATIVE, ManifestError, ScoresError, load_manifest, load_scores
from tests.helpers import CORPUS, HEADER, MANIFEST, SCORES, TempDir, item, write_lines


class ManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = TempDir()
        self.addCleanup(self.dir.cleanup)

    def manifest_of(self, rows: Sequence[object]) -> Path:
        return write_lines(self.dir.path, "m.jsonl", rows)

    def test_loads_the_fixture(self) -> None:
        manifest = load_manifest(MANIFEST)
        self.assertEqual(manifest.check, "synthetic-check")
        self.assertEqual(len(manifest.population(NEGATIVE)), 10)
        self.assertEqual(len(manifest.population(HARM)), 4)
        self.assertEqual(len(manifest.sha256), 64)

    def test_refuses_a_manifest_with_no_genuine_harm(self) -> None:
        path = self.manifest_of([HEADER, item("a", NEGATIVE), item("b", NEGATIVE)])
        with self.assertRaisesRegex(ManifestError, "no genuine_harm"):
            load_manifest(path)

    def test_refuses_a_manifest_with_no_negatives(self) -> None:
        path = self.manifest_of([HEADER, item("a", HARM)])
        with self.assertRaisesRegex(ManifestError, "no challenging_benign"):
            load_manifest(path)

    def test_refuses_a_duplicate_id(self) -> None:
        path = self.manifest_of([HEADER, item("a", NEGATIVE), item("a", HARM)])
        with self.assertRaisesRegex(ManifestError, "appears twice"):
            load_manifest(path)

    def test_refuses_an_undeclared_corpus(self) -> None:
        stray = {**item("a", NEGATIVE), "corpus": "OTHER"}
        path = self.manifest_of([HEADER, stray, item("b", HARM)])
        with self.assertRaisesRegex(ManifestError, "not declared"):
            load_manifest(path)

    def test_refuses_an_unknown_population(self) -> None:
        path = self.manifest_of([HEADER, item("a", "benign"), item("b", HARM)])
        with self.assertRaisesRegex(ManifestError, "population must be one of"):
            load_manifest(path)

    def test_refuses_a_bad_header(self) -> None:
        for header in (
            {**HEADER, "manifest_version": 2},
            {**HEADER, "check": ""},
            {**HEADER, "corpora": []},
            {**HEADER, "corpora": ["not an object"]},
            {**HEADER, "corpora": [CORPUS, CORPUS]},
        ):
            path = self.manifest_of([header, item("a", NEGATIVE), item("b", HARM)])
            with self.subTest(header=header), self.assertRaises(ManifestError):
                load_manifest(path)

    def test_refuses_a_corpus_entry_without_a_licence(self) -> None:
        corpus = {key: value for key, value in CORPUS.items() if key != "licence"}
        path = self.manifest_of([{**HEADER, "corpora": [corpus]}, item("a", NEGATIVE)])
        with self.assertRaisesRegex(ManifestError, "licence"):
            load_manifest(path)

    def test_refuses_lines_that_are_not_objects(self) -> None:
        path = self.dir.path / "m.jsonl"
        path.write_text('{"manifest_version": 1}\n[1]\n', encoding="utf-8")
        with self.assertRaises(ManifestError):
            load_manifest(path)
        path.write_text("not json\n[1]\n", encoding="utf-8")
        with self.assertRaisesRegex(ManifestError, "not JSON"):
            load_manifest(path)

    def test_refuses_a_header_only_manifest_and_a_non_utf8_one(self) -> None:
        path = self.manifest_of([HEADER])
        with self.assertRaisesRegex(ManifestError, "at least one item"):
            load_manifest(path)
        path.write_bytes(b"\xff\xfe\n\xff\n")
        with self.assertRaisesRegex(ManifestError, "UTF-8"):
            load_manifest(path)

    def test_refuses_an_empty_stratum(self) -> None:
        bad = {**item("a", NEGATIVE), "stratum": ""}
        path = self.manifest_of([HEADER, bad, item("b", HARM)])
        with self.assertRaisesRegex(ManifestError, "stratum"):
            load_manifest(path)

    def test_a_missing_stratum_is_unstratified(self) -> None:
        bare = {key: value for key, value in item("a", NEGATIVE).items() if key != "stratum"}
        path = self.manifest_of([HEADER, bare, item("b", HARM)])
        self.assertEqual(load_manifest(path).items[0].stratum, "unstratified")


class ScoresTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = TempDir()
        self.addCleanup(self.dir.cleanup)
        self.manifest = load_manifest(MANIFEST)

    def scores_of(self, rows: Sequence[object]) -> Path:
        return write_lines(self.dir.path, "s.jsonl", rows)

    def full_rows(self) -> list[dict[str, object]]:
        return [{"id": it.item_id, "score": 0.5} for it in self.manifest.items]

    def test_loads_the_fixture_scores(self) -> None:
        scores = load_scores(SCORES, self.manifest)
        self.assertEqual(len(scores), 14)
        self.assertEqual(scores["h01"], 0.95)

    def test_refuses_a_missing_score(self) -> None:
        with self.assertRaisesRegex(ScoresError, "no score"):
            load_scores(self.scores_of(self.full_rows()[:-1]), self.manifest)

    def test_refuses_an_extra_score(self) -> None:
        rows = [*self.full_rows(), {"id": "zzz", "score": 0.1}]
        with self.assertRaisesRegex(ScoresError, "name no manifest item"):
            load_scores(self.scores_of(rows), self.manifest)

    def test_refuses_a_duplicate_score(self) -> None:
        rows = [*self.full_rows(), {"id": "n01", "score": 0.2}]
        with self.assertRaisesRegex(ScoresError, "appears twice"):
            load_scores(self.scores_of(rows), self.manifest)

    def test_refuses_scores_that_are_not_finite_numbers(self) -> None:
        for bad in ("high", True, None):
            rows = [{"id": "n01", "score": bad}, *self.full_rows()[1:]]
            with self.subTest(bad=bad), self.assertRaisesRegex(ScoresError, "must be a number"):
                load_scores(self.scores_of(rows), self.manifest)
        path = self.dir.path / "nan.jsonl"
        path.write_text('{"id": "n01", "score": NaN}\n', encoding="utf-8")
        with self.assertRaisesRegex(ScoresError, "finite"):
            load_scores(path, self.manifest)

    def test_refuses_a_bad_id_and_a_bad_line(self) -> None:
        with self.assertRaisesRegex(ScoresError, "id must be"):
            load_scores(self.scores_of([{"id": "", "score": 1}]), self.manifest)
        path = self.dir.path / "bad.jsonl"
        path.write_text("nope\n", encoding="utf-8")
        with self.assertRaisesRegex(ScoresError, "not JSON"):
            load_scores(path, self.manifest)

    def test_blank_lines_are_skipped(self) -> None:
        path = self.dir.path / "blank.jsonl"
        body = "\n".join(f'{{"id": "{it.item_id}", "score": 1}}' for it in self.manifest.items)
        path.write_text("\n" + body + "\n\n", encoding="utf-8")
        self.assertEqual(len(load_scores(path, self.manifest)), 14)
