// The state contract of the power-meter plugin: what it keeps in `$.state`
// under its name. The hooks module imports these types from this file.

/** Token counts in the four kinds the API reports, plus how many responses they came from. */
export type Tally = {
  /** Uncached input tokens. */
  input: number
  /** Generated tokens, thinking included. */
  output: number
  /** Input tokens written to the prompt cache. */
  cacheWrite: number
  /** Input tokens served from the prompt cache. */
  cacheRead: number
  /** API responses summed into this tally. */
  requests: number
}

/** A turn that finished: what it cost, on which model, and how long it ran. */
export type FinishedTurn = {
  tally: Tally
  model: string
  durationMs: number
}

/** A turn still running: what its responses so far reported. */
export type PendingTurn = {
  tally: Tally
  model: string
  /** `$.clock.now()` at the last response counted; stale entries are pruned. */
  at: number
}

/** Whether, and how, the session's earlier history was counted. */
export type Seed = {
  /** `none`: not tried yet; `transcript`: read from the transcript file; `fresh`: no transcript yet; `unavailable`: could not be read. */
  kind: 'none' | 'transcript' | 'fresh' | 'unavailable'
  /** Model responses counted from the transcript. */
  messages: number
  /** The transcript path that was tried. */
  path: string | null
}

export type Meter = {
  /** `$.clock.now()` when live counting began in this process; null before the first event. */
  liveSinceMs: number | null
  /** Tokens counted live, by the model id the API reported. */
  live: Record<string, Tally>
  /** Tokens read back from the transcript (a resumed session, or a plugin loaded mid-session), by model id. */
  seeded: Record<string, Tally>
  seed: Seed
  /** The transcript path the SessionStart hook reported, when it did. */
  transcriptPath: string | null
  /** Main-loop turns completed while counting live. */
  turns: number
  /** Subagent turns completed while counting live. */
  agentTurns: number
  /** Wall-clock milliseconds the main loop spent in turns while counting live. */
  activeMs: number
  lastTurn: FinishedTurn | null
  /** Turns in progress, by turn id. */
  pending: Record<string, PendingTurn>
}

declare module 'claude-code' {
  interface PluginState {
    'power-meter': { meter: Shaped<Meter> }
  }
}
