const axios = require('axios');

const productionUrl = 'https://api.asaas.com/api/v3';
const sandboxUrl = 'https://sandbox.asaas.com/api/v3';

const baseUrl = process.env.ENVIRONMENT === 'production' 
    ? productionUrl 
    : sandboxUrl;

console.log(`[Asaas Config] Conectando ao ambiente: ${process.env.ENVIRONMENT || 'default (sandbox)'}. URL: ${baseUrl}`);

const asaasAPI = axios.create({
    baseURL: baseUrl, 
    headers: {
        'Content-Type': 'application/json',
        'access_token': process.env.ASAAS_API_KEY 
    }
});

module.exports = asaasAPI;