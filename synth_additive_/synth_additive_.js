// ─── Audio Context ───────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function ensureAudioCtx() {
    if (!audioCtx) {
        audioCtx = (window.parent && window.parent.masterAudioCtx) ? window.parent.masterAudioCtx : new AudioCtx();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

// ─── Synth State ─────────────────────────────────────
const NUM_HARMONICS = 16;
let currentOctave = 4;
let masterGain = 0.5; // will be recalculated by setupMasterVolume with exp curve

// Harmonic amplitudes (1-indexed logical, 0-indexed array)
const harmonicAmplitudes = new Float32Array(NUM_HARMONICS);
harmonicAmplitudes[0] = 1.0; // fundamental at full

// ADSR
const adsr = {
    attack: 0.01,
    decay: 0.1,
    sustain: 0.7,
    release: 0.3
};

// Filter
const filterSettings = {
    type: 'lowpass',
    cutoff: 20000,
    resonance: 1
};

// FX: Vibrato & Tremolo
const vibratoVal = { rate: 5, depth: 0 };
const tremoloVal = { rate: 5, depth: 0 };
const filterLFOVal = { rate: 3, depth: 0, type: 'sine' };

// Active voices: Map<key, voiceObject> (optimized and it preserves the FIFO order during iterations)
const activeVoices = new Map(); //Map() accepts any type of data as key, not only strings(diffent from object {})

function stopAllNotes() {
    activeVoices.forEach((voice, key) => {
        noteOff(key);
    });
}

// Audio chain: Voices → preGainNode (fixed mix) → Limiter → outputGainNode (user volume) → Destination
let preGainNode = null;  // Summing junction (all voices connect here)
let tremoloGainNode = null;
let filterNode = null;
let filterBaseGain = null; // GainNode for multiplicative cutoff
let filterLfo = null;
let filterMod = null;
let filterModSource = null; // ConstantSource(1.0)
let filterRandomInterval = null; // Timer for S&H
let filterRandomValue = 0; // Current S&H value
let vibratoLfo = null;
let vibratoGain = null;
let tremoloLfo = null;
let tremoloMod = null;
let limiterNode = null;
let outputGainNode = null;

function getMasterGain() {  //called everytime you press a key(note)
    const ctx = ensureAudioCtx();
    if (!preGainNode) {  //!!!!!the node are created only the first time you press a key (when preGainNode is null)!!!!!!
        // Pre-gain: fixed level going into the limiter
        preGainNode = ctx.createGain();
        preGainNode.gain.value = 1.0;

        // Tremolo Node (VCA for Tremolo)
        tremoloGainNode = ctx.createGain();
        tremoloGainNode.gain.value = 1.0;

        // Global Vibrato LFO (connects to detune of oscillators)
        vibratoGain = ctx.createGain();
        vibratoGain.gain.value = vibratoVal.depth * 50; // max 50 cents depth
        vibratoLfo = ctx.createOscillator();
        vibratoLfo.frequency.value = vibratoVal.rate;
        vibratoLfo.connect(vibratoGain);
        vibratoLfo.start();

        // Global Tremolo LFO
        tremoloMod = ctx.createGain();
        tremoloMod.gain.value = tremoloVal.depth;
        tremoloLfo = ctx.createOscillator();
        tremoloLfo.frequency.value = tremoloVal.rate;
        tremoloLfo.connect(tremoloMod);
        tremoloMod.connect(tremoloGainNode.gain);
        tremoloLfo.start();

        // Filter Setup
        filterNode = ctx.createBiquadFilter();
        filterNode.type = filterSettings.type;
        filterNode.frequency.value = 0; // Controlled via gain
        filterNode.Q.value = filterSettings.resonance;

        // Multiplicative Cutoff Logic:
        // ResultFrequency = Cutoff_Hz * (1.0 + LFO_Output * Depth)

        // 1. Base Cutoff Gain
        filterBaseGain = ctx.createGain();
        filterBaseGain.gain.value = filterSettings.cutoff;
        filterBaseGain.connect(filterNode.frequency);

        // 2. Modulator Source (Constant 1.0)
        filterModSource = ctx.createConstantSource();
        filterModSource.offset.value = 1.0;
        filterModSource.start();
        filterModSource.connect(filterBaseGain);

        // 3. LFO
        filterMod = ctx.createGain();
        filterMod.gain.value = filterLFOVal.depth; // range 0-1
        filterLfo = ctx.createOscillator();
        filterLfo.frequency.value = filterLFOVal.rate;
        filterLfo.connect(filterMod);
        filterMod.connect(filterModSource.offset); // Additive to the constant 1.0
        filterLfo.start();

        // Output gain: controlled by the master volume
        outputGainNode = ctx.createGain();
        outputGainNode.gain.value = masterGain;

        // Chain: voices → preGain → tremoloGain → filter → outputGain → destination
        preGainNode.connect(tremoloGainNode);
        tremoloGainNode.connect(filterNode);
        filterNode.connect(outputGainNode);

        // window.createMixerFX is a public function of mixer_fx.js!!
        const masterOut = window.createMixerFX ? window.createMixerFX(ctx) : ctx.destination;
        outputGainNode.connect(masterOut);

        // Analyser tapped after output gain (smaller FFT for performance)
        analyserNode = ctx.createAnalyser();
        analyserNode.fftSize = 512;
        outputGainNode.connect(analyserNode);
    }
    return preGainNode;  // voices connect here
}

let analyserNode = null;

// ─── Note Frequencies ────────────────────────────────
// Generates freq for MIDI note number (A4 = 69 = 440Hz)
function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

// Note names
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function isBlackKey(noteIndex) {
    return [1, 3, 6, 8, 10].includes(noteIndex % 12);
}

// ─── Keyboard Mapping (Ableton-style) ────────────────
// Bottom row: white keys C D E F G A B, top row: sharps
// a=C, w=C#, s=D, e=D#, d=E, f=F, t=F#, g=G, y=G#, h=A, u=A#, j=B
// k=C+1, o=C#+1, l=D+1, p=D#+1
const KEY_MAP = {
    'a': 0,   // C
    'w': 1,   // C#
    's': 2,   // D
    'e': 3,   // D#
    'd': 4,   // E
    'f': 5,   // F
    't': 6,   // F#
    'g': 7,   // G
    'y': 8,   // G#
    'h': 9,   // A
    'u': 10,  // A#
    'j': 11,  // B
    'k': 12,  // C  (next octave)
    'o': 13,  // C# (next octave)
    'l': 14,  // D  (next octave)
    'p': 15,  // D# (next octave)
};

// ─── Additive Voice ──────────────────────────────────
// Per-voice amplitude cap to prevent clipping with polyphony
const VOICE_AMPLITUDE = 0.25;

// Generates the PeriodicWave from current harmonicAmplitudes
function getPeriodicWave() {
    const ctx = ensureAudioCtx();
    const real = new Float32Array(NUM_HARMONICS + 1);  //possibile ottimizzazione(poco impatto, ma elegante): inizializzare solo una volta fuori dalla funzione
    const imag = new Float32Array(NUM_HARMONICS + 1); //DC component + HARMONICS

    const totalAmplitude = harmonicAmplitudes.reduce((sum, v) => sum + v, 0) || 1;

    for (let i = 0; i < NUM_HARMONICS; i++) {
        // WebAudio uses imag array for sine wave components (real are useless in this case)
        imag[i + 1] = harmonicAmplitudes[i] / totalAmplitude; //Frequency spectrum filled
    }

    return ctx.createPeriodicWave(real, imag, { disableNormalization: false }); //Inverse Fourier Transform
}

function createVoice(freq) {
    const ctx = ensureAudioCtx();
    const master = getMasterGain();
    const now = ctx.currentTime;

    // Voice gain node (for ADSR)
    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);

    // ADSR — Attack (peak at VOICE_AMPLITUDE, sustain proportional)
    voiceGain.gain.linearRampToValueAtTime(VOICE_AMPLITUDE, now + adsr.attack);
    // Decay → Sustain
    voiceGain.gain.linearRampToValueAtTime(VOICE_AMPLITUDE * adsr.sustain, now + adsr.attack + adsr.decay);

    // Create a single oscillator using PeriodicWave
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(getPeriodicWave());
    osc.frequency.value = freq;

    // Connect global vibrato to the oscillator's detune
    if (vibratoGain) {
        vibratoGain.connect(osc.detune);  //we use detune to mantain the same vibrato regardless of the frequency 
    }

    osc.connect(voiceGain);      //osc -> ADSR -> preGainNode
    voiceGain.connect(master);   //preGainNode -> tremoloGainNode -> filterNode -> outputGainNode -> analyser
    osc.start(now);

    return { oscillator: osc, voiceGain, freq };
}

