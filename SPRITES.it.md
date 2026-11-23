# Animazioni dei Clawd

[English](SPRITES.md) · **Italiano**

Ogni sessione aperta di Claude Code compare nella barra in alto come un Clawd in pixel art, in una
posizione fissa: la sessione più vecchia a sinistra, le nuove si aggiungono a destra, poi gli anelli
di utilizzo. Le animazioni nascono da **spritesheet PNG** in `clawd-animation/` e vengono convertite
in dati JS da uno script: a runtime non si legge nessuna immagine.

`clawd-animation/` è versionata ma serve **solo per lo sviluppo**: non entra nel pacchetto
(`build.sh` include solo `lib/`, `prefs/`, `icons/`, schema e fogli di stile) e chi installa
l'estensione usa il `lib/sprites.js` già generato. I PNG si disegnano con un qualsiasi editor di
pixel art; non c'è uno script generatore. Le versioni vecchie non si tengono in sottocartelle di
`clawd-animation/`: restano nella cronologia git.

## Aggiornare le animazioni (in breve)

**Dimensioni richieste**

- PNG RGBA, una striscia orizzontale per animazione: frame affiancati da sinistra a destra.
- Frame da **16×16 px** (larghezza del frame = altezza dello sheet), quindi lo sheet è largo
  `16 × numero di frame` (16 frame → 256×16). Frame non quadrati: `frameWidth` nel manifest.
- **Tutti** gli sheet con la stessa altezza e la stessa larghezza di frame.
- Contenuto alto al massimo **13 righe** (`floor(maxHeight / pixel)` = 26 / 2), misurate su tutti i
  frame di tutte le animazioni insieme: negli sheet 16×16 disegna tra la riga 2 e la riga 14 (piedi
  alla riga 14), lasciando vuote le righe 0, 1 e 15 in **ogni** frame (effetti come i coriandoli compresi).
- Al massimo **62 colori** diversi sommando tutte le animazioni; alpha 0 = trasparente.

**Quando un'animazione viene accettata**

`check` e `install` validano tutto prima di scrivere; `install` rifiuta (exit 1, `lib/sprites.js`
non modificato) se anche una sola regola non è rispettata: file presente, larghezza dello sheet
multipla del frame, dimensioni uguali per tutti gli sheet, nessuna animazione del tutto trasparente,
nessun frame oltre le 13 righe (il report indica righe e frame che sforano), palette ≤ 62 colori,
stati tutti assegnati ad animazioni esistenti (`start` non in loop, `sleep`/`work`/`done` in loop),
`seconds` solo con `loop: true` e > 0.

**Comandi**

```bash
# 1. modifica i PNG in clawd-animation/ (stessi nomi), oppure aggiungine uno e collegalo a uno stato
gjs -m tools/build-animations.js add nuovo.png --name nuovo --loop
gjs -m tools/build-animations.js set-state work work,nuovo
# 2. controlla (nessuna scrittura) e guarda i frame nel terminale
gjs -m tools/build-animations.js check
gjs -m tools/build-animations.js preview work
# 3. genera lib/sprites.js e verifica
gjs -m tools/build-animations.js install
gjs -m tests/test-crabs.js
gjs -m tools/build-animations.js list      # l'ultima riga deve dire che lib/sprites.js è allineato
# 4. prova nella shell isolata, poi installa
dev/nested.sh start && dev/nested.sh shot crabs 1000 0 280 32 && dev/nested.sh stop
./install.sh                               # su Wayland: esci e rientra nella sessione
# 5. committa insieme clawd-animation/ e lib/sprites.js
```

## Flusso

```
clawd-animation/*.png  +  clawd-animation/animations.json
        │  gjs -m tools/build-animations.js install   (solo lo sviluppatore; valida prima di scrivere)
        ▼
lib/sprites.js   (GENERATO e versionato, non modificare a mano)
        │  compilato una volta al caricamento da lib/crabs.js (livelli per colore + macchina a stati CrabRow)
        ▼
lib/ui/crabArea.js disegna ogni pixel dello sprite come un quadrato di PIXEL × PIXEL px (2) con Cairo
```

## Spritesheet

- Una striscia orizzontale per animazione, frame affiancati da sinistra a destra.
- Frame **quadrati**: la larghezza del frame è l'altezza dello sheet (oggi 16×16).
  Per frame non quadrati aggiungi `frameWidth` all'animazione nel manifest.
- Tutti gli sheet devono avere la stessa altezza e la stessa larghezza di frame.
- Pixel con alpha 0 = trasparenti. Gli altri colori vengono usati così come sono
  (anche semitrasparenti), senza ricolorazione per sessione.
- **Limite di altezza**: il contenuto del pannello è alto 26 px (32 px meno 3 px di bordo sopra e
  sotto); con pixel da 2 px sono al massimo **13 righe**. Il ritaglio globale deve stare in 13 righe:
  negli sheet 16×16 i piedi stanno alla riga 14, quindi si usano le righe 2..14.
- Lo script ritaglia le righe/colonne vuote **comuni a tutti i frame di tutte le animazioni**
  (oggi resta 16×13 → 32×26 px nella barra) e costruisce una palette unica (max 62 colori).

## Manifest `clawd-animation/animations.json`

```json
{
  "fps": 8,
  "pixel": 2,
  "maxHeight": 26,
  "animations": {
    "idle":       {"file": "idle.png",       "loop": true},
    "laptop_out": {"file": "laptop_out.png", "loop": false},
    "success":    {"file": "success.png",    "loop": true, "seconds": 2},
    "work":       {"file": "work.png",       "loop": true}
  },
  "states": {"sleep": "idle", "start": "laptop_out", "work": ["work"], "done": "success"}
}
```

