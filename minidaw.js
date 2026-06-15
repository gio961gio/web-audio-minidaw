// === CONFIGURATION (Model-like) ===
const config = {
    totalSteps: 256,          // Total length of the playlist (e.g., 16 bars)
    stepWidth: 40,           // Width of a single step (16th note)
    trackHeight: 80,         // Height of each track
    tracks: 2,               // Due tracce come richiesto
    patternLength: 16,       // Length of a single pattern clip in steps
    instruments: [
        { id: 'synth_additive', name: 'Synth Additive', path: 'synth_additive_/synth_additive_.html', icon: '🎹' },
        { id: 'sampler', name: 'Sampler', path: 'sampler_/sampler_.html', icon: '📻' },
        { id: 'drum_rack', name: 'Drum Rack', path: 'drum_rack_/drum_rack_.html', icon: '🥁' },
        { id: 'channel_rack', name: 'Channel Rack', path: 'channel_rack_/channel_rack_.html', icon: '🎛️' },
        { id: 'audio_track', name: 'Audio Track', path: 'audio_track_/audio_track_.html', icon: '🎤' }
    ]
};

// === AUDIO CONTEXT ===
const masterAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
window.masterAudioCtx = masterAudioCtx; // Expose to iframes

// Setup Global Recording Bus
window.masterRecordingBus = masterAudioCtx.createGain(); // Bus globale a cui si collegano tutti gli strumenti

// Setup Global Master Limiter to prevent digital clipping when multiple tracks sum
window.globalMasterLimiter = masterAudioCtx.createDynamicsCompressor();
window.globalMasterLimiter.threshold.value = -0.5; // limit just below 0 dB
window.globalMasterLimiter.knee.value = 0.0; // hard knee
window.globalMasterLimiter.ratio.value = 20.0; // brickwall
window.globalMasterLimiter.attack.value = 0.005; // 5ms attack
window.globalMasterLimiter.release.value = 0.050; // 50ms release

window.masterRecordingBus.connect(window.globalMasterLimiter);
window.globalMasterLimiter.connect(masterAudioCtx.destination); // Route everything out to speakers

// === GLOBAL MASTER ANALYSER (captures the TRUE summed signal from ALL tracks) ===
const globalMasterAnalyser = masterAudioCtx.createAnalyser();
globalMasterAnalyser.fftSize = 2048;
window.masterRecordingBus.connect(globalMasterAnalyser);
const globalMasterTimeData = new Float32Array(globalMasterAnalyser.frequencyBinCount);
const globalMasterFreqData = new Uint8Array(globalMasterAnalyser.frequencyBinCount);

const audioCtx = masterAudioCtx; // minidaw.js can just reuse it directly 

/**
 * Utility to get frequency from midi note
 */
function getFrequency(midiNote) {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Basic Synth for Playlist playback
 */
/**
 * Route note trigger to the Synth Additive instrument
 */
function triggerNote(midi, keyId, trackIndex) {
    if (soloedTracks.size > 0 && !soloedTracks.has(trackIndex)) return;  //if there is a soloed track, return if the track is not soloed

    const frame = trackFrames[trackIndex];
    if (frame && frame.dataset.loaded === "true") {
        frame.contentWindow.postMessage({
            type: 'note-on',
            midi: midi, // MIDI note number
            key: keyId // Used in FIFO in poliphony.
        }, '*'); // asterisk means we're not checking origins 
    }
}

function releaseNote(midi, keyId, trackIndex) {
    const frame = trackFrames[trackIndex];
    if (frame && frame.dataset.loaded === "true") {
        frame.contentWindow.postMessage({
            type: 'note-off',
            midi: midi,
            key: keyId
        }, '*');
    }
}

function stopAllInstrumentNotes() {
    trackFrames.forEach(frame => {
        if (frame && frame.dataset.loaded === "true") {
            frame.contentWindow.postMessage({ type: 'stop-all' }, '*');
        }
    });

    if (elements.drumRackFrame && elements.drumRackFrame.contentWindow) {
        elements.drumRackFrame.contentWindow.postMessage({ type: 'stop-all' }, '*');
    }

    if (typeof stopAllAudioClips === 'function') stopAllAudioClips(); //For the audio track clips // Guard against missing audio functionality 
}

/**
 * Checks which tracks should be silenced due to Solo functionality 
 * and sends them a stop-all message immediately.
 */
function updateTrackMutes() {
    for (let trackIndex = 0; trackIndex < config.tracks; trackIndex++) {
        const isMuted = soloedTracks.size > 0 && !soloedTracks.has(trackIndex);
        if (isMuted) {
            const frame = trackFrames[trackIndex];
            if (frame && frame.dataset.loaded === "true") {
                frame.contentWindow.postMessage({ type: 'stop-all' }, '*');
            }
        }
    }
}

// === STATE ===
let trackInstrumentIds = Array(config.tracks).fill(config.instruments[0].id);
let trackTypes = Array(config.tracks).fill('piano_roll'); // Default to piano roll
let trackNames = Array(config.tracks).fill(null).map((_, i) => `Track ${i + 1}`);
let trackColors = Array(config.tracks).fill('#3b82f6');
let trackFrames = []; // To store created iframes for each track
let mixerState = Array(config.tracks).fill(null).map(() => ({ main: 1.0, subs: [], names: [] }));
let currentEditingTrackIndex = 0;
let isLoopActive = false;
let isMetronomeActive = false;
let loopStartStep = 0;
let loopEndStep = 16;
let isDraggingTimeline = false;
let timelineDragAnchor = 0;
let customStartStep = 0;

let currentStep = 0;
let isPlaying = false;
let bpm = 125;
let currentQuantization = 1; // Default 1/16 (1 step)
let intervalId = null;

let draggingClipId = null;
let dragOffsetSteps = 0;

let resizingClipId = null;
let resizeStartX = 0;
let resizeStartLength = 0;
let isWarpResize = false; // true when Shift is held during resize = warp mode
let warpStartLength = 0;

let multiDragInitialPositions = {}; // { clipId: { startStep, trackIndex } } for multi-drag

// Rubber-band (lasso) selection state
let isRubberBanding = false;
let rubberBandStartX = 0;
let rubberBandStartY = 0;
let rubberBandMouseStartX = 0;
let rubberBandMouseStartY = 0;
let rubberBandPending = false;
let rubberBandTrackIndex = 0;
let rubberBandEl = null;

let audioBufferDict = new Map(); // Store audio buffers globally for undo ("Reference Counting" is not implemented)
let audioFileHandles = new Map(); // bufferId -> FileSystemFileHandle (for re-access on load)
let audioFileNames = new Map();   // bufferId -> original filename

let playlistClips = [];      // { id, trackIndex, startStep, length, patternId, etc }
let instrumentStates = [];   // { state object mapping to each track index }
let selectedClipIds = new Set();   //NO duplicates in the list (since you can't select the same clip twice!). It also offers good performance in lookup 
let clipboardClips = [];
let undoStack = [];
let redoStack = [];
let previousStateJSON = "[]";
let selectedPatternId = 1;
let isPainting = false;
let isErasing = false;

// CONTATORI GLOBALI
let clipCounter = 0;
let trackCounter = config.tracks + 1; // Gestisce nomi progressivi unici (es. Track 3, Track 4)

// === PATTERN DATA (Connecting to Piano Roll & Drum Rack) ===
const patterns = {
    1: {
        name: "Pattern 1", type: "piano_roll", color: "#3b82f6", totalSteps: 64, targetTrack: 0, notes: [ //full of dummy datas
            { id: "note_0", pitch: 60, startStep: 0, lengthSteps: 1 },
            { id: "note_1", pitch: 64, startStep: 4, lengthSteps: 1 },
            { id: "note_2", pitch: 67, startStep: 8, lengthSteps: 1 },
            { id: "note_3", pitch: 72, startStep: 12, lengthSteps: 1 }
        ]
    },
    2: {
        name: "Pattern 2", type: "piano_roll", color: "#10b981", totalSteps: 64, targetTrack: 1, notes: [
            { id: "note_4", pitch: 60, startStep: 0, lengthSteps: 4 },
            { id: "note_5", pitch: 62, startStep: 4, lengthSteps: 4 },
            { id: "note_6", pitch: 60, startStep: 8, lengthSteps: 4 },
            { id: "note_7", pitch: 59, startStep: 12, lengthSteps: 4 }
        ]
    },
    3: {
        name: "Pattern 3", type: "piano_roll", color: "#f59e0b", totalSteps: 64, targetTrack: null, notes: [
            { id: "note_8", pitch: 67, startStep: 0, lengthSteps: 2 },
            { id: "note_9", pitch: 67, startStep: 2, lengthSteps: 2 },
            { id: "note_10", pitch: 69, startStep: 8, lengthSteps: 4 },
            { id: "note_11", pitch: 67, startStep: 12, lengthSteps: 4 }
        ]
    },
    4: {
        name: "Pattern 4", type: "piano_roll", color: "#ec4899", totalSteps: 64, targetTrack: null, notes: [
            { id: "note_12", pitch: 48, startStep: 0, lengthSteps: 16 }
        ]
    }
};

window.addEventListener('message', e => {   //event was triggered from the iframes (through postMessage)
    if (e.data && e.data.type === 'create-automation') { //if postMessage type is create-automation
        const { paramId, paramName, min, max } = e.data;  //Destructuring 

        // Find which track this came from
        let sourceTrackIndex = 0; // Default to track 0 if not found
        for (let i = 0; i < config.tracks; i++) {
            if (trackFrames[i] && trackFrames[i].contentWindow === e.source) {
                sourceTrackIndex = i;
                break;
            }
        }

        // Generate an automation clip
        const clipId = `clip_auto_${clipCounter++}`;
        const newClip = {
            id: clipId,
            type: 'automation',
            paramId: paramId,
            paramName: paramName,
            paramMin: min,
            paramMax: max,
            trackIndex: sourceTrackIndex,
            startStep: currentStep,
            length: 16, // Default 1 bar
            nodes: [
                { timePct: 0, valuePct: 0.5 }, //Horizontal pos % and vertical val % 
                { timePct: 1, valuePct: 0.5 }
            ],
            color: '#c084fc' // Purple for automations
        };

        playlistClips.push(newClip);

        // Ensure the track lane is expanded to show the new clip
        trackExpandedLanes[sourceTrackIndex] = true;
        rebuildTracksUI();  //Rendering the whole UI

        checkAndSavePlaylistState(); //Saving the state(for undo/redo)
    }
});

let currentEditingPatternId = null; // Traccia il pattern aperto nel piano roll
let soloedTracks = new Set();
let trackExpandedLanes = {}; // { trackIndex: true/false }
let trackOffsetsY = []; // [y0, y1, y2...]
let automationLaneHeight = 60; // Default height for automation sub-lanes (resizable)
const mixerAutomationCallbacks = {}; // For mixer EQ automation routing

function getAutomationLanes(trackIdx) {  //Useful for grouping automations clips for the same parameter
    const autos = playlistClips.filter(c => c.type === 'automation' && c.trackIndex === trackIdx);
    const map = new Map(); //because we need unique keys (without duplicates)
    autos.forEach(c => map.set(c.paramId, c.paramName));
    return Array.from(map.entries()).map(([id, name]) => ({ paramId: id, paramName: name })); //returns an array (for performance in iterations)
}

function computeTrackLayouts() {
    trackOffsetsY = [];
    let currentY = 0;
    for (let i = 0; i < config.tracks; i++) {
        trackOffsetsY[i] = currentY;
        const lanes = getAutomationLanes(i);
        const isExpanded = trackExpandedLanes[i] === true;
        const height = config.trackHeight + (isExpanded ? lanes.length * automationLaneHeight : 0);
        currentY += height;
    }
    return currentY; // returns total height
}

// === DOM ELEMENTS ===
const elements = {
    trackLabels: document.getElementById('trackLabels'),
    tracksLayer: document.getElementById('tracksLayer'),
    gridBackground: document.getElementById('gridBackground'),
    timeline: document.getElementById('timeline'),
    playhead: document.getElementById('playhead'),
    playBtn: document.getElementById('playBtn'),
    stopBtn: document.getElementById('stopBtn'),
    gridScrollArea: document.getElementById('gridScrollArea'),
    prevPattern: document.getElementById('prevPattern'),
    nextPattern: document.getElementById('nextPattern'),
    patternName: document.getElementById('patternName'),
    patternColorDot: document.getElementById('patternColorDot'),
    addPatternBtn: document.getElementById('addPatternBtn'),
    deletePatternBtn: document.getElementById('deletePatternBtn'),
    pianoRollModal: document.getElementById('pianoRollModal'),
    pianoRollFrame: document.getElementById('pianoRollFrame'),
    closePianoRoll: document.getElementById('closePianoRoll'),
    modalPatternTitle: document.getElementById('modalPatternTitle'),

    // modal choice
    choiceModal: document.getElementById('choiceModal'),
    choiceModalTitle: document.getElementById('choiceModalTitle'),
    choicePianoRollBtn: document.getElementById('choicePianoRollBtn'),
    choiceDrumRackBtn: document.getElementById('choiceDrumRackBtn'),
    choiceChannelRackBtn: document.getElementById('choiceChannelRackBtn'),
    choiceAudioTrackBtn: document.getElementById('choiceAudioTrackBtn'),
    choiceCancelBtn: document.getElementById('choiceCancelBtn'),
    bpmInput: document.getElementById('bpmInput'),
    instrumentModal: document.getElementById('instrumentModal'),
    instrumentFramesContainer: document.getElementById('instrumentFramesContainer'),
    closeInstrument: document.getElementById('closeInstrument'),
    gridSelect: document.getElementById('gridSelect'),
    loopBtn: document.getElementById('loopBtn'),
    metronomeBtn: document.getElementById('metronomeBtn'),
    loopRegion: document.getElementById('loopRegion'),
    addTrackBtn: document.getElementById('addTrackBtn'),

    // mixer
    mixerBtn: document.getElementById('mixerBtn'),
    mixerModal: document.getElementById('mixerModal'),
    closeMixerBtn: document.getElementById('closeMixerBtn'),
    mixerStripsContainer: document.getElementById('mixerStripsContainer'),

    // project save/load
    saveProjectBtn: document.getElementById('saveProjectBtn'),
    loadProjectBtn: document.getElementById('loadProjectBtn'),
    loadProjectInput: document.getElementById('loadProjectInput'),

    // rendering
    renderBtn: document.getElementById('renderBtn'),
    renderModal: document.getElementById('renderModal'),
    closeRenderModal: document.getElementById('closeRenderModal'),
    startRenderBtn: document.getElementById('startRenderBtn'),
    stopRenderBtn: document.getElementById('stopRenderBtn'),
    renderProgressContainer: document.getElementById('renderProgressContainer'),
    renderProgressBar: document.getElementById('renderProgressBar'),
    renderTimerText: document.getElementById('renderTimerText')
};

/**
 * Initialize the Playlist Grid
 */
function initPlaylist() {
    // Filter clips to ensure they fit in the new track count
    playlistClips = playlistClips.filter(c => c.trackIndex < config.tracks); //Defensive programming: removes clips from tracks that don't exist anymore 

    elements.trackLabels.innerHTML = '';
    elements.tracksLayer.innerHTML = '';
    elements.instrumentFramesContainer.innerHTML = '';
    trackFrames = [];
    soloedTracks.clear();

    // Clear only markers, keep loopRegion (beacuse it already exists in HTML)
    Array.from(elements.timeline.children).forEach(child => {
        if (!child.classList.contains('loop-region')) child.remove();
    });

    const totalWidth = config.totalSteps * config.stepWidth;
    elements.timeline.style.width = `${totalWidth}px`;
    elements.gridBackground.style.width = `${totalWidth}px`;
    elements.tracksLayer.style.width = `${totalWidth}px`;
    elements.tracksLayer.oncontextmenu = (e) => e.preventDefault();


    // Timeline Interaction
    elements.timeline.onmousedown = (e) => {
        e.preventDefault();
        const step = getStepFromMouse(e);

        isDraggingTimeline = true;
        timelineDragAnchor = step;

        if (!isLoopActive) {
            // Modalità Semplice: Sposta la testina
            customStartStep = step;
            if (intervalId) {
                currentStep = step;
            }
        }
        // Deseleziona clip quando si clicca sul vuoto (timeline o grid)
        selectedClipIds.clear();
        updateClipsSelectionUI();
        updateTimelineUI();
    };
    elements.timeline.oncontextmenu = (e) => e.preventDefault();


    elements.loopBtn.onclick = () => {
        isLoopActive = !isLoopActive;
        elements.loopBtn.classList.toggle('active', isLoopActive);
        updateTimelineUI();
    };

    elements.metronomeBtn.onclick = () => {
        isMetronomeActive = !isMetronomeActive;
        elements.metronomeBtn.classList.toggle('active', isMetronomeActive);
    };


    for (let i = 0; i < config.tracks; i++) {
        createTrack(i + 1);
    }

    // Bar markers
    for (let i = 0; i < config.totalSteps; i += 16) {
        const barMarker = document.createElement('div');
        barMarker.className = 'bar-marker';
        barMarker.style.left = `${i * config.stepWidth}px`;
        barMarker.innerText = Math.floor(i / 16) + 1;
        elements.timeline.appendChild(barMarker);
    }

    updateGridStyle();
    initPatternPicker();
    updateTimelineUI(); // Ensure initial state is visible

    // Initialize Undo/Redo correctly
    undoStack = [];
    redoStack = [];
    previousStateJSON = serializePlaylistState(); //JSON conversion of the current state of the project and save
    console.log("[UndoSystem] Initialized with state:", previousStateJSON);
}

function rebuildTracksUI() {
    elements.trackLabels.innerHTML = '';
    elements.tracksLayer.innerHTML = '';

    for (let i = 0; i < config.tracks; i++) {
        createTrackUI(i);
    }

    updateGridStyle();

    playlistClips.forEach(clip => {
        renderClip(clip);
    });
}

function createTrack(index) {
    const trackIndex = index - 1;

    // Create an iframe for this track's instrument
    const frame = document.createElement('iframe');  //"iframe" type element
    const initialInst = config.instruments.find(i => i.id === trackInstrumentIds[trackIndex]); //find the instrument for this track
    frame.src = initialInst.path;
    frame.style.display = 'none'; // Hidden when modal is not focused on this track
    frame.dataset.trackIndex = trackIndex;
    frame.dataset.loaded = "false";
    frame.onload = () => { //Execute the function when the iframe is loaded
        frame.dataset.loaded = "true";
        syncBPMToPianoRoll();
        if (elements.mixerModal.style.display === 'flex') { //Il volume viene calcolato solo se il mixer è aperto (per mostrarlo nei meter)
            frame.contentWindow.postMessage({ type: 'set-mixer-visibility', visible: true }, '*');
        }
        frame.contentWindow.postMessage({ type: 'set-master-limiter', active: masterMixerState.limiter }, '*');

        // Restore instrument generic state manually if it has one (when you load a saved project)
        if (instrumentStates[trackIndex] && typeof frame.contentWindow.setInstrumentState === 'function') {
            frame.contentWindow.setInstrumentState(instrumentStates[trackIndex]);
        }

        // Restore mixer fx and volume (when you load a saved project)
        if (mixerState[trackIndex]) {
            const state = mixerState[trackIndex];
            if (trackTypes[trackIndex] === 'channel_rack') {  // Channel Rack type (has sub-tracks)
                if (state.subsFx) {
                    state.subsFx.forEach((fx, subIndex) => {
                        for (let k in fx) frame.contentWindow.postMessage({ type: 'set-mixer-fx', subIndex, fx: k, value: fx[k] }, '*');
                    });
                }
                if (state.subs) {
                    state.subs.forEach((v, subIndex) => frame.contentWindow.postMessage({ type: 'set-mixer-volume', subIndex, volume: v }, '*'));
                }
                if (state.subsPan) {
                    state.subsPan.forEach((pan, subIndex) => frame.contentWindow.postMessage({ type: 'set-mixer-pan', subIndex, pan }, '*'));
                }
            } else { // Single track type (no sub-tracks)
                if (state.mainFx) {
                    for (let k in state.mainFx) frame.contentWindow.postMessage({ type: 'set-mixer-fx', fx: k, value: state.mainFx[k] }, '*');
                }
                if (state.main !== undefined) {
                    frame.contentWindow.postMessage({ type: 'set-mixer-volume', volume: state.main }, '*');
                }
                if (state.pan !== undefined) {
                    frame.contentWindow.postMessage({ type: 'set-mixer-pan', pan: state.pan }, '*');
                }
            }
        }
        for (let k in masterMixerState) { //Iterate each key in masterMixerState object
            if (k !== 'limiter' && k !== 'volume') frame.contentWindow.postMessage({ type: 'set-master-fx', fx: k, value: masterMixerState[k] }, '*');
        }
        if (masterMixerState.volume !== undefined) frame.contentWindow.postMessage({ type: 'set-master-volume', volume: masterMixerState.volume }, '*');
    };
    elements.instrumentFramesContainer.appendChild(frame);
    trackFrames[trackIndex] = frame;

    createTrackUI(trackIndex);
}

function createTrackUI(trackIndex) {
    const wrapper = document.createElement('div'); //External container for the track
    wrapper.className = 'track-label-wrapper';

    const label = document.createElement('div');
    label.className = 'track-label';
    const typeIcon = trackTypes[trackIndex] === 'drum_rack' ? '🥁' : (trackTypes[trackIndex] === 'channel_rack' ? '🎛️' : (trackTypes[trackIndex] === 'audio_track' ? '🎤' : '🎹'));
    const trackColor = trackColors[trackIndex];
    label.style.borderLeftColor = trackColor;

    // Check automation lanes
    const lanes = getAutomationLanes(trackIndex);
    const hasLanes = lanes.length > 0;
    const isExpanded = trackExpandedLanes[trackIndex] === true;

    // Apply subtle background gradient based on track color
    label.style.background = `linear-gradient(90deg, ${trackColor}22 0%, transparent 100%)`;

    let expandBtnHTML = hasLanes
        ? `<button class="track-control-btn expand-btn" style="border:none; background:transparent; font-size: 0.7rem;">${isExpanded ? '▼' : '▶'}</button>`
        : '<div style="width: 24px;"></div>';

    label.innerHTML = `
        ${expandBtnHTML}
        <div class="track-color-dot" style="background-color: ${trackColor}; box-shadow: 0 0 8px ${trackColor}66; margin-left: -5px;">
            <input type="color" class="track-color-picker" value="${trackColor}" style="opacity: 0; position: absolute; width: 100%; height: 100%; cursor: pointer;">
        </div>
        <span class="track-type-icon" style="opacity: 0.6; font-size: 0.9rem;">${typeIcon}</span>
        <span class="track-name">${trackNames[trackIndex]}</span>
        <div class="track-controls" style="display: flex; gap: 5px; align-items: center;">
            <button class="track-control-btn sync-color-btn" title="Sync All Patterns on Track to this Color">🎨</button>
            <button class="track-control-btn solo-btn ${soloedTracks.has(trackIndex) ? 'active' : ''}" title="Solo">S</button>
            <button class="track-control-btn delete-track-btn" title="Delete Track">X</button>
            <div class="instrument-selector-wrapper" style="position: relative;">
                <button class="track-instrument-btn" id="openInstrumentBtn" title="Choose/Edit Instrument">🎹</button>
                <div class="instrument-dropdown" id="instrumentDropdown"></div>
            </div>
        </div>
    `;

    const syncColorBtn = label.querySelector('.sync-color-btn');
    const colorPicker = label.querySelector('.track-color-picker');
    const colorDot = label.querySelector('.track-color-dot');
    const expandBtn = label.querySelector('.expand-btn');

    if (expandBtn) {
        expandBtn.onclick = (e) => {
            e.stopPropagation(); //Stop the event from propagating to the parents
            trackExpandedLanes[trackIndex] = !trackExpandedLanes[trackIndex];
            rebuildTracksUI();
        };
    }

    syncColorBtn.onclick = (e) => {
        e.stopPropagation();
        const trackColor = trackColors[trackIndex];

        // Handle patterns on this track
        const patternsOnTrack = [...new Set(playlistClips.filter(c => c.trackIndex === trackIndex && c.type !== 'automation' && c.patternId !== undefined).map(c => c.patternId))];
        patternsOnTrack.forEach(pid => {
            if (patterns[pid]) {
                patterns[pid].color = trackColor;
                refreshPatternClips(pid);
            }
        });

        // Handle audio clips on this track
        playlistClips.filter(c => c.trackIndex === trackIndex && c.type === 'audio').forEach(clip => {
            clip.color = trackColor;
            const el = document.getElementById(clip.id);
            if (el) el.remove();
            renderClip(clip);
        });

        if (patternsOnTrack.includes(parseInt(selectedPatternId))) updatePatternPickerDisplay();
    };

    colorPicker.oninput = (e) => {
        const newColor = e.target.value;
        trackColors[trackIndex] = newColor;
        colorDot.style.backgroundColor = newColor;
        colorDot.style.boxShadow = `0 0 8px ${newColor}66`;
        label.style.borderLeftColor = newColor;
        label.style.background = `linear-gradient(90deg, ${newColor}22 0%, transparent 100%)`;
        if (elements.mixerModal.style.display === 'flex') renderMixer();
    };

    const nameSpan = label.querySelector('.track-name');
    nameSpan.ondblclick = () => {
        const oldName = trackNames[trackIndex];
        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldName;
        input.className = 'rename-input';
        nameSpan.replaceWith(input);
        input.focus();
        input.select();

        const save = () => {
            const newName = input.value.trim() || oldName;
            trackNames[trackIndex] = newName;
            const newSpan = document.createElement('span');
            newSpan.className = 'track-name';
            newSpan.innerText = newName;
            newSpan.ondblclick = nameSpan.ondblclick;
            input.replaceWith(newSpan);
            if (elements.mixerModal.style.display === 'flex') renderMixer();
        };
        input.onblur = save;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') { input.value = oldName; save(); }
        };
    };

    wrapper.appendChild(label);

    const soloBtn = label.querySelector('.solo-btn');
    const deleteBtn = label.querySelector('.delete-track-btn');
    const instrumentBtn = label.querySelector('.track-instrument-btn');
    const dropdown = label.querySelector('#instrumentDropdown');

    soloBtn.onclick = (e) => {
        e.stopPropagation();
        if (soloedTracks.has(trackIndex)) {
            soloedTracks.delete(trackIndex);
            soloBtn.classList.remove('active');
        } else {
            soloedTracks.add(trackIndex);
            soloBtn.classList.add('active');
        }
        updateTrackMutes();
    };

    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteTrack(trackIndex);
    };

    if (instrumentBtn && dropdown) {
        if (trackTypes[trackIndex] === 'audio_track') {
            instrumentBtn.style.display = 'none';
        } else {
            instrumentBtn.onclick = (e) => {
                e.stopPropagation();
                const isOpen = dropdown.style.display === 'flex';
                closeAllDropdowns();
                if (!isOpen) {
                    dropdown.style.display = 'flex';
                    label.classList.add('dropdown-open');
                    renderInstrumentDropdown(dropdown, trackIndex);
                }
            };
        }
    }

    // Build Sub-lanes UI
    if (isExpanded) {
        lanes.forEach((lane, laneIdx) => {
            const laneLabel = document.createElement('div');
            laneLabel.style.height = automationLaneHeight + 'px';
            laneLabel.style.background = 'rgba(0,0,0,0.2)';
            laneLabel.style.borderBottom = '1px solid var(--border-color)';
            laneLabel.style.borderLeft = `2px solid ${trackColor}`;
            laneLabel.style.display = 'flex';
            laneLabel.style.alignItems = 'center';
            laneLabel.style.padding = '0 12px 0 50px';
            laneLabel.style.fontSize = '0.75rem';
            laneLabel.style.color = 'var(--text-dim)';
            laneLabel.style.position = 'relative';
            laneLabel.innerHTML = `📉 ${lane.paramName}`;

            // Vertical resize handle at bottom of last lane
            if (laneIdx === lanes.length - 1) {
                const resizeHandle = document.createElement('div');
                resizeHandle.style.position = 'absolute';
                resizeHandle.style.bottom = '0';
                resizeHandle.style.left = '0';
                resizeHandle.style.width = '100%';
                resizeHandle.style.height = '5px';
                resizeHandle.style.cursor = 'ns-resize';
                resizeHandle.style.background = 'transparent';
                resizeHandle.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const startY = e.clientY;
                    const startH = automationLaneHeight;
                    const onMove = (ev) => {
                        const delta = ev.clientY - startY;
                        automationLaneHeight = Math.max(30, Math.min(200, startH + delta / Math.max(1, lanes.length)));
                        rebuildTracksUI();
                    };
                    const onUp = () => {
                        window.removeEventListener('mousemove', onMove);
                        window.removeEventListener('mouseup', onUp);
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                });
                laneLabel.appendChild(resizeHandle);
            }

            wrapper.appendChild(laneLabel);
        });
    }

    elements.trackLabels.appendChild(wrapper);

    // Track Grid Area (Row)
    const row = document.createElement('div');
    row.className = 'track-row';
    const computedHeight = config.trackHeight + (isExpanded ? lanes.length * automationLaneHeight : 0);
    row.style.height = computedHeight + 'px';

    // We append the main pattern receptor on top (zona sensibile nella playlistai click e drag & drop)
    const dropArea = document.createElement('div');
    dropArea.style.height = config.trackHeight + 'px';
    dropArea.style.width = '100%';
    dropArea.style.position = 'absolute';
    dropArea.style.top = '0';
    dropArea.addEventListener('mousedown', (e) => handleGridMouseDown(e, trackIndex));
    dropArea.addEventListener('mouseenter', (e) => handleGridMouseEnter(e, trackIndex));
    dropArea.addEventListener('contextmenu', (e) => e.preventDefault());

    if (trackTypes[trackIndex] === 'audio_track') {
        dropArea.addEventListener('dragover', e => {
            e.preventDefault();
            dropArea.style.border = '2px dashed #ec4899';
        });
        dropArea.addEventListener('dragleave', e => {
            e.preventDefault();
            dropArea.style.border = 'none';
        });
        dropArea.addEventListener('drop', async e => {
            e.preventDefault();
            dropArea.style.border = 'none';
            handleAudioDrop(e, trackIndex);
        });
    }

    row.appendChild(dropArea);

    if (isExpanded) {
        lanes.forEach((lane, idx) => {
            const laneGrid = document.createElement('div');
            laneGrid.style.height = automationLaneHeight + 'px';
            laneGrid.style.width = '100%';
            laneGrid.style.position = 'absolute';
            laneGrid.style.top = (config.trackHeight + idx * automationLaneHeight) + 'px';
            laneGrid.style.background = 'rgba(0,0,0,0.1)';
            laneGrid.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
            row.appendChild(laneGrid);
        });
    }

    elements.tracksLayer.appendChild(row);
}

