// config.js
module.exports = {
    serverPort : 3333,
    SMPP: {
        IP_LIST: [
            '10.10.52.18',
            '10.10.52.19',
            '10.10.52.20',
            '10.10.52.21',
            '10.10.52.22',
            '10.10.52.23',
            '10.10.52.23'
        ],
        PORT: 5001,
        SYSTEM_ID: 'lbtest',
        PASSWORD: '123456',
        AUTO_ENQUIRE_LINK_PERIOD: 10000
    },
    FILES: {
        GSM_FILE: 'gsms.txt'
    },
    WORKERS: {
        INSTANCE_COUNT: 14
    },
    BATCH: {
        SIZE: 14,  
    }
};