// Update harmonics on all active voices in real-time (while i'm still playing a note)
function updateActiveVoicesHarmonics() {
    if (activeVoices.size === 0) return; //if i'm not playing any note, do nothing
    const wave = getPeriodicWave(); //get the new wave

    activeVoices.forEach(voice => {
        if (voice.oscillator) {
            try {
                voice.oscillator.setPeriodicWave(wave); //set the new wave to each active voice
            } catch (e) {
                console.error("Error updating PeriodicWave:", e); //avoid crashes
            }
        }
    });
}

function releaseVoice(voice) {
    const ctx = ensureAudioCtx();
    const now = ctx.currentTime;
    const vg = voice.voiceGain.gain;

    // Cancel scheduled to avoid conflicts
    vg.cancelScheduledValues(now);
    vg.setValueAtTime(vg.value, now);
    // Release ramp
    vg.linearRampToValueAtTime(0, now + adsr.release);

    // Stop oscillator after release
    const stopTime = now + adsr.release + 0.05;
    if (voice.oscillator) {
        voice.oscillator.stop(stopTime); //stops the oscillator but it still exists (since it's connected to other nodes)!
    }

    // Cleanup: disconnect all nodes after release to prevent zombie AudioNode accumulation
    const cleanupDelayMs = (adsr.release + 0.15) * 1000;
    setTimeout(() => {
        try {
            // Disconnect vibrato from oscillator's detune
            if (vibratoGain && voice.oscillator) {
                try { vibratoGain.disconnect(voice.oscillator.detune); } catch (e) { }
            }
            // Disconnect oscillator
            try { if (voice.oscillator) voice.oscillator.disconnect(); } catch (e) { }
            // Disconnect voice gain from master
            try { voice.voiceGain.disconnect(); } catch (e) { }
        } catch (e) { }
    }, cleanupDelayMs);
}

// Max simultaneous voices (poliphony)
const MAX_VOICES = 16;

function noteOn(key, midiNote) {
    if (activeVoices.has(key)) return; // example: if i hold "A", the OS send "AAAAAAAAA" --> we must avoid creating multiple oscillators (one per "A")!

    // Steal oldest voice if at polyphony limit
    if (activeVoices.size >= MAX_VOICES) {
        const oldestKey = activeVoices.keys().next().value; //return oldest key
        const oldestVoice = activeVoices.get(oldestKey);
        releaseVoice(oldestVoice);
        activeVoices.delete(oldestKey);
    }

    const freq = midiToFreq(midiNote);
    const voice = createVoice(freq);
    voice.midiNote = midiNote;
    activeVoices.set(key, voice);
}

function noteOff(key) {
    const voice = activeVoices.get(key);
    if (!voice) return;

    releaseVoice(voice);
    activeVoices.delete(key);
}

