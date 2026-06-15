//! #region === MODEL ===
const config = {
    octaves: 4,               // Numero di ottave visibili sulla tastiera
    startNote: 36,            // Nota di partenza (36 = C2)
    totalSteps: 64,           // Lunghezza della sequenza: 64 Sedicesimi = 4 Battute intere.
    stepWidth: 40,            // pixel: Larghezza della cella per ogni sedicesimo
    keyHeight: 18             // pixel: Altezza di un singolo tasto
};

const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Stato dei Dati (Modello)
let notesData = [];           // Array degli oggetti Nota
let currentStep = 0;          // Cursore del sequencer
let sequenceSpeed = 125;      // Millisecondi per step (Default: 120bpm)
let intervalId = null;
let isPaused = false;
let isRightDragging = false;
let isDraggingTimeline = false;
let isLoopActive = false; // Controllato dal Toggle Button
let customStartStep = 0; // Passo da cui iniziare a scorrere senza loop
let loopStartStep = 0; // Passo di inizio loop.
let loopEndStep = config.totalSteps; // Passo di fine loop.
let timelineDragAnchor = 0; // Punto d'ancoraggio quando draggiamo la timeline
let resizingNoteId = null; // Traccia se e quale nota stiamo allungando
let movingNoteId = null; // Traccia la nota che stiamo spostando
let movingNoteOffsetX = 0; // Scarto di offset ritmico per movimento fluido

// --- ADDED FOR MINI DAW CONNECTION ---
let currentPatternId = 1;
let currentTargetTrack = null;
const targetTrackSelect = document.getElementById('targetTrackSelect');

window.addEventListener('message', (event) => {
    if (event.data.type === 'load-pattern') {
        currentPatternId = event.data.patternId;
        currentTargetTrack = event.data.targetTrack !== undefined ? event.data.targetTrack : null;

        // Popola il menu a tendina se riceviamo la configurazione delle tracce
        if (event.data.totalTracks && targetTrackSelect) {
            const oldValue = targetTrackSelect.value;
            targetTrackSelect.innerHTML = '<option value="null">Nessuna Traccia</option>';
            for (let i = 0; i < event.data.totalTracks; i++) {
                const opt = document.createElement('option');
                opt.value = i;
                opt.innerText = `Track ${i + 1}`;
                targetTrackSelect.appendChild(opt);
            }
            targetTrackSelect.value = currentTargetTrack === null ? "null" : currentTargetTrack;
        }

        console.log(`[PianoRoll] Loaded pattern ID: ${currentPatternId}`, event.data.notes);
        loadState(event.data.notes);
    } else if (event.data.type === 'set-bpm') {
        if (bpmInput) {
            bpmInput.value = event.data.bpm;
            calculateTempo(); // Aggiorna internamente la velocità
        }
    } else if (event.data.type === 'update-target-track-ui') {
        currentTargetTrack = event.data.targetTrack;
        if (targetTrackSelect) {
            targetTrackSelect.value = currentTargetTrack === null ? "null" : currentTargetTrack;
        }
    } else if (event.data.type === 'update-tracks-dropdown') {
        if (targetTrackSelect) {
            targetTrackSelect.innerHTML = '<option value="null">Nessuna Traccia</option>';
            for (let i = 0; i < event.data.totalTracks; i++) {
                const opt = document.createElement('option');
                opt.value = i;
                opt.innerText = `Track ${i + 1}`;
                targetTrackSelect.appendChild(opt);
            }
            targetTrackSelect.value = currentTargetTrack === null ? "null" : currentTargetTrack;
        }
    }
});

if (targetTrackSelect) {
    targetTrackSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        currentTargetTrack = val === "null" ? null : parseInt(val);

        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'update-pattern-track',
                patternId: currentPatternId,
                targetTrack: currentTargetTrack
            }, '*');
        }
    });
}

// MULTI-SELECTION LOGIC
let isSelecting = false;
let selectionStartX = 0;
let selectionStartY = 0;
let isSelectingGridClick = false;
let clickMidiNote = null;
let selectedNotesOriginals = [];
let selectedNotesIds = new Set();
const selectionBoxEl = document.createElement('div');
selectionBoxEl.className = 'selection-box';

// LOGICA CLIPBOARD E UNDO/REDO
let clipboardNotes = [];
let undoStack = [];
let redoStack = [];
let previousStateJSON = "[]";

function serializeNotesData() {     //P.S. : L'alternativa è structuredClone
    return JSON.stringify(notesData);  //Se non facessimo cosi, ogni modifica di notesData modificherebbe undoStack
}

function checkAndSaveState() {
    const currentStateJSON = serializeNotesData();
    if (currentStateJSON !== previousStateJSON) {
        undoStack.push(previousStateJSON);
        redoStack = [];   //Viene posto vuoto perche il redoStack viene salvato solo quando viene chiamato undo()
        previousStateJSON = currentStateJSON;

        // --- ADDED FOR MINI DAW CONNECTION ---
        if (window.parent && window.parent !== window) {
            console.log(`[PianoRoll] Broadcasting update for pattern ${currentPatternId}`);
            window.parent.postMessage({
                type: 'update-pattern',
                patternId: currentPatternId,
                notes: notesData,
                totalSteps: config.totalSteps
            }, '*');
        }
    }
}

function loadState(stateJSON) {    //Funzione di render delle note sulla griglia
    if (!stateJSON) return;
    const data = (typeof stateJSON === 'string') ? JSON.parse(stateJSON) : stateJSON;

    clearSelection();
    notesData = data;

    // Rimuovi tutte le note dall'interfaccia UI
    Array.from(layerEl.children).forEach(child => {
        if (!child.classList.contains('selection-box') && !child.classList.contains('playhead')) {
            child.remove();
        }
    });

    let maxId = 0;
    notesData.forEach(notObj => {    //Creazione fisica della nota
        if (!notObj.id) notObj.id = `note_${noteIdCounter++}`;
        renderNoteElement(notObj);
        const parts = notObj.id.split('_');
        const num = parts.length > 1 ? parseInt(parts[1]) : NaN;
        if (!isNaN(num) && num >= maxId) maxId = num + 1;
    });
    if (maxId > noteIdCounter) noteIdCounter = maxId;

    previousStateJSON = serializeNotesData();
}

function undo() {
    if (undoStack.length > 0) {
        redoStack.push(previousStateJSON);
        const stateJSON = undoStack.pop();
        loadState(stateJSON);
    }
}

function redo() {
    if (redoStack.length > 0) {
        undoStack.push(previousStateJSON);
        const stateJSON = redoStack.pop();
        loadState(stateJSON);
    }
}

function copySelectedNotes() {
    if (selectedNotesIds.size === 0) return;
    clipboardNotes = [];
    let minStep = Infinity;
    selectedNotesIds.forEach(id => {
        const n = notesData.find(not => not.id === id); //Prendiamo le note(oggetti) a partire dagli id di quelle selezionate
        if (n && n.startStep < minStep) minStep = n.startStep; //La selezione inizia allo step piu piccolo
    });

    selectedNotesIds.forEach(id => {
        const n = notesData.find(not => not.id === id);
        if (n) {
            clipboardNotes.push({
                pitch: n.pitch,
                lengthSteps: n.lengthSteps,
                offsetStep: n.startStep - minStep  //Distanza normalizzata con partenza allo step 0 della nota con lo step piu piccolo
            });
        }
    });
}

