import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_RATES,
  equivalents,
  familyOf,
  fmtDuration,
  fmtWh,
  tallyGrepLines,
  tallyJsonl,
  whOf,
} from '../hooks/estimate'

test('model families are read off the model id', async () => {
  expect(familyOf('claude-haiku-5-5')).toBe('haiku')
  expect(familyOf('claude-sonnet-5-5')).toBe('sonnet')
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf('claude-fable-5-1')).toBe('fable')
  expect(familyOf('claude-mythos-5-1')).toBe('fable')
  expect(familyOf('some-gateway-model')).toBe('other')
})

test('the energy of a tally follows the rates', async () => {
  const tally = { input: 100, output: 2000, cacheWrite: 5000, cacheRead: 100_000, requests: 1 }
  // 2 Wh/1k × (2000 + 20 + 1000 + 500)
  expect(whOf(tally, 'claude-opus-5-5', DEFAULT_RATES).toFixed(5)).toBe('7.04000')
  // an unknown model is priced as Sonnet
  expect(whOf(tally, 'mystery', DEFAULT_RATES).toFixed(5)).toBe('3.52000')
})

test('numbers read naturally', async () => {
  expect(fmtWh(0.4217)).toBe('0.42 Wh')
  expect(fmtWh(12.44)).toBe('12.4 Wh')
  expect(fmtWh(338.2)).toBe('338 Wh')
  expect(fmtWh(1350)).toBe('1.4 kWh')
  expect(fmtWh(78.04)).toBe('78 Wh')
  expect(fmtWh(0.5)).toBe('0.5 Wh')
  expect(fmtDuration(55_000)).toBe('55 s')
  expect(fmtDuration(190_000)).toBe('3 min 10 s')
  expect(fmtDuration(41 * 60_000)).toBe('41 min')
  expect(fmtDuration(72 * 60_000)).toBe('1 h 12 min')
  expect(equivalents(15)[0]).toBe('1 phone charge')
  expect(equivalents(45)[0]).toBe('3 phone charges')
  expect(equivalents(1.5)[0]).toBe('10% of a phone charge')
})

test('grep output is summed once per message id', async () => {
  const stdout = [
    '"model":"claude-opus-5-5"',
    '"id":"msg_01A"',
    '"input_tokens":2',
    '"cache_creation_input_tokens":20',
    '"cache_read_input_tokens":300',
    '"output_tokens":1000',
    '"input_tokens":2', // the response's own iteration, repeated inside the row
    '"output_tokens":1000',
    '"model":"claude-opus-5-5"',
    '"id":"msg_01A"', // the same response, next content block
    '"input_tokens":2',
    '"output_tokens":1000',
    '"model":"claude-haiku-5-5"',
    '"id":"msg_01B"',
    '"output_tokens":500',
  ].join('\n')
  const counted = tallyGrepLines(stdout)
  expect(counted.messages).toBe(2)
  expect(counted.byModel['claude-opus-5-5']).toEqual({ input: 2, output: 1000, cacheWrite: 20, cacheRead: 300, requests: 1 })
  expect(counted.byModel['claude-haiku-5-5']).toEqual({ input: 0, output: 500, cacheWrite: 0, cacheRead: 0, requests: 1 })
})

test('a transcript is summed once per message id, skipping rows without usage', async () => {
  const row = (id: string, output: number) =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { output_tokens: output } } })
  const text = ['not json', JSON.stringify({ type: 'user', message: {} }), row('msg_1', 10), row('msg_1', 10), row('msg_2', 5)].join('\n')
  const counted = tallyJsonl(text)
  expect(counted.messages).toBe(2)
  expect(counted.byModel['claude-sonnet-5-5']?.output).toBe(15)
})
