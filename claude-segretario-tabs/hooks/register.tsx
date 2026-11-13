import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Snapshot } from '../types'

/*
 * "Where was I": above the prompt, tabs with Ema's most recent chats (claude.ai and Claude Code) and projects, from
 * his Segretario (the shared memory every chat reports to). 6 tabs; the arrow shows 4 more; "History" shows them all,
 * newest first. A dot marks what is waiting for him. Tap a tab: what was done last, the next step, what Claude is
 * waiting on, and a link that opens the chat.
 * It also tells the Segretario which Claude Code chats exist (title, link, last activity: never their content), so
 * the same bar on claude.ai (Voce extension) shows them too.
 */

const data = atom({ plugin: 'segretario-tabs', key: 'data' } as const, null)
const open = atom({ plugin: 'segretario-tabs', key: 'open' } as const, null)
const more = atom({ plugin: 'segretario-tabs', key: 'more' } as const, 0)
const hidden = atom({ plugin: 'segretario-tabs', key: 'hidden' } as const, false)
const err = atom({ plugin: 'segretario-tabs', key: 'err' } as const, null)

const APP_SESSIONS = ['ccd_session_mgmt']
const EVERY_MS = 120_000
const TABS = 6
const MORE = 4

type Block = { type: string; text?: string }
type Result = { content?: Block[]; isError?: boolean }

function json(r: Result): unknown {
  if (r.isError) throw new Error((r.content?.[0]?.text || 'error').slice(0, 120))
  const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null'
  const j = JSON.parse(text) as unknown
  return j && typeof j === 'object' && !Array.isArray(j) && 'result' in (j as object) ? (j as { result: unknown }).result : j
}

/** ISO time -> "YYYY-MM-DD HH:MM" in Italian time (how the Segretario writes times). */
export function romeTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Rome', hour12: false }).slice(0, 16)
}

/** "2026-11-13 12:52" -> "12:52" today, "yesterday", "11/11". */
export function when(v: string, now: Date): string {
  if (!v) return ''
  const today = romeTime(now.toISOString()).slice(0, 10)
  const yesterday = romeTime(new Date(now.getTime() - 86_400_000).toISOString()).slice(0, 10)
  if (v.startsWith(today)) return v.slice(11, 16)
  if (v.startsWith(yesterday)) return 'yesterday'
  return `${v.slice(8, 10)}/${v.slice(5, 7)}`
}

export const keyOf = (x: Item) => x.link || `${x.tipo}:${x.titolo}`
const short = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v)
const kind = (x: Item) => (x.tipo === 'claude code' ? 'Code' : x.tipo === 'claude.ai' ? 'Chat' : x.tipo === 'progetto' ? 'Project' : 'Chat')

let segretario: string | null = null
let timer: { cancel: () => void } | null = null
let busySince = 0 // a refresh in flight since (ms); one stuck for over a minute no longer blocks the next
/** What the last refresh did, for the status tool (no chat content). */
const diag = { at: '', from: '', appSessions: '', segretario: '', items: 0, lastTimer: '' }


async function callFirst($: EngineInterface, names: string[], remember: string | null, tool: string, args: Record<string, unknown>) {
  let last: unknown = null
  for (const name of remember ? [remember] : names) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return { name, value: json(await $.mcp.call(name, tool, args)) }
    } catch (e) {
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(`${tool}: no connector`)
}

type AppChat = { titolo: string; tipo: string; link: string; quando: string; in_corso: boolean }
type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')

/** The same list the Segretario's chat_recenti makes, built here from sessioni_lista + progetti_lista + the app's own
 *  Claude Code chats: for a session whose connector was connected before chat_recenti existed. */
export function mergeLocal(app: AppChat[], sessioni: Row[], progetti: Row[]): Item[] {
  const byName = new Map(sessioni.map((x) => [norm(str(x.nome)), x] as const))
  const used = new Set<string>()
  const item = (tipo: string, titolo: string, link: string, x: Row | undefined, quando: string, inCorso: boolean): Item => {
    const agg = str(x?.aggiornato)
    return { tipo, titolo: titolo || str(x?.nome), link, progetto: str(x?.progetto), stato: str(x?.stato) || (inCorso ? 'in corso' : ''),
      aspetta: str(x?.stato) === 'aspetta Ema', dove_sono: str(x?.dove_sono), prossimo: str(x?.prossimo_passo),
      domanda: str(x?.domanda_per_ema), quando: agg > quando ? agg : quando, in_corso: inCorso }
  }
  const out: Item[] = []
  for (const c of app) {
    const n = norm(c.titolo)
    let x = byName.get(n)
    if (!x) for (const [k, v] of byName) if (k.length >= 6 && n.length >= 6 && (k.includes(n) || n.includes(k))) { x = v; break }
    if (x) used.add(norm(str(x.nome)))
    out.push(item(c.tipo, c.titolo, c.link, x, c.quando, c.in_corso))
  }
  for (const [k, x] of byName) if (!used.has(k) && str(x.stato) !== 'finita') out.push(item('', str(x.nome), '', x, '', false))
  const withProject = new Set(out.filter((x) => x.progetto).map((x) => norm(x.progetto)))
  for (const p of progetti) {
    if (withProject.has(norm(str(p.nome))) || str(p.id) === 'scambio' || !(str(p.dove_sono) || str(p.prossimo_passo))) continue
    out.push({ tipo: 'progetto', titolo: str(p.nome), link: '', progetto: str(p.nome), stato: str(p.stato), aspetta: str(p.stato) === 'aspetta Ema',
      dove_sono: str(p.dove_sono), prossimo: str(p.prossimo_passo), domanda: '', quando: str(p.aggiornato), in_corso: false })
  }
  return out.sort((a, b) => b.quando.localeCompare(a.quando)).slice(0, 40)
}