// --- MINI DAW CONNECTION ---
window.addEventListener('message', (event) => {  //Listen for messages from the parent window (the DAW)
    const { type, midi, key } = event.data;
    if (type === 'note-on') {
        noteOn(key || `remote_${midi}`, midi); //"remote" is used when the note comes from the piano roll
    } else if (type === 'note-off') {
        noteOff(key || `remote_${midi}`);
    } else if (type === 'stop-all') {
        stopAllNotes();
    }
});

// ─── Keyboard Events ─────────────────────────────────
const pressedKeys = new Set();

document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();

    // Octave control
    if (k === 'z') {
        setOctave(currentOctave - 1);
        return;
    }
    if (k === 'x') {
        setOctave(currentOctave + 1);
        return;
    }

    // Note keys
    if (KEY_MAP.hasOwnProperty(k) && !pressedKeys.has(k)) {
        pressedKeys.add(k);
        const semitone = KEY_MAP[k];
        const midiNote = (currentOctave + 1) * 12 + semitone; // C4 = MIDI 60 when octave=4
        noteOn(k, midiNote);
    }
});

document.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (pressedKeys.has(k)) {
        pressedKeys.delete(k);
        noteOff(k);
    }
});

// ─── Octave ──────────────────────────────────────────
function setOctave(oct) {
    oct = Math.max(0, Math.min(8, oct));
    if (oct === currentOctave) return;

    // Release all current notes before switching
    for (const [key] of activeVoices) {
        noteOff(key);
    }
    pressedKeys.clear();

    currentOctave = oct;
    document.getElementById('octaveValue').textContent = oct;
}

// ═══ UI BUILDING ═════════════════════════════════════ (alt+205)

// ─── Harmonics Sliders ───────────────────────────────
function buildHarmonicsUI() {
    const grid = document.getElementById('harmonicsGrid');
    grid.innerHTML = '';

    for (let i = 0; i < NUM_HARMONICS; i++) {
        const row = document.createElement('div');
        row.className = 'harmonic-row';

        const label = document.createElement('span');
        label.className = 'harmonic-label';
        label.textContent = i + 1;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'harmonic-slider';
        slider.id = `harmonic_${i}`;
        slider.min = '0';
        slider.max = '1';
        slider.step = '0.01';
        slider.value = harmonicAmplitudes[i];
        slider.dataset.index = i;

        const value = document.createElement('span');
        value.className = 'harmonic-value';
        value.textContent = Math.round(harmonicAmplitudes[i] * 100) + '%';

        slider.addEventListener('input', () => {
            harmonicAmplitudes[i] = parseFloat(slider.value);
            value.textContent = Math.round(harmonicAmplitudes[i] * 100) + '%';
            // Update style gradient for visual on the slider track
            updateSliderFill(slider);
            // Update harmonics on currently playing notes in real-time
            updateActiveVoicesHarmonics();
        });

        // Automations
        slider.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            window.parent.postMessage({
                type: 'create-automation',
                paramId: slider.id,
                paramName: `Harmonic ${i + 1}`,
                min: 0,
                max: 1
            }, '*');
        });

        updateSliderFill(slider);

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(value);
        grid.appendChild(row);
    }
}

function updateSliderFill(slider) {
    const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100; //range 0-100
    slider.style.background = `linear-gradient(to right, #7c3aed ${pct}%, #2d343e ${pct}%)`;
}

// ─── Presets ─────────────────────────────────────────

function setPresetADSR(a, d, s, r) {
    const attackSl = document.getElementById('attackSlider');
    const decaySl = document.getElementById('decaySlider');
    const sustainSl = document.getElementById('sustainSlider');
    const releaseSl = document.getElementById('releaseSlider');

    if (attackSl && decaySl && sustainSl && releaseSl) {
        attackSl.value = a;
        decaySl.value = d;
        sustainSl.value = s;
        releaseSl.value = r;


        [attackSl, decaySl, sustainSl, releaseSl].forEach(sl => {
            sl.dispatchEvent(new Event('input'));
        });
    }
}

function setPresetFilter(type, cutoff, resonance) {
    // Update filter type via custom select
    const trigger = document.getElementById('filterTypeTrigger');
    const optionsContainer = document.getElementById('filterTypeOptions');
    if (trigger && optionsContainer) {
        const options = optionsContainer.querySelectorAll('.custom-option');
        options.forEach(opt => {
            if (opt.dataset.value === type) {
                opt.classList.add('selected');
                trigger.textContent = opt.textContent;
            } else {
                opt.classList.remove('selected');
            }
        });
        filterSettings.type = type;
    }

    // Update cutoff and resonance sliders
    const cutoffSl = document.getElementById('cutoffSlider');
    const resonanceSl = document.getElementById('resonanceSlider');

    if (cutoffSl && resonanceSl) {
        cutoffSl.value = cutoff;
        resonanceSl.value = resonance;

        // Scatena l'evento 'input' per aggiornare la UI e la logica interna
        [cutoffSl, resonanceSl].forEach(el => {
            el.dispatchEvent(new Event('input'));
        });
    }
}


