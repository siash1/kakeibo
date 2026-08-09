import { describe, expect, it } from 'vitest'
import { assertResettable } from './reset'

const LOCAL = 'postgres://kakeibo:kakeibo@localhost:5433/kakeibo'
const NEON = 'postgres://user:pw@ep-cool-name-123456.ap-south-1.aws.neon.tech/kakeibo'

describe('assertResettable', () => {
  it('allows localhost', () => {
    expect(() => assertResettable(LOCAL, false)).not.toThrow()
    expect(() => assertResettable('postgres://x@127.0.0.1:5433/db', false)).not.toThrow()
    expect(() => assertResettable('postgres://x@[::1]:5433/db', false)).not.toThrow()
  })

  it('refuses anything else', () => {
    expect(() => assertResettable(NEON, false)).toThrow(/refusing/i)
    // The message has to name the host, or the person who hits this at 2am
    // cannot tell which database they were pointed at.
    expect(() => assertResettable(NEON, false)).toThrow(/neon\.tech/)
  })

  it('allows anything when the escape hatch is set explicitly', () => {
    expect(() => assertResettable(NEON, true)).not.toThrow()
  })

  it('refuses a url it cannot parse rather than assuming it is local', () => {
    // Failing closed matters more here than a helpful error: the cost of a
    // false refusal is retyping a command.
    expect(() => assertResettable('not a url', false)).toThrow(/refusing/i)
  })
})