function pasteNotes() {
    if (clipboardNotes.length === 0) return;
    clearSelection();

    const pasteBaseStep = intervalId ? currentStep : customStartStep;   //Sceglie in base al fatto se il sequencer sta suonando o no

    clipboardNotes.forEach(clip => {
        let newStep = pasteBaseStep + clip.offsetStep;   //Viene aggiunto la posizione della testina allo startStep di ogni nota
        if (newStep < config.totalSteps) {
            let len = clip.lengthSteps;
            if (newStep + len > config.totalSteps) len = config.totalSteps - newStep;  //La nota viene accorciata se esce fuori dai bordi

            if (len > 0) {   // Check nel caso il troncamento riduce la nota a zero (startStep fuori dai bordi)
                const existingIndex = notesData.findIndex(n => n.pitch === clip.pitch && n.startStep === newStep);
                if (existingIndex === -1) {   // Creazione nota che avviene solo se non esiste già una nota nello stesso spazio
                    const newId = `note_${noteIdCounter++}`;
                    const noteObj = {
                        id: newId,
                        pitch: clip.pitch,
                        startStep: newStep,
                        lengthSteps: len
                    };
                    notesData.push(noteObj);
                    renderNoteElement(noteObj);

                    selectedNotesIds.add(newId);    //Le note incollate fanno parte anche della selezione, cosi possono essere spostate
                    const newlyCreatedEl = document.getElementById(newId);
                    if (newlyCreatedEl) newlyCreatedEl.classList.add('selected');
                }
            }
        }
    });
    checkAndSaveState();
}

// Audio Context Web API (Il motore sonoro)
const audioCtx = (window.parent && window.parent.masterAudioCtx) ? window.parent.masterAudioCtx : new (window.AudioContext || window.webkitAudioContext)();

// Riferimenti agli elementi HTML
const keyboardEl = document.getElementById('keyboard');
const bgEl = document.getElementById('grid-background');
const layerEl = document.getElementById('notes-layer');
const playheadEl = document.getElementById('playhead');
const timelineEl = document.getElementById('timeline');
const loopRegionEl = document.getElementById('loop-region');
const bpmInput = document.getElementById('bpmInput');
const stepsInput = document.getElementById('stepsInput');
const octavesInput = document.getElementById('octavesInput');
const scrollContainer = document.getElementById('roll-scroll-area');

// Trasporto
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');


// === UTILITIES MUSICALI E GRIGLIA ===
let currentQuantization = 1; // Default 1/16 (1 step)

const gridSelect = document.getElementById('gridSelect');
if (gridSelect) {
    gridSelect.addEventListener('change', (e) => {
        currentQuantization = parseFloat(e.target.value);
        updateGridBackground();
    });
}

function updateGridBackground() {   // Aggiorna la quantizzazione della griglia
    let bgSizeSmall = `${currentQuantization * config.stepWidth}px 100%`;  // Calcolo larghezza step
    // Usa "calc" di CSS nativo per evitare mismatch di subpixel rendering dei browser
    if (Math.abs(currentQuantization - 1.3333333333333333) < 0.01) {  // Se lo step è 1/3
        bgSizeSmall = `calc(${config.stepWidth * 4}px / 3) 100%`;  // 40px * (4/3)
    } else if (Math.abs(currentQuantization - 0.6666666666666666) < 0.01) {   // Se lo step è 1/6
        bgSizeSmall = `calc(${config.stepWidth * 4}px / 6) 100%`;
    }

    bgEl.style.backgroundSize = `${bgSizeSmall}, ${config.stepWidth * 4}px 100%`; // linee step, linee battute
    timelineEl.style.backgroundSize = `${bgSizeSmall}`;   //linee step nella timeline
}

// Quantizza il click
function getSnappedStep(rawStep) {
    return Math.floor(rawStep / currentQuantization) * currentQuantization;
}

// Quantizza l'allungamento/accorciamento della nota
function getRoundSnappedStep(rawStep) {
    return Math.round(rawStep / currentQuantization) * currentQuantization;
}

// Formula standard per ricavare gli Hertz conoscendo l'indice MIDI
function getFrequency(midiNote) {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
}

// Verifica se la nota corrispondente (in modulo 12) è un tasto nero
function isBlackKey(midiNote) {
    const noteInOctave = midiNote % 12;
    return [1, 3, 6, 8, 10].includes(noteInOctave); // Restituisce true o false
}

// Estrae il nome in lettere (es: C4, D#3) partendo dal MIDI ID
function getNoteName(midiNote) {
    const noteInOctave = midiNote % 12;
    const octave = Math.floor(midiNote / 12) - 1; // standardizzazione ottave MIDI
    return noteNames[noteInOctave] + octave;
}
//! #endregion

//? #region === VIEW ===

function initPianoRoll() {
    keyboardEl.innerHTML = '';
    bgEl.innerHTML = '';

    // Inseriamo il box di selezione nel layer
    layerEl.appendChild(selectionBoxEl);

    // Header vuoto della tastiera per far spazio alla timeline (24px)
    const spacer = document.createElement('div');
    spacer.style.height = '24px';
    spacer.style.minHeight = '24px';
    spacer.style.backgroundColor = '#1a1d21';
    spacer.style.borderBottom = '1px solid #111';
    spacer.style.position = 'sticky';
    spacer.style.top = '0';
    spacer.style.zIndex = '25';
    keyboardEl.appendChild(spacer);

    // Calcoliamo la larghezza totale necessaria per ospitare l'intera sequenza e la applichiamo ai div
    const totalWidth = config.totalSteps * config.stepWidth;
    timelineEl.style.width = `${totalWidth}px`;
    bgEl.style.width = `${totalWidth}px`;
    layerEl.style.width = `${totalWidth}px`;
    // Se è cambiata la lunghezza, dobbiamo riallineare il loop visuale se eccede la nuova lunghezza
    if (loopEndStep > config.totalSteps) loopEndStep = config.totalSteps;
    if (loopStartStep >= config.totalSteps) loopStartStep = config.totalSteps - 1;
    if (isLoopActive) {
        let leftPx = loopStartStep * config.stepWidth; //Converte l'inizio del loop da step a pixel
        let wPx = (loopEndStep - loopStartStep) * config.stepWidth; //Converte la larghezza del loop da step a pixel
        loopRegionEl.style.left = `${leftPx}px`;
        loopRegionEl.style.width = `${wPx}px`;
    }

    // Disegniamo la tastiera dall'alto verso il basso (le note acute stanno SEMPRE in alto)
    const endNote = config.startNote + (config.octaves * 12) - 1;

    for (let midi = endNote; midi >= config.startNote; midi--) {
        const isBlack = isBlackKey(midi);

        // 1. CREAZIONE TASTO PIANOLA
        const keyEl = document.createElement('div');
        keyEl.className = `key ${isBlack ? 'black' : 'white'}`;
        keyEl.dataset.midi = midi;    // Sfrutta la proprietà "dataset" degli elementi HTML per memorizzare dati al loro interno

        // Per pulizia visiva (stile FL Setup) mostriamo il numero ottava solo sui tasti C (Do)
        if (midi % 12 === 0) {
            keyEl.textContent = getNoteName(midi);
        }

        // Suona in anteprima quando clicchiamo la pianola laterale
        keyEl.onmousedown = () => playSynth(midi, 0.5);

        keyboardEl.appendChild(keyEl);

        // 2. CREAZIONE DELLA STRISCIA ORIZZONTALE SULLA GRIGLIA
        const rowEl = document.createElement('div');
        rowEl.className = `grid-row ${isBlack ? 'black-key-row' : 'white-key-row'}`;

        rowEl.onmousedown = (e) => handleGridClick(e, midi);
        bgEl.appendChild(rowEl);
    }

    // Aggiorniamo la dimensione visiva di scissione in base alla quantizzazione (default css)
    updateGridBackground();

    // Centra la vista al centro della pianola (ottava centrale)
    setTimeout(() => {   // Delay necessario per dare modo di costruire tutta la tastiera prima
        scrollContainer.scrollTop = (config.octaves * 12 * config.keyHeight) / 2;
    }, 100);
}

