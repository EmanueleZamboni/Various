import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// With the default rates on an Opus-class model:
// 2 Wh/1k × (2000 + 100 × 0.2 + 5000 × 0.2 + 100000 × 0.005) = 7.04 Wh
const OPUS_TURN = {
  input_tokens: 100,
  output_tokens: 2000,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 5000,
  model: 'claude-opus-5-5',
}

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'power', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

/** The engine beneath the plugin: each noun it reaches, answered from memory. */
function engine(on: On, status: Array<string | undefined>, fs: { exists: boolean; text?: string } = { exists: false }) {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/tester' })
  on('command.register', () => ({ value: { command: 'power' } }))
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', () => ({ value: fs.exists }))
  on('fs.stat', () => ({ value: { kind: 'file', size: fs.text?.length ?? 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: fs.text ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
}

test('a finished turn is counted and pinned to the status line', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, status)

  await $.session.start(START)
  await $.turn.complete({ answer: 'done', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer', usage: OPUS_TURN })

  expect(status.at(-1)).toContain('≈7 Wh so far')
  expect(status.at(-1)).toContain('last turn ≈7 Wh')

  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('Energy so far')
  expect(ran.text).toContain('≈ 7 Wh')
  expect(ran.text).toContain('claude-opus-5-5')
  expect(ran.text).toContain('100,000')
  expect(ran.text).toContain('1 turn, 0 subagent turns, 1 model response')
})

test('a turn in progress shows what its responses reported, and an interrupt keeps it', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, status)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: OPUS_TURN }
  })

  await $.session.start(START)
  const step = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _chunk of step) {
    // drained
  }
  expect(status.at(-1)).toContain('this turn ≈7 Wh')

  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(status.at(-1)).toContain('≈7 Wh so far')
  expect(status.at(-1)).toContain('last turn ≈7 Wh')
})

test('the rates follow the plugin options', { options: { wh_per_1k_output_opus: 4 } }, async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, status)

  await $.session.start(START)
  await $.turn.complete({ answer: 'done', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer', usage: OPUS_TURN })

  expect(status.at(-1)).toContain('≈14.1 Wh so far')
})

test('a subagent turn is counted but does not become the last turn', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, status)

  await $.session.start(START)
  await $.turn.complete({ answer: 'done', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer', usage: OPUS_TURN })
  await $.turn.complete({
    answer: 'report',
    durationMs: 9_000,
    isAborted: false,
    turnId: 'a1',
    agentId: 'agent-1',
    reason: 'answer',
    usage: { ...OPUS_TURN, model: 'claude-haiku-5-5' },
  })

  expect(status.at(-1)).toContain('≈8.1 Wh so far')
  expect(status.at(-1)).toContain('last turn ≈7 Wh')
  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('1 turn, 1 subagent turn, 2 model responses')
  expect(ran.text).toContain('claude-haiku-5-5')
})

const transcriptRow = (id: string, output: number, block: string): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: `${id}-${block}`,
    requestId: `req_${id}`,
    message: {
      model: 'claude-sonnet-5-5',
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: block }],
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 },
    },
  })

const TRANSCRIPT =
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    transcriptRow('a', 1000, 'thinking'),
    transcriptRow('a', 1000, 'text'),
    transcriptRow('a', 1000, 'tool_use'),
    transcriptRow('b', 3000, 'text'),
  ].join('\n') + '\n'

test('a resumed session reads its earlier responses back, once per message id', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, status, { exists: true, text: TRANSCRIPT })

  await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/tester/.claude/projects/-proj/session-1.jsonl' })
  await $.session.start(START)

  // Sonnet, 1 Wh/1k: output 4000 + 20 × 0.2 + 40 × 0.2 + 1000 × 0.005 = 4017 weighted → 4.0 Wh
  expect(status.at(-1)).toContain('≈4 Wh so far')
  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('2 earlier responses read back from the transcript')
  expect(ran.text).toContain('4,000')
})

test('/power reset starts the count over', async ($, on) => {
  const status: Array<string | undefined> = []
  engine(on, status)

  await $.session.start(START)
  await $.turn.complete({ answer: 'done', durationMs: 20_000, isAborted: false, turnId: 't1', reason: 'answer', usage: OPUS_TURN })
  const reset = await $.command.run({ ...RUN, args: 'reset' })
  expect(reset.text).toContain('reset')
  expect(status.at(-1)).toContain('≈0 Wh so far')

  const ran = await $.command.run(RUN)
  expect(ran.text).toContain('Nothing counted yet')
})
