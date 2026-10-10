import { describe, expect, mock, test } from 'claude-code/testing'

import {
  clockText,
  compare,
  costs,
  blankSession,
  digest,
  drifted,
  isCorrection,
  keepCost,
  learnRate,
  pctText,
  shareLine,
  parseVerdict,
  payback,
  reason,
  retryLoops,
  signalVerdict,
  summaryLines,
} from '../hooks/register'

const BASE = {
  ctx: 50_000,
  window: 1_000_000,
  base: 40_000,
  leftMs: 30 * 60_000,
  ttlMs: 60 * 60_000,
  keepLeftMs: 0,
  usdPerMTok: 5,
}

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
}

describe('cost model', () => {
  test('a warm ping costs a tenth of a cold rewrite of the same context, and far less', async () => {
    const c = costs(500_000, 40_000, 5)
    expect(Math.round(c.cold * 100)).toBe(500)
    expect(c.ping).toBeLessThan(c.cold / 19)
  })

  test('a small, warm session suggests nothing', async () => {
    expect(reason(BASE)).toBe('')
  })

  test('a big session on track gets no size-only suggestion below the backstop', async () => {
    expect(reason({ ...BASE, ctx: 337_000 })).toBe('')
    expect(payback({ ...BASE, ctx: 337_000 })).toContain('pays back')
  })

  test('past 60% of the window the backstop suggests a handoff', async () => {
    expect(reason({ ...BASE, ctx: 650_000 })).toContain('compaction near')
  })

  test('a cold big session suggests a handoff when a fresh one is cheaper', async () => {
    expect(reason({ ...BASE, ctx: 150_000, leftMs: 0 })).toContain('cache cold')
  })

  test('ten hours of pings over a big context cost more than a fresh session', async () => {
    const why = reason({ ...BASE, ctx: 190_000, keepLeftMs: 10 * 3_600_000 })
    expect(why).toContain('keeping warm')
  })

  test('the clock reads minutes and seconds, then hours', async () => {
    expect(clockText(65_000)).toBe('1:05')
    expect(clockText(3_600_000)).toBe('60:00')
    expect(clockText(2 * 3_600_000 + 5 * 60_000)).toBe('2h05m')
  })
})

describe('signals judge', () => {
  test('a big session with no retries, corrections or drift is on track', async () => {
    expect(signalVerdict({ retryLoops: 0, corrections: 0, drift: false }, 0.34)).toBe('')
  })

  test('a small session stuck in two retry loops is called off track', async () => {
    const calls = [
      { key: 'Bash:pnpm test', err: true },
      { key: 'Read:/a', err: false },
      { key: 'Bash:pnpm test', err: true },
      { key: 'Edit:/b.ts', err: true },
      { key: 'Edit:/b.ts', err: true },
    ]
    expect(retryLoops(calls)).toBe(2)
    expect(signalVerdict({ retryLoops: 2, corrections: 0, drift: false }, 0.02)).toBe('2 retry loops')
  })

  test('the person correcting the assistant counts, ordinary prompts do not', async () => {
    expect(isCorrection('no, I said the web app')).toBe(true)
    expect(isCorrection('it still fails on staging')).toBe(true)
    expect(isCorrection('stage it, then deploy')).toBe(false)
    expect(isCorrection('still broken after your fix')).toBe(true)
    expect(isCorrection('now add the export button')).toBe(false)
    expect(signalVerdict({ retryLoops: 0, corrections: 3, drift: false }, 0)).toBe('3 corrections')
  })

  test('work in folders the session never started in is drift', async () => {
    const early = ['/a', '/a', '/b', '/a', '/b']
    expect(drifted(early, ['/x', '/y', '/x', '/y', '/x'])).toBe(true)
    expect(drifted(early, ['/x', '/a', '/x', '/y', '/x'])).toBe(false)
    expect(drifted(early.slice(0, 3), ['/x', '/y', '/x', '/y', '/x'])).toBe(false)
  })
})

