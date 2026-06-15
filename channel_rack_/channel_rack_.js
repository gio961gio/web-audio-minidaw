const audioCtx = (window.parent && window.parent.masterAudioCtx) ? window.parent.masterAudioCtx : new (window.AudioContext || window.webkitAudioContext)();

// --- MODEL ---
// Contains the configuration and current state of the sequencer.
let bpm = 120;
let numSteps = 16;
let isPlaying = false;
let currentStep = 0;
let nextNoteTime = 0.0;
const lookahead = 25.0;
const scheduleAheadTime = 0.1;
let timerID = null;
let quantization = 1.0; // Default value: 1/16 (1 step = 1/4 of a beat)

// === MINIDAW INTEGRATION ===
let currentPatternId = null;

function notifyMinidaw() {
    if (window.parent) { // if the channel rack is in the minidaw
        const patternSteps = tracks.map(t => t.steps); //create a logic array (if a step is active or not)
        const trackNamesList = tracks.map(t => t.nameDisplay.textContent !== "TRASCINA QUI" ? t.nameDisplay.textContent : "Empty");
        window.parent.postMessage({
            type: 'update-channel-rack',
            patternId: currentPatternId,
            steps: patternSteps,
            totalSteps: numSteps,
            trackNames: trackNamesList
        }, '*');
    }
}

window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data) return;

    if (data.type === 'load-pattern') {
        currentPatternId = data.patternId;
        const pattern = data.pattern;

        if (pattern.stepsData) {  //draw the steps and update the model (based on patterns information)
            updateTracksAmount(Math.max(tracks.length, pattern.stepsData.length));
            pattern.stepsData.forEach((trackSteps, i) => {
                if (tracks[i]) {
                    for (let s = 0; s < numSteps && s < trackSteps.length; s++) {
                        tracks[i].steps[s] = trackSteps[s];
                    }
                    tracks[i].initGrid();
                }
            });
        } else {
            // if pattern is empty
            tracks.forEach(t => {
                t.steps = Array(numSteps).fill(false); //clean the steps
                t.initGrid();
            });
        }
    } else if (data.type === 'play-step-from-pattern') { //every step
        const step = data.step;
        const patternSteps = data.patternSteps;
        tracks.forEach((track, i) => {
            const stepActive = patternSteps[i] && patternSteps[i][step];
            track.play(audioCtx.currentTime, step, stepActive);
        });
    } else if (data.type === 'set-bpm') {
        bpmInput.value = data.bpm;
        bpm = data.bpm;
    }
});

// --- VIEW (Global DOM References) ---
// Links to interface elements defined in HTML.
const container = document.getElementById('sequencer-container');
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const bpmInput = document.getElementById('bpmInput');
const stepsInput = document.getElementById('stepsInput');
const tracksInput = document.getElementById('tracksInput');
const quantizationSelect = document.getElementById('quantizationSelect');

// --- VIEW & MODEL (Track Component) ---
// Class that manages both track data and its visual representation.
class Track {
    constructor(id) {
        this.id = id;
        this.sampleBuffer = null;
        this.steps = Array(numSteps).fill(false);
        this.stepElements = [];
        this.lastStepVisible = -1;

        this.mixerGainNode = window.createMixerFX ? window.createMixerFX(audioCtx, id) : audioCtx.createGain();
        if (!window.createMixerFX) this.mixerGainNode.connect(audioCtx.destination);

        this.createDOM();
    }

    createDOM() { //create the html elements of the track
        // Track row
        const row = document.createElement('div');
        row.classList.add('track-row');

        // Drop Zone
        const dropZone = document.createElement('div');
        dropZone.classList.add('drop-zone');

        const nameDisplay = document.createElement('p');
        nameDisplay.classList.add('sample-name');
        nameDisplay.textContent = "TRASCINA QUI";
        dropZone.appendChild(nameDisplay);

        // Drop Management
        dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
        dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
        dropZone.ondrop = async (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');

            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));

