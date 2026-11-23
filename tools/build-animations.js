// Animation "installer": validates the spritesheets in clawd-animation/ and generates lib/sprites.js.
// Usage (from any cwd):  gjs -m tools/build-animations.js <command> [arguments]   (see `help`)
// Synchronous I/O is fine here: this is a developer tool, not shell code.
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
        fail(`cannot read ${path}`);
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
        return fail(`invalid manifest (${manifestPath}): ${e.message}`);
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

// Validates manifest + sheets. Writes nothing. Returns {errors, lines, data}.
function analyze(manifest) {
    const errors = [];           // every problem (strings)
    const general = [];          // problems not already shown on the per-animation lines
    const animErrors = {};       // name -> [messages]
    const pushG = m => { errors.push(m); general.push(m); };
    const addErr = (name, msg) => {
        (animErrors[name] ??= []).push(msg);
        errors.push(`${name}: ${msg}`);
    };

    const fps = manifest.fps;
    if (!Number.isInteger(fps) || fps <= 0)
        pushG('"fps" must be a positive integer');
    const pixel = manifest.pixel, maxHeight = manifest.maxHeight;
    if (!Number.isInteger(pixel) || pixel <= 0)
        pushG('"pixel" must be a positive integer');
    if (!Number.isInteger(maxHeight) || maxHeight <= 0)
        pushG('"maxHeight" must be a positive integer');
    const maxRows = Number.isInteger(pixel) && Number.isInteger(maxHeight) && pixel > 0
        ? Math.floor(maxHeight / pixel) : null;

    const anims = manifest.animations ?? {};
    const names = Object.keys(anims);
    if (names.length === 0)
        pushG('no animation in the manifest');

    let height = null, frameWidth = null;
    const info = {};   // name -> {frames (rows[][]), rowMin, rowMax, perFrame:[{min,max}]}
    for (const name of names) {
        const a = anims[name];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            addErr(name, 'invalid name (letters, digits and _ only)');
        if (a.loop !== true && a.loop !== false)
            addErr(name, '"loop" must be true/false');
        if (a.seconds !== undefined) {
            if (a.loop === false)
                addErr(name, 'animations with loop:false cannot have "seconds"');
            else if (typeof a.seconds !== 'number' || !(a.seconds > 0))
                addErr(name, '"seconds" must be > 0');
        }
        const path = GLib.build_filenamev([animDir, a.file ?? '']);
        if (!a.file || !GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            addErr(name, `file "${a.file}" not found`);
            continue;
        }
        let sheet;
        try {
            sheet = loadSheet(path);
        } catch (e) {
            addErr(name, `unreadable PNG: ${e.message}`);
            continue;
        }
        const fw = a.frameWidth ?? sheet.height;
        if (!Number.isInteger(fw) || fw <= 0) {
            addErr(name, 'invalid frameWidth');
            continue;
        }
        if (sheet.width % fw !== 0) {
            addErr(name, `sheet width ${sheet.width} is not a multiple of frameWidth ${fw}`);
            continue;
        }
        if (height === null) {
            height = sheet.height;
            frameWidth = fw;
        } else if (sheet.height !== height || fw !== frameWidth) {
            addErr(name, `size ${fw}x${sheet.height} differs from ${frameWidth}x${height}`);
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
            pushG(`unknown state "${state}"`);
        for (const n of Array.isArray(target) ? target : [target]) {
            if (!anims[n])
                pushG(`state "${state}": animation "${n}" does not exist`);
        }
    }
    for (const s of STATE_NAMES) {
        if (states[s] === undefined)
            pushG(`state "${s}" not assigned`);
    }

    // Height: the lowest row over every frame (the feet) is the reference; frames reaching
    // more than maxRows rows above it are the ones that overflow.
    const loaded = Object.keys(info);
    const globalBottom = loaded.length ? Math.max(...loaded.map(n => info[n].rowMax)) : 0;
    const lines = [];
    if (maxRows !== null)
        lines.push(`Limit: max height ${maxHeight} px = ${maxRows} rows (pixel ${pixel} px)`);
    else
        lines.push('Limit: undefined ("pixel"/"maxHeight" missing from the manifest)');
    const nameW = Math.max(0, ...names.map(n => n.length));
    for (const name of names) {
        const pre = `  ${name.padEnd(nameW)}  `;
        const msgs = [...(animErrors[name] ?? [])];
        let desc = '';
        const inf = info[name];
        if (inf) {
            if (inf.rowMax < 0) {
                msgs.push('every frame is transparent');
            } else {
                const n = inf.rowMax - inf.rowMin + 1;
                desc = `${String(inf.frames.length).padStart(2)} frames  rows ${inf.rowMin}..${inf.rowMax} (${n})  `;
                if (maxRows !== null && n > maxRows) {
                    const bad = [];
                    inf.perFrame.forEach((r, i) => {
                        if (r.max >= 0 && (globalBottom - r.min + 1 > maxRows || r.max - r.min + 1 > maxRows))
                            bad.push(i);
                    });
                    const m = `${n} rows > ${maxRows}`;
                    msgs.push(bad.length ? `${m} (frames ${bad.join(', ')})` : m);
                    errors.push(`${name}: ${m}`);
                }
            }
        }
        lines.push(pre + desc + (msgs.length ? `ERROR: ${msgs.join('; ')}` : 'OK'));
    }
    // An overflow can come from a stray pixel low in another frame: say which frames set
    // the bottom row the others are measured from.
    if (maxRows !== null && loaded.length && errors.some(e => / rows > /.test(e))) {
        const refs = [];
        for (const n of loaded) {
            const frames = info[n].perFrame.flatMap((r, i) => (r.max === globalBottom ? [i] : []));
            if (frames.length)
                refs.push(`${n} frame${frames.length > 1 ? 's' : ''} ${frames.join(', ')}`);
        }
        lines.push(`  bottom row ${globalBottom} (the feet) comes from: ${refs.join('; ')}`);
    }

    // One global crop.
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
                errors.push(`installed grid is ${grid.h} rows tall > ${maxRows} (all animations together)`);
            if (maxRows !== null) {
                lines.push(`Installed grid: ${grid.w}x${grid.h} → ${grid.w * pixel}x${grid.h * pixel} px` +
                    (grid.h > maxRows ? '  ERROR: over the limit' : ''));
            }
        }
    }

    // Palette + data (only when the data is complete).
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
            pushG(`more than ${PALETTE_CHARS.length} colours`);
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

