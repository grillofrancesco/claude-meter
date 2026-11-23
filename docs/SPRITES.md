# Clawd animations

**English** · [Italiano](SPRITES.it.md) · [README](../README.md)

Every open Claude Code session shows up in the top bar as a pixel-art Clawd, in a fixed slot: the
oldest session on the left, new ones added to the right, then the usage rings. The animations come
from **PNG spritesheets** in `clawd-animation/` and are converted into JS data by a script: no image
is read at runtime.

`clawd-animation/` is committed but **dev-only**: it is not packaged (`build.sh` only ships `lib/`,
`prefs/`, `icons/`, the schema and the stylesheets), and users get the already generated
`lib/sprites.js`. The PNGs are drawn with any pixel-art editor; there is no generator script.
Old versions are not kept in subfolders of `clawd-animation/`: they live in the git history.

## Quick update

**Required sizes**

- RGBA PNG, one horizontal strip per animation: frames side by side, left to right.
- **16×16 px** frames (frame width = sheet height), so a sheet is `16 × frame count` wide
  (16 frames → 256×16). Non-square frames: `frameWidth` in the manifest.
- **All** sheets with the same height and the same frame width.
- Content at most **13 rows** tall (`floor(maxHeight / pixel)` = 26 / 2), measured over every frame
  of every animation together: in 16×16 sheets draw between row 2 and row 14 (feet on row 14),
  leaving rows 0, 1 and 15 empty in **every** frame (effects such as confetti included).
- At most **62 distinct colours** across all animations; alpha 0 = transparent.

**When an animation is accepted**

`check` and `install` validate everything before writing; `install` refuses (exit 1,
`lib/sprites.js` untouched) if even one rule fails: file present, sheet width a multiple of the
frame width, same sizes for every sheet, no fully transparent animation, no frame beyond 13 rows
(the report lists the rows and the frames that overflow), palette ≤ 62 colours, every state mapped
to an existing animation (`start` not looping, `sleep`/`work`/`done` looping), `seconds` only with
`loop: true` and > 0.

**Commands**

```bash
# 1. edit the PNGs in clawd-animation/ (same file names), or add a new one and map it to a state
gjs -m tools/build-animations.js add new.png --name new --loop
gjs -m tools/build-animations.js set-state work work,new
# 2. validate (writes nothing) and look at the frames in the terminal
gjs -m tools/build-animations.js check
gjs -m tools/build-animations.js preview work
# 3. generate lib/sprites.js and test
gjs -m tools/build-animations.js install
gjs -m tests/test-crabs.js
gjs -m tools/build-animations.js list      # last line must say lib/sprites.js is in sync
# 4. try it in the isolated shell, then install
dev/nested.sh start && dev/nested.sh shot crabs 1000 0 280 32 && dev/nested.sh stop
./install.sh                               # on Wayland: log out and back in
# 5. regenerate the README preview (needs Pillow)
python3 tools/make-preview-gif.py
# 6. commit clawd-animation/, lib/sprites.js and preview/clawd.gif together
```

## Pipeline

```
clawd-animation/*.png  +  clawd-animation/animations.json
        │  gjs -m tools/build-animations.js install   (developer only; validates before writing)
        ▼
lib/sprites.js   (GENERATED and committed, never edit by hand)
        │  compiled once at load time by lib/crabs.js (per-colour layers + CrabRow state machine)
        ▼
lib/ui/crabArea.js paints every sprite pixel as a PIXEL × PIXEL px square (2) with Cairo
```

## Spritesheets

- One horizontal strip per animation, frames side by side from left to right.
- **Square** frames: the frame width is the sheet height (today 16×16).
  For non-square frames add `frameWidth` to the animation in the manifest.
- Every sheet must have the same height and the same frame width.
- Pixels with alpha 0 are transparent. Other colours are used as they are (semi-transparent
  ones too), with no per-session recolouring.
- **Height limit**: the panel content box is 26 px tall (32 px minus a 3 px border at the top and
  bottom); with 2 px pixels that is at most **13 rows**. The global crop must fit in 13 rows: in 16×16
  sheets the feet sit on row 14, so rows 2..14 are usable.
- The script crops the empty rows/columns **common to all frames of all animations**
  (today 16×13 → 32×26 px in the bar) and builds one shared palette (max 62 colours).

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