function updateConfigSettings() {   // Viene chiamata quando viene modificato il numero di step o ottave
    clearSelection();

    if (stepsInput) {
        let val = parseInt(stepsInput.value);
        if (isNaN(val) || val < 16) val = 16;
        config.totalSteps = val;  // Aggiorna il model
        stepsInput.value = val;   // Aggiorna la view
    }

    if (octavesInput) {
        let val = parseInt(octavesInput.value);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 7) val = 7;
        config.octaves = val;
        octavesInput.value = val;
    }

    const endNote = config.startNote + (config.octaves * 12) - 1;

    // Filter notes that are completely out of bounds, and truncate those overflowing totalSteps
    notesData = notesData.filter(n => {
        if (n.startStep >= config.totalSteps) return false; //Rimuove la nota 
        if (n.pitch < config.startNote || n.pitch > endNote) return false; //Rimuove la nota
        return true; // Mantiene la nota
    });

    notesData.forEach(n => {
        if (n.startStep + n.lengthSteps > config.totalSteps) {
            n.lengthSteps = config.totalSteps - n.startStep;
        }
    });

    // Remove old note elements
    Array.from(layerEl.children).forEach(child => {
        if (!child.classList.contains('selection-box') && !child.classList.contains('playhead') && !child.classList.contains('loop-region')) {
            child.remove();
        }
    });

    // Rebuild the grid
    initPianoRoll();

    // Re-render notes
    notesData.forEach(n => {
        renderNoteElement(n);
    });

    checkAndSaveState();
}

if (stepsInput) {
    stepsInput.addEventListener('change', updateConfigSettings);
    stepsInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') stepsInput.blur(); }); //Avvia l'evento "change" solo dopo aver premuto il tasto INVIO
}
if (octavesInput) {
    octavesInput.addEventListener('change', updateConfigSettings);
    octavesInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') octavesInput.blur(); });
}
//? #endregion

//* #region === CONTROLLER ===

// === GESTIONE INSERIMENTO/RIMOZIONE NOTE ===

let noteIdCounter = 0;

function clearSelection() {
    selectedNotesIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('selected');
    });
    selectedNotesIds.clear();
}

function selectAllNotes() {
    clearSelection();
    notesData.forEach(n => {
        selectedNotesIds.add(n.id);
        const el = document.getElementById(n.id);
        if (el) el.classList.add('selected');
    });
}

// Reagisce ai click effettuati sullo sfondo della griglia (le strisce `grid-row`)
function handleGridClick(event, midiNote) {
    // Solo il tasto sinistro interagisce con la griglia
    if (event.button !== 0) return;

    if (!event.shiftKey && !event.ctrlKey) {    //Deseleziona le note precedenti se clicco nel vuoto
        clearSelection();
    }

    // Inizia modalità selezione oppure "click singolo"
    isSelecting = true;
    isSelectingGridClick = true;  // true = cliccato sulla griglia ;  false = cliccato sulla nota per spostarla
    clickMidiNote = midiNote;

    const rect = layerEl.getBoundingClientRect(); // Posizione e dimensioni di layerEl rispetto alla finestra del browser
    selectionStartX = event.clientX - rect.left;    // coordinata x del mouse  -  l'inizio di layerEL
    selectionStartY = event.clientY - rect.top;

    selectionBoxEl.style.left = `${selectionStartX}px`;
    selectionBoxEl.style.top = `${selectionStartY}px`;
    selectionBoxEl.style.width = '0px';
    selectionBoxEl.style.height = '0px';
    selectionBoxEl.style.display = 'block';
}

// Inserisce una nuova Nota e aggiorna l'UI
function addNote(midiNote, step, length) {
    // Controllo per impedire di sovrapporre due note ESATTAMENTE nello stesso box
    const existingIndex = notesData.findIndex(n => n.pitch === midiNote && n.startStep === step);
    if (existingIndex !== -1) {
        return;
    }

    const noteObj = {
        id: `note_${noteIdCounter++}`,   // Inserisce il valore attuale del counter e poi lo incrementa
        pitch: midiNote,
        startStep: step,
        lengthSteps: length
    };

    notesData.push(noteObj);
    renderNoteElement(noteObj); // Crea il box HTML della nota

    playSynth(midiNote, 0.15);
}

// Rimuove una Nota specifica
function removeNote(id) {
    notesData = notesData.filter(n => n.id !== id);   // Mantiene le note con id diverso dalla nota da cancellare
    const el = document.getElementById(id);
    if (el) el.remove();
}