const PRESETS = {
    sine: () => {
        harmonicAmplitudes.fill(0);
        harmonicAmplitudes[0] = 1;
        setPresetADSR(0.01, 0.1, 0.7, 0.3);
        setPresetFilter('lowpass', 20000, 1.0);
    },
    sawtooth: () => {
        for (let i = 0; i < NUM_HARMONICS; i++) harmonicAmplitudes[i] = 1 / (i + 1);
        setPresetADSR(0.01, 0.2, 0.5, 0.2);
        setPresetFilter('lowpass', 15000, 1.0);
    },
    square: () => {
        for (let i = 0; i < NUM_HARMONICS; i++) harmonicAmplitudes[i] = (i % 2 === 0) ? 1 / (i + 1) : 0;
        setPresetADSR(0.01, 0.2, 0.5, 0.2);
        setPresetFilter('lowpass', 15000, 1.0);
    },
    triangle: () => {
        for (let i = 0; i < NUM_HARMONICS; i++) harmonicAmplitudes[i] = (i % 2 === 0) ? 1 / Math.pow(i + 1, 2) : 0;
        setPresetADSR(0.01, 0.1, 0.8, 0.3);
        setPresetFilter('lowpass', 10000, 1.0);
    },
    organ: () => {
        harmonicAmplitudes.fill(0);
        [1, 0.8, 0.6, 0.4, 0, 0.3, 0, 0.2].forEach((val, i) => harmonicAmplitudes[i] = val);
        setPresetADSR(0.001, 0.1, 1.0, 0.05);
        setPresetFilter('notch', 3000, 1.0);
    },
    bell: () => {
        harmonicAmplitudes.fill(0);
        [1, 0, 0, 0.7, 0, 0.5, 0, 0.4, 0, 0.3, 0, 0.2, 0, 0.15].forEach((val, i) => {
            if (i < NUM_HARMONICS) harmonicAmplitudes[i] = val;
        });
        setPresetADSR(0.001, 1.5, 0.0, 2.0);
        setPresetFilter('highpass', 500, 2.0);
    },

    brass: () => {
        harmonicAmplitudes.fill(0);
        const brassWave = [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.15, 0.1, 0.05, 0.02];
        brassWave.forEach((v, i) => { if (i < NUM_HARMONICS) harmonicAmplitudes[i] = v; });
        setPresetADSR(0.12, 0.3, 0.7, 0.4);
        setPresetFilter('lowpass', 2500, 4.0); // Risuona maggiormente per il timbro brassy
    },
    flute: () => {
        harmonicAmplitudes.fill(0);
        harmonicAmplitudes[0] = 1;
        harmonicAmplitudes[1] = 0.3;
        harmonicAmplitudes[2] = 0.1;
        harmonicAmplitudes[3] = 0.05;
        setPresetADSR(0.1, 0.15, 0.8, 0.3);
        setPresetFilter('lowpass', 4000, 0.7);
    },
    strings: () => {
        for (let i = 0; i < NUM_HARMONICS; i++) {
            harmonicAmplitudes[i] = Math.pow(0.75, i);
        }
        setPresetADSR(0.3, 0.4, 0.8, 0.6);
        setPresetFilter('lowpass', 3500, 1.5);
    },
    clarinet: () => {
        harmonicAmplitudes.fill(0);
        for (let i = 0; i < NUM_HARMONICS; i++) {
            if (i % 2 === 0) {
                harmonicAmplitudes[i] = 1 / Math.pow(i + 1, 1.2);
            } else {
                harmonicAmplitudes[i] = 0.05;
            }
        }
        setPresetADSR(0.08, 0.2, 0.8, 0.25);
        setPresetFilter('lowpass', 2000, 1.0);
    },
    choir: () => {
        harmonicAmplitudes.fill(0);
        const formants = [1, 0.3, 0.1, 0.6, 0.5, 0.2, 0.4, 0.2, 0.1];
        formants.forEach((v, i) => { if (i < NUM_HARMONICS) harmonicAmplitudes[i] = v; });
        setPresetADSR(0.4, 0.5, 0.9, 0.7);
        setPresetFilter('bandpass', 1200, 2.0); // Simula formanti vocali
    },
    pluck: () => {
        for (let i = 0; i < NUM_HARMONICS; i++) {
            harmonicAmplitudes[i] = 1 / Math.pow(i + 1, 1.2);
        }
        setPresetADSR(0.001, 0.4, 0.0, 0.4);
        setPresetFilter('lowpass', 5000, 1.5);
    },
    bass: () => {
        harmonicAmplitudes.fill(0);
        harmonicAmplitudes[0] = 1.0;
        harmonicAmplitudes[1] = 0.7;
        harmonicAmplitudes[2] = 0.4;
        harmonicAmplitudes[3] = 0.1;
        setPresetADSR(0.01, 0.3, 0.3, 0.15);
        setPresetFilter('lowpass', 800, 5.0); // Basso profondo con risonanza
    },
    vintage: () => {
        for (let i = 0; i < NUM_HARMONICS; i++) {
            harmonicAmplitudes[i] = (i % 2 === 0) ? 1 / (i + 1) : 0.6 / (i + 1);
        }
        setPresetADSR(0.05, 0.2, 0.5, 0.4);
        setPresetFilter('lowpass', 3000, 2.5);
    },
    nasal: () => {
        harmonicAmplitudes.fill(0);
        harmonicAmplitudes[2] = 0.6;
        harmonicAmplitudes[3] = 1.0;
        harmonicAmplitudes[4] = 0.7;
        setPresetADSR(0.05, 0.2, 0.7, 0.3);
        setPresetFilter('bandpass', 1500, 3.0);
    },
    hollow: () => {
        harmonicAmplitudes.fill(0);
        harmonicAmplitudes[0] = 1.0;
        harmonicAmplitudes[2] = 0.5;
        harmonicAmplitudes[4] = 0.1;
        setPresetADSR(0.05, 0.3, 0.7, 0.4);
        setPresetFilter('notch', 1000, 2.0);
    },
    clear: () => {
        harmonicAmplitudes.fill(0);
        harmonicAmplitudes[0] = 1.0;
        setPresetADSR(0.01, 0.1, 0.7, 0.3);
        setPresetFilter('lowpass', 20000, 1.0);
    }
};

let currentPreset = 'sine';

function applyPreset(name) {
    if (PRESETS[name]) {
        PRESETS[name]();
        buildHarmonicsUI(); // refresh sliders
        currentPreset = name;
    }
    // Highlight active preset button
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === name);
    });
}

