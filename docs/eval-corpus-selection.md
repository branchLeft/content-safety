# Choosing the evaluation corpus for the moderation checks

This page prepares the choice of an open-source corpus to measure each moderation check against. It does not make the choice: the platform owner chooses, and the last section lists exactly what they decide.

The text in this page about each dataset comes from the dataset's own public page, licence text or paper abstract. **No dataset was downloaded, opened or sampled to write it, and no image corpus was consulted at all.** A field the page did not state is written `not stated`, and every `not stated` is a thing to confirm before a corpus is fetched, not a gap to assume away.

## What is being measured

The safety design splits moderation in two. Only the second job needs a corpus.

| Check | Kind | Today | What a wrong answer costs | Corpus needed |
|---|---|---|---|---|
| Known-material hash match (`PdqKnownMaterialCheck`) | media, blocking | built | a miss admits illegal material | none, see below |
| Threats of violence | text, floor | design only | a silenced journalist | text corpus |
| Incitement to violence or hatred | text, floor | design only | a silenced journalist | text corpus |
| Targeting packages (sets of addresses, phone numbers, identity numbers) | text, floor | design only | a silenced journalist | text corpus |
| Solicitation of child sexual abuse, in text | text, floor | design only | a silenced journalist, or a miss | none selectable, see below |
| Harassment, spam, sexual content, self-harm, off-topic | text, comments, tenant-set | design only | a stranger's comment hidden | text corpus, partly |
| The same classifiers on articles | text, advisory | design only | none: never holds publication | the rows above |

No text check exists in code yet, and the classifier is not chosen. Measuring a check therefore waits on the check; this page and the harness (`docs/eval-harness.md`) make that step a matter of running one command per check.

### The hash match is not measured against a corpus

A hash match is a comparison against a known set, so there is no population of grey cases to draw a rate from, and the near-match distance is the supplier's. What the platform owns, and what its tests already pin, is the plumbing: a refusal per tier through the real adapter, a hold on no verdict, a test classification that behaves as a match. Measuring it against images would require fetching an image corpus, which no agent does and which this page does not propose. If the owner later wants a rate for the perceptual hash itself, that is a separate decision about a benign photograph set, to be taken with its own licence reading.

### The solicitation check cannot be given a genuine-harm set

The only open text collections that contain this material are chat logs of adults sexually soliciting people who present as children, or content close to it. They are real people's conversations, they are sexually explicit, and the platform's standing rule is that nobody on the team ever views suspected material. Holding such a file is a legal question this page does not answer. The recommendation is in the last section.

## Hard limits applied while preparing this page

- No dataset that may contain child sexual abuse material or other unlawful imagery was fetched, opened or sampled, and no image corpus of any kind was.
- Text corpora were not fetched either: only their public pages were read.
- Every report the harness writes names item ids and counts, never text, so measuring a check never puts a person in front of the material.

## The two populations every corpus feeds

The ruling is that the corpus is selected from material that already exists and is never authored here. The harness keeps two populations apart and never blends them:

- `challenging_benign`: text that must not be flagged by this check. Journalism and comment text about conflict, abuse, extremism and corruption; quotations of threats inside reporting; court listings; press-office contact details. The false-positive rate is read over this population alone.
- `genuine_harm`: text that must be flagged by this check. The false-negative rate is read over this population alone, and a check that flags nothing is refused an operating point.

A corpus is not itself a population: a labelled corpus supplies both, per check, by its labels.

## Shortlist: text with labels for a single check

Sizes and labels are what the page read says. Licence names are exactly as stated on the page; a page that links a licence file without naming it is marked `not stated`.

### Threats of violence

