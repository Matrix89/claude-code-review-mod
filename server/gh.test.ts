import { describe, expect, test } from 'bun:test'
import { parsePrRef } from './gh'

describe('parsePrRef', () => {
  test('owner/repo#n', async () => {
    expect(await parsePrRef('acme/web#42', '/')).toEqual({ repo: 'acme/web', number: 42 })
  })

  test('github.com pull URLs', async () => {
    const want = { repo: 'acme/web.js', number: 7 }
    for (const u of [
      'https://github.com/acme/web.js/pull/7',
      'http://www.github.com/acme/web.js/pull/7/',
      'github.com/acme/web.js/pull/7/files',
      'https://github.com/acme/web.js/pull/7?diff=split',
      '  https://github.com/acme/web.js/pull/7/files#diff-abc  ',
    ]) {
      expect(await parsePrRef(u, '/')).toEqual(want)
    }
  })

  test('rejects unrecognized input', async () => {
    await expect(parsePrRef('not a pr', '/')).rejects.toThrow(/Unrecognized PR reference/)
    await expect(parsePrRef('acme/web', '/')).rejects.toThrow(/Unrecognized PR reference/)
  })
})
