import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {DataManager, localDateKey} from '../lib/dataManager.js';

let total = 0;
let failures = 0;

function check(name, condition, detail = null) {
    total++;
    if (condition) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}${detail === null ? '' : ` — ${detail}`}`);
    }
}

function localNoonMs(daysAgo) {
    const today = GLib.DateTime.new_now_local();
    const day = today.add_days(-daysAgo);
    return GLib.DateTime.new_local(
        day.get_year(), day.get_month(), day.get_day_of_month(),
        12, 0, 0).to_unix() * 1000;
}

function dateKeyDaysAgo(daysAgo) {
    return GLib.DateTime.new_now_local().add_days(-daysAgo).format('%Y-%m-%d');
}

function writeRaw(path, text) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(
        new TextEncoder('utf-8').encode(text),
        null,
        false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null);
}

function fileMode(path) {
    const info = Gio.File.new_for_path(path).query_info(
        'unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    return info.get_attribute_uint32('unix::mode') & 0o777;
}

function removeTree(path) {
    const file = Gio.File.new_for_path(path);
    try {
        const children = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null);
        let info = null;
        while ((info = children.next_file(null)) !== null) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                removeTree(child.get_path());
            else
                child.delete(null);
        }
        children.close(null);
        file.delete(null);
    } catch (e) {
        print(`nota: pulizia della directory temporanea fallita: ${e.message}`);
    }
}

async function run() {
    const tmpDir = GLib.dir_make_tmp('claude-meter-test-XXXXXX');
    if (!tmpDir)
        throw new Error('impossibile creare la directory temporanea');
    const statePath = GLib.build_filenamev([tmpDir, 'nested', 'state.json']);

    try {
        // --- load su file assente -------------------------------------------
        const dm = new DataManager(statePath);
        await dm.load();

        const today0 = dm.getToday();
        check('load su file assente: oggi a zero',
            today0.input === 0 && today0.output === 0 && today0.total === 0,
            JSON.stringify(today0));

        const hist0 = dm.getHistory();
        check('getHistory: 30 voci', hist0.length === 30, hist0.length);
        check('getHistory: la prima voce è oggi',
            hist0[0].date === localDateKey(Date.now()), hist0[0].date);
        check('getHistory: la 30ª voce è oggi-29',
            hist0[29].date === dateKeyDaysAgo(29), hist0[29].date);
        check('getHistory: giorni azzerati',
            hist0.every(e => e.input === 0 && e.output === 0 && e.total === 0));
        check('stato fresco: files/seen vuoti',
            Object.keys(dm.parserState.files).length === 0 &&
            Object.keys(dm.parserState.seen).length === 0);

        // --- addRecords: aggregazione per giorno locale --------------------
        dm.addRecords([
            {key: 'a:1', timestamp: localNoonMs(0), sessionId: null,
                input: 100, output: 50, cacheCreation: 999, cacheRead: 888},
            {key: 'b:2', timestamp: localNoonMs(0), sessionId: null,
                input: 20, output: 5, cacheCreation: 0, cacheRead: 0},
            {key: 'c:3', timestamp: localNoonMs(1), sessionId: 'sess',
                input: 7, output: 3, cacheCreation: 1234, cacheRead: 5678},
            {key: 'bad', timestamp: Number.NaN, input: 1000, output: 1000},
            {key: 'bad2', timestamp: 'ieri', input: 1000, output: 1000},
            null,
        ]);

        const today1 = dm.getToday();
        check('addRecords: somma input di oggi', today1.input === 120, today1.input);
        check('addRecords: somma output di oggi', today1.output === 55, today1.output);
        check('addRecords: cache ignorata (total)',
            today1.total === 175, today1.total);
        check('addRecords: timestamp non finiti ignorati',
            today1.input === 120 && today1.output === 55);

        const hist1 = dm.getHistory();
        check('addRecords: ieri aggregato correttamente',
            hist1[1].date === dateKeyDaysAgo(1) &&
            hist1[1].input === 7 && hist1[1].output === 3 && hist1[1].total === 10,
            JSON.stringify(hist1[1]));
        check('getHistory: giorno vuoto azzerato', hist1[2].total === 0);

        // --- parserState mutato in place -----------------------------------
        const parserState = dm.parserState;
        parserState.files['/tmp/fixture.jsonl'] = {offset: 42, size: 4200};
        parserState.seen['msg:req'] = dateKeyDaysAgo(0);
        await dm.save();

        // --- prune ----------------------------------------------------------
        dm.addRecords([
            {key: 'old40', timestamp: localNoonMs(40), input: 1, output: 2},
            {key: 'edge29', timestamp: localNoonMs(29), input: 1, output: 0},
            {key: 'edge30', timestamp: localNoonMs(30), input: 1, output: 0},
        ]);
        parserState.seen['old-40'] = dateKeyDaysAgo(40);
        parserState.seen['edge-29'] = dateKeyDaysAgo(29);
        parserState.seen['edge-30'] = dateKeyDaysAgo(30);

        check('prima di prune il giorno di 40 giorni fa ha dati',
            dm.getHistory(45).find(e => e.date === dateKeyDaysAgo(40)).total === 3);
        check('prima di prune seen contiene la chiave vecchia',
            dm.parserState.seen['old-40'] === dateKeyDaysAgo(40));

        dm.prune();

        check('prune: giorno di 40 giorni fa rimosso',
            dm.getHistory(45).find(e => e.date === dateKeyDaysAgo(40)).total === 0);
        check('prune: conserva oggi-29',
            dm.getHistory(31)[29].total === 1, dm.getHistory(31)[29].total);
        check('prune: scarta oggi-30',
            dm.getHistory(31)[30].total === 0, dm.getHistory(31)[30].total);
        check('prune: seen vecchio rimosso',
            dm.parserState.seen['old-40'] === undefined);
        check('prune: seen di oggi-29 conservato',
            dm.parserState.seen['edge-29'] === dateKeyDaysAgo(29));
        check('prune: seen di oggi-30 rimosso',
            dm.parserState.seen['edge-30'] === undefined);
        check('prune: seen recente conservato',
            dm.parserState.seen['msg:req'] === dateKeyDaysAgo(0));

        // --- save -> load roundtrip ----------------------------------------
        await dm.save();
        const dm2 = new DataManager(statePath);
        await dm2.load();

        check('roundtrip: giorni di oggi',
            dm2.getToday().input === 120 && dm2.getToday().output === 55,
            JSON.stringify(dm2.getToday()));
        check('roundtrip: storico identico',
            JSON.stringify(dm2.getHistory()) === JSON.stringify(dm.getHistory()));
        check('roundtrip: files conservati',
            dm2.parserState.files['/tmp/fixture.jsonl']?.offset === 42 &&
            dm2.parserState.files['/tmp/fixture.jsonl']?.size === 4200,
            JSON.stringify(dm2.parserState.files));
        check('roundtrip: seen conservato',
            dm2.parserState.seen['msg:req'] === dateKeyDaysAgo(0));

        // mutazione del parserState sul secondo esemplare -> nuovo save
        dm2.parserState.files['/tmp/altro.jsonl'] = {offset: 7, size: 70};
        dm2.parserState.seen['altro:req'] = dateKeyDaysAgo(0);
        await dm2.save();

        const dm3 = new DataManager(statePath);
        await dm3.load();
        check('parserState: mutazione post-load persistita',
            dm3.parserState.files['/tmp/altro.jsonl']?.offset === 7 &&
            dm3.parserState.seen['altro:req'] === dateKeyDaysAgo(0));
        check('parserState: vecchie chiavi ancora presenti',
            dm3.parserState.files['/tmp/fixture.jsonl']?.offset === 42);

        // --- permessi del file ---------------------------------------------
        check('save: permessi 0600', fileMode(statePath) === 0o600,
            (fileMode(statePath)).toString(8));

        // --- save concorrenti ----------------------------------------------
        const concPath = GLib.build_filenamev([tmpDir, 'concurrent', 'state.json']);
        const dmConc = new DataManager(concPath);
        dmConc.addRecords([{key: 'x:1', timestamp: localNoonMs(0), input: 1, output: 2}]);
        await Promise.all([dmConc.save(), dmConc.save(), dmConc.save()]);
        const dmConc2 = new DataManager(concPath);
        await dmConc2.load();
        check('save concorrenti: file valido e stato corretto',
            dmConc2.getToday().total === 3, dmConc2.getToday().total);

        // --- file corrotto --------------------------------------------------
        writeRaw(statePath, '{non json');
        const dmCorrupt = new DataManager(statePath);
        await dmCorrupt.load();
        check('JSON corrotto: stato fresco',
            dmCorrupt.getToday().total === 0 &&
            Object.keys(dmCorrupt.parserState.files).length === 0 &&
            Object.keys(dmCorrupt.parserState.seen).length === 0);

        dmCorrupt.addRecords([{key: 'y:1', timestamp: localNoonMs(0), input: 5, output: 5}]);
        await dmCorrupt.save();
        const dmCorrupt2 = new DataManager(statePath);
        await dmCorrupt2.load();
        check('JSON corrotto: recupero e nuovo save funzionano',
            dmCorrupt2.getToday().total === 10);

        // --- versione errata -----------------------------------------------
        writeRaw(statePath, JSON.stringify({
            version: 2,
            files: {'/tmp/x': {offset: 1, size: 1}},
            seen: {'k': dateKeyDaysAgo(0)},
            days: {[dateKeyDaysAgo(0)]: {input: 1, output: 1}},
        }));
        const dmV2 = new DataManager(statePath);
        await dmV2.load();
        check('versione errata: stato fresco',
            Object.keys(dmV2.parserState.files).length === 0 &&
            dmV2.getToday().total === 0);

        // --- forme invalide -------------------------------------------------
        writeRaw(statePath, JSON.stringify({
            version: 1,
            files: 'non un oggetto',
            seen: ['no'],
            days: {'2026-01-01': 'bad', 'non-una-data': {input: 1, output: 1}},
        }));
        const dmBad = new DataManager(statePath);
        await dmBad.load();
        check('forme invalide: files/seen azzerati',
            typeof dmBad.parserState.files === 'object' &&
            Object.keys(dmBad.parserState.files).length === 0 &&
            Object.keys(dmBad.parserState.seen).length === 0);
        check('forme invalide: days scartati',
            dmBad.getHistory().every(e => e.total === 0));
    } finally {
        removeTree(tmpDir);
    }
}

const loop = GLib.MainLoop.new(null, false);
run()
    .catch(e => {
        failures++;
        print(`FAIL eccezione non gestita: ${e.message}\n${e.stack}`);
    })
    .then(() => {
        print(`\n${total - failures}/${total} test superati`);
        loop.quit();
    });

loop.run();
System.exit(failures > 0 ? 1 : 0);