| Field | Meaning |
|---|---|
| `fps` | frames per second, all animations |
| `pixel` | logical px per sprite pixel (2) |
| `maxHeight` | px available in the bar (26): max rows = `floor(maxHeight / pixel)` |
| `file` | PNG inside `clawd-animation/` |
| `loop` | `true` = loops; `false` = played once (every frame) |
| `seconds` | only with `loop: true`: after how many seconds the animation ends (used by `done`) |
| `frameWidth` | optional, width of one frame (default: sheet height) |

`states` maps animations to session states:

| State | When |
|---|---|
| `sleep` | session open but idle (loop) |
| `start` | idle → busy: played once, then `work` |
| `work` | session busy (loop). A list: each session picks one at random when created and keeps it |
| `done` | busy → idle: for `seconds`, then `sleep` |

With no open session and the "With No Open Sessions" preference set to "Sleeping Clawd"
(`panel-empty` = `crab`), one sleeping Clawd stays next to the rings: the first session that opens
takes it over (if already busy it plays `start` then `work`), and when the last one closes the
remaining Clawd goes back to being the placeholder (`done` then `sleep` if it was working).
With "Icon", or with Clawds turned off (`crabs-enabled` = false), the bar shows the icon instead.

Transitions (`start`, `done`) always play to the end; at the end the current state is checked (e.g.
if the session went idle again during `start`, `done` follows). The Clawd of a session that just
appeared (or when the extension starts) begins directly in `sleep` or `work`.

## Commands

`gjs -m tools/build-animations.js <command>` (no command = `install`), from any directory. The
manifest is rewritten as 2-space JSON.

| Command | Effect |
|---|---|
| `check` | validates everything and prints the report, writes nothing; exit 1 on problems |
| `install` | same validation; writes `lib/sprites.js` only if everything is OK, otherwise prints the reasons and `Install refused: lib/sprites.js not modified` (exit 1) |
| `list` | animations (file, frames, loop/once, rows used), state map, and whether `lib/sprites.js` is in sync |
| `preview <name> [frame]` | shows the frames in the terminal in colour (transparent = dots); frames are numbered from 0 |
| `add <png> --name N (--loop [--seconds S] \| --once) [--frame-width W]` | copies the PNG into `clawd-animation/`, adds the entry, runs `check` (then `install` is needed) |
| `remove <name>` | removes the entry; refused if a state uses it; the PNG stays |
| `set-state <sleep\|start\|work\|done> <name[,name]>` | only `work` takes a list; `start` must be non-looping, the others looping |
| `help` | usage |

```bash
gjs -m tools/build-animations.js add yawn.png --name yawn --once
gjs -m tools/build-animations.js set-state start yawn
gjs -m tools/build-animations.js add typing_C.png --name work_C --loop
gjs -m tools/build-animations.js set-state work work,work_C
gjs -m tools/build-animations.js install
```

The `check`/`install` report always starts with the limit and gives, per animation, the rows used
(in the sheet's original coordinates) and the frames that overflow. Rows are measured from the
lowest row of **all** frames (the feet), so when something overflows the report also says which
frames set that bottom row: often a single stray pixel low in another frame (here frame 0 of
`success`) is what pushes the tall frames over the limit.

```
Limit: max height 26 px = 13 rows (pixel 2 px)
  idle        16 frames  rows 2..14 (13)  OK
  success     16 frames  rows 2..15 (14)  ERROR: 14 rows > 13 (frames 3, 4, 10, 11)
  bottom row 15 (the feet) comes from: success frame 0
Installed grid: 16x14 → 32x28 px  ERROR: over the limit
```

`lib/sprites.js` exports `FPS`, `PIXEL`, `MAX_HEIGHT`, `SPRITE_HEIGHT` (= `GRID_H * PIXEL`, px),
`GRID_W`, `GRID_H`, `PALETTE`, `STATES`, `ANIMATIONS`.

- **Edit**: change the PNG (same file name), then `check` and `install`.
- **Replace** a state's animation: `set-state`.
- **Change size**: different sheets; if the grid exceeds the max rows `install` refuses.
  Update the grid test in `tests/test-crabs.js` (today it expects 16×13, 26 px).

## install.sh and panel height

After installing, `./install.sh` reads `SPRITE_HEIGHT` from `lib/sprites.js` and
`panel-content-height` (px measured by the running extension, 0 = never measured):

- 0 → says the extension will warn on first start if the animations do not fit;
- measured ≥ sprite → `Animations: X px, panel space: Y px - OK`;
- measured < sprite → explains and, from a terminal, asks `[o]verflow or [c]rop the top rows?`,
  setting `crab-overflow` (`overflow`/`crop`); without a TTY it points to Preferences →
  "Animations Too Tall".
