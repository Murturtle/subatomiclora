import WebBleConnection from "./src/connection/web_ble_connection.js";
import Constants from "./src/constants.js";
import BufferWriter from "./src/buffer_writer.js";


let connection = null;
let publicChannel = null;

// --- 1. Logger Utility ---
function log(msg, data = null) {
    const logEl = document.getElementById('log');
    if (!logEl) {
        console.log(msg, data);
        return;
    }

    const div = document.createElement('div');
    div.style.borderBottom = "1px solid #ddd";
    div.style.padding = "4px 0";
    
    let timestamp = new Date().toLocaleTimeString();
    let content = `[${timestamp}] ${msg}`;

    if (data) {
        const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
        content += ` <br><small style="color: #666; font-family: monospace;">HEX: ${hex}</small>`;
    }

    div.innerHTML = content;
    logEl.prepend(div);
    console.log(msg, data);
}

// --- 2. Connection & Receiving Logic ---
async function startMeshApp() {
    try {
        log("Opening BLE Picker...");
        // This triggers the popup AND connects automatically
        connection = await WebBleConnection.open();

        connection.on("connected", async () => {
            log("CONNECTED: MeshNode is ready.");

            const channels = await connection.getChannels();
            log(channels);
            publicChannel = channels.find(c => c.name === "#hehe");

            if (publicChannel) {
                log(`READY: Listening to (Index: ${publicChannel.channelIdx})`);
            } else {
                log("WARNING: channel not found.");
            }
        });

        

        // Decrypted Text Messages
        connection.on("message", (msg) => {
            log(`<b>${msg.fromName}</b>: ${msg.text}`);
        });

        // Raw Radio Packets (Where your Codec2 bits will appear)
        connection.on(Constants.PushCodes.LogRxData, (event) => {
            log(`RAW PACKET: ${event.raw.length} bytes`, event.raw);
        });

        connection.on("disconnected", () => {
            log("DISCONNECTED.");
            connection = null;
        });

        

        // Note: We DO NOT call connection.connect() here in the browser version.

    } catch (err) {
        log("CONNECTION ERROR: " + err.message);
    }
    
}

// --- 3. Sending Logic (The 0x00 Packet) ---
async function sendTestPacket() {
    if (!connection) {
        alert("Please connect to BLE first!");
        return;
    }

    connection.sendChannelTextMessage(publicChannel, "CODEC2 DATA HERE");
    

}

// --- 4. Event Listeners ---
document.getElementById('connect-ble').onclick = startMeshApp;

// Ensure you have a button with id="send-test" in your HTML
const sendBtn = document.getElementById('send-test');
if (sendBtn) {
    sendBtn.onclick = sendTestPacket;

    
}