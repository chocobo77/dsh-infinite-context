// Minimal, import-free vitest config so the suite can run with any vitest
// install (including the DSH checkout's) without needing a local node_modules.
export default {
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
}
