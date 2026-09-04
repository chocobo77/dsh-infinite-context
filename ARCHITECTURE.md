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
ids), and the folded `mid` rows are removed. `long` memories beyond `maxLong`
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
3. If any are relevant, appends a clearly-framed background message to the
   request `messages` and returns `{ kind: 'enter', messages: [...decision.messages, memory] }`.

Because the pre-step waterfall's final `messages` are appended to the session
as `user/message` events (the same durable idiom `compaction-basic` uses for its
checkpoint), the injected memories are part of the replayed context and are
themselves eventually compacted away. Injection happens at most once per turn
(`lastInjectedTurn`), and only when the retrieved memories clear the
`retrieval.minScore` floor, so it does not spam every tool-call step.

`retrieval.enabled` can be turned off; the manual `memory_search` tool then
provides on-demand retrieval instead.

---

## 8. Component / module map

| File | Depends on DSH? | Responsibility |
|---|---|---|
| `src/types.ts` | no | Shared types (`Tier`, `MemoryDoc`, config shapes, status). |
| `src/embedder.ts` | no | `Embedder` interface, `LightweightEmbedder`, cosine/normalize helpers. |
| `src/transformers-embedder.ts` | no | Optional `TransformersEmbedder` (all-MiniLM-L6-v2). |
| `src/vector-index.ts` | no | `VectorIndex` (top-K cosine search). |
| `src/memory-store.ts` | no | SQLite (`node:sqlite`) persistence of `MemoryDoc`. |
| `src/token-budget.ts` | no | `TokenBudget`, CJK-aware `estimateTokens` + content-block metering (`estimateContentTokens`: nested tool-result/tool-call payloads, capped). |
| `src/forgetting.ts` | no | `ForgettingPolicy`, scoring. |
| `src/memory-engine.ts` | no | Orchestration: store/embed/retrieve/consolidate/forget/status. |
| `src/model-context.ts` | no | `ModelContextTracker`: probe-once-per-model + retry cooldown, per-model window registry, probe-only-narrows. |
| `src/model-probe.ts` | no | Live context probes (llama `/props`, ollama `/api/show`, openai `/models` incl. LM Studio native) + `isLocalHostname`/`isLocalBaseURL` locality gate. |
| `src/compaction-policy.ts` | no | Pure trigger decisions: `decidePressureCompaction` (skip/force/delegate), `dynamicCompactionRatio` curve, `shouldCompressHistory` (surge/pressure/rate-limit). |
| `src/thinking-guard.ts` | yes | Mid-thinking guard: `llm/stream` wrapper, dynamic trigger line, overflow injection. |
| `src/summarization-target.ts` | yes | Summarizer routing: `configured ?? session model`. |
| `src/config.ts` | yes | Schemastery schemas + default resolution. |
| `src/memory-context.ts` | yes | `MemoryContext` service (`ctx.memoryContext`): probe wiring + locality gate + per-model adoption. |
| `src/memory-compaction.ts` | yes | `MemoryCompactionEngine` (extends `BasicCompactionEngine`): pre-step governance + narrowed-window force + thinking-guard wiring. |
| `src/OutputSanitizer.ts` | no | Tool-result sanitization (web_search/code_exec/generic JSON). |
| `src/VectorRetriever.ts` | yes | RAG ingestion (dedup ×3, size caps, timeout) + budget-aware retrieval. |
| `src/tools.ts` | yes | Manual model-callable tools. |
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
```

Uses Node's built-in `node:sqlite` (`DatabaseSync`), the same medium DSH's own
`storage-sqlite` backend uses — no native `sqlite3` dependency.

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
