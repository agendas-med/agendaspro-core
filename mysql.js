require('./config/env');
const mysql = require('mysql');
const { resolveDatabaseConfig, connectionLimit } = require('./config/database');

// MYSQL_* explícitas ou URL de add-on (JAWSDB_MARIA_URL/DATABASE_URL); ver config/database.js.
const { host, port, user, password, database } = resolveDatabaseConfig();

let pool = mysql.createPool({
    user,
    password,
    database,
    host,
    port,
    connectionLimit: connectionLimit(),
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