// Renderizza graficamente il blocco della Nota sul Piano Roll layer
function renderNoteElement(noteObj) {
    const el = document.createElement('div');
    el.id = noteObj.id;
    el.className = 'note';

    /* 
     CALCOLA LA POSIZIONE 
     L'asse Y (verticale) va dall'alto verso il basso. 
     La nota più acuta è l'endNote = è a Y:0px. Scendiamo calcolando la distanza.
    */
    const endNote = config.startNote + (config.octaves * 12) - 1;
    const distanceFromTop = endNote - noteObj.pitch;  //Nel caso (noteObj.pitch === endNote), la distanza sarà 0, e la nota apparirà in cima.

    el.style.top = `${distanceFromTop * config.keyHeight}px`;
    // Assi X in base agli step orizzontali
    el.style.left = `${noteObj.startStep * config.stepWidth}px`;
    el.style.width = `${noteObj.lengthSteps * config.stepWidth}px`;

    // GESTIONE CANCELLAZIONE E SPOSTAMENTO
    el.onmousedown = (e) => {
        e.preventDefault(); // Previene il blocco del drag su Windows e focus dei menù a tendina con il tasto ALT
        e.stopPropagation(); // Impedisce la creazione di nuove note sullo stesso punto; blocca l'Event Bubbling (cioè la trasmissione del click al genitore e agli strati ancora prima)
        if (e.button === 2) {
            isRightDragging = true;   // Vedi "onmouseenter" appena sotto
            removeNote(noteObj.id); // Tasto destro: Cancella la nota
        } else if (e.button === 0) {
            // Tasto sinistro: Inizia trascinamento (spostamento)
            movingNoteId = noteObj.id;

            // Seleziona automaticamente se non fa già parte di una selezione di gruppo
            if (!selectedNotesIds.has(noteObj.id)) {
                clearSelection();
                selectedNotesIds.add(noteObj.id);
                el.classList.add('selected');
            }

            // Memorizza le posizioni originali di tutte le note selezionate per spostarle in blocco
            selectedNotesOriginals = Array.from(selectedNotesIds).map(id => {   //Creazione di un nuovo array 
                const n = notesData.find(not => not.id === id);   // Restituisce il primo elemento che rispetta la condizione
                return { id: n.id, startStep: n.startStep, pitch: n.pitch, lengthSteps: n.lengthSteps };
            });

            const rect = bgEl.getBoundingClientRect();
            const x = e.clientX - rect.left;  // Calcola la posizione del mouse rispetto alla griglia

            let rawClickStep = x / config.stepWidth;   //Trasforma i pixel in step (non quantizzati)

            // Per far si che la posizione del mouse, rispetto alla nota trascinata, rimanga la stessa durante il movimento
            movingNoteOffsetX = rawClickStep - noteObj.startStep;
        }
    };

    el.onmouseenter = () => {
        if (isRightDragging) {
            removeNote(noteObj.id);
        }
    };

    el.oncontextmenu = (e) => e.preventDefault();  // Disabilita menù a tendina

    // HANDLER PER L'ALLUNGAMENTO (RESIZE) SUL BORDO DESTRO
    const resizeHandle = document.createElement('div');  // Sottile bordo destro della nota usato per allungarla
    resizeHandle.className = 'note-resize-handle';
    resizeHandle.onmousedown = (e) => {
        e.preventDefault(); // Previene il blocco del drag
        e.stopPropagation(); // Evita che il click parta per cancellare la nota (dato che si propagherebbe su "el", cioè la nota)
        if (e.button === 0) {
            resizingNoteId = noteObj.id;

            // Seleziona automaticamente se non fa già parte, per abilitare allungamento singolo e multi
            if (!selectedNotesIds.has(noteObj.id)) {
                clearSelection();
                selectedNotesIds.add(noteObj.id);
                el.classList.add('selected');
            }

            // Salviamo lo stato originale prima del ridimensionamento per tutte le note selezionate
            selectedNotesOriginals = Array.from(selectedNotesIds).map(id => {
                const n = notesData.find(not => not.id === id);
                return { id: n.id, startStep: n.startStep, pitch: n.pitch, lengthSteps: n.lengthSteps };
            });
        }
    };

    el.appendChild(resizeHandle);

    layerEl.appendChild(el);
}


// === SINTESI AUDIO WEB API GENERATIVA TIPO (FL KEYS BASE) ===

function playSynth(midiNote, durationSec) {
    // --- REDIRECT TO PARENT (MINI DAW ROUTER) ---
    if (window.parent && window.parent !== window) {
        const keyId = `preview_${midiNote}_${Date.now()}`;
        window.parent.postMessage({
            type: 'note-on',
            midi: midiNote,
            key: keyId
        }, '*');

        // Auto-release preview notes
        setTimeout(() => {
            window.parent.postMessage({
                type: 'note-off',
                midi: midiNote,
                key: keyId
            }, '*');
        }, durationSec * 1000);
    }
}

// Fa accendere temporaneamente di verde il tastino della pianola premuto o suonato in play
function highlightKey(midiNote, durationMs) {
    const keyEl = document.querySelector(`.key[data-midi="${midiNote}"]`);
    if (keyEl) {
        keyEl.classList.add('active');
        setTimeout(() => keyEl.classList.remove('active'), durationMs);
    }
}


// === MOTORE SEQUENCER TEMPORALE ===

function calculateTempo() {
    let bpm = parseInt(bpmInput.value);
    if (isNaN(bpm) || bpm < 40) bpm = 40;
    if (bpm > 300) bpm = 300;
    bpmInput.value = bpm;
    // (60000ms / BPM) ci da la lunghezza un quarto. Diviso 4 ci da 1 sedicesimo 
    sequenceSpeed = (60000 / bpm) / 4;  // Durata in ms di uno step

    // Aggiorna dinamicamente la velocità d'animazione fluida in base ai BPM correnti
    playheadEl.style.transitionDuration = `${sequenceSpeed}ms`;
}

/**
 * Aggiorna la posizione della testina, permettendo salti istantanei senza animazione di "ritorno"
 */
function movePlayhead(step, immediate = false) {
    if (immediate) {
        playheadEl.style.transitionDuration = '0ms';
    }
    playheadEl.style.left = `${step * config.stepWidth}px`;
    if (immediate) {
        // Forza un "reflow" per far capire al browser che il salto è avvenuto ora
        playheadEl.offsetHeight;
        playheadEl.style.transitionDuration = `${sequenceSpeed}ms`;
    }
}

function stepLoop() {
    // 1. Sposta Visivamente l'asticella del tempo (Playhead Giallo)
    playheadEl.style.left = `${currentStep * config.stepWidth}px`;
    movePlayhead(currentStep);

    // 2. Rimuove l'alone bianco sulle note appena suonate dal tick precedente
    document.querySelectorAll('.note.playing').forEach(el => el.classList.remove('playing'));

    // 3. TROVA LE NOTE ATTIVE CHE INIZIANO IN QUESTO GAP RITMICO (tra currentStep e currentStep + 1, non compreso)
    const stepDurationSec = sequenceSpeed / 1000;    // In sec perchè ne ha bisogno web audio API

    // Poiché lo startStep può essere frazionato (es. 1/3, 1/6), cerchiamo le note che cadono all'interno dell'intervallo di questo scatto ritmico (ovvero in questi 125ms correnti, cioè quelli del 16esimo)
    const notesToPlay = notesData.filter(n => n.startStep >= currentStep && n.startStep < currentStep + 1);

    notesToPlay.forEach(noteObj => {
        // Calcola in quale esatto ms all'interno del corrente step la nota dovrebbe fisicamente partire
        const fraction = noteObj.startStep - currentStep;  // Ricorda : startStep può essere decimale!
        const delayMs = fraction * sequenceSpeed;   // Delay in ms rispetto allo step corrente

        setTimeout(() => {
            if (!intervalId) return; // Se stoppato nel frattempo annulla

            // Suona per la sua altezza MIDI (pitch) in base a quanti frammenti (lengthSteps) ingombra
            const durSec = noteObj.lengthSteps * stepDurationSec;
            playSynth(noteObj.pitch, durSec);

            // Accende visivamente il blocchettino verde facendolo brillare (Classe playing CSS)
            const noteEl = document.getElementById(noteObj.id);
            if (noteEl) {
                noteEl.classList.add('playing');
                // Timer dedicato per sbiancarlo terminata la sua durata in millisecondi
                setTimeout(() => {
                    if (noteEl) noteEl.classList.remove('playing');
                }, durSec * 1000);
            }
        }, delayMs);
    });

    // 4. Manda lo step successivo per il prossimo giro loopando alla fine
    currentStep++;

    if (isLoopActive) {
        // Se Loop è Attivo, forza il rientro nel recinto loop
        if (currentStep >= loopEndStep || currentStep >= config.totalSteps) {
            currentStep = loopStartStep;

            // Disabilitare momentaneamente l'animazione per farlo scattare di colpo a sinistra a fine loop
            playheadEl.style.transitionDuration = '0ms';
            playheadEl.style.left = `${currentStep * config.stepWidth}px`;

            // Riattivamo l'animazione ma con qualche ms di ritardo il browser ignora le due linee di codice prima di questo (cioè la transition a 0ms)
            setTimeout(() => {
                if (intervalId) playheadEl.style.transitionDuration = `${sequenceSpeed}ms`;
            }, 10);
            movePlayhead(currentStep, true);
        }
    } else {
        // Se Loop è Disattivo, scorre semplicemente fino in fondo al progetto e si resetta a 0
        if (currentStep >= config.totalSteps) {
            currentStep = 0;
            if (!intervalId) {   // DA RIVEDERE!
                stopBtn.click();
                return;   // Impedisce di eseguire la linea di codice sotto
            }
        }
    }

    // Programma il prossimo avvio esatto
    intervalId = setTimeout(stepLoop, sequenceSpeed);
}

