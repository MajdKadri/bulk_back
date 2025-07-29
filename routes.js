const WorkerManager = require('./workerManager');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const dbFunction = require('./DB/DbFunction');
const ldap = require('ldapjs'); // Add LDAP client
const session = require('express-session');
const WebSocket = require('ws');
const cors = require('cors');
const express = require('express');
const tls = require('tls');
const logger = require('./node_modules/filewriter-siawwad');
logger.setLogDir('C:\\Users\\makadri\\Desktop\\bulk\\logs');

let workerManager = null;

// Approved users list
const APPROVED_USERS = [
    'mtnsyr\\makadri',
    'mtnsyr\\amahayni',
    'mtnsyr\\khelsaidelmasri',
    'mtnsyr\\hahaidar',
];

// Configure multer (unchanged)
const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.txt'];
        const fileExt = path.extname(file.originalname).toLowerCase();
        
        if (!allowedExtensions.includes(fileExt)) {
            const error = new Error('Only .txt files are allowed');
            error.code = 'INVALID_FILE_TYPE';
            return cb(error, false);
        }
        
        if (file.mimetype !== 'text/plain') {
            const error = new Error('File content type must be text/plain');
            error.code = 'INVALID_FILE_TYPE';
            return cb(error, false);
        }
        
        cb(null, true);
    }
});

// Error handling middleware for multer (unchanged)
const handleMulterErrors = (err, req, res, next) => {
    try {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({
                    success: false,
                    error: 'File size exceeds the 500MB limit'
                });
            }
            return res.status(400).json({
                success: false,
                error: err.message
            });
        } else if (err) {
            console.log(err);
            if (err.code === 'INVALID_FILE_TYPE') {
                return res.status(415).json({
                    success: false,
                    error: err.message,
                    allowedTypes: 'Only .txt files are accepted'
                });
            }
            return res.status(500).json({
                success: false,
                error: 'An unknown error occurred'
            });
        }
        next();
    } catch (e) {
        console.log(e);
    }
};

async function authenticateLDAP(username, password) {
    return new Promise((resolve, reject) => {
        // 1. Create client with proper TLS options
        const client = ldap.createClient({
            url: 'ldaps://arsy2011.mtnsyr.com',
            tlsOptions: {
                ca: [fs.readFileSync('config/certificate/mtnsyr.cer')],
                servername: 'arsy2011.mtnsyr.com', // Critical for SNI
                minVersion: 'TLSv1.2', // Force TLS 1.2
                rejectUnauthorized: true,
                checkServerIdentity: (host, cert) => {
                    // Custom validation to handle internal certs
                    if (cert.subjectaltname.includes('DNS:arsy2011.mtnsyr.com')) {
                        return undefined; // Accept if hostname matches
                    }
                    return new Error('Certificate validation failed');
                }
            },
            timeout: 5000, // Add connection timeout
            reconnect: false // Disable automatic reconnection
        });

        // 2. Handle connection errors
        client.on('error', (err) => {
            console.error('LDAP connection error:', err);
            reject(err);
        });

        // 3. Attempt bind with timeout
        const timeout = setTimeout(() => {
            client.unbind();
            reject(new Error('LDAP connection timeout'));
        }, 10000);

        const userDN = `MTNSYR\\${username}`;
        
        // 4. Execute bind
        client.bind(userDN, password, (err) => {
            clearTimeout(timeout);
            client.unbind();
            
            if (err) {
                console.error('LDAP bind error:', err);
                return reject(err);
            }
            resolve(true);
        });
    });
}

// Status update functions (unchanged)
function sendStatusUpdate(ws, appState) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
    const status = workerManager ? workerManager.getStatus() : {
        isProcessing: false,
        paused: false,
        numbersProcessed: 0,
        batchCounter: 0,
        currentIndex: 0
    };
  
    const progress = appState.gsmNumbers.length > 0 
        ? (status.numbersProcessed / appState.gsmNumbers.length * 100)
        : 0;
  
    const statusUpdate = {
        tps: appState.tps,
        status: status.isProcessing ? 'processing' : (status.paused ? 'paused' : 'idle'),
        progress: progress.toFixed(2),
        numbersProcessed: status.numbersProcessed,
        totalNumbers: appState.gsmNumbers.length,
        currentMessage: appState.message,
        sender: appState.sender,
        batchCounter: status.batchCounter,
        currentIndex: status.currentIndex,
        timestamp: new Date().toISOString()
    };
  
    ws.send(JSON.stringify(statusUpdate));
}

