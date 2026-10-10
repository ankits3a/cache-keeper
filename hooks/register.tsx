import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Judge, Ping, Rates, TrialSession, Verdict } from '../types'

// Prompt-cache keeper: a band above the prompt with the time the session's
// prompt cache has left, a Warm button (one tool-less fork over the session's
// own transcript, served from the cache, which resets its TTL), Keep warm for
// N hours while nobody is at the keyboard, and a Handoff button the band
// suggests when the session goes off track or carrying it costs more than a
// fresh session started from a handoff file.
//
// Whether a session is off track is judged two ways, side by side, for the
// first TRIAL_SESSIONS sessions: free signals (retry loops, the person's
// corrections, work drifting away from where it started) and a small model
// reading the last turns. The person rates each suggestion; after the trial
// `/cache trial` compares the two and `/cache judge` keeps one.

const lastTouch = atom({ plugin: 'cache-keeper', key: 'lastTouch' } as const, 0)
const keepUntil = atom({ plugin: 'cache-keeper', key: 'keepUntil' } as const, 0)
const now = atom({ plugin: 'cache-keeper', key: 'now' } as const, 0)
const ctxTokens = atom({ plugin: 'cache-keeper', key: 'ctxTokens' } as const, 0)
const ctxWindow = atom({ plugin: 'cache-keeper', key: 'window' } as const, 0)
const baseTokens = atom({ plugin: 'cache-keeper', key: 'baseTokens' } as const, 0)
const lastPing = atom({ plugin: 'cache-keeper', key: 'lastPing' } as const, null as Ping | null)
const isPinging = atom({ plugin: 'cache-keeper', key: 'isPinging' } as const, false)
const suggested = atom({ plugin: 'cache-keeper', key: 'suggested' } as const, '')
const isHidden = atom({ plugin: 'cache-keeper', key: 'isHidden' } as const, false)
const sigWhy = atom({ plugin: 'cache-keeper', key: 'sigWhy' } as const, '')
const modelWhy = atom({ plugin: 'cache-keeper', key: 'modelWhy' } as const, '')
const voted = atom({ plugin: 'cache-keeper', key: 'voted' } as const, '')
const judge = atom({ plugin: 'cache-keeper', key: 'judge' } as const, 'trial' as Judge)
const trial = atom({ plugin: 'cache-keeper', key: 'trial' } as const, null as TrialSession | null)
const isTrialDone = atom({ plugin: 'cache-keeper', key: 'isTrialDone' } as const, false)
const trialSummary = atom({ plugin: 'cache-keeper', key: 'trialSummary' } as const, [] as string[])
const rates = atom({ plugin: 'cache-keeper', key: 'rates' } as const, {} as Rates)

type Options = {
  ttlMinutes?: number
  keepHours?: number
  inputUsdPerMTok?: number
  handoffDir?: string
}

const MIN = 60_000
const DEFAULT_BASE = 40_000 // system prompt + tools + memory of a fresh session
const HANDOFF_TOKENS = 4_000 // a handoff file, written once and read once
const BACKSTOP = 0.6 // share of the window past which compaction is near, whatever the judges say
const PING_PROMPT =
  'Cache keep-alive ping from the cache-keeper plugin. Do nothing. Reply with the single word: ok'

const TRIAL_SESSIONS = 5
const MIN_TURNS = 3 // a session shorter than this tells the trial nothing
const SIGNAL_LINE = 4
const JUDGE_EVERY = 6 // main turns between model checks
const JUDGE_MIN_CTX = 20_000
const JUDGE_MODEL = 'haiku'
const JUDGE_USD_PER_MTOK = 1
const JUDGE_SYSTEM = [
  'You watch a coding-assistant session on behalf of its user and decide whether it should stop and hand off',
  'to a fresh session through a handoff file.',
  'Hand off when: the assistant repeats the same failing attempt, the user keeps correcting it,',
  'the work has moved to a task unrelated to the start, or replies show it lost track of facts given earlier.',
  'Do NOT hand off only because the context is large while the work is on track.',
  'Reply with JSON only: {"handoff": true or false, "why": "at most 10 words"}',
].join(' ')

export type Costs = {
  ping: number
  cold: number
  fresh: number
  turnHere: number
  turnFresh: number
}

/** USD estimates from the token counts, at the API's cache multipliers. */
export function costs(ctx: number, base: number, usdPerMTok: number): Costs {
  const p = usdPerMTok / 1e6
  const b = base > 0 && base < ctx ? base : Math.min(DEFAULT_BASE, ctx)
  const handoffWrite = ctx * 0.1 * p + HANDOFF_TOKENS * 5 * p
  return {
    ping: ctx * 0.1 * p + 10 * 5 * p,
    cold: ctx * 2 * p,
    fresh: (b + HANDOFF_TOKENS) * 2 * p + handoffWrite,
    turnHere: ctx * 0.1 * p,
    turnFresh: (b + HANDOFF_TOKENS) * 0.1 * p,
  }
}

export type Facts = {
  ctx: number
  window: number
  base: number
  leftMs: number
  ttlMs: number
  keepLeftMs: number
  usdPerMTok: number
}

