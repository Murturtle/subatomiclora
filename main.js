/**
 * --- BASE64 IMPLEMENTATION ---
 * Standard browser-native Base64 conversion.
 */
function toBase64(input) {
    const bytes = input.buffer ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function fromBase64(base64) {
    const binary = window.atob(base64.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * --- CLEAN WASM WRAPPERS ---
 * These ensure the virtual filesystem is cleared after every run.
 */
async function runEncode(mode, rawData) {
    return new Promise(res => {
        const mod = {
            arguments: [mode, "in.raw", "out.bit"],
            preRun: (m) => m.FS.writeFile("in.raw", new Uint8Array(rawData)),
            postRun: (m) => {
                const output = m.FS.readFile("out.bit", {encoding: "binary"});
                m.FS.unlink("in.raw");
                m.FS.unlink("out.bit");
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
                m.FS.unlink("in.bit");
                m.FS.unlink("out.raw");
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
                m.FS.unlink("in.raw");
                m.FS.unlink("out.wav");
                res(output);
            }
        };
        SOXModule(mod);
    });
}

/**
 * --- UI LOGIC ---
 */
let mediaRecorder;
let chunks = [];

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const modeSelect = document.getElementById('mode-select');

startBtn.onclick = async () => {
    chunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        const arrayBuffer = await blob.arrayBuffer();

        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        const offline = new OfflineAudioContext(1, decoded.duration * 8000, 8000);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start();
        
        const resampled = await offline.startRendering();
        const floatData = resampled.getChannelData(0);
        const int16 = new Int16Array(floatData.length);
        for(let i=0; i<floatData.length; i++) {
            const s = Math.max(-1, Math.min(1, floatData[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const mode = modeSelect.value;
        const encoded = await runEncode(mode, int16.buffer);
        
        // Output as standard Base64
        document.getElementById('output-text').value = toBase64(encoded);
        document.getElementById('audio-preview').src = URL.createObjectURL(blob);
        document.getElementById('preview-container').classList.remove('hidden');
        audioCtx.close();
    };

    mediaRecorder.start();
    startBtn.disabled = true; stopBtn.disabled = false;
    startBtn.innerText = "Recording...";
};

stopBtn.onclick = () => {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    startBtn.disabled = false; stopBtn.disabled = true;
    startBtn.innerText = "Start Recording";
};

document.getElementById('decode-btn').onclick = async () => {
    const input = document.getElementById('decode-input').value;
    if(!input) return;
    
    try {
        const mode = modeSelect.value;
        const bitBuffer = fromBase64(input);
        const raw = await runDecode(mode, bitBuffer);
        
        // 450PWB check
        const rate = mode.includes("PWB") ? "16000" : "8000";
        const wav = await rawToWav(raw, rate);
        
        const player = document.getElementById('decode-playback');
        if (player.src) URL.revokeObjectURL(player.src);
        
        player.src = URL.createObjectURL(new Blob([wav], {type: "audio/wav"}));
        document.getElementById('decode-preview-container').classList.remove('hidden');
        player.play();
    } catch (e) {
        console.error(e);
        alert(`Error: ${e.message}`);
    }
};


let serialPort = null;
let writer = null;

const serialBtn = document.getElementById('serial-connect-btn');
const serialStatus = document.getElementById('serial-status');

// --- Serial Connection ---
serialBtn.onclick = async () => {
    if (serialPort) {
        // Disconnect logic
        if (writer) await writer.releaseLock();
        await serialPort.close();
        serialPort = null;
        serialBtn.innerText = "Connect over Serial";
        serialStatus.innerText = "Status: Disconnected";
        return;
    }

    try {
        // Request port from user
        serialPort = await navigator.serial.requestPort();
        // Meshcore typically uses 115200
        await serialPort.open({ baudRate: 115200 });
        
        serialBtn.innerText = "Disconnect Serial";
        serialStatus.innerText = "Status: Connected";
        
        // Setup a writer to send data
        writer = serialPort.writable.getWriter();
        
        // Optional: Setup a reader if you want to receive and auto-decode
        readFromSerial();

    } catch (err) {
        console.error("Serial error:", err);
        alert("Serial Connection Failed: " + err.message);
    }
};

// --- Sending Encoded Data ---
// Update your existing mediaRecorder.onstop logic to include this:
async function sendToSerial(encodedUint8Array) {
    if (writer) {
        // You might want to wrap the data in a frame (e.g., [STX, Length, Data, ETX])
        // depending on what your hardware expects.
        await writer.write(encodedUint8Array);
        console.log("Sent compressed audio over serial.");
    }
}

// --- Receiving Data (Optional) ---
async function readFromSerial() {
    const reader = serialPort.readable.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            // 'value' is a Uint8Array. 
            // If it's a complete Codec2 frame, you can pass it to runDecode()!
            console.log("Received serial data:", value);
        }
    } catch (err) {
        console.error("Read error:", err);
    } finally {
        reader.releaseLock();
    }
}