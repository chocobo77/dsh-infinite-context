# dsh-infinite-context — Architecture

A DeepSeek Harness (DSH) plugin that delivers "infinite context" through
**multi-tier memory management**: it automatically summarizes long conversations
into persistent, searchable memories, retrieves the most relevant ones for each
new question, and enforces a token budget that tracks the **currently routed
model's real context window** — probed live for local servers, declared for
online providers — so the context never overflows, and the plugin can even
intervene mid-generation while the model is deep-thinking.

---

## 1. The problem and the approach

A locally-deployed LLM has a hard context-window ceiling (e.g. 94k tokens). A
long single conversation exhausts it and the session cannot continue. The
standard remedy is **compaction** — replacing an old span of history with a
summary. DSH already ships a compaction backend (`compaction-basic`) that does
this correctly (balanced tool-call ranges, durable replacement, token metering,
LLM summarization).

This plugin builds on that seam rather than reinventing it, and adds the three
things a naive compaction loses:

1. **Persistence** — summaries are written to SQLite and survive restarts.
2. **Tiering** — instead of one flat summary, memories form a three-tier
   pyramid (short / mid / long).
3. **Semantic retrieval** — embeddings let the next question pull in the
   *most relevant* past memories, not just the most recent.

The result behaves like an associative memory in front of a fixed-size context.

---

## 2. High-level architecture

```
                cordis.yml
   ┌─────────────────┼──────────────────────┐
   ▼                 ▼                      ▼
memory-context    memory-compaction    memory-tools
   (Service)        (extends             (tools)
   MemoryContext   BasicCompactionEngine)
      │                   │                    │
      │  provides         │ injects            │ injects
      ▼                   ▼                    ▼
┌─────────────────────┐  ┌───────────────────────────────────────────┐
│ MemoryEngine (core) │  │ summarize() ── persist mid-term ── rebalance│
│  • MemoryStore      │  │ pre-step ── retrieve + inject top-K         │
│  • Embedder         │  └───────────────────────────────────────────┘
│  • VectorIndex      │
│  • TokenBudget      │
│  • ForgettingPolicy │
└─────────────────────┘
   │                            ▲
   └── SQLite ──────────────────┘ (persistence)
```

Three Cordis entries make up the plugin:

| Entry | File | Kind | Role |
|---|---|---|---|
| `memory-context` | `src/memory-context.ts` | `Service` → `ctx.memoryContext` | Owns store + embedder + index + budget + forgetting; exposes the `MemoryEngine`. |
| `memory-compaction` | `src/memory-compaction.ts` | `MemoryCompactionEngine extends BasicCompactionEngine` → `ctx.compaction` | Does compaction, persists each summary, rebalances the pyramid, injects retrieved memories. |
| `memory-tools` | `src/tools.ts` | function plugin | Manual tools (`memory_search`, `memory_status`, …). |

`memory-context` must load before `memory-compaction` (the latter injects it);
Cordis enforces this via the `inject` declaration, not file order.

---

## 3. Multi-tier memory (the pyramid)

Each memory document has a `tier`. The tiers encode *recency and abstraction*:

| Tier | What it holds | In the model context? |
|---|---|---|
| `short` | The recent tail kept verbatim by compaction's `retainTokens`/`retainRatio`. | Yes — it's the live session surface. |
| `mid` | An LLM summary produced by each compaction. Persisted to the store and indexed. | The newest one can be kept in context (budget `mid`). |
| `long` | A consolidated summary of several `mid` memories (the pyramid apex). | Optionally kept (budget `long`). |

**Pyramid consolidation** (`MemoryEngine.consolidate`): when the number of `mid`
memories reaches `pyramid.mergeThreshold`, the oldest `mergeBatch` are folded —
via an LLM call — into a single `long` memory (`mergedFrom` records the folded
ids). The folded `mid` rows are NOT deleted: the merge is lossy, so they are
demoted to the `short` tier at a low importance (`demotedMids` in the result)
and the forgetting policy retires them naturally, making the loss reversible
while the originals are still retrievable. `long` memories beyond `maxLong`
are trimmed oldest-first. This is the "pyramid" the task asks for: summaries of
summaries at higher and higher abstraction.

---

## 4. Token budget

`TokenBudget` allocates the window across the memory tiers and the live input:

```
window (94k)
├── headroom (25%): system prompt, tools, current input, output
└── memory budget (maxTotal)
    ├── short   10k
    ├── mid     20k
    ├── long     5k
    └── retrieved 15k
```

`TokenBudget.validate()` rejects a configuration whose tiers exceed
`window - headroom`. A CJK-aware estimator (`estimateTokens`: ~1 token per Han
character, ~1/4 token per other character) is used by `fits()` and
`truncateToBudget()` to decide whether a memory fits a tier and to trim
over-long memories line-by-line.

The two budgets (the `memoryContext.budget` here, and `compaction-basic`'s
`retainTokens`/`retainRatio` for the short-term tail) are complementary: the
core budget governs the persistent tiers, while compaction's retention governs
the verbatim recent tail.