function deleteTrack(trackIndex) {
    if (config.tracks <= 1) {
        console.warn("Azione annullata: Devi avere almeno una traccia.");
        return;
    }

    // 1. Remove clips visually first, then form array
    playlistClips.forEach(c => {
        if (c.trackIndex === trackIndex) {
            const el = document.getElementById(c.id);
            if (el) el.remove();
        }
    });
    playlistClips = playlistClips.filter(c => c.trackIndex !== trackIndex);

    // 2. Shift clips down
    playlistClips.forEach(c => {
        if (c.trackIndex > trackIndex) c.trackIndex -= 1;
    });

    // 3. Update pattern tracks targeting
    Object.values(patterns).forEach(p => {
        if (p.targetTrack === trackIndex) p.targetTrack = null;
        else if (p.targetTrack !== null && p.targetTrack > trackIndex) p.targetTrack -= 1;
    });

    // 4. Update track arrays
    trackInstrumentIds.splice(trackIndex, 1);
    trackNames.splice(trackIndex, 1);
    trackColors.splice(trackIndex, 1);
    trackTypes.splice(trackIndex, 1);
    mixerState.splice(trackIndex, 1);
    instrumentStates.splice(trackIndex, 1);

    // Shift trackExpandedLanes
    for (let i = trackIndex; i < config.tracks - 1; i++) {
        trackExpandedLanes[i] = trackExpandedLanes[i + 1];
    }
    delete trackExpandedLanes[config.tracks - 1];

    const frameToRemove = trackFrames.splice(trackIndex, 1)[0];
    if (frameToRemove) frameToRemove.remove();
    trackFrames.forEach((frame, idx) => {
        if (frame) frame.dataset.trackIndex = idx;
    });

    config.tracks -= 1;

    // 5. Update Solo set
    const newSoloed = new Set();
    soloedTracks.forEach(s => {
        if (s > trackIndex) newSoloed.add(s - 1);
        else if (s < trackIndex) newSoloed.add(s);
    });
    soloedTracks = newSoloed;

    rebuildTracksUI();

    if (elements.pianoRollFrame.contentWindow) {
        elements.pianoRollFrame.contentWindow.postMessage({
            type: 'update-tracks-dropdown', //Update tracks "select track" menu in piano roll
            totalTracks: config.tracks
        }, '*');
    }

    if (elements.mixerModal.style.display === 'flex') renderMixer(); //If mixer is open, update it
}

if (elements.addTrackBtn) {
    elements.addTrackBtn.onclick = () => {
        promptChoiceModal("Che tipo di traccia vuoi creare?", (type) => {
            config.tracks += 1;
            trackTypes.push(type);
            trackNames.push(`Track ${trackCounter++}`); // Usa il contatore per evitare nomi doppi
            trackColors.push('#3b82f6');
            // Default instrument basato sul tipo preferito dall'utente
            trackInstrumentIds.push(type === 'audio_track' ? 'audio_track' : (type === 'drum_rack' ? 'drum_rack' : (type === 'channel_rack' ? 'channel_rack' : 'synth_additive')));

            mixerState.push({ main: 1.0, subs: [], names: [] });

            createTrack(config.tracks);
            updateGridStyle();

            // Se il piano roll è aperto, aggiorna in tempo reale il numero totale di tracce disponibili
            if (elements.pianoRollFrame.contentWindow) {
                elements.pianoRollFrame.contentWindow.postMessage({
                    type: 'update-tracks-dropdown',
                    totalTracks: config.tracks
                }, '*');
            }
            if (elements.mixerModal.style.display === 'flex') renderMixer(); //If mixer is open, update it
        });
    };
}

function renderInstrumentDropdown(dropdown, trackIndex) {
    dropdown.innerHTML = '';
    const trackType = trackTypes[trackIndex];

    config.instruments.forEach(inst => {
        // Filtraggio esclusivo
        if (trackType === 'drum_rack' && inst.id !== 'drum_rack') return;
        if (trackType === 'channel_rack' && inst.id !== 'channel_rack') return;
        if (trackType === 'piano_roll' && (inst.id === 'drum_rack' || inst.id === 'channel_rack' || inst.id === 'audio_track')) return;

        const item = document.createElement('div');
        const isCurrentlySelected = trackInstrumentIds[trackIndex] === inst.id;
        item.className = `instrument-dropdown-item ${isCurrentlySelected ? 'selected' : ''}`;
        item.innerHTML = `<i>${inst.icon}</i> <span>${inst.name}</span>`;

        item.onclick = (e) => {
            e.stopPropagation();
            if (trackInstrumentIds[trackIndex] !== inst.id) {
                switchInstrument(inst.id, trackIndex);
            } else {
                openInstrumentModal(trackIndex);
            }
            dropdown.style.display = 'none';
            const label = dropdown.closest('.track-label');
            if (label) label.classList.remove('dropdown-open');
        };
        dropdown.appendChild(item);
    });
}

function openInstrumentModal(trackIndex) { //Makes instrument visible
    currentEditingTrackIndex = trackIndex;
    const instId = trackInstrumentIds[trackIndex];
    const inst = config.instruments.find(i => i.id === instId);

    // Show only the relevant iframe
    trackFrames.forEach((frame, idx) => {
        frame.style.display = (idx === trackIndex) ? 'flex' : 'none';
        frame.style.width = '100%';
        frame.style.height = '100%';
    });

    const instrumentTitle = document.getElementById('instrumentTitle');
    if (instrumentTitle) instrumentTitle.innerText = `${trackNames[trackIndex]} - ${inst.name}`;

    elements.instrumentModal.style.display = 'flex';
}

function switchInstrument(id, trackIndex) {
    const inst = config.instruments.find(i => i.id === id);
    if (!inst) return;

    trackInstrumentIds[trackIndex] = id;
    const frame = trackFrames[trackIndex];
    frame.dataset.loaded = "false";
    frame.src = inst.path;

    // Update specific track icon
    const trackLabels = document.querySelectorAll('.track-label');
    const iconBtn = trackLabels[trackIndex].querySelector('.track-instrument-btn');
    if (iconBtn) iconBtn.innerText = inst.icon;

    openInstrumentModal(trackIndex);
}

function closeAllDropdowns() {  //Close all instrument dropdowns (menù a tendina)
    const dropdowns = document.querySelectorAll('.instrument-dropdown');
    dropdowns.forEach(d => d.style.display = 'none');
    document.querySelectorAll('.track-label').forEach(l => l.classList.remove('dropdown-open'));
}

// Global click to close dropdowns (cliccando a vuoto)
window.addEventListener('click', closeAllDropdowns);

function updateGridStyle() {
    const stepWidth = config.stepWidth;
    let bgSizeSmall = `${currentQuantization * stepWidth}px 100%`;

    // Triplet specific logic
    if (Math.abs(currentQuantization - 1.3333333333333333) < 0.01) {
        bgSizeSmall = `calc(${stepWidth * 4}px / 3) 100%`;
    } else if (Math.abs(currentQuantization - 0.6666666666666666) < 0.01) {
        bgSizeSmall = `calc(${stepWidth * 4}px / 6) 100%`;
    }

    elements.gridBackground.style.backgroundSize = `${bgSizeSmall}, ${stepWidth * 16}px 100%`;
    elements.timeline.style.backgroundSize = `${bgSizeSmall}`;

    const totalHeight = computeTrackLayouts();
    elements.gridBackground.style.minHeight = `${totalHeight}px`;
    elements.tracksLayer.style.minHeight = `${totalHeight}px`;
}

// === INTERACTION ===

function handleGridMouseDown(e, trackIndex) { //Clicks
    if (e.button === 0) {  //Left click
        if (!(e.ctrlKey || e.metaKey)) {
            selectedClipIds.clear();
            updateClipsSelectionUI();
        }

        // Store starting position for rubber-band vs paint decision
        const rect = elements.gridScrollArea.getBoundingClientRect();
        rubberBandStartX = e.clientX - rect.left + elements.gridScrollArea.scrollLeft;
        rubberBandStartY = e.clientY - rect.top + elements.gridScrollArea.scrollTop;
        rubberBandMouseStartX = e.clientX;
        rubberBandMouseStartY = e.clientY;
        rubberBandPending = true;
        rubberBandTrackIndex = trackIndex;

        // Don't paint immediately — wait for mouseup (click) or movement (rubber-band)
    }
    else if (e.button === 2) {  //Right click
        isErasing = true;
        removeClipAt(e, trackIndex);
    }
}

function handleGridMouseEnter(e, trackIndex) { //Holding the mouse button while moving 
    if (isPainting && e.buttons === 1) addClip(e, trackIndex);
    else if (isErasing && e.buttons === 2) removeClipAt(e, trackIndex);
}

function addClip(e, trackIndex) {
    const rect = elements.tracksLayer.getBoundingClientRect();
    const x = e.clientX - rect.left + elements.gridScrollArea.scrollLeft;
    const rawStep = x / config.stepWidth;

    // Snapping based on quantization
    let startStep = Math.floor(rawStep / currentQuantization) * currentQuantization;

    if (playlistClips.some(c => c.trackIndex === trackIndex && c.startStep === startStep)) return;

    // VERIFICA SE IL PATTERN HA UNA TRACCIA DI DESTINAZIONE OBBLIGATA
    const pattern = patterns[selectedPatternId];

    // VERIFICA SE IL TIPO DI TRACCIA CORRISPONDE AL TIPO DEL PATTERN
    if (trackTypes[trackIndex] !== pattern.type) {
        console.warn(`Incompatibilità: Stai cercando di inserire un pattern [${pattern.type}] in una traccia [${trackTypes[trackIndex]}].`);
        return;
    }



    if (pattern.targetTrack === null || pattern.targetTrack === undefined) {
        pattern.targetTrack = trackIndex;
        console.log(`Pattern ${selectedPatternId} ha assunto la traccia ${trackIndex}`);

        // Se il piano roll è attualmente aperto proprio su questo pattern, aggiorna l'UI
        if (currentEditingPatternId === selectedPatternId && elements.pianoRollFrame.contentWindow) {
            elements.pianoRollFrame.contentWindow.postMessage({
                type: 'update-target-track-ui',
                targetTrack: trackIndex
            }, '*');
        }
    } else if (pattern.targetTrack !== trackIndex) {
        console.log(`Pattern bloccato sulla traccia ${pattern.targetTrack + 1}`);
        // Puoi opzionalmente far lampeggiare l'etichetta della traccia
        return;
    }

    const clip = { //Clip hasn't notes, it's just a "temporal pointer" for the pattern
        id: `clip_${clipCounter++}`,
        trackIndex,
        startStep, //Default value = 0
        length: config.patternLength, //Default value = 16 steps
        patternId: selectedPatternId //pointer to the pattern!
    };
    playlistClips.push(clip);
    renderClip(clip);  //Shows notes in the clip
}

function removeClipAt(e, trackIndex) {
    const rect = elements.tracksLayer.getBoundingClientRect();
    const x = e.clientX - rect.left + elements.gridScrollArea.scrollLeft;
    const step = Math.floor(x / config.stepWidth);
    const clipIndex = playlistClips.findIndex(c => c.trackIndex === trackIndex && step >= c.startStep && step < (c.startStep + c.length));
    if (clipIndex !== -1) {
        const clipId = playlistClips[clipIndex].id;
        document.getElementById(clipId).remove();
        playlistClips.splice(clipIndex, 1);
        selectedClipIds.delete(clipId);
    }
}

function updateClipsSelectionUI() {
    playlistClips.forEach(c => {
        const el = document.getElementById(c.id);
        if (el) el.classList.toggle('selected', selectedClipIds.has(c.id));
    });
}

