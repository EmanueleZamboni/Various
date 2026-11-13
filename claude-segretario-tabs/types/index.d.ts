/** One recent chat or project, as the Segretario's chat_recenti returns it. */
export type Item = {
  tipo: string // "claude.ai" | "claude code" | "progetto" | "" (a chat that reported but was never seen opened)
  titolo: string
  link: string
  progetto: string
  stato: string
  aspetta: boolean
  dove_sono: string
  prossimo: string
  domanda: string
  quando: string // "YYYY-MM-DD HH:MM", Italian time
  in_corso: boolean
}

export type Snapshot = { at: number; items: Item[] }

declare module 'claude-code' {
  interface PluginState {
    'segretario-tabs': {
      data: Snapshot | null
      open: string | null
      /** 0 = the 6 tabs, 1 = 4 more, 2 = the whole history */
      more: number
      hidden: boolean
      err: string | null
    }
  }
}
