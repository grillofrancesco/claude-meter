// "Installer" delle animazioni: valida gli spritesheet di clawd-animation/ e genera lib/sprites.js.
// Uso (da qualsiasi cwd):  gjs -m tools/build-animations.js <comando> [argomenti]   (vedi `help`)
// I/O sincrono: va bene, non e' codice della shell.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';

const PALETTE_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const STATE_NAMES = ['sleep', 'start', 'work', 'done'];

const toolsDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const rootDir = GLib.path_get_dirname(toolsDir);
const animDir = GLib.build_filenamev([rootDir, 'clawd-animation']);
const manifestPath = GLib.build_filenamev([animDir, 'animations.json']);
const outPath = GLib.build_filenamev([rootDir, 'lib', 'sprites.js']);

class CliError extends Error {}
const fail = msg => { throw new CliError(msg); };

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        fail(`impossibile leggere ${path}`);
    return new TextDecoder().decode(bytes);
}

function writeText(path, text) {
    Gio.File.new_for_path(path).replace_contents(
        new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.NONE, null);
}

function readManifest() {
    try {
        return JSON.parse(readText(manifestPath));
    } catch (e) {
        if (e instanceof CliError)
            throw e;
        return fail(`manifest non valido (${manifestPath}): ${e.message}`);
    }
}

