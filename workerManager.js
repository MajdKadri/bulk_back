const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('./node_modules/filewriter-siawwad');
logger.setLogDir('C:\\Users\\makadri\\Desktop\\bulk\\logs');

class WorkerManager {
    constructor({
        instanceCount,
        ipList,
        port,
        credentials,
        batchConfig,
        gsmNumbers,
        messageConfig,
    }) {
        this.instanceCount = instanceCount;
        this.ipList = ipList;
        this.port = port;
        this.credentials = credentials;
        this.batchConfig = batchConfig;
        this.messageConfig = messageConfig;
        this.gsmNumbers = gsmNumbers;
        this.workers = [];
        this.isProcessing = false;
        this.currentIndex = 0;
        this.batchCounter = 0;
        this.paused = false;
        this.numbersProcessed = 0;
        this.timeoutRef = null;
        this.completionCallback = null;
        this.workerReadyStatus = new Array(instanceCount).fill(false);
    }

    onComplete(callback) {
        this.completionCallback = callback;
    }

    async initialize() {
        await this.closeAllWorkers();
        this.workerReadyStatus = new Array(this.instanceCount).fill(false);
        
        const workerInitializations = Array.from({ length: this.instanceCount }).map((_, i) => {
            return new Promise((resolve, reject) => {
                const ip = this.ipList[i % this.ipList.length];
                const worker = new Worker(path.join(__dirname, 'smppWorker.js'), {
                    workerData: { 
                        ip, 
                        port: this.port, 
                        instanceId: i + 1,
                        ...this.credentials
                    }
                });

                worker.on('message', ({ type }) => {
                    if (type === 'ready') {
                        this.workerReadyStatus[i] = true;
                        resolve(worker);
                    }
                });

                worker.on('error', err => {
                    this.workerReadyStatus[i] = false;
                    logger.logData(`Worker error (Instance ${i + 1}, ${ip}): ${err.message}`);
                    reject(err);
                });

                worker.on('exit', code => {
                    this.workerReadyStatus[i] = false;
                    if (code !== 0) {
                        logger.logData(`Worker stopped (Instance ${i + 1}, ${ip}) with exit code ${code}`);
                    }
                });

                this.workers[i] = worker;
            });
        });

        try {
            await Promise.all(workerInitializations);
            logger.logData(`All ${this.instanceCount} workers are ready.`);
        } catch (error) {
            logger.logData(`Worker initialization failed: ${error.message}`);
            await this.closeAllWorkers();
            throw error;
        }
    }

