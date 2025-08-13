const express = require('express');
const auth = require('express-ntlm');
const config = require('../config');
const app = express();
const PORT = 4444;

// Proper NTLM configuration
app.use(auth({
    domain: 'MTNSYR',
    domaincontroller: 'ldap://10.11.228.201', // Using IP address
    debug: function() {
        // Convert arguments to real array
        const args = Array.prototype.slice.call(arguments);
        console.log('[NTLM]', ...args);
    },
    // Add error handlers
    badrequest: function(req, res) {
        console.error('Bad NTLM request');
        res.status(400).send('Bad request');
    },
    forbidden: function(req, res) {
        console.error('NTLM authentication failed');
        res.status(403).send('Forbidden');
    }
}));

app.get('/userinfo', (req, res) => {
    if (!req.ntlm) {
        console.error('NTLM authentication missing');
        return res.status(401).json({
            error: "Authentication required",
            solution: "Access from domain-joined PC using IE/Edge"
        });
    }

    console.log('Authenticated user:', req.ntlm.UserName);
    res.json({
        username: req.ntlm.UserName,
        domain: req.ntlm.DomainName,
        workstation: req.ntlm.Workstation,
        clientIp: req.ip,
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Note: Requires domain-joined Windows machine with IE/Edge');
});