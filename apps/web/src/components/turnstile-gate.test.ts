import { describe, expect, it } from 'vitest'
import { mayAsk } from './turnstile-gate'

/**
 * The composer's send gate (design spec §5, layer 4).
 *
 * Both cases are written as sequences of turns rather than as single calls,
 * because the defect this covers was never visible in one call. Mounting asked
 * whether a gate was configured; finishing a turn asked whether a token was
 * held. Each answer was right on its own, and together they meant the composer
 * disabled itself forever after the first question on any deployment with the
 * keys empty — which is this one, by the owner's decision.
 *
 * The configured case is here to keep the fix honest: a token is single-use, so
 * "no token, may ask" must stay wrong whenever a widget exists to mint another.
 */

const UNCONFIGURED = ''
const CONFIGURED = '1x00000000000000000000AA'

describe('mayAsk', () => {
  it('stays open across consecutive turns when no gate is configured', () => {
    // Mount: no widget will ever render, so nothing is coming.
    expect(mayAsk(UNCONFIGURED, undefined)).toBe(true)

    // Every turn ends by dropping the token it spent and asking for another.
    // With no gate there is no callback to answer, and this is the assertion
    // that was missing: the second question has to remain askable.
    expect(mayAsk(UNCONFIGURED, undefined)).toBe(true)
  })

  it('waits for a fresh token between turns when a gate is configured', () => {
    // Nothing may be sent before Cloudflare has issued anything.
    expect(mayAsk(CONFIGURED, undefined)).toBe(false)

    expect(mayAsk(CONFIGURED, 'token-for-turn-1')).toBe(true)

    // Turn 1 spends it. Replaying a token is rejected as timeout-or-duplicate,
    // so the composer must close again rather than send the same one twice.
    expect(mayAsk(CONFIGURED, undefined)).toBe(false)

    expect(mayAsk(CONFIGURED, 'token-for-turn-2')).toBe(true)
  })
})