| Corpus | Licence | Size | Labels | Access | Content risk | Notes |
|---|---|---|---|---|---|---|
| Civil Comments (Jigsaw Unintended Bias) | CC0, including the comment text | 1,804,874 train, 97,320 validation, 97,320 test | `threat`, `insult`, `identity_attack`, `obscene`, `sexual_explicit`, `severe_toxicity`, each the fraction of annotators who applied it | direct download through TensorFlow Datasets (427 MiB), or the Kaggle competition page | offensive text, named individuals in comments, no images | Public comments on about 50 English-language news sites, 2015 to 2017: the closest open match to a tenant's comment section. Labels are crowd fractions, so a cut-off must be chosen and recorded, and the page read does not say how many comments carry the threat label. |
| THREAT (Hammer and others) | not stated on the pages read; a copyright notice appears on the repository record | about 30,000 sentences from about 10,000 YouTube comments | sentence-level violent threat or not | a single zip on the research group's dataset page (its certificate failed on fetch: re-check) | violent threats, sentence level | The only corpus found built for violent threats. Cannot be used until its licence is confirmed with the authors. |
| ThreatCore | repository Apache-2.0; the dataset's own terms not stated | 21,764 instances, of which 15,691 were re-annotated source rows and the rest augmentation | explicit threat, implicit threat, non-threat; an `Origin` column marks rows `dataset` or `generated` | public repository | as its sources | Built from several other corpora plus rows generated by language models. A generated row is authored by a model, which the selection rule excludes, and each source row keeps its source's licence, one of which is a gated agreement. Use only as a cross-check, filtered to `dataset` rows, after the sources' licences are read. |
| ETHOS | GPL-3.0 | 998 comments in the binary set, 433 hateful | a `violence` flag on the hateful ones | public repository | hateful text | Too small for a rate. Copyleft makes a redistributed derived manifest awkward. |

### Incitement to violence or hatred

| Corpus | Licence | Size | Labels | Access | Content risk | Notes |
|---|---|---|---|---|---|---|
| Dynamically Generated Hate Speech | CC BY 4.0 | not stated on the page read | hate or not; for hate, one of five types including threatening; target group | two CSV files in a public repository | hateful text; the page counts 20 annotators and calls the content synthetic | Human-written adversarial cases, so it contains the near-misses a classifier trips on. |
| Measuring Hate Speech (UC Berkeley) | CC BY 4.0 | 136,000 rows on the dataset page (rows are annotator judgements, not comments) | continuous hate score built from sentiment, respect, insult, humiliate, status, dehumanize ratings, with target groups | Hugging Face, no gate shown | hateful text, no content warning on the page | Large and graded, which suits a precision curve. Items carry a platform field. |
| HateCheck | CC BY 4.0 | 3,728 cases in 29 functional tests | hateful or not, plus whether directed at an individual | public repository | hateful and contrast text | Template-generated by its authors. The contrast cases (non-hateful text that mentions or quotes hate) are what a false-positive measure wants, but the page read does not list the 29 tests: read the paper before relying on any. |
| Contextual Abuse Dataset | CC BY 4.0 | not stated | six primary categories (names not on the page read), secondary categories, labelled in thread context | Zenodo, open | abusive text from Reddit | Context-aware, which is how comments are actually judged. |
| Gab Hate Corpus | CC BY 4.0 on the project page, per a search snippet: confirm on the files tab | 27,665 posts | hate-based rhetoric typology, three or more trained annotators | OSF project | hateful text from a platform known for it | Confirm there is no download request. |
| HateXplain | MIT on the repository; the data's own terms not stated | not stated | hate, offensive or normal; target; rationales | public repository | warns it contains offensive and hateful content | The page read does not name the platforms the posts came from: read their terms before use. |
| Counter | not stated for the data | not stated | radicalisation level, call for action, named entities, in English, French and Arabic | public repository named in the paper | genuine extremist propaganda, pseudonymised, from social platforms | The only corpus found with a call-for-action label, which is nearest to incitement. The text is real extremist material: whether the platform may hold it is a legal view, not an engineering one. |

### Targeting packages

No open labelled corpus of doxing was found. A study of doxing on a social platform holds 3,131 labelled posts and will share post identifiers on request; re-fetching those posts would collect real third parties' personal data. A synthetic-data vendor's corpus of finance documents with labelled personal-data spans is Apache-2.0 (about 55,900 rows, synthetic, name, street address, card number and similar spans), and a larger masking corpus exists (about 225,000 rows) whose licence the page read does not name. Neither is a targeting package: each is one fictional person's own documents, and assembling their identifiers into a list about a third party would be authoring, which the selection rule forbids.