---

## 5. Forgetting

`ForgettingPolicy` scores each memory as a weighted blend of **importance** and
**recency**:

```
score = importanceWeight × importance
      + recencyWeight × 0.5^(ageDays / halfLifeDays)
```

`selectToForget()` drops (a) any memory below `minScore`, and (b) the
lowest-scoring extras needed to respect `maxMemories`. Dropped rows and their
embeddings are removed from both the store and the vector index. The sweep runs
after each compaction (`MemoryEngine.rebalance`).

---

## 6. Embedders

`Embedder` is a small interface (`dimension`, `name`, `embed(text)`). Two
implementations:

- **`lightweight`** (default, dependency-free): signed feature-hashing of tokens
  into a fixed-dimension vector with sublinear term weighting, L2-normalized. It
  handles CJK by tokenizing each Han character and requires no model download, so
  the plugin works out of the box. It captures lexical/character overlap, not
  deep semantics.
- **`transformers`** (optional): `all-MiniLM-L6-v2` via `@huggingface/transformers`
  (transformers.js, 384-dim). Enabled by setting `embedder.kind: transformers`
  and installing the optional dependency. Loaded lazily so the optional package
  never blocks the default path.

The vector index is an in-memory linear-scan cosine index over the embeddings
persisted as `Float32` BLOBs in SQLite — fast enough for hundreds to low
thousands of memories. For much larger corpora, swap `VectorIndex` for an ANN
index or a dedicated vector DB (Qdrant/Chroma); the interface is isolated in
`src/vector-index.ts`.

---

## 7. Retrieval injection

