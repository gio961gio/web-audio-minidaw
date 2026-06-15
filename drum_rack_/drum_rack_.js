//#region ---//! MODEL --- 
// Manages the data and application state.
let totalButtons = 16;
let buttonsPerGroup = 4;
// Internal representation of pads state
let padsState = [];
// Array to store the audio files (AudioBuffers) loaded in the pads
let padBuffers = [];
// Array to store the full names of the files loaded in the pads
let padFileNames = [];
// Array to store the volume of each pad (0.0 to 1.0)
let padGains = [];
// Array to store the active audio sources for each pad (to avoid overlaps)
let activeSources = [];
// Array to store the reverb levels (0.0 to 1.0) for each pad
let padReverbLevels = [];
// Array to store the delay levels (0.0 to 1.0) for each pad
let padDelayLevels = [];
// Array to store the pan (-1.0 left, 0 center, 1.0 right) for each pad
let padPanLevels = [];
// Current step of the sequence
let currentStep = 0;
let sequenceSpeed = 125; // Default for 120 BPM
let intervalId = null;   // Timer reference
let isPaused = false;    // Tracks if the sequencer is paused
let swingAmount = 0;     // Swing percentage (0 - 100)
let swingGrid = 16;      // Swing grid setting: 16 (1/16) or 8 (1/8)

// === MINIDAW INTEGRATION ===
let currentPatternId = null;

function notifyMinidaw(index, state) {
    if (currentPatternId && window.parent) {
        window.parent.postMessage({
            type: 'update-drum-pad',
            patternId: currentPatternId,
            padIndex: index,
            state: state
        }, '*');
    }
}

function notifySwingMinidaw() {
    if (currentPatternId && window.parent) {
        window.parent.postMessage({
            type: 'update-drum-swing',
            patternId: currentPatternId,
            swingAmount: swingAmount,
            swingGrid: swingGrid
        }, '*');
    }
}

window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data) return;

    if (data.type === 'load-pattern') {
        currentPatternId = data.patternId;
        const pattern = data.pattern;

        swingAmount = pattern.swingAmount || 0;
        swingGrid = pattern.swingGrid || 16;
        swingSlider.value = swingAmount;
        swingInput.value = swingAmount;
        swingGridSelect.value = swingGrid;

        if (!pattern.padsState) {
            pattern.padsState = Array(totalButtons).fill(false);
        }

        for (let i = 0; i < totalButtons; i++) {
            padsState[i] = pattern.padsState[i] || false;
            if (padsElements[i]) {
                updatePadVisual(padsElements[i], padsState[i]);
            }
        }
    } else if (data.type === 'play-pad') {
        const step = data.step;
        if (padBuffers[step]) {
            playSound(step, padBuffers[step], padGains[step], padPanLevels[step], padReverbLevels[step], padDelayLevels[step]);
        }
    } else if (data.type === 'stop-all') {
        activeSources.forEach((source, index) => {
            if (source) {
                try { source.stop(); } catch (err) { }
                activeSources[index] = null;
            }
        });
    } else if (data.type === 'set-bpm') {
        bpmInput.value = data.bpm;
    }
});

// Audio Engine initialization
const audioCtx = (window.parent && window.parent.masterAudioCtx) ? window.parent.masterAudioCtx : new (window.AudioContext || window.webkitAudioContext)();
const masterGainNode = window.createMixerFX ? window.createMixerFX(audioCtx) : audioCtx.createGain();
if (!window.createMixerFX) masterGainNode.connect(audioCtx.destination);

// Reverb Setup (LAZY — created on first use)
let reverbNode = null;
let reverbConnected = false;

function getReverbNode() {
    if (!reverbNode) {
        reverbNode = audioCtx.createConvolver();
        const revLen = audioCtx.sampleRate * 1.5;
        const revBuf = audioCtx.createBuffer(2, revLen, audioCtx.sampleRate);
        for (let c = 0; c < 2; c++) {
            const d = revBuf.getChannelData(c);
            for (let i = 0; i < revLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / revLen, 3);
        }
        reverbNode.buffer = revBuf;
        reverbNode.connect(masterGainNode);
        reverbConnected = true;
    }
    return reverbNode;
}

