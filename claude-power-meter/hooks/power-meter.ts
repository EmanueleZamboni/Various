// power-meter: estimates the electricity this session uses, from the token
// counts every model response reports. A line under the prompt follows each
// response; /power prints the whole account; /power reset starts over.
//
// What is counted: the main loop's responses and every subagent's, as their
// turns report them, plus, for a resumed session or a plugin that loaded
// mid-session, the responses already in the transcript file.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Meter, PendingTurn, Seed, Tally } from '../types'
import {
  DEFAULT_RATES,
  EMPTY_TALLY,
  GREP_PATTERN,
  addTally,
  addTo,
  co2Grams,
  equivalents,
  fmtDuration,
  fmtInt,
  fmtNum,
  fmtRange,
  fmtW,
  fmtWh,
  isEmptyTally,
  mergeByModel,
  padLeft,
  padRight,
  sumTallies,
  tallyGrepLines,
  tallyJsonl,
  tallyOf,
  totalWh,
  wattsOf,
  whOf,
} from './estimate'
import type { Counted, Rates, UsageLike } from './estimate'

const COMMAND = 'power'
/** `$.fs.read` refuses a larger file; past it the transcript is summed with grep. */
const FOUR_MIB = 4 * 1024 * 1024
/** A turn in progress that reported nothing for this long is dropped. */
const PENDING_TTL_MS = 6 * 60 * 60 * 1000

const EMPTY_METER: Meter = {
  liveSinceMs: null,
  live: {},
  seeded: {},
  seed: { kind: 'none', messages: 0, path: null },
  transcriptPath: null,
  turns: 0,
  agentTurns: 0,
  activeMs: 0,
  lastTurn: null,
  pending: {},
}

// Bump the tag when Meter's fields change: what an earlier version stored
// then reads as EMPTY_METER instead of breaking the new code.
const meter = atom({ plugin: 'power-meter', key: 'meter' } as const, EMPTY_METER, { shape: 'meter-1' })

type Dollar = EngineInterface
type Usage = { model: string } & UsageLike

const numberOption = (options: PluginOptions, key: string, fallback: number): number => {
  const raw = options[key]
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export const register: Register = (on, options) => {
  const rates: Rates = {
    haiku: numberOption(options, 'wh_per_1k_output_haiku', DEFAULT_RATES.haiku),
    sonnet: numberOption(options, 'wh_per_1k_output_sonnet', DEFAULT_RATES.sonnet),
    opus: numberOption(options, 'wh_per_1k_output_opus', DEFAULT_RATES.opus),
    fable: numberOption(options, 'wh_per_1k_output_fable', DEFAULT_RATES.fable),
    inputFraction: numberOption(options, 'input_fraction', DEFAULT_RATES.inputFraction),
    cacheWriteFraction: numberOption(options, 'cache_write_fraction', DEFAULT_RATES.cacheWriteFraction),
    cacheReadFraction: numberOption(options, 'cache_read_fraction', DEFAULT_RATES.cacheReadFraction),
  }
  const gridGramsPerKwh = numberOption(options, 'grid_g_co2_per_kwh', 400)
  const showStatusLine = options['show_status_line'] !== false

  const view: View = { rates, showStatusLine }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Estimated electricity this session has used, in watt-hours and watts; "reset" starts the count over',
        argumentHint: '[reset]',
      })
    } catch {
      // The status line still works without the command.
    }
    try {
      const now = await $.clock.now()
      const m = await update($, meter, cur => ({ ...cur, liveSinceMs: cur.liveSinceMs ?? now }))
      if (m.seed.kind === 'none') await seedFromTranscript($, m.transcriptPath)
      await refresh($, view)
    } catch {
      // An observer never holds up the session.
    }
    return next(e)
  })

  // The settings-hook event carries the transcript's path, and says when a
  // /clear or a resume happened.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      const path = typeof e.transcript_path === 'string' && e.transcript_path !== '' ? e.transcript_path : null
      if (e.source === 'clear') {
        await resetMeter($, path)
      } else if (e.source !== 'compact') {
        const m = await update($, meter, cur => ({ ...cur, transcriptPath: path ?? cur.transcriptPath }))
        if (m.seed.kind !== 'transcript' && path !== null && path !== m.seed.path) await seedFromTranscript($, path)
      }
      await refresh($, view)
    } catch {
      // As above.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await resetMeter($, null)
        await refresh($, view)
      } catch {
        // As above.
      }
    }
    return next(e)
  })

  // One model request of a turn: once its response is whole, add what it
  // cost to the turn in progress, so the line moves while a long turn runs.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const usage = result.usage
      if (usage !== null) {
        const now = await $.clock.now()
        await update($, meter, m => notePending(m, e.turnId, usage, now))
        await refresh($, view)
      }
    } catch {
      // Never disturb the stream the model's response came through.
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update($, meter, m => commitTurn(m, e, now))
      await refresh($, view)
    } catch {
      // As above.
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      await resetMeter($, null)
      await refresh($, view)
      return { text: 'Power meter reset: counting from now.' }
    }
    const [m, now] = await Promise.all([read($, meter), $.clock.now()])
    return { text: report(m, now, rates, gridGramsPerKwh) }
  })
}

