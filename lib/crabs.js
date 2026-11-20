// Claude crabs: sprite compilation and per-session state machine (no drawing here).
// Pure module: testable with plain gjs. Sprites live in sprites.js (generated); the
// indicator paints the layers of frames() on a St.DrawingArea.

import {ANIMATIONS, PALETTE, STATES, FPS, GRID_W, GRID_H, SPRITE_HEIGHT} from './sprites.js';

export {FPS};
export const PIXEL = 2;                       // logical px per sprite pixel
export const SPRITE_W = GRID_W * PIXEL;
export const SPRITE_H = SPRITE_HEIGHT;       // = GRID_H * PIXEL
export const CRAB_GAP = 2;
export const CRAB_SLOT = SPRITE_W + CRAB_GAP;


// Top-bar geometry (shared by indicator.js and prefs.js; pure numbers, no shell imports).
export const RING_SIZE = 16;
export const PANEL_SPACING = 4;               // must match .claude-meter-panel spacing
export const HIGHLIGHT_PAD = 3;               // horizontal padding of the rings/icon highlight (CSS)
export const MORE_WIDTH = 20;                 // "+N" label, fixed so the layout maths is exact

/** Split sessions into shown crabs (oldest first, at most `max`) and the hidden count. */
export function splitSessions(sessions, max, enabled = true) {
    const list = enabled && Array.isArray(sessions) && max > 0 ? sessions : [];
    const shown = list.slice(0, Math.max(0, max));
    return {shown, hidden: (Array.isArray(sessions) && enabled ? sessions.length : 0) - shown.length};
}

/**
 * Widths of the top-bar content, in px.
 * @param {{crabs?: number, more?: number|boolean, rings?: number}} parts crab count,
 *   whether the "+N" label is shown, number of rings
 * @returns {{crabs: number, total: number}} total = content width (rings include the
 *   highlight padding; excludes the button's own 3 px + 3 px border and the hidden icon)
 */
export function panelWidths({crabs = 0, more = 0, rings = 0} = {}) {
    const crabsWidth = crabs > 0 ? crabs * CRAB_SLOT - CRAB_GAP : 0;
    const ringsWidth = rings > 0 ? rings * RING_SIZE + (rings - 1) * PANEL_SPACING + 2 * HIGHLIGHT_PAD : 0;
    const parts = [crabsWidth, more ? MORE_WIDTH : 0, ringsWidth].filter(w => w > 0);
    const total = parts.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * PANEL_SPACING;
    return {crabs: crabsWidth, total};
}

export const PLACEHOLDER_ID = '__placeholder__';
const EMPTY = '.';

function normalizeStates(states) {
    const work = Array.isArray(states.work) ? states.work : [states.work];
    return {sleep: states.sleep, start: states.start, work, done: states.done};
}

/**
 * Compile hand-written animations into per-colour pixel layers.
 * Throws on malformed data (missing state animation, empty frames, inconsistent
 * grid, unknown character).
 * @returns {{width, height, animations: Object<string, {loop, seconds, frames}>}}
 *   frame = {layers: [{rgba: [r,g,b,a] 0..1, pixels: [[col,row],...]}]}
 */
export function compileAnimations(source, palette, states) {
    const st = normalizeStates(states);
    const needed = [st.sleep, st.start, st.done, ...st.work];
    for (const name of needed) {
        if (!name || !source[name])
            throw new Error(`sprites: animazione '${name}' mancante`);
    }
    let width = null;
    let height = null;
    const animations = {};
    for (const [name, anim] of Object.entries(source)) {
        if (!Array.isArray(anim.frames) || anim.frames.length === 0)
            throw new Error(`sprites: '${name}' non ha frame`);
        const frames = anim.frames.map((rows, f) => {
            if (height === null) {
                height = rows.length;
                width = rows[0]?.length ?? 0;
            }
            if (rows.length !== height)
                throw new Error(`sprites: '${name}' frame ${f}: ${rows.length} righe invece di ${height}`);
            const byChar = new Map();
            rows.forEach((row, r) => {
                if (row.length !== width)
                    throw new Error(`sprites: '${name}' frame ${f} riga ${r}: ${row.length} colonne invece di ${width}`);
                for (let c = 0; c < row.length; c++) {
                    const ch = row[c];
                    if (ch === EMPTY)
                        continue;
                    if (!palette[ch])
                        throw new Error(`sprites: carattere sconosciuto '${ch}' in '${name}' frame ${f} riga ${r}`);
                    if (!byChar.has(ch))
                        byChar.set(ch, []);
                    byChar.get(ch).push([c, r]);
                }
            });
            const layers = [...byChar].map(([ch, pixels]) => {
                const [r, g, b, a] = palette[ch];
                return {rgba: [r / 255, g / 255, b / 255, a / 255], pixels};
            });
            return {layers};
        });
        animations[name] = {loop: Boolean(anim.loop), seconds: anim.seconds ?? null, frames};
    }
    return {width, height, animations};
}