// Delay Setup (LAZY — created on first use)
let delayNode = null;
let delayFeedback = null;
let delayConnected = false;

function getDelayNode() {
    if (!delayNode) {
        delayNode = audioCtx.createDelay(1.0);
        delayNode.delayTime.value = 0.3;
        delayFeedback = audioCtx.createGain();
        delayFeedback.gain.value = 0.4;
        delayNode.connect(delayFeedback);
        delayFeedback.connect(delayNode);
        delayNode.connect(masterGainNode);
        delayConnected = true;
    }
    return delayNode;
}
//#endregion ---  //!---




//#region --- //? VIEW ---
// Manages the display (DOM) and user interface.
const drumRack = document.getElementById('drum_rack_');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const tempoSlider = document.getElementById('tempoSlider');
const bpmInput = document.getElementById('bpmInput');
const swingSlider = document.getElementById('swingSlider');
const swingInput = document.getElementById('swingInput');
const swingGridSelect = document.getElementById('swingGridSelect');


function createPad(index, groupNumber) {
    const btn = document.createElement('button');
    const led = document.createElement('span');
    const label = document.createElement('span');
    const volume = document.createElement('input');

    led.classList.add('led');
    label.classList.add('pad-label');
    label.textContent = `PAD ${index + 1}`;

    // Volume slider configuration
    volume.type = 'range';
    volume.min = 0;
    volume.max = 1;
    volume.step = 0.05;
    volume.value = 1;
    volume.classList.add('pad-volume');

    btn.classList.add('btn', `group-${groupNumber}`);

    btn.appendChild(led);
    btn.appendChild(label);
    btn.appendChild(volume);

    return btn;
}

function updatePadVisual(btnElement, isActive) {
    btnElement.classList.toggle('active', isActive);
}

function updatePlaybackVisual(pads, step) {
    // Removes the 'playing' class from all pads
    pads.forEach(p => p.classList.remove('playing'));

    // Adds it only if the pad is also "active" in the model
    if (padsState[step]) {
        pads[step].classList.add('playing');
    }
}
//#endregion ---  //?---



//#region --- //* CONTROLLER ---
// Coordinates startup and interactions. 
let padsElements = [];
let fxLabelsElements = [];
let fxStripsElements = [];
let isDragging = false;  // Tracks if the mouse is held down
let isRightDragging = false; // Tracks if the right mouse button is held down
let dragAction = null;   // Tracks if we are "turning on" or "turning off" the pads

// Retrieve the effects rack from HTML
const fxRack = document.getElementById('fx-rack');
const padsInput = document.getElementById('padsInput');
const groupInput = document.getElementById('groupInput');