function renderClip(clip) {  //For midi pattern, automations and audio clips
    const el = document.createElement('div');
    el.id = clip.id;
    el.className = 'clip';
    el.style.left = `${clip.startStep * config.stepWidth}px`;
    el.style.width = `${clip.length * config.stepWidth}px`;

    let topY = trackOffsetsY[clip.trackIndex];
    let heightY = config.trackHeight;
    let isHidden = false;

    if (clip.type === 'automation') {
        const lanes = getAutomationLanes(clip.trackIndex);
        const laneIndex = lanes.findIndex(l => l.paramId === clip.paramId);

        if (trackExpandedLanes[clip.trackIndex] === true && laneIndex !== -1) {
            topY += config.trackHeight + (laneIndex * automationLaneHeight);
            heightY = automationLaneHeight;
            // No top/bottom border spacing gap to fit neatly
        } else {
            isHidden = true; // hide when collapsed
        }

        el.style.background = `linear-gradient(135deg, ${clip.color}44, ${clip.color}22)`;
        el.style.borderTop = `2px solid ${clip.color}`;
        el.innerText = '📉 ' + clip.paramName;
        el.style.color = clip.color;

        const svgContainer = document.createElement('div');
        svgContainer.className = 'automation-container';
        svgContainer.style.position = 'absolute';
        svgContainer.style.left = '0';
        svgContainer.style.top = '0';
        svgContainer.style.width = '100%';
        svgContainer.style.height = '100%';
        svgContainer.style.overflow = 'visible';

        el.appendChild(svgContainer);
        drawAutomationSVG(clip, svgContainer, heightY);
    } else if (clip.type === 'audio') {
        const baseColor = clip.color || '#ec4899';
        el.style.background = `linear-gradient(135deg, ${baseColor}, ${adjustColor(baseColor, -30)})`;
        el.style.color = '#fff';
        el.innerText = '🎤 ' + clip.name;

        // Initialize fade values if missing
        if (clip.fadeIn === undefined) clip.fadeIn = 0;
        if (clip.fadeOut === undefined) clip.fadeOut = 0;

        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.bottom = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '60%';
        canvas.style.opacity = '0.5';
        el.appendChild(canvas);
        drawAudioWaveform(clip, canvas);

        // Fade In handle
        const fadeInHandle = document.createElement('div');
        fadeInHandle.className = 'clip-fade-handle clip-fade-in';
        fadeInHandle.style.left = `${(clip.fadeIn / clip.length) * 100}%`;
        fadeInHandle.title = 'Fade In';
        fadeInHandle.onmousedown = (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const clipEl = el;
            const startX = ev.clientX;
            const startFade = clip.fadeIn;
            const onMove = (me) => {
                const dx = me.clientX - startX;
                const dSteps = dx / config.stepWidth;
                clip.fadeIn = Math.max(0, Math.min(clip.length, Math.round(startFade + dSteps)));
                fadeInHandle.style.left = `${(clip.fadeIn / clip.length) * 100}%`;
                drawAudioWaveform(clip, canvas);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                checkAndSavePlaylistState();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        el.appendChild(fadeInHandle);

        // Fade Out handle
        const fadeOutHandle = document.createElement('div');
        fadeOutHandle.className = 'clip-fade-handle clip-fade-out';
        fadeOutHandle.style.right = `${10 + (clip.fadeOut / clip.length) * (el.offsetWidth - 10)}px`;
        fadeOutHandle.title = 'Fade Out';
        fadeOutHandle.onmousedown = (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const startX = ev.clientX;
            const startFade = clip.fadeOut;
            const onMove = (me) => {
                const dx = startX - me.clientX;
                const dSteps = dx / config.stepWidth;
                clip.fadeOut = Math.max(0, Math.min(clip.length, Math.round(startFade + dSteps)));
                const pct = (clip.fadeOut / clip.length);
                fadeOutHandle.style.right = `${10 + pct * (clip.length * config.stepWidth - 10)}px`;
                drawAudioWaveform(clip, canvas);
            };
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                checkAndSavePlaylistState();
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        };
        el.appendChild(fadeOutHandle);

        drawAudioWaveform(clip, canvas);
    } else {
        const pattern = patterns[clip.patternId];
        el.style.background = `linear-gradient(135deg, ${pattern.color}, ${adjustColor(pattern.color, -30)})`;
        const typeVisual = pattern.type === 'drum_rack' ? '🥁 ' : (pattern.type === 'channel_rack' ? '🎛️ ' : '🎹 ');
        el.innerText = typeVisual + pattern.name;

        const notesContainer = document.createElement('div');
        notesContainer.className = 'clip-notes-preview';
        el.appendChild(notesContainer);

        // Fill the preview with notes 
        renderNotesToPreview(clip, notesContainer);
    }

    el.onclick = (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) {
            // Ctrl+Click: toggle this clip in selection
            if (selectedClipIds.has(clip.id)) {
                selectedClipIds.delete(clip.id);
            } else {
                selectedClipIds.add(clip.id);
            }
        } else {
            // Normal click: select only this clip
            selectedClipIds.clear();
            selectedClipIds.add(clip.id);
        }
        updateClipsSelectionUI();
    };

    el.ondblclick = (e) => {
        e.stopPropagation();
        if (clip.type === 'automation') {
            // Automation nodes handle dblclick directly
        } else if (clip.type === 'audio') {
            // Open pitch/volume popup for audio clips
            openAudioClipPopup(clip, el);
        } else {
            openPianoRoll(clip.patternId);
        }
    };

    el.onmousedown = (e) => {
        // For automation clips: check if clicking near right edge for resize
        if (clip.type === 'automation') {
            if (e.target.tagName === 'circle') return; // Let SVG circle handle it
            const elRect = el.getBoundingClientRect();
            const distFromRight = elRect.right - e.clientX;
            if (e.button === 0 && distFromRight <= 10) {
                // Start resize
                e.stopPropagation();
                resizingClipId = clip.id;
                resizeStartX = e.clientX;
                resizeStartLength = clip.length;
                return;
            }
        }

        if (e.target.tagName !== 'circle' && e.button === 0) {
            e.stopPropagation();

            // If this clip is NOT in current selection (and not Ctrl-clicking), select only it
            if (!selectedClipIds.has(clip.id) && !(e.ctrlKey || e.metaKey)) {
                selectedClipIds.clear();
                selectedClipIds.add(clip.id);
                updateClipsSelectionUI();
            } else if (!selectedClipIds.has(clip.id)) {
                // Ctrl+drag on unselected clip: add it to selection
                selectedClipIds.add(clip.id);
                updateClipsSelectionUI();
            }

            draggingClipId = clip.id;
            const rect = elements.tracksLayer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left + elements.gridScrollArea.scrollLeft;
            const clickStep = mouseX / config.stepWidth;
            dragOffsetSteps = clickStep - clip.startStep;

            // Store initial positions of all selected clips for multi-drag
            multiDragInitialPositions = {};
            selectedClipIds.forEach(id => {
                const c = playlistClips.find(pc => pc.id === id);
                if (c) {
                    multiDragInitialPositions[id] = { startStep: c.startStep, trackIndex: c.trackIndex };
                }
            });

            el.classList.add('dragging');
        } else if (e.button === 2) {
            // If clicking on a circle (automation node), let the SVG handle it
            if (e.target.tagName === 'circle') return;
            e.stopPropagation();
            el.remove();
            playlistClips = playlistClips.filter(c => c.id !== clip.id);
        }
    };
    el.oncontextmenu = (e) => e.preventDefault();

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'clip-resize-handle';
    if (clip.type === 'automation') {
        // For automation clips: let clicks pass through to SVG nodes
        resizeHandle.style.pointerEvents = 'none';
    } else {
        resizeHandle.onmousedown = (e) => {
            e.stopPropagation();
            resizingClipId = clip.id;
            resizeStartX = e.clientX;
            resizeStartLength = clip.length;
            // Shift+drag on audio clips = warp mode
            if (clip.type === 'audio' && e.shiftKey) {
                isWarpResize = true;
                warpStartLength = clip.warpLength || clip.length; //Use the warpLength if it exists, otherwise use the length (if the clip wasn't warped before)
            } else {
                isWarpResize = false;
            }
        };
    }
    el.appendChild(resizeHandle);

    if (selectedClipIds.has(clip.id)) el.classList.add('selected');

    el.style.top = `${topY}px`;
    el.style.height = `${heightY}px`;
    if (isHidden) el.style.display = 'none';  //Usato dalle automazioni se compresse

    elements.tracksLayer.appendChild(el);
}

// === AUDIO CLIP POPUP (Pitch & Volume) ===
function openAudioClipPopup(clip, clipEl) {
    // Remove any existing popup
    const existing = document.getElementById('audioClipPopup');
    if (existing) existing.remove();

    // Initialize clip values if missing
    if (clip.pitchSemitones === undefined) clip.pitchSemitones = 0;
    if (clip.clipVolume === undefined) clip.clipVolume = 1.0;

    const popup = document.createElement('div');
    popup.id = 'audioClipPopup';
    popup.style.cssText = `
        position: fixed; z-index: 9999;
        background: #1a1d23; border: 1px solid #3b82f6;
        border-radius: 10px; padding: 14px 18px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        color: #fff; font-size: 12px; min-width: 200px;
        font-family: 'Inter', sans-serif;
    `;

    const rect = clipEl.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 6}px`;

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-weight: 600; font-size: 13px; margin-bottom: 12px; color: #ec4899;';
    title.textContent = '🎤 ' + (clip.name || 'Audio Clip');
    popup.appendChild(title);

    // Pitch control
    const pitchRow = document.createElement('div');
    pitchRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;';
    const pitchLabel = document.createElement('span');
    pitchLabel.textContent = 'Pitch';
    pitchLabel.style.width = '42px';
    const pitchSlider = document.createElement('input');
    pitchSlider.type = 'range';
    pitchSlider.min = '-12';
    pitchSlider.max = '12';
    pitchSlider.step = '1';
    pitchSlider.value = clip.pitchSemitones;
    pitchSlider.style.cssText = 'flex: 1; accent-color: #3b82f6;';
    const pitchValue = document.createElement('span');
    pitchValue.style.cssText = 'width: 36px; text-align: right; font-variant-numeric: tabular-nums;';
    pitchValue.textContent = `${clip.pitchSemitones > 0 ? '+' : ''}${clip.pitchSemitones}st`;
    pitchSlider.oninput = () => {
        clip.pitchSemitones = parseInt(pitchSlider.value);
        pitchValue.textContent = `${clip.pitchSemitones > 0 ? '+' : ''}${clip.pitchSemitones}st`;
    };
    pitchSlider.onchange = () => checkAndSavePlaylistState();
    pitchRow.appendChild(pitchLabel);
    pitchRow.appendChild(pitchSlider);
    pitchRow.appendChild(pitchValue);
    popup.appendChild(pitchRow);

    // Volume control
    const volRow = document.createElement('div');
    volRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';
    const volLabel = document.createElement('span');
    volLabel.textContent = 'Vol';
    volLabel.style.width = '42px';
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '2';
    volSlider.step = '0.01';
    volSlider.value = clip.clipVolume;
    volSlider.style.cssText = 'flex: 1; accent-color: #10b981;';
    const volValue = document.createElement('span');
    volValue.style.cssText = 'width: 36px; text-align: right; font-variant-numeric: tabular-nums;';
    const volToDb = (v) => v <= 0 ? '-∞' : `${(20 * Math.log10(v)).toFixed(1)}`;
    volValue.textContent = volToDb(clip.clipVolume) + 'dB';
    volSlider.oninput = () => {
        clip.clipVolume = parseFloat(volSlider.value);
        volValue.textContent = volToDb(clip.clipVolume) + 'dB';
    };
    volSlider.onchange = () => checkAndSavePlaylistState();
    volRow.appendChild(volLabel);
    volRow.appendChild(volSlider);
    volRow.appendChild(volValue);
    popup.appendChild(volRow);

    document.body.appendChild(popup);

    // Close on click outside
    const closePopup = (ev) => {
        if (!popup.contains(ev.target) && ev.target !== clipEl) {
            popup.remove();
            document.removeEventListener('mousedown', closePopup);
        }
    };
    setTimeout(() => document.addEventListener('mousedown', closePopup), 50);
}

function drawAutomationSVG(clip, container, providedHeight) {
    container.innerHTML = '';
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';

    // Dynamic getters so w/h always reflect current clip state
    const getW = () => clip.length * config.stepWidth;
    const getH = () => providedHeight || automationLaneHeight || config.trackHeight;

    // Set initial viewBox
    svg.setAttribute('viewBox', `0 0 ${getW()} ${getH()}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    // Polyline
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(path);

    // Fill area under curve
    const fillPath = document.createElementNS(svgNS, "path");
    fillPath.setAttribute('fill', `${clip.color}20`);
    fillPath.setAttribute('stroke', 'none');
    svg.insertBefore(fillPath, path);

    const updatePath = () => {
        const w = getW();
        const h = getH();
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

        clip.nodes.sort((a, b) => a.timePct - b.timePct);
        if (clip.nodes.length > 0) {
            clip.nodes[0].timePct = 0;
            clip.nodes[clip.nodes.length - 1].timePct = 1;
        }

        let d = '';
        let fd = '';
        clip.nodes.forEach((node, i) => {
            const x = node.timePct * w;
            const y = (1 - node.valuePct) * h;
            if (i === 0) {
                d += `M ${x} ${y} `; //Sposta la penna
                fd += `M ${x} ${h} L ${x} ${y} `;
            } else {
                d += `L ${x} ${y} `; //Traccia la linea fino a qui
                fd += `L ${x} ${y} `;
            }
        });
        if (clip.nodes.length > 0) {
            const lastX = clip.nodes[clip.nodes.length - 1].timePct * w;
            fd += `L ${lastX} ${h} Z`;
        }
        path.setAttribute('d', d);
        fillPath.setAttribute('d', fd);
    };

    const dragState = { active: false, node: null };

    const renderNodes = () => {   //Salviamo la funzione in una variabile per chiamarla comodamente
        const w = getW();
        const h = getH();

        // Clear previous circles
        svg.querySelectorAll('circle').forEach(c => c.remove());

        updatePath();

        clip.nodes.forEach(node => {
            const cx = node.timePct * w;
            const cy = (1 - node.valuePct) * h;

            const circle = document.createElementNS(svgNS, "circle");
            circle.setAttribute('cx', cx);
            circle.setAttribute('cy', cy);
            circle.setAttribute('r', '5');
            circle.setAttribute('fill', '#ffffff');
            circle.setAttribute('stroke', clip.color);
            circle.setAttribute('stroke-width', '2');
            circle.setAttribute('vector-effect', 'non-scaling-stroke');
            circle.style.cursor = 'pointer';

            circle.onmousedown = (e) => {
                e.stopPropagation();
                if (e.button === 2) {
                    if (node.timePct > 0 && node.timePct < 1) {
                        clip.nodes = clip.nodes.filter(n => n !== node);
                        renderNodes();
                        checkAndSavePlaylistState();
                    }
                } else if (e.button === 0) {
                    dragState.active = true;
                    dragState.node = node;
                }
            };
            svg.appendChild(circle);
        });
    };

    // Store renderNodes on the container so we can call it from resize handler
    container._redrawAutomation = renderNodes;

    // Prevent browser context menu on SVG
    svg.addEventListener('contextmenu', (e) => e.preventDefault());

    svg.ondblclick = (e) => {
        e.stopPropagation();
        const rect = svg.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = getW();
        const h = getH();

        // Convert screen coords to SVG coords (account for viewBox scaling)
        const scaleX = w / rect.width;
        const scaleY = h / rect.height;

        let timePct = (x * scaleX) / w;
        let valuePct = 1 - ((y * scaleY) / h);

        timePct = Math.max(0, Math.min(1, timePct));
        valuePct = Math.max(0, Math.min(1, valuePct));

        clip.nodes.push({ timePct, valuePct });
        renderNodes();
        checkAndSavePlaylistState();
    };

    window.addEventListener('mousemove', (e) => {
        if (!dragState.active || !dragState.node) return;

        const rect = svg.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const w = getW();
        const h = getH();

        const scaleX = w / rect.width;
        const scaleY = h / rect.height;

        let newTimePct = (x * scaleX) / w;
        let newValuePct = 1 - ((y * scaleY) / h);

        // Prevent first/last nodes from moving time
        if (dragState.node === clip.nodes[0]) newTimePct = 0;
        else if (dragState.node === clip.nodes[clip.nodes.length - 1]) newTimePct = 1;

        newTimePct = Math.max(0, Math.min(1, newTimePct));
        newValuePct = Math.max(0, Math.min(1, newValuePct));

        dragState.node.timePct = newTimePct;
        dragState.node.valuePct = newValuePct;
        renderNodes();
    });

    window.addEventListener('mouseup', () => {
        if (dragState.active) {
            dragState.active = false;
            dragState.node = null;
            checkAndSavePlaylistState();
        }
    });

    renderNodes();
    container.appendChild(svg);
}

function updatePatternPickerDisplay() { //Render the pattern picker (in the toolbar)
    const pattern = patterns[selectedPatternId];
    if (!pattern) return;
    const typeIcon = pattern.type === 'drum_rack' ? '🥁 ' : (pattern.type === 'channel_rack' ? '🎛️ ' : '🎹 ');
    elements.patternName.innerHTML = `<span class="pattern-type-icon">${typeIcon}</span>${pattern.name}`;
    elements.patternColorDot.style.backgroundColor = pattern.color;
    elements.patternColorDot.style.boxShadow = `0 0 10px ${pattern.color}`;
    const picker = document.getElementById('patternColorPicker');
    if (picker) picker.value = pattern.color;
}

function initPatternPicker() {  //Pattern picker logic
    let patternClickTimeout = null;
    const handlePatternClick = () => {
        if (patternClickTimeout) return;
        patternClickTimeout = setTimeout(() => {
            openPianoRoll(selectedPatternId);
            patternClickTimeout = null;
        }, 250);  //250 ms di delay prima di essere eseguita per essere sicuri che sia un click singolo
    };

    const handlePatternDblClick = () => {
        if (patternClickTimeout) {
            clearTimeout(patternClickTimeout); //Cancella il timer del click singolo
            patternClickTimeout = null;
        }

        const pattern = patterns[selectedPatternId];
        const oldName = pattern.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldName;
        input.className = 'rename-input pattern-rename';
        elements.patternName.replaceWith(input);
        input.focus();
        input.select();
        const save = () => {
            const newName = input.value.trim() || oldName;
            pattern.name = newName;
            const newSpan = document.createElement('span');
            newSpan.id = 'patternName';
            newSpan.onclick = handlePatternClick;
            newSpan.ondblclick = handlePatternDblClick;
            input.replaceWith(newSpan);
            elements.patternName = newSpan;
            updatePatternPickerDisplay(); // Re-add icons and name
            refreshPatternClips(selectedPatternId);
        };

        input.onblur = save;
        input.onkeydown = (e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') { input.value = oldName; save(); }
        };
    };

    elements.patternName.onclick = handlePatternClick;
    elements.patternName.ondblclick = handlePatternDblClick;

    elements.prevPattern.onclick = () => {
        const keys = Object.keys(patterns).map(Number).sort((a, b) => a - b);
        let idx = keys.indexOf(parseInt(selectedPatternId));
        idx = (idx - 1 + keys.length) % keys.length;
        selectedPatternId = keys[idx];
        updatePatternPickerDisplay();
    };

    elements.nextPattern.onclick = () => {
        const keys = Object.keys(patterns).map(Number).sort((a, b) => a - b);
        let idx = keys.indexOf(parseInt(selectedPatternId));
        idx = (idx + 1) % keys.length;
        selectedPatternId = keys[idx];
        updatePatternPickerDisplay();
    };

    if (elements.addPatternBtn) {
        elements.addPatternBtn.onclick = () => {
            promptChoiceModal("Che tipo di pattern vuoi creare?", (type) => {
                const keys = Object.keys(patterns).map(Number);
                const newId = (keys.length > 0 ? Math.max(...keys) : 0) + 1;

                const hue = Math.floor(Math.random() * 360);
                const color = `hsl(${hue}, 80%, 60%)`;

                patterns[newId] = {
                    name: `Pattern ${newId}`,
                    type: type,
                    color: color,
                    totalSteps: 64,
                    targetTrack: null,
                    notes: []
                };

                selectedPatternId = newId;
                updatePatternPickerDisplay();
            }, false);
        };
    }

    const delBtn = document.getElementById('deletePatternBtn');
    if (delBtn) {
        delBtn.onclick = () => {
            console.log("Delete Pattern clicked! selectedPatternId:", selectedPatternId);
            const keys = Object.keys(patterns).map(Number);
            if (keys.length <= 1) {
                console.warn("Azione annullata: Devi avere almeno un pattern nel progetto.");
                return;
            }

            const patternName = patterns[selectedPatternId]?.name || `Pattern ${selectedPatternId}`;
            const res = confirm(`Vuoi eliminare definitivamente ${patternName}? Tutte le relative clip spariranno.`);
            if (!res) return;

            // Remove all clips visually first
            playlistClips.forEach(c => {
                if (c.patternId == selectedPatternId) {
                    const el = document.getElementById(c.id);
                    if (el) el.remove();
                }
            });
            // Remove from array
            playlistClips = playlistClips.filter(c => c.patternId != selectedPatternId);

            console.log("Deleting from patterns object:", selectedPatternId);
            delete patterns[selectedPatternId];

            const newKeys = Object.keys(patterns).map(Number).sort((a, b) => a - b);
            selectedPatternId = newKeys[0];
            updatePatternPickerDisplay();
            console.log("Deletion complete. New selectedPatternId:", selectedPatternId);
        };
    }

    // BPM Sync
    elements.bpmInput.onchange = (e) => {
        bpm = parseInt(e.target.value);
        const stepDuration = (60000 / bpm) / 4;   // Alternativa semplice ma efficiente ai Tick MIDI (che però hanno risoluzione piu alta)
        elements.playhead.style.transitionDuration = `${stepDuration}ms`;
        syncBPMToPianoRoll();
    };

    // Grid Sync
    elements.gridSelect.onchange = (e) => {
        currentQuantization = parseFloat(e.target.value); //From string to float
        updateGridStyle();
    };

    // Pattern Color Sync
    const pPicker = document.getElementById('patternColorPicker');
    if (pPicker) {
        pPicker.oninput = (e) => {
            const newColor = e.target.value;
            const pattern = patterns[selectedPatternId];
            if (pattern) {
                pattern.color = newColor;
                elements.patternColorDot.style.backgroundColor = newColor;
                elements.patternColorDot.style.boxShadow = `0 0 10px ${newColor}`;
                refreshPatternClips(selectedPatternId);
            }
        };
    }

    updatePatternPickerDisplay();
}

/**
 * Send current BPM to the Piano Roll iframe
 */
function syncBPMToPianoRoll() {
    // Sync to Piano Roll
    if (elements.pianoRollFrame.dataset.loaded === "true") {
        elements.pianoRollFrame.contentWindow.postMessage({ type: 'set-bpm', bpm: bpm }, '*');
    }
    // Sync to all Track Instruments
    trackFrames.forEach(frame => {
        if (frame.dataset.loaded === "true") {
            frame.contentWindow.postMessage({ type: 'set-bpm', bpm: bpm }, '*');
        }
    });
}

function promptChoiceModal(title, callback, showAudioTrack = true) {  //Window for choosing pattern/track type
    elements.choiceModalTitle.innerText = title;
    elements.choiceModal.style.display = 'flex'; //makes the window visible

    // Show/hide audio track button based on context (perchè non ha senso creare un pattern audio)
    if (elements.choiceAudioTrackBtn) {
        elements.choiceAudioTrackBtn.style.display = showAudioTrack ? '' : 'none';
    }

    const cleanup = () => {
        elements.choicePianoRollBtn.onclick = null;
        elements.choiceDrumRackBtn.onclick = null;
        elements.choiceChannelRackBtn.onclick = null;
        if (elements.choiceAudioTrackBtn) elements.choiceAudioTrackBtn.onclick = null;
        elements.choiceCancelBtn.onclick = null;
        elements.choiceModal.style.display = 'none';
    };

    elements.choicePianoRollBtn.onclick = () => {
        cleanup();
        callback('piano_roll');
    };
    elements.choiceDrumRackBtn.onclick = () => {
        cleanup();
        callback('drum_rack');
    };
    elements.choiceChannelRackBtn.onclick = () => {
        cleanup();
        callback('channel_rack');
    };
    if (elements.choiceAudioTrackBtn) {
        elements.choiceAudioTrackBtn.onclick = () => {
            cleanup();
            callback('audio_track');
        };
    }
    elements.choiceCancelBtn.onclick = () => {
        cleanup();
    };
}

function openPianoRoll(patternId) {
    currentEditingPatternId = patternId;
    const pattern = patterns[patternId];
    console.log(`[Main] Opening Editor for Pattern ${patternId}`, pattern);

    if (pattern.type === 'drum_rack' || pattern.type === 'channel_rack') {
        if (pattern.targetTrack !== null && pattern.targetTrack !== undefined) {
            // Apri lo strumento della traccia a cui è vincolato!
            openInstrumentModal(pattern.targetTrack);

            // Chiedi al drum rack o channel rack della traccia di visualizzare questo pattern temporaneamente
            const targetFrame = trackFrames[pattern.targetTrack];
            if (targetFrame) {
                const sendTargetData = () => {
                    targetFrame.contentWindow.postMessage({
                        type: 'load-pattern',
                        patternId: patternId,
                        pattern: pattern
                    }, '*');
                    targetFrame.contentWindow.postMessage({ type: 'set-bpm', bpm: bpm }, '*');
                };
                if (targetFrame.dataset.loaded === "true") sendTargetData();
                else targetFrame.onload = () => { targetFrame.dataset.loaded = "true"; sendTargetData(); };
            }
        } else {
            console.warn(`Azione annullata: Trascina prima la clip su una traccia ${pattern.type === 'channel_rack' ? 'Channel Rack' : 'Drum Rack'} per poterne assegnare i suoni e modificarla!`);
        }
        return; // Fermati qui per non aprire anche il genrico pianoRollModal
    } else {
        elements.modalPatternTitle.innerText = `Piano Roll - ${pattern.name}`;
        elements.pianoRollFrame.style.display = 'block';

        const sendData = () => {
            if (elements.pianoRollFrame.contentWindow) {
                elements.pianoRollFrame.contentWindow.postMessage({
                    type: 'load-pattern',
                    patternId: patternId,
                    totalTracks: config.tracks,
                    targetTrack: pattern.targetTrack,
                    notes: pattern.notes
                }, '*');
                syncBPMToPianoRoll();
            }
        };

        sendData();
        elements.pianoRollFrame.onload = () => {
            elements.pianoRollFrame.dataset.loaded = "true";
            sendData();
        };
    }

    elements.pianoRollModal.style.display = 'flex';
}

elements.closePianoRoll.onclick = () => elements.pianoRollModal.style.display = 'none';