// ─── ADSR Controls ───────────────────────────────────
function setupADSR() {
    const attackSl = document.getElementById('attackSlider');
    const decaySl = document.getElementById('decaySlider');
    const sustainSl = document.getElementById('sustainSlider');
    const releaseSl = document.getElementById('releaseSlider');

    const attackVal = document.getElementById('attackValue');
    const decayVal = document.getElementById('decayValue');
    const sustainVal = document.getElementById('sustainValue');
    const releaseVal = document.getElementById('releaseValue');

    const updateADSR = () => {
        adsr.attack = parseFloat(attackSl.value);
        adsr.decay = parseFloat(decaySl.value);
        adsr.sustain = parseFloat(sustainSl.value);
        adsr.release = parseFloat(releaseSl.value);

        attackVal.textContent = adsr.attack >= 1 ? adsr.attack.toFixed(1) + 's' : Math.round(adsr.attack * 1000) + 'ms';
        decayVal.textContent = adsr.decay >= 1 ? adsr.decay.toFixed(1) + 's' : Math.round(adsr.decay * 1000) + 'ms';
        sustainVal.textContent = Math.round(adsr.sustain * 100) + '%';
        releaseVal.textContent = adsr.release >= 1 ? adsr.release.toFixed(1) + 's' : Math.round(adsr.release * 1000) + 'ms';

        drawADSR();


        // Update slider fills
        [attackSl, decaySl, sustainSl, releaseSl].forEach(sl => {
            const pct = ((sl.value - sl.min) / (sl.max - sl.min)) * 100;
            sl.style.background = `linear-gradient(to right, #00d4ff ${pct}%, #2d343e ${pct}%)`;
        });
    };

    [attackSl, decaySl, sustainSl, releaseSl].forEach(sl =>
        sl.addEventListener('input', updateADSR)
    );

    updateADSR();
}

// ─── ADSR Canvas ────────────────────────────────────
function drawADSR() {
    const canvas = document.getElementById('adsrCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth * 2; // HiDPI
    const H = canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);
    const w = W / 2;
    const h = H / 2;

    ctx.clearRect(0, 0, w, h);

    const pad = 12;
    const drawW = w - 2 * pad;
    const drawH = h - 2 * pad;

    // Time proportions
    const totalTime = adsr.attack + adsr.decay + 0.3 + adsr.release; // 0.3 = visual sustain hold
    const aX = pad + (adsr.attack / totalTime) * drawW;
    const dX = aX + (adsr.decay / totalTime) * drawW;
    const sX = dX + (0.3 / totalTime) * drawW;
    const rX = sX + (adsr.release / totalTime) * drawW;

    const bottom = pad + drawH;
    const top = pad;
    const sustainY = pad + drawH * (1 - adsr.sustain);

    // Fill gradient under curve
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(0, 212, 255, 0.15)');
    grad.addColorStop(1, 'rgba(0, 212, 255, 0.01)');

    ctx.beginPath();
    ctx.moveTo(pad, bottom);
    ctx.lineTo(aX, top);
    ctx.lineTo(dX, sustainY);
    ctx.lineTo(sX, sustainY);
    ctx.lineTo(rX, bottom);
    ctx.lineTo(pad, bottom);
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(pad, bottom);
    ctx.lineTo(aX, top);
    ctx.lineTo(dX, sustainY);
    ctx.lineTo(sX, sustainY);
    ctx.lineTo(rX, bottom);
    ctx.strokeStyle = '#00d4ff';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Dots
    const dots = [[pad, bottom], [aX, top], [dX, sustainY], [sX, sustainY], [rX, bottom]];
    dots.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#00d4ff';
        ctx.fill();
    });

    // Labels
    ctx.fillStyle = '#475569';
    ctx.font = '9px Outfit';
    ctx.textAlign = 'center';
    ctx.fillText('A', (pad + aX) / 2, bottom + 10);
    ctx.fillText('D', (aX + dX) / 2, bottom + 10);
    ctx.fillText('S', (dX + sX) / 2, bottom + 10);
    ctx.fillText('R', (sX + rX) / 2, bottom + 10);
}


// ─── ADSR Canvas Interaction ─────────────────────────
function setupADSRCanvasInteraction() {
    const canvas = document.getElementById('adsrCanvas');
    let draggingPoint = null;
    let lastX = 0;
    let lastY = 0;

    // Helper to calculate current point coordinates on canvas (proportional mapping)
    const getPoints = () => {
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;
        const pad = 12;
        const drawW = w - 2 * pad;
        const drawH = h - 2 * pad;
        const totalTime = Math.max(0.1, adsr.attack + adsr.decay + 0.3 + adsr.release);

        return {
            A: { x: pad + (adsr.attack / totalTime) * drawW, y: pad },
            D: { x: pad + ((adsr.attack + adsr.decay) / totalTime) * drawW, y: pad + drawH * (1 - adsr.sustain) },
            R: { x: pad + ((adsr.attack + adsr.decay + 0.3 + adsr.release) / totalTime) * drawW, y: pad + drawH }
        };
    };

    // Start dragging
    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const pts = getPoints();
        const hitRadius = 15;

        if (Math.hypot(x - pts.A.x, y - pts.A.y) < hitRadius) draggingPoint = 'A';
        else if (Math.hypot(x - pts.D.x, y - pts.D.y) < hitRadius) draggingPoint = 'D';
        else if (Math.hypot(x - pts.R.x, y - pts.R.y) < hitRadius) draggingPoint = 'R';

        if (draggingPoint) {
            lastX = x;
            lastY = y;
            document.body.style.cursor = 'grabbing';
        }
    });

    // Handle dragging
    window.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Hover effect
        if (!draggingPoint) {
            const pts = getPoints();
            const hitRadius = 15;
            if (Math.hypot(x - pts.A.x, y - pts.A.y) < hitRadius ||
                Math.hypot(x - pts.D.x, y - pts.D.y) < hitRadius ||
                Math.hypot(x - pts.R.x, y - pts.R.y) < hitRadius) {
                canvas.style.cursor = 'grab';
            } else {
                canvas.style.cursor = 'default';
            }
            return;
        }

        const dx = x - lastX;
        const dy = y - lastY;
        lastX = x;
        lastY = y;

        // Sensitivities relative to canvas size
        const timeSens = 2.0 / canvas.offsetWidth;
        const relSens = 5.0 / canvas.offsetWidth;
        const susSens = 1.0 / canvas.offsetHeight;

        const updateSlider = (id, val) => {
            const sl = document.getElementById(id);
            sl.value = val;
            sl.dispatchEvent(new Event('input'));
        };

        if (draggingPoint === 'A') {
            updateSlider('attackSlider', Math.max(0.001, Math.min(2, adsr.attack + dx * timeSens)));
        } else if (draggingPoint === 'D') {
            updateSlider('decaySlider', Math.max(0.001, Math.min(2, adsr.decay + dx * timeSens)));
            updateSlider('sustainSlider', Math.max(0, Math.min(1, adsr.sustain - dy * susSens)));
        } else if (draggingPoint === 'R') {
            updateSlider('releaseSlider', Math.max(0.01, Math.min(5, adsr.release + dx * relSens)));
        }
    });

    window.addEventListener('mouseup', () => {
        if (draggingPoint) {
            draggingPoint = null;
            document.body.style.cursor = 'default';
        }
    });
}