const kTok = (n: number) => `${Math.round(n / 1000)}k`

/**
 * Why a handoff would serve better than this session on size or money alone,
 * or '' when it would not. Whether the session is off track is the judges'.
 */
export function reason(f: Facts): string {
  if (f.ctx <= 0) return ''
  const c = costs(f.ctx, f.base, f.usdPerMTok)
  if (f.window > 0 && f.ctx / f.window >= BACKSTOP) {
    return `context ${Math.round((f.ctx / f.window) * 100)}% full: compaction near`
  }
  if (f.leftMs <= 0 && c.cold > c.fresh) {
    return `cache cold: resuming rewrites ${kTok(f.ctx)} ≈ ${usd(c.cold)}, fresh ≈ ${usd(c.fresh)}`
  }
  if (f.keepLeftMs > 0) {
    const keep = keepCost(c.ping, f.keepLeftMs, f.ttlMs)
    if (keep > c.fresh) {
      return `keeping warm ≈ ${usd(keep)} > fresh session ≈ ${usd(c.fresh)}`
    }
  }
  return ''
}

/** What each turn costs here against a fresh session: shown, never a suggestion on its own. */
export function payback(f: Facts): string {
  const c = costs(f.ctx, f.base, f.usdPerMTok)
  const saved = c.turnHere - c.turnFresh
  if (saved <= 0) return 'a fresh session saves nothing per turn'
  return `each turn ${usd(c.turnHere)} here vs ${usd(c.turnFresh)} fresh: a fresh start pays back in ${Math.ceil(c.fresh / saved)} turns`
}

// ---- signals judge ----

export type Call = { key: string; err: boolean }
export type SignalFacts = { retryLoops: number; corrections: number; drift: boolean }

const CORRECTION =
  /^\s*(no|nope|wrong|not that|undo|revert)\b|\b(i said|i told you|i asked|that'?s (not|wrong)|not what i|still (broken|failing|fails|wrong|not)|(didn'?t|doesn'?t|does not|did not|isn'?t) work|you (missed|forgot|ignored))\b/i

export function isCorrection(text: string): boolean {
  return CORRECTION.test(text.slice(0, 400))
}

/** Calls that failed at least twice on the same tool and target among the recent ones. */
export function retryLoops(calls: readonly Call[]): number {
  const errs = new Map<string, number>()
  for (const c of calls.slice(-12)) if (c.err) errs.set(c.key, (errs.get(c.key) ?? 0) + 1)
  return [...errs.values()].filter(n => n >= 2).length
}

/** The recent work touches none of the folders the session started in. */
export function drifted(early: readonly string[], recent: readonly string[]): boolean {
  if (early.length < 5 || recent.length < 5) return false
  const start = new Set(early)
  return !recent.some(d => start.has(d))
}

export function signalVerdict(s: SignalFacts, fill: number): string {
  const score = (2 * s.retryLoops + 1.5 * s.corrections + (s.drift ? 2 : 0)) * (1 + Math.min(1, Math.max(0, fill)))
  if (score < SIGNAL_LINE) return ''
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (s.retryLoops) parts.push(plural(s.retryLoops, 'retry loop'))
  if (s.corrections) parts.push(plural(s.corrections, 'correction'))
  if (s.drift) parts.push('work drifted from the start')
  return parts.join(' · ')
}

export function callKey(tool: string, input: Record<string, unknown>): string {
  const target = input.command ?? input.file_path ?? input.notebook_path ?? input.path ?? input.pattern ?? input.url
  return `${tool}:${String(target ?? JSON.stringify(input)).slice(0, 160)}`
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : path
}

// ---- model judge ----

export function parseVerdict(text: string): { handoff: boolean; why: string } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const v = JSON.parse(m[0]) as { handoff?: unknown; why?: unknown }
    if (typeof v.handoff !== 'boolean') return null
    return { handoff: v.handoff, why: typeof v.why === 'string' ? v.why.slice(0, 80) : '' }
  } catch {
    return null
  }
}

type Row = {
  role: string
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; isError?: true }[]
  toolResults?: readonly { isError?: boolean }[]
}

/** The last turns, shortened to what a judge needs: who said what, which tools ran, which failed. */
export function digest(rows: readonly Row[], budget = 9000): string {
  const lines: string[] = []
  for (const r of rows.slice(-16)) {
    if (r.role === 'user' && !r.text.trim()) continue
    const tools = r.toolUses.map(u => `[${callKey(u.tool, u.input).slice(0, 80)}${u.isError ? ' FAILED' : ''}]`)
    lines.push(`${r.role.toUpperCase()}: ${r.text.replace(/\s+/g, ' ').slice(0, 350)} ${tools.join(' ')}`.trim())
  }
  let out = lines.join('\n')
  while (out.length > budget && lines.length > 1) {
    lines.shift()
    out = lines.join('\n')
  }
  return out
}

// ---- trial ----

export function blankVerdict(): Verdict {
  return { firstAt: 0, firstCtx: 0, firstTurn: 0, fired: 0, up: 0, down: 0, missed: 0 }
}