// === CATTURA EVENTI CONTROLLI SUPERIORI ===

playBtn.addEventListener('click', () => {
    if (intervalId) return; // Selezionabile una sola volta (Non doppi avvii)
    if (audioCtx.state === 'suspended') audioCtx.resume();

    playheadEl.style.display = 'block'; // Fai comparire il playhead nascosto
    playBtn.classList.add('active');
    stopBtn.classList.remove('active');

    calculateTempo();
    stepLoop();
});

stopBtn.addEventListener('click', () => {
    clearTimeout(intervalId);
    intervalId = null;

    // Ripristina la testina al Custom Start oppure al Loop Start in base a cosa è attivo
    currentStep = isLoopActive ? loopStartStep : customStartStep;

    // Spegne temporaneamente l'animazione fluida per resettarlo di colpo al punto di partenza senza l'effetto scivolata all'indietro
    playheadEl.style.transitionDuration = '0ms';
    playheadEl.style.left = `${currentStep * config.stepWidth}px`;
    playheadEl.style.display = 'block';

    // Ricalcola lo step dopo 50ms (per far digerire al css prima il salto) e riabilita la fluidità
    setTimeout(() => {
        if (!intervalId) { // Assicuriamoci che non sia ripartito accidentalmente
            playheadEl.style.transitionDuration = `${sequenceSpeed}ms`;
        }
    }, 50);

    playBtn.classList.remove('active');
    stopBtn.classList.add('active');
    setTimeout(() => stopBtn.classList.remove('active'), 200);

    // Spegni tutte le attuali in coda
    document.querySelectorAll('.note.playing').forEach(el => el.classList.remove('playing'));
});

clearBtn.addEventListener('click', () => {
    notesData = []; // Azzera modello
    // Rimuovi tutto tranne playhead e selection box
    Array.from(layerEl.children).forEach(child => {
        if (!child.classList.contains('selection-box') && !child.classList.contains('playhead')) {
            child.remove();
        }
    });
    checkAndSaveState();
});

bpmInput.addEventListener('change', () => {
    calculateTempo(); // Adatta i BPM Live

    // --- ADDED FOR MINI DAW CONNECTION ---
    if (window.parent && window.parent !== window) {
        window.parent.postMessage({
            type: 'bpm-changed',
            bpm: parseInt(bpmInput.value)
        }, '*');
    }
});
bpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') bpmInput.blur();
});

// Spacebar play/stop sync with DAW removed to avoid double-playback and allow local focus as requested
window.addEventListener('keydown', (e) => {
    // If typing in an input, ignore
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === ' ') {
        e.preventDefault(); // Just prevent default, let the other listener below handle the local playback
    }
});

// START
initPianoRoll();

// Gestione globale del rilascio mouse per resettare lo stato di dragging
window.addEventListener('mouseup', (e) => {
    if (e.button === 2) {
        isRightDragging = false;
    }

    if (e.button === 0) {
        if (isSelecting) {
            isSelecting = false;
            selectionBoxEl.style.display = 'none';

            // Check se stavamo semplicemente facendo un click per aggiungere una nota
            if (isSelectingGridClick) {
                const rect = layerEl.getBoundingClientRect();
                const currentX = e.clientX - rect.left;
                const currentY = e.clientY - rect.top;

                // Se non ci siamo mossi quasi per nulla, allora è un click!
                if (Math.abs(currentX - selectionStartX) < 5 && Math.abs(currentY - selectionStartY) < 5) {
                    let rawStep = selectionStartX / config.stepWidth;
                    let step = getSnappedStep(rawStep);
                    if (step >= 0 && step < config.totalSteps && clickMidiNote !== null) {
                        addNote(clickMidiNote, step, currentQuantization);
                    }
                }
            }

            isSelectingGridClick = false;
            clickMidiNote = null;
        }

        // Fine trascinamento nota
        if (movingNoteId) {
            movingNoteId = null;
            selectedNotesOriginals = [];
        }

        // Fine allungamento nota
        if (resizingNoteId) {
            resizingNoteId = null;
            selectedNotesOriginals = [];
        }
    }

    isDraggingTimeline = false;

    // Controlla se ci sono stati dei cambiamenti e salvali per la cronologia (undo/redo)
    checkAndSaveState();
});