describe('model judge', () => {
  test('reads the verdict out of a reply, and refuses a reply without one', async () => {
    expect(parseVerdict('```json\n{"handoff": true, "why": "loops on same test"}\n```')).toEqual({
      handoff: true,
      why: 'loops on same test',
    })
    expect(parseVerdict('looks fine')).toBeNull()
    expect(parseVerdict('{"handoff": "yes"}')).toBeNull()
  })

  test('the digest keeps the newest turns and marks failed tools', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      text: `turn ${i}`,
      toolUses: i === 39 ? [{ tool: 'Bash', input: { command: 'pnpm test' }, isError: true as const }] : [],
    }))
    const d = digest(rows)
    expect(d).toContain('turn 39')
    expect(d).not.toContain('turn 10')
    expect(d).toContain('[Bash:pnpm test FAILED]')
  })
})

describe('trial', () => {
  const ended = (id: string, f: (s: ReturnType<typeof blankSession>) => void) => {
    const s = blankSession(id, 1)
    s.endedAt = 2
    s.turns = 10
    f(s)
    return s
  }

  test('the judge with more agreed calls and fewer misses is the pick; short or open sessions do not count', async () => {
    const list = [
      ended('a', s => ((s.signals.fired = 1), (s.signals.down = 1), (s.model.fired = 1), (s.model.up = 1))),
      ended('b', s => ((s.model.fired = 1), (s.model.up = 1), (s.signals.missed = 1), (s.modelUsd = 0.02))),
      ended('c', s => (s.turns = 1)),
      blankSession('open', 1),
    ]
    const c = compare(list)
    expect(c.n).toBe(2)
    expect(c.model.score).toBe(2)
    expect(c.signals.score).toBe(-2)
    expect(c.pick).toBe('model')
  })

  test('the band summary names both judges and the pick', async () => {
    const lines = summaryLines([ended('a', s => ((s.model.fired = 1), (s.model.up = 1), (s.modelUsd = 0.03)))])
    expect(lines).toEqual([
      'signals: right 0 · wrong 0 · missed 0 · fired in 0/1 · free',
      'model: right 1 · wrong 0 · missed 0 · fired in 1/1 at ~0k · $0.03',
      'suggest keeping model',
    ])
  })

  test('a tie goes to the free signals judge', async () => {
    expect(compare([ended('a', () => {})]).pick).toBe('signals')
  })
})

describe('band', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`Keep arms keep-warm and Warm pings through a fork (${surface})`, async ($, on) => {
      mock.clock(on, { now: 1_000_000 })
      let forks = 0
      on('model.fork', () => {
        forks += 1
        return {
          value: {
          isAnswered: true as const,
          text: 'ok',
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 120_000,
            cache_creation_input_tokens: 0,
          },
          },
        }
      })
      const ui = await $.ui.mount({
        plugin: 'cache-keeper',
        surface,
        component: 'AbovePrompt',
        props: PROPS,
      })
      expect((await ui.find({ key: 'keep' }))?.text).toContain('Keep 10h')

      await ui.press({ key: 'keep' })
      expect(await ui.find({ key: 'stop' })).toBeDefined()

      await ui.press({ key: 'warm' })
      expect(forks).toBe(1)
      expect(await ui.find({ text: /cache 60:00/ })).toBeDefined()
      expect(await ui.find({ text: /ctx 120k/ })).toBeDefined()
      expect(await ui.find({ text: /hit 120k/ })).toBeDefined()
    })
  }
})

describe('trial end', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`after five sessions every new session shows the comparison and Keep buttons (${surface})`, async ($, on) => {
      mock.clock(on, { now: 1_000_000 })
      const store: Record<string, unknown> = {
        sessions: ['a', 'b', 'c', 'd', 'e'].map(id => ({
          id,
          startedAt: 1,
          endedAt: 2,
          turns: 8,
          peakCtx: 100_000,
          handoffs: 0,
          modelCalls: 2,
          modelUsd: 0.01,
          signals: { firstAt: 0, firstCtx: 0, firstTurn: 0, fired: 0, up: 0, down: 0, missed: 0 },
          model: { firstAt: 0, firstCtx: 0, firstTurn: 0, fired: 0, up: 0, down: 0, missed: 0 },
        })),
      }
      on('store.get', (_$, e) => ({ value: store[e.key] }))
      on('store.set', (_$, e) => {
        store[e.key] = e.value
        return { value: undefined }
      })
      on('session.id', () => ({ value: 'now' }))
      on('session.start', (_$, e) => ({ cwd: e.cwd }))
      on('command.register', () => ({ value: { command: 'cache' } }))
      await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cache-keeper', surface, component: 'AbovePrompt', props: PROPS })
      expect(await ui.find({ text: /handoff trial done/ })).toBeDefined()
      expect(await ui.find({ text: /suggest keeping signals/ })).toBeDefined()
      await ui.press({ key: 'keep-model' })
      expect(store.judge).toBe('model')
      expect(await ui.find({ text: /handoff trial done/ })).toBeUndefined()
    })
  }
})