window.addEventListener('message', (event) => { //Listener for messages FROM iframes!
    if (event.data.type === 'update-pattern') {
        const { patternId, notes, totalSteps } = event.data;
        console.log(`[Main] Received update-pattern for ID: ${patternId}`, notes.length);
        if (patterns[patternId]) {
            patterns[patternId].notes = notes;
            patterns[patternId].totalSteps = totalSteps || 64;
            refreshPatternClips(patternId);  //Rendering the pattern clip in the playlist
        }
    } else if (event.data.type === 'update-pattern-track') { //Vincolo del tipo di traccia in base al tipo di pattern
        const { patternId, targetTrack } = event.data;
        if (patterns[patternId]) {
            patterns[patternId].targetTrack = targetTrack;
            console.log(`[Main] Updated target track for Pattern ${patternId} to ${targetTrack}`);

            // Rimuovi le clip se la traccia non combacia (o se è tornata null)
            const clipsToRemove = playlistClips.filter(c => c.patternId === patternId && (targetTrack === null || c.trackIndex !== targetTrack));
            clipsToRemove.forEach(clip => {
                const el = document.getElementById(clip.id);
                if (el) el.remove();
            });
            playlistClips = playlistClips.filter(c => c.patternId !== patternId || (targetTrack !== null && c.trackIndex === targetTrack));
        }
    } else if (event.data.type === 'bpm-changed') {
        bpm = event.data.bpm;
        elements.bpmInput.value = bpm;
    } else if (event.data.type === 'note-on') {
        // Anteprima suono dal piano roll verso la traccia di appartenenza (se null non suona)
        const targetTrk = currentEditingPatternId ? patterns[currentEditingPatternId].targetTrack : null;
        if (targetTrk !== null && targetTrk !== undefined) {
            triggerNote(event.data.midi, event.data.key, targetTrk);
        }
    } else if (event.data.type === 'note-off') {
        const targetTrk = currentEditingPatternId ? patterns[currentEditingPatternId].targetTrack : null;
        if (targetTrk !== null && targetTrk !== undefined) {
            releaseNote(event.data.midi, event.data.key, targetTrk);
        }
    } else if (event.data.type === 'toggle-play') {
        if (event.data.ctrlKey) {
            resetPlayback();
        } else if (event.data.shiftKey) {
            togglePause();
        } else {
            if (isPlaying) stop();
            else play();
        }
    } else if (event.data.type === 'update-drum-swing') {
        const pattern = patterns[event.data.patternId];
        if (pattern && pattern.type === 'drum_rack') {
            pattern.swingAmount = event.data.swingAmount;
            pattern.swingGrid = event.data.swingGrid;
        }
    } else if (event.data.type === 'update-drum-pad') {
        const pattern = patterns[event.data.patternId];
        if (pattern && pattern.type === 'drum_rack') {
            if (!pattern.padsState) pattern.padsState = [];
            pattern.padsState[event.data.padIndex] = event.data.state;
            refreshPatternClips(event.data.patternId);
        }
    } else if (event.data.type === 'update-channel-rack') {
        const trackIdx = trackFrames.findIndex(frame => frame.contentWindow === event.source);
        if (trackIdx !== -1 && mixerState[trackIdx]) {
            mixerState[trackIdx].names = event.data.trackNames || [];
            while (mixerState[trackIdx].subs.length < event.data.steps.length) {
                mixerState[trackIdx].subs.push(1.0);
            }
            if (mixerState[trackIdx].subs.length > event.data.steps.length) {
                mixerState[trackIdx].subs.splice(event.data.steps.length);
            }

            if (elements.mixerModal.style.display === 'flex') {
                renderMixer();
            }
        }

        if (event.data.patternId) {
            const pattern = patterns[event.data.patternId];
            if (pattern && pattern.type === 'channel_rack') {
                pattern.stepsData = event.data.steps;
                if (event.data.totalSteps) pattern.totalSteps = event.data.totalSteps;
                refreshPatternClips(event.data.patternId);
            }
        }
    } else if (event.data.type === 'meter-update') {
        const trackIdx = Array.from(trackFrames).findIndex(frame => frame.contentWindow === event.source);
        if (trackIdx !== -1) {
            let meterId = event.data.subIndex !== undefined ? `${trackIdx}_${event.data.subIndex}` : `${trackIdx}`;
            activePeaks[meterId] = event.data.trackPeak;
            // Master peak is now computed from the global analyser in dawRenderLoop,
            // no longer from per-iframe masterPeak which only sees one track.

            // SALVATAGGIO DEI DATI FFT IN TEMPO REALE (per-track only)
            if (event.data.trackSpectrum || event.data.masterSpectrum) {
                // For master EQ spectrum, we use the global analyser (see dawRenderLoop).
                // For individual tracks, use the per-iframe data.
                if (activeEqMeterId !== 'master' && activeEqMeterId === meterId) {
                    currentSpectrumData = event.data.trackSpectrum;
                }
            }
        }
    }
});

function refreshPatternClips(patternId) {
    playlistClips.filter(c => c.patternId === patternId).forEach(clip => {
        const el = document.getElementById(clip.id);
        if (el) el.remove();
        renderClip(clip);
    });
}

function renderNotesToPreview(clip, container) {
    const pattern = patterns[clip.patternId];
    const totalPatternSteps = pattern.totalSteps || 64;
    const numLoops = Math.ceil(clip.length / totalPatternSteps);

    for (let i = 0; i < numLoops; i++) {
        const offset = i * totalPatternSteps;
        if (pattern.type === 'drum_rack') {
            if (pattern.padsState) {
                pattern.padsState.forEach((isActive, stepIndex) => {
                    if (isActive) {
                        const absoluteStep = offset + stepIndex;
                        if (absoluteStep < clip.length) {
                            const noteBar = document.createElement('div');
                            noteBar.className = 'mini-note';
                            noteBar.style.left = `${(absoluteStep / clip.length) * 100}%`;
                            noteBar.style.width = `${(1 / clip.length) * 100}%`;
                            noteBar.style.height = '6px';
                            noteBar.style.top = '45%';
                            container.appendChild(noteBar);
                        }
                    }
                });
            }
        } else if (pattern.type === 'channel_rack') {
            if (pattern.stepsData) {
                pattern.stepsData.forEach((trackSteps, trackIdx) => {
                    trackSteps.forEach((isActive, stepIndex) => {
                        if (isActive) {
                            const absoluteStep = offset + stepIndex;
                            if (absoluteStep < clip.length) {
                                const noteBar = document.createElement('div');
                                noteBar.className = 'mini-note';
                                noteBar.style.left = `${(absoluteStep / clip.length) * 100}%`;
                                noteBar.style.width = `${(1 / clip.length) * 100}%`;
                                noteBar.style.height = '4px';
                                const maxVisualTracks = 4;
                                const topPerc = ((trackIdx % maxVisualTracks) / maxVisualTracks) * 100 + 10;
                                noteBar.style.top = `${topPerc}%`;
                                container.appendChild(noteBar);
                            }
                        }
                    });
                });
            }
        } else {
            pattern.notes.forEach(n => {
                const absoluteStep = offset + n.startStep;
                // Only render if within clip bounds
                if (absoluteStep < clip.length) {
                    const noteBar = document.createElement('div');
                    noteBar.className = 'mini-note';

                    // Position relative to CLIP LENGTH (Percentage relative to clip total width)
                    noteBar.style.left = `${(absoluteStep / clip.length) * 100}%`;

                    let visibleLength = n.lengthSteps;
                    if (absoluteStep + visibleLength > clip.length) {
                        visibleLength = clip.length - absoluteStep;
                    }
                    noteBar.style.width = `${(visibleLength / clip.length) * 100}%`;

                    // Pitch scaling (fixed range C2-C5 for preview)
                    const topPos = 100 - ((n.pitch - 48) / 36) * 100;
                    noteBar.style.top = `${Math.max(0, Math.min(90, topPos))}%`;
                    container.appendChild(noteBar);
                }
            });
        }
    }
}

// === TRANSPORT ===

function movePlayhead(step, immediate = false) {
    if (immediate) {
        elements.playhead.style.transitionDuration = '0ms';
    }
    const stepDuration = (60000 / bpm) / 4;
    elements.playhead.style.left = `${step * config.stepWidth}px`; //Tuttavia non avviene istantaneamente!

    if (immediate) {
        elements.playhead.offsetHeight; // force reflow --> trucco per aggiornare il playhead istantaneamente!
        elements.playhead.style.transitionDuration = `${stepDuration}ms`;
    }
}

function play() {
    if (isPlaying) return;
    isPlaying = true;
    elements.playBtn.classList.add('active');
    elements.playhead.style.display = 'block';
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Set initial duration
    const stepDuration = (60000 / bpm) / 4;
    elements.playhead.style.transitionDuration = `${stepDuration}ms`;

    tick();
}

function stop() {
    isPlaying = false;
    clearTimeout(intervalId);
    intervalId = null;
    expectedNextTick = 0;
    currentStep = customStartStep;
    elements.playBtn.classList.remove('active');
    movePlayhead(currentStep, true);
    stopAllInstrumentNotes();
}

function resetPlayback() {
    stop();
    customStartStep = 0;
    currentStep = 0;
    movePlayhead(0, true);
}

function togglePause() {
    if (isPlaying) {
        isPlaying = false;
        clearTimeout(intervalId);
        intervalId = null;
        expectedNextTick = 0;
        elements.playBtn.classList.remove('active');
        stopAllInstrumentNotes();
    } else {
        play();
    }
}

//--- CLOCK MANAGEMENT ---//
//Per usare il clock della scheda audio!//  Serve solo per il metronomo qui!!
let lastTickWebAudioTime = 0; //serve a dire alla Scheda Audio quando suonare con precisione assoluta (Usando il Look-ahead ed evitando il Jitter, dovuto al rendering della UI)

//Utili solo per il calcolo del jitter nelle performance//
let lastTickStep = 0; //step dell'ultimo tick() lanciato
let expectedNextTick = 0;  //serve a controllare se JavaScript è in ritardo. (Jitter!) 

function playMetronomeClick(isDownbeat) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination); // Direct out to bypass master effects

    osc.type = 'sine';
    // Downbeat(battere) gets a higher pitch
    osc.frequency.setValueAtTime(isDownbeat ? 880 : 440, lastTickWebAudioTime);

    gainNode.gain.setValueAtTime(0.5, lastTickWebAudioTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, lastTickWebAudioTime + 0.05); //Da beep a click

    osc.start(lastTickWebAudioTime);  //Created and destroyed every step (for performance)
    osc.stop(lastTickWebAudioTime + 0.05);
}

function tick() {
    if (!isPlaying) return;  //don't do anything if not playing

    //Jitter Calculation
    const tickNow = performance.now(); //Time since the page loaded
    if (expectedNextTick > 0) {
        window.reportTickJitter(expectedNextTick, tickNow);
    }
    // 

    lastTickWebAudioTime = audioCtx.currentTime;
    lastTickStep = currentStep;

    if (isMetronomeActive && currentStep % 4 === 0) {
        // Quarter notes. Assuming 16th notes per step. So % 4 === 0 is a quarter note.
        // Downbeat is when currentStep % 16 === 0 (every 16th step is a bar of 4/4)
        playMetronomeClick(currentStep % 16 === 0);
    }

    // PLAY AUDIO FOR NOTES STARTING AT THIS STEP
    const stepDuration = (60000 / bpm) / 4;

    // Find all clips covering this currentStep
    playlistClips.forEach(clip => {
        // Skip automation clips
        if (clip.type === 'automation') return;

        // Ensure we check for overlap with [currentStep, currentStep + 1) window
        // using a small epsilon to avoid float rounding errors skipping exactly aligned events.
        const EPS = 0.0001;

        if (clip.type === 'audio') {
            if (clip.startStep >= currentStep - EPS && clip.startStep < currentStep + 1 - EPS) {
                // starts in this window
                const delayMs = Math.max(0, clip.startStep - currentStep) * stepDuration;
                setTimeout(() => playAudioClip(clip, 0), delayMs);
            } else if (isLoopActive && currentStep === loopStartStep && currentStep > clip.startStep + EPS && currentStep < clip.startStep + clip.length) {
                // if loop is active and we jump back inside the clip
                playAudioClip(clip, currentStep - clip.startStep);
            } else if (!intervalId && currentStep > clip.startStep + EPS && currentStep < clip.startStep + clip.length) {
                // Partenza a freddo (premi play)
                playAudioClip(clip, currentStep - clip.startStep);
            }
            return;
        }

        if (clip.startStep < currentStep + 1 && (clip.startStep + clip.length) > currentStep) {
            const pattern = patterns[clip.patternId];
            if (!pattern) return; // Safety check
            const patternTotalSteps = pattern.totalSteps || 64;

            if (pattern.type === 'drum_rack' || pattern.type === 'channel_rack') {
                for (let relativeStep = 0; relativeStep < patternTotalSteps; relativeStep++) {
                    const absoluteStep = clip.startStep + relativeStep;

                    if (absoluteStep >= currentStep - EPS && absoluteStep < currentStep + 1 - EPS && absoluteStep < clip.startStep + clip.length) {
                        const delayMs = Math.max(0, absoluteStep - currentStep) * stepDuration;

                        if (pattern.type === 'drum_rack' && pattern.padsState && pattern.padsState[relativeStep]) {
                            if (soloedTracks.size > 0 && !soloedTracks.has(clip.trackIndex)) continue;

                            let swingDelayMs = 0;
                            if (pattern.swingAmount > 0) {
                                const swingFactor = pattern.swingAmount / 100;
                                const swingShift = stepDuration * 0.5 * swingFactor;
                                const swingGrid = pattern.swingGrid || 16;
                                let isSwingLengthened = false;

                                if (swingGrid === 16) {
                                    isSwingLengthened = (relativeStep % 2 !== 0);
                                } else {
                                    isSwingLengthened = (Math.floor(relativeStep / 2) % 2 !== 0);
                                }

                                if (isSwingLengthened) swingDelayMs = swingShift;
                            }

                            const triggerDrumPad = () => {
                                if (!isPlaying && !window.isRendering) return;

                                const frame = trackFrames[clip.trackIndex];
                                if (frame && frame.dataset.loaded === "true" && trackInstrumentIds[clip.trackIndex] === 'drum_rack') {
                                    frame.contentWindow.postMessage({ type: 'play-pad', step: relativeStep }, '*');
                                }

                                if (trackInstrumentIds[clip.trackIndex] !== 'drum_rack') {
                                    const defaultPitch = 60 + relativeStep;
                                    const noteKey = `step_${currentStep}_${defaultPitch}_${Math.random()}`;
                                    triggerNote(defaultPitch, noteKey, clip.trackIndex);
                                    setTimeout(() => releaseNote(defaultPitch, noteKey, clip.trackIndex), stepDuration);
                                }
                            };

                            if (delayMs + swingDelayMs > 0) {
                                setTimeout(triggerDrumPad, delayMs + swingDelayMs);
                            } else {
                                triggerDrumPad();
                            }
                        } else if (pattern.type === 'channel_rack' && pattern.stepsData) {
                            if (soloedTracks.size > 0 && !soloedTracks.has(clip.trackIndex)) continue;
                            const triggerChannelRack = () => {
                                if (!isPlaying && !window.isRendering) return;
                                const frame = trackFrames[clip.trackIndex];
                                if (frame && frame.dataset.loaded === "true" && trackInstrumentIds[clip.trackIndex] === 'channel_rack') {
                                    frame.contentWindow.postMessage({
                                        type: 'play-step-from-pattern',
                                        step: relativeStep,
                                        patternSteps: pattern.stepsData
                                    }, '*');
                                }
                            };
                            if (delayMs > 0) {
                                setTimeout(triggerChannelRack, delayMs);
                            } else {
                                triggerChannelRack();
                            }
                        }
                    }
                }
            } else {
                pattern.notes.forEach(note => {
                    const absoluteStep = clip.startStep + note.startStep;

                    //La nota cade esattamente nello step che sto leggendo adesso(dal playhead)?"
                    if (absoluteStep >= currentStep - EPS && absoluteStep < currentStep + 1 - EPS && absoluteStep < clip.startStep + clip.length) {
                        const delayMs = Math.max(0, absoluteStep - currentStep) * stepDuration; //deviazione se la nota non è quantizzata  * stepDuration

                        setTimeout(() => {
                            if (!isPlaying) return;
                            const durationInMs = (note.lengthSteps || 1) * stepDuration;
                            const noteKey = `step_${currentStep}_${note.pitch}_${Math.random()}`;

                            triggerNote(note.pitch, noteKey, clip.trackIndex);
                            setTimeout(() => {
                                releaseNote(note.pitch, noteKey, clip.trackIndex);
                            }, durationInMs); //when note ends
                        }, delayMs); //when note starts
                    }
                });
            }
        }
    });

    // Move playhead to the NEXT step so it arrives there exactly when the next tick starts
    movePlayhead(currentStep + 1);

    // Auto-scroll logic if needed
    const scrollLeft = elements.gridScrollArea.scrollLeft;
    const viewWidth = elements.gridScrollArea.clientWidth;
    const playheadPos = currentStep * config.stepWidth;
    if (playheadPos > scrollLeft + viewWidth - 100) elements.gridScrollArea.scrollLeft += 200;

    currentStep++;

    // CHECK FOR RENDERING STOP
    if (typeof isRendering !== 'undefined' && isRendering) {
        // Update UI Progress
        const pct = Math.min(100, (currentStep / renderMaxSteps) * 100);
        if (elements.renderProgressBar) elements.renderProgressBar.style.width = pct + '%';

        // Calculate Time
        const elapsedSecs = (currentStep * stepDuration) / 1000;
        const mins = Math.floor(elapsedSecs / 60).toString().padStart(2, '0');
        const secs = Math.floor(elapsedSecs % 60).toString().padStart(2, '0');
        if (elements.renderTimerText) elements.renderTimerText.innerText = `${mins}:${secs}`;

        if (currentStep >= renderMaxSteps) {
            stopAudioRenderAndExport();
            return;
        }
    }

    if (isLoopActive && (!window.isRendering || window.isRendering === false)) {
        if (currentStep >= loopEndStep) {
            currentStep = loopStartStep;
            movePlayhead(currentStep, true);
        }
    } else if (currentStep >= config.totalSteps && !window.isRendering) {
        currentStep = 0;
        movePlayhead(0, true);
        elements.gridScrollArea.scrollLeft = 0;
    }

    expectedNextTick = performance.now() + stepDuration;
    intervalId = setTimeout(tick, stepDuration);
}

function getStepFromMouse(e) {
    const rect = elements.timeline.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const rawStep = x / config.stepWidth;
    const snappedStep = Math.max(0, Math.floor(rawStep / currentQuantization) * currentQuantization);
    return snappedStep;
}

function updateTimelineUI() {
    if (!elements.loopRegion) return;

    if (isLoopActive) {
        elements.loopRegion.style.display = 'block';
        elements.loopRegion.style.left = `${loopStartStep * config.stepWidth}px`;
        const width = (loopEndStep - loopStartStep) * config.stepWidth;
        elements.loopRegion.style.width = `${width}px`;

        // Se siamo fermi forziamo la testina dentro lo start (comportamento Piano Roll)
        if (!intervalId) {
            currentStep = loopStartStep;
        }
    } else {
        elements.loopRegion.style.display = 'none';
        if (!intervalId) {
            currentStep = customStartStep;
        }
    }

    // Riposizionamento testina visiva
    if (!intervalId) {
        movePlayhead(currentStep, true);
    }
}

function adjustColor(hex, amount) {
    let usePound = false; if (hex[0] === "#") { hex = hex.slice(1); usePound = true; }
    const num = parseInt(hex, 16);
    let r = (num >> 16) + amount; r = Math.max(0, Math.min(255, r));
    let b = ((num >> 8) & 0x00FF) + amount; b = Math.max(0, Math.min(255, b));
    let g = (num & 0x0000FF) + amount; g = Math.max(0, Math.min(255, g));
    return (usePound ? "#" : "") + (g | (b << 8) | (r << 16)).toString(16).padStart(6, '0');
}

elements.playBtn.addEventListener('click', play);
elements.stopBtn.addEventListener('click', stop);
// Close Instrument Editor
elements.closeInstrument.onclick = () => {
    elements.instrumentModal.style.display = 'none';
};


// This is needed because browsers block native file drag&drop into cross-origin iframes.
(function () { //IIFE --> Immediatly Invoked Function Expression (and for isolating variables!)
    const AUDIO_EXTS = /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i;

    function isAudioFile(file) {
        return file && (file.type.startsWith('audio/') || AUDIO_EXTS.test(file.name));
    }

    function getActiveSamplerFrame() {
        if (elements.instrumentModal.style.display !== 'flex') return null;
        const frame = trackFrames[currentEditingTrackIndex];
        if (!frame || frame.style.display === 'none') return null;
        // Only forward if it's a sampler instrument
        const instId = trackInstrumentIds[currentEditingTrackIndex];
        if (instId !== 'sampler') return null;
        return frame;
    }

    document.addEventListener('dragover', (e) => {
        const frame = getActiveSamplerFrame();
        if (!frame) return;
        // Check if there are files being dragged
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });

    document.addEventListener('drop', async (e) => {
        const frame = getActiveSamplerFrame();
        if (!frame) return;
        e.preventDefault();

        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file || !isAudioFile(file)) return;

        // Read as ArrayBuffer and forward to the iframe
        const arrayBuffer = await file.arrayBuffer();
        frame.contentWindow.postMessage({
            type: 'load-sample-buffer',
            buffer: arrayBuffer,
            name: file.name
        }, '*', [arrayBuffer]);
    });
})();

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    // If typing in an input, don't trigger spacebar play/stop
    if (e.target.tagName === 'INPUT') return;

    // Controlliamo in modo specifico quali modali sono aperti
    const isPianoRollOpen = elements.pianoRollModal.style.display === 'flex';
    const isChoiceModalOpen = elements.choiceModal.style.display === 'flex';
    const isMixerOpen = elements.mixerModal.style.display === 'flex';
    const isEqOpen = document.getElementById('eqModal') && document.getElementById('eqModal').style.display === 'flex';
    const isInstrumentOpen = elements.instrumentModal.style.display === 'flex';

    // 1. GESTIONE PLAY/STOP (Barra Spaziatrice)
    if (e.key === ' ') {
        e.preventDefault(); // Evita lo scroll della pagina

        // Se siamo nel Piano Roll (o nel menu di scelta), la playlist principale DEVE ignorare lo spazio
        if (isPianoRollOpen || isChoiceModalOpen) {
            return; // Ci penserà il Piano Roll a gestire il suo play/stop interno
        }

        // In tutti gli altri casi (Mixer aperto, EQ aperto, o niente aperto), controlla la playlist
        if (e.ctrlKey) {
            resetPlayback();
        } else if (e.shiftKey) {
            togglePause();
        } else {
            if (isPlaying) stop();
            else play();
        }
        return; // Interrompe qui per non attivare altre scorciatoie
    }

    // 2. BLOCCO SHORTCUT DI EDITING DELLA PLAYLIST
    // Se un *qualsiasi* modale è aperto, disabilita le scorciatoie della griglia (Canc, Copia, Frecce, ecc.)
    if (isPianoRollOpen || isChoiceModalOpen || isMixerOpen || isEqOpen || isInstrumentOpen) {
        return;
    }

    // 3. SCORCIATOIE DI EDITING (funzionano solo se siamo sulla griglia principale)
    if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        elements.loopBtn.click();
    }

    if (e.key === 'd' && e.ctrlKey) {
        e.preventDefault();
        duplicateSelectedClips();
    }

    if (e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') {
            e.preventDefault();
            copySelectedClips();
        } else if (k === 'v') {
            e.preventDefault();
            pasteClips();
        } else if (k === 'a') {
            e.preventDefault();
            selectAllClips();
        } else if (k === 'z' && e.shiftKey) {
            e.preventDefault();
            redoPlaylist();
        } else if (k === 'z') {
            e.preventDefault();
            undoPlaylist();
        } else if (k === 'y') {
            e.preventDefault();
            redoPlaylist();
        }
    } else {
        if (e.code === 'Delete' || e.code === 'Backspace') {
            if (selectedClipIds.size > 0) {
                e.preventDefault();
                deleteSelectedClips();
            }
        }
    }

    // Frecce per muovere le clip
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (selectedClipIds.size > 0) {
            e.preventDefault();
            moveSelectedClips(e.key, e.ctrlKey);
        }
    }
});

function copySelectedClips() {
    if (selectedClipIds.size === 0) return;
    clipboardClips = [];
    let minStep = Infinity;

    const selected = playlistClips.filter(c => selectedClipIds.has(c.id));
    selected.forEach(c => { if (c.startStep < minStep) minStep = c.startStep; }); //looking for the leftmost clip to start copying from there

    selected.forEach(c => {
        clipboardClips.push({
            ...c, //spread operator(copy all c properties)
            offsetStep: c.startStep - minStep  //saving the relative positions
        });
    });
}

