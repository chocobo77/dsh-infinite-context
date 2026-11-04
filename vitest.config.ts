import { resolve } from 'node:path'

// Minimal, import-free vitest config so the suite can run with any vitest
// install (including the DSH checkout's) without needing a local node_modules.
//
// The suite imports the plugin's own TS sources directly, and those sources
// import their HOST packages (`@deepseek-ai/*` — cordis, schemastery, the dsh
// libs) which this repo deliberately does not depend on. Resolve them by
// alias into a DSH checkout: `DSH_CHECKOUT` wins when set (CI provisions a
// checkout there), the Windows dev machine keeps its
// `D:/Program files/deepseek-harness` checkout, every other platform falls
// back to the user-level install (`~/.local/share/deepseek-harness`, the same
// layout the `dsh` launcher uses). Only built libs are aliased; exact-name
// entries only (no subpath imports exist), longest first so
// `dsh-compaction-basic` never prefix-matches the `dsh-compaction` alias.
const harnessRoot = process.env.DSH_CHECKOUT
  ?? (process.platform === 'win32'
    ? 'D:/Program files/deepseek-harness'
    : resolve(process.env.HOME ?? '', '.local/share/deepseek-harness'))

const hostPackages = [
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-compaction',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/cordis',
] as const

/** Monorepo dir of each host package, relative to the DSH checkout root. */
const hostPackageDirs: Record<(typeof hostPackages)[number], string> = {
  '@deepseek-ai/dsh-compaction-basic': 'packages/compaction/compaction-basic',
  '@deepseek-ai/dsh-compaction': 'packages/compaction/compaction',
  '@deepseek-ai/dsh-token-meter': 'packages/llm/token-meter',
  '@deepseek-ai/dsh-session': 'packages/core/session',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/cosmokit': 'vendor/cosmokit',
  '@deepseek-ai/cordis': 'vendor/cordis',
}

export default {
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
  resolve: {
    alias: hostPackages.map((pkg) => ({
      find: pkg,
      replacement: resolve(harnessRoot, hostPackageDirs[pkg]),
    })),
  },
}
