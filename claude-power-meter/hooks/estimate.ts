// The energy model and the words it is shown in. Pure functions: nothing
// here touches the engine, so the tests can check the arithmetic directly.
//
// Energy of a tally, in watt-hours:
//
//   Wh = (rate[model family] / 1000)
//        × (output + input × inputFraction + cacheWrite × cacheWriteFraction + cacheRead × cacheReadFraction)
//
// where `rate` is watt-hours per 1,000 generated tokens. Anthropic publishes
// no per-token energy figures; the defaults are calibrated on public
// estimates of frontier-model inference (see the README) and carry a
// plausible range of about one third to three times the central value.

import type { Tally } from '../types'

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'other'

export type Rates = {
  /** Wh per 1,000 output tokens on a Haiku-class model. */
  haiku: number
  /** Wh per 1,000 output tokens on a Sonnet-class model; also the rate for a model that fits no family. */
  sonnet: number
  /** Wh per 1,000 output tokens on an Opus-class model. */
  opus: number
  /** Wh per 1,000 output tokens on a Fable- or Mythos-class model. */
  fable: number
  /** Energy of one uncached input token as a fraction of one output token. */
  inputFraction: number
  /** Energy of one input token written to the prompt cache, as a fraction of one output token. */
  cacheWriteFraction: number
  /** Energy of one input token served from the prompt cache, as a fraction of one output token. */
  cacheReadFraction: number
}

export const DEFAULT_RATES: Rates = {
  haiku: 0.3,
  sonnet: 1,
  opus: 2,
  fable: 3,
  inputFraction: 0.2,
  cacheWriteFraction: 0.2,
  cacheReadFraction: 0.005,
}

/** The plausible range around a central estimate: one third to three times. */
export const RANGE_FACTOR = 3

export const EMPTY_TALLY: Tally = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 }

/** The four counts as the API spells them; a count left out reads as zero. */
export type UsageLike = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)

/** One response's usage as a tally. */
export const tallyOf = (u: UsageLike): Tally => ({
  input: count(u.input_tokens),
  output: count(u.output_tokens),
  cacheWrite: count(u.cache_creation_input_tokens),
  cacheRead: count(u.cache_read_input_tokens),
  requests: 1,
})

export const isEmptyTally = (t: Tally): boolean => t.input + t.output + t.cacheWrite + t.cacheRead === 0

export const addTally = (a: Tally, b: Tally): Tally => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  requests: a.requests + b.requests,
})

/** `byModel` with `t` added under `model`; the input is left as it was. */
export const addTo = (byModel: Record<string, Tally>, model: string, t: Tally): Record<string, Tally> => ({
  ...byModel,
  [model]: addTally(byModel[model] ?? EMPTY_TALLY, t),
})

export const mergeByModel = (a: Record<string, Tally>, b: Record<string, Tally>): Record<string, Tally> => {
  let out = { ...a }
  for (const [model, t] of Object.entries(b)) out = addTo(out, model, t)
  return out
}

export const sumTallies = (byModel: Record<string, Tally>): Tally =>
  Object.values(byModel).reduce(addTally, EMPTY_TALLY)

export function familyOf(model: string): Family {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  return 'other'
}

export function whPer1kOutput(model: string, rates: Rates): number {
  const family = familyOf(model)
  return family === 'other' ? rates.sonnet : rates[family]
}

/** The tally as output-token equivalents. */
export function weightedTokens(t: Tally, rates: Rates): number {
  return (
    t.output +
    t.input * rates.inputFraction +
    t.cacheWrite * rates.cacheWriteFraction +
    t.cacheRead * rates.cacheReadFraction
  )
}

export function whOf(t: Tally, model: string, rates: Rates): number {
  return (whPer1kOutput(model, rates) / 1000) * weightedTokens(t, rates)
}

export function totalWh(byModel: Record<string, Tally>, rates: Rates): number {
  let wh = 0
  for (const [model, t] of Object.entries(byModel)) wh += whOf(t, model, rates)
  return wh
}

/** Average power, in watts, of `wh` spent over `ms`; 0 when no time passed. */
export const wattsOf = (wh: number, ms: number): number => (ms > 0 ? (wh * 3_600_000) / ms : 0)

export const co2Grams = (wh: number, gramsPerKwh: number): number => (wh / 1000) * gramsPerKwh

// ---- words ----