export function blankSession(id: string, at: number): TrialSession {
  return {
    id,
    startedAt: at,
    endedAt: 0,
    turns: 0,
    peakCtx: 0,
    handoffs: 0,
    modelCalls: 0,
    modelUsd: 0,
    signals: blankVerdict(),
    model: blankVerdict(),
  }
}

/** Sessions that count toward the trial: ended, and long enough to say something. */
export function counted(list: readonly TrialSession[]): TrialSession[] {
  return list.filter(s => s.endedAt > 0 && s.turns >= MIN_TURNS)
}

export type JudgeRow = {
  sessionsFired: number
  avgFirstCtx: number
  avgFirstTurn: number
  up: number
  down: number
  missed: number
  usd: number
  score: number
}

export function compare(list: readonly TrialSession[]): {
  n: number
  signals: JudgeRow
  model: JudgeRow
  pick: 'signals' | 'model'
} {
  const done = counted(list)
  const row = (side: 'signals' | 'model'): JudgeRow => {
    const fired = done.filter(s => s[side].fired > 0)
    const sum = (f: (s: TrialSession) => number) => done.reduce((a, s) => a + f(s), 0)
    const avg = (f: (s: TrialSession) => number) =>
      fired.length ? Math.round(fired.reduce((a, s) => a + f(s), 0) / fired.length) : 0
    const up = sum(s => s[side].up)
    const down = sum(s => s[side].down)
    const missed = sum(s => s[side].missed)
    return {
      sessionsFired: fired.length,
      avgFirstCtx: avg(s => s[side].firstCtx),
      avgFirstTurn: avg(s => s[side].firstTurn),
      up,
      down,
      missed,
      usd: side === 'model' ? sum(s => s.modelUsd) : 0,
      score: up - down - missed,
    }
  }
  const signals = row('signals')
  const model = row('model')
  // A tie goes to the free judge.
  return { n: done.length, signals, model, pick: model.score > signals.score ? 'model' : 'signals' }
}

/** The comparison as the band shows it: one line per judge, then the suggestion. */
export function summaryLines(list: readonly TrialSession[]): string[] {
  const c = compare(list)
  const line = (name: string, r: JudgeRow) =>
    `${name}: right ${r.up} · wrong ${r.down} · missed ${r.missed} · fired in ${r.sessionsFired}/${c.n}` +
    `${r.sessionsFired ? ` at ~${kTok(r.avgFirstCtx)}` : ''}${r.usd ? ` · ${usd(r.usd)}` : ' · free'}`
  return [line('signals', c.signals), line('model', c.model), `suggest keeping ${c.pick}`]
}

export function compareText(list: readonly TrialSession[]): string {
  const c = compare(list)
  const line = (name: string, r: JudgeRow) =>
    `${name.padEnd(8)} fired in ${r.sessionsFired}/${c.n} · first at ~${kTok(r.avgFirstCtx)}, turn ${r.avgFirstTurn} · ` +
    `right ${r.up} · wrong ${r.down} · missed ${r.missed} · score ${r.score}${r.usd ? ` · cost ${usd(r.usd)}` : ' · free'}`
  return [
    `Handoff judges over ${c.n} session${c.n === 1 ? '' : 's'} (right = you agreed or handed off; missed = you handed off and it had not called it):`,
    line('signals', c.signals),
    line('model', c.model),
    `Suggest keeping: ${c.pick}. Keep one with /cache judge signals | model | both.`,
  ].join('\n')
}

// ---- share of the plan's usage limits ----

/** One limit window's learning: where this session last stood, and the % one dollar moves it. */
export type RateLearner = { anchorPct: number; anchorUsd: number; pctPerUsd: number }

const MIN_LEARN_PCT = 1 // a window must move a whole point before a rate is read from it
const MIN_LEARN_USD = 0.5

/**
 * Learns how many percent of a limit window one dollar of this session's spend
 * uses. The window counts every session on the account, so a busy neighbour
 * only ever inflates a reading: the lowest reading is kept. A window that reset
 * (the % fell) or a session whose cost restarted is re-anchored, rate kept.
 */
export function learnRate(prev: RateLearner | undefined, pct: number, spentUsd: number, known = 0): RateLearner {
  const base = prev?.pctPerUsd || known
  if (!prev || pct < prev.anchorPct || spentUsd < prev.anchorUsd) {
    return { anchorPct: pct, anchorUsd: spentUsd, pctPerUsd: base }
  }
  const dPct = pct - prev.anchorPct
  const dUsd = spentUsd - prev.anchorUsd
  if (dPct < MIN_LEARN_PCT || dUsd < MIN_LEARN_USD) return { ...prev, pctPerUsd: base }
  const r = dPct / dUsd
  return { anchorPct: pct, anchorUsd: spentUsd, pctPerUsd: base > 0 ? Math.min(base, r) : r }
}

/** The pings a keep-warm span takes and what they cost. */
export function keepCost(pingUsd: number, spanMs: number, ttlMs: number): number {
  return Math.ceil(spanMs / Math.max(MIN, ttlMs - pingMargin(ttlMs))) * pingUsd
}