function pasteClips() {
    if (clipboardClips.length === 0) return;

    selectedClipIds.clear();
    const pasteBaseStep = currentStep;

    clipboardClips.forEach(clip => {
        const newStep = pasteBaseStep + clip.offsetStep;
        if (newStep < config.totalSteps) {
            const newClip = { ...clip };
            newClip.id = `clip_${clipCounter++}`;
            newClip.startStep = newStep;
            delete newClip.offsetStep;
            playlistClips.push(newClip);
            renderClip(newClip);
            selectedClipIds.add(newClip.id);
        }
    });

    updateClipsSelectionUI();

    // Salva lo stato per abilitare Undo/Redo
    checkAndSavePlaylistState();
}

function deleteSelectedClips() {
    selectedClipIds.forEach(id => {
        const index = playlistClips.findIndex(c => c.id === id);
        if (index !== -1) {
            const el = document.getElementById(id);
            if (el) el.remove();
            playlistClips.splice(index, 1);
        }
    });
    selectedClipIds.clear();
    checkAndSavePlaylistState();
}

function selectAllClips() {
    selectedClipIds.clear();
    playlistClips.forEach(c => selectedClipIds.add(c.id));
    updateClipsSelectionUI();
}

function moveSelectedClips(key, ctrlKey) {
    let deltaStep = 0;
    let deltaTrack = 0;

    if (key === 'ArrowLeft') deltaStep = -currentQuantization;
    if (key === 'ArrowRight') deltaStep = currentQuantization;
    if (key === 'ArrowUp') deltaTrack = -1;
    if (key === 'ArrowDown') deltaTrack = +1;

    // Boundary checks
    let minStep = Infinity, maxStep = 0, minTrack = Infinity, maxTrack = 0;
    const selected = playlistClips.filter(c => selectedClipIds.has(c.id));
    selected.forEach(c => {
        if (c.startStep < minStep) minStep = c.startStep;
        if (c.startStep + c.length > maxStep) maxStep = c.startStep + c.length;
        if (c.trackIndex < minTrack) minTrack = c.trackIndex;
        if (c.trackIndex > maxTrack) maxTrack = c.trackIndex;
    });

    if (minStep + deltaStep < 0) deltaStep = -minStep;
    if (maxStep + deltaStep > config.totalSteps) deltaStep = config.totalSteps - maxStep;
    if (minTrack + deltaTrack < 0) deltaTrack = -minTrack;
    if (maxTrack + deltaTrack >= config.tracks) deltaTrack = config.tracks - 1 - maxTrack;

    if (deltaStep === 0 && deltaTrack === 0) return;

    selected.forEach(c => {
        c.startStep += deltaStep;
        c.trackIndex += deltaTrack;
        const el = document.getElementById(c.id);
        if (el) {
            el.style.left = `${c.startStep * config.stepWidth}px`;
            el.style.top = `${c.trackIndex * config.trackHeight}px`;
        }
    });
    checkAndSavePlaylistState();
}

function duplicateSelectedClips() {
    if (selectedClipIds.size === 0) return;

    const newSelections = new Set();
    const sortedSelectedClips = playlistClips
        .filter(c => selectedClipIds.has(c.id))
        .sort((a, b) => a.startStep - b.startStep);

    sortedSelectedClips.forEach(clip => {
        const newClip = {
            ...clip,
            id: `clip_${clipCounter++}`,
            startStep: clip.startStep + clip.length
        };
        playlistClips.push(newClip);
        renderClip(newClip);
        newSelections.add(newClip.id);
    });

    selectedClipIds = newSelections;
    updateClipsSelectionUI();
    console.log("[Paste] Clips added. Saving state...");
    checkAndSavePlaylistState();
}

function serializePlaylistState() {
    return JSON.stringify(playlistClips);
}

function checkAndSavePlaylistState(force = false) {
    const currentState = serializePlaylistState();
    if (currentState !== previousStateJSON || force) {
        undoStack.push(previousStateJSON);
        redoStack = [];
        previousStateJSON = currentState;
        console.log(`[UndoSystem] State saved. Undo stack size: ${undoStack.length}`);
    }
}

function undoPlaylist() {
    if (undoStack.length === 0) {
        console.log("[UndoSystem] Undo stack empty.");
        return;
    }

    console.log("[UndoSystem] Attempting Undo...");
    redoStack.push(previousStateJSON);
    const stateJSON = undoStack.pop();
    console.log(`[UndoSystem] Loading state from pop: ${stateJSON}`);
    loadPlaylistState(stateJSON);
}

function redoPlaylist() {
    if (redoStack.length === 0) return;

    console.log("[UndoSystem] Attempting Redo...");
    undoStack.push(previousStateJSON);
    const stateJSON = redoStack.pop();
    loadPlaylistState(stateJSON);
}

function loadPlaylistState(stateJSON) {
    if (!stateJSON) return;
    const data = JSON.parse(stateJSON);

    // Clear and reset UI
    const allClips = elements.tracksLayer.querySelectorAll('.clip');
    allClips.forEach(el => el.remove());

    playlistClips = data;
    selectedClipIds.clear();
    draggingClipId = null;
    resizingClipId = null;
    isPainting = false;
    isErasing = false;

    // Restore missing internal audio buffers post-serialization
    playlistClips.forEach(c => {
        if (c.type === 'audio' && c.audioBufferId && audioBufferDict.has(c.audioBufferId)) {
            c.buffer = audioBufferDict.get(c.audioBufferId);
        }
    });

    // Render all clips
    playlistClips.forEach(c => renderClip(c));

    // Update clipCounter to avoid ID conflicts
    let maxId = 0;
    playlistClips.forEach(c => {
        const num = parseInt(c.id.split('_')[1]);
        if (!isNaN(num) && num >= maxId) maxId = num + 1;
    });
    if (maxId > clipCounter) clipCounter = maxId;

    previousStateJSON = serializePlaylistState();
}

//listener for the mouse (in different situations)
window.addEventListener('mousemove', (e) => {
    if (draggingClipId) {
        const anchorClip = playlistClips.find(c => c.id === draggingClipId);
        if (!anchorClip) return;

        const rect = elements.tracksLayer.getBoundingClientRect();
        const mouseX = e.clientX - rect.left + elements.gridScrollArea.scrollLeft;
        const mouseY = e.clientY - rect.top;

        const rawStep = mouseX / config.stepWidth;
        const newAnchorStep = Math.max(0, Math.floor((rawStep - dragOffsetSteps) / currentQuantization) * currentQuantization);
        const newAnchorTrack = Math.max(0, Math.min(config.tracks - 1, Math.floor(mouseY / config.trackHeight)));

        // Calculate delta from anchor clip's initial position
        const anchorInit = multiDragInitialPositions[draggingClipId];
        if (!anchorInit) return;
        const deltaStep = newAnchorStep - anchorInit.startStep;
        const deltaTrack = newAnchorTrack - anchorInit.trackIndex;

        // Check boundaries for ALL selected clips
        let canMove = true;
        let adjustedDeltaStep = deltaStep;
        let adjustedDeltaTrack = deltaTrack;

        selectedClipIds.forEach(id => {
            const init = multiDragInitialPositions[id];
            if (!init) return;
            const candidateStep = init.startStep + deltaStep;
            const candidateTrack = init.trackIndex + deltaTrack;
            if (candidateStep < 0) adjustedDeltaStep = Math.max(adjustedDeltaStep, -init.startStep);
            if (candidateTrack < 0) adjustedDeltaTrack = Math.max(adjustedDeltaTrack, -init.trackIndex);
            if (candidateTrack >= config.tracks) adjustedDeltaTrack = Math.min(adjustedDeltaTrack, config.tracks - 1 - init.trackIndex);
        });

        // Apply movement to all selected clips
        selectedClipIds.forEach(id => {
            const c = playlistClips.find(pc => pc.id === id);
            const init = multiDragInitialPositions[id];
            if (!c || !init) return;

            const targetStep = init.startStep + adjustedDeltaStep;
            const targetTrack = init.trackIndex + adjustedDeltaTrack;

            // Automation clips: only horizontal movement
            if (c.type === 'automation') {
                if (targetStep !== c.startStep) {
                    c.startStep = targetStep;
                    const el = document.getElementById(c.id);
                    if (el) el.style.left = `${c.startStep * config.stepWidth}px`;
                }
            } else if (c.type === 'audio') {
                // Audio clips: allow movement to audio_track type tracks
                c.startStep = targetStep;
                if (trackTypes[targetTrack] === 'audio_track') {
                    c.trackIndex = targetTrack;
                }
                const el = document.getElementById(c.id);
                if (el) {
                    el.style.left = `${c.startStep * config.stepWidth}px`;
                    el.style.top = `${trackOffsetsY[c.trackIndex]}px`;
                }
            } else {
                const pattern = patterns[c.patternId];
                if (!pattern) return;

                // For pattern clips: respect target track constraints
                if (pattern.targetTrack === null || pattern.targetTrack === undefined) {
                    pattern.targetTrack = targetTrack;
                    c.startStep = targetStep;
                    c.trackIndex = targetTrack;
                } else if (pattern.targetTrack !== targetTrack) {
                    // Can't change track, only horizontal
                    c.startStep = targetStep;
                } else {
                    c.startStep = targetStep;
                    c.trackIndex = targetTrack;
                }

                const el = document.getElementById(c.id);
                if (el) {
                    el.style.left = `${c.startStep * config.stepWidth}px`;
                    el.style.top = `${trackOffsetsY[c.trackIndex]}px`;
                }
            }
        });

    } else if (resizingClipId) {
        const clip = playlistClips.find(c => c.id === resizingClipId);
        if (!clip) return;

        const deltaX = e.clientX - resizeStartX;
        const deltaSteps = Math.round(deltaX / config.stepWidth);

        if (isWarpResize && clip.type === 'audio') {
            // WARP MODE: change warpLength (and length together) — stretches audio without cropping
            const newWarpLength = Math.max(currentQuantization, Math.round((warpStartLength + deltaSteps) / currentQuantization) * currentQuantization);
            if (newWarpLength !== clip.warpLength) {
                clip.warpLength = newWarpLength;
                clip.length = newWarpLength; // visual length follows warp
                const el = document.getElementById(clip.id);
                if (el) {
                    el.style.width = `${clip.length * config.stepWidth}px`;
                    const canvas = el.querySelector('canvas');
                    if (canvas) drawAudioWaveform(clip, canvas);
                }
            }
        } else {
            // CROP MODE (normal resize)
            const newLength = Math.max(currentQuantization, Math.round((resizeStartLength + deltaSteps) / currentQuantization) * currentQuantization);

            if (newLength !== clip.length) {
                const oldLength = clip.length;
                clip.length = newLength;

                if (clip.type === 'audio') {
                    if (!clip.warpLength) clip.warpLength = oldLength; // Crop
                }

                // For automation clips: keep nodes at their absolute positions
                if (clip.type === 'automation' && clip.nodes && oldLength > 0) {
                    const ratio = oldLength / newLength;
                    clip.nodes.forEach((node, i) => {
                        // First node always stays at 0, last node always stays at 1
                        if (i === 0) return;
                        if (i === clip.nodes.length - 1) return;
                        // Rescale intermediate nodes to keep absolute step positions
                        node.timePct = Math.max(0, Math.min(1, node.timePct * ratio));
                    });
                }

                const el = document.getElementById(clip.id);
                if (el) {
                    el.style.width = `${clip.length * config.stepWidth}px`;

                    if (clip.type === 'automation') {
                        // Redraw the automation SVG with updated width
                        const autoContainer = el.querySelector('.automation-container');
                        if (autoContainer && autoContainer._redrawAutomation) {
                            autoContainer._redrawAutomation();
                        }
                    } else if (clip.type === 'audio') {
                        // Redraw the waveform canvas for audio clip
                        const canvas = el.querySelector('canvas');
                        if (canvas) {
                            drawAudioWaveform(clip, canvas);
                        }
                    } else {
                        const notesContainer = el.querySelector('.clip-notes-preview');
                        if (notesContainer) {
                            notesContainer.innerHTML = '';
                            renderNotesToPreview(clip, notesContainer);
                        }
                    }
                }
            }
        }
    }

    if (isDraggingTimeline) {
        // Logica Timeline Elastica (Selezione Loop)
        const step = getStepFromMouse(e);

        if (step !== timelineDragAnchor) {
            // Se abbiamo iniziato a trascinare, forziamo l'attivazione del Loop
            if (!isLoopActive) {
                isLoopActive = true;
                elements.loopBtn.classList.add('active');
            }
        }

        if (isLoopActive) {
            if (step >= timelineDragAnchor) {
                loopStartStep = timelineDragAnchor;
                loopEndStep = step + currentQuantization;
            } else {
                loopStartStep = step;
                loopEndStep = timelineDragAnchor + currentQuantization;
            }
            updateTimelineUI();
        }
    }

    if (isPainting) {
        const row = e.target.closest('.track-row');
        if (row) {
            const trackIndex = parseInt(row.dataset.index);
            addClip(e, trackIndex);
        }
    }

    if (isErasing) {
        const row = e.target.closest('.track-row');
        if (row) {
            const trackIndex = parseInt(row.dataset.index);
            removeClipAt(e, trackIndex);
        }
    }

    // Rubber-band: detect threshold and switch from pending to active
    if (rubberBandPending && !isRubberBanding) {
        const dx = Math.abs(e.clientX - rubberBandMouseStartX);
        const dy = Math.abs(e.clientY - rubberBandMouseStartY);
        if (dx > 5 || dy > 5) {
            // Threshold exceeded → start rubber-band selection
            isRubberBanding = true;
            rubberBandPending = false;
            if (!rubberBandEl) {
                rubberBandEl = document.createElement('div');
                rubberBandEl.className = 'rubber-band';
                elements.gridScrollArea.appendChild(rubberBandEl);
            }
            rubberBandEl.style.display = 'block';
        }
    }

    if (isRubberBanding && rubberBandEl) {
        const scrollRect = elements.gridScrollArea.getBoundingClientRect();
        const currentX = e.clientX - scrollRect.left + elements.gridScrollArea.scrollLeft;
        const currentY = e.clientY - scrollRect.top + elements.gridScrollArea.scrollTop;

        const x1 = Math.min(rubberBandStartX, currentX);
        const y1 = Math.min(rubberBandStartY, currentY);
        const x2 = Math.max(rubberBandStartX, currentX);
        const y2 = Math.max(rubberBandStartY, currentY);

        rubberBandEl.style.left = `${x1}px`;
        rubberBandEl.style.top = `${y1}px`;
        rubberBandEl.style.width = `${x2 - x1}px`;
        rubberBandEl.style.height = `${y2 - y1}px`;

        // Real-time highlight: select clips that intersect the rectangle
        const timelineH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--timeline-height')) || 30;
        const bandLeft = x1;
        const bandRight = x2;
        const bandTop = y1 - timelineH;
        const bandBottom = y2 - timelineH;

        selectedClipIds.clear();
        playlistClips.forEach(c => {
            const clipLeft = c.startStep * config.stepWidth;
            const clipRight = clipLeft + c.length * config.stepWidth;
            const clipTop = trackOffsetsY[c.trackIndex] || (c.trackIndex * config.trackHeight);
            const clipBottom = clipTop + config.trackHeight;

            // Check intersection
            if (clipRight > bandLeft && clipLeft < bandRight && clipBottom > bandTop && clipTop < bandBottom) {
                selectedClipIds.add(c.id);
            }
        });
        updateClipsSelectionUI();
    }
});

//to save CPU/GPU  
function broadcastMixerVisibility(visible) {  //alerts meters, spectrum analyzers, etc... if the mixer is visible 
    trackFrames.forEach(frame => {
        if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage({ type: 'set-mixer-visibility', visible }, '*');
        }
    });
}

// === MIXER LOGIC ===
elements.mixerBtn.onclick = () => {
    elements.mixerModal.style.display = 'flex';
    renderMixer();
    broadcastMixerVisibility(true);
};

elements.closeMixerBtn.onclick = () => {
    elements.mixerModal.style.display = 'none';
    broadcastMixerVisibility(false);
};

const trackMeters = {};
const activePeaks = { master: 0 };

function dawRenderLoop() { //Render of real-time parts of the project
    // === Read GLOBAL master analyser for true summed peak ===
    globalMasterAnalyser.getFloatTimeDomainData(globalMasterTimeData);
    let globalMasterPeak = 0;
    for (let i = 0; i < globalMasterTimeData.length; i++) {
        const abs = Math.abs(globalMasterTimeData[i]);
        if (abs > globalMasterPeak) globalMasterPeak = abs;
    }
    activePeaks.master = globalMasterPeak;

    // === Read global master spectrum for EQ visualization ===
    if (activeEqMeterId === 'master') {
        globalMasterAnalyser.getByteFrequencyData(globalMasterFreqData);
        currentSpectrumData = globalMasterFreqData;
    }

    if (elements.mixerModal.style.display === 'flex') { //if the mixer is visible!
        Object.keys(trackMeters).forEach(id => {
            const peak = activePeaks[id] || 0;
            if (trackMeters[id]) {
                // Logarithmic mapping for better visual db feel: sqrt provides a nice natural curve
                const mappedPeak = Math.min(1, Math.sqrt(peak));
                trackMeters[id].style.transform = `scaleY(${mappedPeak})`;
            }
            // Decay per-track peaks (master is read fresh every frame from the analyser)
            if (id !== 'master') activePeaks[id] *= 0.85;
        });

        // Master meter
        if (trackMeters['master']) {
            const mappedMaster = Math.min(1, Math.sqrt(globalMasterPeak));
            trackMeters['master'].style.transform = `scaleY(${mappedMaster})`;
        }
    }
    requestAnimationFrame(dawRenderLoop); //loop of the render frame by frame (most powerful than setinterval)
}
requestAnimationFrame(dawRenderLoop);

let masterMixerState = { volume: 1.0, reverb: 0, delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0, limiter: false };

function renderMixer() {
    elements.mixerStripsContainer.innerHTML = '';

    // Clear existing meter references and callbacks
    for (let key in trackMeters) delete trackMeters[key];
    for (let key in mixerAutomationCallbacks) delete mixerAutomationCallbacks[key];

    const eqParams = ['eqLow', 'eqLowFreq', 'eqMid', 'eqMidFreq', 'eqMidQ', 'eqHigh', 'eqHighFreq'];
    const eqRanges = {
        eqLow: { min: -12, max: 12 }, eqLowFreq: { min: 20, max: 2000 },
        eqMid: { min: -12, max: 12 }, eqMidFreq: { min: 200, max: 8000 }, eqMidQ: { min: 0.1, max: 10 },
        eqHigh: { min: -12, max: 12 }, eqHighFreq: { min: 1000, max: 20000 }
    };

    const registerEqCallbacks = (meterId, onChangeFx) => {
        eqParams.forEach(param => {
            const paramId = `mixer_${meterId}_${param}`;
            const range = eqRanges[param];
            mixerAutomationCallbacks[paramId] = {
                min: range.min,
                max: range.max,
                callback: onChangeFx
            };
        });
    };

    // Rendering tracce
    for (let i = 0; i < config.tracks; i++) {
        const type = trackTypes[i];
        const state = mixerState[i] || { main: 1.0, pan: 0, subs: [], subsPan: [], names: [], mainFx: { reverb: 0, delay: 0 }, subsFx: [] };
        if (!state.mainFx) state.mainFx = { reverb: 0, delay: 0 };
        if (!state.subsFx) state.subsFx = [];
        if (state.pan === undefined) state.pan = 0;
        if (!state.subsPan) state.subsPan = [];

        const trackColor = trackColors[i] || '#3b82f6';

        if (type === 'channel_rack') {
            const numSubs = state.subs.length > 0 ? state.subs.length : 4;
            for (let j = 0; j < numSubs; j++) {
                const subVol = state.subs[j] !== undefined ? state.subs[j] : 1.0;
                const subPan = state.subsPan[j] !== undefined ? state.subsPan[j] : 0;
                const subFx = state.subsFx[j] || { reverb: 0, delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0 };
                const name = state.names[j] || `CH ${j + 1}`;
                const subOnChangeFx = (fxName, val) => {
                    if (!mixerState[i].subsFx[j]) mixerState[i].subsFx[j] = { reverb: 0, delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0 };
                    mixerState[i].subsFx[j][fxName] = val;
                    const frame = trackFrames[i];
                    if (frame && frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: 'set-mixer-fx', subIndex: j, fx: fxName, value: val }, '*');
                    }
                };
                createMixerStrip(`${i}_${j}`, name, subVol, subPan, subFx, trackColor, (vol) => {
                    mixerState[i].subs[j] = vol;
                    const frame = trackFrames[i];
                    if (frame && frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: 'set-mixer-volume', subIndex: j, volume: vol }, '*');
                    }
                }, (pan) => {
                    if (!mixerState[i].subsPan) mixerState[i].subsPan = [];
                    mixerState[i].subsPan[j] = pan;
                    const frame = trackFrames[i];
                    if (frame && frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: 'set-mixer-pan', subIndex: j, pan }, '*');
                    }
                }, subOnChangeFx);
                registerEqCallbacks(`${i}_${j}`, subOnChangeFx);
            }
        } else {
            // Piano Roll (Sampler/Synth) o Drum Rack
            const mainFxState = state.mainFx || { reverb: 0, delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0 };
            const mainOnChangeFx = (fxName, val) => {
                if (!mixerState[i].mainFx) mixerState[i].mainFx = { reverb: 0, delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0 };
                mixerState[i].mainFx[fxName] = val;
                const frame = trackFrames[i];
                if (frame && frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'set-mixer-fx', fx: fxName, value: val }, '*');
                }
            };
            createMixerStrip(`${i}`, `${trackNames[i]}`, state.main, state.pan, mainFxState, trackColor, (vol) => {
                mixerState[i].main = vol;
                const frame = trackFrames[i];
                if (frame && frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'set-mixer-volume', volume: vol }, '*');
                }
            }, (pan) => {
                mixerState[i].pan = pan;
                const frame = trackFrames[i];
                if (frame && frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'set-mixer-pan', pan }, '*');
                }
            }, mainOnChangeFx);
            registerEqCallbacks(`${i}`, mainOnChangeFx);
        }
    }

    // Master Track (no pan on master)
    const masterOnChangeFx = (fxName, val) => {
        masterMixerState[fxName] = val;
        trackFrames.forEach(frame => {
            if (frame && frame.contentWindow) {
                frame.contentWindow.postMessage({ type: 'set-master-fx', fx: fxName, value: val }, '*');
            }
        });
    };
    createMixerStrip('master', 'Master', masterMixerState.volume, 0, masterMixerState, '#ffffff', (vol) => {
        masterMixerState.volume = vol;
        trackFrames.forEach(frame => {
            if (frame && frame.contentWindow) {
                frame.contentWindow.postMessage({ type: 'set-master-volume', volume: vol }, '*');
            }
        });
    }, null, masterOnChangeFx);
    registerEqCallbacks('master', masterOnChangeFx);
}