            for (let i = 0; i < files.length; i++) {
                const targetTrackIndex = this.id + i;
                if (tracks[targetTrackIndex]) {
                    await tracks[targetTrackIndex].loadFile(files[i]);
                }
            }
        };

        // Grid
        const grid = document.createElement('div');
        grid.classList.add('sequencer-grid');

        row.appendChild(dropZone);
        row.appendChild(grid);
        container.appendChild(row);

        this.rowElement = row;
        this.gridElement = grid;
        this.nameDisplay = nameDisplay;
        this.initGrid();
    }

    async loadFile(file) {
        if (!file) return;
        const arrayBuffer = await file.arrayBuffer();
        this.sampleBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        this.nameDisplay.textContent = file.name.toUpperCase();
        this.nameDisplay.style.color = "#00ff88";
        notifyMinidaw(); // Notify mixer about new sample name
    }

    removeDOM() {
        if (this.rowElement) {
            container.removeChild(this.rowElement);
        }
        if (this.mixerGainNode && this.mixerGainNode.destroyFX) {
            this.mixerGainNode.destroyFX();
        }
    }

    initGrid() {
        this.gridElement.innerHTML = '';
        this.stepElements = [];
        for (let i = 0; i < numSteps; i++) {
            const btn = document.createElement('button');
            btn.classList.add('step');

            // Visual logic for quantization
            // Groups of 4 for 1/16, or otherwise based on "beats"
            const stepsPerBeat = 4 / quantization;
            if (Math.floor(i / stepsPerBeat) % 2 === 0) {
                btn.style.opacity = "1";
            } else {
                btn.style.opacity = "0.7";
            }

            if (this.steps[i]) btn.classList.add('active');

            btn.onpointerdown = (e) => {
                this.steps[i] = !this.steps[i];
                btn.classList.toggle('active', this.steps[i]);
                notifyMinidaw();
                e.preventDefault();
            };

            this.gridElement.appendChild(btn);
            this.stepElements.push(btn);
        }
    }

    updateSteps(newNum) {
        const oldSteps = this.steps;
        this.steps = Array(newNum).fill(false);
        for (let i = 0; i < Math.min(oldSteps.length, newNum); i++) {
            this.steps[i] = oldSteps[i];
        }
        this.initGrid();
    }

    remapSteps(ratio, newNumSteps) {
        const oldSteps = this.steps;
        this.steps = Array(newNumSteps).fill(false);
        for (let i = 0; i < oldSteps.length; i++) {
            if (oldSteps[i]) {
                const newIndex = Math.round(i * ratio);
                if (newIndex < newNumSteps) {
                    this.steps[newIndex] = true;
                }
            }
        }
        this.initGrid();
    }

    play(time, stepIndex, forceActive = null) {
        const isActive = forceActive !== null ? forceActive : this.steps[stepIndex];
        if (isActive && this.sampleBuffer) {
            const source = audioCtx.createBufferSource();
            source.buffer = this.sampleBuffer;
            source.connect(this.mixerGainNode);
            source.start(time);
        }

        // Visual feedback
        const drawTime = (time - audioCtx.currentTime) * 1000;
        setTimeout(() => {
            // If we pressed STOP in the meantime, do nothing (the playhead must disappear)
            // If we are in PAUSE, we want the last highlight to remain, so we allow the update
            // but only if the stop did not occur. 
            // We introduce a distinction: if currentStep is 0 and we are not playing, it is probably a stop.
            if (!isPlaying && currentStep === 0) return;

            if (this.lastStepVisible !== -1 && this.stepElements[this.lastStepVisible]) {
                this.stepElements[this.lastStepVisible].classList.remove('playing');
            }
            if (this.stepElements[stepIndex]) {
                this.stepElements[stepIndex].classList.add('playing');
                this.lastStepVisible = stepIndex;
            }
        }, drawTime > 0 ? drawTime : 0);
    }

    clearVisuals() {
        this.stepElements.forEach(el => el.classList.remove('playing'));
        this.lastStepVisible = -1;
    }
}

// Track initialization
let tracks = [];
function updateTracksAmount(newAmount) {
    if (newAmount > tracks.length) {
        // Add tracks
        for (let i = tracks.length; i < newAmount; i++) {
            tracks.push(new Track(i));
        }
    } else if (newAmount < tracks.length) {
        // Remove tracks
        const removed = tracks.splice(newAmount);
        removed.forEach(t => t.removeDOM());
    }
}

// Initial initialization
updateTracksAmount(4);

// --- CONTROLLER (Audio Engine and Timing) ---
// Manages timing precision and scheduling of audio notes.
function nextNote() {
    const secondsPerBeat = 60.0 / bpm;
    // The next note depends on the quantization
    // Base unit 1/16 = 0.25 beat. 1/8 = 0.5 beat. 1/4 = 1 beat.
    nextNoteTime += 0.25 * quantization * secondsPerBeat;

    currentStep++;
    if (currentStep >= numSteps) {
        currentStep = 0;
    }
}

function scheduleNote(stepNumber, time) {
    tracks.forEach(track => track.play(time, stepNumber));
}