// check/install: prints the report; returns the analysis.
function runCheck(manifest) {
    const r = analyze(manifest);
    print(r.lines.join('\n'));
    for (const e of r.general)
        print(`ERROR: ${e}`);
    return r;
}

function cmdCheck() {
    const r = runCheck(readManifest());
    if (r.errors.length) {
        print(`Check failed: ${r.errors.length} problem(s)`);
        return 1;
    }
    print('Check OK (nothing written)');
    return 0;
}

function cmdInstall() {
    const r = runCheck(readManifest());
    if (r.errors.length || !r.palette) {
        print('Install refused: lib/sprites.js not modified');
        return 1;
    }
    const text = render(r);
    if (text === currentSprites())
        print('lib/sprites.js already up to date');
    else {
        writeText(outPath, text);
        print(`lib/sprites.js written (${r.palette.size} colours, ${r.fps} fps)`);
    }
    return 0;
}

function cmdList() {
    const manifest = readManifest();
    const r = analyze(manifest);
    print(`Manifest: fps ${r.fps}, pixel ${r.pixel} px, maxHeight ${r.maxHeight} px (max ${r.maxRows} rows)`);
    print('Animations:');
    for (const name of r.names) {
        const a = r.anims[name], inf = r.info[name];
        const kind = a.loop ? `loop${a.seconds ? `, ${a.seconds} s` : ''}` : 'once';
        const rows = inf && inf.rowMax >= 0
            ? `rows ${inf.rowMin}..${inf.rowMax} (${inf.rowMax - inf.rowMin + 1})` : 'rows ?';
        print(`  ${name}: ${a.file}, ${inf ? inf.frames.length : '?'} frames, ${kind}, ${rows}`);
    }
    print('States:');
    for (const [s, v] of Object.entries(r.states))
        print(`  ${s}: ${Array.isArray(v) ? v.join(', ') : v}`);
    if (r.errors.length || !r.palette) {
        print('lib/sprites.js: cannot compare (the check fails, run `check`)');
    } else {
        const cur = currentSprites();
        print(cur === render(r)
            ? 'lib/sprites.js: in sync with the manifest and the sheets'
            : 'lib/sprites.js: NOT in sync (run `install`)');
    }
    return 0;
}

function cmdPreview(args) {
    const [name, frameArg] = args;
    if (!name)
        fail('usage: preview <name> [frame]');
    const r = analyze(readManifest());
    const inf = r.info[name];
    if (!inf)
        fail(`animation "${name}" does not exist or is unreadable`);
    let list = inf.frames.map((f, i) => i);
    if (frameArg !== undefined) {
        const n = Number(frameArg);
        if (!Number.isInteger(n) || n < 0 || n >= inf.frames.length)
            fail(`invalid frame (0..${inf.frames.length - 1})`);
        list = [n];
    }
    const bg = [40, 40, 48];
    for (const i of list) {
        print(`${name} frame ${i}/${inf.frames.length - 1}  (rows used ${inf.perFrame[i].min}..${inf.perFrame[i].max}` +
            `, limit ${r.maxRows} rows)`);
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
                fail(`${a} needs a value`);
            flags[a.slice(2)] = args[++i];
        } else if (a.startsWith('--')) {
            fail(`unknown option ${a}`);
        } else {
            pos.push(a);
        }
    }
    return {pos, flags};
}