/** A spend as a share of a limit window: '0.4% 5h', '' while the rate is unknown. */
export function pctText(spendUsd: number, pctPerUsd: number | undefined, label: string): string {
  if (!pctPerUsd || pctPerUsd <= 0) return ''
  const p = spendUsd * pctPerUsd
  return `${p < 0.1 ? '<0.1' : p < 10 ? p.toFixed(1) : p.toFixed(0)}% ${label}`
}

/** One warm against the 5-hour window, a keep-warm span against the weekly one. */
export function shareLine(pingUsd: number, keepMs: number, ttlMs: number, r: Rates): { warm: string; keep: string } {
  return {
    warm: pctText(pingUsd, r.five_hour, '5h'),
    keep: pctText(keepCost(pingUsd, keepMs, ttlMs), r.seven_day, 'wk'),
  }
}

// ---- small helpers ----

/** How long before expiry a keep-warm ping goes out. */
export function pingMargin(ttlMs: number): number {
  return ttlMs >= 30 * MIN ? 5 * MIN : MIN
}

export function usd(n: number): string {
  return n < 0.01 ? '<$0.01' : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`
}

export function clockText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return s > 3600 ? `${h}h${String(m).padStart(2, '0')}m` : `${Math.floor(s / 60)}:${ss}`
}

export function bar(fraction: number, cells: number): string {
  const full = Math.round(Math.min(1, Math.max(0, fraction)) * cells)
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

const HANDOFF_SECTIONS = [
  'Sections, terse, under 150 lines in all:',
  '1. Goal: what the person asked for, in their words.',
  '2. State: what is done, verified, and how it was verified (commands, counts).',
  '3. Decisions and constraints the person gave in this session.',
  '4. Files touched, with path:line for anything important.',
  '5. Failed attempts and why they failed.',
  '6. Open questions and the next three steps.',
  '7. A fenced block headed PROMPT: the exact text to paste into a fresh session, naming this file.',
]

export function handoffPath(dir: string, stamp: string): string {
  return `${dir ? dir.replace(/\/$/, '') : '.'}/HANDOFF-${stamp}.md`
}

export function handoffPrompt(dir: string, stamp: string): string {
  return [
    `Write a handoff file to ${handoffPath(dir, stamp)} so a fresh session can continue this work without this conversation.`,
    ...HANDOFF_SECTIONS,
    'Then reply with the path and one line: run /clear and paste the PROMPT block.',
  ].join('\n')
}

/** The fork has no tools: it answers the file's text and the mod writes it. */
export function compactHandoffPrompt(path: string): string {
  return [
    'The conversation is about to be auto-compacted. Write the handoff file that lets a fresh session',
    `continue this work without this conversation; it will be saved to ${path}.`,
    ...HANDOFF_SECTIONS,
    'Reply with the file\'s Markdown only: no preamble, no closing line, no outer code fence.',
  ].join('\n')
}

/**
 * Saves a handoff file before an auto-compaction, then lets the compaction run
 * with the summary told where the file is. Never blocks the compaction: a fork
 * or write that fails passes the event on unchanged.
 */
export async function saveHandoffBeforeCompact<R>(
  $: EngineInterface,
  e: { instructions?: string } & Record<string, unknown>,
  next: (e: never) => Promise<R>,
): Promise<R> {
  const pass = next as unknown as (x: typeof e) => Promise<R>
  try {
    const t = new Date(await $.clock.now())
    const stamp = t.toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const dir = cfg.handoffDir || (await $.session.cwd())
    const path = handoffPath(dir, stamp)
    const r = await $.model.fork({ prompt: compactHandoffPrompt(path) })
    if (!r.isAnswered || !r.text.trim()) {
      $.ui.toast(`cache-keeper: no handoff before compaction (${r.isAnswered ? 'empty' : r.reason})`)
      return pass(e)
    }
    await $.fs.write(path, r.text.trim() + '\n')
    $.ui.toast(`cache-keeper: handoff saved before compaction: ${path}`)
    const note = `A handoff file was saved at ${path} just before this compaction. Name that path in the summary.`
    return pass({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${note}` : note })
  } catch {
    return pass(e)
  }
}

type Cfg = { ttlMs: number; keepMs: number; usdPerMTok: number; handoffDir: string }

let cfg: Cfg = { ttlMs: 60 * MIN, keepMs: 600 * MIN, usdPerMTok: 5, handoffDir: '' }
let isBusy = false
let warnedFor = 0
let tick: { cancel: () => void } | undefined
// Signals of this session; they start over on a reload of the module.
let calls: Call[] = []
let learners: Record<string, RateLearner> = {}
let earlyDirs: string[] = []
let recentDirs: string[] = []
let prompts: boolean[] = []
let isJudging = false
let lastJudgedTurn = 0

const usesSignals = (j: Judge) => j !== 'model'
const usesModel = (j: Judge) => j !== 'signals'

async function touch($: EngineInterface) {
  const t = await $.clock.now()
  await update($, lastTouch, () => t)
  await update($, now, () => t)
}