function writeManifest(m) {
    writeText(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
}

// PNG -> {width, height, pixel(x, y) -> [r, g, b, a]}
function loadSheet(path) {
    const pb = GdkPixbuf.Pixbuf.new_from_file(path);
    const width = pb.get_width(), height = pb.get_height();
    const stride = pb.get_rowstride(), channels = pb.get_n_channels();
    const hasAlpha = pb.get_has_alpha();
    const data = pb.get_pixels();
    return {
        width, height,
        pixel(x, y) {
            const i = y * stride + x * channels;
            return [data[i], data[i + 1], data[i + 2], hasAlpha ? data[i + 3] : 255];
        },
    };
}

// Valida manifest + sheet. Non scrive nulla. Restituisce {errors, lines, data}.
function analyze(manifest) {
    const errors = [];           // tutti i problemi (stringhe)
    const general = [];          // problemi non gia' mostrati nelle righe per animazione
    const animErrors = {};       // nome -> [messaggi]
    const pushG = m => { errors.push(m); general.push(m); };
    const addErr = (name, msg) => {
        (animErrors[name] ??= []).push(msg);
        errors.push(`${name}: ${msg}`);
    };

    const fps = manifest.fps;
    if (!Number.isInteger(fps) || fps <= 0)
        pushG('"fps" deve essere un intero positivo');
    const pixel = manifest.pixel, maxHeight = manifest.maxHeight;
    if (!Number.isInteger(pixel) || pixel <= 0)
        pushG('"pixel" deve essere un intero positivo');
    if (!Number.isInteger(maxHeight) || maxHeight <= 0)
        pushG('"maxHeight" deve essere un intero positivo');
    const maxRows = Number.isInteger(pixel) && Number.isInteger(maxHeight) && pixel > 0
        ? Math.floor(maxHeight / pixel) : null;

    const anims = manifest.animations ?? {};
    const names = Object.keys(anims);
    if (names.length === 0)
        pushG('nessuna animazione nel manifest');

    let height = null, frameWidth = null;
    const info = {};   // nome -> {frames (rows[][]), rowMin, rowMax, perFrame:[{min,max}]}
    for (const name of names) {
        const a = anims[name];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            addErr(name, 'nome non valido (solo lettere, cifre, _)');
        if (a.loop !== true && a.loop !== false)
            addErr(name, '"loop" deve essere true/false');
        if (a.seconds !== undefined) {
            if (a.loop === false)
                addErr(name, 'le animazioni con loop:false non possono avere "seconds"');
            else if (typeof a.seconds !== 'number' || !(a.seconds > 0))
                addErr(name, '"seconds" deve essere > 0');
        }
        const path = GLib.build_filenamev([animDir, a.file ?? '']);
        if (!a.file || !GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            addErr(name, `file "${a.file}" non trovato`);
            continue;
        }
        let sheet;
        try {
            sheet = loadSheet(path);
        } catch (e) {
            addErr(name, `PNG illeggibile: ${e.message}`);
            continue;
        }
        const fw = a.frameWidth ?? sheet.height;
        if (!Number.isInteger(fw) || fw <= 0) {
            addErr(name, 'frameWidth non valido');
            continue;
        }
        if (sheet.width % fw !== 0) {
            addErr(name, `larghezza sheet ${sheet.width} non multipla di frameWidth ${fw}`);
            continue;
        }
        if (height === null) {
            height = sheet.height;
            frameWidth = fw;
        } else if (sheet.height !== height || fw !== frameWidth) {
            addErr(name, `dimensione ${fw}x${sheet.height} diversa da ${frameWidth}x${height}`);
            continue;
        }
        const frames = [];
        const perFrame = [];
        let rowMin = Infinity, rowMax = -1;
        for (let f = 0; f < sheet.width / fw; f++) {
            const rows = [];
            let fMin = Infinity, fMax = -1;
            for (let y = 0; y < height; y++) {
                const row = [];
                for (let x = 0; x < fw; x++) {
                    const p = sheet.pixel(f * fw + x, y);
                    row.push(p);
                    if (p[3] !== 0) {
                        fMin = Math.min(fMin, y);
                        fMax = Math.max(fMax, y);
                    }
                }
                rows.push(row);
            }
            frames.push(rows);
            perFrame.push({min: fMin, max: fMax});
            rowMin = Math.min(rowMin, fMin);
            rowMax = Math.max(rowMax, fMax);
        }
        info[name] = {frames, rowMin, rowMax, perFrame};
    }

    const states = manifest.states ?? {};
    for (const [state, target] of Object.entries(states)) {
        if (!STATE_NAMES.includes(state))
            pushG(`stato sconosciuto "${state}"`);
        for (const n of Array.isArray(target) ? target : [target]) {
            if (!anims[n])
                pushG(`stato "${state}": animazione "${n}" inesistente`);
        }
    }
    for (const s of STATE_NAMES) {
        if (states[s] === undefined)
            pushG(`stato "${s}" non assegnato`);
    }

    // Altezza: riga piu' bassa globale come riferimento (i piedi); i frame che salgono oltre
    // maxRows righe sopra di essa sono quelli che sforano.
    const loaded = Object.keys(info);
    const globalBottom = loaded.length ? Math.max(...loaded.map(n => info[n].rowMax)) : 0;
    const lines = [];
    if (maxRows !== null)
        lines.push(`Limite: altezza max ${maxHeight} px = ${maxRows} righe (pixel ${pixel} px)`);
    else
        lines.push('Limite: non definito (mancano "pixel"/"maxHeight" nel manifest)');
    const nameW = Math.max(0, ...names.map(n => n.length));
    for (const name of names) {
        const pre = `  ${name.padEnd(nameW)}  `;
        const msgs = [...(animErrors[name] ?? [])];
        let desc = '';
        const inf = info[name];
        if (inf) {
            if (inf.rowMax < 0) {
                msgs.push('tutti i frame sono trasparenti');
            } else {
                const n = inf.rowMax - inf.rowMin + 1;
                desc = `${String(inf.frames.length).padStart(2)} frame  righe ${inf.rowMin}..${inf.rowMax} (${n})  `;
                if (maxRows !== null && n > maxRows) {
                    const bad = [];
                    inf.perFrame.forEach((r, i) => {
                        if (r.max >= 0 && (globalBottom - r.min + 1 > maxRows || r.max - r.min + 1 > maxRows))
                            bad.push(i);
                    });
                    const m = `${n} righe > ${maxRows}`;
                    msgs.push(bad.length ? `${m} (frame ${bad.join(', ')})` : m);
                    errors.push(`${name}: ${m}`);
                }
            }
        }
        lines.push(pre + desc + (msgs.length ? `ERRORE: ${msgs.join('; ')}` : 'OK'));
    }

    // Ritaglio globale unico.
    let grid = null;
    if (loaded.length) {
        let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
        for (const name of loaded) {
            for (const rows of info[name].frames) {
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < frameWidth; x++) {
                        if (rows[y][x][3] === 0)
                            continue;
                        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                    }
                }
            }
        }
        if (maxX >= 0) {
            grid = {minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1, frameWidth, height};
            if (maxRows !== null && grid.h > maxRows)
                errors.push(`griglia installata alta ${grid.h} righe > ${maxRows} (insieme di tutte le animazioni)`);
            if (maxRows !== null) {
                lines.push(`Griglia installata: ${grid.w}x${grid.h} → ${grid.w * pixel}x${grid.h * pixel} px` +
                    (grid.h > maxRows ? '  ERRORE: supera il limite' : ''));
            }
        }
    }

    // Palette + dati (solo se i dati sono completi).
    let palette = null, out = null;
    if (grid && loaded.length === names.length) {
        palette = new Map();
        out = {};
        let tooMany = false;
        for (const name of names) {
            out[name] = info[name].frames.map(rows => {
                const ls = [];
                for (let y = grid.minY; y <= grid.maxY; y++) {
                    let line = '';
                    for (let x = grid.minX; x <= grid.maxX; x++) {
                        const p = rows[y][x];
                        if (p[3] === 0) {
                            line += '.';
                            continue;
                        }
                        const key = p.join(',');
                        let entry = palette.get(key);
                        if (!entry) {
                            if (palette.size >= PALETTE_CHARS.length) {
                                tooMany = true;
                                line += '.';
                                continue;
                            }
                            entry = {char: PALETTE_CHARS[palette.size], rgba: p};
                            palette.set(key, entry);
                        }
                        line += entry.char;
                    }
                    ls.push(line);
                }
                return ls;
            });
        }
        if (tooMany)
            pushG(`piu' di ${PALETTE_CHARS.length} colori`);
    }

    return {errors, general, lines, info, names, anims, states, fps, pixel, maxHeight, maxRows, grid, palette, out};
}