When a new user turn arrives, `memory-compaction` listens on `agent/pre-step`
(after compaction's own hook, since it registers later) and:

1. Extracts the latest user text from the request `messages`.
2. Calls `memoryContext.retrieve(text, topK, minScore)` → top-K memories above
   the relevance floor.
3. Filters out hits already injected in the previous turn (`lastInjectedIds`,
   cross-turn de-dup) and hits already VISIBLE on the active surface (§7.1).
4. If any are left, splices a clearly-framed background message into the
   request `messages` **immediately before the latest user message** and
   returns `{ kind: 'enter', messages: [...] }` — inserting at that anchor
   (rather than appending) keeps the question last, so instruction ordering in
   the replayed context stays intact.

Because the pre-step waterfall's final `messages` are appended to the session
as `user/message` events (the same durable idiom `compaction-basic` uses for its
checkpoint), the injected memories are part of the replayed context and are
themselves eventually compacted away. Injection happens at most once per turn
(`lastInjectedTurn`), and only when the retrieved memories clear the
`retrieval.minScore` floor, so it does not spam every tool-call step.

`retrieval.enabled` can be turned off; the manual `memory_search` tool then
provides on-demand retrieval instead.

### 7.1 Surface-aware de-dup (`rag_surface_dedupe`)

A tool result is ingested the moment it settles, but its text stays on the
active context until compaction eats it. Retrieving it back a step later spends
tokens to re-send what the model can already read — the measured case was three
short-tier memories scoring 0.46/0.44/0.43 that were verbatim copies of file
reads still on the surface.

`VectorRetriever.retrieve(query, excludeIds, tokenBudget, surfaceTexts)` takes
the text of every message in the request and, before the budget loop:

- normalizes each side (`normalizeSurfaceText`: lowercase + collapse every
  whitespace run to one space — re-wrapped or re-cased copies still match);
- splits the memory into segments (`surfaceSegments`) on newlines and
  sentence ends, drops the `[tier=…, score=…]` provenance header (added at
  injection time, never present on the surface) and any segment shorter than
  20 chars (short strings collide by accident);
- suppresses the memory when ≥70% of its segments appear in the surface blob.

Two invariants matter:

- **State-dependent, never permanent.** Suppression is a per-call filter; it
  writes nothing. Only ids of memories ACTUALLY injected enter
  `lastInjectedIds`. Once compaction moves the text off the surface the memory
  is injected normally again.
- **No cross-message false positives.** Surface messages are joined with a NUL
  separator, so a segment can never match across a message boundary.

The surface is materialized lazily (once per step, only if a check needs it).

### 7.2 Local-model conciseness mode (`concise_local_mode`)

A local model's narration ("让我先看看…") is re-sent as input on every later
request and re-paid after each cache expiry; the observed session ran at ≈76:1
input:output. When `ctx.memoryContext.isLocalRoute(requestContext.provider)`
holds (loopback / private-LAN `baseURL` from the `llm-pi-ai` settings
namespace — the same gate that decides whether a live context probe is
warranted), one short directive is spliced in **after** the memory background
and immediately before the latest user message:

```
<runtime_directive scope="dsh-infinite-context:concise">
本地模型运行中，请压缩输出：工具调用之间不要写任何说明文字，直接连续发起调用；
相互独立的调用合并到同一回合并行发出；不要复述文件内容或工具输出；
所有解释、结论与总结集中写在最终答复里。
</runtime_directive>
```

Why the injection point is `agent/pre-step` and not the system prompt: the
`llm/stream` waterfall hands a loop-built request in **deep-frozen** form
(mutation throws) — listeners read it, never rewrite it; `GenerateOptions.system`
is for one-shot callers only, and a loop request carries its system prompt as the
leading system-role message INSIDE `options.messages`. The pre-step decision's
message list is the supported place to add per-turn text, and it is the same
mechanism the RAG background already uses.

Idempotence: the directive would otherwise be re-added on every step, since an
injected message becomes part of the durable session log. `hasConciseDirective`
scans the current surface for the marker and skips the injection while a copy is
still present; compaction dropping the copy re-arms it. The check is on surface
state rather than a turn counter, so it also survives restarts and rewinds.

### 7.3 Tool-result archive (CCR)

DSH ships a `tool-result-pruner` that rewrites a tool result above 8192 chars to
`head(4096) + "[... tool result middle pruned ...]" + tail(1024)`. The middle is
gone permanently, there is no read-back path, and it only runs when a compaction
happens to fire — between two compactions an oversized result sits on the surface
at full size. The plugin turns that lossy cut into a recoverable one:

- `tools/result` is an observer notification, so `capture()` sees the RAW content
  before anything prunes it. Payloads above `tool_archive_threshold_chars`
  (default 6000, deliberately below the pruner threshold of 8192 so our stub wins)
  are stored verbatim in `tool_results` under a content-addressed
  `ref = "tr_" + sha256(text)[0..12)`; the same payload archives once, however
  many times it is produced. Ingestion into the memory pyramid is unchanged.
- The live node is then replaced by a stub of `tool_archive_head_chars` (2048) + a
  marker carrying the ref and the original size + `tool_archive_tail_chars` (1024)
  (`replaceTextMiddle`, which refuses to write a stub that would not shrink the
  message). The rewrite uses the same surface op the built-in pruner uses:
  `session.append("tool/result", { ...event.data, message }, { surfaceOp: { op: "replace", startSeq, endSeq }, sourceEventSeqs: [seq] })`.
- Two rewrite points: `agent/pre-step` (before `next()`, i.e. before the request is
  built) rewrites only nodes appended since the previous pass, and
  `compactIfNeeded` rewrites every oversized node FIRST, so our stub lands before
  the built-in pruner can destroy the middle.
- The barrier is what keeps this prefix-cache-safe. `lastPassSeq` (a WeakMap keyed
  by `Session`) records the highest seq seen in the first pass and never rewrites
  history: a node the provider has already been sent is never rebuilt, because a
  rebuilt prefix is a cache miss. Rewriting old nodes is acceptable exactly at
  compaction time, where the prefix was about to be rebuilt anyway.
- `memory_expand(ref?, query?, offset?, limit?)` is the read path: list or search
  the archive, page through one stored text by code point (offset/limit), or get
  ±200-code-point windows around `query` hits.

Retention (`tool_archive_max_entries` = 500, newest win, and
`tool_archive_retention_days` = 30) is enforced on the next capture. The archive is
exact text for retrieval, not memory: `tool_results` is never embedded, never
injected, and `memory_expand` sits on the ingest denylist so reading a 20K result
back does not re-ingest it.

### 7.4 Immediate distillation (`tool_absorb`)

7.3 shrinks an oversized result but still pays for its full head and tail on the
surface. The absorb pass is the complementary step: it runs on the RAW payload the
moment the result lands and extracts the lines that actually carry the signal.
`buildDigest(tool, text, options)` (src/absorb.ts) emits a header
(`[<tool> result absorbed: <chars> chars / <lines> lines]`), then the first three
lines, then every line matching one of ten signal patterns (error/failed/fatal/
exception/traceback, denied/refused/timeout/not found, warn/deprecated/retry,
`exit code N`, `N passed|failed|skipped`, test pass/fail summaries,
insertions/deletions and files-changed diff stats, extension-bearing file paths,
and `✗✘×`/`FAIL`/`ERROR`/`WARN`/`Traceback` line prefixes), and finally the last
three lines. Signal lines are capped at `maxDigestChars / 120`. Every line is
trimmed and clipped to 240 code points, blank and duplicate lines are dropped, and
the whole digest is hard-capped at `tool_absorb_max_digest_chars` (default 1200,
itself floored under the archive threshold so the stub is always smaller than the
text it replaces). A payload that yields nothing but its header (`kept.length <= 1`
— a whitespace-only blob) returns `null`, and the head+tail stub of 7.3 is used
instead: the digest has to earn its place.

The digest is stored in `tool_results.digest` next to the archived text and is ALSO
ingested into the memory pyramid under the producing tool name, so "which error did
that command report" is still retrievable after both the surface stub and the memory
have been compacted. `tool_absorb_min_chars` (4000) is deliberately below the
archive threshold (6000): a result can be too small to archive and still worth
distilling. `replaceTextWithStub` replaces the whole result with the digest text
plus a ref-bearing footer, dropping the remaining text blocks but keeping non-text
blocks in place; it refuses (returns `null`) when the stub would not shrink the
message, in which case the 7.3 path runs.

### 7.5 Compression scheduling nudge (`compress_nudge`)

`shouldCompressHistory` decides on ARRIVAL: it only sees the request that is
already built, so the first oversized request has already been paid for by the time
it fires. The nudge adds a predictive second check. `nextGrowthEma(previous, delta)`
keeps a per-session exponential moving average (weight 0.5) of how much the surface
grew between requests, updated in `HistoryCompressor.compress()` from
`lastSizeTokens`; `shouldNudgeCompaction` then fires when the current size is still
below the trigger but `tokens + growthTokens` is not — i.e. the next request would
cross it anyway. Six guards keep it honest: disabled, unknown or non-positive
growth, already over the trigger, growth not enough to reach it, a failure cooldown
in progress, and `turn - lastCompressedTurn < 1` all return false, so it never fires
twice in a turn. A nudged run sets `force: force || nudged` for the trigger and
returns `{ nudged: true }`, which the ledger records as its own kind so the two
paths can be told apart. The trade is a slightly earlier — and therefore slightly
more frequent — compression in exchange for not paying one oversized request.

### 7.6 Context accounting (`usage_ledger`)

Everything the plugin does to the context is measurable, and unmeasured it is easy
to tune blind. `UsageLedger` (src/usage-ledger.ts) appends one `usage_events` row
per measurement: injected tokens and memory count, surface skips, code points
removed by the archive, code points of the digests, nudged compressions, tokens
saved by compression, and the provider's own usage. Provider numbers are recorded
FIELD BY FIELD on purpose: DSH reports disjoint counts (`inputTokens` is the
UNCACHED input; the billed input is `input + cacheRead + cacheWrite`), so
pre-summing them would destroy the cache hit rate — the single most useful signal
for judging whether injection and prefix-preserving rewrites pay off. The ledger is
fed from three places: the `tools/result` observer (absorb/archive), the pre-step
governance path (injection, skips, compaction savings, nudge), and a `session/event`
subscription that reads `assistant/message`'s `usage`. `summary(days = 7)` folds
rows per kind and computes `cacheRead / (input + cacheRead + cacheWrite)`
(`memory_status` prints it); `record` silently ignores disabled, non-finite and
zero values, every store failure is logged and swallowed (metering never breaks a
turn), retention (`usage_retention_days`, default 30, 0 disables) is enforced every
256 writes, and `usage_events` is drained oldest-first. Each LLM record also
lends its `detail` column to the model id (`provider/model`, resolved through
`memoryContext.modelInfo`), so `summary(days).models` and `memory_status`'s
`usage.models` break the ledger down per model — the upstream MODEL SWITCHES
view — while per-kind totals stay unchanged.

---

### 7.7 Reversible compaction (`fold_ranges`)

Compression is only safe to run if what it folds away stays recoverable. Before
the fold takes effect, `HistoryCompressor` serializes the exact messages being
folded (the same serialization the summarizer sees, plus code points and a
token estimate) into `folded_ranges` and mints a `fl_…` ref (12 random hex
chars). The header prepended to the summary (src/fold-archive.ts
`foldedRangeHeader`) reports the message count and char count and names the ref,
so the summary block tells the model the exact messages are archived and how to
read them back; when no ref can be minted the header degrades to the plain
"details preserved below" form instead of promising a broken lookup.
`memory_expand ref=fl_…` restores the full serialized text and marks the row
restored, `memory_search` appends keyword hits inside folded history, and
`memory_status`'s `foldedRanges` reports count/chars/tokens plus the most recent
entries. Retention is bounded twice over (`fold_range_retention_days`, default 30,
0 keeps; `fold_range_max_entries`, default 300, trimmed oldest-first), both
enforced on every archive. This is the engine-layer equivalent of upstream
billion-context's `decompress` (docs/billion-context/ABSORPTION.md): the read-back
path is a tool call, not a surface rewrite — re-splicing old messages into the
live transcript would invalidate the prefix cache and unbalance tool-call/result
ranges, which the archive deliberately never touches. A compression whose output
is later rejected may leave one unused archive row; it is storage-only and stays
under the two retention bounds.

---

## 8. Component / module map


| File | Depends on DSH? | Responsibility |
|---|---|---|
| `src/types.ts` | no | Shared types (`Tier`, `MemoryDoc`, config shapes, status). |
| `src/embedder.ts` | no | `Embedder` interface, `LightweightEmbedder`, cosine/normalize helpers. |
| `src/transformers-embedder.ts` | no | Optional `TransformersEmbedder` (all-MiniLM-L6-v2). |
| `src/vector-index.ts` | no | `VectorIndex` (top-K cosine search). |
| `src/memory-store.ts` | no | SQLite (`node:sqlite`) persistence of `MemoryDoc`, the `tool_results` archive (+`digest`), the `folded_ranges` reversible-compaction archive and the `usage_events` ledger. |
| `src/absorb.ts` | no | Immediate distillation: `buildDigest` signal-line extraction (errors/counts/diff stats/paths + head/tail), line clipping, digest cap. |
| `src/usage-ledger.ts` | no | Context accounting: `UsageLedger.record`/`totals`/`recent`/`prune`/`summary`, disjoint provider-usage folding, per-model attribution (`detail = provider/model`), cache-hit rate. |
| `src/fold-archive.ts` | no | Reversible compaction: `foldedRangeHeader` (ref-bearing fold header with graceful degradation) plus `FoldOptions`/`DEFAULT_FOLD_OPTIONS` resolution. |
| `src/token-budget.ts` | no | `TokenBudget`, CJK-aware `estimateTokens` + content-block metering (`estimateContentTokens`: nested tool-result/tool-call payloads, capped). |
| `src/forgetting.ts` | no | `ForgettingPolicy`, scoring. |
| `src/memory-engine.ts` | no | Orchestration: store/embed/retrieve/consolidate/forget/status. |
| `src/model-context.ts` | no | `ModelContextTracker`: probe-once-per-model + retry cooldown, per-model window registry, probe-only-narrows. |
| `src/model-probe.ts` | no | Live context probes (llama `/props`, ollama `/api/show`, openai `/models` incl. LM Studio native) + `isLocalHostname`/`isLocalBaseURL` locality gate. |
| `src/compaction-policy.ts` | no | Pure trigger decisions: `decidePressureCompaction` (skip/force/delegate), `dynamicCompactionRatio` curve, `shouldCompressHistory` (surge/pressure/rate-limit), plus the growth nudge (`nextGrowthEma`, `shouldNudgeCompaction`). |
| `src/thinking-guard.ts` | yes | Mid-thinking guard: `llm/stream` wrapper, dynamic trigger line, overflow injection. |
| `src/summarization-target.ts` | yes | Summarizer routing: `configured ?? session model`. |
| `src/config.ts` | yes | Schemastery schemas + default resolution. |
| `src/memory-context.ts` | yes | `MemoryContext` service (`ctx.memoryContext`): probe wiring + locality gate + per-model adoption. |
| `src/memory-compaction.ts` | yes | `MemoryCompactionEngine` (extends `BasicCompactionEngine`): pre-step governance (compression → RAG injection → conciseness directive → truncation) + narrowed-window force + thinking-guard wiring + archive/absorb/nudge/usage-ledger wiring. |
| `src/OutputSanitizer.ts` | no | Tool-result sanitization: per-source strategies for rendered text and `ContentBlock[]` (the automatic `tools/result` path) plus structured JSON objects (web_search/code_exec/generic truncation, the manual ingest path). |
| `src/VectorRetriever.ts` | yes | RAG ingestion (dedup ×3, size caps, timeout) + budget-aware retrieval + surface-aware de-dup (`normalizeSurfaceText`/`surfaceSegments`/`isMemoryOnSurface`/`buildSurfaceBlob`, reporting a `skipped` count for the ledger). |
| `src/conciseness-mode.ts` | yes | Local-model conciseness directive: marker, default text, `createConciseMessage`, idempotence check `hasConciseDirective`. |
| `src/tool-archive.ts` | yes | Tool-result archive (CCR): content-addressed `tr_` refs, stub rewriting (`replaceTextWithStub` for absorbed digests, `replaceTextMiddle` otherwise; append-time + pre-compaction passes with a per-session barrier), retention/cap. |
| `src/tools.ts` | yes | Manual model-callable tools (incl. `memory_expand`, the archive read path). |
| `src/core.ts` | no | Barrel re-exporting the dependency-free core. |
| `src/index.ts` | yes | Package barrel. |

The dependency-free modules (`core`) are fully unit-testable in isolation; the
DSH-facing modules are thin integration layers.

---

## 9. Data model (SQLite)

```sql
CREATE TABLE memories (
  id                TEXT PRIMARY KEY,
  tier              TEXT NOT NULL,           -- 'short' | 'mid' | 'long'
  text              TEXT NOT NULL,           -- the summary Markdown
  created_at        INTEGER NOT NULL,        -- epoch ms
  importance        REAL NOT NULL,           -- 0..1
  source_session_id TEXT,                    -- provenance
  source_turn_start INTEGER,
  source_turn_end   INTEGER,
  embedding         BLOB,                    -- Float32 vector
  merged_from       TEXT                     -- JSON array of folded mid ids
);
CREATE INDEX idx_memories_tier   ON memories (tier);
CREATE INDEX idx_memories_created ON memories (created_at);

CREATE TABLE tool_results (
  ref        TEXT PRIMARY KEY,          -- "tr_" + sha256(text)[0..12)
  tool       TEXT NOT NULL,             -- producing tool name
  call_id    TEXT,                      -- tool-call id of the surface stub
  session_id TEXT,
  created_at INTEGER NOT NULL,          -- epoch ms
  chars      INTEGER NOT NULL,          -- code-point length of text
  text       TEXT NOT NULL,             -- the exact archived payload
  digest     TEXT                       -- absorbed signal-line digest (7.4), or NULL
);
CREATE INDEX idx_tool_results_created ON tool_results (created_at);
CREATE INDEX idx_tool_results_session ON tool_results (session_id, created_at);

CREATE TABLE folded_ranges (
  ref            TEXT PRIMARY KEY,       -- "fl_" + 12 random hex chars (7.7)
  ts             INTEGER NOT NULL,       -- epoch ms
  session_id     TEXT,
  messages       INTEGER NOT NULL,       -- folded message count
  chars          INTEGER NOT NULL,       -- code points of the serialized text
  tokens         INTEGER NOT NULL,       -- CJK-aware estimate at fold time
  summary        TEXT NOT NULL,          -- the summary the fold produced
  original       TEXT NOT NULL,          -- the exact serialized messages
  restored_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_folded_ranges_ts      ON folded_ranges (ts);
CREATE INDEX idx_folded_ranges_session ON folded_ranges (session_id, ts);

CREATE TABLE usage_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,          -- epoch ms
  kind       TEXT NOT NULL,             -- see USAGE_KIND (src/usage-ledger.ts)
  value      INTEGER NOT NULL,          -- round(); 0 is never written
  session_id TEXT,
  detail     TEXT
);
CREATE INDEX idx_usage_events_ts   ON usage_events (ts);
CREATE INDEX idx_usage_events_kind ON usage_events (kind, ts);
```

`memories` is the retrieval corpus; `tool_results` is an exact-text archive (7.3)
that is never embedded and never retrieved as memory; `usage_events` is the
append-only ledger behind `memory_status`'s context accounting (7.6) and is pruned
by time rather than capped by entry count; `folded_ranges` is the reversible
compaction archive (7.7): exact folded text, ref-addressable, bounded by age and
entry count.

Uses Node's built-in `node:sqlite` (`DatabaseSync`), the same medium DSH's own
`storage-sqlite` backend uses — no native `sqlite3` dependency. Missing parent
directories are created on open, so an absolute `storePath` into a not-yet-existing
directory works on first run.

### Where the file lives

A configured `storePath` is resolved by `resolveStorePath()`
(src/config.ts): `:memory:` passes through, an absolute path is used as given,
`~` expands against the user home, and a **relative** path resolves below
`<DSH_HOME>/storages` — never against the process cwd. The cwd is wherever `dsh`
was launched (a source checkout, an install dir, a temp dir), so a cwd-relative
store moves whenever that changes: every memory appears lost, and the orphaned
file sits in a directory a reinstall/re-clone deletes. `$DSH_HOME` follows DSH's
own precedence (non-blank env var, else `~/.dsh`). When a legacy cwd-relative
store is found and the resolved one does not exist yet, `memoryContext` logs a
warning naming both paths rather than starting silently empty.

---

## 10. Runtime flow

```
user message arrives
   │
   ▼
agent/pre-step (waterfall, registered order)
   │
   ├─ [BasicCompactionEngine hook → MemoryCompactionEngine.compactIfNeeded override]
   │    measure tokens (ctx.tokenMeter) + per-model REAL window (probe/registry)
   │    narrowed < declared and over the DYNAMIC threshold (~70% of real window)?
   │         ──► force overflow-style compactRegion ──► summarize()
   │                                              │
   │        [MemoryCompactionEngine.summarize]    │
   │          • super.summarize() (LLM checkpoint)
   │          • storeMemory(text, 'mid')          │
   │          • rebalance() = forget() + consolidate() (pyramid)
   │                                              ▼
   │                                    surface replaced with checkpoint
   │
   └─ [MemoryCompactionEngine retrieval hook] (registered after)
        observe request-context → adopt window / kick local probe (once per model)
        compress history if over the trigger water level (per-model budget)
        retrieve(topK, minScore) for the latest user text
        relevant? ──► append background memory message to request
        fallback truncation to window − headroom (image-aware metering)
   │
   ▼
llm/stream (waterfall) ── [thinking guard, agent-loop requests only]
   │    estimate input (system+tools+messages, nested tool payloads included)
   │    meter output as chunks flow
   │    input + output ≥ dynamic line (window − reserve, capped at ratio)?
   │         ──► yield CONTEXT_WINDOW_EXCEEDED finish
   │               ──► agent/request-error ──► durable compaction ──► retry
```

---

## 11. Model context awareness & the mid-thinking guard

### Per-model context registry

The routed model's window comes from three sources, narrowed in order:
the DSH catalog / `settings.yaml` declaration (`request-context`), an explicit
`modelWindows` override (`config`), and — for LOCAL servers only — a live
probe (`probe`) of the real runtime context. Windows are recorded per model
id, so a 1M remote session and a 167k local session sharing one runtime never
poison each other's budgets. Probing is gated by locality (`isLocalBaseURL`:
loopback / RFC1918 hosts only — online providers are never probed), runs once
per model with a 60s retry cooldown, and only ever NARROWS the window
(`min(probed, declared)`; the ceiling is the probed model's own declared
value, never the global last-observed slot).