async function warm($: EngineInterface, why: string) {
  if (await read($, isPinging)) return
  await update($, isPinging, () => true)
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    const at = await $.clock.now()
    if (!r.isAnswered) {
      const note = r.reason === 'nothing-to-fork' ? 'nothing cached yet' : `failed: ${r.reason}`
      const cost = 'usage' in r ? spend(r.usage) : 0
      await update($, lastPing, () => ({ at, ok: false, usd: cost, note }))
      $.ui.toast(`cache-keeper: warm ${note}`)
      return
    }
    const u = r.usage
    const isHit = u.cache_read_input_tokens > 0
    const note = isHit
      ? `${why} hit ${Math.round(u.cache_read_input_tokens / 1000)}k`
      : `${why} miss: rewrote the cache`
    await update($, lastPing, () => ({ at, ok: isHit, usd: spend(u), note }))
    const seen = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    await update($, ctxTokens, ctx => (ctx > 0 ? ctx : seen))
    await touch($)
  } finally {
    await update($, isPinging, () => false)
  }
}

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function spend(u: Usage, usdPerMTok = cfg.usdPerMTok): number {
  const weighted =
    u.input_tokens +
    u.cache_read_input_tokens * 0.1 +
    u.cache_creation_input_tokens * 2 +
    u.output_tokens * 5
  return (weighted * usdPerMTok) / 1e6
}

async function facts($: EngineInterface, t: number): Promise<Facts> {
  const touched = await read($, lastTouch)
  const until = await read($, keepUntil)
  return {
    ctx: await read($, ctxTokens),
    window: await read($, ctxWindow),
    base: await read($, baseTokens),
    leftMs: touched > 0 ? touched + cfg.ttlMs - t : 0,
    ttlMs: cfg.ttlMs,
    keepLeftMs: Math.max(0, until - t),
    usdPerMTok: cfg.usdPerMTok,
  }
}

/** Applies `fn` to this session's trial record and keeps the result across sessions. */
async function record($: EngineInterface, fn: (s: TrialSession) => TrialSession) {
  const cur = await read($, trial)
  if (!cur) return
  const next = fn(cur)
  await update($, trial, () => next)
  const list = ((await $.store.get('sessions')) as TrialSession[] | undefined) ?? []
  const i = list.findIndex(s => s.id === next.id)
  if (i >= 0) list[i] = next
  else list.push(next)
  await $.store.set('sessions', list.slice(-30))
}

/** Marks a judge's first call of a handoff in this session. */
async function fired($: EngineInterface, side: 'signals' | 'model') {
  const t = await $.clock.now()
  const ctx = await read($, ctxTokens)
  await record($, s => {
    const v = s[side]
    return {
      ...s,
      [side]: {
        ...v,
        fired: v.fired + 1,
        firstAt: v.firstAt || t,
        firstCtx: v.firstCtx || ctx,
        firstTurn: v.firstTurn || s.turns,
      },
    }
  })
}

/** The person rated the suggestion on screen: credit or debit each judge that made it. */
async function vote($: EngineInterface, isRight: boolean) {
  const s = await read($, sigWhy)
  const m = await read($, modelWhy)
  await record($, r => ({
    ...r,
    signals: s ? { ...r.signals, [isRight ? 'up' : 'down']: r.signals[isRight ? 'up' : 'down'] + 1 } : r.signals,
    model: m ? { ...r.model, [isRight ? 'up' : 'down']: r.model[isRight ? 'up' : 'down'] + 1 } : r.model,
  }))
  await update($, voted, () => `${s}|${m}`)
}

async function judgeByModel($: EngineInterface) {
  if (isJudging) return
  isJudging = true
  try {
    const rows = await $.session.messages()
    const ctx = await read($, ctxTokens)
    const win = await read($, ctxWindow)
    const r = await $.model.complete({
      model: JUDGE_MODEL,
      system: JUDGE_SYSTEM,
      prompt: `Context so far: ${kTok(ctx)} tokens${win ? ` of ${kTok(win)}` : ''}.\nLast turns:\n${digest(rows)}`,
      maxTokens: 150,
      effort: 'low',
      timeoutMs: 30_000,
    })
    const cost = spend(r.usage, JUDGE_USD_PER_MTOK)
    await record($, s => ({ ...s, modelCalls: s.modelCalls + 1, modelUsd: s.modelUsd + cost }))
    if (!r.isAnswered) return
    const v = parseVerdict(r.text)
    if (!v) return
    const why = v.handoff ? v.why || 'off track' : ''
    const before = await read($, modelWhy)
    await update($, modelWhy, () => why)
    if (why && !before) await fired($, 'model')
  } finally {
    isJudging = false
  }
}

