const smpp = require('smpp');
const { workerData, parentPort } = require('worker_threads');
const logger = require('./node_modules/filewriter-siawwad');
logger.setLogDir('C:\\Users\\makadri\\Desktop\\bulk\\logs');

const { ip, port, instanceId, system_id, password } = workerData;
let session = null;
let isBound = false;
const messageQueue = [];
const failedMessages = [];

function createSession() {
    session = smpp.connect({
        url: `smpp://${ip}:${port}`,
        auto_enquire_link_period: 10000, // 10 seconds
        debug: false
    });

    session.on('connect', () => {
        session.bind_transceiver({
            system_id,
            password
        }, (pdu) => {
            if (pdu.command_status === 0) {
                isBound = true;
                parentPort.postMessage({ type: 'ready' });
                processQueue();
            } else {
                session.close();
            }
        });
    });

    session.on('error', (err) => {
        console.error(`Worker ${instanceId} error:`, err);
        isBound = false;
    });

    session.on('close', () => {
        isBound = false;
        if (messageQueue.length > 0 || failedMessages.length > 0) {
            setTimeout(createSession, 5000);
        }
    });
}

function processQueue() {
    if (!isBound) return;

    // First process any previously failed messages
    while (failedMessages.length > 0) {
        messageQueue.unshift(failedMessages.pop());
    }

    if (messageQueue.length === 0) return;

    const { gsm, source_addr, message_text } = messageQueue.shift();

    session.submit_sm({
        source_addr_ton: 5,
        destination_addr_ton: 5,
        data_coding: 8,
        source_addr_npi: 0,
        destination_addr_npi: 0,
        source_addr: source_addr,
        destination_addr: gsm,
        message_payload: message_text,
    }, (pdu) => {
        if (pdu.message_id === '0000000000') {
            failedMessages.push({ gsm, source_addr, message_text });
            logger.logData(`GSM: ${gsm} Message_ID: ${pdu.message_id} - Requeued for retry`);
        } else {
            parentPort.postMessage({ type: 'processed' });
        }
        
        processQueue();
    });
}

parentPort.on('message', (message) => {
    switch (message.type) {
        case 'send':
            messageQueue.push(message);
            
            if (!session || !isBound) {
                createSession();
            } else {
                processQueue();
            }
            break;
        case 'close':
            if (session && isBound) {
                if (messageQueue.length === 0 && failedMessages.length === 0) {
                    session.close();
                }
            }
            break;
    }
});

createSession();