OpenAI-compatible probes cover llama-server (`meta.n_ctx`), vLLM
(`max_model_len`), LM Studio (native `/api/v0/models`), and Ollama
(`/api/show`).

### Dynamic compaction threshold

`compaction-basic` scales its pressure threshold off the DECLARED window. When
the real window is smaller (a local model whose server runs 167k while the
catalog says 262k), that threshold is unreachable before overflow.
`MemoryCompactionEngine.compactIfNeeded` therefore evaluates
`decidePressureCompaction` (src/compaction-policy.ts): with a narrowed window it
forces the overflow-style balanced reduction once the measured conversation
crosses a threshold derived from the REAL window. The threshold uses the
`dynamicCompactionRatio` curve — the trigger ratio slides from
`thresholdRatio` (0.8) toward `compaction_dynamic_floor` (0.6) as the window
fills, so compaction fires at ~70% of the REAL window, reserving ~30% for the
summarization pass itself. Forcing only happens when `narrowed < declared`,
so a correctly-declared 1M online model is never over-forced.

### The mid-thinking guard

DSH recovers from a provider-confirmed context overflow: `agent/request-error`
with code `CONTEXT_WINDOW_EXCEEDED` compacts the durable surface and returns
`{kind: 'retry'}`. That only helps AFTER the model already tried against a
context it cannot hold. The thinking guard (src/thinking-guard.ts) moves the
intervention INTO the generation: it wraps the `llm/stream` waterfall for
AGENT-LOOP requests only (`isAgentLoopRequest` — the plugin's own summarization
calls are never guarded), estimates the request input, meters output as chunks
flow, and when they cross the dynamic line yields a terminal
`CONTEXT_WINDOW_EXCEEDED` finish. The agent loop then takes the exact same
compact-and-retry path — the model is stopped mid-thinking, the surface is
compacted durably, and the request restarts with room.

