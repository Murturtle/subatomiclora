import WebBleConnection from "./src/connection/web_ble_connection.js";
import Constants from "./src/constants.js";

// --- Global State ---
let connection = null;
let publicChannel = null;
let mediaRecorder;
let chunks = [];
let lastEncodedBuffer = null;
const reassemblyBuffer = {}; 

// --- UI Elements ---
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const transmitBtn = document.getElementById('transmit-btn');
const bleBtn = document.getElementById('ble-connect-btn');
const bleStatus = document.getElementById('ble-status');
const modeSelect = document.getElementById('mode-select');
const outputText = document.getElementById('output-text');
const decodeInput = document.getElementById('decode-input');
const decodeBtn = document.getElementById('decode-btn');

// --- 1. BLE & MeshCore Initialization ---
async function initBLE() {
    try {
        bleStatus.innerText = "Status: Connecting...";
        connection = await WebBleConnection.open();

        connection.on("connected", async () => {
            bleStatus.innerText = "Status: Connected";
            bleBtn.innerText = "Disconnect BLE";
            const channels = await connection.getChannels();
            publicChannel = channels.find(c => c.name === "#hehe");
        });

        connection.on("message", async (msg) => {
            if (msg.channelIdx === publicChannel?.channelIdx) {
                await handleIncomingVoiceData(msg.text);
            }
        });

        connection.on("disconnected", () => {
            bleStatus.innerText = "Status: Disconnected";
            bleBtn.innerText = "Connect BLE";
            connection = null;
        });
    } catch (err) { console.error(err); }
}

// --- 2. Transmission (Chunking) with 1500ms Delay ---
async function sendVoiceInChunks(encodedData) {
    if (!connection || !publicChannel) return;

    const dataArray = new Uint8Array(encodedData);
    // Base64 expands 3 bytes into 4 chars. 
    // 60 binary bytes becomes 80 Base64 chars.
    const CHUNK_SIZE = 60; 
    const msgId = Math.floor(Math.random() * 65535);
    const totalChunks = Math.ceil(dataArray.length / CHUNK_SIZE);
    const recvLog = document.getElementById('recv-log');

    for (let i = 0; i < totalChunks; i++) {
        const slice = dataArray.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        
        // Native btoa requires a string, so we convert Uint8Array to string first
        const base64Data = btoa(String.fromCharCode.apply(null, slice));

        const payload = JSON.stringify({ 
            id: msgId, 
            c: i, 
            t: totalChunks, 
            d: base64Data 
        });

        if (recvLog) recvLog.innerText = `Transmitting ${i + 1}/${totalChunks}...`;

        try {
            await connection.sendChannelTextMessage(publicChannel.channelIdx, payload);
            await new Promise(r => setTimeout(r, 1500)); 
        } catch (err) {
            console.error(err);
            break;
        }
    }
    if (recvLog) recvLog.innerText = "Transmission complete.";
}

