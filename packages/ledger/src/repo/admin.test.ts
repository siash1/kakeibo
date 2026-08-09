import { resetEnvCache } from '@kakeibo/core/env'
import { afterEach, describe, expect, it } from 'vitest'
import { assertAdmin } from './admin'

function allowlist(value: string): void {
  process.env.ADMIN_EMAILS = value
  resetEnvCache()
}

afterEach(() => {
  delete process.env.ADMIN_EMAILS
  resetEnvCache()
})

describe('assertAdmin', () => {
  it('admits an email on the allowlist', () => {
    allowlist('owner@example.com')
    expect(assertAdmin('owner@example.com')?.email).toBe('owner@example.com')
  })

  it('ignores case and surrounding whitespace on both sides', () => {
    allowlist('  Owner@Example.com , other@example.com ')
    expect(assertAdmin('owner@example.com')).toBeDefined()
    expect(assertAdmin(' OWNER@EXAMPLE.COM ')).toBeDefined()
  })

  it('refuses everyone when the allowlist is empty', () => {
    // The default. A missing environment variable must not be an open door.
    allowlist('')
    expect(assertAdmin('owner@example.com')).toBeUndefined()
  })

  it('refuses an absent email', () => {
    allowlist('owner@example.com')
    expect(assertAdmin(undefined)).toBeUndefined()
    expect(assertAdmin(null)).toBeUndefined()
    expect(assertAdmin('')).toBeUndefined()
  })

  it('refuses an email that merely contains an allowed one', () => {
    allowlist('owner@example.com')
    expect(assertAdmin('owner@example.com.attacker.test')).toBeUndefined()
    expect(assertAdmin('notowner@example.com')).toBeUndefined()
  })
})