The trigger line is DYNAMIC:

```
line = min(window − reserve, floor(window × thinking_guard_ratio))
reserve = systemToolsTokens + summaryOutputEstimate + GUARD_MARGIN
```

The compaction replays the compactable surface (≈ the request input) through a
summarizer call, so `window − reserve` guarantees the CURRENT model's remaining
context is enough to run the plugin's own compression when the guard fires.
A takeover whose input is ALREADY over the line is compacted before any
generation. Input metering counts nested tool-result/tool-call payloads
(capped per block), so file reads are seen.

---

## 12. Key design decisions & trade-offs

- **Reuse `BasicCompactionEngine`** instead of reimplementing compaction. The
  hard parts — balanced tool-call/result ranges, durable `compaction/summary`
  records, token-pressure metering, and the cache-friendly summarization call —
  are battle-tested. The plugin only adds the persistence/tiering/retrieval
  layers.
- **Dependency-free core.** The storage/embedding/search/budget/forgetting logic
  imports nothing from DSH, so it is unit-tested in isolation and could be
  reused by a non-Cordis runtime.
- **Embeddings stored inline in SQLite** for a single-file, zero-dependency
  deployment. This trades some query scalability for operational simplicity;
  the vector index is swappable.
- **Lightweight embedder by default** so the plugin is immediately usable. True
  semantics require the optional transformers.js embedder.
