Claude Usage GNOME
Piano progettuale e specifiche tecniche

Piattaforma: Fedora 44
Desktop environment: GNOME Shell
Tipologia: GNOME Shell Extension
Account target: Anthropic Claude Pro
Stato: Specifica progettuale

1. Obiettivo del progetto

Realizzare un'estensione nativa per GNOME Shell che consenta di monitorare rapidamente l'utilizzo di Claude direttamente dalla barra superiore del desktop Fedora 44.

L'estensione deve consentire di visualizzare:

Il numero di token di input utilizzati tramite Claude Code.
Il numero di token di output utilizzati tramite Claude Code.
La percentuale di utilizzo della finestra di 5 ore del piano Claude Pro.
La percentuale di utilizzo del limite settimanale del piano Claude Pro.
Lo storico dei consumi degli ultimi 30 giorni.

L'obiettivo principale è fornire un sistema di monitoraggio discreto, leggero e sempre accessibile, senza dover aprire il sito di Claude o applicazioni esterne.

L'estensione deve integrarsi perfettamente nell'ambiente GNOME, rispettandone le convenzioni grafiche e comportamentali.

2. Filosofia del progetto

Il progetto deve seguire tre principi fondamentali:

Minimalismo

L'interfaccia deve mostrare soltanto le informazioni realmente utili.

Niente dashboard elaborate, card decorative, animazioni superflue o elementi grafici ingombranti.

Integrazione nativa

L'estensione deve sembrare una funzionalità originale di GNOME, non un'applicazione esterna inserita artificialmente nel desktop.

Efficienza

Il consumo di risorse deve essere minimo.

L'estensione non deve mantenere processi pesanti in esecuzione, effettuare richieste continue o rallentare GNOME Shell.

3. Tecnologia da utilizzare
3.1 GNOME Shell Extension

La componente principale sarà sviluppata come GNOME Shell Extension.

La tecnologia di riferimento è GJS (GNOME JavaScript), che permette di interagire direttamente con le API di GNOME Shell.

Non utilizzare Electron, Chromium o framework web per costruire l'interfaccia.

3.2 Tecnologie principali
Tecnologia	Responsabilità
GJS	Logica principale dell'estensione
GNOME Shell API	Integrazione nella barra superiore
St (Shell Toolkit)	Creazione di menu e componenti grafici
CSS	Personalizzazione dell'interfaccia
Gio / GLib	Gestione file, processi e operazioni asincrone
JSON	Scambio e memorizzazione dei dati
JSONL	Lettura delle statistiche di Claude Code

Non è necessario introdurre GTK o Libadwaita nella prima versione, poiché non è prevista una dashboard separata.

3.3 Compatibilità

L'estensione deve essere sviluppata e testata prioritariamente su:

Fedora 44.
GNOME Shell della versione inclusa in Fedora 44.
Wayland.

La compatibilità con X11 può essere verificata successivamente.

Occorre dichiarare correttamente le versioni GNOME supportate nei metadati dell'estensione.

4. Design e interfaccia grafica
4.1 Direzione estetica

Lo stile deve essere estremamente minimal.

L'interfaccia deve seguire il design nativo di GNOME, utilizzando:

Spaziature contenute.
Tipografia di sistema.
Colori sobri.
Indicatori di progresso semplici.
Nessuna decorazione non necessaria.
Nessuna ombra o effetto visivo eccessivo.

L'estensione deve adattarsi automaticamente al tema chiaro o scuro di GNOME.

Non deve imporre una propria palette cromatica all'intero desktop.

4.2 Indicatore nella barra superiore

Nella barra superiore di GNOME deve essere presente esclusivamente una piccola icona Claude.

L'icona deve essere discreta e non occupare spazio eccessivo.

Non mostrare percentuali, contatori o testo nella barra superiore.

Cliccando sull'icona deve essere aperto il menu dell'estensione.

4.3 Menu principale

Il menu deve essere compatto e contenere tutte le informazioni principali.

Sezioni previste:

Utilizzo del piano Claude Pro

Percentuale della finestra di 5 ore.
Barra di progresso della finestra di 5 ore.
Tempo rimanente prima del reset.
Percentuale del limite settimanale.
Barra di progresso settimanale.
Tempo rimanente prima del reset settimanale.

Token utilizzati

Input tokens.
Output tokens.

I valori devono essere presentati in formato leggibile, utilizzando abbreviazioni come K e M quando necessario.

Aggiornamento

Indicazione dell'ultimo aggiornamento.
Possibilità di aggiornare manualmente i dati con un pulsante di refresh.

Non introdurre grafici complessi nel menu principale.

4.4 Colori

Le barre di progresso devono utilizzare colori discreti.

Indicativamente:

Verde per utilizzo normale.
Giallo per utilizzo elevato.
Rosso per utilizzo prossimo al limite.

