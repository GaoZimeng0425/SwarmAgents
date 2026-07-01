import { describe, expect, it } from 'vitest'
import { extractCredentials } from './auth'

describe('extractCredentials', () => {
  it('pulls the three required cookies', () => {
    expect(
      extractCredentials([
        { name: 'SESSDATA', value: 'sess' },
        { name: 'bili_jct', value: 'jct' },
        { name: 'DedeUserID', value: '42' },
        { name: 'other', value: 'x' },
      ])
    ).toEqual({ sessdata: 'sess', biliJct: 'jct', dedeUserId: '42' })
  })

  it('returns null when SESSDATA is missing', () => {
    expect(
      extractCredentials([
        { name: 'bili_jct', value: 'jct' },
        { name: 'DedeUserID', value: '42' },
      ])
    ).toBeNull()
  })

  it('returns null for an empty cookie list', () => {
    expect(extractCredentials([])).toBeNull()
  })
})
