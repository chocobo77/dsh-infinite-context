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

/** Key-value assignments: password=…, api_key: …, "token": "…", 密码： … */
const KEY_VALUE =
  /\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|private[_-]?key)\b(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)}\[\]]{4,})/gi
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
]

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
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
  return out
}