// Impedisce globalmente il menu contestuale su tutta la pagina per facilitare l'uso del tasto destro
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Aggiunge la scorciatoia della Barra Spaziatrice per avviare/fermare la riproduzione
window.addEventListener('keydown', (e) => {
    // Blocca il focus sul menu di sistema Windows quando si clicca ALT da tastiera
    if (e.key === 'Alt') {
        e.preventDefault();
    }

    if (e.code === 'Space') {
        // Previene il fastidioso scroll della pagina quando premi spazio
        e.preventDefault();

        if (e.ctrlKey) {
            // LOGICA RESET ASSOLUTO (Ctrl + Space): Torna all'inizio assoluto (Step 0)
            const wasPlaying = !!intervalId;

            clearTimeout(intervalId);
            intervalId = null;

            currentStep = 0;
            customStartStep = 0; // Resetta anche il marker di inizio personalizzato

            // Aggiorna visualmente la testina istantaneamente
            playheadEl.style.transitionDuration = '0ms';
            playheadEl.style.left = '0px';

            playBtn.classList.remove('active');

            if (wasPlaying) {
                // Se stava suonando, riparte subito da zero
                playBtn.click();
            } else {
                // Altrimenti mostra lo stato di stop aggiornato
                stopBtn.classList.add('active');
                setTimeout(() => stopBtn.classList.remove('active'), 200);
            }
        } else if (e.shiftKey) {
            // LOGICA PAUSA (Shift + Space): Ferma senza resettare la posizione
            if (intervalId) {
                clearTimeout(intervalId);
                intervalId = null;
                playBtn.classList.remove('active');
                // Pulisce solo i feedback visivi delle note che stanno suonando
                document.querySelectorAll('.note.playing').forEach(el => el.classList.remove('playing'));
            } else {
                playBtn.click();
            }
        } else {
            // COMPORTAMENTO STANDARD (Solo Space): Avvia (Sempre dall'inizio) o Stoppa (Reset)
            if (intervalId) {
                stopBtn.click();
            } else {
                // Se siamo fermi ma non all'inizio (es. dopo una pausa), resettiamo prima di partire
                const startPos = isLoopActive ? loopStartStep : customStartStep;
                if (currentStep !== startPos) {
                    stopBtn.click();
                }
                playBtn.click();
            }
        }
    }

    // Scorciatoia Duplica: Ctrl + D e tasti base (Cancella)
    if (e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (e.code === 'KeyC' || k === 'c') {
            e.preventDefault();
            copySelectedNotes();
        } else if (e.code === 'KeyV' || k === 'v') {
            e.preventDefault();
            pasteNotes();
        } else if ((e.code === 'KeyZ' || k === 'z') && e.shiftKey) { // Z maiuscola = REDO per sicurezza
            e.preventDefault();
            redo();
        } else if (e.code === 'KeyZ' || k === 'z') {
            e.preventDefault();
            undo();
        } else if (e.code === 'KeyY' || k === 'y') {
            e.preventDefault();
            redo();
        } else if (e.code === 'KeyD' || k === 'd') {
            e.preventDefault();
            duplicateSelectedNotes();
        } else if (e.code === 'KeyA' || k === 'a') {
            e.preventDefault();
            selectAllNotes();
        } else if (e.code === 'KeyL' || k === 'l') {
            e.preventDefault();
            loopBtn.click();
        }
    } else {
        // Tasti senza modificatori
        if (e.code === 'Delete' || e.code === 'Backspace') {
            if (selectedNotesIds.size > 0) {
                e.preventDefault();
                selectedNotesIds.forEach(id => {
                    removeNote(id);
                });
                selectedNotesIds.clear();
                checkAndSaveState();
            }
        }
    }

    // Le frecce direzionali funzionano sia con che senza CTRL
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        if (selectedNotesIds.size > 0) {
            e.preventDefault(); // Evita di far scrollare la pagina verticalmente o orizzontalmente

            let deltaStep = 0;
            let deltaPitch = 0;

            // Se tieni premuto il control, fai un salto di un'ottava (12 semitoni)
            const pitchJump = e.ctrlKey ? 12 : 1;

            if (e.code === 'ArrowUp') deltaPitch = pitchJump;         // Più acuto
            if (e.code === 'ArrowDown') deltaPitch = -pitchJump;      // Più grave
            if (e.code === 'ArrowLeft') deltaStep = -currentQuantization;
            if (e.code === 'ArrowRight') deltaStep = currentQuantization;

            let minStepStart = Infinity;
            let maxStepEnd = 0;
            let minPitch = Infinity;
            let maxPitch = 0;

            selectedNotesIds.forEach(id => {
                const o = notesData.find(n => n.id === id);
                if (o) {
                    if (o.startStep < minStepStart) minStepStart = o.startStep;
                    if (o.startStep + o.lengthSteps > maxStepEnd) maxStepEnd = o.startStep + o.lengthSteps;
                    if (o.pitch < minPitch) minPitch = o.pitch;
                    if (o.pitch > maxPitch) maxPitch = o.pitch;
                }
            });

            const endNote = config.startNote + (config.octaves * 12) - 1;

            // Evita di sbordare dai margini
            if (minStepStart + deltaStep < 0) {
                deltaStep = -minStepStart;
            }
            if (maxStepEnd + deltaStep > config.totalSteps) {
                deltaStep = config.totalSteps - maxStepEnd;
            }

            // Se lo spostamento (specie di un'ottava) fa uscire le note dalla griglia,
            // annulliamo lo spostamento verticale per evitare trasposizioni "monche" di pochi semitoni
            if (minPitch + deltaPitch < config.startNote || maxPitch + deltaPitch > endNote) {
                deltaPitch = 0;
            }

            if (deltaStep !== 0 || deltaPitch !== 0) {
                const toUpdate = [];
                selectedNotesIds.forEach(id => {
                    const o = notesData.find(n => n.id === id);
                    if (o) {
                        toUpdate.push({
                            id: o.id,
                            newPitch: o.pitch + deltaPitch,
                            newStartStep: o.startStep + deltaStep
                        });
                    }
                });

                // Verifica sovrapposizione con note non selezionate
                const conflict = toUpdate.some(u => {
                    return notesData.some(nd => !selectedNotesIds.has(nd.id) && nd.pitch === u.newPitch && nd.startStep === u.newStartStep);
                });

                if (!conflict) {
                    let playPreviewPitch = null;
                    toUpdate.forEach(u => {
                        const no = notesData.find(nx => nx.id === u.id);
                        if (no) {
                            if (no.pitch !== u.newPitch) {
                                playPreviewPitch = u.newPitch;
                            }
                            no.pitch = u.newPitch;
                            no.startStep = u.newStartStep;

                            const noteEl = document.getElementById(no.id);
                            if (noteEl) {
                                const distanceFromTop = endNote - no.pitch;
                                noteEl.style.top = `${distanceFromTop * config.keyHeight}px`;
                                noteEl.style.left = `${no.startStep * config.stepWidth}px`;
                            }
                        }
                    });

                    // Suona il synth per dare un feedback audivo dello spostamento in verticale
                    if (playPreviewPitch !== null && deltaPitch !== 0) {
                        playSynth(playPreviewPitch, 0.15);
                    }

                    checkAndSaveState();
                }
            }
        }
    }
});

function duplicateSelectedNotes() {
    if (selectedNotesIds.size === 0) return;

    let maxStepEnd = 0;
    let minStepStart = Infinity;

    const toDuplicate = [];
    selectedNotesIds.forEach(id => {
        const n = notesData.find(not => not.id === id);
        if (n) {
            toDuplicate.push({ ...n }); // Cloniamo l'oggetto (shallow clone, quindi non clona gli annidati!) per non mutare l'originale
            if (n.startStep < minStepStart) minStepStart = n.startStep;
            if (n.startStep + n.lengthSteps > maxStepEnd) maxStepEnd = n.startStep + n.lengthSteps;
        }
    });

    clearSelection();

    // Sposta i cloni subito dopo la fine dell'ultimo elemento del blocco
    const blockLength = maxStepEnd - minStepStart;

    toDuplicate.forEach(oldNote => {
        let newStep = oldNote.startStep + blockLength;
        if (newStep < config.totalSteps) {
            let len = oldNote.lengthSteps;
            if (newStep + len > config.totalSteps) {
                len = config.totalSteps - newStep; // tronca se esce dai limiti
            }
            if (len > 0) {
                // Inserimento silenzioso
                const existingIndex = notesData.findIndex(n => n.pitch === oldNote.pitch && n.startStep === newStep);
                if (existingIndex === -1) {
                    const newId = `note_${noteIdCounter++}`;
                    const noteObj = {
                        id: newId,
                        pitch: oldNote.pitch,
                        startStep: newStep,
                        lengthSteps: len
                    };
                    notesData.push(noteObj);
                    renderNoteElement(noteObj);

                    selectedNotesIds.add(newId);
                    const newlyCreatedEl = document.getElementById(newId);
                    if (newlyCreatedEl) newlyCreatedEl.classList.add('selected');
                }
            }
        }
    });

    checkAndSaveState();
}

