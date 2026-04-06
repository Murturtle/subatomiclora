import WebBleConnection from "./src/connection/web_ble_connection.js";
import Constants from "./src/constants.js";

let connection = null;

// UI Elements
const logEl = document.getElementById('log');
const connectBtn = document.getElementById('connect-ble');
const disconnectBtn = document.getElementById('disconnect-btn');

const log = (msg) => {
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.prepend(div);
    console.log(msg);
};

// 1. Connect Logic
connectBtn.onclick = async () => {
    try {
        log("Opening BLE Picker...");
        
        // Static open() method triggers the browser's native Bluetooth popup
        connection = await WebBleConnection.open();

        // 2. Setup Library Event Listeners
        connection.on("connected", async () => {
            log("CONNECTED: MeshNode is ready.");
            connectBtn.disabled = true;
            disconnectBtn.disabled = false;

            // Optional: Match the example template's startup routine
            await connection.syncDeviceTime();
            const info = await connection.getSelfInfo();
            log(`NODE INFO: ${info.name}`);
        });

        connection.on("disconnected", () => {
            log("DISCONNECTED.");
            connectBtn.disabled = false;
            disconnectBtn.disabled = true;
            connection = null;
        });

        connection.on(Constants.PushCodes.MsgWaiting, async () => {
            try {
                const waitingMessages = await connection.getWaitingMessages();
                for(const message of waitingMessages){
                    if(message.channelMessage) {
                        await onChannelMessageReceived(message.channelMessage);
                    }
                }
            } catch(e) {
                console.log(e);
            }
        });

    
        

    } catch (err) {
        log("ERROR: " + err.message);
    }
};

// 4. Disconnect Logic
disconnectBtn.onclick = async () => {
    if (connection) {
        await connection.close();
    }
};