/** The Segretario connector's name in THIS session (claude.ai connectors get an id as their name, and a new one after a
 *  reconnect): the server that has the tool sessioni_lista. Also says whether it already has chat_recenti. */
async function findSegretario($: EngineInterface): Promise<{ server: string; nuovo: boolean } | null> {
  const tools = await $.tool.list()
  const servers = new Map<string, Set<string>>()
  for (const t of tools) {
    const m = /^mcp__(.+)__([A-Za-z0-9_]+)$/.exec(t.name)
    if (!m || !m[1] || !m[2]) continue
    if (!servers.has(m[1])) servers.set(m[1], new Set())
    servers.get(m[1])?.add(m[2])
  }
  for (const [server, names] of servers) {
    if (names.has('sessioni_lista') && names.has('progetti_lista')) return { server, nuovo: names.has('chat_recenti') }
  }
  return null
}

async function refresh($: EngineInterface, from = 'timer', force = false) {
  if (!force && busySince && Date.now() - busySince < 60_000) return
  busySince = Date.now()
  try {
    const found = await findSegretario($)
    if (!found) throw new Error('the Segretario connector is not in this chat')
    segretario = found.server
    // 1. the Claude Code chats of this app (title, link, last activity)
    let app: AppChat[] = []
    try {
      const r = await callFirst($, APP_SESSIONS, null, 'list_sessions', { limit: 15 })
      const list = (Array.isArray(r.value) ? r.value : []) as { title?: string; link?: string; lastActivityAt?: string; isRunning?: boolean }[]
      app = list
        .filter((x) => x.link && x.title)
        .map((x) => ({ titolo: x.title ?? '', tipo: 'claude code', link: x.link ?? '', quando: romeTime(x.lastActivityAt ?? ''), in_corso: !!x.isRunning }))
      diag.appSessions = `ok, ${app.length} Claude Code chats`
    } catch (e) {
      diag.appSessions = `failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`
    }
    // 2. tell the Segretario (so the claude.ai bar shows them too), then read the merged list. A session connected
    //    before those two tools existed builds the same list here from the older tools.
    let items: Item[]
    let how: string
    if (found.nuovo) {
      if (app.length) await callFirst($, [found.server], null, 'chat_aperte', { voci: app })
      const r = await callFirst($, [found.server], null, 'chat_recenti', { quante: 40 })
      items = (Array.isArray(r.value) ? r.value : []) as Item[]
      how = 'chat_recenti'
    } else {
      const s = await callFirst($, [found.server], null, 'sessioni_lista', { solo_aperte: false })
      const pr = await callFirst($, [found.server], null, 'progetti_lista', { solo_aperti: true })
      items = mergeLocal(app, (Array.isArray(s.value) ? s.value : []) as Row[], (Array.isArray(pr.value) ? pr.value : []) as Row[])
      how = 'merged here (this chat has the older Segretario tools)'
    }
    const snap: Snapshot = { at: await $.clock.now(), items }
    // a toast only for something NEW waiting for Ema (never at the first load)
    const seen = ((await $.store.get('waiting')) as string[] | undefined) ?? null
    const waiting = items.filter((x) => x.aspetta).map((x) => `${keyOf(x)}|${x.domanda}`)
    if (seen) {
      const fresh = items.filter((x) => x.aspetta && !seen.includes(`${keyOf(x)}|${x.domanda}`))
      if (fresh.length === 1) $.ui.toast(`${fresh[0]?.titolo ?? 'A chat'} is waiting for you`)
      else if (fresh.length > 1) $.ui.toast(`${fresh.length} chats are waiting for you`)
    }
    await $.store.set('waiting', waiting)
    await update($, data, () => snap)
    await update($, err, () => null)
    diag.segretario = `ok, ${how}`
    diag.items = items.length
  } catch (e) {
    diag.segretario = `failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`
    segretario = null
    await update($, err, () => (e instanceof Error ? e.message : String(e)).slice(0, 140))
  } finally {
    diag.at = new Date().toISOString()
    diag.from = from
    if (from === 'timer') diag.lastTimer = diag.at
    busySince = 0
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'recent_chats_status',
      description: "Status of the recent-chats bar above the prompt (segretario-tabs mod): when it last refreshed, whether it reached the Segretario and the app's own chat list. For checking the mod only.",
    })
    // from timers: work started straight from this hook could be cut off when the hook returns
    timer?.cancel()
    timer = $.clock.every(EVERY_MS, () => void refresh($))
    $.clock.after(1, () => void refresh($))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__segretario-tabs__recent_chats_status' }, async ($) => {
    const before = { lastTimer: diag.lastTimer, timerResult: diag.from === 'timer' ? diag.segretario : '' }
    await refresh($, 'status', true)
    return { result: JSON.stringify({ ...diag, ...before }) }
  })

  // after each turn a chat may have just reported to the Segretario: look again
  on('turn.complete', async ($, e, next) => {
    $.clock.after(1, () => void refresh($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text, Link } = $.ui.resolve(e)
    const snap = await read($, data)
    const problem = await read($, err)

    if (await read($, hidden)) {
      const waiting = snap?.items.filter((x) => x.aspetta).length ?? 0
      return (
        <Box>
          <Button key="show" plain dimColor label={`Recent chats${waiting ? ` · ${waiting} waiting` : ''}`} onPress={() => update($, hidden, () => false)} />
        </Box>
      )
    }
    if (!snap) {
      return (
        <Box>
          <Text dimColor>{problem ? `Recent chats: can't reach the Segretario (${problem})` : 'Recent chats: loading…'}</Text>
        </Box>
      )
    }

    const level = await read($, more)
    const openKey = await read($, open)
    const now = new Date(snap.at)
    const items = snap.items
    const sel = items.find((x) => keyOf(x) === openKey) ?? null
    const tab = (x: Item) => (
      <Button
        key={keyOf(x)}
        variant={keyOf(x) === openKey ? 'primary' : 'secondary'}
        label={`${x.aspetta ? '● ' : ''}${short(x.titolo, 24)}`}
        onPress={() => update($, open, (o) => (o === keyOf(x) ? null : keyOf(x)))}
      />
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {items.slice(0, TABS).map(tab)}
          {level === 1 ? items.slice(TABS, TABS + MORE).map(tab) : null}
          {items.length > TABS && (
            <Button key="more" plain dimColor label={level === 1 ? '‹' : '›'} onPress={() => update($, more, (v) => (v === 1 ? 0 : 1))} />
          )}
          <Button key="history" plain dimColor label={level === 2 ? 'Close history' : 'History'} onPress={() => update($, more, (v) => (v === 2 ? 0 : 2))} />
          <Button key="hide" plain dimColor label="Hide" onPress={() => update($, hidden, () => true)} />
        </Box>
        {level === 2 && (
          <Box flexDirection="column" marginTop={1} paddingLeft={1}>
            {items.map((x) => (
              <Button
                key={`h-${keyOf(x)}`}
                plain
                label={`${x.aspetta ? '● ' : '  '}${when(x.quando, now).padEnd(9)} ${kind(x).padEnd(7)} ${short(x.titolo, 48)}${x.progetto && x.progetto !== x.titolo ? `  · ${short(x.progetto, 24)}` : ''}`}
                onPress={() => update($, open, () => keyOf(x))}
              />
            ))}
          </Box>
        )}
        {sel && (
          <Box flexDirection="column" paddingLeft={1} marginTop={1}>
            <Text bold>
              {sel.titolo}
              <Text dimColor>
                {`  ·  ${kind(sel)}${sel.progetto && sel.progetto !== sel.titolo ? ` · ${sel.progetto}` : ''}  ·  ${sel.aspetta ? 'waiting for you' : sel.in_corso ? 'working now' : sel.stato || 'opened'}${sel.quando ? `  ·  ${when(sel.quando, now)}` : ''}`}
              </Text>
            </Text>
            {sel.dove_sono ? <Text>{`Last: ${short(sel.dove_sono, 260)}`}</Text> : null}
            {sel.prossimo ? <Text>{`Next: ${short(sel.prossimo, 260)}`}</Text> : null}
            {sel.domanda ? <Text color="yellow">{`Claude asks you: ${short(sel.domanda, 220)}`}</Text> : null}
            {!sel.dove_sono && !sel.prossimo ? <Text dimColor>This chat hasn't written its progress to the Segretario yet.</Text> : null}
            {sel.link ? <Link href={sel.link}>{sel.tipo === 'claude code' ? 'Open this chat' : 'Open in claude.ai'}</Link> : null}
          </Box>
        )}
        {problem ? <Text dimColor>{`Not updated: ${problem}`}</Text> : null}
      </Box>
    )
  })
}