// === LOGICA CURSORE TIMELINE ===

// === LOGICA BOTTONE LOOP ===
const loopBtn = document.getElementById('loopBtn');
loopBtn.addEventListener('click', () => {
    isLoopActive = !isLoopActive;
    if (isLoopActive) {
        loopBtn.classList.add('active');
        loopRegionEl.style.display = 'block';

        if (selectedNotesIds.size > 0) {
            // LOGICA BASATA SULLA SELEZIONE: dal primo step all'ultima fine battuta
            let minStart = Infinity;
            let maxEnd = 0;

            selectedNotesIds.forEach(id => {
                const n = notesData.find(note => note.id === id);
                if (n) {
                    if (n.startStep < minStart) minStart = n.startStep;
                    if (n.startStep + n.lengthSteps > maxEnd) maxEnd = n.startStep + n.lengthSteps;
                }
            });

            loopStartStep = minStart;
            // Fine del "quarto" o "battito" (un quarto = 4 step in questo sequencer a 16esimi)
            // Questo gestisce correttamente anche le terzine in termini di suddivisione del tempo
            loopEndStep = Math.ceil(maxEnd / 4) * 4;

            // Sicurezza: non sbordare il progetto
            if (loopEndStep > config.totalSteps) loopEndStep = config.totalSteps;
        } else {
            // LOGICA STANDARD: posiziona il loop sul playhead
            const snappedPlayhead = getSnappedStep(currentStep);
            const currentDuration = loopEndStep - loopStartStep;

            loopStartStep = snappedPlayhead;
            loopEndStep = Math.min(loopStartStep + (currentDuration > 0 ? currentDuration : 16), config.totalSteps);
        }

        // Fix di sicurezza finale: loop minimo di 1 unità
        if (loopEndStep <= loopStartStep) {
            loopEndStep = Math.min(loopStartStep + currentQuantization, config.totalSteps);
        }

        updateTimelineUI();
    } else {
        loopBtn.classList.remove('active');
        loopRegionEl.style.display = 'none';
        // Se spengo il loop, consideriamo come "punto d'avvio custom" l'inizio dell'ultimo loop usato
        customStartStep = loopStartStep;
        updateTimelineUI();
    }
});

// === LOGICA CURSORE TIMELINE ===

function getStepFromMouse(e) {
    const rect = timelineEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let rawStep = x / config.stepWidth;
    let step = getSnappedStep(rawStep);
    if (step < 0) step = 0;
    if (step >= config.totalSteps) step = config.totalSteps - 1;
    return step;
}

function updateTimelineUI() {
    // Bounds check di sicurezza per non sbordare
    if (loopEndStep > config.totalSteps) loopEndStep = config.totalSteps;
    if (loopStartStep < 0) loopStartStep = 0;
    if (loopStartStep >= config.totalSteps) loopStartStep = config.totalSteps - 1;

    if (isLoopActive) {
        // Mostriamo visivamente l'area di loop rosso
        loopRegionEl.style.display = 'block';
        loopRegionEl.style.left = `${loopStartStep * config.stepWidth}px`;
        const width = (loopEndStep - loopStartStep) * config.stepWidth;
        loopRegionEl.style.width = `${width}px`;

        // Se siammo fermi forziamo la testina dentro lo start
        if (!intervalId) {
            currentStep = loopStartStep;
        }
    } else {
        // Niente marker visibili, la testina parte dal customStartStep scelto
        loopRegionEl.style.display = 'none';

        if (!intervalId) {
            currentStep = customStartStep;
        }
    }

    // In entrambi i casi (se la sequenza è ferma), riallineiamo il marker testina visiva
    if (!intervalId) {
        playheadEl.style.transitionDuration = '0ms'; // Salto istantaneo
        playheadEl.style.left = `${currentStep * config.stepWidth}px`;
        playheadEl.style.display = 'block';
    }
}

// Cliccando sulla timeline (Ruler) in alto
timelineEl.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Previene glitch visivi
    const step = getStepFromMouse(e);

    if (isLoopActive) {
        // Modalità: Disegna Regione Loop (Trascina e allarga)
        isDraggingTimeline = true;
        timelineDragAnchor = step;
        loopStartStep = step;
        loopEndStep = step + currentQuantization;
    } else {
        // Modalità Semplice: Sposta la testina
        customStartStep = step;

        // Cliccando mentre sta suonando (Spostamento Live del cursore)
        if (intervalId) {
            currentStep = step;
        }
    }
    updateTimelineUI();
});

// Funzione per ricavare l'altezza MIDI dal mouse (usata nello spostamento verticale)
function getPitchFromMouse(e) {
    const rect = layerEl.getBoundingClientRect();
    let y = e.clientY - rect.top;

    const distanceFromTop = Math.floor(y / config.keyHeight);
    const endNote = config.startNote + (config.octaves * 12) - 1;
    let pitch = endNote - distanceFromTop;

    if (pitch < config.startNote) pitch = config.startNote;
    if (pitch > endNote) pitch = endNote;
    return pitch;
}

// Funzione di utilità per box di selezione
function updateSelectionBox(boxX, boxY, boxW, boxH) {
    clearSelection();
    const boxRight = boxX + boxW;
    const boxBottom = boxY + boxH;

    const endNote = config.startNote + (config.octaves * 12) - 1;

    notesData.forEach(n => {
        const noteX = n.startStep * config.stepWidth;
        const noteY = (endNote - n.pitch) * config.keyHeight;
        const noteRight = noteX + (n.lengthSteps * config.stepWidth);
        const noteBottom = noteY + config.keyHeight;

        // Verifica se il rettangolo nota interseca la box di selezione
        if (noteX < boxRight && noteRight > boxX && noteY < boxBottom && noteBottom > boxY) {
            selectedNotesIds.add(n.id);
            const el = document.getElementById(n.id);
            if (el) el.classList.add('selected');
        }
    });
}

