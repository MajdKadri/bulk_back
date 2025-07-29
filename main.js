const config = require('./config');
const express = require('express');
const app = express();
const WebSocket = require('ws');
const http = require('http');
const routes = require('./routes');
const cors = require('cors');

// Add this after creating the express app but before defining routes
app.use(cors({
  origin: ['http://10.11.209.117:3000','http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization',]
}));
// Initialize app state
const appState = {
    gsmNumbers: [],
    message: null,
    isProcessing: false,
    sender: null,
    tps:1,
    messagePartsCount:1,
    sleepMs:12000/this.tps,
};

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket connections management
const clients = new Set();
// In main.js
wss.on('connection', (ws) => {
    clients.add(ws);
    
    // Send initial status when a client connects
    routes.sendStatusUpdate(ws, appState);
    
    // Set up interval to send status updates every second
    const statusInterval = setInterval(() => {
      routes.sendStatusUpdate(ws, appState);
    }, 1000);
    
    ws.on('close', () => {
      clients.delete(ws);
      clearInterval(statusInterval);
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize routes
routes.configureRoutes(app, appState, clients);

// Start server
usedPort = config.serverPort;
server.listen(usedPort, () => {
    console.log(`Server running on port ${usedPort}`);
});

// Handle process termination
process.on('SIGINT', async () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    if (routes.workerManager) {
        await routes.workerManager.closeAllWorkers();
        wss.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    if (routes.workerManager) {
        await routes.workerManager.closeAllWorkers();
        wss.close();
    }
    process.exit(0);
});

// Export for testing if needed
module.exports = { app, server, appState };