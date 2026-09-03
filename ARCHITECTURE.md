# dsh-infinite-context — Architecture

A DeepSeek Harness (DSH) plugin that delivers "infinite context" through
**multi-tier memory management**: it automatically summarizes long conversations
into persistent, searchable memories, retrieves the most relevant ones for each
new question, and enforces a token budget so the context never overflows a
94k-token local window.

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
| `src/token-budget.ts` | no | `TokenBudget`, CJK-aware `estimateTokens`. |
| `src/forgetting.ts` | no | `ForgettingPolicy`, scoring. |
| `src/memory-engine.ts` | no | Orchestration: store/embed/retrieve/consolidate/forget/status. |
| `src/config.ts` | yes | Schemastery schemas + default resolution. |
| `src/memory-context.ts` | yes | `MemoryContext` service (`ctx.memoryContext`). |
| `src/memory-compaction.ts` | yes | `MemoryCompactionEngine` (extends `BasicCompactionEngine`). |
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
   ├─ [BasicCompactionEngine hook]
   │    measure tokens (ctx.tokenMeter)
   │    over threshold/overflow? ──► compactRegion ──► summarize()
   │                                              │
   │        [MemoryCompactionEngine.summarize]    │
   │          • super.summarize() (LLM checkpoint)
   │          • storeMemory(text, 'mid')          │
   │          • rebalance() = forget() + consolidate() (pyramid)
   │                                              ▼
   │                                    surface replaced with checkpoint
   │
   └─ [MemoryCompactionEngine retrieval hook] (registered after)
        retrieve(topK, minScore) for the latest user text
        relevant? ──► append background memory message to request
   │
   ▼
model call sees: ...context..., [retrieved memories], current question
```

---

## 11. Key design decisions & trade-offs

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