// ─── Custom Selects────────────────
function initCustomSelect(containerId, triggerId, optionsId, onSelect) {
    const trigger = document.getElementById(triggerId);
    const options = document.getElementById(optionsId);
    const optionElements = options.querySelectorAll('.custom-option');

    const toggle = (e) => {
        e.stopPropagation();
        const isOpen = options.classList.contains('open');
        // Close all other custom selects first
        document.querySelectorAll('.custom-options').forEach(opt => opt.classList.remove('open'));

        if (!isOpen) {
            options.classList.add('open');
            stopAllNotes(); // Stop notes when opening a menu
        }
    };

    trigger.addEventListener('click', toggle);

    optionElements.forEach(opt => {
        opt.addEventListener('click', () => {
            const val = opt.dataset.value;
            trigger.textContent = opt.textContent;

            optionElements.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');

            options.classList.remove('open');
            onSelect(val);
        });
    });

    // Close on click outside
    window.addEventListener('click', () => {
        options.classList.remove('open');
    });
}


// ─── Filter Controls ─────────────────────────────────
function setupFilter() {
    const cutoffSl = document.getElementById('cutoffSlider');
    const resonanceSl = document.getElementById('resonanceSlider');

    const cutoffVal = document.getElementById('cutoffValue');
    const resonanceVal = document.getElementById('resonanceValue');

    const updateFilter = () => {
        filterSettings.cutoff = parseFloat(cutoffSl.value);
        filterSettings.resonance = parseFloat(resonanceSl.value);

        if (filterNode) {
            const ctx = ensureAudioCtx();
            const now = ctx.currentTime;

            filterNode.type = filterSettings.type;
            if (filterBaseGain) {
                filterBaseGain.gain.setTargetAtTime(filterSettings.cutoff, now, 0.02);
            }
            filterNode.Q.setTargetAtTime(filterSettings.resonance, now, 0.02);
        }

        cutoffVal.textContent = Math.round(filterSettings.cutoff) + 'Hz';
        resonanceVal.textContent = filterSettings.resonance.toFixed(1);

        [cutoffSl, resonanceSl].forEach(sl => {
            const pct = ((sl.value - sl.min) / (sl.max - sl.min)) * 100;
            sl.style.background = `linear-gradient(to right, #00d4ff ${pct}%, #2d343e ${pct}%)`;
        });
    };

    initCustomSelect('filterTypeContainer', 'filterTypeTrigger', 'filterTypeOptions', (val) => {
        filterSettings.type = val;
        updateFilter();
    });

    [cutoffSl, resonanceSl].forEach(el => {
        el.addEventListener('input', updateFilter);
        el.addEventListener('mouseup', () => el.blur());
    });

    updateFilter();
}

