const smpp = require('smpp');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const config = require('./config');

if (isMainThread) {
    // Main thread - read GSM numbers and coordinate workers
    const gsmNumbers = fs.readFileSync(config.FILES.GSM_FILE, 'utf-8')
        .split('\n')
        .map(num => num.trim())
        .filter(num => num.length > 0);

    if (gsmNumbers.length === 0) {
        console.error(`No GSM numbers found in ${config.FILES.GSM_FILE}`);
        process.exit(1);
    }

    // Create workers - distribute IPs in round-robin fashion
    const workers = Array.from({ length: config.WORKERS.INSTANCE_COUNT }).map((_, i) => {
        const ip = config.SMPP.IP_LIST[i % config.SMPP.IP_LIST.length];
        return new Promise((resolve) => {
            const worker = new Worker(__filename, {
                workerData: { 
                    ip, 
                    port: config.SMPP.PORT, 
                    instanceId: i + 1,
                    system_id: config.SMPP.SYSTEM_ID,
                    password: config.SMPP.PASSWORD
                }
            });

            worker.on('message', ({ type }) => {
                if (type === 'ready') {
                    resolve(worker);
                }
            });

            worker.on('error', err => {
                console.error(`Worker error (Instance ${i + 1}, ${ip}):`, err);
            });

            worker.on('exit', code => {
                if (code !== 0) {
                    console.error(`Worker stopped (Instance ${i + 1}, ${ip}) with exit code ${code}`);
                }
            });
        });
    });

    // Wait for all workers to be ready
    Promise.all(workers).then((boundWorkers) => {
        console.log(`All ${config.WORKERS.INSTANCE_COUNT} workers are ready. Starting message distribution...`);
        console.log(`Batch size: ${config.BATCH.SIZE}, Sleep between batches: ${config.BATCH.SLEEP_MS}ms`);

        // Distribute GSM numbers to workers in batches
        let currentWorkerIndex = 0;
        let batchCounter = 0;

        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        async function sendBatch() {
            const batchStart = batchCounter * config.BATCH.SIZE;
            console.log(`BatchStart : ${batchStart}`);
            
            const batchEnd = Math.min((batchCounter + 1) * config.BATCH.SIZE, gsmNumbers.length);
            console.log(`BatchStart : ${batchEnd}`);
            
            if (batchStart >= gsmNumbers.length) {
                // All messages sent, close workers
                setTimeout(() => {
                    boundWorkers.forEach(worker => worker.postMessage({ type: 'close' }));
                }, 5000);
                return;
            }

            console.log(`Sending batch ${batchCounter + 1} (messages ${batchStart + 1}-${batchEnd})`);
            
            // Send all messages in current batch
            for (let i = batchStart; i < batchEnd; i++) {
                const gsm = gsmNumbers[i];
                boundWorkers[currentWorkerIndex].postMessage({
                    type: 'send',
                    gsm,
                    source_addr: config.SMPP.SOURCE_ADDR,
                    message_text: config.SMPP.MESSAGE_TEXT
                });
                currentWorkerIndex = (currentWorkerIndex + 1) % boundWorkers.length;
            }

            batchCounter++;
            
            // Sleep before next batch
            await sleep(config.BATCH.SLEEP_MS);
            sendBatch();
        }

        // Start batch processing
        sendBatch();
    });

} else {
    // Worker thread
    const { ip, port, instanceId, system_id, password } = workerData;
    const logger = require('./node_modules/filewriter-siawwad');
    logger.setLogDir('C:\\Users\\makadri\\Desktop\\bulk\\logs');

    let session = null;
    let isBound = false;
    const messageQueue = [];
    const failedMessages = []; // Store messages that failed with 0000000000 message_id

    function createSession() {
        session = smpp.connect({
            url: `smpp://${ip}:${port}`,
            auto_enquire_link_period: config.SMPP.AUTO_ENQUIRE_LINK_PERIOD,
            debug: false
        });

        session.on('connect', () => {
            session.bind_transceiver({
                system_id,
                password
            }, (pdu) => {
                if (pdu.command_status === 0) {
                    isBound = true;
                    parentPort.postMessage({
                        type: 'ready'
                    });
                    processQueue();
                } else {
                    session.close();
                }
            });
        });

        session.on('error', (err) => {
            isBound = false;
        });

        session.on('close', () => {
            isBound = false;
            if (messageQueue.length > 0 || failedMessages.length > 0) {
                setTimeout(createSession, 5000);
            }
            process.exit(0);
        });
    }

    function processQueue() {
        if (!isBound) return;

        // First process any previously failed messages
        while (failedMessages.length > 0) {
            messageQueue.unshift(failedMessages.pop());
        }

        if (messageQueue.length === 0) return;

        const { gsm, source_addr, message_text, callback } = messageQueue.shift();

        session.submit_sm({
            source_addr_ton: 5,
            destination_addr_ton: 5,
            data_coding: 8,
            source_addr_npi: 0,
            destination_addr_npi: 0,
            source_addr: source_addr,
            destination_addr: gsm,
            message_payload: message_text,
        }, async (pdu) => {
            if (pdu.message_id === '0000000000') {
                // Add the message back to the queue for retry
                failedMessages.push({
                    gsm,
                    source_addr,
                    message_text,
                    callback
                });
                logger.logData('GSM: ' + gsm + ' Message_ID:' + pdu.message_id + ' - Requeued for retry');
            } else {
                if (callback) callback();
            }
            
            // Process next message
            processQueue();
        });
    }

    parentPort.on('message', (message) => {
        switch (message.type) {
            case 'send':
                const promise = new Promise(resolve => {
                    messageQueue.push({
                        ...message,
                        callback: resolve
                    });
                });

                if (!session || !isBound) {
                    createSession();
                } else {
                    processQueue();
                }
                return promise;
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
}