Le percentuali devono rimanere leggibili sia nel tema chiaro sia in quello scuro.

5. Raccolta dei dati

Il sistema deve utilizzare due fonti indipendenti.

5.1 Token Claude Code

I dati devono essere recuperati dai file di sessione locali generati da Claude Code.

Percorso principale:

~/.claude/projects/

I file JSONL contengono informazioni sulle richieste e sulle risposte dei modelli.

Il sistema deve individuare i campi relativi a:

Input tokens.
Output tokens.

I dati devono essere aggregati per sessione e per data.

È importante evitare di conteggiare due volte gli stessi record durante le successive scansioni.

Il sistema deve distinguere i token di input e output dai token relativi alla cache.

I token di cache non devono essere sommati automaticamente agli input tokens, perché potrebbero produrre conteggi doppi o statistiche fuorvianti.

5.2 Utilizzo del piano Claude Pro

Le percentuali di utilizzo del piano devono essere recuperate separatamente.

Il sistema deve individuare un metodo compatibile con l'autenticazione dell'account Claude Pro e con i dati di utilizzo messi a disposizione da Anthropic.

Le informazioni richieste sono:

Percentuale di utilizzo della finestra di 5 ore.
Percentuale di utilizzo settimanale.
Tempo residuo prima del reset.
Eventuali informazioni sullo stato dei limiti.

Gli endpoint non ufficiali devono essere isolati in un componente indipendente, così da poterli aggiornare senza modificare l'interfaccia.

Non devono essere inventate percentuali sulla base dei token registrati localmente.

Il consumo del piano Claude Pro non corrisponde necessariamente alla somma dei token di input e output.

5.3 Distinzione tra le due metriche

È fondamentale mantenere separate le seguenti informazioni:

Token Claude Code

Rappresentano i token effettivamente registrati nelle sessioni locali di Claude Code.

Utilizzo del piano Claude Pro

Rappresenta la percentuale di consumo dei limiti stabiliti da Anthropic.

Le due metriche hanno finalità diverse e non devono essere confuse.

La percentuale del piano può includere anche utilizzi provenienti da altre superfici Claude, mentre il conteggio locale dei token riguarda esclusivamente Claude Code.

6. Storico dei consumi

Il progetto deve conservare uno storico degli ultimi 30 giorni.

Le informazioni da registrare sono:

Data.
Input tokens giornalieri.
Output tokens giornalieri.
Totale dei token giornalieri.

Lo storico deve essere aggiornato automaticamente.

I dati devono essere aggregati senza dover rileggere continuamente tutti i file storici di Claude Code.

Il sistema deve evitare duplicazioni e gestire correttamente le sessioni ancora attive.

Non è prevista una dashboard separata: lo storico deve essere accessibile attraverso il menu dell'estensione, eventualmente in una sezione secondaria compatta.

7. Aggiornamento automatico

La frequenza di aggiornamento predefinita deve essere di 60 secondi.

Il sistema deve aggiornare:

Percentuali del piano Claude Pro.
Informazioni sui reset.
Token registrati nelle sessioni Claude Code.
Storico giornaliero.

Le operazioni di lettura e aggiornamento devono essere asincrone e non devono bloccare GNOME Shell.

È necessario evitare scansioni complete e ripetute di tutti i file JSONL.

L'aggiornamento manuale deve essere sempre disponibile.

8. Privacy e sicurezza

La privacy è un requisito fondamentale.

Tutti i dati devono essere gestiti localmente.

Non devono essere utilizzati servizi cloud di terze parti.

L'unica comunicazione esterna consentita è quella strettamente necessaria per recuperare i dati di utilizzo da Anthropic.

Requisiti:

Non trasmettere le conversazioni Claude Code.
Non trasmettere prompt o risposte.
Non trasmettere i file JSONL.
Non salvare token OAuth in chiaro in file aggiuntivi.
Utilizzare le credenziali locali già disponibili, quando possibile.
Non richiedere nuovamente le credenziali se esiste già un'autenticazione valida.
Non registrare credenziali o dati sensibili nei log.

L'estensione deve richiedere soltanto i permessi necessari.

9. Architettura software

Il progetto deve essere organizzato in componenti indipendenti.

Interfaccia GNOME

Responsabile di:

Indicatore nella barra superiore.
Menu a comparsa.
Barre di progresso.
Visualizzazione delle statistiche.
Aggiornamento grafico dei dati.

Token Parser

Responsabile di:

Lettura dei file JSONL.
Estrazione dei token di input.
Estrazione dei token di output.
Aggregazione dei dati.
Individuazione dei nuovi record.

Usage Manager

Responsabile di:

Recupero delle percentuali del piano.
Gestione delle finestre temporali.
Calcolo dei tempi di reset.
Gestione degli errori di comunicazione.

