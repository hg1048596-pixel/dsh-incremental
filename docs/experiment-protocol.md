# Experiment protocol

This project tests whether declared task inputs and dependency edges can safely support reusable review results. The built-in executor is a deterministic, rule-based synthetic analyzer. Its results and timings do not establish AI review quality, model cost savings, or performance on a production repository.

## Repository and reference snapshots

`examples/demo-repo` contains three independent JavaScript modules and a four-task manifest. The `auth`, `pricing`, and `pagination` tasks each declare exactly one source file. The `summary` task has no direct source files and depends on those three module tasks. None of the modules import or execute another module.

The initial source has three fixed-reference defects: a role substring check inconsistent with the exact-role contract, acceptance of a negative item quantity despite the stated validation requirement, and an absolute slice-end index that breaks later pages. The experiment changes only `src/pricing.js` by adding the negative-quantity check. The changed reference snapshot therefore has two remaining fixed findings.

`examples/ground-truth.json` is outside the reviewed repository. It declares SHA-256 hashes for every source file in both the initial and changed snapshots, together with exact finding paths, one-based source lines, and evidence. The preparation step copies that reference beside each experimental repository, outside its root. Neither the reference nor the fixture executor implementation is included in review inputs, descriptions, or acceptance criteria. There are no answer-key annotations in the source files or review prompts.

The source repository is copied into a fresh artifact directory for every repetition. State directories and raw reports also remain outside the copied repository. Preparation refuses to overwrite an existing copied repository; the experiment does not recursively delete or move directories, and never imports or executes reviewed JavaScript.

## Synthetic demonstration

Run `node bin/dsh-incremental.js demo`. All calls use the fixture executor, whose identity contains the SHA-256 of its implementation. Expected task counts are:

| Stage | Executed | Reused | Expected fixed findings |
| --- | ---: | ---: | ---: |
| Initial input | 4 | 0 | 3 |
| Unchanged input | 0 | 4 | 3 |
| Pricing-only edit | 2 | 2 | 2 |

The last stage recomputes pricing and the downstream summary. Authorization and pagination remain eligible for reuse. A successful demonstration requires the observed reports to show these counts and retain the expected source evidence. The fixture makes zero model calls and reports token usage as `null`.

## Paired benchmark

Run `node bin/dsh-incremental.js benchmark` for the default synthetic experiment. A real-model executor must be selected explicitly using the CLI's documented provider options; the benchmark does not silently choose a model, read credentials, or send repository files to a provider on its own.

The default is three independent repetitions. Every repetition uses the same source, task manifest, and executor identity/model controls. The runner is sequential, with concurrency one and no retries. Its four stages are:

1. Seed the incremental state using the initial snapshot.
2. Run unchanged input against that state.
3. Apply the declared pricing-only edit and run a full review with a separate state directory.
4. Run the identical changed snapshot against the existing incremental state.

The order of stages 3 and 4 alternates by repetition. Full and incremental reviews see identical changed source bytes and manifest bytes. Full review state cannot overwrite the seeded incremental cache.

The runner verifies source and manifest hashes immediately before and after each stage. Before scoring, it also compares each task's `inputSnapshot.files` against the declared reference snapshot, so a factory or executor cannot silently change the consumed input while retaining the same claimed experiment condition. Missing or incomplete evidence cannot establish a completed paired comparison. Cancellation stops later stages, source edits, and executor creation; incomplete comparisons remain unknown.

The executor factory receives `{repetition, stage, repoRoot}`. It must preserve the same model, revision controls, prompt, response schema, generation settings, and provider behavior. The report records every executor identity and whether those identities were identical; a differing identity is a visible control failure, never a reason to relax cache validation. Repository routing authorization may vary by copied root without changing model controls.

Strict real-model executors must disable reuse when model/revision identity cannot be pinned under the project's reuse policy. If all upstream tasks succeed, all four tasks execute at every stage: at most 16 calls per repetition and 48 over three repetitions. An invalid or failed module result blocks its downstream summary, so an unsuccessful experiment can make fewer calls. The observed calls and blocked tasks remain in the report. Fixture mode normally executes 4, 0, 4, and 2 tasks respectively. Cache eligibility and reasons are preserved per stage so the two modes can be distinguished.

## Supplementary explicit-line-number pair

`runPairedBenchmark` is a separate follow-up protocol for requests that expose explicit source line numbers. It prepares the same declared pricing-fixed snapshot and runs one full review followed by one incremental review. Both use independent, initially empty state directories. There is no seed or unchanged stage, so this pair does not measure seeded incremental cache savings. Strict unpinned real executors are expected to execute both reviews; upstream failures may block a summary. The dispatch cap is eight, with the same concurrency-one and no-retry controls.

The helper retains both raw reports and the standard JSON/Markdown benchmark artifacts under the protocol ID `supplemental-numbered-lines-pair-v1`. It records this request-presentation change and the absence of seeded incremental state. The follow-up is reported separately from the baseline: it must not erase failed baseline runs or be pooled with their measurements. Any provider-request budget shared with earlier runs is configured externally and must remain within the overall approved cap.

## Request budget and actual measurements

The benchmark caps non-fixture task-execution dispatches centrally at 48, even when a factory creates a new executor for each stage. A non-fixture executor must make at most one actual provider request per execution, including failure paths, and must not retry internally. The real executor also maintains its own provider-request budget; factory construction must not reset that shared budget. Budget exhaustion is reported as a failed task with zero additional model calls.

Reports use actual executor/provider-reported model calls and usage. They preserve `null` when usage or a complete model-call total is unavailable. `knownModelCalls` retains observed calls and `unknownCallCounts` retains the number of tasks with unknown call counts; an unknown count is never converted to zero. Missing usage is never replaced with a token or monetary estimate. Aggregate usage sums only reported numeric fields and includes the number of runs with available usage. Individual task and run reports retain the engine's measured total, snapshot, execution, and cache times. The paired comparison records measured time differences; it does not claim a statistically reliable speedup from three repetitions.

For every repetition, artifacts preserve the four raw run reports, copied repository, external reference, initial and changed source hashes, state directories, executor identities, reuse reasons, usage, and reference scores. The top-level `benchmark.json` and `benchmark.md` retain observations and limitations. The demo similarly retains three raw reports plus `demo.json` and `demo.md`.

## Finding checks and interpretation

Scoring uses the final summary task. A known finding matches only when normalized relative path, one-based line number, and trimmed source evidence equal a fixed reference entry. Titles and prose wording are not scored. Reports list matched reference IDs, missed IDs, and every unmatched finding. Exact evidence-set equality between the paired full and incremental summaries is recorded separately.

This checks retention of selected concrete findings. It does not fully adjudicate semantic correctness, severity, completeness, duplicate explanations, or legitimate additional findings. An unmatched finding is not automatically a false positive. Source-hash verification prevents silently scoring a different fixture snapshot as if it were the declared one.

Incremental correctness is conditional on complete input declarations and dependency edges, executor identity, output validation, and conservative reuse policy. This four-task graph does not demonstrate detection of undeclared semantic dependencies. A wider source dependency requires a corresponding manifest declaration or an explicit full run. Findings remain review results, not proof that code is correct.