// Trascinando sulla timeline o alterando note
window.addEventListener('mousemove', (e) => {
    if (isSelecting) {
        const rect = layerEl.getBoundingClientRect();
        let currentX = e.clientX - rect.left;
        let currentY = e.clientY - rect.top;
        if (currentX < 0) currentX = 0;
        if (currentY < 0) currentY = 0;

        const x = Math.min(selectionStartX, currentX);
        const y = Math.min(selectionStartY, currentY);
        const w = Math.abs(selectionStartX - currentX);
        const h = Math.abs(selectionStartY - currentY);

        selectionBoxEl.style.left = `${x}px`;
        selectionBoxEl.style.top = `${y}px`;
        selectionBoxEl.style.width = `${w}px`;
        selectionBoxEl.style.height = `${h}px`;

        updateSelectionBox(x, y, w, h);
        return;
    }

    if (resizingNoteId) {
        // Logica Allungamento Gruppo di Note
        const noteObj = notesData.find(n => n.id === resizingNoteId);
        const originalMaster = selectedNotesOriginals.find(no => no.id === resizingNoteId);

        if (noteObj && originalMaster) {
            const rect = bgEl.getBoundingClientRect(); // Coordinate della griglia
            const x = e.clientX - rect.left;

            // Troviamo quanti step interamente o parzialmente stiamo toccando col mouse calcolando dall'inizio assoluto
            const rawEndStep = x / config.stepWidth;

            // Se si tiene premuto ALT, lo spostamento è libero e continuo, altrimenti usa lo snap magnetico
            const endStep = e.altKey ? rawEndStep : getRoundSnappedStep(rawEndStep);

            // Calcolo la variazioni di lunghezza rispetto all'originale master
            let deltaLength = endStep - originalMaster.startStep - originalMaster.lengthSteps;

            // Trovo il deltaLength minimo per evitare che una nota del gruppo diventi più corta di un certo limite
            // Se è libero (alt) permettiamo lunghezze bassissime (es 0.2), altrimenti il limite minimo è 1 step
            const minNoteLength = e.altKey ? 0.2 : 1;
            let minAllowedLengthDelta = -Infinity;
            selectedNotesOriginals.forEach(o => {
                const limit = minNoteLength - o.lengthSteps;
                if (limit > minAllowedLengthDelta) minAllowedLengthDelta = limit;
            });
            if (deltaLength < minAllowedLengthDelta) deltaLength = minAllowedLengthDelta;

            // Trovo il deltaLength massimo per non sfondare oltre al limite totale della griglia ritmica (64 step)
            let maxAllowedLengthDelta = Infinity;
            selectedNotesOriginals.forEach(o => {
                const limit = config.totalSteps - o.startStep - o.lengthSteps;
                if (limit < maxAllowedLengthDelta) maxAllowedLengthDelta = limit;
            });
            if (deltaLength > maxAllowedLengthDelta) deltaLength = maxAllowedLengthDelta;

            // Adesso applico il deltaLength valido a tutte le note del gruppo
            selectedNotesOriginals.forEach(o => {
                const no = notesData.find(nx => nx.id === o.id);
                if (no) {
                    const newLength = o.lengthSteps + deltaLength;
                    if (no.lengthSteps !== newLength) {
                        no.lengthSteps = newLength;
                        const noteEl = document.getElementById(no.id);
                        if (noteEl) noteEl.style.width = `${no.lengthSteps * config.stepWidth}px`;
                    }
                }
            });
        }
        return; // Ferma l'esecuzione se stavamo "resizing", non facciamo altro
    }

    if (movingNoteId) {
        // Logica Spostamento Gruppo di Note
        const noteObj = notesData.find(n => n.id === movingNoteId);
        const originalMaster = selectedNotesOriginals.find(no => no.id === movingNoteId);

        if (noteObj && originalMaster) {
            // Trova la coordinata ritmica in orizzontale
            const rect = bgEl.getBoundingClientRect();
            const x = e.clientX - rect.left;

            const rawHoverStep = x / config.stepWidth;
            let newStartStep = rawHoverStep - movingNoteOffsetX;

            // Se tieni premuto alt lo spostamento è fluido, altrimenti è magnetico
            if (!e.altKey) {
                newStartStep = getRoundSnappedStep(newStartStep);
            }

            let deltaStep = newStartStep - originalMaster.startStep;

            // Trova i limiti orizzontali e verticali del gruppo intero per non sbordare
            let minStepStart = Infinity;
            let maxStepEnd = 0;
            let minPitch = Infinity;
            let maxPitch = 0;
            selectedNotesOriginals.forEach(o => {
                if (o.startStep < minStepStart) minStepStart = o.startStep;
                if (o.startStep + o.lengthSteps > maxStepEnd) maxStepEnd = o.startStep + o.lengthSteps;
                if (o.pitch < minPitch) minPitch = o.pitch;
                if (o.pitch > maxPitch) maxPitch = o.pitch;
            });

            if (minStepStart + deltaStep < 0) { deltaStep = -minStepStart; }
            if (maxStepEnd + deltaStep > config.totalSteps) { deltaStep = config.totalSteps - maxStepEnd; }

            // Trova la variazione in verticale
            const newPitchMaster = getPitchFromMouse(e);
            let deltaPitch = newPitchMaster - originalMaster.pitch;
            const endNote = config.startNote + (config.octaves * 12) - 1;

            if (minPitch + deltaPitch < config.startNote) { deltaPitch = config.startNote - minPitch; }
            if (maxPitch + deltaPitch > endNote) { deltaPitch = endNote - maxPitch; }

            // Prova a calcolare la nuova posizione di tutte e vedi se sbattono contro muri o altre note
            const toUpdate = selectedNotesOriginals.map(o => ({
                id: o.id,
                newPitch: o.pitch + deltaPitch,
                newStartStep: o.startStep + deltaStep
            }));

            const conflict = toUpdate.some(u => {
                return notesData.some(nd => !selectedNotesIds.has(nd.id) && nd.pitch === u.newPitch && nd.startStep === u.newStartStep);
            });

            if (!conflict) {
                let pitchChandedForMaster = false;

                toUpdate.forEach(u => {
                    const no = notesData.find(nx => nx.id === u.id);
                    if (no.pitch !== u.newPitch) {
                        if (no.id === movingNoteId) pitchChandedForMaster = true;
                    }

                    no.pitch = u.newPitch;
                    no.startStep = u.newStartStep;

                    const noteEl = document.getElementById(no.id);
                    if (noteEl) {
                        const distanceFromTop = endNote - no.pitch;
                        noteEl.style.top = `${distanceFromTop * config.keyHeight}px`;
                        noteEl.style.left = `${no.startStep * config.stepWidth}px`;
                    }
                });

                if (pitchChandedForMaster) {
                    playSynth(originalMaster.pitch + deltaPitch, 0.15); // Suona solo una nota come anteprima per non assordare
                }
            }
        }
        return; // Fermiamoci qui
    }

    if (isDraggingTimeline && isLoopActive) {
        // Logica Timeline Elastica (Selezione Loop)
        const step = getStepFromMouse(e);
        if (step >= timelineDragAnchor) {
            loopStartStep = timelineDragAnchor;
            loopEndStep = step + currentQuantization; // Raccoglie in avanti rispettando la griglia
        } else {
            loopStartStep = step;
            loopEndStep = timelineDragAnchor + currentQuantization; // Raccoglie all'indietro rispettando la griglia
        }
        updateTimelineUI();
    }
});
//* #endregion