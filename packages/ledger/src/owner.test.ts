import { describe, expect, it } from 'vitest'
import { asOwnerId, DEV_OWNER_ID } from './owner'

describe('OwnerId', () => {
  it('accepts a uuid', () => {
    expect(asOwnerId('3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8')).toBe(
      '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8',
    )
  })

  it('rejects anything that is not a uuid, because it reaches SQL', () => {
    expect(() => asOwnerId('not-a-uuid')).toThrow(/uuid/i)
    expect(() => asOwnerId('')).toThrow(/uuid/i)
  })

  it('exposes a stable development owner', () => {
    expect(DEV_OWNER_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(DEV_OWNER_ID).toBe(asOwnerId(DEV_OWNER_ID))
  })
})