/** What the status line is drawn from: the rates in force, and whether to draw it at all. */
type View = { rates: Rates; showStatusLine: boolean }

async function refresh($: Dollar, view: View): Promise<void> {
  if (!view.showStatusLine) return
  const m = await read($, meter)
  $.ui.status(statusLine(m, view.rates))
}

// ---- the tally ----

function notePending(m: Meter, turnId: string, usage: Usage, now: number): Meter {
  const open = m.pending[turnId]
  const entry: PendingTurn = {
    model: usage.model,
    tally: addTally(open?.tally ?? EMPTY_TALLY, tallyOf(usage)),
    at: now,
  }
  return { ...m, liveSinceMs: m.liveSinceMs ?? now, pending: { ...m.pending, [turnId]: entry } }
}

type TurnEnd = {
  turnId: string
  agentId?: string | undefined
  durationMs: number
  usage?: Usage | undefined
}

/** Moves a turn from `pending` to `live`: the turn's own count, else what its steps reported. */
function commitTurn(m: Meter, e: TurnEnd, now: number): Meter {
  const open = m.pending[e.turnId]
  const pending: Record<string, PendingTurn> = {}
  for (const [id, p] of Object.entries(m.pending)) {
    if (id !== e.turnId && now - p.at < PENDING_TTL_MS) pending[id] = p
  }
  const isAgent = e.agentId !== undefined
  const duration = Math.max(0, e.durationMs)
  const next: Meter = {
    ...m,
    pending,
    liveSinceMs: m.liveSinceMs ?? now,
    turns: m.turns + (isAgent ? 0 : 1),
    agentTurns: m.agentTurns + (isAgent ? 1 : 0),
    activeMs: m.activeMs + (isAgent ? 0 : duration),
  }
  const tally: Tally | undefined =
    e.usage !== undefined ? { ...tallyOf(e.usage), requests: Math.max(1, open?.tally.requests ?? 1) } : open?.tally
  const model = e.usage?.model ?? open?.model ?? 'unknown'
  if (tally === undefined || isEmptyTally(tally)) return next
  return {
    ...next,
    live: addTo(m.live, model, tally),
    lastTurn: isAgent ? m.lastTurn : { tally, model, durationMs: duration },
  }
}

async function resetMeter($: Dollar, transcriptPath: string | null): Promise<void> {
  const now = await $.clock.now()
  await update($, meter, (cur): Meter => ({
    ...EMPTY_METER,
    liveSinceMs: now,
    transcriptPath: transcriptPath ?? cur.transcriptPath,
    seed: { kind: 'fresh', messages: 0, path: null },
  }))
}

// ---- reading the session's earlier responses back ----