function initApp() {     //Called when changing the number of pads and groups
    // Stop everything before resetting
    stopSequencer();
    drumRack.innerHTML = '';
    // Clears the FX rack keeping the title
    const title = fxRack.querySelector('.fx-rack-title');  //saves the HTML of the "title"
    fxRack.innerHTML = '';
    if (title) fxRack.appendChild(title);

    // Reset reference arrays and model
    padsElements = []; fxLabelsElements = []; fxStripsElements = [];
    padsState = Array(totalButtons).fill(false);
    padBuffers = Array(totalButtons).fill(null);
    padFileNames = Array(totalButtons).fill('');
    padGains = Array(totalButtons).fill(1.0);
    activeSources = Array(totalButtons).fill(null);
    padReverbLevels = Array(totalButtons).fill(0.0);
    padDelayLevels = Array(totalButtons).fill(0.0);
    padPanLevels = Array(totalButtons).fill(0.0);

    for (let i = 0; i < totalButtons; i++) {
        // Calculates the group using modulo 8 to cycle them based on colors defined in CSS
        const groupNumber = (Math.floor(i / buttonsPerGroup) % 8) + 1;
        const pad = createPad(i, groupNumber);

        padsElements.push(pad);

        // Volume management for the single pad
        const volumeSlider = pad.querySelector('.pad-volume');  //Inside the pad, looks for the element with the .pad-volume class
        volumeSlider.onmousedown = (e) => e.stopPropagation(); // Prevents activating/deactivating the pad while adjusting the volume (blocks click on the pad)
        volumeSlider.oninput = (e) => {
            padGains[i] = parseFloat(e.target.value);
        };

        // Creation of FX strips in the separate rack
        const fxStrip = document.createElement('div');     //The single effects pad
        fxStrip.classList.add('fx-strip', `group-${groupNumber}`);
        fxStrip.classList.add('disabled'); // Starts off by default
        fxStripsElements.push(fxStrip);

        const fxLabel = document.createElement('span');
        fxLabel.textContent = `P${i + 1}`;
        fxLabelsElements.push(fxLabel);

        const revSlider = document.createElement('input');
        revSlider.type = 'range'; revSlider.min = 0; revSlider.max = 1; revSlider.step = 0.05; revSlider.value = 0;
        revSlider.classList.add('pad-fx', 'reverb');
        revSlider.title = 'Reverb';
        revSlider.oninput = (e) => {
            padReverbLevels[i] = parseFloat(e.target.value);
        };

        const delSlider = document.createElement('input');
        delSlider.type = 'range'; delSlider.min = 0; delSlider.max = 1; delSlider.step = 0.05; delSlider.value = 0;
        delSlider.classList.add('pad-fx', 'delay');
        delSlider.title = 'Delay';
        delSlider.oninput = (e) => {
            padDelayLevels[i] = parseFloat(e.target.value);
        };

        const panSlider = document.createElement('input');
        panSlider.type = 'range'; panSlider.min = -1; panSlider.max = 1; panSlider.step = 0.05; panSlider.value = 0;
        panSlider.classList.add('pad-fx', 'pan');
        panSlider.title = 'Pan (doppio clic = centro)';
        panSlider.oninput = (e) => {
            padPanLevels[i] = parseFloat(e.target.value);
        };
        panSlider.ondblclick = () => {
            panSlider.value = 0;
            padPanLevels[i] = 0;
        };

        fxStrip.append(fxLabel, revSlider, delSlider, panSlider);
        fxRack.appendChild(fxStrip);

        const clearPad = () => {
            // If there's a sound playing on this pad, we stop it immediately
            if (activeSources[i]) {
                try { activeSources[i].stop(); } catch (e) { }
                activeSources[i] = null;
            }

            // Empties the audio buffer for this pad in the model
            padBuffers[i] = null;

            // Turns off the pad in the sequencer
            padsState[i] = false;
            updatePadVisual(pad, false);

            // Restores the original label in the view
            const label = pad.querySelector('.pad-label');
            label.textContent = `PAD ${i + 1}`;
            fxLabelsElements[i].textContent = `P${i + 1}`;

            // Visually disables the FX strip
            fxStripsElements[i].classList.add('disabled');

            notifyMinidaw(i, false);
        };

        pad.onmousedown = (e) => {
            e.preventDefault(); // Prevents drag-and-drop or the native browser menu

            if (e.button === 0) {
                // Execute the "painting" action for the left click (button 0)
                isDragging = true;
                dragAction = !padsState[i]; // Determines the action based on the state of the first clicked pad
                padsState[i] = dragAction;
                updatePadVisual(pad, padsState[i]);
                notifyMinidaw(i, padsState[i]);
            } else if (e.button === 2) {
                // Erase action for the right click (button 2)
                isRightDragging = true;
                clearPad();
            }
        };

        pad.onmouseenter = () => {
            if (isDragging) {
                if (padsState[i] !== dragAction) {
                    padsState[i] = dragAction;
                    updatePadVisual(pad, padsState[i]);
                    notifyMinidaw(i, padsState[i]);
                }
            } else if (isRightDragging) {
                // Executes chain deletion by dragging
                clearPad();
            }
        };

        // Prevents the context menu
        pad.oncontextmenu = (e) => {
            e.preventDefault();
        };

        // Drag & Drop management of audio samples on the single pad
        pad.ondragover = (e) => {
            e.preventDefault(); // Necessary to allow the drop
            pad.classList.add('drag-over');
        };

        pad.ondragleave = () => {
            pad.classList.remove('drag-over');
        };

        pad.ondrop = async (e) => {   //The browser reads (and decodes) the audio file asynchronously
            e.preventDefault();
            pad.classList.remove('drag-over');

            const file = e.dataTransfer.files[0];  //Gets the first file among those dragged
            if (file && file.type.startsWith('audio/')) {    //Checks if the file is audio
                // Reads the dragged file
                const arrayBuffer = await file.arrayBuffer();
                // Decodes the audio to be able to play it
                const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

                // Saves the sound in the model corresponding to this pad
                padBuffers[i] = audioBuffer;
                padFileNames[i] = file.name;

                const shortName = file.name.substring(0, 5).toUpperCase();
                // Changes the pad label showing the first letters of the file
                const label = pad.querySelector('.pad-label');
                label.textContent = shortName;
                fxLabelsElements[i].textContent = shortName;

                // Enables the FX strip
                fxStripsElements[i].classList.remove('disabled');

                // Automatically turns on the pad
                padsState[i] = true;
                updatePadVisual(pad, true);
            }
        };

        drumRack.appendChild(pad); //Render of the drum rack buttons
    }
}