function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
        scheduleNote(currentStep, nextNoteTime);
        nextNote();
    }
    timerID = setTimeout(scheduler, lookahead);
}

// --- CONTROLLER (User Input Management) ---
// Manages transport commands, text input, and global interactions.
playBtn.onclick = () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();

    if (!isPlaying) {
        isPlaying = true;
        nextNoteTime = audioCtx.currentTime + 0.05;
        scheduler();
        playBtn.textContent = "PAUSE";
    } else {
        isPlaying = false;
        clearTimeout(timerID);
        playBtn.textContent = "PLAY";
        // Do NOT call clearVisuals here, so the highlight remains frozen on the current step
    }
};

stopBtn.onclick = () => {
    // If playing, stop the timer
    if (isPlaying) {
        isPlaying = false;
        clearTimeout(timerID);
    }

    // Always reset the position and the interface
    currentStep = 0;
    playBtn.textContent = "PLAY";
    tracks.forEach(t => t.clearVisuals());
};

bpmInput.oninput = (e) => {
    const val = parseInt(e.target.value);
    if (val >= 40 && val <= 240) bpm = val;
};

stepsInput.onchange = (e) => {
    const val = parseInt(e.target.value);
    if (val > 0) {
        numSteps = val;
        tracks.forEach(t => t.updateSteps(numSteps));
        if (currentStep >= numSteps) currentStep = 0;
        notifyMinidaw();
    }
};

tracksInput.onchange = (e) => {
    const val = parseInt(e.target.value);
    if (val > 0 && val <= 16) {
        updateTracksAmount(val);
        notifyMinidaw();
    }
};

quantizationSelect.onchange = (e) => {
    const newQuant = parseFloat(e.target.value);
    const ratio = quantization / newQuant;

    // Update numSteps to maintain the same musical duration (e.g., 1 bar)
    const newNumSteps = Math.round(numSteps * ratio);

    // IMPORTANT: Update numSteps and quantization before calling remapSteps, 
    // since initGrid() (called internally by remapSteps) uses global values.
    numSteps = newNumSteps;
    stepsInput.value = numSteps;
    quantization = newQuant;

    tracks.forEach(t => t.remapSteps(ratio, newNumSteps));

    // Reset the position to avoid sudden jumps out of range
    currentStep = 0;
    notifyMinidaw();
};

// Context menu
window.oncontextmenu = (e) => e.preventDefault();

// === SAVE / LOAD STATE ===
window.getInstrumentState = function () {
    const serializedTracks = tracks.map(t => {
        let serializedBuffer = null;
        if (t.sampleBuffer && window.parent && window.parent.audioBufferToBase64) {
            serializedBuffer = window.parent.audioBufferToBase64(t.sampleBuffer);
        }
        return {
            name: t.nameDisplay.textContent,
            buffer: serializedBuffer
        };
    });

    return {
        bpm: bpm,
        numSteps: numSteps,
        quantization: quantization,
        tracksAmount: tracks.length,
        tracks: serializedTracks
    };
};

window.setInstrumentState = async function (state) {
    if (!state) return;

    if (state.bpm) {
        bpm = state.bpm;
        bpmInput.value = bpm;
    }
    if (state.numSteps) {
        numSteps = state.numSteps;
        stepsInput.value = numSteps;
    }
    if (state.quantization) {
        quantization = state.quantization;
        quantizationSelect.value = quantization.toString();
    }
    if (state.tracksAmount) {
        updateTracksAmount(state.tracksAmount);
        tracksInput.value = state.tracksAmount;
    }

    if (state.tracks) {
        for (let i = 0; i < Math.min(tracks.length, state.tracks.length); i++) {
            const trackState = state.tracks[i];
            if (trackState.name) {
                tracks[i].nameDisplay.textContent = trackState.name;
                if (trackState.name !== "TRASCINA QUI") {
                    tracks[i].nameDisplay.style.color = "#00ff88";
                }
            }
            if (trackState.buffer) {
                try {
                    let buffer;
                    if (typeof trackState.buffer === "string" && window.parent && window.parent.base64ToAudioBuffer) {
                        buffer = await window.parent.base64ToAudioBuffer(trackState.buffer, audioCtx);
                    } else {
                        buffer = trackState.buffer;
                    }
                    tracks[i].sampleBuffer = buffer;
                } catch (e) {
                    console.error('Error decoding channel rack buffer', e);
                }
            }
        }
        notifyMinidaw();
    }
};