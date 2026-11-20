# Piano di refactoring + lingue (IT/EN)

Branch: `refactor` (da `multi-delete`). Ogni fase = uno o più commit; i test passano dopo ogni merge.

## Obiettivi
1. Preparare il codice alla selezione della lingua IT/EN (circa 80 testi oggi scritti direttamente nel codice).
2. Dividere i due file troppo grandi: `lib/indicator.js` (1211 righe) e `prefs.js` (958).
3. Rendere testabile con gjs la logica di aggiornamento del piano (oggi dentro `extension.js`).
4. Testi tecnici in inglese: descrizioni dello schema GSettings e messaggi di `install.sh`/`build.sh`.

Fuori scope: `tokenParser`, `dataManager`, `sessionStore`, `sessionMonitor`, `crabs`, `tools/` (già separati e testati).

## Traduzioni: dizionario JS + `Intl`, niente gettext né librerie npm
- **gettext** segue la lingua del sistema per tutto il processo gnome-shell: non si può forzare IT/EN per una sola estensione (cambiare `LANGUAGE` cambierebbe la lingua dell'intera shell), e servirebbero `.po`/`.mo` più un passaggio di compilazione.
- **Librerie npm (i18next ecc.)**: vanno incluse nel pacchetto, vanno contro la regola "nessuna dipendenza esterna" di AGENTS.md e la revisione di extensions.gnome.org le guarda con sospetto. Il loro valore (plurali, date, numeri) è già incluso in GJS.
- **Cosa usiamo già pronto**: `Intl.PluralRules` (plurali), `Intl.DateTimeFormat` (nomi di giorni e mesi, verificato in GJS 1.88) e `Intl.NumberFormat` se serve. Il codice da scrivere è solo la ricerca per chiave con i segnaposto `{name}`, circa 60 righe.

### Contratto `lib/i18n.js` (modulo puro, GLib solo per la lingua di sistema)
```js
export const LANGUAGES = ['it', 'en'];
export function resolveLanguage(setting, systemNames = GLib.get_language_names()) // -> 'it' | 'en'
                                       // '' (mai scelta): 'it' se il desktop è in italiano, altrimenti 'en'
export function setLanguage(lang)      // 'it' | 'en'; notifies listeners only if it changed
export function getLanguage()          // -> 'it' | 'en'
export function t(key, params = {})    // '{name}' interpolation; missing key -> console.debug + fallback
                                       // to 'en', then to the key itself (never throws)
export function tn(key, count, params = {}) // plural: entry { one, other } chosen with Intl.PluralRules
export function onLanguageChanged(callback) // -> id
export function disconnectLanguage(id)
```
Dizionari divisi per area (file separati, così più agenti lavorano in parallelo senza conflitti); ogni file contiene entrambe le lingue:
```js
// lib/locale/panel.js   (also prefs.js, errors.js, common.js)
export default { it: { 'panel.menu.title': 'Utilizzo di Claude', ... },
                 en: { 'panel.menu.title': 'Claude usage', ... } };
```
Chiavi `<area>.<sezione>.<nome>`. `tests/test-i18n.js` controlla che `it` ed `en` abbiano le stesse chiavi e gli stessi segnaposto, e che non ci siano doppioni tra le aree.

`lib/format.js` resta puro: legge `getLanguage()` (o un parametro `lang` opzionale per i test) e usa `Intl.DateTimeFormat` per giorni e mesi.

## Selezione della lingua
- Nuova chiave `language` (s, `'' | 'it' | 'en'`, default `''`). Il menu offre solo Italiano / English. Finché l'utente non sceglie, vale `''`: italiano se il desktop è in italiano, altrimenti inglese (fallback inglese). Il menu mostra la lingua effettiva.
- Prefs: menu a tendina nell'header bar della finestra, **in alto a destra** (Italiano / English). `Adw.PreferencesWindow` non offre un modo diretto per metterlo lì: si cerca l'`Adw.HeaderBar` nell'albero dei widget e si usa `pack_end`; se non si trova, si ripiega su una riga "Lingua" in Aspetto.
- Il cambio è immediato ovunque:
  - prefs: le pagine vengono ricostruite mantenendo quella visibile;
  - shell: la barra superiore non ha testi, ma il menu che si apre e la notifica "Animazioni troppo alte" sì. `extension.js` chiama `setLanguage()`; l'indicatore ascolta `onLanguageChanged` e rietichetta il menu (che è chiuso mentre si usano le prefs: alla riapertura è già nella nuova lingua). Barra e Clawd non vengono toccati.

## Fasi e parallelizzazione

Gli agenti sono Sonnet 5.5, ognuno nel proprio git worktree. Ogni agente riceve: i file di sua proprietà, i file che non può toccare, i contratti da rispettare e i criteri di completamento (test verdi + resoconto con le modifiche fatte e i rischi). L'orchestratore rilegge ogni diff prima del merge, lancia `tests/run-all.sh` e per il codice della shell la shell annidata (`dev/nested.sh`).

### Ondata 1 — in parallelo (file disgiunti)
| Agente | Fase | File di proprietà |
|---|---|---|
| A | 0 – rete di sicurezza | `tests/test-format.js`, `tests/run-all.sh` |
| B | 2 – divisione indicatore | `lib/indicator.js`, nuovi `lib/ui/*.js` |
| C | 3 – divisione prefs | `prefs.js`, nuovi `prefs/*.js` |
| D | 4 – regole di aggiornamento | `extension.js`, nuovi `lib/planScheduler.js`, `tests/test-scheduler.js` |

- **B**: `lib/ui/drawing.js` (`roundedRect`, `setSource`), `rings.js`, `bars.js`, `chart.js`, `menu.js` (pagine, `NavItem`, righe, pareggio delle altezze), `panelSpace.js` (misura dell'altezza + notifica). `indicator.js` resta il punto che collega tutto (sulle 300–400 righe), con la stessa API pubblica. Segnali: `connectObject`/`disconnectObject`. I testi non cambiano.
- **C**: `prefs/generalPage.js`, `prefs/sessionsPage.js`, `prefs/widgets.js` (`bindComboRow(settings, key, values, labels)` per le 3 combo; un piccolo gestore dei segnali che si scollega su `close-request`). `prefs.js` diventa il punto d'ingresso sottile. `build.sh`: aggiungere `--extra-source=prefs` (lo fa l'orchestratore, che ne è proprietario).
- **D**: `lib/planScheduler.js`, puro: `isPlanDue(reason, now, state, intervalS)`, `backoffDelay(hits, retryAfterMs)`, `resetTimes(usage)`, `planExpired`, `mergeReason(pending, reason)`, più le costanti. `extension.js` tiene solo timer e collegamenti. Il comportamento resta identico: i test riproducono i casi di oggi.

Verifica 1 (orchestratore): merge, `tests/run-all.sh`, shell annidata (avvio, `eval`, screenshot della barra e del menu, log senza errori), prefs aperte a mano dall'utente.

### Ondata 2 — in parallelo, dopo che l'orchestratore ha scritto lo scheletro di `lib/i18n.js` e i file locale vuoti
| Agente | File di proprietà |
|---|---|
| E – nucleo | `lib/i18n.js`, `lib/locale/common.js`, `lib/format.js`, `tests/test-i18n.js`, `tests/test-format.js` |
| F – testi del pannello | `lib/indicator.js`, `lib/ui/*.js`, `lib/locale/panel.js` |
| G – testi delle prefs | `prefs.js`, `prefs/*.js`, `lib/locale/prefs.js` |
| H – errori e testi tecnici | `extension.js`, `lib/usageManager.js`, `lib/dataManager.js` (solo l'etichetta 'Limite'), `lib/locale/errors.js`, schema (descrizioni in inglese), `install.sh` (messaggi in inglese, scelta `[o]verflow/[c]rop`) |

- I messaggi di `UsageError` diventano interni, in inglese (solo log); la UI traduce partendo da `.code` (`PLAN_ERRORS` → `errors.plan.<code>`).
- Ogni agente scrive le traduzioni inglesi della propria area.

Verifica 2: come la verifica 1, più la shell annidata con `LANGUAGE=en` e con `it`.

### Ondata 3 — sequenziale (un agente, I)
- Chiave `language` nello schema; `extension.js` la applica e la ascolta; l'indicatore si ridisegna nella nuova lingua; menu a tendina nell'header delle prefs con ricostruzione delle pagine.
- Verifica 3: cambio di lingua dal vivo nella shell annidata (`gsettings set ... language en` → screenshot) e nelle prefs (a mano).

### Chiusura (orchestratore)
`AGENTS.md` (proprietà dei file, contratti `i18n`/`planScheduler`, regola "testi della UI tramite `t()`", chiave `language`), `README.md`, rimozione di questo file oppure suo spostamento in `docs/`.

## Rischi
- La divisione di `indicator.js` può rompere delle sfumature già verificate (evidenziazione, `translation_y`, misura del pannello): B deve spostare il codice così com'è, senza riscriverlo, e lo si verifica con screenshot prima e dopo.
- Il menu a tendina nell'header delle prefs dipende dalla struttura interna di libadwaita: c'è la riga di riserva.
- L'output di `Intl` dipende dai dati ICU: i test confrontano i valori calcolati con `Intl` stesso oppure fissano solo `it`/`en` sui casi stabili.
