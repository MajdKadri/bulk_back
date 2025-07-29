const express = require('express');
const multer = require('multer');
const smpp = require('smpp');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const app = express();
const upload = multer({ dest: 'uploads/' });

// Configuration
const CONFIG = {
    IP_LIST: [
        '10.10.52.17',
        '10.10.52.18',
        '10.10.52.19',
        '10.10.52.20',
        '10.10.52.21',
        '10.10.52.22',
        '10.10.52.23'
    ],
    PORT: 5001,
    SYSTEM_ID: 'lbtest',
    PASSWORD: '123456',
    SOURCE_ADDR: 'test2',
    DEFAULT_MESSAGE: 'test',
    INSTANCE_COUNT: 7,
    MAX_TPS: 1,
    BATCH_SIZE : 1,
    LOG_DIR: path.join(__dirname, 'logs'),
    UPLOAD_DIR: path.join(__dirname, 'uploads')
};

// Initialize directories
[CONFIG.LOG_DIR, CONFIG.UPLOAD_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// State management
const state = {
    gsmNumbers: [],
    workers: [],
    isRunning: false,
    isPaused: false,
    currentIndex: 0,
    messageText: CONFIG.DEFAULT_MESSAGE,
    completedWorkers: 0
};

// Utility functions
const utils = {
    getTimestamp: () => new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''),
    log: (message, level = 'info') => {
        const logEntry = `[${utils.getTimestamp()}] [${level.toUpperCase()}] ${message}\n`;
        fs.appendFileSync(path.join(CONFIG.LOG_DIR, 'smpp-sender.log'), logEntry);
        console[level === 'error' ? 'error' : 'log'](logEntry.trim());
    },
    clearUploads: () => {
        fs.readdir(CONFIG.UPLOAD_DIR, (err, files) => {
            if (err) return utils.log(`Upload clear error: ${err.message}`, 'error');
            files.forEach(file => {
                fs.unlink(path.join(CONFIG.UPLOAD_DIR, file), () => {});
            });
            utils.log('Cleared upload directory');
        });
    }
};