- **Retrieval injection mutates the session** (as a durable `user/message`),
  consistent with DSH's compaction idiom. The trade-off is transcript noise;
  this is why injection is gated by a relevance floor, capped at one per turn,
  and optional.
- **CJK-aware** everywhere: tokenizer, token estimator, and summarization
  framing, so Chinese-language sessions work well.
- **Summarization follows the session model by default (zero config).** The
  `summarizationProvider`/`summarizationModel` keys ship EMPTY (`''`): the
  harness compaction backend resolves `configured ?? latest` and this plugin's
  `resolveSummarizationTarget()` (src/summarization-target.ts) mirrors that
  order for its own history-compression and pyramid paths — explicit config
  wins, otherwise the session's routed model is used, so a local-model session
  summarizes with the local model and a cloud session with the cloud model.
  Pinning a provider here overrides the session route and silently breaks every
  compaction when that endpoint is unavailable or out of balance.
- **The real window beats the declared one, per model.** Compression thresholds,
  history-compression budgets, RAG injection caps, and fallback truncation all
  scale off the routed model's REAL window (probe for local servers, declared
  for online), tracked per model id in `ModelContextTracker`. Probes only ever
  narrow; a wider observation cannot raise a narrowed value. This is what gives
  short-window local models their "refill" (续杯) ability without breaking
  correctly-declared 1M online models.
