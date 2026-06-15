document.addEventListener('DOMContentLoaded', () => {
    let isInitialized = false;
    let masterVolume = null;

    let originalBuffer = null;
    let processedBuffer = null;

    let currentOctave = 4;
    const activeVoices = new Map();
    let latestVoiceKey = null;

    // Parametri UI
    let startPct = 0.0;
    let endPct = 1.0;
    let fadePct = 0.0;
    let isDraggingMarker = null;

    const adsr = { attack: 0.01, decay: 0.3, sustain: 1, release: 0.5 };

    const KEY_MAP = {
        'a': 0, 'w': 1, 's': 2, 'e': 3, 'd': 4, 'f': 5, 't': 6, 'g': 7,
        'y': 8, 'h': 9, 'u': 10, 'j': 11, 'k': 12, 'o': 13, 'l': 14, 'p': 15
    };

    // DOM Cache
    const dropZone = document.getElementById('waveform-display');
    const dropText = document.getElementById('drop-text');
    const regionOverlay = document.getElementById('region-overlay');
    const sampleInfo = document.getElementById('sample-info');
    const sampleName = document.getElementById('sample-name');
    const canvas = document.getElementById('wave-canvas');
    const ctx = canvas.getContext('2d');

    const startMarkerDOM = document.getElementById('start-marker');
    const endMarkerDOM = document.getElementById('end-marker');
    const fadeMarkerDOM = document.getElementById('fade-out-marker');
    const fadeVisualDOM = document.getElementById('fade-visual');
    const unselectedLeft = document.getElementById('unselected-left');
    const unselectedRight = document.getElementById('unselected-right');
    const playheadDOM = document.getElementById('playhead');

    const loopToggle = document.getElementById('loop-toggle');
    const warpToggle = document.getElementById('warp-toggle');

    let localCtx;
    let streamDest;
    let parentStreamSource;

    // ─── INITIALIZATION OF TONE.JS ───
    async function initTone() { //initTone won't load until Tone.start() finished to load. However, being async, minidaw continues to run. 
        if (!isInitialized) {
            localCtx = new (window.AudioContext || window.webkitAudioContext)();
            Tone.setContext(localCtx); //Tone.js own audio context
            await Tone.start();
            masterVolume = new Tone.Volume();

            // BRIDGE AUDIO: Iframe Context -> MediaStream -> Parent Context
            streamDest = localCtx.createMediaStreamDestination();
            masterVolume.connect(streamDest); //master volume to streamDest

            const parentCtx = (window.parent && window.parent.masterAudioCtx) ? window.parent.masterAudioCtx : null; //save the minidaw audio context in parentCtx
            if (parentCtx && window.createMixerFX) {
                parentStreamSource = parentCtx.createMediaStreamSource(streamDest.stream); //iframe audio to minidaw (an audio source is created that receive the audio stream from the iframe)
                parentStreamSource.connect(window.createMixerFX(parentCtx)); //from minidaw to the mixer
            } else {
                masterVolume.toDestination();  //standalone ( no minidaw)
            }

            const initVol = parseFloat(document.getElementById('volume').value);
            masterVolume.volume.value = initVol === 0 ? -100 : 20 * Math.log10(initVol);

            isInitialized = true;
            requestAnimationFrame(updatePlayhead); //fluid animation (instead of using "setInterval()")
        }
    }

    // ─── DRAG & DROP ───
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('drop', async (e) => { //async function when drop a file
        e.preventDefault(); //not open a file in a new tab
        dropZone.classList.remove('drag-over');

        try {
            await initTone();  //waiting for audio initialization before processing
        } catch (err) {
            console.error('[Sampler] initTone failed on drop', err); //limit the crash
        }

        const file = e.dataTransfer.files[0];  //dataTransfer is an object that contains the files that are being dragged (e is the event)
        if (file && (file.type.startsWith('audio/') || file.name.match(/\.(wav|mp3|ogg|flac|aiff|m4a)$/i))) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const rawCtx = Tone.context.rawContext;
                const decoded = await rawCtx.decodeAudioData(arrayBuffer);
                originalBuffer = new Tone.ToneAudioBuffer();
                originalBuffer._buffer = decoded;

                dropText.classList.add('hidden');
                sampleInfo.classList.remove('hidden');
                regionOverlay.classList.remove('hidden');
                sampleName.textContent = file.name;

                startPct = 0.0;
                endPct = 1.0;
                fadePct = 0.0;

                snapAndProcessBuffer();
            } catch (err) {
                console.error('[Sampler] Failed to decode dropped audio file:', err);
                alert("Errore nel caricamento del file audio. Controlla la console.");
            }
        }
    });

    // ─── LOGICA ZERO-CROSSING E PRE-PROCESSING AUDIO ───
    function getZeroCrossing(data, sampleRate, timeSec) { //useful to snap to zero-crossing in order to avoid clicks 
        let index = Math.floor(timeSec * sampleRate);
        const searchWindow = Math.floor(0.01 * sampleRate);
        let bestIndex = index;
        let minAmp = Infinity;

        let startSearch = Math.max(0, index - searchWindow);
        let endSearch = Math.min(data.length - 2, index + searchWindow);

        for (let i = startSearch; i <= endSearch; i++) {
            if (data[i] <= 0 && data[i + 1] > 0) {
                if (Math.abs(data[i]) < minAmp) { //find the optimal value (closest to 0)
                    minAmp = Math.abs(data[i]);
                    bestIndex = i;
                }
            }
        }
        return minAmp === Infinity ? index : bestIndex;
    }

    function snapAndProcessBuffer() {
        if (!originalBuffer) return;

        const data = originalBuffer.getChannelData(0);  //our sample window (it depends by our selection, using markers)
        const sr = originalBuffer.sampleRate;
        const dur = originalBuffer.duration;

        startPct = getZeroCrossing(data, sr, startPct * dur) / (dur * sr);
        endPct = getZeroCrossing(data, sr, endPct * dur) / (dur * sr);

        startPct = Math.max(0, Math.min(startPct, 0.99)); //to avoid errors (out of bounds)
        endPct = Math.max(startPct + 0.01, Math.min(endPct, 1.0));
        fadePct = Math.max(0, Math.min(fadePct, endPct - startPct));

        updateMarkersUI();

        const ctx = Tone.context;
        const audioBuf = ctx.rawContext.createBuffer(  //create a new buffer, don't touching originalBuffer. 
            originalBuffer.numberOfChannels,
            originalBuffer.length,
            originalBuffer.sampleRate
        );

        const endSample = Math.floor(endPct * dur * sr);
        const fadeSamples = Math.floor(fadePct * dur * sr);
        const startFadeSample = endSample - fadeSamples;

        for (let channel = 0; channel < originalBuffer.numberOfChannels; channel++) {
            const inData = originalBuffer.getChannelData(channel);
            const outData = audioBuf.getChannelData(channel);

            for (let i = 0; i < inData.length; i++) {
                if (i >= startFadeSample && i < endSample && fadeSamples > 0) {
                    const ratio = (i - startFadeSample) / fadeSamples;
                    const fadeMultiplier = Math.cos(ratio * Math.PI / 2);
                    outData[i] = inData[i] * fadeMultiplier;
                } else if (i >= endSample) {
                    outData[i] = 0;
                } else {
                    outData[i] = inData[i];
                }
            }
        }
        //We have a memory leakage(loosing reference of the previous preprocessed buffer), but it's resolved by the garbage collector.
        processedBuffer = new Tone.ToneAudioBuffer(); //create a Tone.js buffer object
        processedBuffer._buffer = audioBuf; //assign the Tone.js buffer object to the processedBuffer buffer
        drawWaveform();
    }

    // ─── LOGIC MARKERS UI ───
    dropZone.addEventListener('mousedown', (e) => { //detect if you have clicked on a marker
        if (!originalBuffer || !originalBuffer.loaded) return;
        const rect = dropZone.getBoundingClientRect();
        const clickPct = (e.clientX - rect.left) / rect.width;
        const fadeMarkerPos = endPct - fadePct;

        if (Math.abs(clickPct - fadeMarkerPos) < 0.04 && (e.clientY - rect.top) < 40) {
            isDraggingMarker = 'fade';
        } else if (Math.abs(clickPct - startPct) < 0.05) {
            isDraggingMarker = 'start';
        } else if (Math.abs(clickPct - endPct) < 0.05) {
            isDraggingMarker = 'end';
        }
    });

    window.addEventListener('mousemove', (e) => { //update the marker position moving the mouse
        if (!isDraggingMarker) return;
        const rect = dropZone.getBoundingClientRect();
        let movePct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

        if (isDraggingMarker === 'start') {
            startPct = Math.min(movePct, endPct - 0.01);
            if (endPct - fadePct < startPct) fadePct = endPct - startPct;
        } else if (isDraggingMarker === 'end') {
            endPct = Math.max(movePct, startPct + 0.01);
            if (endPct - fadePct < startPct) fadePct = endPct - startPct;
        } else if (isDraggingMarker === 'fade') {
            fadePct = endPct - movePct;
            fadePct = Math.max(0, Math.min(fadePct, endPct - startPct));
        }
        updateMarkersUI();
    });

    window.addEventListener('mouseup', () => {
        if (isDraggingMarker) {
            isDraggingMarker = null;
            snapAndProcessBuffer();
        }
    });

    function updateMarkersUI() {
        startMarkerDOM.style.left = `${startPct * 100}%`;
        endMarkerDOM.style.left = `${endPct * 100}%`;
        unselectedLeft.style.width = `${startPct * 100}%`;
        unselectedRight.style.width = `${(1 - endPct) * 100}%`;

        const fadePos = endPct - fadePct;
        fadeMarkerDOM.style.left = `${fadePos * 100}%`;
        fadeVisualDOM.style.left = `${fadePos * 100}%`;
        fadeVisualDOM.style.width = `${fadePct * 100}%`;
    }

    // ─── PLAYBACK AND TONE.JS ENGINE─── 
    async function noteOn(key, midiNote) {
        if (!processedBuffer || !processedBuffer.loaded || activeVoices.has(key)) return;

        try {
            await initTone();

            const rootNote = 60;
            const isLooping = loopToggle.checked;
            const isWarping = warpToggle.checked;

            const duration = originalBuffer.duration;
            const offsetTime = startPct * duration;
            const playDuration = (endPct - startPct) * duration;

            let player;
            let speedRate = 1;

            if (isWarping) {
                const cents = (midiNote - rootNote) * 100;
                player = new Tone.GrainPlayer({ //Warping
                    url: processedBuffer,
                    loop: isLooping,
                    loopStart: offsetTime,
                    loopEnd: offsetTime + playDuration,
                    detune: cents,
                    playbackRate: 1,
                    grainSize: 0.1,  //low values ---> less ringing on high freq.
                    overlap: 0.05
                });
            } else {
                const rate = Math.pow(Math.pow(2, 1 / 12), midiNote - rootNote); //higher notes respect to root note --> higher rate
                speedRate = rate;
                player = new Tone.Player({ //Resampling
                    url: processedBuffer,
                    loop: isLooping,
                    loopStart: offsetTime,
                    loopEnd: offsetTime + playDuration,
                    playbackRate: rate
                });
            }

            const env = new Tone.AmplitudeEnvelope({
                attack: adsr.attack,
                decay: adsr.decay,
                sustain: adsr.sustain,
                release: adsr.release
            }).connect(masterVolume);

            const sampleFadeNode = new Tone.Gain(1).connect(env);
            player.connect(sampleFadeNode);

            const voiceStartTime = Tone.now();

            const voiceObj = {
                player,
                env,
                sampleFadeNode,
                startTime: voiceStartTime,
                offsetTime,
                playDuration,
                speedRate,
                isLooping,
                fadeTimer: null
            };
            activeVoices.set(key, voiceObj);

            // --- SCHEDULE (ATTACK & FADE OUT AT EACH LOOP) ---
            if (isLooping) {
                const loopDuration = playDuration / speedRate;
                let boundaryCount = 1;

                const scheduleNextLoopDynamics = () => {
                    const voice = activeVoices.get(key);
                    if (!voice) return;

                    const now = Tone.now();
                    // Calculate where the next loop boundary (jump) will occur
                    let nextBoundary = voice.startTime + (boundaryCount * loopDuration);

                    while (nextBoundary < now + 2.0) {
                        if (nextBoundary > now) {
                            // Limit fades to 45% of the loop duration to avoid overlaps
                            const maxHalfLoop = loopDuration * 0.45;
                            const currentAttack = Math.min(Math.max(adsr.attack, 0.015), maxHalfLoop);

                            const rawFade = (fadePct * originalBuffer.duration) / speedRate;
                            const currentFade = Math.min(Math.max(rawFade, 0.015), maxHalfLoop);

                            const fadeStart = nextBoundary - currentFade;
                            const attackEnd = nextBoundary + currentAttack;

                            // 1. FADE OUT (Turning off volume at the end of the current cycle)
                            if (fadeStart >= now) {
                                voice.sampleFadeNode.gain.setValueAtTime(1, fadeStart);
                                voice.sampleFadeNode.gain.linearRampToValueAtTime(0, nextBoundary);
                            } else {
                                // If the browser lagged and we wake up in the middle of the fade
                                voice.sampleFadeNode.gain.setValueAtTime(voice.sampleFadeNode.gain.value, now);
                                voice.sampleFadeNode.gain.linearRampToValueAtTime(0, nextBoundary);
                            }

                            // 2. ATTACK (Turning volume back on at the start of the new cycle)
                            voice.sampleFadeNode.gain.setValueAtTime(0, nextBoundary);
                            voice.sampleFadeNode.gain.linearRampToValueAtTime(1, attackEnd);
                        }

                        boundaryCount++;
                        nextBoundary = voice.startTime + (boundaryCount * loopDuration);
                    }

                    voice.fadeTimer = setTimeout(scheduleNextLoopDynamics, 200);
                };

                scheduleNextLoopDynamics();
            }

            player.start(voiceStartTime, offsetTime);
            env.triggerAttack(voiceStartTime);

            latestVoiceKey = key;
        } catch (err) {
            console.error("[Sampler] Error during noteOn:", err);
        }
    }

    function noteOff(key) {
        const voice = activeVoices.get(key);
        if (!voice) return;

        if (voice.fadeTimer) {
            clearTimeout(voice.fadeTimer); //clear setTimeout in note on
        }

        voice.env.triggerRelease(Tone.now()); //trigger release on note off

        const releaseTimeSec = Tone.Time(adsr.release).toSeconds();
        voice.player.stop(`+${releaseTimeSec + 0.1}`);

        //free the memory (mandatory steps to activate the arrival of garbage collector)
        setTimeout(() => {
            voice.player.dispose();
            voice.env.dispose();
            voice.sampleFadeNode.dispose();
        }, (releaseTimeSec + 0.5) * 1000);

        activeVoices.delete(key);

        //update latest voice key
        if (latestVoiceKey === key) {
            latestVoiceKey = activeVoices.size > 0 ? Array.from(activeVoices.keys()).pop() : null;
        }
    }

    // --- ADDED FOR MINI DAW CONNECTION ---
    window.addEventListener('message', async (event) => {
        const { type, midi, key } = event.data;
        if (type === 'note-on') {
            noteOn(key || `remote_${midi}`, midi);
        } else if (type === 'note-off') {
            noteOff(key || `remote_${midi}`);
        } else if (type === 'stop-all') {
            activeVoices.forEach((voice, vKey) => {
                noteOff(vKey);
            });
        } else if (type === 'load-sample-buffer') {
            // File forwarded from parent DAW via postMessage (bypasses iframe drag&drop restriction)
            try {
                await initTone();
                const { buffer: arrayBuffer, name: fileName } = event.data;
                const rawCtx = Tone.context.rawContext;
                const decoded = await rawCtx.decodeAudioData(arrayBuffer);
                originalBuffer = new Tone.ToneAudioBuffer();
                originalBuffer._buffer = decoded;

                dropText.classList.add('hidden');
                sampleInfo.classList.remove('hidden');
                regionOverlay.classList.remove('hidden');
                sampleName.textContent = fileName || 'Sample';

                startPct = 0.0;
                endPct = 1.0;
                fadePct = 0.0;

                snapAndProcessBuffer();
            } catch (err) {
                console.error('[Sampler] Failed to load forwarded sample:', err);
            }
        }
    });

    // ─── PC KEYBOARD ───
    const pressedKeys = new Set();
    document.addEventListener('keydown', (e) => {
        if (e.repeat) return;
        const k = e.key.toLowerCase();
        if (k === 'z') { currentOctave = Math.max(0, currentOctave - 1); return; }
        if (k === 'x') { currentOctave = Math.min(8, currentOctave + 1); return; }
        if (KEY_MAP.hasOwnProperty(k) && !pressedKeys.has(k)) {
            pressedKeys.add(k);
            noteOn(k, (currentOctave + 1) * 12 + KEY_MAP[k]);
        }
    });

    document.addEventListener('keyup', (e) => {
        const k = e.key.toLowerCase();
        if (pressedKeys.has(k)) {
            pressedKeys.delete(k);
            noteOff(k);
        }
    });

    // ─── UI CONTROLS ───
    ['attack', 'decay', 'sustain', 'release'].forEach(param => {
        document.getElementById(param).addEventListener('input', (e) => adsr[param] = parseFloat(e.target.value));
    });

    document.getElementById('volume').addEventListener('input', (e) => {
        if (masterVolume) {
            const val = parseFloat(e.target.value);
            masterVolume.volume.value = val === 0 ? -100 : 20 * Math.log10(val);
        }
    });

    // ─── PLAYHEAD ANIMATION ───
    function updatePlayhead() {
        if (latestVoiceKey && activeVoices.has(latestVoiceKey) && originalBuffer && originalBuffer.loaded) {
            const voice = activeVoices.get(latestVoiceKey);
            const elapsed = Tone.now() - voice.startTime;

            let consumedAudio = elapsed * voice.speedRate;

            if (voice.isLooping && voice.playDuration > 0) {
                consumedAudio = consumedAudio % voice.playDuration;
            } else {
                consumedAudio = Math.min(consumedAudio, voice.playDuration);
            }

            const currentPos = voice.offsetTime + consumedAudio;
            const pct = currentPos / originalBuffer.duration;

            playheadDOM.style.left = `${pct * 100}%`;
            playheadDOM.classList.remove('hidden');
        } else {
            playheadDOM.classList.add('hidden');
        }
        requestAnimationFrame(updatePlayhead);
    }

    // ─── DRAW WAVEFORM ───
    function drawWaveform() {
        if (!originalBuffer || !originalBuffer.loaded) return;
        const rect = dropZone.getBoundingClientRect();
        canvas.width = rect.width * 2;
        canvas.height = rect.height * 2;
        ctx.scale(2, 2);

        const data = originalBuffer.getChannelData(0);
        const step = Math.ceil(data.length / rect.width);
        const amp = rect.height / 2;
        ctx.clearRect(0, 0, rect.width, rect.height);

        ctx.fillStyle = '#00d4ff';
        ctx.beginPath();
        for (let i = 0; i < rect.width; i++) {
            let min = 1.0, max = -1.0;
            for (let j = 0; j < step; j++) {
                const datum = data[(i * step) + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            ctx.fillRect(i, (1 + min) * amp, 1, Math.max(1, (max - min) * amp));
        }
    }
    window.addEventListener('resize', drawWaveform);

    // ─── SAVE / LOAD STATE ───
    window.getInstrumentState = function () {
        let serializedBuffer = null;
        if (originalBuffer && window.parent && window.parent.audioBufferToBase64) {
            const nativeBuffer = originalBuffer.get ? originalBuffer.get() : originalBuffer;
            serializedBuffer = window.parent.audioBufferToBase64(nativeBuffer);
        }

        return {
            sampleName: sampleName.textContent,
            buffer: serializedBuffer,
            currentOctave: currentOctave,
            startPct: startPct,
            endPct: endPct,
            fadePct: fadePct,
            adsr: { ...adsr },
            isLooping: loopToggle.checked,
            isWarping: warpToggle.checked,
            volume: parseFloat(document.getElementById('volume').value)
        };
    };

    window.setInstrumentState = async function (state) {
        if (!state) return;

        if (state.sampleName && state.sampleName !== "Nessun campione caricato") {
            sampleName.textContent = state.sampleName;
            dropText.classList.add('hidden');
            sampleInfo.classList.remove('hidden');
            regionOverlay.classList.remove('hidden');
        }

        if (state.currentOctave !== undefined) currentOctave = state.currentOctave;
        if (state.startPct !== undefined) startPct = state.startPct;
        if (state.endPct !== undefined) endPct = state.endPct;
        if (state.fadePct !== undefined) fadePct = state.fadePct;
        if (state.adsr) {
            adsr.attack = state.adsr.attack;
            adsr.decay = state.adsr.decay;
            adsr.sustain = state.adsr.sustain;
            adsr.release = state.adsr.release;

            const updateKnob = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = val;
            };
            updateKnob('attack', adsr.attack);
            updateKnob('decay', adsr.decay);
            updateKnob('sustain', adsr.sustain);
            updateKnob('release', adsr.release);
        }

        if (state.isLooping !== undefined) loopToggle.checked = state.isLooping;
        if (state.isWarping !== undefined) warpToggle.checked = state.isWarping;
        if (state.volume !== undefined) {
            const volKnob = document.getElementById('volume');
            if (volKnob) volKnob.value = state.volume;
            if (masterVolume) {
                masterVolume.volume.value = state.volume === 0 ? -100 : 20 * Math.log10(state.volume);
            }
        }

        if (state.buffer) { //the audio buffer injetted by minidaw
            try {
                await initTone();
                let nativeBuffer;
                if (typeof state.buffer === "string" && window.parent && window.parent.base64ToAudioBuffer) {
                    nativeBuffer = await window.parent.base64ToAudioBuffer(state.buffer, Tone.context.rawContext);
                } else {
                    nativeBuffer = state.buffer;
                }
                originalBuffer = new Tone.ToneAudioBuffer();
                originalBuffer._buffer = nativeBuffer;
                snapAndProcessBuffer();
            } catch (e) {
                console.error('Error decoding sampler buffer', e);
            }
        }
    };
});