async function seedFromTranscript($: Dollar, knownPath: string | null): Promise<void> {
  const path = knownPath ?? (await guessTranscriptPath($))
  const finish = (kind: Seed['kind'], counted?: Counted): Promise<Meter> =>
    update($, meter, (m): Meter => ({
      ...m,
      seed: { kind, messages: counted?.messages ?? 0, path },
      seeded: counted?.byModel ?? m.seeded,
    }))
  if (path === null) {
    await finish('unavailable')
    return
  }
  let exists = false
  try {
    exists = await $.fs.exists(path)
  } catch {
    await finish('unavailable')
    return
  }
  if (!exists) {
    await finish('fresh')
    return
  }
  try {
    const stat = await $.fs.stat(path)
    const counted = stat.size <= FOUR_MIB ? tallyJsonl(await $.fs.read(path)) : await tallyWithGrep($, path)
    await finish('transcript', counted)
  } catch {
    await finish('unavailable')
  }
}

async function tallyWithGrep($: Dollar, path: string): Promise<Counted> {
  const run = await $.process.run(['grep', '-oE', GREP_PATTERN, path], { timeoutMs: 60_000 })
  // grep exits 1 when nothing matched, which is an empty transcript, not a failure.
  if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`grep exited ${run.exitCode}`)
  return tallyGrepLines(run.stdout)
}

/** Where Claude Code keeps this session's transcript: <config dir>/projects/<project slug>/<session id>.jsonl */
async function guessTranscriptPath($: Dollar): Promise<string | null> {
  try {
    const [id, root, configDir, home, profile] = await Promise.all([
      $.session.id(),
      $.session.root(),
      $.env.get('CLAUDE_CONFIG_DIR'),
      $.env.get('HOME'),
      $.env.get('USERPROFILE'),
    ])
    const base =
      configDir !== undefined && configDir !== ''
        ? configDir
        : home !== undefined && home !== ''
          ? `${home}/.claude`
          : profile !== undefined && profile !== ''
            ? `${profile}/.claude`
            : null
    if (base === null || id === '' || root === '') return null
    const slug = root.replace(/[^a-zA-Z0-9]/g, '-')
    return `${base}/projects/${slug}/${id}.jsonl`
  } catch {
    return null
  }
}

// ---- words ----

const pendingByModel = (m: Meter): Record<string, Tally> => {
  let out: Record<string, Tally> = {}
  for (const p of Object.values(m.pending)) out = addTo(out, p.model, p.tally)
  return out
}

const pendingWhOf = (m: Meter, rates: Rates): number => totalWh(pendingByModel(m), rates)

function statusLine(m: Meter, rates: Rates): string {
  const pendingWh = pendingWhOf(m, rates)
  const total = totalWh(mergeByModel(m.seeded, m.live), rates) + pendingWh
  const parts = [`⚡ ≈${fmtWh(total)} so far`]
  if (pendingWh > 0) {
    parts.push(`this turn ≈${fmtWh(pendingWh)}…`)
  } else if (m.lastTurn !== null) {
    const wh = whOf(m.lastTurn.tally, m.lastTurn.model, rates)
    parts.push(
      m.lastTurn.durationMs > 0
        ? `last turn ≈${fmtWh(wh)} (≈${fmtW(wattsOf(wh, m.lastTurn.durationMs))})`
        : `last turn ≈${fmtWh(wh)}`,
    )
  }
  return parts.join(' · ')
}

const percent = (fraction: number): string => {
  const p = fraction * 100
  const text = Number.isInteger(p) ? String(p) : p.toFixed(p < 1 ? 2 : 1).replace(/\.?0+$/, '')
  return `${text}%`
}

