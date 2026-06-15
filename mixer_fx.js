// mixer_fx.js
function createMixerFX(audioCtx, subIndex = undefined) { //subindex --> index of the track the mixer belongs to
    if (!audioCtx) return null;
    const input = audioCtx.createGain(); //zero gain node (summing junction for multiple voices)
    const trackVolume = audioCtx.createGain();

    // TRACK EQ
    const trackEqLow = audioCtx.createBiquadFilter();
    trackEqLow.type = 'lowshelf';
    trackEqLow.frequency.value = 250;
    trackEqLow.gain.value = 0;

    const trackEqMid = audioCtx.createBiquadFilter();
    trackEqMid.type = 'peaking';
    trackEqMid.frequency.value = 1000;
    trackEqMid.Q.value = 1.0;
    trackEqMid.gain.value = 0;

    const trackEqHigh = audioCtx.createBiquadFilter();
    trackEqHigh.type = 'highshelf';
    trackEqHigh.frequency.value = 4000;
    trackEqHigh.gain.value = 0;

    input.connect(trackEqLow);
    trackEqLow.connect(trackEqMid);
    trackEqMid.connect(trackEqHigh);
    const trackEqOut = trackEqHigh;

    // PANNER
    const trackPanner = audioCtx.createStereoPanner();
    trackPanner.pan.value = 0;
    trackEqOut.connect(trackPanner);
    const trackPanOut = trackPanner;

    // === TRACK REVERB (LAZY — created on demand) ===
    let trackReverb = null;
    let trackReverbWet = null;
    let trackReverbIR = null; // shared IR buffer
    let trackReverbConnected = false;

    function getTrackIR() {
        if (!trackReverbIR) {
            const len = audioCtx.sampleRate * 2.5;
            trackReverbIR = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
            for (let c = 0; c < 2; c++) {
                const cd = trackReverbIR.getChannelData(c);
                for (let i = 0; i < len; i++) cd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
            }
        }
        return trackReverbIR;
    }

    function connectTrackReverb() {  //called in minidaw.js when reverb knob is clicked (lazy initialization)
        if (trackReverbConnected) return;
        if (!trackReverb) {
            trackReverb = audioCtx.createConvolver();
            trackReverb.buffer = getTrackIR(); //fill the buffer with our simple IR
            trackReverbWet = audioCtx.createGain();
            trackReverbWet.gain.value = 0;
            trackReverb.connect(trackReverbWet);
            trackReverbWet.connect(trackVolume);
        }
        trackPanOut.connect(trackReverb);
        trackReverbConnected = true;
    }

    function disconnectTrackReverb() {  //called in minidaw.js when reverb knob goes to zero (convolution stops, saving cpu)
        if (!trackReverbConnected || !trackReverb) return;
        try { trackPanOut.disconnect(trackReverb); } catch (e) { }
        trackReverbConnected = false;
    }

    // === TRACK DELAY (LAZY — created on demand) ===
    let trackDelay = null;
    let trackFeedback = null;
    let trackDelayWet = null;
    let trackDelayConnected = false;

    function connectTrackDelay() {
        if (trackDelayConnected) return;
        if (!trackDelay) {
            trackDelay = audioCtx.createDelay();
            trackDelay.delayTime.value = 0.3;
            trackFeedback = audioCtx.createGain();
            trackFeedback.gain.value = 0.3;
            trackDelayWet = audioCtx.createGain();
            trackDelayWet.gain.value = 0;
            trackDelay.connect(trackFeedback);
            trackFeedback.connect(trackDelay);
            trackDelay.connect(trackDelayWet);
            trackDelayWet.connect(trackVolume);
        }
        trackPanOut.connect(trackDelay);
        trackDelayConnected = true;
    }

    function disconnectTrackDelay() {
        if (!trackDelayConnected || !trackDelay) return;
        try { trackPanOut.disconnect(trackDelay); } catch (e) { }
        trackDelayConnected = false;
    }

    trackPanOut.connect(trackVolume); // Dry Signal

    // === MASTER REVERB (LAZY) ===
    let masterReverb = null;
    let masterReverbWet = null;
    let masterReverbConnected = false;

    function connectMasterReverb() {
        if (masterReverbConnected) return;
        if (!masterReverb) {
            masterReverb = audioCtx.createConvolver();
            masterReverb.buffer = getTrackIR();
            masterReverbWet = audioCtx.createGain();
            masterReverbWet.gain.value = 0;
            masterReverb.connect(masterReverbWet);
            masterReverbWet.connect(masterEqLow); //Master reverb -> Master EQ
        }
        trackVolume.connect(masterReverb);
        masterReverbConnected = true;
    }

    function disconnectMasterReverb() {
        if (!masterReverbConnected || !masterReverb) return;
        try { trackVolume.disconnect(masterReverb); } catch (e) { }
        masterReverbConnected = false;
    }

    // === MASTER DELAY (LAZY) ===
    let masterDelay = null;
    let masterFeedback = null;
    let masterDelayWet = null;
    let masterDelayConnected = false;

    function connectMasterDelay() {
        if (masterDelayConnected) return;
        if (!masterDelay) {
            masterDelay = audioCtx.createDelay();
            masterDelay.delayTime.value = 0.3;
            masterFeedback = audioCtx.createGain();
            masterFeedback.gain.value = 0.3;
            masterDelayWet = audioCtx.createGain();
            masterDelayWet.gain.value = 0;
            masterDelay.connect(masterFeedback);
            masterFeedback.connect(masterDelay);
            masterDelay.connect(masterDelayWet);
            masterDelayWet.connect(masterEqLow);
        }
        trackVolume.connect(masterDelay);
        masterDelayConnected = true;
    }

    function disconnectMasterDelay() {
        if (!masterDelayConnected || !masterDelay) return;
        try { trackVolume.disconnect(masterDelay); } catch (e) { }
        masterDelayConnected = false;
    }

    const masterVolume = audioCtx.createGain();

    // MASTER EQ
    const masterEqLow = audioCtx.createBiquadFilter();
    masterEqLow.type = 'lowshelf';
    masterEqLow.frequency.value = 250;
    masterEqLow.gain.value = 0;

    const masterEqMid = audioCtx.createBiquadFilter();
    masterEqMid.type = 'peaking';
    masterEqMid.frequency.value = 1000;
    masterEqMid.Q.value = 1.0;
    masterEqMid.gain.value = 0;

    const masterEqHigh = audioCtx.createBiquadFilter();
    masterEqHigh.type = 'highshelf';
    masterEqHigh.frequency.value = 4000;
    masterEqHigh.gain.value = 0;

    // Dry signal into master EQ
    trackVolume.connect(masterEqLow);

    masterEqLow.connect(masterEqMid);
    masterEqMid.connect(masterEqHigh);
    masterEqHigh.connect(masterVolume);

    // MASTER LIMITER
    const masterLimiter = audioCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -0.5;
    masterLimiter.knee.value = 0.0;
    masterLimiter.ratio.value = 20.0;
    masterLimiter.attack.value = 0.005;
    masterLimiter.release.value = 0.050;

    let limiterEnabled = false;

    // OUTPUT BUS
    const masterOut = audioCtx.createGain();
    masterVolume.connect(masterOut);

    if (window.parent && window.parent.masterRecordingBus && window.parent.masterAudioCtx === audioCtx) {
        masterOut.connect(window.parent.masterRecordingBus);
    } else {
        masterOut.connect(audioCtx.destination);
    }

    // ANALYSERS FOR METERS & SPECTRUM
    const trackAnalyser = audioCtx.createAnalyser();
    trackAnalyser.fftSize = 2048;
    trackVolume.connect(trackAnalyser);

    const masterAnalyser = audioCtx.createAnalyser();
    masterAnalyser.fftSize = 2048;
    masterOut.connect(masterAnalyser);

    const trackDataArray = new Float32Array(trackAnalyser.frequencyBinCount);
    const masterDataArray = new Float32Array(masterAnalyser.frequencyBinCount);

    const trackFreqArray = new Uint8Array(trackAnalyser.frequencyBinCount);
    const masterFreqArray = new Uint8Array(masterAnalyser.frequencyBinCount);
    let sendSpectrum = false;

    let isLooping = true;

    //Message sender
    function renderLoop() {  //send UI data to minidaw.js to update meters and spectrum
        if (!isLooping) return;

        trackAnalyser.getFloatTimeDomainData(trackDataArray); //track peak level
        let maxPeak = 0;
        for (let i = 0; i < trackDataArray.length; i++) {
            if (Math.abs(trackDataArray[i]) > maxPeak) maxPeak = Math.abs(trackDataArray[i]);
        }

        masterAnalyser.getFloatTimeDomainData(masterDataArray);
        let mMaxPeak = 0;
        for (let i = 0; i < masterDataArray.length; i++) {
            if (Math.abs(masterDataArray[i]) > mMaxPeak) mMaxPeak = Math.abs(masterDataArray[i]);
        }

        let msg = {
            type: 'meter-update',
            subIndex: subIndex,
            trackPeak: maxPeak,
            masterPeak: mMaxPeak
        };

        if (sendSpectrum) {
            trackAnalyser.getByteFrequencyData(trackFreqArray);
            masterAnalyser.getByteFrequencyData(masterFreqArray);
            msg.trackSpectrum = trackFreqArray;
            msg.masterSpectrum = masterFreqArray;
        }

        if (window.parent) {
            window.parent.postMessage(msg, '*');
        }

        requestAnimationFrame(renderLoop);
    }

    requestAnimationFrame(renderLoop);

    // Setup message listener
    const messageListener = (event) => {
        const data = event.data;
        if (!data) return;

        if (subIndex !== undefined && data.subIndex !== undefined && data.subIndex !== subIndex) {
            // ignore messages for other tracks
        } else {
            if (data.type === 'set-mixer-volume') {
                trackVolume.gain.value = data.volume;
            } else if (data.type === 'set-mixer-pan') {
                trackPanner.pan.value = Math.max(-1, Math.min(1, data.pan));
            } else if (data.type === 'set-mixer-fx') {
                if (data.fx === 'reverb') {
                    const val = data.value;
                    if (val > 0) {
                        connectTrackReverb();
                        trackReverbWet.gain.value = val;
                    } else {
                        disconnectTrackReverb();
                        if (trackReverbWet) trackReverbWet.gain.value = 0;
                    }
                }
                if (data.fx === 'delay') {
                    const val = data.value;
                    if (val > 0) {
                        connectTrackDelay();
                        trackDelayWet.gain.value = val;
                    } else {
                        disconnectTrackDelay();
                        if (trackDelayWet) trackDelayWet.gain.value = 0;
                    }
                }
                if (data.fx === 'eqLow') trackEqLow.gain.value = data.value;
                if (data.fx === 'eqLowFreq') trackEqLow.frequency.value = data.value;
                if (data.fx === 'eqMid') trackEqMid.gain.value = data.value;
                if (data.fx === 'eqMidFreq') trackEqMid.frequency.value = data.value;
                if (data.fx === 'eqMidQ') trackEqMid.Q.value = data.value;
                if (data.fx === 'eqHigh') trackEqHigh.gain.value = data.value;
                if (data.fx === 'eqHighFreq') trackEqHigh.frequency.value = data.value;
            }
        }

        // Master FX applies to everything
        if (data.type === 'set-master-volume') {
            masterVolume.gain.value = data.volume;
        } else if (data.type === 'set-master-fx') {
            if (data.fx === 'reverb') {
                const val = data.value;
                if (val > 0) {
                    connectMasterReverb();
                    masterReverbWet.gain.value = val;
                } else {
                    disconnectMasterReverb();
                    if (masterReverbWet) masterReverbWet.gain.value = 0;
                }
            }
            if (data.fx === 'delay') {
                const val = data.value;
                if (val > 0) {
                    connectMasterDelay();
                    masterDelayWet.gain.value = val;
                } else {
                    disconnectMasterDelay();
                    if (masterDelayWet) masterDelayWet.gain.value = 0;
                }
            }
            if (data.fx === 'eqLow') masterEqLow.gain.value = data.value;
            if (data.fx === 'eqLowFreq') masterEqLow.frequency.value = data.value;
            if (data.fx === 'eqMid') masterEqMid.gain.value = data.value;
            if (data.fx === 'eqMidFreq') masterEqMid.frequency.value = data.value;
            if (data.fx === 'eqMidQ') masterEqMid.Q.value = data.value;
            if (data.fx === 'eqHigh') masterEqHigh.gain.value = data.value;
            if (data.fx === 'eqHighFreq') masterEqHigh.frequency.value = data.value;
        } else if (data.type === 'set-master-limiter') {
            limiterEnabled = data.active;
            masterVolume.disconnect();
            if (limiterEnabled) {
                masterVolume.connect(masterLimiter);
                masterLimiter.connect(masterOut);
            } else {
                try { masterLimiter.disconnect(); } catch (e) { }
                masterVolume.connect(masterOut);
            }
        }
        if (data.type === 'toggle-spectrum') {
            sendSpectrum = data.active;
        }
    };

    window.addEventListener('message', messageListener);

    input.destroyFX = () => {   //method assigned as an object property in minidaw.js, to be called when track is deleted from the tracklist
        isLooping = false;
        window.removeEventListener('message', messageListener);
        trackVolume.disconnect();
        masterVolume.disconnect();
        try { masterOut.disconnect(); } catch (e) { }
        // Disconnect lazy FX
        disconnectTrackReverb();
        disconnectTrackDelay();
        disconnectMasterReverb();
        disconnectMasterDelay();
    };

    window.addEventListener('unload', input.destroyFX); //when a track is deleted in minidaw

    return input;
}

window.createMixerFX = createMixerFX;

