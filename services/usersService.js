const functions = require("../utils/functions");
const bcrypt = require('bcrypt');
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');
const tokenCache = new NodeCache({ stdTTL: 28.800 });

let userService = {
    register: function (email, nickname, password) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        id
                    FROM
                        users
                    WHERE
                        email = ?
                    OR
                        nickname = ?
                `, [email, nickname]
            ).then((results) => {
                if (results.length > 0) {
                    reject("Nickname ou email indisponível");
                } else {                    
                    bcrypt.hash(password, 10, (errBcrypt, hash) => {
                        if (errBcrypt) {
                            reject(errBcrypt);
                        }

                        functions.executeSql(
                            `
                                INSERT INTO
                                    users
                                    (nickname, email, password, profile_photo, banner_photo)
                                VALUES
                                    (?, ?, ?, ?, ?)
                            `, [
                                nickname, 
                                email, 
                                hash, 
                                process.env.URL_API + '/public/default-user-image.png',
                                process.env.URL_API + '/public/default-banner-image.png'
                            ]
                        ).then((results2) => {

                            let createdUser = {
                                id: results2.insertId,
                                email: email
                            }

                            resolve(createdUser);
                        }).catch((error2) => {
                            reject(error2);
                        })
                    });
                }
            }).catch((error) => {
                reject(error);
            })        
        })
    },
    login: function (email, password) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        users
                    WHERE
                        email = ?
                `, [email]
            ).then((results) => {
                if (results.length < 1) {
                    reject("Falha na autenticação");
                } else {
                    bcrypt.compare(password, results[0].password, (error2, result) => {
                        if (error2) {
                            reject("Falha na autenticação");
                        }

                        if (result) {
                            let token = jwt.sign({
                                id: results[0].id,
                                email: results[0].email,
                                nickname: results[0].nickname
                            }, 
                            process.env.JWT_KEY,
                            {
                                expiresIn: "8h"
                            })

                            resolve(token);
                        }

                        reject("Falha na autenticação");
                    });
                }
            }).catch((error) => {
                reject(error);
            })
        })
    },
    checkJwt: function (tokenParam) {
        return new Promise((resolve, reject) => {
            let token = tokenParam.split(" ")[1];
            jwt.verify(token, process.env.JWT_KEY, (err, decoded) => {
                if (err) {
                    reject("Token inválido");
                } else {
                    let newToken = jwt.sign({
                        id: decoded.id,
                        email: decoded.email,
                        nickname: decoded.nickname
                    }, process.env.JWT_KEY, {expiresIn: "8h"});

                    tokenCache.set(decoded.id, newToken);
                    tokenCache.del(token);
                    
                    resolve(newToken);
                }
            })
        })
    },
    returnUser: function (user_id, return_email = true, requesting_user = null) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        u.id,
                        u.nickname,
                        u.email,
                        u.profile_photo,
                        u.banner_photo,
                        u.create_date,
                        u.visibility,
                        COUNT(DISTINCT f.id) AS friends,
                        GROUP_CONCAT(DISTINCT CASE
                            WHEN f.friend1 = u.id THEN f.friend2
                            ELSE f.friend1
                        END) AS friend_ids,
                        COUNT(DISTINCT p.id) AS posts,
                        CASE WHEN (SELECT COUNT(id) FROM blocked_users WHERE blocking_user = ${user_id} AND blocked_user = ${requesting_user} OR blocking_user = ${requesting_user} AND blocked_user = ${user_id}) > 0 THEN 1 ELSE 0 END AS blocked,
                        CASE WHEN (SELECT COUNT(id) FROM blocked_users WHERE blocking_user = ${requesting_user} AND blocked_user = ${user_id}) > 0 THEN 1 ELSE 0 END AS requesting_user_has_blocked
                    FROM
                        users u
                    LEFT JOIN
                        friends f ON f.friend1 = u.id OR f.friend2 = u.id
                    LEFT JOIN
                        posts p ON p.creator_id = u.id
                    WHERE
                        u.id = ?
                `, [user_id], true, 60
            ).then((results) => {
                functions.executeSql(
                    `
                        SELECT
                            u.id,
                            u.nickname,
                            u.profile_photo,
                            (
                                SELECT
                                    COUNT(id)
                                FROM
                                    friends
                                WHERE
                                    friend1 = u.id OR friend2 = u.id
                            ) AS friends
                        FROM 
                            users u
                        INNER JOIN
                            friends f ON (f.friend1 = u.id OR f.friend2 = u.id)
                        WHERE
                            (f.friend1 = ? OR f.friend2 = ?)
                            AND u.id != ?
                    `, [user_id, user_id, user_id]
                ).then((results2) => {
                    let user = {
                        id: results[0].id,
                        nickname: results[0].nickname,
                        nick_at_sign: "@" + results[0].nickname,
                        email: return_email ? results[0].email : "",
                        profile_photo: results[0].blocked == 1 ? process.env.URL_API + '/public/default-user-image.png' : results[0].profile_photo,
                        banner_photo: results[0].blocked == 1 ? process.env.URL_API + '/public/default-banner-image.png' : results[0].banner_photo,
                        create_date: results[0].create_date,
                        visibility: results[0].visibility,
                        friends: results[0].friends,
                        friend_ids: results[0].friend_ids ? results[0].friend_ids.split(",") : [],
                        posts: results[0].posts,
                        friends_objects: results2,
                        blocked: results[0].blocked,
                        requesting_user_has_blocked: results[0].requesting_user_has_blocked
                    }
    
                    resolve(user);
                }).catch((error) => {
                    reject(error);
                })
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = userService;