// Initialization on load
initApp();

// Stops dragging when releasing the click anywhere on the page
document.addEventListener('mouseup', () => {
    isDragging = false;
    isRightDragging = false;
});

// Function to play the sound
function playSound(index, buffer, volume, pan, reverbLevel, delayLevel) {
    // Browsers block audio until the user interacts. 
    // If it's suspended, we resume it.
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // If there's already a sound playing on this pad, we stop it to avoid overlaps
    if (activeSources[index]) {
        try {
            activeSources[index].stop();
        } catch (e) {
            // Ignore errors if the source has already finished
        }
    }

    const source = audioCtx.createBufferSource();
    activeSources[index] = source;

    // Remove the reference when the sound naturally ends
    source.onended = () => {
        if (activeSources[index] === source) activeSources[index] = null;
    };

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = volume;
    source.buffer = buffer;

    // Stereo Panner
    const pannerNode = audioCtx.createStereoPanner();
    pannerNode.pan.value = Math.max(-1, Math.min(1, pan || 0));

    source.connect(gainNode);
    gainNode.connect(pannerNode);
    pannerNode.connect(masterGainNode);

    // Reverb Send (Parallel Send)
    if (reverbLevel > 0) {
        const revGain = audioCtx.createGain();
        revGain.gain.value = reverbLevel;
        pannerNode.connect(revGain);
        revGain.connect(getReverbNode());
    }

    // Delay Send (Parallel Send)
    if (delayLevel > 0) {
        const delGain = audioCtx.createGain();
        delGain.gain.value = delayLevel;
        pannerNode.connect(delGain);
        delGain.connect(getDelayNode());
    }

    source.start(0);
}

// Isolated logic to manage the single step
function playNextStep() {
    // First updates the graphics for the CURRENT step
    updatePlaybackVisual(padsElements, currentStep);

    // Plays the sample if the pad is on AND has a sound loaded
    if (padsState[currentStep] && padBuffers[currentStep]) {
        playSound(
            currentStep,
            padBuffers[currentStep],
            padGains[currentStep],
            padPanLevels[currentStep],
            padReverbLevels[currentStep],
            padDelayLevels[currentStep]
        );
    }

    // Then prepares the step for the NEXT round
    currentStep = (currentStep + 1) % totalButtons;
}

function stepLoop() {    //Sequencer engine and recalculates the delay swing at each step
    playNextStep();

    let delay = sequenceSpeed;
    const swingFactor = swingAmount / 100;
    const swingShift = sequenceSpeed * 0.5 * swingFactor;

    // currentStep is now the NEXT step. The prevStep is the one that just played.
    let prevStep = (currentStep + totalButtons - 1) % totalButtons;
    let isSwingLengthened;

    if (swingGrid === 16) {
        // Swing 1/16: lengthens the wait after even steps (0->1 long, 1->2 short)
        isSwingLengthened = (prevStep % 2 === 0);
    } else {
        // Swing 1/8: lengthens the wait in the first half of each eighth note (0->1 long, 1->2 long, 2->3 short, 3->4 short)
        isSwingLengthened = (Math.floor(prevStep / 2) % 2 === 0);
    }

    if (isSwingLengthened) {
        delay = sequenceSpeed + swingShift;
    } else {
        delay = sequenceSpeed - swingShift;
    }

    //We don't use "setInterval" because it has a fixed time.
    intervalId = setTimeout(stepLoop, delay);  //Calls the function itself asynchronously.
}