function render(r) {
    const q = s => `'${s}'`;
    const js = [];
    js.push('// GENERATED by tools/build-animations.js from clawd-animation/ — do not edit by hand.');
    js.push('// Edit the spritesheets / clawd-animation/animations.json and run: gjs -m tools/build-animations.js install');
    js.push(`export const FPS = ${r.fps};`);
    js.push(`export const PIXEL = ${r.pixel};`);
    js.push(`export const MAX_HEIGHT = ${r.maxHeight};`);
    js.push(`export const GRID_W = ${r.grid.w};   // after crop`);
    js.push(`export const GRID_H = ${r.grid.h};`);
    js.push(`export const SPRITE_HEIGHT = ${r.grid.h * r.pixel};`);
    js.push('// char -> [r, g, b, a] (0..255)');
    js.push('export const PALETTE = {');
    for (const {char, rgba} of r.palette.values())
        js.push(`    ${q(char)}: [${rgba.join(', ')}],`);
    js.push('};');
    const stateStr = Object.entries(r.states).map(([k, v]) =>
        `${k}: ${Array.isArray(v) ? `[${v.map(q).join(', ')}]` : q(v)}`).join(', ');
    js.push(`export const STATES = {${stateStr}};`);
    js.push('export const ANIMATIONS = {');
    for (const name of r.names) {
        const a = r.anims[name];
        js.push(`    ${name}: {`);
        js.push(`        loop: ${a.loop},`);
        js.push(`        seconds: ${a.seconds ?? null},`);
        js.push('        frames: [');
        for (const frame of r.out[name]) {
            js.push('            [');
            for (const line of frame)
                js.push(`                ${q(line)},`);
            js.push('            ],');
        }
        js.push('        ],');
        js.push('    },');
    }
    js.push('};');
    js.push('');
    return js.join('\n');
}

function currentSprites() {
    return GLib.file_test(outPath, GLib.FileTest.EXISTS) ? readText(outPath) : null;
}

// check/install: stampa il report; ritorna l'analisi.
function runCheck(manifest) {
    const r = analyze(manifest);
    print(r.lines.join('\n'));
    for (const e of r.general)
        print(`ERRORE: ${e}`);
    return r;
}

function cmdCheck() {
    const r = runCheck(readManifest());
    if (r.errors.length) {
        print(`Controllo fallito: ${r.errors.length} problema/i`);
        return 1;
    }
    print('Controllo OK (nulla scritto)');
    return 0;
}

function cmdInstall() {
    const r = runCheck(readManifest());
    if (r.errors.length || !r.palette) {
        print('Installazione rifiutata: lib/sprites.js non modificato');
        return 1;
    }
    const text = render(r);
    if (text === currentSprites())
        print('lib/sprites.js gia\' aggiornato');
    else {
        writeText(outPath, text);
        print(`lib/sprites.js scritto (${r.palette.size} colori, ${r.fps} fps)`);
    }
    return 0;
}

