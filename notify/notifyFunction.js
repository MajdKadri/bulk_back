const axios = require('axios');
const config = require('../config');

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

const sendNotifyingBulkMessage = async ({
    sent,
    remaining,
    bulkSender,
    gsmsCount,
    user,
    sms,
    action
}) => {
    numbers=config.notifyingNumbers;
    const now = new Date();
    const formattedDate = formatDateTime(now);
    console.log(formattedDate);
    switch (action) {
        case 'start':
            notificationMessage = 
            `Bulk started sending with info below:
            sender: ${bulkSender} 
            numbers Count: ${gsmsCount} GSMs 
            SMS: ${sms}
            started at ${formattedDate}
            by user: ${user}`;
            break;
            
        case 'pause':
            notificationMessage = 
            `Bulk paused sending at ${formattedDate}
             sent:${sent}
             remaining:${remaining}
             by user:${user}`;
            break;

            case 'resume':
                notificationMessage = 
                `Bulk resumed sending at ${formattedDate}
                 sent:${sent}
                 remaining:${remaining}
                 by user:${user}`;
                break;
            
        case 'stop':
            notificationMessage = 
            `Bulk stopped sending at ${formattedDate}
            sent:${sent}
            remaining:${remaining}
            by user:${user}`;
            break;
            
        case 'end':
            notificationMessage = 
            `Bulk ended with info below:
            sender: ${bulkSender} 
            numbers Count: ${gsmsCount} GSMs 
            SMS: ${sms}
            ended at ${formattedDate}`;
            break;
            
        default:
            notificationMessage = `Unknown bulk action: ${action}`;
            break;
    }
    
    try {
        // Send notifications in parallel
        await Promise.all(numbers.map(number => 
            sendHTTPNotification(number, 'Bulk', notificationMessage)
        ));
        console.log('All notifications sent successfully');
    } catch (error) {
        console.error('Error sending bulk notifications:', error.message);
    }
};



module.exports = {
    sendNotifyingBulkMessage
};