async function check($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  const f = await facts($, t)
  const until = await read($, keepUntil)
  const touched = await read($, lastTouch)
  const j = await read($, judge)

  if (until > 0 && t >= until) {
    await update($, keepUntil, () => 0)
    $.ui.toast('cache-keeper: keep-warm window ended')
  } else if (until > t && touched > 0 && !isBusy && f.leftMs <= pingMargin(cfg.ttlMs)) {
    await warm($, 'keep-warm')
  }

  if (until <= t && touched > 0 && f.leftMs > 0 && f.leftMs <= pingMargin(cfg.ttlMs) && warnedFor !== touched) {
    warnedFor = touched
    $.ui.toast(`cache-keeper: cache expires in ${clockText(f.leftMs)}, press Warm to keep it`)
  }

  const sig = signalVerdict(
    { retryLoops: retryLoops(calls), corrections: prompts.slice(-10).filter(Boolean).length, drift: drifted(earlyDirs, recentDirs) },
    f.window > 0 ? f.ctx / f.window : 0,
  )
  const sigBefore = await read($, sigWhy)
  if (sig !== sigBefore) {
    await update($, sigWhy, () => sig)
    if (sig && !sigBefore) await fired($, 'signals')
  }

  const m = await read($, modelWhy)
  const parts = [reason(f)]
  if (usesSignals(j) && sig) parts.push(j === 'trial' ? `signals: ${sig}` : sig)
  if (usesModel(j) && m) parts.push(j === 'trial' ? `model: ${m}` : m)
  const why = parts.filter(Boolean).join(' | ')
  const before = await read($, suggested)
  if (why !== before) {
    await update($, suggested, () => why)
    if (why && !before) {
      $.ui.toast(`cache-keeper: handoff suggested, ${why}`)
      void $.ui.notify(`Handoff suggested: ${why}`, { title: 'cache-keeper' }).catch(() => {})
    }
  }
}

async function keep($: EngineInterface, hours?: number) {
  const t = await $.clock.now()
  const span = hours && hours > 0 ? hours * 60 * MIN : cfg.keepMs
  await update($, keepUntil, () => t + span)
  return `Keeping the cache warm for ${clockText(span)} while idle.`
}

async function handoff($: EngineInterface) {
  // A handoff the person chose credits the judges that called it and charges the ones that did not.
  const s = await read($, sigWhy)
  const m = await read($, modelWhy)
  await record($, r => ({
    ...r,
    handoffs: r.handoffs + 1,
    signals: { ...r.signals, ...(s ? { up: r.signals.up + 1 } : { missed: r.signals.missed + 1 }) },
    model: { ...r.model, ...(m ? { up: r.model.up + 1 } : { missed: r.model.missed + 1 }) },
  }))
  const t = new Date(await $.clock.now())
  const stamp = t.toISOString().slice(0, 16).replace(/[:T]/g, '-')
  await $.prompt.submit({ text: handoffPrompt(cfg.handoffDir, stamp), asUser: true })
}

async function setJudge($: EngineInterface, j: Judge) {
  await $.store.set('judge', j)
  await update($, judge, () => j)
  await update($, isTrialDone, () => false)
  await update($, trialSummary, () => [])
  if (j === 'signals') await update($, modelWhy, () => '')
  if (j === 'model') await update($, sigWhy, () => '')
  $.ui.toast(j === 'trial' ? 'cache-keeper: trial back on' : `cache-keeper: handoff judge kept: ${j}`)
}

