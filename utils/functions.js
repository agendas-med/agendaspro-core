const mysql = require("../mysql").pool;

const NodeCache = require('node-cache');

const cache = new NodeCache();

let queriesQuantity = 0;
let queriesServedByCache = 0;

let functions = {
    executeSql: function (query, queryParams = [], useCache = false, cacheSeconds = 60) {
        return new Promise((resolve, reject) => {
            // Verifica se o resultado está em cache, se useCache for verdadeiro
            if (useCache) {
                const cacheKey = query + JSON.stringify(queryParams);
                const cachedResult = cache.get(cacheKey);

                if (cachedResult !== undefined) {
                    queriesServedByCache++;
                    resolve(cachedResult);
                }
            }
    
            mysql.getConnection((error, conn) => {
                if (error) {
                    reject(error);
                    return;
                }
    
                conn.query(query, queryParams, (err, results) => {
                    conn.release();
                    if (err) {
                        reject(err);
                        return;
                    }
    
                    // Armazena o resultado em cache se useCache for verdadeiro
                    if (useCache) {
                        const cacheKey = query + JSON.stringify(queryParams);
                        cache.set(cacheKey, results, cacheSeconds);
                    }

                    queriesQuantity++;    
                    resolve(results);
                });
            });
        });
    },
    createResponse: function (message, returnObj, request_type, request_status) {
        let response = {
            message: message,
            returnObj: returnObj,
            request: {
                type: request_type.toUpperCase(),
                status: request_status
            }
        }

        return response;
    }
}

module.exports = functions;