// Worker management
const workerManager = {
    start: () => {
        if (state.isRunning || state.gsmNumbers.length === 0) return false;
        
        state.isRunning = true;
        state.currentIndex = 0;
        state.completedWorkers = 0;
        const tpsPerWorker = Math.floor(CONFIG.MAX_TPS / CONFIG.INSTANCE_COUNT);

        state.workers = Array.from({ length: CONFIG.INSTANCE_COUNT }).map((_, i) => {
            const ip = CONFIG.IP_LIST[i % CONFIG.IP_LIST.length];
            const worker = new Worker(__filename, {
                workerData: {
                    ip,
                    port: CONFIG.PORT,
                    instanceId: i + 1,
                    systemId: CONFIG.SYSTEM_ID,
                    password: CONFIG.PASSWORD,
                    sourceAddr: CONFIG.SOURCE_ADDR,
                    messageText: state.messageText,
                    tpsPerWorker
                }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'worker_complete') {
                    state.completedWorkers++;
                    if (state.completedWorkers === CONFIG.INSTANCE_COUNT) {
                        utils.log('All workers completed processing');
                        workerManager.stop();
                    }
                }
            });

            worker.on('error', (err) => {
                utils.log(`Worker ${i+1} error: ${err.message}`, 'error');
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    utils.log(`Worker ${i+1} exited with code ${code}`, 'error');
                }
            });

            return worker;
        });

        workerManager.distributeMessages();
        return true;
    },

    distributeMessages: async () => {
        let workerIndex = 0;
        
        while (state.currentIndex < state.gsmNumbers.length && !state.isPaused) {
            const batch = [];
            const batchEnd = Math.min(state.currentIndex + CONFIG.BATCH_SIZE, state.gsmNumbers.length);
            
            for (let i = state.currentIndex; i < batchEnd; i++) {
                const isLast = i === state.gsmNumbers.length - 1;
                batch.push({
                    gsm: state.gsmNumbers[i],
                    message: state.messageText,
                    isLast: isLast && (i === batchEnd - 1)
                });

                
            }
            
            state.workers[workerIndex].postMessage({
                type: 'batch',
                messages: batch
            });
            
            workerIndex = (workerIndex + 1) % state.workers.length;
            state.currentIndex = batchEnd;
            
            // Throttle distribution slightly
            if (state.currentIndex % 1000 === 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    },

    stop: () => {
        utils.log('Stopping all workers and cleaning up');
        state.workers.forEach(worker => {
            worker.postMessage({ type: 'shutdown' });
        });
        state.workers = [];
        state.isRunning = false;
        state.isPaused = false;
        utils.clearUploads();
    }
};

// Express endpoints
app.use(express.json());
app.post('/upload', upload.single('gsms'), (req, res) => {
    try {
        state.gsmNumbers = fs.readFileSync(req.file.path, 'utf-8')
            .split('\n')
            .map(num => num.trim())
            .filter(num => num.length > 0);
        state.currentIndex = 0;
        res.json({ success: true, count: state.gsmNumbers.length });
    } catch (err) {
        utils.log(`Upload error: ${err.message}`, 'error');
        res.status(500).json({ error: 'File processing failed' });
    }
});

app.post('/message', (req, res) => {
    if (!req.body?.message) return res.status(400).json({ error: 'Message text required' });
    state.messageText = req.body.message;
    res.json({ success: true, message: state.messageText });
});

app.post('/start', (req, res) => {
    console.log ("starting time" + Date.now());
    if (workerManager.start()) {
        res.json({ success: true, message: 'Message sending started' });
    } else {
        res.status(400).json({ error: 'Already running or no numbers loaded' });
    }
});

app.post('/stop', (req, res) => {
    workerManager.stop();
    res.json({ success: true, message: 'Message sending stopped' });
});

app.post('/pause', (req, res) => {
    state.isPaused = true;
    res.json({ 
        success: true, 
        message: 'Message sending paused',
        remaining: state.gsmNumbers.length - state.currentIndex
    });
});

app.post('/resume', (req, res) => {
    if (!state.isPaused) return res.status(400).json({ error: 'Not currently paused' });
    state.isPaused = false;
    workerManager.distributeMessages();
    res.json({ 
        success: true, 
        message: 'Message sending resumed',
        remaining: state.gsmNumbers.length - state.currentIndex
    });
});

app.get('/status', (req, res) => {
    res.json({
        isRunning: state.isRunning,
        isPaused: state.isPaused,
        totalNumbers: state.gsmNumbers.length,
        sent: state.currentIndex,
        remaining: state.gsmNumbers.length - state.currentIndex,
        currentMessage: state.messageText,
        activeWorkers: state.workers.length
    });
});

// Optimized Worker Implementation
if (!isMainThread) {
    const { 
        ip, 
        port,
        instanceId,
        systemId,
        password,
        sourceAddr,
        messageText,
        tpsPerWorker
    } = workerData;
    
    const SESSION_POOL_SIZE = 1;
    const MAX_RETRIES = 3;
    const sessions = [];
    const queue = [];
    let activeSessions = 0;
    let isShuttingDown = false;
    let retryCount = 0;

    const workerUtils = {
        initializeSessions: () => {
            for (let i = 0; i < SESSION_POOL_SIZE; i++) {
                workerUtils.createSession();
            }
        },

        createSession: () => {
            const session = smpp.connect({
                url: `smpp://${ip}:${port}`,
                auto_enquire_link_period: 15000,
                debug: false
            });

            session.on('connect', () => {
                session.bind_transceiver({
                    system_id: systemId,
                    password: password
                }, (pdu) => {
                    if (pdu.command_status === 0) {
                        activeSessions++;
                        sessions.push(session);
                        workerUtils.processQueue();
                        retryCount = 0; // Reset retry counter on successful bind
                    } else {
                        session.close();
                        workerUtils.retrySessionCreation();
                    }
                });
            });

            session.on('error', (err) => {
                if (session._session) session.close();
                workerUtils.retrySessionCreation();
            });

            session.on('close', () => {
                console.log("end time" + Date.now());
                activeSessions--;
                if (!isShuttingDown && queue.length > 0) {
                    workerUtils.retrySessionCreation();
                }
            });
        },

        retrySessionCreation: () => {
            if (retryCount++ < MAX_RETRIES) {
                setTimeout(workerUtils.createSession, 1000);
            } else {
                parentPort.postMessage({
                    type: 'error',
                    instanceId,
                    message: `Max retries (${MAX_RETRIES}) reached for session creation`
                });
            }
        },

        processQueue: async () => {
            if (queue.length === 0 || sessions.length === 0) return;
            
            const session = sessions.pop();
            const batchSize = Math.min(50, queue.length);
            const batch = queue.splice(0, batchSize);
            const promises = [];
            
            try {
                for (const { gsm, message, isLast } of batch) {
                    promises.push(new Promise((resolve) => {
                        session.submit_sm({
                            source_addr: sourceAddr,
                            destination_addr: gsm,
                            short_message: message,
                            data_coding: 8,
                            source_addr_ton: 5,
                            source_addr_npi: 0,
                            dest_addr_ton: 5,
                            dest_addr_npi: 0,
                            registered_delivery: 1
                        }, (pdu) => {
                            if (pdu.command_status !== 0) {
                                queue.push({ gsm, message, isLast });
                            }
                            resolve();
                        });
                    }));
                }

                await Promise.all(promises);
                
                // Check if this was the last batch
                if (batch.some(item => item.isLast)) {
                    parentPort.postMessage({
                        type: 'worker_complete',
                        instanceId
                    });
                }
            } catch (err) {
                // Requeue the entire batch on error
                queue.unshift(...batch);
            } finally {
                // Return session to pool
                sessions.push(session);
                
                // Process next batch if available
                if (queue.length > 0) {
                    setImmediate(() => workerUtils.processQueue());
                }
            }
        },

        shutdown: () => {
            isShuttingDown = true;
            let closedCount = 0;
            
            if (sessions.length === 0) {
                process.exit(0);
                return;
            }
            
            sessions.forEach(session => {
                session.unbind(() => {
                    session.close();
                    if (++closedCount === sessions.length) {
                        process.exit(0);
                    }
                });
            });
        }
    };

    parentPort.on('message', (msg) => {
        if (msg.type === 'batch') {
            queue.push(...msg.messages);
            if (activeSessions > 0) {
                workerUtils.processQueue();
            }
        } else if (msg.type === 'shutdown') {
            workerUtils.shutdown();
        }
    });

    workerUtils.initializeSessions();
}

// Start server
const PORT_SERVER = 3000;
app.listen(PORT_SERVER, () => {
    utils.log(`Server running on port ${PORT_SERVER}`);
});