function cmdList() {
    const manifest = readManifest();
    const r = analyze(manifest);
    print(`Manifest: fps ${r.fps}, pixel ${r.pixel} px, maxHeight ${r.maxHeight} px (max ${r.maxRows} righe)`);
    print('Animazioni:');
    for (const name of r.names) {
        const a = r.anims[name], inf = r.info[name];
        const kind = a.loop ? `loop${a.seconds ? `, ${a.seconds} s` : ''}` : 'una volta';
        const rows = inf && inf.rowMax >= 0
            ? `righe ${inf.rowMin}..${inf.rowMax} (${inf.rowMax - inf.rowMin + 1})` : 'righe ?';
        print(`  ${name}: ${a.file}, ${inf ? inf.frames.length : '?'} frame, ${kind}, ${rows}`);
    }
    print('Stati:');
    for (const [s, v] of Object.entries(r.states))
        print(`  ${s}: ${Array.isArray(v) ? v.join(', ') : v}`);
    if (r.errors.length || !r.palette) {
        print('lib/sprites.js: impossibile confrontare (il controllo fallisce, esegui `check`)');
    } else {
        const cur = currentSprites();
        print(cur === render(r)
            ? 'lib/sprites.js: allineato al manifest e agli sheet'
            : 'lib/sprites.js: NON allineato (esegui `install`)');
    }
    return 0;
}

function cmdPreview(args) {
    const [name, frameArg] = args;
    if (!name)
        fail('uso: preview <nome> [frame]');
    const r = analyze(readManifest());
    const inf = r.info[name];
    if (!inf)
        fail(`animazione "${name}" inesistente o non leggibile`);
    let list = inf.frames.map((f, i) => i);
    if (frameArg !== undefined) {
        const n = Number(frameArg);
        if (!Number.isInteger(n) || n < 0 || n >= inf.frames.length)
            fail(`frame non valido (0..${inf.frames.length - 1})`);
        list = [n];
    }
    const bg = [40, 40, 48];
    for (const i of list) {
        print(`${name} frame ${i}/${inf.frames.length - 1}  (righe usate ${inf.perFrame[i].min}..${inf.perFrame[i].max}` +
            `, limite ${r.maxRows} righe)`);
        inf.frames[i].forEach((row, y) => {
            let s = `\x1b[2m${String(y).padStart(2)} \x1b[0m`;
            for (const p of row) {
                if (p[3] === 0) {
                    s += '\x1b[2m· \x1b[0m';
                } else {
                    const a = p[3] / 255;
                    const c = [0, 1, 2].map(k => Math.round(p[k] * a + bg[k] * (1 - a)));
                    s += `\x1b[48;2;${c[0]};${c[1]};${c[2]}m  \x1b[0m`;
                }
            }
            print(s);
        });
        print('');
    }
    return 0;
}

function parseFlags(args) {
    const pos = [], flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--loop' || a === '--once') {
            flags[a.slice(2)] = true;
        } else if (a === '--name' || a === '--seconds' || a === '--frame-width') {
            if (i + 1 >= args.length)
                fail(`${a} richiede un valore`);
            flags[a.slice(2)] = args[++i];
        } else if (a.startsWith('--')) {
            fail(`opzione sconosciuta ${a}`);
        } else {
            pos.push(a);
        }
    }
    return {pos, flags};
}

function cmdAdd(args) {
    const {pos, flags} = parseFlags(args);
    if (pos.length !== 1 || !flags.name || !(flags.loop || flags.once) || (flags.loop && flags.once))
        fail('uso: add <png> --name <nome> (--loop [--seconds N] | --once) [--frame-width N]');
    const manifest = readManifest();
    const name = flags.name;
    if (manifest.animations?.[name])
        fail(`l'animazione "${name}" esiste gia'`);
    if (flags.once && flags.seconds !== undefined)
        fail('--seconds si usa solo con --loop');
    let src = pos[0];
    if (!GLib.file_test(src, GLib.FileTest.IS_REGULAR))
        src = GLib.build_filenamev([animDir, pos[0]]);
    if (!GLib.file_test(src, GLib.FileTest.IS_REGULAR))
        fail(`file "${pos[0]}" non trovato`);
    const file = GLib.path_get_basename(src);
    const dest = GLib.build_filenamev([animDir, file]);
    if (GLib.path_get_dirname(GLib.canonicalize_filename(src, null)) !== animDir) {
        if (GLib.file_test(dest, GLib.FileTest.EXISTS))
            fail(`${file} esiste gia' in clawd-animation/`);
        Gio.File.new_for_path(src).copy(Gio.File.new_for_path(dest), Gio.FileCopyFlags.NONE, null, null);
        print(`Copiato ${file} in clawd-animation/`);
    }
    const entry = {file, loop: !!flags.loop};
    if (flags.seconds !== undefined) {
        entry.seconds = Number(flags.seconds);
        if (!(entry.seconds > 0))
            fail('--seconds deve essere > 0');
    }
    if (flags['frame-width'] !== undefined) {
        entry.frameWidth = Number(flags['frame-width']);
        if (!Number.isInteger(entry.frameWidth) || entry.frameWidth <= 0)
            fail('--frame-width non valido');
    }
    manifest.animations[name] = entry;
    writeManifest(manifest);
    print(`Aggiunta "${name}" al manifest. Controllo:`);
    const code = cmdCheck();
    print('Per applicare: gjs -m tools/build-animations.js install');
    return code;
}

