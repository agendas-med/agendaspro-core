const { pool, mysql } = require("../mysql");
const NodeCache = require('node-cache');
const cache = new NodeCache();
const crypto = require('crypto');
const util = require('util');

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
                pool.getConnection((error, conn) => {
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
    /**
     * Executa uma série de queries dentro de uma transação MySQL.
     * Garante que todas as operações sejam atômicas (ou todas são bem-sucedidas, ou todas falham).
     * * @param {Array<Object>} queries - Um array de objetos, onde cada objeto contém uma string 'query' e um array de 'queryParams'.
     * @returns {Promise<Array<Object>>} Uma promise que resolve com os resultados de cada query em um array, ou rejeita em caso de erro, desfazendo a transação.
     * * @example
     * // Exemplo de uso para registrar uma venda com múltiplos itens
     * const queriesDeVenda = [
     * {
     * query: "INSERT INTO orders (customer_id, order_date) VALUES (?, NOW())",
     * queryParams: [101]
     * },
     * {
     * query: "UPDATE products SET current_stock = current_stock - ? WHERE id = ?",
     * queryParams: [2, 50] // Saída de 2 unidades do produto de ID 50
     * },
     * {
     * query: "UPDATE products SET current_stock = current_stock - ? WHERE id = ?",
     * queryParams: [1, 51] // Saída de 1 unidade do produto de ID 51
     * }
     * ];
     * * executeTransaction(queriesDeVenda)
     * .then(results => {
     * console.log("Transação concluída com sucesso:", results);
     * })
     * .catch(error => {
     * console.error("Erro na transação:", error);
     * });
     */
    executeTransaction(queries) {
        return new Promise(async (resolve, reject) => {
            queries.push({
                query: "SET time_zone = '-03:00'",
                queryParams: []
            });
            
            let conn;
            try {
                const getConnection = util.promisify(pool.getConnection).bind(pool);
                conn = await getConnection();
                
                const beginTransaction = util.promisify(conn.beginTransaction).bind(conn);
                const query = util.promisify(conn.query).bind(conn);
                const commit = util.promisify(conn.commit).bind(conn);

                await beginTransaction();

                const results = [];

                for (const q of queries) {
                    const rows = await query(q.query, q.queryParams);
                    results.push(rows);
                }

                await commit();
                resolve(results);

            } catch (error) {
                if (conn) {
                    try {
                        const rollback = util.promisify(conn.rollback).bind(conn);

                        await rollback();
                    } catch (rollbackError) {
                        console.error("Erro durante o rollback:", rollbackError);
                    }
                }
                reject(error);
            } finally {
                if (conn) {
                    conn.release();
                }
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
    },
    returnColumn: function (table, value, targetColumn, referenceColumn = "id") {
        return new Promise((resolve, reject) => {


            functions.executeSql(
                `
                    SELECT
                        ${targetColumn}
                    FROM
                        ${table}
                    WHERE
                        ${referenceColumn} = ?
                `, [value]
            ).then((results) => {
                resolve(results[0][targetColumn]);
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = functions;