describe('usage share', () => {
  test('a rate is read only once the window moved a point and $0.50 was spent', () => {
    let l = learnRate(undefined, 10, 1)
    expect(l.pctPerUsd).toBe(0)
    l = learnRate(l, 10.5, 3)
    expect(l.pctPerUsd).toBe(0)
    l = learnRate(l, 12, 3)
    expect(l.pctPerUsd).toBe(1)
  })

  test('the lowest reading is kept, since other sessions only inflate one', () => {
    let l = learnRate(undefined, 0, 0, 2)
    l = learnRate(l, 6, 1)
    expect(l.pctPerUsd).toBe(2)
    l = learnRate(l, 7, 2)
    expect(l.pctPerUsd).toBe(1)
  })

  test('a window that reset re-anchors and keeps the rate', () => {
    const l = learnRate({ anchorPct: 80, anchorUsd: 5, pctPerUsd: 1.5 }, 3, 6)
    expect(l).toEqual({ anchorPct: 3, anchorUsd: 6, pctPerUsd: 1.5 })
  })

  test('one warm counts against 5h, a 10h keep against the week', () => {
    expect(Math.round(keepCost(0.1, 600 * 60_000, 60 * 60_000) * 100)).toBe(110)
    expect(shareLine(0.1, 600 * 60_000, 60 * 60_000, { five_hour: 2, seven_day: 0.5 })).toEqual({
      warm: '0.2% 5h',
      keep: '0.6% wk',
    })
    expect(shareLine(0.1, 600 * 60_000, 60 * 60_000, {})).toEqual({ warm: '', keep: '' })
    expect(pctText(0.01, 1, '5h')).toBe('<0.1% 5h')
  })
})

const MSGS = [{ role: 'user' as const, text: 'build it', toolUses: [] }]

describe('handoff before auto-compaction', () => {
  test('the file is written first, then the compaction runs told where it is', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 10, 20, 15) })
    on('ui.toast', () => ({ value: undefined }))
    on('session.cwd', () => ({ value: '/work' }))
    on('model.fork', () => ({
      value: {
        isAnswered: true as const,
        text: '# Handoff\nGoal: x\n',
        usage: { input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
    }))
    const order: string[] = []
    let file = { path: '', text: '' }
    on('fs.write', (_$, e) => {
      order.push('write')
      file = e as unknown as typeof file
      return { value: undefined }
    })
    let seen: { instructions?: string } = {}
    on('session.compact', (_$, x) => {
      order.push('compact')
      seen = x
      return { skip: 'test' }
    })
    await $.session.compact({ trigger: 'auto', messages: MSGS })
    expect(order).toEqual(['write', 'compact'])
    expect(file.path).toBe('/work/HANDOFF-2026-10-10-20-15.md')
    expect(file.text).toBe('# Handoff\nGoal: x\n')
    expect(seen.instructions).toContain('/work/HANDOFF-2026-10-10-20-15.md')
  })

  test('a fork that fails never blocks the compaction', async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('ui.toast', () => ({ value: undefined }))
    on('session.cwd', () => ({ value: '/work' }))
    on('model.fork', () => ({ value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }))
    let writes = 0
    on('fs.write', () => {
      writes += 1
      return { value: undefined }
    })
    let ran = false
    let seen: { instructions?: string } = { instructions: 'x' }
    on('session.compact', (_$, x) => {
      ran = true
      seen = x
      return { skip: 'test' }
    })
    await $.session.compact({ trigger: 'auto', messages: MSGS })
    expect(ran).toBe(true)
    expect(writes).toBe(0)
    expect(seen.instructions).toBeUndefined()
  })

  test('the person\'s own /compact is left alone', async ($, on) => {
    let forks = 0
    on('model.fork', () => {
      forks += 1
      return { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
    })
    on('session.compact', () => ({ skip: 'test' }))
    await $.session.compact({ trigger: 'manual', messages: MSGS })
    expect(forks).toBe(0)
  })
})
