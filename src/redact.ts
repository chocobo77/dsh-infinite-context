/**
 * Credential redaction for artifacts that are RE-INJECTED into model context.
 *
 * WHY: a checkpoint summary, the task-state block, an absorb digest and an
 * ingested memory are re-sent to the model on every later request, forwarded
 * to whatever route the summarizer/retriever runs on, and persisted into the
 * memory store. When a user (or a tool result) carries a credential — the
 * production case was a sudo password the user typed mid-session and the
 * fold checkpoint then quoted verbatim — those artifacts amplify its
 * exposure across every subsequent turn and route. Deliberate scope LINE:
 * the tr_/fl_ ARCHIVES are exempt — their contract is exact restoration
 * (memory_expand), they live only in the local SQLite store, and masking
 * them would break reversibility. Redaction happens on the way INTO model
 * context, never on the way into the archive.
 *
 * The patterns are deliberately CONSERVATIVE (credential-shaped only): a
 * masked false positive costs the text's fidelity; an unmasked true positive
 * costs the credential. Values keep nothing — not a prefix, not a length —
 * because a summarizer quoting `[REDACTED]` uniformly is also the clearest
 * signal to the model that the value must not be guessed at.
 *
 * @module dsh-infinite-context/redact
 */

/** Marker substituted for every redacted value. */
export const REDACTED = '[REDACTED]'

/**
 * Key-value assignments: password=…, api_key: …, "token": "…", 密码： …
 * The optional `[A-Za-z0-9]+[-_]` prefix group is what makes QUALIFIED names
 * match: a bare `\b(…)` never fires inside `OPENAI_API_KEY=` or
 * `CLIENT_SECRET=` (a `_` is a word character, so there is no word boundary
 * before the core noun) — exactly the shapes a summarizer quotes verbatim.
 * The prefix keeps the whole qualified key in group 1 so the mask preserves
 * what the value WAS without leaking it.
 */
const KEY_VALUE =
  /(?<![A-Za-z0-9_])((?:[A-Za-z0-9]+[-_])*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|private[_-]?key)\b["']?)(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)}\[\]]{4,})/gi
const CJK_KEY_VALUE =
  /((?:密码|口令|密钥|令牌|访问令牌|私钥)(?:\s*[:：是为=]\s*|\s+))([^\s,，。;；)}\[\]】]{4,})/g

/** `printf '%s\n' '960131' | sudo -S …` — the piped sudo password. */
const SUDO_PIPED = /((?:printf\s+'?%s\\n'?\s+|echo\s+)['"])([^'"]{3,})(['"]\s*\|\s*sudo\s+-S)/g
/** `sudo -S` fed a password on the following line is NOT matched (too broad). */

/** Well-known token shapes. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b[spr]k_live_[0-9A-Za-z]{20,}\b/g, // Stripe live secret / restricted / publishable
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/~-]+/g, // Slack incoming webhook (full URL is the secret)
]

/**
 * URL / DSN userinfo: `scheme://user:password@host` — the shape connection
 * strings carry in logs and error output (postgres://, mysql://, redis:// …).
 * The `@` lookahead is what keeps `http://host:8080/` untouched; the value may
 * itself contain `@` (`p@ssw0rd`), so the greedy value runs to the LAST `@`
 * that still precedes the host. The value excludes `/ ? #`: without that,
 * `http://host:8080/path?email=a@b.com` would treat the port as a password.
 * (A literal `/` inside a DSN password is the accepted miss; `@` still works.)
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+):([^\s"'/?#]+(?=@[^\s@/]*(?:[/:]|\s|['")\],;]|$)))/gi

/** PEM private-key blocks, masked whole. */
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

/**
 * Mask credential-shaped values in `text`. Idempotent: already-redacted
 * text passes through unchanged (the marker matches none of the patterns).
 */
export function redactCredentials(text: string): string {
  let out = text.replace(PEM_BLOCK, `-----PRIVATE KEY ${REDACTED}-----`)
  out = out.replace(SUDO_PIPED, (_m, head: string, value: string, tail: string) => `${head}${REDACTED}${tail}`)
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
  out = out.replace(CJK_KEY_VALUE, (_m, key: string) => `${key}${REDACTED}`)
  // The scheme+user half is kept (which connection it was stays legible); only
  // the password between `:` and the last `@` goes.
  out = out.replace(URL_USERINFO, (_m, head: string) => `${head}:${REDACTED}`)
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
  return out
}