// --- 3. Recording & Encoding ---
startBtn.onclick = async () => {
    chunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks);
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        const offline = new OfflineAudioContext(1, decoded.duration * 8000, 8000);
        const src = offline.createBufferSource();
        src.buffer = decoded; src.connect(offline.destination); src.start();
        const resampled = await offline.startRendering();
        const floatData = resampled.getChannelData(0);
        const int16 = new Int16Array(floatData.length);
        for(let i=0; i<floatData.length; i++) {
            const s = Math.max(-1, Math.min(1, floatData[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const encoded = await runEncode(modeSelect.value, int16.buffer);
        lastEncodedBuffer = encoded;
        
        // Update UI with full base64 string
        outputText.value = btoa(String.fromCharCode.apply(null, new Uint8Array(encoded)));
        
        transmitBtn.disabled = false;
        document.getElementById('preview-container').classList.remove('hidden');
        document.getElementById('audio-preview').src = URL.createObjectURL(blob);
        audioCtx.close();
    };
    mediaRecorder.start();
    startBtn.disabled = true; stopBtn.disabled = false;
};

stopBtn.onclick = () => {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    startBtn.disabled = false; stopBtn.disabled = true;
};

// --- 4. Reassembly & Decoding ---
async function handleIncomingVoiceData(rawText) {
    let payload;
    try {
        payload = JSON.parse(rawText);
    } catch (e) {
        // Fallback: If it's not JSON, assume it's a raw Base64 string pasted in
        const binary = atob(rawText);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        
        const rawAudio = await runDecode(modeSelect.value, bytes.buffer);
        const wav = await rawToWav(rawAudio, modeSelect.value === "450PWB" ? "16000" : "8000");
        playAudio(wav);
        return;
    }

    const { id, c, t, d } = payload;
    if (!reassemblyBuffer[id]) reassemblyBuffer[id] = { chunks: new Array(t).fill(null), count: 0, total: t };
    
    if (reassemblyBuffer[id].chunks[c] === null) {
        const binary = atob(d);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        
        reassemblyBuffer[id].chunks[c] = bytes.buffer;
        reassemblyBuffer[id].count++;
    }

    if (reassemblyBuffer[id].count === t) {
        const fullBuffer = combineBuffers(reassemblyBuffer[id].chunks);
        const decoded = await runDecode(modeSelect.value, fullBuffer);
        const wav = await rawToWav(decoded, modeSelect.value === "450PWB" ? "16000" : "8000");
        playAudio(wav);
        delete reassemblyBuffer[id];
    }
}

function playAudio(wav) {
    const player = document.getElementById('decode-playback');
    player.src = URL.createObjectURL(new Blob([wav], {type: "audio/wav"}));
    document.getElementById('decode-preview-container').classList.remove('hidden');
    player.play();
}

// --- WASM Wrappers (WASM logic remains the same) ---
async function runEncode(mode, rawData) {
    return new Promise(res => {
        const mod = {
            arguments: [mode, "in.raw", "out.bit"],
            preRun: (m) => m.FS.writeFile("in.raw", new Uint8Array(rawData)),
            postRun: (m) => {
                const output = m.FS.readFile("out.bit", {encoding: "binary"});
                m.FS.unlink("in.raw"); m.FS.unlink("out.bit");
                res(output);
            }
        };
        createC2Enc(mod);
    });
}

async function runDecode(mode, data) {
    return new Promise(res => {
        const mod = {
            arguments: [mode, "in.bit", "out.raw"],
            preRun: (m) => m.FS.writeFile("in.bit", new Uint8Array(data)),
            postRun: (m) => {
                const output = m.FS.readFile("out.raw", {encoding: "binary"});
                m.FS.unlink("in.bit"); m.FS.unlink("out.raw");
                res(output);
            }
        };
        createC2Dec(mod);
    });
}

async function rawToWav(buffer, rate = "8000") {
    return new Promise(res => {
        const mod = {
            arguments: ["-r", rate, "-L", "-e", "signed-integer", "-b", "16", "-c", "1", "in.raw", "out.wav"],
            preRun: (m) => m.FS.writeFile("in.raw", new Uint8Array(buffer)),
            postRun: (m) => {
                const output = m.FS.readFile("out.wav", {encoding: "binary"});
                m.FS.unlink("in.raw"); m.FS.unlink("out.wav");
                res(output);
            }
        };
        SOXModule(mod);
    });
}

function combineBuffers(buffers) {
    let length = buffers.reduce((a, b) => a + b.byteLength, 0);
    let res = new Uint8Array(length);
    let offset = 0;
    for (let b of buffers) { res.set(new Uint8Array(b), offset); offset += b.byteLength; }
    return res.buffer;
}

// --- Listeners ---
bleBtn.onclick = initBLE;
transmitBtn.onclick = async () => {
    if (!lastEncodedBuffer) return;
    transmitBtn.disabled = true;
    await sendVoiceInChunks(lastEncodedBuffer);
    transmitBtn.disabled = false;
};
decodeBtn.onclick = () => handleIncomingVoiceData(decodeInput.value);