const axios = require('axios');

const sendHTTPNotification = async (MSISDN, Sender, SMS) => {
    const notificationData = {
        MSISDN,
        Sender,
        SMS
    };

    try {
        const response = await axios.post(
            'http://10.10.52.93:9004/app_engine/production/414dabd0-e203-11ea-b68d-2fdf268fd195', 
            notificationData
        );
        console.log('HTTP Notification response:', response.data);
    } catch (error) {
        console.error('HTTP Notification error:', error.message);
    }
};

const formatDateTime = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const sendStartingBulkMessage = async (numbers, bulkSender, gsmsCount) => {
    const now = new Date();
    const formattedDate = formatDateTime(now);
    console.log(formattedDate);

    const message = 
`Bulk with sender: ${bulkSender} 
to ${gsmsCount} GSMs 
started at ${formattedDate}`;

    try {
        // Send notifications in parallel
        await Promise.all(numbers.map(number => 
            sendHTTPNotification(number, 'Bulk', message)
        ));
        console.log('All notifications sent successfully');
    } catch (error) {
        console.error('Error sending bulk notifications:', error.message);
    }
};

// Example usage
sendStartingBulkMessage([963957222195], "MTN", 10);

module.exports = {
    sendStartingBulkMessage
};