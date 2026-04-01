const mysql = require('mysql');

let pool = mysql.createPool({
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    connectionLimit: process.env.MYSQL_CONNECTION_LIMIT || 10,
    multipleStatements: true,
    timezone: '-03:00'
});

exports.pool = pool;
exports.mysql = mysql;