function startSequencer() {
    if (intervalId) return; // Avoids starting multiple loops

    // Make sure the AudioContext is active on play
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // If we weren't paused, make sure to start from the beginning
    if (!isPaused) {
        currentStep = 0;
    }
    isPaused = false;

    // Illuminates the START button
    startBtn.classList.add('active');
    pauseBtn.classList.remove('active');

    stepLoop();
}

function pauseSequencer() {
    if (!intervalId) return; // Pauses only if it is playing

    clearTimeout(intervalId);
    intervalId = null;
    isPaused = true;

    // Visually updates the buttons
    startBtn.classList.remove('active');
    pauseBtn.classList.add('active');
}

function stopSequencer() {
    clearTimeout(intervalId);
    intervalId = null;
    isPaused = false;
    currentStep = 0;
    // Turns off the START and PAUSE buttons
    startBtn.classList.remove('active');
    pauseBtn.classList.remove('active');
    // Clears the last remaining light
    padsElements.forEach(p => p.classList.remove('playing'));

    // Stops all active sounds for cleanup
    activeSources.forEach((source, index) => {
        if (source) {
            try { source.stop(); } catch (e) { }
            activeSources[index] = null;
        }
    });
}

// Dynamic input management for Pads and Groups
padsInput.onchange = () => {
    let val = parseInt(padsInput.value);
    if (isNaN(val) || val < 4) val = 4;
    if (val > 64) val = 64;
    totalButtons = val;
    padsInput.value = val;
    initApp();
};

groupInput.onchange = () => {
    let val = parseInt(groupInput.value);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 16) val = 16;
    buttonsPerGroup = val;
    groupInput.value = val;
    initApp();
};

function updateTempo(source) {
    let bpm;

    if (source === 'slider') {
        bpm = tempoSlider.value;
        bpmInput.value = bpm; // Synchronizes the number with the slider
    } else {
        bpm = parseInt(bpmInput.value);
        if (isNaN(bpm)) bpm = 120; // Sets 120 if the value is not a number
        if (bpm < 30) bpm = 30;    // Minimum limit
        if (bpm > 200) bpm = 200;  // Maximum limit
        bpmInput.value = bpm;
        tempoSlider.value = bpm;   // Synchronizes the slider with the typed number
    }

    // Calculation in milliseconds: (60.000ms / BPM) / 4 (to get sixteenth notes)
    sequenceSpeed = (60000 / bpm) / 4;

    // If the sequencer is active, we update the interval "on the fly"
    if (intervalId) {
        clearTimeout(intervalId);
        intervalId = setTimeout(stepLoop, sequenceSpeed);
    }
}

function updateSwing(source) {
    let val;
    if (source === 'slider') {
        val = parseInt(swingSlider.value);
        swingInput.value = val;
    } else {
        val = parseInt(swingInput.value);
        if (isNaN(val)) val = 0;
        if (val < 0) val = 0;
        if (val > 100) val = 100;
        swingSlider.value = val;
    }
    swingAmount = val;
    notifySwingMinidaw();
}

// We use onchange for the keyboard, so that the update occurs when you press "Enter" or click outside
tempoSlider.oninput = () => updateTempo('slider');
tempoSlider.ondblclick = () => {     //Double click.
    bpmInput.value = 100;
    updateTempo('input'); // We use 'input' so it forces the slider update and applies the limits
};
bpmInput.onchange = () => updateTempo('input');

swingSlider.oninput = () => updateSwing('slider');
swingSlider.ondblclick = () => {
    swingInput.value = 0;
    updateSwing('input');
};
swingInput.onchange = () => updateSwing('input');

swingGridSelect.onchange = () => {
    swingGrid = parseInt(swingGridSelect.value);
    notifySwingMinidaw();
};

function clearAllPads() {
    for (let i = 0; i < totalButtons; i++) {
        padsState[i] = false;
        updatePadVisual(padsElements[i], false);
    }
}

