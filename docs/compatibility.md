# Installed DSH compatibility

The compatibility target is the existing Windows DeepSeek Harness installation
whose `@deepseek-ai/dsh-*` packages report `0.1.0-rc.6`, using Node 22 or newer.
The separately reviewed official 0.2.2 source is reference material. It is not
installed, substituted for the desktop runtime, or treated as proof about rc.6.
No DSH core files need changes and no packages need installation.

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
arguments cannot change those values. Planning does not resolve a credential or
generate a model response. The credential provider is accessed only for the
single explicitly approved reference during execution.

An unconfigured bundle stays dormant, logs a configuration warning, and registers
no tools. A partially configured bundle fails with a specific configuration error.
Report lookup fails cleanly when the requested run does not exist.

For each plan or run the plugin snapshots the public
`sandboxPolicy.resolve({session: exec.agent?.session})` facts and the approval
service's public `overrideOf(session)` and configured default. Those facts enter
the recorded security policy; unavailable or invalid policy information is marked
unknown. Reading a host policy does not grant remote access: authorization still
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
`immutableRevision: null` and `assurance: "config_only"`. Strict cross-run reuse
is disabled with reason `model_revision_unknown`, even when inputs are unchanged.
An environment variable cannot manufacture an immutable revision. Endpoint and
fixed execution controls belong to identity; repository authorization and live
budget counters are checked separately.

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