    async closeAllWorkers() {
        if (this.workers.length > 0) {
            const closePromises = this.workers.map((worker, index) => {
                if (!worker || worker.terminated) {
                    this.workerReadyStatus[index] = false;
                    return Promise.resolve();
                }
                
                return new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        worker.terminate();
                        this.workerReadyStatus[index] = false;
                        resolve();
                    }, 5000);

                    worker.once('exit', () => {
                        clearTimeout(timeout);
                        this.workerReadyStatus[index] = false;
                        resolve();
                    });

                    worker.postMessage({ type: 'close' });
                });
            });

            await Promise.all(closePromises);
            this.workers = [];
            this.isProcessing = false;
        }
    }

    resetState() {
        this.isProcessing = false;
        this.currentIndex = 0;
        this.batchCounter = 0;
        this.paused = false;
        this.numbersProcessed = 0;
        
        if (this.timeoutRef) {
            clearTimeout(this.timeoutRef);
            this.timeoutRef = null;
        }
    }

    async startProcessing() {
        if (this.isProcessing && !this.paused) {
            throw new Error('Processing is already in progress');
        }

        try {
            await this.initialize();
            this.isProcessing = true;
            this.paused = false;
            logger.logData(`Starting message distribution...`);
            logger.logData(`Batch size: ${this.batchConfig.size}, Sleep between batches: ${this.batchConfig.sleepMs}ms`);
            this.processBatches();
        } catch (error) {
            logger.logData(`Failed to start processing: ${error.message}`);
            throw error;
        }
    }

    async processBatches() {
        if (this.paused || !this.isProcessing) {
            return;
        }

        const batchStart = this.batchCounter * this.batchConfig.size;
        const batchEnd = Math.min((this.batchCounter + 1) * this.batchConfig.size, this.gsmNumbers.length);
        
        if (batchStart >= this.gsmNumbers.length) {
            logger.logData('All messages have been sent. Cleaning up...');
            try {
                await this.closeAllWorkers();
                this.resetState();
                logger.logData('Processing completed successfully. Workers closed.');
                if (this.completionCallback) {
                    this.completionCallback();
                }
            } catch (err) {
                logger.logData(`Error during cleanup: ${err.message}`);
            }
            return;
        }

        logger.logData(`Sending batch ${this.batchCounter + 1} (messages ${batchStart + 1}-${batchEnd})`);
        
        try {
            let currentWorkerIndex = 0;
            let activeWorkerCount = 0;
            
            // Find the first available worker
            while (activeWorkerCount < this.workers.length) {
                if (this.workerReadyStatus[currentWorkerIndex] && this.workers[currentWorkerIndex]) {
                    break;
                }
                currentWorkerIndex = (currentWorkerIndex + 1) % this.workers.length;
                activeWorkerCount++;
            }

            if (activeWorkerCount >= this.workers.length) {
                throw new Error('No available workers to process the batch');
            }

            for (let i = batchStart; i < batchEnd; i++) {
                const gsm = this.gsmNumbers[i];
                
                // Find next available worker
                while (!this.workerReadyStatus[currentWorkerIndex] || !this.workers[currentWorkerIndex]) {
                    currentWorkerIndex = (currentWorkerIndex + 1) % this.workers.length;
                }

                const worker = this.workers[currentWorkerIndex];
                if (worker && this.workerReadyStatus[currentWorkerIndex]) {
                    worker.postMessage({
                        type: 'send',
                        gsm,
                        ...this.messageConfig
                    });
                    
                    this.numbersProcessed++;
                    this.currentIndex = i;
                    currentWorkerIndex = (currentWorkerIndex + 1) % this.workers.length;
                } else {
                    logger.logData(`Worker ${currentWorkerIndex} is not ready, skipping message ${i}`);
                }
            }

            this.batchCounter++;
            
            this.timeoutRef = setTimeout(() => {
                this.processBatches();
            }, this.batchConfig.sleepMs);
        } catch (error) {
            logger.logData(`Error processing batch: ${error.message}`);
            this.stopProcessing();
            throw error;
        }
    }

    pauseProcessing() {
        if (!this.isProcessing) {
            throw new Error('No processing to pause');
        }
        this.paused = true;
        if (this.timeoutRef) {
            clearTimeout(this.timeoutRef);
            this.timeoutRef = null;
        }
        this.workers.forEach((worker, index) => {
            if (worker && this.workerReadyStatus[index]) {
                worker.postMessage({ type: 'pause' });
            }
        });
        logger.logData('Processing paused');
    }

    async resumeProcessing() {
        if (!this.paused) {
            throw new Error('Processing is not paused');
        }
        
        try {
            // Verify workers are still available
            const readyWorkers = this.workerReadyStatus.filter(status => status).length;
            if (readyWorkers === 0) {
                throw new Error('No workers available to resume processing');
            }
            
            this.paused = false;
            this.isProcessing = true;
            this.workers.forEach((worker, index) => {
                if (worker && this.workerReadyStatus[index]) {
                    worker.postMessage({ type: 'resume' });
                }
            });
            logger.logData('Processing resumed');
            this.processBatches();
        } catch (error) {
            logger.logData(`Failed to resume processing: ${error.message}`);
            await this.closeAllWorkers();
            throw error;
        }
    }

    async stopProcessing() {
        try {
            await this.closeAllWorkers();
            this.resetState();
            logger.logData('Processing stopped by user request');
        } catch (error) {
            logger.logData(`Error stopping processing: ${error.message}`);
            throw error;
        }
    }

    getStatus() {
        const activeWorkers = this.workerReadyStatus.filter(status => status).length;
        return {
            isProcessing: this.isProcessing && !this.paused,
            paused: this.paused,
            numbersProcessed: this.numbersProcessed,
            batchCounter: this.batchCounter,
            currentIndex: this.currentIndex,
            activeWorkers: activeWorkers,
            totalWorkers: this.instanceCount
        };
    }
}

module.exports = WorkerManager;