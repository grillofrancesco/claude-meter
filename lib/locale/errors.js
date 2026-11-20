// Translations for the 'errors.*' keys. Both languages must have the same keys and
// placeholders ({name}); plural entries are objects {one, other} (used with tn()).
export default {
    it: {
        'errors.plan.no-credentials': 'Credenziali Claude Code non trovate',
        'errors.plan.expired': 'Credenziali scadute: apri Claude Code per rinnovarle',
        'errors.plan.unauthorized': 'Accesso negato da Anthropic',
        'errors.plan.rate-limited': 'Troppe richieste ad Anthropic',
        'errors.plan.network': 'Anthropic non raggiungibile',
        'errors.plan.invalid-response': 'Risposta non valida da Anthropic',
        'errors.tokens.unreadable': 'Sessioni Claude Code non leggibili',
    },
    en: {
        'errors.plan.no-credentials': 'Claude Code credentials not found',
        'errors.plan.expired': 'Credentials expired: open Claude Code to renew them',
        'errors.plan.unauthorized': 'Access denied by Anthropic',
        'errors.plan.rate-limited': 'Too many requests to Anthropic',
        'errors.plan.network': 'Anthropic unreachable',
        'errors.plan.invalid-response': 'Invalid response from Anthropic',
        'errors.tokens.unreadable': 'Claude Code sessions unreadable',
    },
};