Data Manager

Responsabile di:

Conservazione dello storico.
Aggregazione giornaliera.
Eliminazione dei dati più vecchi di 30 giorni.
Prevenzione delle duplicazioni.

Settings Manager

Responsabile di eventuali preferenze dell'estensione, tra cui:

Frequenza di aggiornamento.
Comportamento dell'indicatore.
Gestione delle impostazioni locali.
10. Gestione degli errori

L'estensione deve continuare a funzionare anche quando una fonte di dati non è disponibile.

Esempi:

Anthropic non raggiungibile.
Credenziali scadute.
File JSONL non accessibili.
Nessuna sessione Claude Code disponibile.
Dati incompleti.
Risposta API non valida.

In questi casi:

Non bloccare GNOME Shell.
Non mostrare valori inventati.
Conservare l'ultimo dato valido disponibile.
Indicare chiaramente quando i dati non sono aggiornati.
Consentire un nuovo tentativo di aggiornamento.

L'indisponibilità dei dati del piano non deve impedire la visualizzazione dei token locali e viceversa.

11. Fasi di sviluppo
Fase 1 — Struttura iniziale
Creazione del progetto GNOME Shell Extension.
Configurazione dei metadati.
Verifica dell'installazione su Fedora 44.
Creazione dell'indicatore nella barra superiore.
Verifica del funzionamento su Wayland.
Fase 2 — Interfaccia
Creazione del menu a comparsa.
Inserimento delle sezioni relative al piano.
Inserimento delle statistiche dei token.
Implementazione delle barre di progresso.
Adattamento automatico al tema GNOME.
Fase 3 — Token Parser
Individuazione dei file JSONL.
Lettura dei record.
Estrazione di input e output tokens.
Aggregazione per sessione.
Aggregazione giornaliera.
Prevenzione dei conteggi duplicati.
Fase 4 — Integrazione Anthropic
Analisi delle modalità di autenticazione disponibili.
Individuazione dell'endpoint di utilizzo.
Recupero dei limiti 5h e settimanali.
Calcolo dei tempi di reset.
Gestione delle credenziali e degli errori.
Fase 5 — Storico
Memorizzazione locale dei dati.
Conservazione degli ultimi 30 giorni.
Aggiornamento incrementale.
Verifica della correttezza delle statistiche.
Fase 6 — Ottimizzazione
Riduzione delle operazioni di lettura.
Verifica dell'utilizzo di RAM e CPU.
Verifica del comportamento dopo sospensione e ripresa del sistema.
Gestione dei riavvii di GNOME Shell.
Test con sessioni Claude Code attive.
Fase 7 — Distribuzione
Preparazione del pacchetto dell'estensione.
Verifica dell'installazione manuale.
Documentazione delle dipendenze.
Documentazione delle limitazioni.
Preparazione delle istruzioni per gli aggiornamenti.
12. Criteri di completamento

La prima versione può essere considerata completa quando:

L'icona Claude è presente nella barra superiore GNOME.
Il menu si apre correttamente.
Il menu mostra il consumo del piano nelle finestre di 5 ore e settimanale.
I tempi di reset sono corretti.
Input e output tokens vengono letti correttamente.
Lo storico degli ultimi 30 giorni è disponibile.
L'aggiornamento automatico avviene ogni 60 secondi.
L'interfaccia rispetta il tema GNOME.
L'estensione non blocca GNOME Shell.
I dati personali rimangono locali.
L'estensione continua a funzionare correttamente quando una fonte di dati non è disponibile.
13. Funzionalità escluse dalla prima versione

Per mantenere il progetto minimalista, non sono previste:

Dashboard desktop separata.
Applicazione Electron.
Monitoraggio di Claude Desktop.
Monitoraggio del sito claude.ai.
Statistiche per modello.
Calcolo dei costi in denaro.
Notifiche avanzate.
Grafici complessi.
Sincronizzazione cloud.
Account o autenticazione proprietari dell'estensione.

Queste funzionalità potranno essere valutate in futuro, senza compromettere la semplicità dell'architettura iniziale.

14. Risultato finale atteso

Un'estensione GNOME Shell leggera, discreta e nativa per Fedora 44.

L'utente deve poter controllare l'utilizzo di Claude senza interrompere il proprio lavoro e senza aprire applicazioni aggiuntive.

La barra superiore deve contenere soltanto l'icona Claude.

Il menu deve fornire rapidamente le informazioni essenziali:

Utilizzo del piano nelle ultime 5 ore.
Utilizzo settimanale.
Tempi di reset.
Input tokens.
Output tokens.
Storico dei consumi degli ultimi 30 giorni.

Priorità assoluta: minimalismo, precisione dei dati, integrazione GNOME e basso consumo di risorse.
