# Aggiornamenti firmati

Il server installa solo commit firmati da una chiave in `allowed_signers` (letta dalla versione GIA installata).
`mode`: `off` | `avviso` (installa tutto, dice solo se e firmato) | `obbligo` (solo commit firmati).
La chiave privata e solo sul PC di Ema (`~/.ssh/firma_deploy`). Per cambiarla: aggiungi la nuova riga qui in un commit firmato con la vecchia.
