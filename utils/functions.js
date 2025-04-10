const mysql = require("../mysql").pool;
const NodeCache = require('node-cache');
const cache = new NodeCache();
const crypto = require('crypto');

let queriesQuantity = 0;
let queriesServedByCache = 0;

let functions = {
    executeSql: function (query, queryParams = [], useCache = false, cacheSeconds = 60) {
        return new Promise((resolve, reject) => {
            let cacheKey = query + JSON.stringify(queryParams);
            const cachedResult = cache.get(cacheKey);

            if (useCache && cachedResult !== undefined) {
                queriesServedByCache++;
                resolve(cachedResult);
            } else {
                mysql.getConnection((error, conn) => {
                    if (error) {
                        reject(error);
                        return;
                    }

                    conn.query("SET time_zone = '-03:00';");
        
                    conn.query(query, queryParams, (err, results) => {
                        conn.release();
                        if (err) {
                            reject(err);
                            return;
                        }
        
                        cacheKey = query + JSON.stringify(queryParams);
    
                        if (useCache) {
                            cache.set(cacheKey, results, cacheSeconds);
                        } else {
                            if (cache.has(cacheKey)) {
                                cache.del(cacheKey);
                            }
                        }
    
                        queriesQuantity++;    
                        resolve(results);
                    });
                });
            }
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
    },
    generateToken: function () {
        const randomPart = crypto.randomBytes(5).toString('hex').substring(0, 10);
        const timestamp = new Date().toISOString().replace(/\D/g, '').substring(0, 14);
        const token = `${randomPart.slice(0, 5)}${timestamp}${randomPart.slice(5)}`;

        return token;
    },
    insertCompanyPreference: function (company_id, preference_code) {
        this.executeSql(
            `
                DELETE FROM
                    config_companies_preferences
                WHERE
                    company_id = ?
                AND
                    preference_id = (SELECT id FROM preferences WHERE code = ?)
            `, [company_id, preference_code]
        )
    },
    insertCompanyPreference: function (company_id, preference_code, active) {
        return new Promise((resolve, reject) => {
            this.executeSql(
                `
                    SELECT
                        *
                    FROM 
                        config_companies_preferences
                    WHERE
                        company_id = ? AND preference_id = (SELECT id FROM preferences WHERE code = ?)
                `, [company_id, preference_code]
            ).then((results) => {
                if (results.length > 0) {
                    this.executeSql(
                        `
                            UPDATE 
                                config_companies_preferences
                            SET 
                                active = ?
                            WHERE
                                id = ?
                        `, [active, results[0].id]
                    ).then(() => {
                        resolve();
                    }).catch((error) => {
                        reject(error);
                    })
                } else {
                    this.executeSql(
                        `
                            INSERT INTO
                                config_companies_preferences
                                (company_id, preference_id, active)
                            VALUES
                                (?, (SELECT id FROM preferences WHERE code = ?), ?)
                        `, [company_id, preference_code, active]
                    ).then(() => {
                        resolve();
                    }).catch((error) => {
                        reject(error);
                    })
                }
            })
        })
    },
    getCompanyPreference: function (company_id, preference_code) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        p.*
                    FROM
                        preferences p
                    INNER JOIN
                        config_companies_preferences ccp ON ccp.preference_id = p.id AND p.code = ?
                    WHERE
                        ccp.company_id = ?
                `, [preference_code, company_id], true, 60
            ).then((results) => {
                resolve(results[0]);
            })
        })
    }
}

module.exports = functions;