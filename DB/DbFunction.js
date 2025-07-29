// const oracledb = require("oracledb");
// const dbConfig = require("./DbConfig");

// async function withSingleConnection(callback) {
//   let connection;
//   try {
//     connection = await oracledb.getConnection(dbConfig);
//     const result = await callback(connection);
//     return result;
//   } catch (err) {
//     console.error('Database error:', err);
//     throw err;
//   } finally {
//     if (connection) {
//       try {
//         await connection.close();
//       } catch (err) {
//         console.error('Error closing connection:', err);
//       }
//     }
//   }
// }

// async function getPeakTps() {
//   try {
//     const result = await withSingleConnection(async (conn) => {
//       return await conn.execute(
//         `SELECT PEAK_TPS 
//         FROM (
//             SELECT * 
//             FROM CHANNEL_LICENSE_STATISTICS 
//             WHERE TRUNC(datetime) = TRUNC(SYSDATE) 
//               AND MODULE_IDENTIFIER = 'IM'  
//               AND peak_tps IS NOT NULL 
//             ORDER BY DATETIME DESC
//         ) 
//         WHERE ROWNUM = 1`,
//         [],
//         { outFormat: oracledb.OUT_FORMAT_OBJECT }
//       );
//     });
    
//     console.log(result.rows[0].PEAK_TPS);
//     return result.rows;
//   } catch (err) {
//     console.error('Error in getPeakTps:', err);
//     throw err;
//   }
// }

// getPeakTps().catch(console.error);

// module.exports = {getPeakTps};