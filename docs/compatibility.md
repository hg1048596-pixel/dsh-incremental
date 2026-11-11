# Installed DSH compatibility

The compatibility target is the existing Windows DeepSeek Harness installation
whose `@deepseek-ai/dsh-*` packages report `0.1.0-rc.6`, using Node 22 or newer.
The separately reviewed official 0.2.2 source is reference material. It is not
installed, substituted for the desktop runtime, or treated as proof about rc.6.
No DSH core files need changes; the plugin uses the public packages already
shipped with that runtime.

The local core now passes a real DeepSeek API acceptance chain through this
installed runtime: four initial task executions, four unchanged result reuses
with zero completion calls, then two executions and two reuses after changing
only pricing. The route is `deepseek-flash`, `visible-model`, with a 24-hour TTL.
Each stage also makes one model-catalog GET. See the [core results](core-functionality.md)
and [portable acceptance evidence](evidence/core-acceptance.json), which retain the
earlier unsuccessful attempt. This checks the core engine with the real adapter
on one small example; it is not installed desktop UI end-to-end validation,
general performance evidence, or proof of review correctness.

The explicit `runtimeRoot` identifies the existing `dsh-app` directory containing
`package.json` and `node_modules`. Resolution uses `createRequire` from that
directory and imports package roots exported by their public `exports` map. It
never imports private adapter, registry, session, or runtime files as APIs.

## Tool contract

The rc.6 `@deepseek-ai/dsh-tools` root exports `defineTool`. Every registered tool
declares `output.schema` and `output.render`. Its body returns a canonical JSON
value; the renderer creates text content from that validated value. Returning
`{content: [...]}` as though it were the canonical registry result is incorrect.

The plugin registers `incremental_plan`, `incremental_run`, and
`incremental_report`. The host fixes repository, manifest, state location,
provider, model, credential reference, endpoint, and remote authorization. Tool
arguments cannot change those values. Planning never generates a model response.
With explicit `visible-model` reuse, both planning and execution resolve only the
approved credential reference to query the configured `/models` endpoint.
Strict mode does not query that metadata endpoint.

An unconfigured bundle stays dormant, logs a configuration warning, and registers
no tools. A partially configured bundle fails with a specific configuration error.
Report lookup fails cleanly when the requested run does not exist.

For each plan or run the plugin snapshots the public
`sandboxPolicy.resolve({session: exec.agent?.session})` facts and the approval
service's public `overrideOf(session)` and configured default. Those facts enter
the recorded security policy; unavailable or invalid policy information is marked
unknown, and unknown sandbox/approval facts make results ineligible for reuse.
Effective policy facts and session identity enter the cache key. rc.6's public
SandboxExecutionPolicy identifies per-session backend security state, so a new
session is conservatively treated as a new permission boundary.
Reading a host policy does not grant remote access: authorization still
comes only from the fixed host configuration. This records the host's file policy;
it does not claim that the independent model executor supplies process confinement.

Runs are foreground operations and forward cancellation. The optional jobs
controller was evaluated: rc.6 completion delivery belongs to the existing
`dsh-tool-jobs` composition, whose default can wake the owning model. Its public
per-job API does not guarantee quiet completion. Background mode therefore fails
explicitly; this plugin neither mounts a controller nor creates follow-up turns.
Disposal first prevents new plan/run operations, cancels active operations, and
waits for operations that were still reading their manifest before releasing the
private executor. Executor disposal also rechecks its state after asynchronous
repository validation, so a late validation cannot dispatch against a disposed root.

## Isolated model executor

Each executor creates `new Context()` and mounts `LlmRuntime` on that independent
root. It does not inherit the host's LLM waterfalls, retry listeners, conversation
history, tools, workspace instructions, settings, or credential discovery. There
is exactly one frozen provider route. The direct DeepSeek route constructs the
public `DeepSeekAdapter` with public `resolveAdapterOptions`. The pi-ai route
uses that package's public plugin entry to construct `PiAiAdapter`, with exactly
one fixed profile and a restricted credential service. No retry plugin is mounted
and the profile's retry policy is capped at zero retries.

The request includes only the engine's frozen system prompt and user text, an
empty tools list, the configured model, and an output cap at most 4096 tokens.
The executor also enforces a timeout and a maximum of 48 requests, including a
shared mutable budget when supplied by the host. A dispatch consumes one call
even if the provider later fails. There is no automatic retry.
Model-catalog GET attempts are counted separately from completion calls and
recorded in `identityObservation.requestCount`.