export const register: Register = (on, options) => {
  const opt = options as Options
  cfg = {
    ttlMs: Math.max(1, opt.ttlMinutes ?? 60) * MIN,
    keepMs: Math.max(0.5, opt.keepHours ?? 10) * 60 * MIN,
    usdPerMTok: opt.inputUsdPerMTok ?? 5,
    handoffDir: opt.handoffDir ?? '',
  }
  const { ttlMs, keepMs, usdPerMTok } = cfg

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Prompt-cache keeper: warm | keep [hours] | stop | handoff | trial | judge <which> | show | hide',
      argumentHint: 'warm | keep [hours] | stop | handoff | trial | judge signals|model|both|trial | show | hide',
    })
    const j = ((await $.store.get('judge')) as Judge | undefined) ?? 'trial'
    await update($, judge, () => j)
    const stored = ((await $.store.get('rates')) as Rates | undefined) ?? {}
    await update($, rates, () => stored)
    const id = await $.session.id()
    const t = await $.clock.now()
    const list = ((await $.store.get('sessions')) as TrialSession[] | undefined) ?? []
    const mine = list.find(s => s.id === id)
    await update($, trial, () => (mine ? { ...mine, endedAt: 0 } : blankSession(id, t)))
    const done = j === 'trial' && counted(list.filter(s => s.id !== id)).length >= TRIAL_SESSIONS
    await update($, isTrialDone, () => done)
    await update($, trialSummary, () => (done ? summaryLines(list) : []))
    if (done) {
      // Shown in every session until a judge is kept: the band carries the comparison and the choice.
      $.ui.toast(`cache-keeper: handoff trial done (${TRIAL_SESSIONS} sessions), pick a judge in the band`)
      void $.ui.notify('Handoff trial done: pick a judge in the cache band', { title: 'cache-keeper' }).catch(() => {})
    }
    tick?.cancel()
    tick = $.clock.every(1000, () => {
      void check($)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    tick?.cancel()
    const t = await $.clock.now()
    await record($, s => ({ ...s, endedAt: t }))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const spent = e.cost?.usd
    if (spent !== undefined && e.rateLimits.length > 0) {
      const known = await read($, rates)
      let moved = false
      for (const w of e.rateLimits) {
        const l = learnRate(learners[w.kind], w.percentUsed, spent, known[w.kind])
        learners = { ...learners, [w.kind]: l }
        if (l.pctPerUsd > 0 && l.pctPerUsd !== known[w.kind]) moved = true
      }
      if (moved) {
        const learned: Rates = { ...known }
        for (const [k, l] of Object.entries(learners)) if (l.pctPerUsd > 0) learned[k] = l.pctPerUsd
        await update($, rates, () => learned)
        await $.store.set('rates', learned)
      }
    }
    const tokens = e.context.tokens
    if (e.changed.includes('context') && tokens !== undefined) {
      await update($, ctxTokens, () => tokens)
      await update($, ctxWindow, () => e.context.window)
      await update($, baseTokens, b => (b > 0 ? Math.min(b, tokens) : tokens))
      const cur = await read($, trial)
      if (cur && tokens > cur.peakCtx) await record($, s => ({ ...s, peakCtx: tokens }))
    }
    return next(e)
  })

  on('session.compact', { trigger: 'auto' }, ($, e, next) =>
    e.agentId === undefined ? saveHandoffBeforeCompact($, e, next as never) : next(e),
  ).catch(($, e, next) => next(e)) // a failure here never holds up the compaction

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      prompts = [...prompts, isCorrection(e.text)].slice(-20)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // an observer: a failure here never holds up the prompt

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      const input = e as unknown as Record<string, unknown>
      calls = [...calls, { key: callKey(e.tool, input), err: 'isError' in r && r.isError === true }].slice(-30)
      const path = input.file_path ?? input.notebook_path ?? input.path
      if (typeof path === 'string' && path.startsWith('/')) {
        const d = dirOf(path)
        if (earlyDirs.length < 8) earlyDirs = [...earlyDirs, d]
        else recentDirs = [...recentDirs, d].slice(-8)
      }
    }
    return r
  }).catch(($, e, next) => next(e)) // an observer: a failure here never changes the tool's result

  on('turn.start', ($, e, next) => {
    isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isBusy = false
      if (e.usage) await touch($)
      await record($, s => ({ ...s, turns: s.turns + 1 }))
      const cur = await read($, trial)
      const ctx = await read($, ctxTokens)
      if (cur && usesModel(await read($, judge)) && ctx >= JUDGE_MIN_CTX && cur.turns - lastJudgedTurn >= JUDGE_EVERY) {
        lastJudgedTurn = cur.turns
        void judgeByModel($)
      }
    }
    return next(e)
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const [verb = '', arg] = e.args.trim().split(/\s+/)
    switch (verb) {
      case 'warm':
        await warm($, 'warm')
        return { text: 'Warm ping sent.' }
      case 'keep':
        return { text: await keep($, Number(arg) || undefined) }
      case 'stop':
        await update($, keepUntil, () => 0)
        return { text: 'Keep-warm stopped.' }
      case 'handoff':
        await handoff($)
        return { text: 'Handoff prompt queued.' }
      case 'hide':
        await update($, isHidden, () => true)
        return { text: 'Cache band hidden. /cache show brings it back.' }
      case 'trial': {
        const list = ((await $.store.get('sessions')) as TrialSession[] | undefined) ?? []
        const n = counted(list).length
        const head =
          (await read($, judge)) === 'trial'
            ? `Trial running: ${Math.min(n, TRIAL_SESSIONS)}/${TRIAL_SESSIONS} sessions counted (ended, ${MIN_TURNS}+ turns).`
            : `Trial over; kept: ${await read($, judge)}.`
        return { text: `${head}\n${compareText(list)}` }
      }
      case 'judge': {
        if (arg !== 'signals' && arg !== 'model' && arg !== 'both' && arg !== 'trial') {
          return { text: 'Usage: /cache judge signals | model | both | trial' }
        }
        await setJudge($, arg)
        return { text: arg === 'trial' ? 'Trial back on: both judges, side by side.' : `Handoff judge kept: ${arg}.` }
      }
      default: {
        await update($, isHidden, () => false)
        const t = await $.clock.now()
        const f = await facts($, t)
        const c = costs(f.ctx, f.base, usdPerMTok)
        const j = await read($, judge)
        const sh = shareLine(c.ping, keepMs, ttlMs, await read($, rates))
        const keepH = Math.round(keepMs / (60 * MIN))
        return {
          text: [
            `Cache: ${f.leftMs > 0 ? `${clockText(f.leftMs)} left` : 'cold'} (TTL ${ttlMs / MIN} min)`,
            `Context: ${Math.round(f.ctx / 1000)}k tokens`,
            `Warm ping ≈ ${usd(c.ping)}${sh.warm ? ` (${sh.warm})` : ''} · keep ${keepH}h ≈ ${usd(keepCost(c.ping, keepMs, ttlMs))}${sh.keep ? ` (${sh.keep})` : ''}`,
            `Cold rewrite ≈ ${usd(c.cold)} · fresh session ≈ ${usd(c.fresh)}`,
            `Usage share: ${sh.warm || sh.keep ? 'learned from this account' : 'learning (needs a subscription and ~$0.50 of use)'}`,
            `Per turn: ${f.ctx > 0 ? payback(f) : '—'}`,
            `Keep-warm: ${f.keepLeftMs > 0 ? `${clockText(f.keepLeftMs)} left` : 'off'}`,
            `Judge: ${j}${j === 'trial' ? ' (signals and model side by side)' : ''}`,
            `Signals: ${(await read($, sigWhy)) || 'on track'} · Model: ${(await read($, modelWhy)) || 'on track'}`,
            `Handoff: ${(await read($, suggested)) || 'not needed yet'}`,
          ].join('\n'),
        }
      }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A finished trial shows even on a hidden band, so the choice is never forgotten.
    if (e.props.hasSurvey || ((await read($, isHidden)) && !(await read($, isTrialDone)))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    const t = (await read($, now)) || (await $.clock.now())
    const f = await facts($, t)
    const c = costs(f.ctx, f.base, usdPerMTok)
    const ping = await read($, lastPing)
    const pinging = await read($, isPinging)
    const why = await read($, suggested)
    const touched = await read($, lastTouch)
    const j = await read($, judge)
    const s = await read($, sigWhy)
    const m = await read($, modelWhy)
    const canVote = j === 'trial' && (s !== '' || m !== '') && (await read($, voted)) !== `${s}|${m}`
    const trialDone = await read($, isTrialDone)
    const summary = await read($, trialSummary)
    const narrow = e.props.bodyColumns < 90
    const sh = shareLine(c.ping, keepMs, ttlMs, await read($, rates))

    const color = f.leftMs <= 0 ? 'inactive' : f.leftMs <= pingMargin(ttlMs) ? 'error' : f.leftMs <= ttlMs / 4 ? 'warning' : 'success'
    const label =
      touched === 0 ? 'cache —' : f.leftMs > 0 ? `cache ${clockText(f.leftMs)}` : 'cache cold'

    return (
      <Box flexDirection="column">
        <Box flexDirection={narrow ? 'column' : 'row'} columnGap={2}>
          <Text>
            <Text color={color} bold>
              ◷ {label}
            </Text>{' '}
            <Text color={color}>{bar(f.leftMs / ttlMs, 10)}</Text>
            <Text dimColor>
              {f.ctx > 0 ? ` · ctx ${Math.round(f.ctx / 1000)}k` : ''}
              {f.ctx > 0 && f.window > 0 ? ` ${Math.round((f.ctx / f.window) * 100)}%` : ''}
              {f.ctx > 0 ? ` · warm ≈ ${usd(c.ping)}${sh.warm ? ` ${sh.warm}` : ''}` : ''}
              {f.ctx > 0 && sh.keep ? ` · ${Math.round(keepMs / (60 * MIN))}h ${sh.keep}` : ''}
              {f.leftMs <= 0 && f.ctx > 0 ? ` · resume ≈ ${usd(c.cold)}` : ''}
            </Text>
            {f.keepLeftMs > 0 && (
              <Text color="suggestion"> · keep-warm {clockText(f.keepLeftMs)}</Text>
            )}
          </Text>
          <Box columnGap={1}>
            <Button
              key="warm"
              hotkey="w"
              label={pinging ? 'Warming…' : 'Warm'}
              onPress={() => void warm($, 'warm')}
            />
            {f.keepLeftMs > 0 ? (
              <Button key="stop" hotkey="k" label="Stop keep" onPress={() => update($, keepUntil, () => 0)} />
            ) : (
              <Button
                key="keep"
                hotkey="k"
                label={`Keep ${Math.round(keepMs / (60 * MIN))}h`}
                onPress={() => keep($)}
              />
            )}
            <Button
              key="handoff"
              hotkey="h"
              label="Handoff"
              variant={why ? 'primary' : 'secondary'}
              onPress={() => handoff($)}
            />
            <Button key="hide" plain label="×" onPress={() => update($, isHidden, () => true)} />
          </Box>
        </Box>
        {why !== '' && (
          <Box columnGap={1}>
            <Text color="warning" wrap="truncate-end">
              ⚠ handoff suggested: {why}
            </Text>
            {canVote && (
              <Box columnGap={1}>
                <Button key="right" label="Right" onPress={() => vote($, true)} />
                <Button key="wrong" label="Wrong" onPress={() => vote($, false)} />
              </Box>
            )}
          </Box>
        )}
        {trialDone && (
          <Box flexDirection="column">
            <Text color="suggestion" bold wrap="truncate-end">
              ◆ handoff trial done ({TRIAL_SESSIONS} sessions): keep which judge?
            </Text>
            {summary.map((l, i) => (
              <Text key={`sum-${i}`} dimColor={i < 2} wrap="truncate-end">
                {'  '}
                {l}
              </Text>
            ))}
            <Box columnGap={1}>
              <Button key="keep-signals" label="Keep signals" onPress={() => setJudge($, 'signals')} />
              <Button key="keep-model" label="Keep model" onPress={() => setJudge($, 'model')} />
              <Button key="keep-both" label="Keep both" onPress={() => setJudge($, 'both')} />
            </Box>
          </Box>
        )}
        {ping !== null && why === '' && !trialDone && (
          <Text dimColor wrap="truncate-end">
            last ping {clockText(t - ping.at)} ago: {ping.note}, ≈ {usd(ping.usd)}
          </Text>
        )}
      </Box>
    )
  })
}