What does exist openly is the false-positive population, which is the part the ruling cares about:

| Corpus | Licence | Size | Why it is here | Access | Content risk | Notes |
|---|---|---|---|---|---|---|
| CourtListener bulk data | Creative Commons Public Domain Mark 1.0 ("free of known copyright restrictions") | court opinions, dockets and more; quarterly CSV snapshots | court listings; opinions quoting threats; victim testimony | S3 bulk files in a browsable index | names of private people in public records; descriptions of abuse | Sample, do not take whole. US material. |
| Global Voices | the site states Creative Commons Attribution 3.0 | not stated | challenging-topic journalism | web and feeds; a bulk route is not stated | accounts of conflict, censorship and abuse | Attribution is required in anything published. The page read did not say whether commercial reuse is covered: CC BY does, so confirm the licence applies to every article. |
| Civil Comments | CC0 | as above | comments quoting officials and press offices | as above | as above | The same file as threats. |

Two licence traps found while reading, both of which a naive plan would have walked into:

- The national case-law service licenses its records under the Open Justice Licence, which states that it **does not permit computational analysis**; bulk programmatic use needs a separate licence from the service. Run through a classifier, those records are computational analysis. Do not use them without that licence.
- The Open Government Licence v3 **excludes personal data**. Government pages that list a named official's telephone number or address are exactly the "named officials with contact details" population, and they fall outside the licence grant. Role addresses of a press office are not personal data; named individuals' details are. The licence for parliamentary material (the Open Parliament Licence) could not be read from this environment and is unverified.

### Solicitation of child sexual abuse in text

| Corpus | Licence | Size | Labels | Access | Content risk |
|---|---|---|---|---|---|
| PAN 2012 sexual predator identification | the Zenodo record shows access `open` and no licence field | a 91.2 MB archive; per papers, about 67,000 training conversations, 142 predator accounts | which accounts are predators | Zenodo, direct | real chat logs of adults soliciting people presenting as children, sexually explicit, identifiable people |
| OpenAI moderation samples (see below) | MIT | about 1,680 samples by file name | per-category binary flags, including a category for sexual content involving minors | public repository, archived | the minors category is a small slice of text; its contents are not described on the page read |

### Comment layers

| Layer | Source | Licence | Size | Notes |
|---|---|---|---|---|
| Harassment | Civil Comments `insult` and `identity_attack`; Contextual Abuse Dataset | CC0; CC BY 4.0 | as above | Enough open labelled data. |
| Sexual content | Civil Comments `sexual_explicit`; OpenAI moderation samples (sexual) | CC0; MIT | as above | Enough open labelled data. |
| Spam | YouTube Spam Collection | CC BY 4.0 | 1,956 comments on 5 videos, spam or not | Direct download, small and a different platform from a publisher's site. Larger email and SMS spam sets exist: not read here. |
| Self-harm | OpenAI moderation samples (self-harm flag); NVIDIA Nemotron/Aegis safety dataset (suicide and self harm category) | MIT; CC BY 4.0 | about 1,680; about 11,997 | The second is prompts taken from a public assistant-training set with machine-written replies: wrong domain for a comment section. Clinical-community datasets are normally under a data-use agreement and were not read. |
| Off-topic | none | | | Off-topic is relative to a tenant's own site, so no fixed corpus can measure it. |

Supplementary, wrong domain: the OpenAI moderation samples (public text, eight category flags where a missing flag means unknown rather than negative) and the NVIDIA Nemotron/Aegis dataset (CC BY 4.0, 13 categories including threat and personal data, content warning on its card) are prompts and replies to assistants, not publishing. They are useful as a second opinion on a category, not as the corpus.

## Recommendation

**First honest run: Civil Comments, Dynamically Generated Hate Speech and Measuring Hate Speech, plus a stratified sample from CourtListener and from Global Voices.** All are open without a request, none holds an image, and together they give per-check negatives and positives for threats, incitement, harassment and sexual content. Reason: the cleanest licences found (CC0 and CC BY, no gate, no agreement), the largest labelled volumes, and the only two sources of challenging-topic journalism and court text that are openly reusable. The platform needs an answer it can publish, and a published number must rest on terms that allow publishing.