const plural = (n: number, word: string): string => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`

function report(m: Meter, now: number, rates: Rates, gridGramsPerKwh: number): string {
  const pending = pendingByModel(m)
  const pendingWh = totalWh(pending, rates)
  const counted = mergeByModel(m.seeded, m.live)
  const total = totalWh(counted, rates) + pendingWh
  const liveWh = totalWh(m.live, rates) + pendingWh
  const lines: string[] = ['⚡ Power meter: estimated electricity for this session', '']

  if (total <= 0) {
    lines.push('Nothing counted yet. The meter fills in as model responses arrive.')
  } else {
    const rows: Array<[string, string]> = [['Energy so far', `≈ ${fmtWh(total)}   (plausible range ${fmtRange(total)})`]]
    if (m.activeMs > 0 && liveWh > 0) {
      rows.push(['While Claude works', `≈ ${fmtW(wattsOf(liveWh, m.activeMs))} averaged over ${fmtDuration(m.activeMs)} of turns`])
    }
    const elapsed = m.liveSinceMs !== null ? now - m.liveSinceMs : 0
    if (elapsed >= 60_000 && liveWh > 0) {
      rows.push(['Whole session', `≈ ${fmtW(wattsOf(liveWh, elapsed))} averaged over ${fmtDuration(elapsed)}`])
    }
    if (pendingWh > 0) rows.push(['Turn in progress', `≈ ${fmtWh(pendingWh)} so far`])
    if (m.lastTurn !== null) {
      const wh = whOf(m.lastTurn.tally, m.lastTurn.model, rates)
      const d = m.lastTurn.durationMs
      rows.push([
        'Last turn',
        `≈ ${fmtWh(wh)} in ${fmtDuration(d)}` + (d > 0 ? `, about ${fmtW(wattsOf(wh, d))} while it ran` : ''),
      ])
    }
    rows.push([`CO₂ at ${fmtInt(gridGramsPerKwh)} g/kWh`, `≈ ${fmtNum(co2Grams(total, gridGramsPerKwh))} g`])
    const width = Math.max(...rows.map(([label]) => label.length))
    for (const [label, value] of rows) lines.push(`${padRight(label, width)}  ${value}`)
    lines.push('', `That is about ${equivalents(total).join(', ')}.`)
  }

  lines.push('')
  const live = sumTallies(m.live).requests + sumTallies(pending).requests
  let tokens = `Tokens counted: ${plural(m.turns, 'turn')}, ${plural(m.agentTurns, 'subagent turn')}, ${plural(live, 'model response')} while this plugin was loaded`
  if (m.seed.kind === 'transcript') tokens += `, plus ${plural(m.seed.messages, 'earlier response')} read back from the transcript`
  lines.push(tokens)
  const table = mergeByModel(counted, pending)
  const models = Object.keys(table).sort()
  if (models.length > 0) {
    const head = ['model', 'output', 'uncached in', 'cache write', 'cache read', '≈ Wh']
    const body = models.map(model => {
      const t = table[model] ?? EMPTY_TALLY
      return [model, fmtInt(t.output), fmtInt(t.input), fmtInt(t.cacheWrite), fmtInt(t.cacheRead), fmtNum(whOf(t, model, rates))]
    })
    const widths = head.map((h, i) => Math.max(h.length, ...body.map(r => (r[i] ?? '').length)))
    const row = (cells: string[]): string =>
      cells.map((cell, i) => (i === 0 ? padRight(cell, widths[i] ?? 0) : padLeft(cell, widths[i] ?? 0))).join('  ')
    lines.push(row(head))
    for (const r of body) lines.push(row(r))
  }

  lines.push(
    '',
    `Assumptions: Wh per 1,000 output tokens by model family: haiku ${String(rates.haiku)}, sonnet ${String(rates.sonnet)}, opus ${String(rates.opus)}, fable/mythos ${String(rates.fable)}; ` +
      `an uncached input token costs ${percent(rates.inputFraction)} of an output token, a cache-written one ${percent(rates.cacheWriteFraction)}, a cache-read one ${percent(rates.cacheReadFraction)}. ` +
      'Anthropic publishes no per-token energy figures: this is a model-based estimate (the README says how it was calibrated). ' +
      'Tune it in /config under power-meter; "/power reset" starts the count over.',
  )
  if (m.seed.kind === 'unavailable') {
    lines.push('Earlier turns of this session could not be read back from its transcript, so the count starts when the plugin loaded.')
  }
  return lines.join('\n')
}
