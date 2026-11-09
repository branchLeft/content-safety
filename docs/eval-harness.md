# The evaluation harness

`eval/` holds a small Python tool that measures one moderation check against a corpus manifest. It is a development tool: it is not part of the service, is not built into the image, and has no dependencies outside the standard library. The choice of corpus is in [eval-corpus-selection.md](eval-corpus-selection.md).

## What it computes

For one check and one manifest: the confusion counts, precision, recall, false-positive rate and false-negative rate at every threshold the check's scores produce, as a precision curve. It then picks the operating point with the most recall whose false-positive rate is within a ceiling given on the command line, and reports the ids the check got wrong and the counts per stratum at that point.

Three rules are built in and each has a test that fails without it:

- **Populations are never blended.** The false-positive rate is read over the `challenging_benign` items alone and the false-negative rate over the `genuine_harm` items alone.
- **A manifest needs both populations.** Without genuine-harm items, a check that flags nothing would show a perfect false-positive rate.
- **A check that flags no genuine harm is never given an operating point**, however low its false-positive rate.

The ceiling has no default and the harness will not run without one. A report says whether any threshold keeps the check within the ceiling; whether a check may enforce is the publication gate's decision, not the harness's.

## Manifest

JSON Lines. The first line is the header; every other line is one item.

```json
{"manifest_version": 1, "check": "CHECK_NAME", "corpora": [{"id": "CORPUS_ID", "version": "CORPUS_VERSION", "licence": "LICENCE_NAME", "source_url": "https://CORPUS_ORIGIN"}]}
{"id": "ITEM_ID", "text": "ITEM_TEXT", "population": "challenging_benign", "corpus": "CORPUS_ID", "stratum": "STRATUM_NAME"}
```

`population` is `challenging_benign` (must not be flagged) or `genuine_harm` (must be flagged). `stratum` is optional and names the kind of passage, so a rate can be read per kind. Ids are unique, every `corpus` is declared in the header, and the manifest is hashed into the report.

## Scores

A check produces one score per item, higher meaning more likely flagged; a check that answers yes or no scores 1 or 0. Scores are JSON Lines with `id` and `score`, one per manifest item exactly: a missing, extra, duplicated or non-finite score refuses the whole run, because a skipped row would change the population being measured.

A check written in Python can instead implement the `Check` protocol (`name` and `score(text)`) and be run with `run_check`, which refuses a check whose name differs from the manifest's. A check in another language writes the scores file.

## Running it

From the `eval/` directory, this runs the synthetic fixture:

```sh
python3 -m corpus_eval --manifest tests/fixtures/synthetic-manifest.jsonl --scores tests/fixtures/synthetic-scores.jsonl --ceiling-fpr 0.1 --ceiling-basis point
```

`--ceiling-basis` is `point` (the observed rate) or `upper_bound` (the upper end of the 95 per cent Wilson interval). `--threshold` adds the counts at one fixed threshold. The report is JSON on standard output and carries the manifest and scores hashes, the corpora with licences, the ceiling and the curve. It names ids and never text. A refused input prints one line on standard error and exits 2.

## Checks

```sh
cd eval
python3 -m unittest discover -s tests -t .
ruff check .
ruff format --check .
mypy corpus_eval tests
```

The tests use synthetic fixtures in `eval/tests/fixtures/`, whose texts are placeholders. They never fetch a corpus.
