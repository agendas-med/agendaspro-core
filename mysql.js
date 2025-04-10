const mysql = require('mysql');

let pool = mysql.createPool({
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    connectionLimit: 8,
    multipleStatements: true,
    timezone: '-03:00'
});

exports.pool = pool;