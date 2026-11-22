// Translations for the 'errors.*' keys. Both languages must have the same keys and
// placeholders ({name}); plural entries are objects {one, other} (used with tn()).
export default {
    it: {
        'errors.plan.no-credentials': 'Credenziali Claude Code non trovate',
        'errors.plan.expired': 'Dati non aggiornati: apri Claude Code per aggiornarli',
        'errors.plan.unauthorized': 'Dati non aggiornati: apri Claude Code per aggiornarli',
        'errors.plan.rate-limited': 'Troppe richieste ad Anthropic',
        'errors.plan.network': 'Anthropic non raggiungibile',
        'errors.plan.invalid-response': 'Risposta non valida da Anthropic',
        'errors.tokens.unreadable': 'Sessioni Claude Code non leggibili',
    },
    en: {
        'errors.plan.no-credentials': 'Claude Code credentials not found',
        'errors.plan.expired': 'Data out of date: open Claude Code to refresh it',
        'errors.plan.unauthorized': 'Data out of date: open Claude Code to refresh it',
        'errors.plan.rate-limited': 'Too many requests to Anthropic',
        'errors.plan.network': 'Anthropic unreachable',
        'errors.plan.invalid-response': 'Invalid response from Anthropic',
        'errors.tokens.unreadable': 'Claude Code sessions unreadable',
    },
};