function broadcastStatus(clients, appState) {
    clients.forEach(client => {
        sendStatusUpdate(client, appState);
    });
}

// Authentication middleware - now uses LDAP
async function authenticate(req, res, next) {
    // Check if already authenticated via session
    if (req.session.user) {
        return next();
    }

    // For login endpoint, handle authentication
    if (req.method === 'POST' && req.path === '/api/auth/login') {
        return next(); // Let the login route handle it
    }

    // For all other routes, require authentication
    return res.status(401).json({ 
        error: 'Authentication required',
        details: 'Please login first'
    });
}

function configureRoutes(app, appState, clients) {
    // Apply all middleware in correct order
    app.use(cors({
        origin: ['http://10.11.209.117:3000', 'http://localhost:3000'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type', 
            'Authorization',
            'x-requested-with',
            'Accept',
            'Accept-Language',
            'Content-Language'
        ],
        exposedHeaders: [
            'Content-Length',
            'X-Request-Id'
        ]
    }));
    
    // Configure JSON parser with error handling
    app.use(express.json({
        strict: false, // Allow non-object JSON
        verify: (req, res, buf, encoding) => {
            try {
                if (buf.length > 0 && buf.toString() !== 'null') {
                    JSON.parse(buf.toString('utf8'));
                }
            } catch (e) {
                throw new Error('Invalid JSON');
            }
        }
    }));
    
    // Then add this middleware to handle null bodies specifically
    app.use((req, res, next) => {
        if (req.body === null) {
            req.body = {};
        }
        next();
    });

    
    
    // Error handler for JSON parsing
  
    
    app.use(express.urlencoded({ extended: true }));
  
    
    
    // Session middleware
    app.use(session({
        secret: config.SESSION_SECRET || 'your-secret-key',
        resave: false,
        saveUninitialized: false,
        cookie: { 
            secure: process.env.NODE_ENV === 'production',
            maxAge:   10 *1000 // 8 hours
        }
    }));

    // Apply authentication to all routes (except auth status and login)
    app.use((req, res, next) => {
        // Skip auth for these endpoints
        if (req.path === '/api/auth/status' || req.path === '/api/auth/login') {
            return next();
        }
        authenticate(req, res, next);
    });

    // Auth status endpoint (public)
    app.get('/api/auth/status', (req, res) => {
        res.json({
            authenticated: !!req.session.user,
            user: req.session.user,
            isApproved: req.session.user ? 
                APPROVED_USERS.includes(`${req.session.user.domain}\\${req.session.user.username}`) :
                false
        });
    });

    // Login endpoint (public) - now uses LDAP authentication
       // Login endpoint (public) - now uses LDAP authentication
       app.post('/api/auth/login', async (req, res) => {
        try {
            // Check if body exists and has the required fields
            if (!req.body || typeof req.body !== 'object') {
                return res.status(400).json({ 
                    success: false,
                    error: 'Invalid request body',
                    details: 'Request body must be a valid JSON object'
                });
            }

            const { username, password } = req.body;
            
            if (!username || !password) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Username and password are required',
                    details: 'Please provide both username and password fields'
                });
            }

            // First verify credentials with LDAP
            try {
                await authenticateLDAP(username, password);
            } catch (err) {
                console.error('LDAP authentication error:', err);
                return res.status(401).json({ 
                    success: false,
                    error: 'Authentication failed',
                    details: 'Invalid credentials'
                });
            }

            // Then check if user is approved
            const userKey = `mtnsyr\\${username}`.toLowerCase();
            if (!APPROVED_USERS.map(u => u.toLowerCase()).includes(userKey)) {
                return res.status(403).json({ 
                    success: false,
                    error: 'Access denied',
                    details: 'Your account is not authorized to use this service'
                });
            }

            // Create session
            req.session.user = {
                username: username,
                domain: 'mtnsyr',
                authenticatedAt: new Date().toISOString()
            };
            
            res.json({ 
                success: true,
                user: req.session.user
            });
        } catch (err) {
            console.error('Login error:', err);
            res.status(500).json({ 
                success: false,
                error: 'Login failed',
                details: 'An error occurred during authentication'
            });
        }
    });

    // Logout endpoint (unchanged)
    app.get('/api/auth/logout', (req, res) => {
        if (!req.session.user) {
            return res.status(400).json({ 
                success: false,
                error: 'Not logged in',
                details: 'No active session found'
            });
        }
    
        req.session.destroy(err => {
            if (err) {
                console.error('Logout error:', err);
                return res.status(500).json({ 
                    success: false,
                    error: 'Logout failed',
                    details: err.message
                });
            }
            res.json({ 
                success: true,
                message: 'Logged out successfully'
            });
        });
    });

    // ... (All other routes remain exactly the same as before) ...
    // File upload route
    app.post('/upload', upload.single('gsms'), (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: "No file was uploaded. Please upload a text file with the 'gsms' field."
                });
            }

            const fileContent = fs.readFileSync(req.file.path, 'utf-8');
            fs.unlinkSync(req.file.path);

            appState.gsmNumbers = fileContent
                .split('\n')
                .map(num => num.trim())
                .filter(num => num.length > 0);

            if (appState.gsmNumbers.length === 0) {
                return res.status(422).json({
                    success: false,
                    error: "The uploaded file doesn't contain any valid GSMs"
                });
            }

            if (workerManager) {
                workerManager = null;
            }

            res.json({ 
                success: true, 
                count: appState.gsmNumbers.length,
                message: `${appState.gsmNumbers.length} GSMs processed successfully`
            });

        } catch (err) {
            console.error(`Upload error: ${err.message}`);
            res.status(500).json({ 
                success: false,
                error: 'File processing failed',
                details: err.message 
            });
        }
    });

    // TPS route
    app.post('/tps', (req, res) => {
        if (!('tps' in req.body)) {
            return res.status(400).json({
                error: 'tps field is required'
            });
        }
        
        const tps = Number(req.body.tps);
        if (isNaN(tps) || tps < 0) {
            return res.status(400).json({
                error: 'tps must be a non-negative number'
            });
        }
         
        if (tps === 0) {
            dbFunction.getPeakTps()
            .then(peakTpsResult => {
                const dbPeaktps = peakTpsResult.length > 0 ? Number(peakTpsResult[0].PEAK_TPS) : 0;
                appState.tps = Math.max(0, 5000 - dbPeaktps) / appState.messagePartsCount;
                appState.sleepMs = appState.tps === 0 ? 0 : 12000 / appState.tps;
                return res.json({
                    success: true,
                    calculatedValue: appState.sleepMs,
                    autoCalculated: true
                });
            })
            .catch(err => {
                console.error('Error getting peak TPS:', err);
                appState.tps = 5000;
                appState.sleepMs = 12000 / 5000 / Math.ceil(appState.messagePartsCount);
                return res.json({
                    success: true,
                    calculatedValue: appState.sleepMs,
                    autoCalculated: true
                });
            });
        } else {
            appState.sleepMs = 12000 / tps / appState.messagePartsCount;
            appState.tps = tps / appState.messagePartsCount;
            
            return res.json({
                success: true,
                calculatedValue: appState.sleepMs,
                autoCalculated: false
            });
        }
    });

    // Sender route
    app.post('/sender', (req, res) => {
        if (!req.body?.sender) {
            return res.status(400).json({
                error: 'Sender Field is required'
            });
        }
        appState.sender = req.body.sender;
        res.json({
            message: 'Sender updated successfully',
            currentSender: appState.sender
        });
    });

    // Message route
    app.post('/message', (req, res) => {
        if (!req.body?.message) {
            return res.status(400).json({ 
                error: 'Message text required' 
            });
        }
        appState.message = req.body.message;
        appState.messagePartsCount = Math.ceil(appState.message.length / 70);
        res.json({  
            message: 'Message updated successfully',
            parts: appState.messagePartsCount,
            currentMessage: appState.message
        });
    });

    // Start processing route
    app.post('/start', async (req, res) => {
        if (appState.gsmNumbers.length === 0) {
            return res.status(400).json({ 
                error: 'No numbers uploaded' 
            });
        }
        
        if (!appState.message) {
            return res.status(400).json({ 
                error: 'No message set' 
            });
        }
        
        if (!appState.sender) {
            return res.status(400).json({ 
                error: 'No sender set' 
            });
        }
        
        if (appState.isProcessing) {
            return res.status(409).json({ 
                error: 'Process already running' 
            });
        }

        try {
            if (!workerManager) {
                workerManager = new WorkerManager({
                    instanceCount: config.WORKERS.INSTANCE_COUNT,
                    ipList: config.SMPP.IP_LIST,
                    port: config.SMPP.PORT,
                    gsmNumbers: appState.gsmNumbers,
                    credentials: {
                        system_id: config.SMPP.SYSTEM_ID,
                        password: config.SMPP.PASSWORD
                    },
                    batchConfig: {
                        size: config.BATCH.SIZE,
                        sleepMs: appState.sleepMs
                    },
                    messageConfig: {
                        source_addr: appState.sender,
                        message_text: appState.message
                    }
                });

                workerManager.onComplete(() => {
                    appState.isProcessing = false;
                    appState.sender = null;
                    appState.message = null;
                    appState.gsmNumbers = [];
                    console.log('All messages processed and workers terminated');
                    workerManager = null;
                    broadcastStatus(clients, appState);
                });
            }

            appState.isProcessing = true;
            await workerManager.startProcessing();
            res.json({ 
                success: true, 
                message: 'Started sending messages' 
            });
        } catch (err) {
            appState.isProcessing = false;
            res.status(500).json({ 
                success: false, 
                message: 'Failed to start processing',
                error: err.message 
            });
        }
    });

    // Pause processing route
    app.post('/pause', (req, res) => {
        if (!appState.isProcessing) {
            return res.status(409).json({ 
                error: 'No process is currently running' 
            });
        }
        
        if (!workerManager) {
            return res.status(400).json({ 
                error: 'Worker manager not initialized' 
            });
        }

        try {
            workerManager.pauseProcessing();
            appState.isProcessing = false;
            res.json({ 
                success: true, 
                message: 'Processing paused successfully' 
            });
        } catch (err) {
            res.status(500).json({ 
                success: false, 
                message: 'Failed to pause processing',
                error: err.message 
            });
        }
    });

    // Resume processing route
    app.post('/resume', (req, res) => {
        if (appState.isProcessing) {
            return res.status(409).json({ 
                error: 'Process is already running' 
            });
        }
        
        if (!workerManager) {
            return res.status(400).json({ 
                error: 'Worker manager not initialized' 
            });
        }

        try {
            workerManager.resumeProcessing();
            appState.isProcessing = true;
            res.json({ 
                success: true, 
                message: 'Processing resumed successfully' 
            });
        } catch (err) {
            res.status(500).json({ 
                success: false, 
                message: 'Failed to resume processing',
                error: err.message 
            });
        }
    });

    // Stop processing route
    app.post('/stop', async (req, res) => {
        if (!workerManager) {
            return res.status(400).json({ 
                error: 'Worker manager not initialized' 
            });
        }

        try {
            await workerManager.closeAllWorkers();
            workerManager = null;
            appState.isProcessing = false;
            res.json({ 
                success: true, 
                message: 'Processing stopped and workers terminated' 
            });
        } catch (err) {
            res.status(500).json({ 
                success: false, 
                message: 'Failed to stop processing',
                error: err.message 
            });
        }
    });

    // Status route
    app.get('/status', (req, res) => {
        if (!workerManager) {
            return res.json({
                status: 'idle',
                message: 'No active worker manager',
                numbersProcessed: 0,
                totalNumbers: appState.gsmNumbers.length,
                progress: '0%',
                currentMessage: appState.message,
                sender: appState.sender,
                timestamp: new Date().toISOString()
            });
        }

        const status = workerManager.getStatus();
        res.json({
            status: status.isProcessing ? 'processing' : (status.paused ? 'paused' : 'idle'),
            numbersProcessed: status.numbersProcessed,
            totalNumbers: appState.gsmNumbers.length,
            progress: appState.gsmNumbers.length > 0 
                ? (status.numbersProcessed / appState.gsmNumbers.length * 100).toFixed(2) + '%'
                : '0%',
            currentMessage: appState.message,
            sender: appState.sender,
            batchCounter: status.batchCounter,
            currentIndex: status.currentIndex,
            timestamp: new Date().toISOString()
        });
    });

    // Add multer error handling middleware
    app.use(handleMulterErrors);
}

module.exports = {
    configureRoutes,
    sendStatusUpdate,
    broadcastStatus,
    workerManager
};