The reader accepts text and reasoning stream blocks, discards reasoning, and
parses visible output strictly as JSON. It rejects tool calls, unknown blocks,
malformed streams, non-stop finishes, truncation, missing finishes, and invalid
review schemas. A failed response is not repaired or executed. Usage is recorded
only when actually supplied; unknown usage is null. Failure errors retain known
usage and the dispatch count without copying raw provider error payloads.
Known terminal finish kinds map to fixed error codes; provider-defined finish
labels and thrown adapter error codes are not copied into reports.

The endpoint must be explicit. HTTPS is required except for loopback HTTP. The
approved repository root and `allowRemote: true` are checked before dispatch.
Credentials come only from the named environment variable or the host's explicit
resolver for that same reference. No `credentials-local` directories are scanned;
no credential value is logged, hashed into identity, or written into reports.
Offline wire tests intercept the official DeepSeek and pi-ai OpenAI-completions
adapters before transport and verify the configured URL, named credential,
empty tools, supplied messages, usage mapping and output cap. This verifies
request construction for those routes; the installed official adapter and its
transport remain trusted for redirects and provider-specific protocol behavior.

## Model identity and reuse

The current adapter metadata exposes the configured provider/model identifier,
not a provider-attested immutable model revision. Identity records
`immutableRevision: null`. Strict mode records `assurance: "config_only"`; cross-run reuse
is disabled with reason `model_revision_unknown`, even when inputs are unchanged.
An environment variable cannot manufacture an immutable revision.

After explicit user approval of the weaker policy, `reusePolicy.mode:
visible-model` supports real result reuse through the direct DeepSeek adapter.
Each engine plan/run calls `prepareRun()` and receives a frozen run-specific view.
A controlled authenticated `/models` GET contributes only the selected entry's
id, optional name and owner to identity. Query time and unrelated catalog entries
do not invalidate results. Missing/failed observations disable reuse. Base
executors remain ineligible until preparation succeeds.

This observation describes the advertised route; rc.6's public adapter discards
wire response model/fingerprint metadata, so it is not a completion revision
attestation. `immutableRevision` remains null and both uncertainty risks are
reported; assurance is `configured-visible-route`. The user-authorized policy accepts same-ID backend changes that may
remain undetected. A mandatory maximum age (24h by default, at most 30 days) starts
at result creation, is not extended by hits, and expiry forces execution. `--full`
also forces execution. The default remains strict.

The real acceptance chain preserves every version on the unchanged run and
preserves only auth/pagination versions after the pricing edit. The first fresh
attempt did not pass reuse acceptance because auth reported a dependency gap
and summary inherited it. Prompt v3 then clarified that missing facts required
for a scoped conclusion belong in `unknownDependencies`, while unreviewed wider
behavior belongs in `limitations`; genuine missing dependencies must still be
reported. New real outputs in a fresh repository/state passed the full chain.
The earlier outputs were retained, not edited to enable reuse.

Endpoint, visible identity, policy and fixed execution controls belong to the
cache key; repository authorization and live budget counters are checked
separately. No DSH core interception or global transport patch is used.

`doctor` reads installed versions, validates required public exports, and hashes
the resolved entry files. It does not boot DSH, resolve credentials, call a model,
or alter the installation. Hashes permit later comparison; without a trusted
baseline it reports modification status as unknown and does not claim that core
files are pristine. Installed-runtime smoke tests use a fake adapter and the
actual rc.6 LLM/tool services; they make no provider network calls.
An executor-to-engine integration test completes two offline runs through the
installed LLM service and confirms both execute because the model revision is
unknown. A separate temporary-profile smoke test uses the public
`loadProfile`, `composeEntries`, and `Loader` APIs to resolve this package's
declared bundle patch, activate all three configured tools, and unload them.
The fixture links the local package into its own temporary profile and blocks
`fetch`; it does not run `dsh plugin add`, pnpm, an installer, or any existing
user profile. The subsequent [offline installation verification](installation-verification.md)
also exercised the public rc.6 CLI and existing pnpm with the local tarball in an
isolated profile, followed by configuration composition and activation from the
installed copy; no provider credentials or network requests were used.