// ─── Vibrato & Tremolo Controls ──────────────────────
function setupFX() {
    const vRate = document.getElementById('vibratoRate');
    const vDepth = document.getElementById('vibratoDepth');
    const tRate = document.getElementById('tremoloRate');
    const tDepth = document.getElementById('tremoloDepth');
    const fRate = document.getElementById('filterLFORate');
    const fDepth = document.getElementById('filterLFODepth');

    const vRateVal = document.getElementById('vibratoRateValue');
    const vDepthVal = document.getElementById('vibratoDepthValue');
    const tRateVal = document.getElementById('tremoloRateValue');
    const tDepthVal = document.getElementById('tremoloDepthValue');
    const fRateVal = document.getElementById('filterLFORateValue');
    const fDepthVal = document.getElementById('filterLFODepthValue');

    const updateFX = () => {
        vibratoVal.rate = parseFloat(vRate.value);
        vibratoVal.depth = parseFloat(vDepth.value) / 100;
        tremoloVal.rate = parseFloat(tRate.value);
        tremoloVal.depth = parseFloat(tDepth.value) / 100;
        // filterLFOVal.type is updated via custom select
        filterLFOVal.rate = parseFloat(fRate.value);
        filterLFOVal.depth = parseFloat(fDepth.value);

        vRateVal.textContent = vibratoVal.rate.toFixed(1) + 'Hz';
        vDepthVal.textContent = Math.round(vibratoVal.depth * 100) + '%';
        tRateVal.textContent = tremoloVal.rate.toFixed(1) + 'Hz';
        tDepthVal.textContent = Math.round(tremoloVal.depth * 100) + '%';
        fRateVal.textContent = filterLFOVal.rate.toFixed(1) + 'Hz';
        fDepthVal.textContent = Math.round(filterLFOVal.depth * 100) + '%';

        const ctx = ensureAudioCtx();
        const now = ctx.currentTime;

        if (vibratoLfo && vibratoGain) {
            vibratoLfo.frequency.setTargetAtTime(vibratoVal.rate, now, 0.05);
            vibratoGain.gain.setTargetAtTime(vibratoVal.depth * 50, now, 0.05);
        }

        if (tremoloLfo && tremoloMod) {
            tremoloLfo.frequency.setTargetAtTime(tremoloVal.rate, now, 0.05);
            tremoloMod.gain.setTargetAtTime(tremoloVal.depth, now, 0.05);
        }

        if (filterLfo && filterMod && filterModSource) {
            if (filterLFOVal.type === 'random') {
                filterLfo.frequency.setTargetAtTime(0.001, now, 0.05);
                if (!filterRandomInterval || filterLFOVal.lastRate !== filterLFOVal.rate) {
                    clearInterval(filterRandomInterval);
                    filterRandomInterval = setInterval(() => {
                        filterRandomValue = (Math.random() * 2 - 1);
                        const then = ctx.currentTime;
                        filterModSource.offset.setTargetAtTime(1.0 + filterRandomValue, then, 0.01);
                    }, 1000 / filterLFOVal.rate);
                    filterLFOVal.lastRate = filterLFOVal.rate;
                }
            } else {
                clearInterval(filterRandomInterval);
                filterRandomInterval = null;
                filterModSource.offset.setTargetAtTime(1.0, now, 0.05);
                filterLfo.type = filterLFOVal.type;
                filterLfo.frequency.setTargetAtTime(filterLFOVal.rate, now, 0.05);
            }
            filterMod.gain.setTargetAtTime(filterLFOVal.depth, now, 0.05);
        }

        [vRate, vDepth, tRate, tDepth, fRate, fDepth].forEach(sl => {
            const pct = ((sl.value - sl.min) / (sl.max - sl.min)) * 100;
            sl.style.background = `linear-gradient(to right, #00d4ff ${pct}%, #2d343e ${pct}%)`;
        });
    };

    initCustomSelect('filterLFOTypeContainer', 'filterLFOTypeTrigger', 'filterLFOTypeOptions', (val) => {
        filterLFOVal.type = val;
        updateFX();
    });

    [vRate, vDepth, tRate, tDepth, fRate, fDepth].forEach(sl => {
        sl.addEventListener('input', updateFX);
        sl.addEventListener('mouseup', () => sl.blur());
    });

    updateFX();
}



// ─── Waveform Visualizer ─────────────────────────────
function startWaveformLoop() {
    const canvas = document.getElementById('waveformCanvas');
    const ctx = canvas.getContext('2d');

    function draw() {
        requestAnimationFrame(draw);

        // Resize canvas to container
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * 2;
        canvas.height = (rect.height - 40) * 2; // minus header
        ctx.scale(2, 2);
        const w = rect.width;
        const h = rect.height - 40;

        ctx.clearRect(0, 0, w, h);

        // Grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        for (let y = 0; y < h; y += 20) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        // Center line
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        if (!analyserNode) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            return;
        }

        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        analyserNode.getFloatTimeDomainData(dataArray);

        // Draw waveform
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, '#7c3aed');
        grad.addColorStop(0.5, '#00d4ff');
        grad.addColorStop(1, '#7c3aed');

        ctx.beginPath();
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';

        const sliceWidth = w / bufferLength;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i];
            const y = (1 - v) * h / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.stroke();

        // Glow effect
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.15)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i];
            const y = (1 - v) * h / 2;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            x += sliceWidth;
        }
        ctx.stroke();

        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    draw();
}

// ─── Master Volume ───────────────────────────────────
function setupMasterVolume() {
    const slider = document.getElementById('masterVolume');
    const display = document.getElementById('masterVolumeValue');

    slider.addEventListener('input', () => {
        masterGain = parseFloat(slider.value);
        display.textContent = Math.round(masterGain * 100) + '%';
        if (outputGainNode) {
            outputGainNode.gain.setValueAtTime(masterGain, audioCtx.currentTime);
        }
    });
}

// ─── Octave Buttons ──────────────────────────────────
function setupOctaveButtons() {
    document.getElementById('octaveDownBtn').addEventListener('click', () => setOctave(currentOctave - 1));
    document.getElementById('octaveUpBtn').addEventListener('click', () => setOctave(currentOctave + 1));
}

// ─── Preset Buttons ─────────────────────────────────
function setupPresetButtons() {
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });
}

