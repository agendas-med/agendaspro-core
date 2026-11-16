require('./config/env');
const mysql = require('mysql');

let pool = mysql.createPool({
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    host: process.env.MYSQL_HOST,
    port: process.env.MYSQL_PORT,
    connectionLimit: process.env.MYSQL_CONNECTION_LIMIT || 10,
    multipleStatements: false,
    timezone: '-03:00',
    charset: 'utf8mb4',
    // DECIMAL (dinheiro, SUM/AVG) como Number, não string: DECIMAL(12,2) cabe sem perda em double.
    typeCast: (field, next) => {
        if (field.type !== 'NEWDECIMAL') return next();
        const value = field.string();
        return value === null ? null : Number(value);
    },
});

exports.pool = pool;
exports.mysql = mysql;