const COMPILED = compileAnimations(ANIMATIONS, PALETTE, STATES);
export const COMPILED_ANIMATIONS = COMPILED.animations;
export const COMPILED_GRID = {width: COMPILED.width, height: COMPILED.height};

function doneTicks(anim) {
    const seconds = anim.seconds ?? anim.frames.length / FPS;
    return Math.max(1, Math.round(seconds * FPS));
}

/** Row of crabs, one per session, in fixed slots (oldest on the left). */
export class CrabRow {
    constructor(rand = Math.random, animations = COMPILED_ANIMATIONS, states = STATES) {
        this._rand = rand;
        this._anims = animations;
        this._states = normalizeStates(states);
        this._crabs = [];
    }

    static widthFor(count) {
        return count > 0 ? count * CRAB_SLOT - CRAB_GAP : 0;
    }

    static capacity(width) {
        return width >= SPRITE_W ? Math.floor((width + CRAB_GAP) / CRAB_SLOT) : 0;
    }

    get size() {
        return this._crabs.length;
    }

    get animating() {
        return this._crabs.some(c => c.state === 'start' || c.state === 'done' ||
            this._animOf(c).frames.length > 1);
    }

    _animOf(crab) {
        const name = crab.state === 'work' ? crab.workName : this._states[crab.state];
        return this._anims[name];
    }

    _frameOf(crab) {
        const {frames} = this._animOf(crab);
        return frames[crab.tick % frames.length];
    }

    _enter(crab, state) {
        crab.state = state;
        crab.tick = 0;
    }

    /** React to the busy flag in looping states. */
    _react(crab) {
        if (crab.state === 'sleep' && crab.busy)
            this._enter(crab, 'start');
        else if (crab.state === 'work' && !crab.busy)
            this._enter(crab, 'done');
    }

    _newCrab(id, busy) {
        const w = this._states.work;
        const idx = Math.min(w.length - 1, Math.floor(this._rand() * w.length));
        return {id, busy, state: busy ? 'work' : 'sleep', tick: 0, workName: w[idx]};
    }

    /**
     * @param {Array<{id: string, busy: boolean}>} sessions in display order
     * @param {{placeholder?: boolean}} opts with no sessions, keep one sleeping crab (PLACEHOLDER_ID)
     */
    sync(sessions, {placeholder = false} = {}) {
        if (sessions.length === 0) {
            if (!placeholder) {
                this._crabs = [];
                return;
            }
            // Release: reuse the slot-0 crab so a running animation completes (work -> done -> sleep).
            const crab = this._crabs[0] ?? this._newCrab(PLACEHOLDER_ID, false);
            crab.id = PLACEHOLDER_ID;
            crab.busy = false;
            this._react(crab);
            this._crabs = [crab];
            return;
        }
        const old = new Map(this._crabs.map(c => [c.id, c]));
        // Adoption: the placeholder crab becomes the first session not already present.
        let spare = old.get(PLACEHOLDER_ID) ?? null;
        old.delete(PLACEHOLDER_ID);
        this._crabs = sessions.map(s => {
            let crab = old.get(s.id);
            if (!crab && spare) {
                crab = spare;
                crab.id = s.id;
                spare = null;
            } else if (!crab) {
                crab = this._newCrab(s.id, Boolean(s.busy));
            }
            crab.busy = Boolean(s.busy);
            this._react(crab);
            return crab;
        });
    }

    /** Advance one tick (1/FPS s). @returns {boolean} true if any visible frame changed */
    step() {
        let changed = false;
        for (const crab of this._crabs) {
            const before = this._frameOf(crab);
            this._advance(crab);
            if (this._frameOf(crab) !== before)
                changed = true;
        }
        return changed;
    }

    _advance(crab) {
        this._react(crab);
        switch (crab.state) {
        case 'start':
            crab.tick++;
            if (crab.tick >= this._animOf(crab).frames.length)
                this._enter(crab, crab.busy ? 'work' : 'done');
            break;
        case 'done':
            crab.tick++;
            if (crab.tick >= doneTicks(this._animOf(crab)))
                this._enter(crab, crab.busy ? 'start' : 'sleep');
            break;
        default:
            if (crab.state === 'sleep' || crab.state === 'work')
                crab.tick++;
        }
    }

    /** @returns {Array<{id, x, state, animation, sprite}>} x in px */
    frames() {
        return this._crabs.map((crab, i) => ({
            id: crab.id,
            x: i * CRAB_SLOT,
            state: crab.state,
            animation: crab.state === 'work' ? crab.workName : this._states[crab.state],
            sprite: this._frameOf(crab),
        }));
    }
}
