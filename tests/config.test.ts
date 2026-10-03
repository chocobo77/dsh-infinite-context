import { isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STORE_PATH,
  IN_MEMORY_STORE,
  resolveDshHome,
  resolveMemoryContextConfig,
  resolveStorePath,
} from '../src/config.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveDshHome', () => {
  it('prefers a non-blank $DSH_HOME', () => {
    expect(resolveDshHome({ DSH_HOME: join('C:', 'custom-home') }, join('C:', 'users', 'me')))
      .toBe(join('C:', 'custom-home'))
  })

  it('treats blank and whitespace-only $DSH_HOME as unset', () => {
    const home = join('C:', 'users', 'me')
    expect(resolveDshHome({ DSH_HOME: '' }, home)).toBe(join(home, '.dsh'))
    expect(resolveDshHome({ DSH_HOME: '   ' }, home)).toBe(join(home, '.dsh'))
    expect(resolveDshHome({}, home)).toBe(join(home, '.dsh'))
  })

  it('absolute-izes a relative $DSH_HOME like DSH itself does', () => {
    // A relative home would make resolveStorePath return a cwd-relative store
    // path, which moves with the launch directory and looks like data loss.
    expect(resolveDshHome({ DSH_HOME: 'relhome' }, join('C:', 'users', 'me'))).toBe(resolve('relhome'))
    expect(isAbsolute(resolveDshHome({ DSH_HOME: 'relhome' }, join('C:', 'users', 'me')))).toBe(true)
  })

  it('expands a leading ~', () => {
    const home = join('C:', 'users', 'me')
    expect(resolveDshHome({ DSH_HOME: '~' }, home)).toBe(home)
    expect(resolveDshHome({ DSH_HOME: '~/.dsh-alt' }, home)).toBe(join(home, '.dsh-alt'))
  })
})

describe('resolveStorePath', () => {
  const homeDir = join('C:', 'users', 'me')
  const env = { DSH_HOME: join('C:', 'harness-home') }

  it('passes :memory: through untouched', () => {
    expect(resolveStorePath(IN_MEMORY_STORE, env, homeDir)).toBe(IN_MEMORY_STORE)
  })

  it('passes an absolute path through untouched', () => {
    const absolute = resolve(homeDir, 'data', 'memories.db')
    expect(resolveStorePath(absolute, env, homeDir)).toBe(absolute)
  })

  it('resolves a relative path below <DSH_HOME>/storages, not the cwd', () => {
    expect(resolveStorePath(DEFAULT_STORE_PATH, env, homeDir))
      .toBe(join(env.DSH_HOME, 'storages', DEFAULT_STORE_PATH))
    expect(resolveStorePath(join('nested', 'memories.db'), env, homeDir))
      .toBe(join(env.DSH_HOME, 'storages', 'nested', 'memories.db'))
  })

  it('expands ~ against the user home and trims surrounding whitespace', () => {
    expect(resolveStorePath('  ~/memories.db  ', env, homeDir)).toBe(join(homeDir, 'memories.db'))
  })

  it('falls back to ~/.dsh when $DSH_HOME is unset or blank', () => {
    const expected = join(homeDir, '.dsh', 'storages', 'memories.db')
    expect(resolveStorePath('memories.db', {}, homeDir)).toBe(expected)
    expect(resolveStorePath('memories.db', { DSH_HOME: '  ' }, homeDir)).toBe(expected)
  })
})

describe('resolveMemoryContextConfig store path', () => {
  it('resolves the default store below the ambient $DSH_HOME', () => {
    const home = resolve('test-dsh-home')
    vi.stubEnv('DSH_HOME', home)
    const resolved = resolveMemoryContextConfig({})
    expect(resolved.storePath).toBe(join(home, 'storages', DEFAULT_STORE_PATH))
    expect(isAbsolute(resolved.storePath)).toBe(true)
  })

  it('keeps an explicit :memory: store in-process', () => {
    vi.stubEnv('DSH_HOME', resolve('test-dsh-home'))
    expect(resolveMemoryContextConfig({ storePath: IN_MEMORY_STORE }).storePath).toBe(IN_MEMORY_STORE)
  })
})
