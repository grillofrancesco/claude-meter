# Claude Meter

Estensione GNOME Shell (Fedora 44, GNOME 50, Wayland) che mostra nella barra superiore una sola icona; il menu contiene:

- vista principale: utilizzo del piano Claude Pro (finestra 5 h, settimanale, eventuali limiti per modello, tempo al reset) ed età del dato;
- pagina "Dettagli ›": token di input/output di Claude Code di oggi (da `~/.claude/projects/**/*.jsonl`, cache esclusa), grafico degli ultimi 7 giorni, preferenze;
- aggiornamento automatico: token locali ogni 60 s, percentuali del piano ogni 5 min e all'apertura del menu se il dato ha più di 3 min. Le ultime percentuali valide restano salvate, così dopo un nuovo accesso sono subito visibili. L'endpoint di Anthropic risponde 429 se interrogato troppo spesso: in quel caso l'estensione attende (5→30 min, o quanto indicato da `Retry-After`) e mostra l'orario del prossimo tentativo, anche dopo un nuovo accesso.

Colori: le barre seguono il tema chiaro/scuro e, a scelta nelle preferenze, il colore d'accento di sistema oppure verde/giallo/rosso in base alle soglie. Lo storico (30 giorni) è conservato in `~/.local/share/claude-meter/state.json`.

## Installazione

```bash
./install.sh
# Wayland: esci e rientra nella sessione, poi
gnome-extensions enable claude-meter@whitebear
```

Disinstallazione: `gnome-extensions uninstall claude-meter@whitebear` (stato locale in `~/.local/share/claude-meter/`).

## Dipendenze
Nessuna oltre a GNOME Shell 50 (GJS, St, Soup 3). Serve Claude Code autenticato con un account Pro/Max (`~/.claude/.credentials.json`).

## Limitazioni
- Le percentuali del piano arrivano dall'endpoint **non ufficiale** `https://api.anthropic.com/api/oauth/usage`, isolato in `lib/usageManager.js`: se Anthropic lo cambia, va aggiornato solo quel file.
- Il token OAuth è usato in sola lettura e mai rinnovato: se è scaduto, il menu lo segnala finché Claude Code non lo rinnova (basta usare Claude Code).
- I token locali riguardano solo Claude Code; la percentuale del piano include anche le altre superfici Claude.
- Lo storico parte dal primo avvio e include solo i record degli ultimi 30 giorni ancora presenti nei file di Claude Code.

## Sviluppo
- Stili: `styles/base.css` + `styles/dark.css` / `styles/light.css`; `./build.sh` genera `stylesheet-dark.css` e `stylesheet-light.css` (GNOME Shell li alterna al cambio tema) e crea il pacchetto in `dist/`.
- Test dei moduli puri: `gjs -m tests/test-parser.js`, `tests/test-usage.js`, `tests/test-data.js`.
- Le estensioni JS non si ricaricano a caldo: `dev/nested.sh start` avvia una GNOME Shell headless isolata (richiede `mutter-devkit`) con l'estensione; `eval`, `shot`, `log`, `stop` per ispezionarla.