function createMixerStrip(meterId, label, initialVolume, initialPan, fxState, trackColor, onChangeVol, onChangePan, onChangeFx) {
    const strip = document.createElement('div');
    strip.style.display = 'flex';
    strip.style.flexDirection = 'column';
    strip.style.alignItems = 'center';
    strip.style.background = '#2d343e';
    strip.style.padding = '10px 5px';
    strip.style.borderRadius = '8px';
    strip.style.minWidth = '75px';
    strip.style.border = '1px solid #475569';
    if (label !== 'Master') strip.style.borderBottom = `4px solid ${trackColor}`;
    else strip.style.borderBottom = `4px double #ffffff`;
    strip.style.boxShadow = `0 4px 6px rgba(0,0,0,0.3), inset 0 2px 0 ${trackColor}44`;

    // FX Knobs
    const createKnob = (name, initVal, minVal, maxVal, onChange, automationParamId) => {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'center';
        wrap.style.marginBottom = '8px';
        wrap.style.width = '100%';

        const lbl = document.createElement('div');
        lbl.innerText = name;
        lbl.style.fontSize = '0.6rem';
        lbl.style.color = '#94a3b8';
        lbl.style.marginBottom = '2px';

        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = minVal;
        inp.max = maxVal;
        inp.step = (maxVal - minVal) / 100;
        inp.value = initVal || 0;
        inp.style.width = '80%';
        inp.style.height = '4px';
        inp.style.appearance = 'none';
        inp.style.background = '#475569';
        inp.style.borderRadius = '2px';
        inp.style.outline = 'none';

        // Assign unique ID for automation targeting
        if (automationParamId) inp.id = automationParamId;

        inp.oninput = (e) => onChange(parseFloat(e.target.value));

        // Right-click: create mixer automation clip
        if (automationParamId) {
            inp.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                // Determine which track this belongs to
                let sourceTrackIndex = 0;
                if (meterId === 'master') {
                    sourceTrackIndex = 0; // Master automations go on track 0
                } else {
                    const parts = meterId.split('_');
                    sourceTrackIndex = parseInt(parts[0]) || 0;
                }

                const clipId = `clip_auto_${clipCounter++}`;
                const newClip = {
                    id: clipId,
                    type: 'automation',
                    source: 'mixer',
                    paramId: automationParamId,
                    paramName: `${label} ${name}`,
                    paramMin: minVal,
                    paramMax: maxVal,
                    trackIndex: sourceTrackIndex,
                    startStep: currentStep,
                    length: 16,
                    nodes: [
                        { timePct: 0, valuePct: (initVal - minVal) / (maxVal - minVal) },
                        { timePct: 1, valuePct: (initVal - minVal) / (maxVal - minVal) }
                    ],
                    color: '#fb923c' // Orange for mixer automations
                };
                playlistClips.push(newClip);
                trackExpandedLanes[sourceTrackIndex] = true;
                rebuildTracksUI();
                checkAndSavePlaylistState();
            });
        }

        wrap.appendChild(lbl);
        wrap.appendChild(inp);
        return wrap;
    };

    const eqBtn = document.createElement('button');
    eqBtn.innerText = 'EQ';
    eqBtn.style.fontSize = '0.7rem';
    eqBtn.style.padding = '4px';
    eqBtn.style.background = '#334155';
    eqBtn.style.color = '#e2e8f0';
    eqBtn.style.border = '1px solid #475569';
    eqBtn.style.borderRadius = '3px';
    eqBtn.style.cursor = 'pointer';
    eqBtn.style.marginBottom = '10px';
    eqBtn.style.width = '80%';
    eqBtn.style.fontWeight = 'bold';
    eqBtn.onclick = () => openEqModal(meterId, label, fxState, onChangeFx, trackColor);

    // Add hover effect
    eqBtn.onmouseover = () => eqBtn.style.background = '#475569';
    eqBtn.onmouseout = () => eqBtn.style.background = '#334155';

    strip.appendChild(eqBtn);

    strip.appendChild(createKnob('REV', fxState.reverb, 0, 1, (val) => onChangeFx('reverb', val), `mixer_${meterId}_reverb`));
    strip.appendChild(createKnob('DLY', fxState.delay, 0, 1, (val) => onChangeFx('delay', val), `mixer_${meterId}_delay`));

    // PAN KNOB — only for track strips, not master
    if (onChangePan !== null) {
        const panWrap = document.createElement('div');
        panWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;margin-bottom:8px;width:100%;';

        const panLbl = document.createElement('div');
        panLbl.style.cssText = 'font-size:0.6rem;color:#94a3b8;margin-bottom:2px;';
        panLbl.innerText = 'PAN';

        const panValDisplay = document.createElement('div');
        panValDisplay.style.cssText = 'font-size:0.6rem;color:#60a5fa;min-width:28px;text-align:center;';
        const formatPan = v => v === 0 ? 'C' : (v > 0 ? `R${Math.round(v * 100)}` : `L${Math.round(-v * 100)}`);
        panValDisplay.innerText = formatPan(initialPan || 0);

        const panInp = document.createElement('input');
        panInp.type = 'range';
        panInp.min = -1;
        panInp.max = 1;
        panInp.step = 0.01;
        panInp.value = initialPan || 0;
        panInp.id = `mixer_${meterId}_pan`;
        panInp.style.cssText = 'width:80%;height:4px;appearance:none;background:#475569;border-radius:2px;outline:none;';
        panInp.title = 'Pan (right-click = automation)';

        panInp.oninput = (e) => {
            const v = parseFloat(e.target.value);
            panValDisplay.innerText = formatPan(v);
            if (onChangePan) onChangePan(v);
        };

        // Double-click resets to center
        panInp.ondblclick = () => {
            panInp.value = 0;
            panValDisplay.innerText = 'C';
            if (onChangePan) onChangePan(0);
        };

        // Right-click: create automation clip
        panInp.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            let sourceTrackIndex = 0;
            if (meterId !== 'master') {
                sourceTrackIndex = parseInt(meterId.split('_')[0]) || 0;
            }
            const clipId = `clip_auto_${clipCounter++}`;
            const newClip = {
                id: clipId,
                type: 'automation',
                source: 'mixer',
                paramId: `mixer_${meterId}_pan`,
                paramName: `${label} Pan`,
                paramMin: -1,
                paramMax: 1,
                trackIndex: sourceTrackIndex,
                startStep: currentStep,
                length: 16,
                nodes: [
                    { timePct: 0, valuePct: (parseFloat(panInp.value) + 1) / 2 },
                    { timePct: 1, valuePct: (parseFloat(panInp.value) + 1) / 2 }
                ],
                color: '#fb923c'
            };
            playlistClips.push(newClip);
            trackExpandedLanes[sourceTrackIndex] = true;
            rebuildTracksUI();
            checkAndSavePlaylistState();
        });

        // Register for automation playback
        mixerAutomationCallbacks[`mixer_${meterId}_pan`] = {
            min: -1, max: 1,
            callback: (_, val) => {
                panInp.value = val;
                panValDisplay.innerText = formatPan(val);
                if (onChangePan) onChangePan(val);
            }
        };

        panWrap.appendChild(panLbl);
        panWrap.appendChild(panInp);
        panWrap.appendChild(panValDisplay);
        strip.appendChild(panWrap);
    }

    const valDisplay = document.createElement('div');
    valDisplay.style.color = label === 'Master' ? '#ff4081' : '#00ff88';
    valDisplay.style.fontSize = '0.75rem';
    valDisplay.style.fontWeight = 'bold';
    valDisplay.style.marginBottom = '10px';
    valDisplay.style.marginTop = '5px';
    valDisplay.style.background = '#1e293b';
    valDisplay.style.padding = '2px 8px';
    valDisplay.style.borderRadius = '4px';
    valDisplay.style.border = '1px solid #334155';
    valDisplay.innerText = Math.round(initialVolume * 100) + '%';

    const faderAndMeterCont = document.createElement('div');
    faderAndMeterCont.style.display = 'flex';
    faderAndMeterCont.style.flexDirection = 'row';
    faderAndMeterCont.style.gap = '8px';
    faderAndMeterCont.style.alignItems = 'center';

    const faderCont = document.createElement('div');
    faderCont.style.position = 'relative';
    faderCont.style.height = '140px';
    faderCont.style.width = '30px';
    faderCont.style.background = '#1e293b';
    faderCont.style.borderRadius = '15px';
    faderCont.style.display = 'flex';
    faderCont.style.justifyContent = 'center';
    faderCont.style.boxShadow = 'inset 0 2px 5px rgba(0,0,0,0.5)';

    const fader = document.createElement('input');
    fader.type = 'range';
    fader.orient = 'vertical';
    fader.min = '0';
    fader.max = '1';
    fader.step = '0.01';
    fader.value = initialVolume;
    fader.style.appearance = 'slider-vertical';
    fader.style.width = '100%';
    fader.style.height = '100%';
    fader.style.margin = '0';
    fader.style.cursor = 'pointer';
    fader.style.outline = 'none';

    fader.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        valDisplay.innerText = Math.round(val * 100) + '%';
        onChangeVol(val);
    });

    faderCont.appendChild(fader);

    // DB METER
    const meterCont = document.createElement('div');
    meterCont.style.width = '10px';
    meterCont.style.height = '140px';
    meterCont.style.background = '#0f172a';
    meterCont.style.borderRadius = '3px';
    meterCont.style.position = 'relative';
    meterCont.style.overflow = 'hidden';
    meterCont.style.border = '1px solid #1e293b';

    const meterFill = document.createElement('div');
    meterFill.style.width = '100%';
    meterFill.style.height = '100%';
    meterFill.style.position = 'absolute';
    meterFill.style.bottom = '0';
    // Colori classici rosso/arancio/verde FL Studio
    meterFill.style.background = 'linear-gradient(to top, #00ff00 0%, #00ff00 65%, #ffcc00 80%, #ff0000 100%)';
    meterFill.style.transformOrigin = 'bottom';
    meterFill.style.transform = 'scaleY(0)';
    // No transition to make it completely snappy (FL Studio style), decay handled by JS

    meterCont.appendChild(meterFill);
    trackMeters[meterId] = meterFill;

    faderAndMeterCont.appendChild(faderCont);
    faderAndMeterCont.appendChild(meterCont);

    const nameLabel = document.createElement('div');
    nameLabel.style.color = label === 'Master' ? '#ffffff' : '#e2e8f0';
    nameLabel.style.fontSize = '0.70rem';
    nameLabel.style.fontWeight = label === 'Master' ? 'bold' : '500';
    nameLabel.style.marginTop = '15px';
    nameLabel.style.textAlign = 'center';
    nameLabel.style.width = '100%';
    nameLabel.style.maxWidth = '65px';
    nameLabel.style.whiteSpace = 'nowrap';
    nameLabel.style.overflow = 'hidden';
    nameLabel.style.textOverflow = 'ellipsis';
    nameLabel.innerText = label;

    strip.appendChild(valDisplay);
    strip.appendChild(faderAndMeterCont);
    strip.appendChild(nameLabel);

    // Bottom container for Limiter button or spacer (keeps faders aligned)
    const bottomCont = document.createElement('div');
    bottomCont.style.height = '32px'; // Height for the button + margin
    bottomCont.style.width = '100%';
    bottomCont.style.display = 'flex';
    bottomCont.style.justifyContent = 'center';
    bottomCont.style.alignItems = 'flex-end';

    if (label === 'Master') {
        const limBtn = document.createElement('button');
        limBtn.innerText = masterMixerState.limiter ? 'LIMITER: ON' : 'LIMITER: OFF';
        limBtn.style.fontSize = '0.55rem';
        limBtn.style.padding = '4px';
        limBtn.style.background = masterMixerState.limiter ? '#ff4081' : '#475569';
        limBtn.style.color = '#fff';
        limBtn.style.border = 'none';
        limBtn.style.borderRadius = '3px';
        limBtn.style.cursor = 'pointer';
        limBtn.style.marginTop = '10px';
        limBtn.style.fontWeight = 'bold';
        limBtn.onclick = () => {
            masterMixerState.limiter = !masterMixerState.limiter;
            limBtn.innerText = masterMixerState.limiter ? 'LIMITER: ON' : 'LIMITER: OFF';
            limBtn.style.background = masterMixerState.limiter ? '#ff4081' : '#475569';
            trackFrames.forEach(frame => {
                if (frame && frame.contentWindow) {
                    frame.contentWindow.postMessage({ type: 'set-master-limiter', active: masterMixerState.limiter }, '*');
                }
            });
        };
        bottomCont.appendChild(limBtn);
    }

    strip.appendChild(bottomCont);
    elements.mixerStripsContainer.appendChild(strip);
}

// --- EQ MODAL LOGIC & GRAPHICS ---
const eqModal = document.getElementById('eqModal');
const closeEqBtn = document.getElementById('closeEqBtn');
const eqCanvas = document.getElementById('eqCanvas');
const eqCtx = eqCanvas ? eqCanvas.getContext('2d') : null;

const eqInputs = {
    eqLowFreq: document.getElementById('eqLowFreq'),
    eqLowGain: document.getElementById('eqLowGain'),
    eqMidFreq: document.getElementById('eqMidFreq'),
    eqMidQ: document.getElementById('eqMidQ'),
    eqMidGain: document.getElementById('eqMidGain'),
    eqHighFreq: document.getElementById('eqHighFreq'),
    eqHighGain: document.getElementById('eqHighGain')
};
const eqVals = {
    eqLowFreq: document.getElementById('eqLowFreqVal'),
    eqLowGain: document.getElementById('eqLowGainVal'),
    eqMidFreq: document.getElementById('eqMidFreqVal'),
    eqMidQ: document.getElementById('eqMidQVal'),
    eqMidGain: document.getElementById('eqMidGainVal'),
    eqHighFreq: document.getElementById('eqHighFreqVal'),
    eqHighGain: document.getElementById('eqHighGainVal')
};

let currentEqOnChange = null;
let currentEqState = null;
let eqAnimationId = null;
let currentSpectrumData = null;
let activeEqMeterId = null;

const eqDummyCtx = new (window.AudioContext || window.webkitAudioContext)();
const dummyLow = eqDummyCtx.createBiquadFilter(); dummyLow.type = 'lowshelf';
const dummyMid = eqDummyCtx.createBiquadFilter(); dummyMid.type = 'peaking';
const dummyHigh = eqDummyCtx.createBiquadFilter(); dummyHigh.type = 'highshelf';

function getXForFreq(freq, width) {
    const minF = Math.log10(20); const maxF = Math.log10(20000);
    return ((Math.log10(Math.max(20, Math.min(20000, freq))) - minF) / (maxF - minF)) * width;
}

function getFreqForX(x, width) {
    const minF = Math.log10(20); const maxF = Math.log10(20000);
    return Math.pow(10, minF + (x / width) * (maxF - minF));
}

function getYForDb(db, height) {
    const normalized = (db + 24) / 48;
    return height - (normalized * height);
}

// DYNAMIC RENDER LOOP
function drawEqCurve() {
    if (!eqCtx) return;

    // Stop the loop if we close the window
    if (eqModal.style.display !== 'flex') {
        eqAnimationId = null;
        return;
    }

    const rect = eqCanvas.getBoundingClientRect();
    if (eqCanvas.width !== rect.width || eqCanvas.height !== rect.height) {
        eqCanvas.width = rect.width; eqCanvas.height = rect.height;
    }

    const width = eqCanvas.width;
    const height = eqCanvas.height;
    eqCtx.clearRect(0, 0, width, height);

    // 1. GRID DRAWING
    eqCtx.strokeStyle = '#334155'; eqCtx.lineWidth = 1; eqCtx.beginPath();
    [100, 1000, 10000].forEach(freq => {
        const x = getXForFreq(freq, width);
        eqCtx.moveTo(x, 0); eqCtx.lineTo(x, height);
    });
    for (let db = -24; db <= 24; db += 12) {
        const y = getYForDb(db, height);
        eqCtx.moveTo(0, y); eqCtx.lineTo(width, y);
    }
    eqCtx.stroke();
    eqCtx.strokeStyle = '#475569'; eqCtx.lineWidth = 2; eqCtx.beginPath();
    const zeroY = getYForDb(0, height);
    eqCtx.moveTo(0, zeroY); eqCtx.lineTo(width, zeroY);
    eqCtx.stroke();

    // 2. REAL-TIME FFT SPECTRUM DRAWING (Behind the curve)
    if (currentSpectrumData && currentSpectrumData.length > 0) {
        const binCount = currentSpectrumData.length;
        const nyquist = eqDummyCtx.sampleRate / 2;

        let gradient = eqCtx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, 'rgba(59, 130, 246, 0.05)');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0.6)');

        eqCtx.fillStyle = gradient;
        eqCtx.beginPath();
        eqCtx.moveTo(0, height);

        for (let i = 0; i < binCount; i++) {
            const value = currentSpectrumData[i];
            const percent = value / 255;
            const h = percent * height;
            const y = height - h;
            const freq = i * nyquist / binCount;

            // Exact logarithmic mapping
            if (freq >= 20 && freq <= 20000) {
                const x = getXForFreq(freq, width);
                eqCtx.lineTo(x, y);
            }
        }
        eqCtx.lineTo(width, height);
        eqCtx.fill();
    }

    // 3. EQ CURVE DRAWING (Instantly updated by filters)
    const numPoints = Math.min(width, 500);
    const freqArray = new Float32Array(numPoints);
    for (let i = 0; i < numPoints; i++) freqArray[i] = getFreqForX((i / numPoints) * width, width);

    const magLow = new Float32Array(numPoints); const phaseLow = new Float32Array(numPoints);
    dummyLow.getFrequencyResponse(freqArray, magLow, phaseLow);

    const magMid = new Float32Array(numPoints); const phaseMid = new Float32Array(numPoints);
    dummyMid.getFrequencyResponse(freqArray, magMid, phaseMid);

    const magHigh = new Float32Array(numPoints); const phaseHigh = new Float32Array(numPoints);
    dummyHigh.getFrequencyResponse(freqArray, magHigh, phaseHigh);

    eqCtx.beginPath();
    for (let i = 0; i < numPoints; i++) {
        const totalMag = magLow[i] * magMid[i] * magHigh[i];
        let db = 20 * Math.log10(totalMag);
        if (!isFinite(db)) db = 0;
        const x = (i / numPoints) * width;
        const y = getYForDb(db, height);
        if (i === 0) eqCtx.moveTo(x, y); else eqCtx.lineTo(x, y);
    }
    eqCtx.strokeStyle = '#38bdf8'; eqCtx.lineWidth = 3; eqCtx.stroke();
    eqCtx.lineTo(width, height); eqCtx.lineTo(0, height);
    eqCtx.fillStyle = 'rgba(56, 189, 248, 0.2)'; eqCtx.fill();

    // 4. CONTROL DOTS DRAWING
    const drawDot = (freq, gain, color) => {
        const x = getXForFreq(freq, width); const y = getYForDb(gain, height);
        eqCtx.beginPath(); eqCtx.arc(x, y, 6, 0, Math.PI * 2);
        eqCtx.fillStyle = color; eqCtx.fill();
        eqCtx.strokeStyle = '#fff'; eqCtx.lineWidth = 2; eqCtx.stroke();
    };
    drawDot(dummyLow.frequency.value, dummyLow.gain.value, '#ef4444');
    drawDot(dummyMid.frequency.value, dummyMid.gain.value, '#10b981');
    drawDot(dummyHigh.frequency.value, dummyHigh.gain.value, '#3b82f6');

    // Call next frame (Smooth 60fps loop)
    eqAnimationId = requestAnimationFrame(drawEqCurve);
}

function updateEqUI() {
    if (!currentEqState) return;

    // Instantly update the Dummy nodes. The renderLoop will read them on the next frame.
    dummyLow.frequency.value = currentEqState.eqLowFreq || 250;
    dummyLow.gain.value = currentEqState.eqLow || 0;
    dummyMid.frequency.value = currentEqState.eqMidFreq || 1000;
    dummyMid.Q.value = currentEqState.eqMidQ || 1.0;
    dummyMid.gain.value = currentEqState.eqMid || 0;
    dummyHigh.frequency.value = currentEqState.eqHighFreq || 4000;
    dummyHigh.gain.value = currentEqState.eqHigh || 0;

    eqInputs.eqLowFreq.value = dummyLow.frequency.value;
    eqVals.eqLowFreq.innerText = Math.round(dummyLow.frequency.value) + ' Hz';
    eqInputs.eqLowGain.value = dummyLow.gain.value;
    eqVals.eqLowGain.innerText = dummyLow.gain.value.toFixed(1) + ' dB';

    eqInputs.eqMidFreq.value = dummyMid.frequency.value;
    eqVals.eqMidFreq.innerText = Math.round(dummyMid.frequency.value) + ' Hz';
    eqInputs.eqMidQ.value = dummyMid.Q.value;
    eqVals.eqMidQ.innerText = dummyMid.Q.value.toFixed(1);
    eqInputs.eqMidGain.value = dummyMid.gain.value;
    eqVals.eqMidGain.innerText = dummyMid.gain.value.toFixed(1) + ' dB';

    eqInputs.eqHighFreq.value = dummyHigh.frequency.value;
    eqVals.eqHighFreq.innerText = Math.round(dummyHigh.frequency.value) + ' Hz';
    eqInputs.eqHighGain.value = dummyHigh.gain.value;
    eqVals.eqHighGain.innerText = dummyHigh.gain.value.toFixed(1) + ' dB';
}

function setupEqListeners() {
    const eqParamNames = {
        eqLowFreq: { name: 'EQ Low Freq', min: 20, max: 2000 },
        eqLowGain: { name: 'EQ Low Gain', min: -12, max: 12 },
        eqMidFreq: { name: 'EQ Mid Freq', min: 200, max: 8000 },
        eqMidQ: { name: 'EQ Mid Q', min: 0.1, max: 10 },
        eqMidGain: { name: 'EQ Mid Gain', min: -12, max: 12 },
        eqHighFreq: { name: 'EQ High Freq', min: 1000, max: 20000 },
        eqHighGain: { name: 'EQ High Gain', min: -12, max: 12 }
    };


    const bindInput = (id, paramKey) => {
        eqInputs[id].oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (currentEqOnChange) currentEqOnChange(paramKey, val);
            if (currentEqState) currentEqState[paramKey] = val;
            updateEqUI();
        };

        // Right-click: create EQ automation clip
        eqInputs[id].addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!activeEqMeterId) return; // No EQ modal open

            // Determine track from activeEqMeterId
            let sourceTrackIndex = 0;
            if (activeEqMeterId === 'master') {
                sourceTrackIndex = 0;
            } else {
                const parts = activeEqMeterId.split('_');
                sourceTrackIndex = parseInt(parts[0]) || 0;
            }

            const info = eqParamNames[id];
            const currentVal = parseFloat(eqInputs[id].value);
            const initPct = (currentVal - info.min) / (info.max - info.min);

            const metLabel = activeEqMeterId === 'master' ? 'Master' : (trackNames[sourceTrackIndex] || `Track ${sourceTrackIndex + 1}`);
            const clipId = `clip_auto_${clipCounter++}`;
            const newClip = {
                id: clipId,
                type: 'automation',
                source: 'mixer',
                paramId: `mixer_${activeEqMeterId}_${paramKey}`,
                paramName: `${metLabel} ${info.name}`,
                paramMin: info.min,
                paramMax: info.max,
                trackIndex: sourceTrackIndex,
                startStep: currentStep,
                length: 16,
                nodes: [
                    { timePct: 0, valuePct: initPct },
                    { timePct: 1, valuePct: initPct }
                ],
                color: '#38bdf8' // Sky blue for EQ automations
            };
            playlistClips.push(newClip);
            trackExpandedLanes[sourceTrackIndex] = true;
            rebuildTracksUI();
            checkAndSavePlaylistState();
        });
    };
    bindInput('eqLowFreq', 'eqLowFreq'); bindInput('eqLowGain', 'eqLow');
    bindInput('eqMidFreq', 'eqMidFreq'); bindInput('eqMidQ', 'eqMidQ'); bindInput('eqMidGain', 'eqMid');
    bindInput('eqHighFreq', 'eqHighFreq'); bindInput('eqHighGain', 'eqHigh');
}
setupEqListeners();