- **The guard reuses the overflow path instead of inventing one.** The
  mid-thinking guard injects the same `CONTEXT_WINDOW_EXCEEDED` code the
  provider would emit, so compaction-basic's proven durable-compact-and-retry
  machinery (with its retry cap) handles recovery. The guard itself stays
  stateless per request and never guards the plugin's own summarization calls
  (`isAgentLoopRequest`), which prevents re-entrancy.
- **Heuristic metering, bounded.** Token estimates are CJK-aware and deliberately
  conservative; nested tool-result/tool-call payloads are metered (file reads
  are seen) but capped per block (`MAX_TOOL_BLOCK_TOKENS`) so base64-laden
  payloads cannot skew the estimate. The guard's dynamic line reserves
  system/tools + summary output + a fixed margin, and the adapter's own hard
  limit remains the final backstop.
- **Retrieval de-dup reads the surface, it does not remember a decision.**
  Suppressing a memory that is already visible records nothing: the filter runs
  per call, and only memories actually injected join `lastInjectedIds`. Writing
  a "suppressed" id into the exclusion set would make the suppression permanent
  — the memory would stay invisible even after compaction removed its text from
  the surface, which is exactly when it becomes worth re-injecting.
- **Per-turn text goes through `agent/pre-step`, not `llm/stream`.** A loop-built
  request reaches the `llm/stream` waterfall deep-frozen (mutation throws), and
  its system prompt is a leading system-role message inside `options.messages`
  (`GenerateOptions.system` serves one-shot callers). Anything the plugin wants
  the model to read this turn must therefore be spliced into the pre-step
  decision's message list — the same durable idiom as the RAG background.