| Campo | Significato |
|---|---|
| `fps` | frame al secondo di tutte le animazioni |
| `pixel` | px logici per pixel dello sprite (2) |
| `maxHeight` | px disponibili nella barra (26): righe massime = `floor(maxHeight / pixel)` |
| `file` | PNG dentro `clawd-animation/` |
| `loop` | `true` = gira in loop; `false` = eseguita una volta sola (tutti i frame) |
| `seconds` | solo con `loop: true`: dopo quanti secondi l'animazione finisce (usato per `done`) |
| `frameWidth` | facoltativo, larghezza di un frame (default: altezza dello sheet) |

`states` collega le animazioni agli stati della sessione:

| Stato | Quando |
|---|---|
| `sleep` | sessione aperta ma ferma (loop) |
| `start` | passaggio ferma → al lavoro: eseguita una volta, poi `work` |
| `work` | sessione al lavoro (loop). Lista: ogni sessione ne sceglie una a caso alla creazione e la tiene |
| `done` | passaggio al lavoro → ferma: per `seconds`, poi `sleep` |

Senza sessioni aperte e con la preferenza "Senza sessioni aperte" = "Clawd che dorme"
(`panel-empty` = `crab`), resta un Clawd in `sleep` accanto agli anelli: alla prima sessione aperta
diventa il suo Clawd (se è già al lavoro fa `start` e poi `work`), e quando si chiude l'ultima il
Clawd rimasto torna a fare da segnaposto (`done` e poi `sleep` se stava lavorando).
Con "Icona", oppure con i Clawd disattivati (`crabs-enabled` = false), la barra mostra l'icona.

Le transizioni (`start`, `done`) arrivano sempre alla fine; alla fine si guarda lo stato attuale
(es. se la sessione è già tornata ferma durante `start`, segue `done`). Il Clawd di una sessione
appena comparsa (o all'avvio dell'estensione) parte direttamente da `sleep` o `work`.

## Comandi

`gjs -m tools/build-animations.js <comando>` (senza comando = `install`), da qualsiasi cartella.
Il manifest viene riscritto con JSON a 2 spazi.

| Comando | Effetto |
|---|---|
| `check` | valida tutto e stampa il report, non scrive nulla; exit 1 se ci sono problemi |
| `install` | stessa validazione; solo se è tutto OK scrive `lib/sprites.js`, altrimenti stampa i motivi e `Installazione rifiutata: lib/sprites.js non modificato` (exit 1) |
| `list` | animazioni (file, frame, loop/una volta, righe usate), mappa degli stati, e se `lib/sprites.js` è allineato |
| `preview <nome> [frame]` | mostra i frame nel terminale a colori (trasparente = punti); i frame partono da 0 |
| `add <png> --name N (--loop [--seconds S] \| --once) [--frame-width W]` | copia il PNG in `clawd-animation/`, aggiunge la voce, esegue `check` (poi serve `install`) |
| `remove <nome>` | toglie la voce; rifiutato se usata da uno stato; il PNG resta |
| `set-state <sleep\|start\|work\|done> <nome[,nome]>` | solo `work` accetta una lista; `start` deve essere non-loop, gli altri loop |
| `help` | istruzioni d'uso |

```bash
gjs -m tools/build-animations.js add yawn.png --name yawn --once
gjs -m tools/build-animations.js set-state start yawn
gjs -m tools/build-animations.js add typing_C.png --name work_C --loop
gjs -m tools/build-animations.js set-state work work,work_C
gjs -m tools/build-animations.js install
```

Il report di `check`/`install` inizia sempre dal limite e dice, per animazione, le righe usate
(nelle coordinate originali dello sheet) e i frame che sforano:

```
Limite: altezza max 26 px = 13 righe (pixel 2 px)
  idle        16 frame  righe 2..14 (13)  OK
  success     16 frame  righe 0..15 (16)  ERRORE: 16 righe > 13 (frame 3, 4, 10, 11)
Griglia installata: 16x16 → 32x32 px  ERRORE: supera il limite
```

`lib/sprites.js` esporta `FPS`, `PIXEL`, `MAX_HEIGHT`, `SPRITE_HEIGHT` (= `GRID_H * PIXEL`, px),
`GRID_W`, `GRID_H`, `PALETTE`, `STATES`, `ANIMATIONS`.

- **Modificare**: cambia il PNG (stesso nome), poi `check` e `install`.
- **Sostituire** l'animazione di uno stato: `set-state`.
- **Cambiare dimensione**: sheet diversi; se la griglia supera le righe massime `install` rifiuta.
  Aggiorna il test della griglia in `tests/test-crabs.js` (oggi si aspetta 16×13, 26 px).

## install.sh e altezza nel pannello

Dopo l'installazione `./install.sh` legge `SPRITE_HEIGHT` da `lib/sprites.js` e
`panel-content-height` (px misurati dall'estensione in esecuzione, 0 = mai misurato):

- 0 → avvisa che l'estensione segnalerà al primo avvio se le animazioni non ci stanno;
- misurato ≥ sprite → `Animations: X px, panel space: Y px - OK`;
- misurato < sprite → spiega e, da terminale, chiede `[o]verflow or [c]rop the top rows?`
  impostando `crab-overflow` (`overflow`/`crop`); senza TTY indica dove cambiarlo
  (Preferenze → "Animazioni troppo alte").