| Check | Recommendation | Reason |
|---|---|---|
| Threats | Civil Comments `threat` as the positive set, its other comments and the journalism strata as negatives. Ask the THREAT authors for their licence in parallel. | The only gate-free positive source; the specialist corpus is better but unlicensed on its face. |
| Incitement or hatred | Dynamically Generated Hate Speech and Measuring Hate Speech as positives, HateCheck's contrast cases and the journalism strata as negatives. Leave Counter for a separate legal decision. | CC BY and ungated. Counter is the nearest to incitement but is real extremist propaganda. |
| Targeting packages | Measure false positives only: court listings, press-office quotations, notice-board text drawn from CourtListener, Civil Comments and Global Voices. The recall of this check goes unmeasured, so it stays advisory-only. | No open genuine-harm set exists, and building one is authoring. Advisory-only is already the launch position, so nothing is held on an unmeasured judgement. |
| Solicitation in text | Select no positive set. Measure false positives against every benign population above and leave the check advisory-only. | The only open collections are real sexual chat logs involving minors and identifiable people, which conflicts with the rule that nobody on the team views suspected material. |
| Harassment, sexual content | Civil Comments labels, plus the Contextual Abuse Dataset for harassment. | Enough open data. |
| Spam | YouTube Spam Collection to start; a larger spam corpus to be read before it is relied on. | Open but small and from another platform. |
| Self-harm | Do not select now. | Every source found is the wrong domain or gated; the layer is tenant-set, held items are released by the tenant, and it stays advisory-only until measured. |
| Off-topic | Out of the corpus eval. | It is relative to each site. Measure it against a tenant's own pages once there are any. |
| Hash match | No corpus. | See above. |

A check with a recall that cannot be measured is not blocked from shipping: every text check ships advisory-only until it earns enforcement, and this page changes none of that.

## The ceiling comes first

A false-positive ceiling, agreed before any number exists, caps how far a curve may be read: no check enforces above it however good it looks. It is not set here and the harness has no default. The first run must not begin until it is recorded, and the report echoes the ceiling and its basis so a run that used a different one is visible. The harness offers two bases: the observed rate, or the upper end of a 95 per cent Wilson interval, which a small corpus cannot flatter.

## Selection by procedure, not by taste

Choosing the sources and strata is the owner's editorial judgement. Drawing items from a chosen stratum is then done by a recorded procedure (the stratum, a fixed random seed, the count) so that no agent picks individual passages and the draw can be repeated. Recording the corpus identifier, version and licence in the manifest header carries the provenance into every report.

## What the owner must decide

1. **The first-run set.** Approve, amend or reject the set in the recommendation. This is the only decision that blocks the run itself.
2. **The sources and strata for the journalism and court samples.** For example which kinds of coverage in Global Voices and which kinds of opinion in CourtListener stand for "writing our target publishers do". Names and categories, not passages.
3. **Whether to write to the THREAT authors to ask for a licence.** Sending a message on the organisation's behalf is the owner's act.
4. **Whether the platform may hold the Counter extremist-text corpus.** A legal view; absent one, it is left out.
5. **Targeting packages:** accept false-positive-only measurement, or approve a proxy positive set (which edges toward authoring) or an approach to researchers.
6. **Solicitation in text:** accept false-positive-only measurement, or route the genuine-harm measurement through an institution that already lawfully holds such material and returns counts only.
7. **The ceiling and its basis**, before the first run.

Time: one sitting of about thirty minutes for decisions 1, 2, 5 and 6 on the card, which is a forecast and not a schedule. Writing to the authors is a few minutes of the owner's time, with an external wait for a reply.

## After the choice

An agent fetches only the chosen ungated text corpora into a local directory outside the repository, writes the sampling procedure, builds manifests and runs each check as it comes to exist, committing manifests' hashes and reports but never the corpora. Until a text check exists the harness has nothing to score; that dependency sits with the check, not with the corpus.