- **Injected directives are idempotent by surface state.** An injected message
  becomes part of the durable session log, so a per-step injection would add a
  copy every step. The conciseness directive is therefore re-injected only when
  its marker is absent from the current surface — a check that also survives
  restarts, replays, and compaction-driven re-arming.
- **Persistent state never resolves against the cwd.** `storePath` is a
  user-facing path, but the Harness process cwd is an accident of how `dsh` was
  launched; resolving plugin data against it silently relocates the memory store
  (and puts it inside a source checkout that reinstalls delete). Relative paths
  therefore resolve below `<DSH_HOME>/storages`, and the store creates its own
  parent directory instead of trusting the caller.
- **Lossy pruning is made reversible instead of avoided.** Rather than fight the
  built-in `tool-result-pruner` (which destroys the middle of an oversized result
  with no read-back path, and only inside a compaction), the plugin archives the
  exact payload first and leaves a ref-bearing stub behind. The transcript shrinks
  the same way, but `memory_expand` can hand the text back; the cost is one row per
  oversized result plus two stub-shaped surface events per rewritten node.
- **Rewrites stop at the last sent message.** Replacing a surface node invalidates
  the provider prefix cache, so the archive pass keeps a per-session barrier
  (`lastPassSeq`) and only touches nodes appended after the previous pass — the
  first pass records the barrier and rewrites nothing. The single deliberate
  exception is compaction, which rebuilds the prefix anyway: that is where
  deferred stubs are flushed, ahead of the built-in pruner.
- **Distillation is a stub strategy, not a second summarizer.** `tool_absorb` runs on
  the RAW result the moment it lands, extracts the lines that carry the signal
  (errors, exit codes, counts, diff stats) and lets that digest BE the stub: no extra
  model call, and no loss of the exact text (the archive keeps it and `memory_expand`
  returns it). A payload that yields nothing but a header falls back to the head+tail
  stub, and `replaceTextWithStub` refuses to write a stub no smaller than the original
  — so the strategy can only help, never inflate.
- **Compression is scheduled on a prediction, not only on arrival.** The growth EMA
  answers a question the trigger cannot ("do I still fit after the NEXT tool
  result?") and compresses one step early when the answer is no. The trade is a
  slightly earlier and slightly more frequent compression in exchange for not paying
  one oversized request; the nudge never fires twice in a turn or during a cooldown,
  and it is recorded as its own kind so its cost stays visible.
- **Provider usage is stored per field, never pre-summed.** DSH's counts are
  disjoint: `inputTokens` is the uncached input and the billed input is
  `input + cacheRead + cacheWrite`. Collapsing them into one number would erase the
  cache hit rate — the most useful single signal for judging whether injection and
  prefix-preserving rewrites are actually paying off.
- **Reversible compaction archives instead of re-splicing.** Every fold keeps its
  exact folded messages under a `fl_…` ref before the summary replaces them — the
  engine-layer equivalent of upstream billion-context's `decompress`. Read-back is
  a tool call (`memory_expand`), never a surface rewrite: re-inserting old
  messages would invalidate the prefix cache and unbalance tool-call/result
  ranges, while an archive row is lossless, bounded by retention, and invisible to
  the transcript. The upstream feature set is tracked in docs/billion-context/
  (UPSTREAM.md as the long-term follow-up target, ABSORPTION.md for per-feature
  conflicts and decisions).
