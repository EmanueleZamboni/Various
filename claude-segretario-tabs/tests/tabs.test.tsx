import { expect, test } from 'claude-code/testing'

// Made-up chats: 12 recent items, the second one waiting for Ema.
const ITEMS = Array.from({ length: 12 }, (_, i) => ({
  tipo: i % 3 === 0 ? 'claude code' : i % 3 === 1 ? 'claude.ai' : 'progetto',
  titolo: `Chat ${i + 1}`,
  link: i % 3 === 0 ? `claude://claude.ai/epitaxy/local_0000000${i}-aaaa` : i % 3 === 1 ? `https://claude.ai/chat/0000000${i}-bbbb` : '',
  progetto: 'Prova',
  stato: i === 1 ? 'aspetta Ema' : 'in corso',
  aspetta: i === 1,
  dove_sono: `fatto il passo ${i + 1}`,
  prossimo: `passo ${i + 2}`,
  domanda: i === 1 ? 'Va bene così?' : '',
  quando: `2026-11-13 ${String(20 - i).padStart(2, '0')}:00`,
  in_corso: false,
}))

const BAND = { plugin: 'segretario-tabs', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('six tabs, the arrow shows four more, history shows all, a tab shows its chat', async ($, on) => {
  const asked: string[] = []
  on('mcp.call', (_, e) => {
    asked.push(`${e.server}/${e.tool}`)
    if (e.server !== 'abc-123') return { value: { content: [{ type: 'text', text: 'unknown server' }], isError: true } }
    const value = e.tool === 'chat_recenti' ? { result: ITEMS } : { segnate: 0 }
    return { value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } }
  })
  on('tool.list', () => ({
    value: ['sessioni_lista', 'progetti_lista', 'chat_recenti', 'chat_aperte'].map((t) => ({ name: `mcp__abc-123__${t}`, description: '', mcp: true })),
  }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-13T21:00:00Z') }))
  on('clock.every', () => ({ value: { id: 1 } }))
  on('clock.after', () => ({ value: { id: 2 } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__segretario-tabs__recent_chats_status' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // the status tool runs a refresh and waits for it
  const status = await $.tool.call({ tool: 'mcp__segretario-tabs__recent_chats_status' } as never)
  expect(JSON.stringify(status)).toContain('chat_recenti')
  expect(asked).toContain('abc-123/chat_recenti')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Button', key: 'Chat 1' }))?.type ?? 'none').toBe('none') // tabs are keyed by link
    expect(await ui.find({ type: 'Button', key: ITEMS[0]!.link })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: ITEMS[6]!.link })).toBeFalsy() // the 7th is behind the arrow
    await ui.press({ key: 'more' })
    expect(await ui.find({ type: 'Button', key: ITEMS[6]!.link })).toBeTruthy()
    await ui.press({ key: 'more' })
    await ui.press({ key: 'history' })
    expect(await ui.find({ type: 'Button', key: `h-progetto:Chat 12` })).toBeTruthy()
    await ui.press({ key: 'history' })
    await ui.press({ key: ITEMS[1]!.link })
    expect((await ui.find({ type: 'Text', text: /Claude asks you: Va bene/ }))?.text).toContain('Va bene così?')
    expect(await ui.find({ type: 'Link' })).toBeTruthy()
    await ui.press({ key: ITEMS[1]!.link })
    await ui.unmount()
  }
})
