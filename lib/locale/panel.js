// Translations for the 'panel.*' keys. Both languages must have the same keys and
// placeholders ({name}); plural entries are objects {one, other} (used with tn()).
export default {
    it: {
        'panel.menu.title': 'Utilizzo di Claude',
        'panel.menu.preferences': 'Preferenze',
        'panel.nav.details': 'Dettagli',
        'panel.nav.back': 'Indietro',
        'panel.plan.fiveHour': 'Sessione (5 h)',
        'panel.plan.sevenDay': 'Settimanale',
        'panel.plan.reset': 'Reset {countdown}',
        'panel.plan.resetDone': 'Reset avvenuto',
        'panel.plan.resetUnknown': 'Reset non disponibile',
        'panel.age.updated': 'aggiornato {age}',
        'panel.age.updatedAt': 'aggiornato alle {time}',
        'panel.age.retryAt': 'nuovo tentativo alle {time}',
        'panel.tokens.title': 'Token Claude Code · oggi',
        'panel.tokens.input': 'Input',
        'panel.tokens.output': 'Output',
        'panel.chart.title': 'Ultimi 7 giorni',
        'panel.chart.total': '{amount} token',
        'panel.notify.title': 'Animazioni troppo alte per il pannello',
        'panel.notify.body': 'Le animazioni ({sprite} px) sono più alte dello spazio disponibile ' +
            '({height} px). In Preferenze → "Animazioni troppo alte" puoi scegliere ' +
            'se farle sbordare o tagliarle in alto.',
        'panel.notify.action': 'Apri preferenze',
    },
    en: {
        'panel.menu.title': 'Claude usage',
        'panel.menu.preferences': 'Preferences',
        'panel.nav.details': 'Details',
        'panel.nav.back': 'Back',
        'panel.plan.fiveHour': 'Session (5 h)',
        'panel.plan.sevenDay': 'Weekly',
        'panel.plan.reset': 'Resets {countdown}',
        'panel.plan.resetDone': 'Reset done',
        'panel.plan.resetUnknown': 'Reset unavailable',
        'panel.age.updated': 'updated {age}',
        'panel.age.updatedAt': 'updated at {time}',
        'panel.age.retryAt': 'retrying at {time}',
        'panel.tokens.title': 'Claude Code tokens · today',
        'panel.tokens.input': 'Input',
        'panel.tokens.output': 'Output',
        'panel.chart.title': 'Last 7 days',
        'panel.chart.total': '{amount} tokens',
        'panel.notify.title': 'Animations too tall for the panel',
        'panel.notify.body': 'The animations ({sprite} px) are taller than the available space ' +
            '({height} px). In Preferences → "Animations too tall" you can choose ' +
            'whether to let them overflow or crop the top.',
        'panel.notify.action': 'Open preferences',
    },
};