function openEqModal(meterId, label, fxState, onChangeFx, trackColor) {
    document.getElementById('eqModalTitle').innerText = `Track EQ: ${label}`;
    document.getElementById('eqModalTitle').style.borderBottom = `2px solid ${trackColor}`;

    activeEqMeterId = meterId;
    currentEqState = fxState;
    currentEqOnChange = onChangeFx;

    // Tells the iframes to start sending FFT data for the animation
    trackFrames.forEach(frame => {
        if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage({ type: 'toggle-spectrum', active: true }, '*');
        }
    });

    updateEqUI();
    eqModal.style.display = 'flex';

    // Starts the loop if it's not already active
    if (!eqAnimationId) {
        drawEqCurve();
    }
}

if (closeEqBtn) {
    closeEqBtn.onclick = () => {
        eqModal.style.display = 'none';
        currentEqOnChange = null;
        currentEqState = null;
        activeEqMeterId = null;
        currentSpectrumData = null;

        // Disables FFT calculation to free up CPU
        trackFrames.forEach(frame => {
            if (frame && frame.contentWindow) {
                frame.contentWindow.postMessage({ type: 'toggle-spectrum', active: false }, '*');
            }
        });
    };
}
window.addEventListener('mouseup', (e) => {
    // Only save state if something actually happened
    if (draggingClipId || resizingClipId || isPainting || isErasing) {
        checkAndSavePlaylistState();
    }

    if (draggingClipId) {
        const el = document.getElementById(draggingClipId);
        if (el) el.classList.remove('dragging');
    }

    // Rubber-band: if pending (no significant movement), treat as click = paint a clip
    if (rubberBandPending && !isRubberBanding && e.button === 0) {
        // Use the trackIndex captured at mousedown time
        const mockEvent = { clientX: rubberBandMouseStartX, clientY: rubberBandMouseStartY };
        addClip(mockEvent, rubberBandTrackIndex);
        checkAndSavePlaylistState();
    }

    // Rubber-band: finalize
    if (isRubberBanding) {
        if (rubberBandEl) {
            rubberBandEl.style.display = 'none';
        }
    }

    draggingClipId = null;
    multiDragInitialPositions = {};
    resizingClipId = null;
    isPainting = false;
    isErasing = false;
    isDraggingTimeline = false;
    isResizingLoopLeft = false;
    isResizingLoopRight = false;
    isRubberBanding = false;
    rubberBandPending = false;
});

// === AUDIO BUFFER SERIALIZATION HELPERS === (Legacy Support) 
window.audioBufferToBase64 = function (audioBuffer) {
    if (!audioBuffer) return null;
    const numOfChan = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numOfChan * bytesPerSample;
    const dataSize = audioBuffer.length * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    function writeString(offset, str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    let pos = 0;
    writeString(pos, 'RIFF'); pos += 4;
    view.setUint32(pos, totalSize - 8, true); pos += 4;
    writeString(pos, 'WAVE'); pos += 4;
    writeString(pos, 'fmt '); pos += 4;
    view.setUint32(pos, 16, true); pos += 4;             // fmt chunk size
    view.setUint16(pos, 1, true); pos += 2;              // PCM format
    view.setUint16(pos, numOfChan, true); pos += 2;
    view.setUint32(pos, sampleRate, true); pos += 4;
    view.setUint32(pos, sampleRate * blockAlign, true); pos += 4; // byte rate
    view.setUint16(pos, blockAlign, true); pos += 2;
    view.setUint16(pos, bitsPerSample, true); pos += 2;
    writeString(pos, 'data'); pos += 4;
    view.setUint32(pos, dataSize, true); pos += 4;

    const channels = [];
    for (let i = 0; i < numOfChan; i++) {
        channels.push(audioBuffer.getChannelData(i));
    }

    let offset = 0;
    while (pos < totalSize) {
        for (let i = 0; i < numOfChan; i++) {
            const sample = Math.max(-1, Math.min(1, channels[i][offset]));
            const val = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, val | 0, true);
            pos += 2;
        }
        offset++;
    }

    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunkSize = 0x8000;
    for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
};

window.base64ToAudioBuffer = async function (base64, audioCtx) {
    if (!base64) return null;
    const binaryStr = atob(base64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    return await audioCtx.decodeAudioData(bytes.buffer);
};

// === PROJECT SAVE / LOAD ===
async function saveProject() {
    // Collect all instrument states
    const activeInstrumentStates = [];
    trackFrames.forEach((frame, idx) => {
        if (frame && frame.contentWindow && typeof frame.contentWindow.getInstrumentState === 'function') {
            const state = frame.contentWindow.getInstrumentState();
            activeInstrumentStates.push(state);
        } else {
            activeInstrumentStates.push(null);
        }
    });

    // save only lightweight file metadata — no audio bytes embedded
    const audioFilesMetadata = {};
    for (let [id] of audioBufferDict.entries()) {  //takes only the first element of each key-value pair
        audioFilesMetadata[id] = { name: audioFileNames.get(id) || 'unknown.wav' };
    }

    // === TECHNICAL DEBT / MIDDLEWARE PATTERN ===
    // Convert Base64 instrument buffers to metadata references
    // The Iframes (Sampler, Drum Rack) still legacy-encode their audio to Base64 (wasting CPU momentarily).
    // Here, we intercept that heavy state, extract only the filename metadata,
    // and brutally delete the Base64 string ("delete state.buffer") before JSON serialization.
    // It's a calculated compromise: avoids rewriting all iframe logics while achieving lightweight 0KB save files!
    activeInstrumentStates.forEach((state, idx) => {
        if (!state) return;
        const instType = trackInstrumentIds[idx];
        if (instType === 'sampler') {
            if (state.sampleName && state.buffer) {
                const id = `inst_${idx}_sampler`;
                audioFilesMetadata[id] = { name: state.sampleName };
                delete state.buffer;
            }
        } else if (instType === 'channel_rack') {
            if (state.tracks) {
                state.tracks.forEach((track, tIdx) => {
                    if (track.name && track.buffer) {
                        const id = `inst_${idx}_chan_${tIdx}`;
                        audioFilesMetadata[id] = { name: track.name };
                    }
                    delete track.buffer;
                });
            }
        } else if (instType === 'drum_rack') {
            if (state.labels && state.padBuffers) {
                state.labels.forEach((label, pIdx) => {
                    if (label && state.padBuffers[pIdx]) {
                        const id = `inst_${idx}_drum_${pIdx}`;
                        const fileName = (state.fullNames && state.fullNames[pIdx]) ? state.fullNames[pIdx] : label;
                        audioFilesMetadata[id] = { name: fileName };
                    }
                });
            }
            if (state.padBuffers) delete state.padBuffers;
        }
    });

    const projectData = {
        version: "2.0",
        config: { totalSteps: config.totalSteps, tracks: config.tracks },
        bpm: bpm,
        currentQuantization: currentQuantization,
        trackInstrumentIds: trackInstrumentIds,
        trackTypes: trackTypes,
        trackNames: trackNames,
        trackColors: trackColors,
        mixerState: mixerState,
        masterMixerState: masterMixerState,
        instrumentStates: activeInstrumentStates,
        playlistClips: playlistClips.map(c => { const cl = { ...c }; delete cl.buffer; return cl; }),
        patterns: patterns,
        clipCounter: clipCounter,
        trackCounter: trackCounter,
        selectedPatternId: selectedPatternId,
        loopStartStep: loopStartStep,
        loopEndStep: loopEndStep,
        isLoopActive: isLoopActive,
        audioFilesMetadata: audioFilesMetadata  // <-- only names, no audio data
    };

    const blob = new Blob([JSON.stringify(projectData)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'project.mindaw';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// === INDEXEDDB HELPERS FOR DIRECTORY HANDLE CACHING ===
const _IDB_NAME = 'MiniDAW_Handles';
const _IDB_STORE = 'dirs';

function _openHandleDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(_IDB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore(_IDB_STORE);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = reject;
    });
}
async function _saveDirHandle(handle) {
    try { const db = await _openHandleDB(); db.transaction(_IDB_STORE, 'readwrite').objectStore(_IDB_STORE).put(handle, 'lastDir'); } catch (e) { }
}
async function _loadDirHandle() {
    try {
        const db = await _openHandleDB();
        return await new Promise(res => {
            const req = db.transaction(_IDB_STORE, 'readonly').objectStore(_IDB_STORE).get('lastDir');
            req.onsuccess = e => res(e.target.result || null);
            req.onerror = () => res(null);
        });
    } catch (e) { return null; }
}

/**
 * Recursively scans a FileSystemDirectoryHandle looking for files matching neededFiles.
 * - Skips files already loaded (audioBufferDict)
 * - Deduplicates by matchId (no double counting)
 * - Early exit when all needed files are found
 */
async function _scanDirForAudio(dirHandle, neededFiles, depth = 0, onProgress = null, _state = null) {
    // Initialize state on first call
    if (_state === null) {
        _state = {
            scanned: 0,
            foundIds: new Set(),                      // matchId already located
            remainingIds: new Set(                    // what we still need
                neededFiles
                    .filter(n => !audioBufferDict.has(n.id)) // skip already-loaded
                    .map(n => n.id)
            ),
            totalNeeded: 0,
            aborted: false
        };
        _state.totalNeeded = _state.remainingIds.size;
    }

    const found = [];
    if (depth > 4 || _state.aborted) return found;

    for await (const [name, entry] of dirHandle.entries()) {
        // Early exit: nothing left to find
        if (_state.remainingIds.size === 0) {
            _state.aborted = true;
            break;
        }

        if (entry.kind === 'file') {
            _state.scanned++;
            const match = neededFiles.find(n =>
                n.name.toLowerCase() === name.toLowerCase() &&
                _state.remainingIds.has(n.id)          // only if still needed
            );
            if (match) {
                const file = await entry.getFile();
                found.push({ file, handle: entry, matchId: match.id });
                _state.foundIds.add(match.id);
                _state.remainingIds.delete(match.id);  // don't recount
            }
            if (onProgress) {
                onProgress(_state.scanned, _state.foundIds.size, _state.totalNeeded);
            }
        } else if (entry.kind === 'directory') {
            const sub = await _scanDirForAudio(entry, neededFiles, depth + 1, onProgress, _state);
            found.push(...sub);
            if (_state.aborted) break;
        }
    }
    return found;
}

/**
 * Loads audio buffers from a list of { file, handle, matchId } objects.
 * onProgress(loaded, total) is called after each file is decoded.
 * Returns number of files successfully loaded.
 */
async function _loadFoundFiles(foundFiles, onProgress = null) {
    await Tone.start();
    Tone.setContext(masterAudioCtx);
    let loaded = 0;
    const total = foundFiles.length;
    for (const { file, handle, matchId } of foundFiles) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const nativeBuffer = await masterAudioCtx.decodeAudioData(arrayBuffer);
            audioBufferDict.set(matchId, nativeBuffer);
            audioFileNames.set(matchId, file.name);
            if (handle) audioFileHandles.set(matchId, handle);
            loaded++;
            if (onProgress) onProgress(loaded, total);
        } catch (err) {
            console.error(`Failed to load ${file.name}:`, err);
        }
    }
    return loaded;
}

/**
 * Main entry point: tries to auto-resolve audio files from the cached directory handle.
 * If auto-resolve fails or finds nothing, shows the modal asking for a folder.
 */
async function relocateAudioFiles(audioFilesMetadata) {
    // Build the "needed" list, skipping files already loaded
    const neededFiles = Object.entries(audioFilesMetadata)
        .filter(([id]) => !audioBufferDict.has(id))
        .map(([id, meta]) => ({ id, name: meta.name }));

    if (neededFiles.length === 0) return; // nothing to do

    // === 1. Auto-resolve from cached directory handle ===
    const cachedDir = await _loadDirHandle();
    if (cachedDir && window.FileSystemDirectoryHandle) {
        try {
            const perm = await cachedDir.queryPermission({ mode: 'read' });
            let granted = perm === 'granted';
            if (!granted) {
                const req = await cachedDir.requestPermission({ mode: 'read' });
                granted = req === 'granted';
            }
            if (granted) {
                const found = await _scanDirForAudio(cachedDir, neededFiles);
                if (found.length > 0) {
                    await _loadFoundFiles(found);
                    console.log(`[MiniDAW] Auto-loaded ${found.length}/${neededFiles.length} audio files from cached folder.`);
                }
            }
        } catch (e) { /* cached handle stale, fall through to modal */ }
    }

    // Recompute what's STILL missing after auto-resolve
    const stillMissing = neededFiles.filter(n => !audioBufferDict.has(n.id));
    if (stillMissing.length === 0) return; // everything resolved silently

    // === 2. Show modal only for what's actually missing ===
    return new Promise(resolve => {
        const modal = document.getElementById('missingAudioModal');
        const fileList = document.getElementById('missingAudioList');
        const selectBtn = document.getElementById('missingAudioSelectBtn');
        const skipBtn = document.getElementById('missingAudioSkipBtn');
        const statusEl = document.getElementById('missingAudioStatus');
        const progressBlock = document.getElementById('missingAudioProgress');
        const progressBar = document.getElementById('missingAudioProgressBar');
        const progressLabel = document.getElementById('missingAudioProgressLabel');
        const progressPct = document.getElementById('missingAudioProgressPct');

        // Helper: update the progress bar UI
        const setProgress = (pct, label, pctText) => {
            progressBlock.style.display = 'block';
            progressBar.style.width = Math.min(100, Math.round(pct)) + '%';
            progressLabel.textContent = label;
            progressPct.textContent = pctText;
        };
        const hideProgress = () => { progressBlock.style.display = 'none'; progressBar.style.width = '0%'; };

        // Show only the REAL missing files
        fileList.innerHTML = stillMissing.map(f => `<li>🎵 ${f.name}</li>`).join('');
        statusEl.textContent = '';
        hideProgress();

        // Adapt button label based on API availability
        if (window.showDirectoryPicker) {
            selectBtn.textContent = '📂 Seleziona Cartella';
        } else if (window.showOpenFilePicker) {
            selectBtn.textContent = '📂 Seleziona File Audio';
        } else {
            selectBtn.textContent = '📂 Seleziona File';
        }

        modal.style.display = 'flex';

        const cleanup = () => {
            modal.style.display = 'none';
            selectBtn.onclick = null;
            skipBtn.onclick = null;
            resolve();
        };

        skipBtn.onclick = cleanup;

        selectBtn.onclick = async () => {
            let foundFiles = [];

            // Disable buttons during operation
            selectBtn.disabled = true;
            skipBtn.disabled = true;
            selectBtn.style.opacity = '0.5';
            skipBtn.style.opacity = '0.5';

            if (window.showDirectoryPicker) {
                // === BEST: folder picker + auto recursive scan ===
                try {
                    statusEl.textContent = '📁 Seleziona la cartella contenente i tuoi campioni...';
                    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
                    await _saveDirHandle(dirHandle); // cache for future loads
                    statusEl.textContent = '';

                    // === Phase 1: SCAN ===
                    foundFiles = await _scanDirForAudio(dirHandle, stillMissing, 0, (scanned, foundCount, totalNeeded) => {
                        const pct = totalNeeded > 0 ? Math.min(100, (foundCount / totalNeeded) * 100) : 0;
                        setProgress(pct,
                            `🔍 Scansione... ${foundCount}/${totalNeeded} trovati`,
                            `${scanned} file esaminati`);
                    });
                } catch (err) {
                    if (err.name !== 'AbortError') console.error(err);
                    statusEl.textContent = '';
                    hideProgress();
                    selectBtn.disabled = false; skipBtn.disabled = false;
                    selectBtn.style.opacity = ''; skipBtn.style.opacity = '';
                    return;
                }
            } else if (window.showOpenFilePicker) {
                // === FALLBACK: multi-file picker ===
                try {
                    const handles = await window.showOpenFilePicker({
                        multiple: true,
                        types: [{ description: 'Audio', accept: { 'audio/*': ['.wav', '.mp3', '.ogg', '.flac', '.aiff', '.m4a'] } }]
                    });
                    for (const h of handles) {
                        const f = await h.getFile();
                        const match = stillMissing.find(n => n.name.toLowerCase() === f.name.toLowerCase());
                        if (match && !audioBufferDict.has(match.id)) {
                            foundFiles.push({ file: f, handle: h, matchId: match.id });
                        }
                    }
                } catch (err) {
                    if (err.name !== 'AbortError') console.error(err);
                    selectBtn.disabled = false; skipBtn.disabled = false;
                    selectBtn.style.opacity = ''; skipBtn.style.opacity = '';
                    return;
                }
            } else {
                // === FINAL FALLBACK: classic <input type="file"> ===
                await new Promise(res => {
                    const inp = document.createElement('input');
                    inp.type = 'file'; inp.multiple = true; inp.accept = 'audio/*';
                    inp.onchange = () => {
                        Array.from(inp.files).forEach(f => {
                            const match = stillMissing.find(n => n.name.toLowerCase() === f.name.toLowerCase());
                            if (match && !audioBufferDict.has(match.id)) {
                                foundFiles.push({ file: f, handle: null, matchId: match.id });
                            }
                        });
                        res();
                    };
                    inp.oncancel = () => res();
                    inp.click();
                });
            }

            if (!foundFiles.length) {
                statusEl.textContent = '⚠️ Nessun file trovato. Controlla che i nomi corrispondano.';
                hideProgress();
                selectBtn.disabled = false; skipBtn.disabled = false;
                selectBtn.style.opacity = ''; skipBtn.style.opacity = '';
                return;
            }

            // === Phase 2: DECODE ===
            statusEl.textContent = '';
            progressBar.style.width = '0%';

            const loaded = await _loadFoundFiles(foundFiles, (done, tot) => {
                const pct = (done / tot) * 100;
                setProgress(pct,
                    `📦 Caricamento... ${done}/${tot}`,
                    `${Math.round(pct)}%`);
            });

            // === Phase 3: REPORT ===
            const finalMissing = stillMissing.filter(n => !audioBufferDict.has(n.id));
            if (finalMissing.length === 0) {
                setProgress(100, '✅ Caricamento completato!', `${loaded}/${stillMissing.length}`);
                statusEl.textContent = '';
                setTimeout(cleanup, 1200);
            } else {
                setProgress((loaded / stillMissing.length) * 100,
                    `⚠️ ${finalMissing.length} file non trovati`,
                    `${loaded}/${stillMissing.length}`);
                statusEl.textContent = 'I file mancanti potrebbero avere nomi diversi.';
                // Refresh list to show only those still missing
                fileList.innerHTML = finalMissing.map(f => `<li>📄 ${f.name}</li>`).join('');
            }

            selectBtn.disabled = false; skipBtn.disabled = false;
            selectBtn.style.opacity = ''; skipBtn.style.opacity = '';
        };
    });
}