export function fmtInt(x: number): string {
  return Math.round(x)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Two or three significant digits: 0.42, 7.0, 12.4, 338, 1,234. */
export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return '?'
  const a = Math.abs(x)
  if (a === 0) return '0'
  if (a >= 100) return fmtInt(x)
  const fixed = x.toFixed(a < 1 ? 2 : 1)
  // 7.0 reads as 7, 0.50 as 0.5; 12.4 stays
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

export const fmtWh = (wh: number): string => (wh >= 1000 ? `${fmtNum(wh / 1000)} kWh` : `${fmtNum(wh)} Wh`)

export const fmtW = (w: number): string => (w >= 1000 ? `${fmtNum(w / 1000)} kW` : `${fmtNum(w)} W`)

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return min < 10 && s % 60 ? `${min} min ${s % 60} s` : `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

export const fmtRange = (wh: number): string => `${fmtWh(wh / RANGE_FACTOR)} to ${fmtWh(wh * RANGE_FACTOR)}`

/** Everyday comparisons for an amount of energy; the reference values are in the README. */
export function equivalents(wh: number): string[] {
  if (!(wh > 0)) return []
  const out: string[] = []
  const phones = wh / 15 // a phone battery holds about 15 Wh
  const phoneText = fmtNum(phones)
  out.push(
    phones < 1
      ? `${Math.max(1, Math.round(phones * 100))}% of a phone charge`
      : `${phoneText} phone charge${phoneText === '1' ? '' : 's'}`,
  )
  out.push(`${fmtDuration((wh / 10) * 3_600_000)} of a 10 W LED bulb`)
  out.push(`${fmtDuration(wh * 3.6 * 1000)} of a 1 kW microwave`)
  const km = wh / 170 // an electric car uses about 170 Wh per km
  out.push(km < 1 ? `${fmtInt(km * 1000)} m in an electric car` : `${fmtNum(km)} km in an electric car`)
  out.push(`${fmtInt(wh / 0.3)} Google searches (Google's 2009 figure)`)
  return out
}

/** Pads `s` to `width` on the left (numbers) or the right (names). */
export const padLeft = (s: string, width: number): string => (s.length >= width ? s : ' '.repeat(width - s.length) + s)
export const padRight = (s: string, width: number): string => (s.length >= width ? s : s + ' '.repeat(width - s.length))

// ---- reading a transcript back ----

export type Counted = { byModel: Record<string, Tally>; messages: number }

/**
 * Sums the model responses of a transcript file (one JSON row per line).
 * A response is written as one row per content block, each carrying the same
 * `message.id` and the same usage, so rows are counted once per id.
 */
export function tallyJsonl(text: string): Counted {
  const seen = new Set<string>()
  let byModel: Record<string, Tally> = {}
  let messages = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (r['type'] !== 'assistant') continue
    const msg = r['message']
    if (typeof msg !== 'object' || msg === null) continue
    const m = msg as Record<string, unknown>
    const usage = m['usage']
    if (typeof usage !== 'object' || usage === null) continue
    const id = [m['id'], r['requestId'], r['uuid']].find((v): v is string => typeof v === 'string')
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const t = tallyOf(usage as UsageLike)
    if (isEmptyTally(t)) continue
    const model = typeof m['model'] === 'string' ? m['model'] : 'unknown'
    byModel = addTo(byModel, model, t)
    messages += 1
  }
  return { byModel, messages }
}

/**
 * The pattern `grep -oE` is run with over a transcript too large to read
 * whole: message ids, model names and the four counts, one match per line,
 * in file order. Inside a row the model precedes the id, and the counts
 * follow it; text quoted inside a tool result is escaped and never matches.
 */
export const GREP_PATTERN =
  '"id":"msg_[A-Za-z0-9_-]+"|"model":"[^"]+"|"(input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens)":[0-9]+'

/** Sums the lines `grep -oE GREP_PATTERN` printed, once per message id. */
export function tallyGrepLines(stdout: string): Counted {
  const seen = new Set<string>()
  let byModel: Record<string, Tally> = {}
  let messages = 0
  let model = 'unknown'
  let current: { id: string; model: string; usage: Record<string, number> } | null = null
  const flush = (): void => {
    if (current !== null && !seen.has(current.id)) {
      seen.add(current.id)
      const t = tallyOf(current.usage)
      if (!isEmptyTally(t)) {
        byModel = addTo(byModel, current.model, t)
        messages += 1
      }
    }
    current = null
  }
  for (const line of stdout.split('\n')) {
    const asModel = /^"model":"([^"]+)"$/.exec(line)
    if (asModel?.[1] !== undefined) {
      model = asModel[1]
      continue
    }
    const asId = /^"id":"(msg_[A-Za-z0-9_-]+)"$/.exec(line)
    if (asId?.[1] !== undefined) {
      flush()
      current = { id: asId[1], model, usage: {} }
      continue
    }
    const asCount = /^"(\w+)":(\d+)$/.exec(line)
    if (current !== null && asCount?.[1] !== undefined && asCount[2] !== undefined && !(asCount[1] in current.usage)) {
      current.usage[asCount[1]] = Number(asCount[2])
    }
  }
  flush()
  return { byModel, messages }
}