// ═══ INIT ════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => { //when the dom is loaded
    buildHarmonicsUI();
    setupADSR();
    setupADSRCanvasInteraction();
    setupMasterVolume();
    setupOctaveButtons();
    setupPresetButtons();
    setupFilter();
    setupFX();
    startWaveformLoop();

    // Apply sine preset as default
    applyPreset('sine');

    // === AUTOMATION CLIP CREATION HOOK (Scans all the elements to hook automation) ===
    document.querySelectorAll('input[type="range"]').forEach(knob => {
        knob.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            let paramName = knob.id || '';
            const prev = knob.previousElementSibling;
            if (prev && prev.tagName === 'LABEL') {
                paramName = prev.innerText;
            } else if (knob.parentNode.querySelector('.label')) {
                paramName = knob.parentNode.querySelector('.label').innerText;
            } else if (prev && prev.classList.contains('harmonic-label')) {
                paramName = `Harmonic ${prev.textContent}`;
            }

            const paramId = knob.id || `slider_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            if (!knob.id) knob.id = paramId;

            window.parent.postMessage({
                type: 'create-automation',
                paramId: paramId,
                paramName: paramName || paramId,
                min: parseFloat(knob.min) || 0,
                max: parseFloat(knob.max) || 100
            }, '*');
        });
    });
});

window.addEventListener('message', e => {
    // Other handlers like note-on, note-off are processed at global level.
    if (e.data && e.data.type === 'automation-update') {
        const slider = document.getElementById(e.data.paramId);
        if (slider) {
            const min = parseFloat(slider.min) || 0;
            const max = parseFloat(slider.max) || 100;
            const absoluteVal = min + (max - min) * e.data.valuePct;
            slider.value = absoluteVal;
            slider.dispatchEvent(new Event('input')); // Innesca la logica del synth
        }
    }
});

// --- STATE MANAGEMENT FOR DAW SAVING/LOADING ---
window.getInstrumentState = function () {  //public function ---> the parent can use it
    return {
        adsr,
        filterSettings,
        vibratoVal,
        tremoloVal,
        filterLFOVal,
        harmonicAmplitudes: Array.from(harmonicAmplitudes),
        currentOctave,
        masterGain,
        currentPreset // new state property
    };
};

window.setInstrumentState = function (state) {
    if (!state) return;
    if (state.adsr) Object.assign(adsr, state.adsr);
    if (state.filterSettings) Object.assign(filterSettings, state.filterSettings);
    if (state.vibratoVal) Object.assign(vibratoVal, state.vibratoVal);
    if (state.tremoloVal) Object.assign(tremoloVal, state.tremoloVal);
    if (state.filterLFOVal) Object.assign(filterLFOVal, state.filterLFOVal);

    // reset the graphic setting of the preset if present
    if (state.currentPreset) {
        currentPreset = state.currentPreset;
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.preset === currentPreset);
        });
    }

    if (state.harmonicAmplitudes) {
        state.harmonicAmplitudes.forEach((val, i) => {
            if (i < NUM_HARMONICS) harmonicAmplitudes[i] = val;
        });
    }
    if (state.currentOctave !== undefined) {
        currentOctave = state.currentOctave;
        const octDisplay = document.getElementById('octaveValue');
        if (octDisplay) octDisplay.textContent = currentOctave;
    }
    if (state.masterGain !== undefined) {
        masterGain = state.masterGain;
        const slider = document.getElementById('masterVolume');
        const display = document.getElementById('masterVolumeValue');
        if (slider) slider.value = masterGain;
        if (display) display.textContent = Math.round(masterGain * 100) + '%';
        if (typeof outputGainNode !== 'undefined' && outputGainNode) {
            outputGainNode.gain.setValueAtTime(masterGain, audioCtx.currentTime);
        }
    }

    // Update simple inputs 
    const setValOnly = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };

    setValOnly('attackSlider', adsr.attack);
    setValOnly('decaySlider', adsr.decay);
    setValOnly('sustainSlider', adsr.sustain);
    setValOnly('releaseSlider', adsr.release);

    setValOnly('cutoffSlider', filterSettings.cutoff);
    setValOnly('resonanceSlider', filterSettings.resonance);

    setValOnly('vibratoRate', vibratoVal.rate);
    setValOnly('vibratoDepth', vibratoVal.depth * 100);
    setValOnly('tremoloRate', tremoloVal.rate);
    setValOnly('tremoloDepth', tremoloVal.depth * 100);
    setValOnly('filterLFORate', filterLFOVal.rate);
    setValOnly('filterLFODepth', filterLFOVal.depth);

    // Trigger one event per logic group to commit to DOM + UI texts, now that all values in the group are primed
    const trigger = (id) => {
        const el = document.getElementById(id);
        if (el) el.dispatchEvent(new Event('input'));
    };

    trigger('attackSlider'); // Updates ADSR logic
    trigger('cutoffSlider'); // Updates Filter logic
    trigger('vibratoRate'); // Updates FX logic

    // Refresh filter type options
    const fTrigger = document.getElementById('filterTypeTrigger');
    const fOptionsContainer = document.getElementById('filterTypeOptions');
    if (fTrigger && fOptionsContainer) {
        const options = fOptionsContainer.querySelectorAll('.custom-option');
        options.forEach(opt => {
            if (opt.dataset.value === filterSettings.type) {
                opt.classList.add('selected');
                fTrigger.textContent = opt.textContent;
            } else {
                opt.classList.remove('selected');
            }
        });
    }

    // Refresh LFO type options
    const lTrigger = document.getElementById('filterLFOTypeTrigger');
    const lOptionsContainer = document.getElementById('filterLFOTypeOptions');
    if (lTrigger && lOptionsContainer) {
        const options = lOptionsContainer.querySelectorAll('.custom-option');
        options.forEach(opt => {
            if (opt.dataset.value === filterLFOVal.type) {
                opt.classList.add('selected');
                lTrigger.textContent = opt.textContent;
            } else {
                opt.classList.remove('selected');
            }
        });
    }

    if (typeof buildHarmonicsUI === 'function') {
        buildHarmonicsUI();
    }
};

// ─── Cleanup on unload (prevents zombie oscillators on project reload) ───
window.addEventListener('unload', () => { //when the iframe is removed
    stopAllNotes();
    try { if (vibratoLfo) { vibratoLfo.stop(); vibratoLfo.disconnect(); } } catch (e) { }
    try { if (tremoloLfo) { tremoloLfo.stop(); tremoloLfo.disconnect(); } } catch (e) { }
    try { if (filterLfo) { filterLfo.stop(); filterLfo.disconnect(); } } catch (e) { }
    try { if (filterModSource) { filterModSource.stop(); filterModSource.disconnect(); } } catch (e) { }
    try { if (preGainNode) preGainNode.disconnect(); } catch (e) { }
    try { if (outputGainNode) outputGainNode.disconnect(); } catch (e) { }
});
