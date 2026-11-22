// Today's tokens section of the details page.

import St from 'gi://St';

import {formatTokens} from '../format.js';
import {createSection, createHeaderLabel, createValueRow, createErrorLabel} from './menu.js';
import {setStale} from './planSection.js';
import {t} from '../i18n.js';

export class TokensSection {
    constructor(pages) {
        this._pages = pages;
        this._tokens = null;
        this._tokensError = null;

        const tokens = createSection();
        this.item = tokens.item;
        this._tokensBox = tokens.box;

        this._tokensHeader = createHeaderLabel(t('panel.tokens.title'));
        this._tokensBox.add_child(this._tokensHeader);

        this._inputRow = createValueRow(t('panel.tokens.input'));
        this._tokensBox.add_child(this._inputRow.row);

        this._outputRow = createValueRow(t('panel.tokens.output'));
        this._tokensBox.add_child(this._outputRow.row);

        this._tokensErrorLabel = createErrorLabel();
        this._tokensBox.add_child(this._tokensErrorLabel);
    }

    setTokens(today, error) {
        if (today)
            this._tokens = today;
        this._tokensError = error ? String(error) : null;
        this.render();
    }

    render() {
        const tokens = this._tokens;
        const error = this._tokensError;

        this._inputRow.value.text = formatTokens(tokens ? tokens.input : null);
        this._outputRow.value.text = formatTokens(tokens ? tokens.output : null);

        const stale = Boolean(error && tokens);
        setStale(this._inputRow.row, stale);
        setStale(this._outputRow.row, stale);

        this._tokensErrorLabel.text = error ?? '';
        this._tokensErrorLabel.visible = Boolean(error);
        this._pages.equalize();
    }

    /** Language changed: re-set the static labels (the caller re-renders). */
    relabel() {
        this._tokensHeader.text = t('panel.tokens.title');
        this._inputRow.label.text = t('panel.tokens.input');
        this._outputRow.label.text = t('panel.tokens.output');
    }

    destroy() {
        this._tokens = null;
    }
}