function cmdAdd(args) {
    const {pos, flags} = parseFlags(args);
    if (pos.length !== 1 || !flags.name || !(flags.loop || flags.once) || (flags.loop && flags.once))
        fail('usage: add <png> --name <name> (--loop [--seconds N] | --once) [--frame-width N]');
    const manifest = readManifest();
    const name = flags.name;
    if (manifest.animations?.[name])
        fail(`animation "${name}" already exists`);
    if (flags.once && flags.seconds !== undefined)
        fail('--seconds is only valid with --loop');
    let src = pos[0];
    if (!GLib.file_test(src, GLib.FileTest.IS_REGULAR))
        src = GLib.build_filenamev([animDir, pos[0]]);
    if (!GLib.file_test(src, GLib.FileTest.IS_REGULAR))
        fail(`file "${pos[0]}" not found`);
    const file = GLib.path_get_basename(src);
    const dest = GLib.build_filenamev([animDir, file]);
    if (GLib.path_get_dirname(GLib.canonicalize_filename(src, null)) !== animDir) {
        if (GLib.file_test(dest, GLib.FileTest.EXISTS))
            fail(`${file} already exists in clawd-animation/`);
        Gio.File.new_for_path(src).copy(Gio.File.new_for_path(dest), Gio.FileCopyFlags.NONE, null, null);
        print(`Copied ${file} to clawd-animation/`);
    }
    const entry = {file, loop: !!flags.loop};
    if (flags.seconds !== undefined) {
        entry.seconds = Number(flags.seconds);
        if (!(entry.seconds > 0))
            fail('--seconds must be > 0');
    }
    if (flags['frame-width'] !== undefined) {
        entry.frameWidth = Number(flags['frame-width']);
        if (!Number.isInteger(entry.frameWidth) || entry.frameWidth <= 0)
            fail('invalid --frame-width');
    }
    manifest.animations[name] = entry;
    writeManifest(manifest);
    print(`Added "${name}" to the manifest. Checking:`);
    const code = cmdCheck();
    print('Per applicare: gjs -m tools/build-animations.js install');
    return code;
}

function cmdRemove(args) {
    const [name] = args;
    if (!name)
        fail('usage: remove <name>');
    const manifest = readManifest();
    if (!manifest.animations?.[name])
        fail(`animation "${name}" does not exist`);
    const users = Object.entries(manifest.states ?? {})
        .filter(([, v]) => (Array.isArray(v) ? v : [v]).includes(name)).map(([k]) => k);
    if (users.length)
        fail(`"${name}" is used by the states: ${users.join(', ')} (change them with set-state)`);
    const file = manifest.animations[name].file;
    delete manifest.animations[name];
    writeManifest(manifest);
    print(`Removed "${name}" from the manifest. The file ${file} was kept in clawd-animation/.`);
    print('Per applicare: gjs -m tools/build-animations.js install');
    return 0;
}

function cmdSetState(args) {
    const [state, value] = args;
    if (!STATE_NAMES.includes(state) || !value || args.length !== 2)
        fail('usage: set-state <sleep|start|work|done> <name[,name...]>');
    const manifest = readManifest();
    const list = value.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0)
        fail('no name given');
    if (state !== 'work' && list.length > 1)
        fail('only "work" accepts several animations');
    for (const n of list) {
        const a = manifest.animations?.[n];
        if (!a)
            fail(`animation "${n}" does not exist`);
        if (state === 'start' && a.loop !== false)
            fail(`"start" needs a non-looping animation ("${n}" loops)`);
        if (state !== 'start' && a.loop !== true)
            fail(`"${state}" needs a looping animation ("${n}" does not loop)`);
    }
    manifest.states ??= {};
    manifest.states[state] = state === 'work' ? list : list[0];
    writeManifest(manifest);
    print(`State "${state}" = ${list.join(', ')}`);
    print('Per applicare: gjs -m tools/build-animations.js install');
    return 0;
}

function usage() {
    print(`Usage: gjs -m tools/build-animations.js <command> [arguments]

  check                      validates everything, writes nothing (exit 1 on problems)
  install                    (default) validates and, only if everything is OK, writes lib/sprites.js
  list                       animations, states and whether lib/sprites.js is in sync
  preview <name> [frame]     shows the frames in the terminal (ANSI colours, frames from 0)
  add <png> --name <name> (--loop [--seconds N] | --once) [--frame-width N]
                             copies the PNG to clawd-animation/, adds the entry and checks
  remove <name>              removes the entry from the manifest (refused if a state uses it)
  set-state <state> <name[,name...]>
                             state: sleep|start|work|done (only work takes a list)
  help                       this text`);
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
        printerr(`Unknown command: ${cmd}\n`);
        usage();
        code = 1;
    }
    System.exit(code);
} catch (e) {
    printerr(`build-animations: ${e instanceof CliError ? e.message : e}`);
    System.exit(1);
}