function loadProject(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (data.config && data.config.tracks !== undefined) {
                config.tracks = data.config.tracks;
                config.totalSteps = data.config.totalSteps || 256;
            }
            bpm = data.bpm || 125;
            elements.bpmInput.value = bpm;
            currentQuantization = data.currentQuantization || 1;
            elements.gridSelect.value = currentQuantization.toString();

            trackInstrumentIds = data.trackInstrumentIds || [];
            trackTypes = data.trackTypes || [];
            trackNames = data.trackNames || [];
            trackColors = data.trackColors || [];
            mixerState = data.mixerState || [];
            masterMixerState = data.masterMixerState || { volume: 1.0, reverb: 0, delay: 0, eqLow: 0, eqMid: 0, eqHigh: 0, limiter: false };
            instrumentStates = data.instrumentStates || [];
            playlistClips = data.playlistClips || [];

            const patternsObj = data.patterns || {};
            for (let member in patterns) delete patterns[member];
            Object.assign(patterns, patternsObj);

            clipCounter = data.clipCounter || playlistClips.length * 2;
            trackCounter = data.trackCounter || config.tracks + 1;
            selectedPatternId = data.selectedPatternId || 1;
            loopStartStep = data.loopStartStep || 0;
            loopEndStep = data.loopEndStep || 16;
            isLoopActive = data.isLoopActive || false;
            elements.loopBtn.classList.toggle('active', isLoopActive);

            initPlaylist();

            // Clear audio caches
            audioBufferDict.clear();
            audioFileHandles.clear();
            audioFileNames.clear();

            const hasAudioFiles = Object.keys(data.audioFilesMetadata || {}).length > 0;

            if (data.version === '2.0' || data.audioFilesMetadata) {
                // === v2.0 FORMAT: lightweight metadata — prompt user to re-locate files ===
                if (data.audioFilesMetadata && hasAudioFiles) {
                    await relocateAudioFiles(data.audioFilesMetadata);
                }
            } else if (data.audioBuffers) {
                // === LEGACY v1.0 FORMAT: base64 embedded audio ===
                await Tone.start();
                Tone.setContext(masterAudioCtx);
                for (let id in data.audioBuffers) {
                    try {
                        const nativeBuf = await window.base64ToAudioBuffer(data.audioBuffers[id], masterAudioCtx);
                        if (nativeBuf) audioBufferDict.set(id, new Tone.ToneAudioBuffer(nativeBuf));
                    } catch (err) { console.error('Failed to decode audio buffer', id, err); }
                }
            }

            // Inject resolved buffers into instrument states
            instrumentStates.forEach((state, idx) => {
                if (!state) return;
                const instType = trackInstrumentIds[idx];

                const getNative = (toneBuf) => {
                    if (!toneBuf) return null;
                    return toneBuf.get ? toneBuf.get() : (toneBuf._buffer || toneBuf);
                };

                if (instType === 'sampler') {
                    const id = `inst_${idx}_sampler`;
                    if (audioBufferDict.has(id)) state.buffer = getNative(audioBufferDict.get(id));
                } else if (instType === 'channel_rack') {
                    if (state.tracks) {
                        state.tracks.forEach((track, tIdx) => {
                            const id = `inst_${idx}_chan_${tIdx}`;
                            if (audioBufferDict.has(id)) track.buffer = getNative(audioBufferDict.get(id));
                        });
                    }
                } else if (instType === 'drum_rack') {
                    if (state.labels && !state.padBuffers) state.padBuffers = [];
                    if (state.labels) {
                        state.labels.forEach((label, pIdx) => {
                            const id = `inst_${idx}_drum_${pIdx}`;
                            if (audioBufferDict.has(id)) state.padBuffers[pIdx] = getNative(audioBufferDict.get(id));
                        });
                    }
                }
            });

            // Re-send states to already-loaded iframes (they may have loaded
            // before relocateAudioFiles finished, so the first setInstrumentState
            // call would have been missing the buffers)
            trackFrames.forEach((frame, idx) => {
                if (frame && frame.dataset.loaded === "true" &&
                    instrumentStates[idx] &&
                    typeof frame.contentWindow.setInstrumentState === 'function') {
                    console.log(`[MiniDAW] Re-injecting state with buffers into track ${idx}`);
                    frame.contentWindow.setInstrumentState(instrumentStates[idx]);
                }
            });

            // Re-attach live buffer refs to clips
            playlistClips.forEach(c => {
                if (c.type === 'audio' && c.audioBufferId && audioBufferDict.has(c.audioBufferId)) {
                    c.buffer = audioBufferDict.get(c.audioBufferId);
                }
            });

            playlistClips.forEach(c => renderClip(c));
            if (elements.mixerModal.style.display === 'flex') renderMixer();

        } catch (err) {
            alert('Errore nel caricamento del progetto: file non valido.');
            console.error(err);
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

if (elements.saveProjectBtn) {
    elements.saveProjectBtn.addEventListener('click', () => saveProject());
}

if (elements.loadProjectBtn && elements.loadProjectInput) {
    elements.loadProjectBtn.addEventListener('click', () => {
        elements.loadProjectInput.click();
    });
    elements.loadProjectInput.addEventListener('change', loadProject);
}


initPlaylist();

// === AUTOMATION ENGINE ===
let automationReqId = null;

function interpolateNodes(nodes, pct) {
    if (!nodes || nodes.length === 0) return 0.5;
    if (nodes.length === 1) return nodes[0].valuePct;

    // find segment
    for (let i = 0; i < nodes.length - 1; i++) {
        const n1 = nodes[i];
        const n2 = nodes[i + 1];
        if (pct >= n1.timePct && pct <= n2.timePct) {
            const range = n2.timePct - n1.timePct;
            if (range === 0) return n1.valuePct;
            const factor = (pct - n1.timePct) / range;
            return n1.valuePct + (n2.valuePct - n1.valuePct) * factor;
        }
    }
    if (pct < nodes[0].timePct) return nodes[0].valuePct;
    if (pct > nodes[nodes.length - 1].timePct) return nodes[nodes.length - 1].valuePct;
    return 0.5;
}

function processAutomations() {
    if (!isPlaying) {
        automationReqId = requestAnimationFrame(processAutomations);
        return;
    }

    // Calcoliamo la posizione ESATTA continua della playhead rispetto a currentStep
    // Poiché tick() avanza a scatti, usiamo il tempo di WebAudio per l'interpolazione liscia
    const stepDurationSecs = (60 / bpm) / 4;
    const elapsedSinceTick = audioCtx.currentTime - lastTickWebAudioTime;
    let continuousStep = lastTickStep + (elapsedSinceTick / stepDurationSecs);

    // Clamp
    if (continuousStep < 0) continuousStep = 0;
    playlistClips.forEach(clip => {
        if (clip.type === 'automation' && continuousStep >= clip.startStep && continuousStep <= clip.startStep + clip.length) {
            const localStep = continuousStep - clip.startStep;
            const pct = localStep / clip.length;
            const valuePct = interpolateNodes(clip.nodes, pct);

            const frame = trackFrames[clip.trackIndex];
            if (frame && frame.contentWindow) {
                frame.contentWindow.postMessage({
                    type: 'automation-update',
                    paramId: clip.paramId,
                    valuePct: valuePct
                }, '*');
            }
        }
    });

    automationReqId = requestAnimationFrame(processAutomations);
}
automationReqId = requestAnimationFrame(processAutomations);
window.isRendering = false;
let renderScriptNode = null;
let recordedLeft = [];
let recordedRight = [];
let renderMaxSteps = 0;
let renderStartStepBackup = 0;

if (elements.renderBtn) {
    elements.renderBtn.addEventListener('click', () => {
        elements.renderModal.style.display = 'flex';
        elements.startRenderBtn.style.display = 'block';
        elements.stopRenderBtn.style.display = 'none';
        elements.renderProgressContainer.style.display = 'none';
    });
}

if (elements.closeRenderModal) {
    elements.closeRenderModal.addEventListener('click', () => {
        if (!window.isRendering) elements.renderModal.style.display = 'none';
    });
}

function startAudioRender() {
    // 1. Calculate length
    let maxStep = 0;
    playlistClips.forEach(c => {
        const end = c.startStep + c.length;
        if (end > maxStep) maxStep = end;
    });
    // Add tail for fx
    const tailSeconds = 3.0; // 3 seconds reverb/delay tail
    const stepDurationSecs = 60 / bpm / 4;
    const tailSteps = Math.ceil(tailSeconds / stepDurationSecs);
    renderMaxSteps = maxStep + tailSteps;

    // Reset arrays
    recordedLeft = [];
    recordedRight = [];
    window.isRendering = true;

    // Build the script processor and connect it
    if (!renderScriptNode) {
        renderScriptNode = masterAudioCtx.createScriptProcessor(4096, 2, 2);
        renderScriptNode.onaudioprocess = (e) => {
            if (!window.isRendering) return;
            const inputL = e.inputBuffer.getChannelData(0);
            const inputR = e.inputBuffer.getChannelData(1);
            recordedLeft.push(new Float32Array(inputL));
            recordedRight.push(new Float32Array(inputR));
        };
        window.masterRecordingBus.connect(renderScriptNode);
        renderScriptNode.connect(masterAudioCtx.destination);
    }

    // UI Updates
    elements.startRenderBtn.style.display = 'none';
    elements.stopRenderBtn.style.display = 'block';
    elements.renderProgressContainer.style.display = 'block';
    elements.renderProgressBar.style.width = '0%';
    elements.renderTimerText.innerText = "00:00";

    // Playback starting
    renderStartStepBackup = currentStep;
    currentStep = 0;
    elements.playhead.style.left = '0px';

    // Disable user modifications and loop
    isLoopActiveBackup = isLoopActive;
    isLoopActive = false;

    // Stop all audio before starting
    if (isPlaying) togglePause();
    updateTrackMutes();

    // Give audio nodes some ms to relax
    setTimeout(() => {
        play();
    }, 100);
}

function stopAudioRenderAndExport() {
    window.isRendering = false;
    if (isPlaying) {
        togglePause();
    }

    // Restore loop
    if (typeof isLoopActiveBackup !== 'undefined') {
        isLoopActive = isLoopActiveBackup;
    }

    elements.renderModal.style.display = 'none';

    // Convert arrays to WAV
    exportToWAV(recordedLeft, recordedRight, masterAudioCtx.sampleRate);
}

if (elements.startRenderBtn) {
    elements.startRenderBtn.addEventListener('click', startAudioRender);
}
if (elements.stopRenderBtn) {
    elements.stopRenderBtn.addEventListener('click', stopAudioRenderAndExport);
}

function exportToWAV(leftChunks, rightChunks, sampleRate) {
    let totalLength = 0;
    for (let i = 0; i < leftChunks.length; i++) {
        totalLength += leftChunks[i].length;
    }

    // Create interleaved buffer
    const interleaved = new Float32Array(totalLength * 2);
    let offset = 0;
    for (let i = 0; i < leftChunks.length; i++) {  //chunks
        const left = leftChunks[i];
        const right = rightChunks[i];
        for (let j = 0; j < left.length; j++) {   //samples of the chunks
            interleaved[offset++] = left[j];
            interleaved[offset++] = right[j];
        }
    }

    // Convert Float32 to Int16
    const pcmData = new Int16Array(interleaved.length);
    for (let i = 0; i < interleaved.length; i++) {
        let s = Math.max(-1, Math.min(1, interleaved[i]));
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Build WAV header
    const wavBuffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(wavBuffer);

    const writeString = (view, offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 2, true); // stereo channels
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true); // byte rate (sampleRate * 2 * 2)
    view.setUint16(32, 4, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(view, 36, 'data');
    view.setUint32(40, pcmData.length * 2, true);

    // Write PCM data
    const len = pcmData.length;
    let offsetData = 44;
    for (let i = 0; i < len; i++) {
        view.setInt16(offsetData, pcmData[i], true);
        offsetData += 2;
    }

    const blob = new Blob([view], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `MiniDAW_Render_${Date.now()}.wav`;
    a.click();
    URL.revokeObjectURL(url);
}

// === AUTOMATION ENGINE ===

// Lookup table for mixer automation callbacks is declared at top of file

function applyMixerAutomation(paramId, valuePct) {
    // paramId format: "mixer_{meterId}_{fxName}" e.g. "mixer_0_reverb", "mixer_master_eqLow"
    const parts = paramId.split('_');
    // parts[0] = "mixer", rest = meterId parts + fxName
    // meterId can be "master", "0", "1", "0_2" (channel rack sub)
    // fxName is always the last part
    if (parts.length < 3) return;

    const fxName = parts[parts.length - 1]; // e.g. "reverb", "delay", "eqLow", "eqLowFreq"
    const meterId = parts.slice(1, parts.length - 1).join('_'); // e.g. "0", "master", "0_2"

    // Find the DOM slider if it exists and update it visually
    const slider = document.getElementById(paramId);
    if (slider) {
        const min = parseFloat(slider.min) || 0;
        const max = parseFloat(slider.max) || 1;
        const absoluteVal = min + (max - min) * valuePct;
        slider.value = absoluteVal;
        // Trigger the oninput to propagate the change
        slider.dispatchEvent(new Event('input'));
        return;
    }

    // If no DOM slider (e.g. EQ params), we need to use callbacks
    if (mixerAutomationCallbacks[paramId]) {
        const cb = mixerAutomationCallbacks[paramId];
        const absoluteVal = cb.min + (cb.max - cb.min) * valuePct;
        cb.callback(fxName, absoluteVal);

        // If the EQ modal is open for this track, update the UI
        if (activeEqMeterId === meterId && currentEqState) {
            currentEqState[fxName] = absoluteVal;
            updateEqUI();
        }
    }
}

function processAutomations() {   //processa le automazioni 
    if (isPlaying) {
        const stepDurationSecs = (60 / bpm) / 4;
        let continuousStep = currentStep;

        if (typeof lastTickWebAudioTime !== 'undefined' && typeof lastTickStep !== 'undefined') {
            const elapsedSinceTick = audioCtx.currentTime - lastTickWebAudioTime;
            continuousStep = lastTickStep + (elapsedSinceTick / stepDurationSecs);
        }

        if (continuousStep < 0) continuousStep = 0;

        playlistClips.forEach(clip => {
            if (clip.type === 'automation' && continuousStep >= clip.startStep && continuousStep <= clip.startStep + clip.length) {
                const localStep = continuousStep - clip.startStep;
                const timePct = localStep / clip.length;

                // Interpolate
                let lowerNode = null;
                let upperNode = null;
                for (let i = 0; i < clip.nodes.length - 1; i++) {
                    if (timePct >= clip.nodes[i].timePct && timePct <= clip.nodes[i + 1].timePct) {
                        lowerNode = clip.nodes[i];
                        upperNode = clip.nodes[i + 1];
                        break;
                    }
                }

                if (lowerNode && upperNode) {
                    const range = upperNode.timePct - lowerNode.timePct;
                    const pctInRange = range === 0 ? 0 : (timePct - lowerNode.timePct) / range;
                    const valuePct = lowerNode.valuePct + (upperNode.valuePct - lowerNode.valuePct) * pctInRange;

                    if (clip.source === 'mixer') {
                        // Mixer automation: update directly
                        applyMixerAutomation(clip.paramId, valuePct);
                    } else {
                        // Instrument automation: send to iframe
                        const frame = trackFrames[clip.trackIndex];
                        if (frame && frame.dataset.loaded === "true") {
                            frame.contentWindow.postMessage({
                                type: 'automation-update',
                                paramId: clip.paramId,
                                valuePct: valuePct
                            }, '*');
                        }
                    }
                }
            }
        });
    }

    requestAnimationFrame(processAutomations); //recursion every 60 times in a second (60 hz ~ 16ms)
}
requestAnimationFrame(processAutomations);

// === AUDIO TRACK LOGIC ===

const activeAudioPlayers = new Map();

async function handleAudioDrop(e, trackIndex) {
    const file = e.dataTransfer.files[0];
    if (!file || (!file.type.startsWith('audio/') && !file.name.match(/\.(wav|mp3|ogg|flac|aiff|m4a)$/i))) return;

    const rect = elements.tracksLayer.getBoundingClientRect();
    const x = e.clientX - rect.left + elements.gridScrollArea.scrollLeft;
    const rawStep = x / config.stepWidth;
    let startStep = Math.floor(rawStep / currentQuantization) * currentQuantization;

    // Try to grab a persistent FileSystemFileHandle from the drag event
    let fileHandle = null;
    if (e.dataTransfer.items && e.dataTransfer.items[0] &&
        typeof e.dataTransfer.items[0].getAsFileSystemHandle === 'function') {
        try { fileHandle = await e.dataTransfer.items[0].getAsFileSystemHandle(); }
        catch (err) { console.warn('getAsFileSystemHandle not supported:', err); }
    }

    const fileUrl = URL.createObjectURL(file);
    await Tone.start();
    Tone.setContext(masterAudioCtx);

    new Tone.ToneAudioBuffer(fileUrl, (buffer) => {
        const durationSec = buffer.duration;
        let guessedBpm = Math.round(16 * 60 / durationSec);  //guessing bpm of the sample!
        if (guessedBpm < 60 || guessedBpm > 200) guessedBpm = bpm;

        const ratio = bpm / guessedBpm;
        const expectedDurationMs = (durationSec / ratio) * 1000;
        const stepDurationMs = (60000 / bpm) / 4;
        let lengthSteps = Math.round(expectedDurationMs / stepDurationMs);
        if (lengthSteps <= 0) lengthSteps = 16;

        const clipId = `clip_audio_${clipCounter++}`;
        const bufferId = `buffer_${Date.now()}_${Math.random()}`;

        audioBufferDict.set(bufferId, buffer);
        audioFileNames.set(bufferId, file.name);          // store filename for save
        if (fileHandle) audioFileHandles.set(bufferId, fileHandle); // store handle if available

        const clip = {
            id: clipId,
            type: 'audio',
            audioBufferId: bufferId,
            trackIndex,
            startStep,
            length: lengthSteps,
            warpLength: lengthSteps,
            color: trackColors[trackIndex],
            buffer: buffer,
            originalBpm: guessedBpm,
            name: file.name
        };
        playlistClips.push(clip);
        renderClip(clip);
        checkAndSavePlaylistState();
    });
}

function drawAudioWaveform(clip, canvas) {
    if (!clip.buffer) return;
    const ctx = canvas.getContext('2d');
    const warpLen = clip.warpLength || clip.length;
    const w = canvas.width = warpLen * config.stepWidth;
    const h = canvas.height = config.trackHeight * 0.6;

    canvas.style.width = w + 'px';
    canvas.style.height = '60%';

    const data = clip.buffer.getChannelData(0);
    const step = Math.ceil(data.length / w);
    const amp = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Draw waveform with per-pixel fade applied
    const fadeInPx = clip.fadeIn ? (clip.fadeIn / clip.length) * w : 0;
    const fadeOutPx = clip.fadeOut ? (clip.fadeOut / clip.length) * w : 0;
    const fadeOutStart = w - fadeOutPx;

    for (let i = 0; i < w; i++) {
        let min = 1.0, max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = data[(i * step) + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }

        // Calculate fade multiplier for this pixel
        let fadeMul = 1;
        if (fadeInPx > 0 && i < fadeInPx) fadeMul = i / fadeInPx;
        if (fadeOutPx > 0 && i > fadeOutStart) fadeMul = Math.min(fadeMul, (w - i) / fadeOutPx);

        ctx.fillStyle = `rgba(255, 255, 255, ${fadeMul})`;
        ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
    }

    // Draw fade lines
    ctx.strokeStyle = 'rgba(255, 255, 200, 0.8)';
    ctx.lineWidth = 1.5;
    if (fadeInPx > 0) {
        ctx.beginPath();
        ctx.moveTo(0, h);
        ctx.lineTo(fadeInPx, 0);
        ctx.stroke();
    }
    if (fadeOutPx > 0) {
        ctx.beginPath();
        ctx.moveTo(fadeOutStart, 0);
        ctx.lineTo(w, h);
        ctx.stroke();
    }
}

function playAudioClip(clip, offsetSteps) {
    if (!clip.buffer) return;
    if (soloedTracks.size > 0 && !soloedTracks.has(clip.trackIndex)) return;

    // Cleanup existing instance to prevent overlapping and memory leaks
    if (activeAudioPlayers.has(clip.id)) {
        const old = activeAudioPlayers.get(clip.id);
        if (old.player) { old.player.stop(); old.player.dispose(); }
        if (old.fadeGain) { old.fadeGain.dispose(); }
        activeAudioPlayers.delete(clip.id);
    }

    const durationSec = clip.buffer.duration;
    const stepDurationSec = (60000 / bpm) / 4 / 1000;
    const targetWarpDurationSec = (clip.warpLength || clip.length) * stepDurationSec;
    const targetPlayDurationSec = clip.length * stepDurationSec;
    const pbRate = durationSec / targetWarpDurationSec;

    const player = new Tone.GrainPlayer({
        url: clip.buffer,
        playbackRate: pbRate,   //time warping
        grainSize: 0.1,
        overlap: 0.05
    });

    // Apply pitch shift (semitones → cents)
    const pitchCents = (clip.pitchSemitones || 0) * 100;
    if (pitchCents !== 0) {
        player.detune = pitchCents;
    }

    // Create a gain node for fade in/out
    const fadeGain = new Tone.Gain(1);
    player.connect(fadeGain);

    // Per-clip volume gain
    const clipVolumeGain = new Tone.Gain(clip.clipVolume !== undefined ? clip.clipVolume : 1.0);
    fadeGain.connect(clipVolumeGain);

    const frame = trackFrames[clip.trackIndex];
    if (frame && frame.contentWindow && frame.contentWindow.mixerInput) {
        Tone.connect(clipVolumeGain, frame.contentWindow.mixerInput);
    } else {
        clipVolumeGain.connect(window.masterRecordingBus);
    }

    const now = Tone.now();
    const offsetTimeSec = (offsetSteps * stepDurationSec) * pbRate;
    const playDurationSec = targetPlayDurationSec - (offsetSteps * stepDurationSec);
    const elapsedClipSec = offsetSteps * stepDurationSec;

    // Fade In
    const fadeInSec = (clip.fadeIn || 0) * stepDurationSec;
    if (fadeInSec > 0) {
        const fadeInRemaining = fadeInSec - elapsedClipSec;
        if (fadeInRemaining > 0) {
            // We're still in the fade-in zone
            const progress = elapsedClipSec / fadeInSec;
            fadeGain.gain.setValueAtTime(progress, now);
            fadeGain.gain.linearRampToValueAtTime(1, now + fadeInRemaining);
        }
    }

    // Fade Out
    const fadeOutSec = (clip.fadeOut || 0) * stepDurationSec;
    if (fadeOutSec > 0 && playDurationSec > 0) {
        const fadeOutStartSec = playDurationSec - fadeOutSec;
        if (fadeOutStartSec > 0) {
            fadeGain.gain.setValueAtTime(1, now + fadeOutStartSec);
            fadeGain.gain.linearRampToValueAtTime(0, now + playDurationSec);
        } else {
            // Already in fade-out zone
            const progress = (-fadeOutStartSec) / fadeOutSec;
            const currentVol = 1 - progress;
            fadeGain.gain.setValueAtTime(Math.max(0, currentVol), now);
            fadeGain.gain.linearRampToValueAtTime(0, now + playDurationSec);
        }
    }

    player.start(now, offsetTimeSec);
    activeAudioPlayers.set(clip.id, { player, fadeGain, clipVolumeGain });

    setTimeout(() => {
        const stored = activeAudioPlayers.get(clip.id);
        if (stored && stored.player === player) {
            player.stop();
            player.dispose();
            fadeGain.dispose();
            clipVolumeGain.dispose();
            activeAudioPlayers.delete(clip.id);
        }
    }, playDurationSec * 1000 + 100);
}

function stopAllAudioClips() {
    activeAudioPlayers.forEach(entry => {
        if (entry.player) { entry.player.stop(); entry.player.dispose(); }
        if (entry.fadeGain) { entry.fadeGain.dispose(); }
        if (entry.clipVolumeGain) { entry.clipVolumeGain.dispose(); }
    });
    activeAudioPlayers.clear();
}

// === PERFORMANCE MONITOR ===
let perfFrames = 0;
let perfLastFpsUpdate = performance.now();
let perfLastFrameTime = performance.now();
let perfMaxFrameTime = 0;       // Worst frame in current window (ms)
let perfTickJitterMax = 0;      // Worst tick deviation in current window (ms)
let perfTickJitterAvg = 0;      // Smoothed average jitter
let perfSmoothedLoad = 0;       // Smoothed total load %

// Hook into transport tick: called from inside tick()
window.reportTickJitter = function (expectedMs, actualMs) {
    const jitter = Math.abs(actualMs - expectedMs);
    perfTickJitterMax = Math.max(perfTickJitterMax, jitter);
    perfTickJitterAvg = perfTickJitterAvg * 0.8 + jitter * 0.2;
};

function updatePerformanceMonitor() {
    const now = performance.now();
    const frameTime = now - perfLastFrameTime;
    perfLastFrameTime = now;

    // Track worst frame time in this window
    if (frameTime > perfMaxFrameTime) perfMaxFrameTime = frameTime;

    perfFrames++;

    if (now - perfLastFpsUpdate >= 500) {
        const elapsed = now - perfLastFpsUpdate;
        const fps = Math.round((perfFrames * 1000) / elapsed);

        const fpsEl = document.getElementById('perfFps');
        const cpuEl = document.getElementById('perfCpu');
        const barEl = document.getElementById('perfBar');

        // === LOAD CALCULATION ===
        // Combine 3 signals into a single 0-100% "load" indicator:

        // 1. Frame budget pressure (target 16.67ms = 60fps)
        //    >16.67ms means we're dropping frames → main thread stressed
        const frameLoad = Math.min(100, (perfMaxFrameTime / 16.67) * 50);
        // (16.67ms = 50% load, 33ms = 100% load)

        // 2. Tick jitter (target <2ms for tight timing)
        //    >10ms jitter = audio timing audibly off
        const jitterLoad = Math.min(100, (perfTickJitterMax / 10) * 100);

        // 3. FPS drop (target 60fps)
        const fpsLoad = Math.max(0, Math.min(100, ((60 - fps) / 60) * 100));

        // Take worst of the three (most pessimistic = most useful warning)
        const instantLoad = Math.max(frameLoad, jitterLoad, fpsLoad);

        // Smooth to avoid flickering numbers
        perfSmoothedLoad = perfSmoothedLoad * 0.6 + instantLoad * 0.4;
        const displayLoad = Math.round(perfSmoothedLoad);

        // === LATENCY (hardware buffer, mostly constant) ===
        let latencyMs = 0;
        if (masterAudioCtx) {
            const base = masterAudioCtx.baseLatency || 0;
            const output = masterAudioCtx.outputLatency || 0;
            latencyMs = Math.round((base + output) * 1000);
        }

        // === UPDATE UI ===
        if (fpsEl && cpuEl && barEl) {
            fpsEl.textContent = fps;
            cpuEl.textContent = `${displayLoad}% · ${latencyMs}ms`;

            barEl.style.width = `${displayLoad}%`;

            let color;
            if (displayLoad < 40) color = '#00ff88'; // green: tutto ok
            else if (displayLoad < 70) color = '#fbbf24'; // amber: attenzione
            else color = '#ef4444'; // red:   overload

            barEl.style.background = color;
            fpsEl.style.color = fps >= 50 ? '#00ff88' : (fps >= 30 ? '#fbbf24' : '#ef4444');
            cpuEl.style.color = color;

            // Tooltip diagnostico 
            const monitor = document.getElementById('perfMonitor');
            if (monitor) {
                monitor.title =
                    `Load: ${displayLoad}%\n` +
                    `FPS: ${fps}\n` +
                    `Frame time max: ${perfMaxFrameTime.toFixed(1)}ms\n` +
                    `Tick jitter max: ${perfTickJitterMax.toFixed(1)}ms\n` +
                    `Tick jitter avg: ${perfTickJitterAvg.toFixed(1)}ms\n` +
                    `HW Latency: ${latencyMs}ms\n` +
                    `Clips: ${playlistClips.length} · Tracks: ${config.tracks}`;
            }
        }

        // Reset window
        perfFrames = 0;
        perfMaxFrameTime = 0;
        perfTickJitterMax = 0;
        perfLastFpsUpdate = now;
    }

    requestAnimationFrame(updatePerformanceMonitor);  //recursion at 60hz(60 times in a second)
}

requestAnimationFrame(updatePerformanceMonitor);