clearBtn.onclick = clearAllPads;
startBtn.onclick = startSequencer;
pauseBtn.onclick = pauseSequencer;
stopBtn.onclick = stopSequencer;
drumRack.onmousedown = (e) => { e.preventDefault() }; // Removes text selection from the drum rack
drumRack.oncontextmenu = (e) => { e.preventDefault() }; // Prevents the context menu on the drum rack

// === STATE SAVE / LOAD ===
window.getInstrumentState = function () {
    const serializedBuffers = padBuffers.map(buffer => {
        if (!buffer) return null;
        if (window.parent && window.parent.audioBufferToBase64) {
            return window.parent.audioBufferToBase64(buffer);
        }
        return null;
    });

    const labels = padsElements.map(pad => pad.querySelector('.pad-label').textContent);

    return {
        totalButtons,
        buttonsPerGroup,
        padGains: [...padGains],
        padReverbLevels: [...padReverbLevels],
        padDelayLevels: [...padDelayLevels],
        padPanLevels: [...padPanLevels],
        padBuffers: serializedBuffers,
        labels: labels,
        fullNames: [...padFileNames]
    };
};

window.setInstrumentState = async function (state) {
    if (!state) return;

    if (state.totalButtons) {
        padsInput.value = state.totalButtons;
        totalButtons = state.totalButtons;
    }
    if (state.buttonsPerGroup) {
        groupInput.value = state.buttonsPerGroup;
        buttonsPerGroup = state.buttonsPerGroup;
    }

    initApp(); // Rebuilds the DOM based on the buttons

    for (let i = 0; i < totalButtons; i++) {
        if (state.padGains && state.padGains[i] !== undefined) {
            padGains[i] = state.padGains[i];
            const volSlider = padsElements[i].querySelector('.pad-volume');
            if (volSlider) volSlider.value = padGains[i];
        }
        if (state.padReverbLevels && state.padReverbLevels[i] !== undefined) {
            padReverbLevels[i] = state.padReverbLevels[i];
            const revSlider = fxStripsElements[i].querySelector('.reverb');
            if (revSlider) revSlider.value = padReverbLevels[i];
        }
        if (state.padDelayLevels && state.padDelayLevels[i] !== undefined) {
            padDelayLevels[i] = state.padDelayLevels[i];
            const delSlider = fxStripsElements[i].querySelector('.delay');
            if (delSlider) delSlider.value = padDelayLevels[i];
        }
        if (state.padPanLevels && state.padPanLevels[i] !== undefined) {
            padPanLevels[i] = state.padPanLevels[i];
            const panSlider = fxStripsElements[i].querySelector('.pan');
            if (panSlider) panSlider.value = padPanLevels[i];
        }
        if (state.labels && state.labels[i]) {
            const label = padsElements[i].querySelector('.pad-label');
            if (label) label.textContent = state.labels[i];
            if (fxLabelsElements[i]) fxLabelsElements[i].textContent = state.labels[i];
        }
        if (state.fullNames && state.fullNames[i]) {
            padFileNames[i] = state.fullNames[i];
        }
        if (state.padBuffers && state.padBuffers[i]) {
            try {
                let buffer;
                if (typeof state.padBuffers[i] === "string" && window.parent && window.parent.base64ToAudioBuffer) {
                    buffer = await window.parent.base64ToAudioBuffer(state.padBuffers[i], audioCtx);
                } else {
                    buffer = state.padBuffers[i];
                }
                padBuffers[i] = buffer;
                if (fxStripsElements[i]) fxStripsElements[i].classList.remove('disabled');
            } catch (e) {
                console.error('Error decoding drum rack buffer', e);
            }
        }
    }
};

window.addEventListener('unload', () => {
    stopSequencer();
    activeSources.forEach(source => {
        if (source) {
            try { source.stop(); source.disconnect(); } catch (e) { }
        }
    });
    try { if (masterGainNode) masterGainNode.disconnect(); } catch (e) { }
    try { if (reverbNode) reverbNode.disconnect(); } catch (e) { }
    try { if (delayNode) delayNode.disconnect(); } catch (e) { }
});

//#endregion ---  //*---