function cmdRemove(args) {
    const [name] = args;
    if (!name)
        fail('uso: remove <nome>');
    const manifest = readManifest();
    if (!manifest.animations?.[name])
        fail(`animazione "${name}" inesistente`);
    const users = Object.entries(manifest.states ?? {})
        .filter(([, v]) => (Array.isArray(v) ? v : [v]).includes(name)).map(([k]) => k);
    if (users.length)
        fail(`"${name}" e' usata dagli stati: ${users.join(', ')} (cambiali con set-state)`);
    const file = manifest.animations[name].file;
    delete manifest.animations[name];
    writeManifest(manifest);
    print(`Rimossa "${name}" dal manifest. Il file ${file} e' stato mantenuto in clawd-animation/.`);
    print('Per applicare: gjs -m tools/build-animations.js install');
    return 0;
}

function cmdSetState(args) {
    const [state, value] = args;
    if (!STATE_NAMES.includes(state) || !value || args.length !== 2)
        fail('uso: set-state <sleep|start|work|done> <nome[,nome...]>');
    const manifest = readManifest();
    const list = value.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0)
        fail('nessun nome indicato');
    if (state !== 'work' && list.length > 1)
        fail(`solo "work" accetta piu' animazioni`);
    for (const n of list) {
        const a = manifest.animations?.[n];
        if (!a)
            fail(`animazione "${n}" inesistente`);
        if (state === 'start' && a.loop !== false)
            fail(`"start" richiede un'animazione non in loop ("${n}" e' in loop)`);
        if (state !== 'start' && a.loop !== true)
            fail(`"${state}" richiede un'animazione in loop ("${n}" non lo e')`);
    }
    manifest.states ??= {};
    manifest.states[state] = state === 'work' ? list : list[0];
    writeManifest(manifest);
    print(`Stato "${state}" = ${list.join(', ')}`);
    print('Per applicare: gjs -m tools/build-animations.js install');
    return 0;
}

function usage() {
    print(`Uso: gjs -m tools/build-animations.js <comando> [argomenti]

  check                      valida tutto, non scrive nulla (exit 1 se ci sono problemi)
  install                    (default) valida e, solo se tutto e' OK, scrive lib/sprites.js
  list                       animazioni, stati e allineamento di lib/sprites.js
  preview <nome> [frame]     mostra i frame nel terminale (colori ANSI)
  add <png> --name <nome> (--loop [--seconds N] | --once) [--frame-width N]
                             copia il PNG in clawd-animation/, aggiunge la voce e controlla
  remove <nome>              toglie la voce dal manifest (rifiutato se usata da uno stato)
  set-state <stato> <nome[,nome...]>
                             stato: sleep|start|work|done (solo work accetta una lista)
  help                       questo testo`);
}

try {
    const args = [...System.programArgs];
    const cmd = args.shift() ?? 'install';
    let code = 0;
    switch (cmd) {
    case 'check': code = cmdCheck(); break;
    case 'install': code = cmdInstall(); break;
    case 'list': code = cmdList(); break;
    case 'preview': code = cmdPreview(args); break;
    case 'add': code = cmdAdd(args); break;
    case 'remove': code = cmdRemove(args); break;
    case 'set-state': code = cmdSetState(args); break;
    case 'help': case '--help': case '-h': usage(); break;
    default:
        printerr(`Comando sconosciuto: ${cmd}\n`);
        usage();
        code = 1;
    }
    System.exit(code);
} catch (e) {
    printerr(`build-animations: ${e instanceof CliError ? e.message : e}`);
    System.exit(1);
}
