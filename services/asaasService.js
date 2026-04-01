// services/asaasService.js
const asaasAPI = require('../config/asaas');
const axios = require('axios'); // Precisamos do axios para a chamada ao ViaCEP
const functions = require("../utils/functions");

const asaasService = {
    /**
     * Cria uma nova Subconta no Asaas, buscando o endereço pelo CEP.
     * @param {object} companyData - O objeto completo da empresa do seu banco de dados.
     * @returns {Promise<object>} Objeto com o walletId e apiKey da subconta criada.
     */
    createSubaccount: async function (companyData) {
        try {
            let subContaExistente = await this.findSubaccountByEmail(companyData.email_requisitado);

            if (subContaExistente) return;

            const cleanCep = companyData.cep.replace(/[^\d]/g, '');
            if (!cleanCep) {
                return "O CEP não foi fornecido.";
            }

            const viaCepResponse = await axios.get(`https://viacep.com.br/ws/${cleanCep}/json/`);

            if (viaCepResponse.data.erro) {
                return `CEP inválido ou não encontrado: ${companyData.cep}`;
            }

            const addressFromCep = viaCepResponse.data;
            const [account, accountDigit] = companyData.conta.split('-');
            const document = companyData.cnpj.replace(/[^\d]/g, '');

            const payload = {
                name: companyData.nome,
                email: companyData.email_requisitado,
                cpfCnpj: document,
                companyType: companyData.tipo_empresa,

                //TODO: Tornar esses campos dinamicos
                birthDate: "1990-10-12",
                incomeValue: companyData.faturamento_mensal || 1000,

                mobilePhone: companyData.telefone.replace(/[^\d]/g, ''),
                phone: companyData.telefone.replace(/[^\d]/g, ''),
                address: addressFromCep.logradouro,
                addressNumber: String(companyData.numero || 'S/N'),
                complement: companyData.complemento,
                province: addressFromCep.bairro,
                postalCode: cleanCep,
                bankAccount: {
                    bank: companyData.banco,
                    accountName: companyData.nome,
                    ownerName: companyData.nome,

                    //TODO: Tornar esses campos dinamicos
                    ownerBirthDate: "1990-10-12",

                    cpfCnpj: document,
                    agency: companyData.agencia,
                    account: account,
                    accountDigit: accountDigit,
                    bankAccountType: "CONTA_CORRENTE"
                }
            };

            console.log("Enviando dados para criar subconta no Asaas:", payload);

            const response = await asaasAPI.post('/accounts', payload);

            if (response.data && response.data.walletId && response.data.apiKey) {
                return {
                    walletId: response.data.walletId,
                    apiKey: response.data.apiKey
                };
            } else {
                return "Resposta da API Asaas não continha walletId ou apiKey.";
            }

        } catch (error) {
            console.error("ERRO ao criar subconta no Asaas:", error.response?.data || error.message);
            return error;
        }
    },
    /**
     * @param {string} email O e-mail a ser pesquisado.
     * @returns {Promise<object|null>} O objeto da conta se encontrada, ou null se não existir.
     */
    findSubaccountByEmail: async function (email) {
        try {
            const response = await asaasAPI.get('/accounts', {
                params: {
                    email: email
                }
            });

            if (response.data && response.data.data.length > 0) {
                return response.data.data[0];
            }

            return null;

        } catch (error) {
            console.error("ERRO ao buscar subconta por e-mail no Asaas:", error.response?.data || error.message);
            throw error;
        }
    },
    createPixKey: async function () {
        try {
            const response = await asaasAPI.post('/pix/addressKeys', { type: "EVP" });

            if (response.data) {
                return response.data;
            }

            return null;
        } catch (error) {
            console.error("ERRO ao criar uma chave pix no Asaas:", error.response?.data || error.message);
            throw error;
        }
    },
    /**
     * Cria uma cobrança Pix com Split de Pagamento configurado.
     * @param {Object} data - Dados da cobrança.
     * @param {string} data.customerId - ID do cliente Asaas (cus_xxxx).
     * @param {number} data.value - Valor total da cobrança.
     * @param {string} data.sellerAccountId - walletId da Subconta Vendedora (98%).
     * @param {string} data.linkedAccountId - walletId da Subconta Vinculada (1%).
     * @param {string} data.mainAccountId - walletId da SUA conta principal (1%).
     * @param {string} data.description - Descrição da cobrança.
     */
    createPixPaymentWithSplit: async function (data) {
        try {
            if (data.value <= 0) {
                throw new Error("O valor da cobrança deve ser maior que zero.");
            }

            // Definindo a data de vencimento para hoje se não for fornecida
            const dueDate = new Date().toISOString().slice(0, 10);

            // Configuração do Split: 98%, 1%, 1%
            const splitConfig = [
                {
                    walletId: data.sellerAccountId, // Empresa Vendedora (Subconta 1)
                    fixedValue: 0, // Não usa valor fixo
                    percentualValue: 98 // Recebe 98% do valor líquido
                },
                {
                    walletId: data.linkedAccountId, // Empresa Vinculada (Subconta 2)
                    fixedValue: 0,
                    percentualValue: 1 // Recebe 1% do valor líquido
                }
            ];

            const payload = {
                customer: data.customerId,
                billingType: "PIX",
                value: data.value,
                dueDate: dueDate,
                description: data.description || "Pagamento com Split",
                split: splitConfig
            };

            const response = await asaasAPI.post('/payments', payload);

            if (response.data && response.data.id) {
                return response.data;
            } else {
                return "Cobrança criada, mas resposta da API incompleta.";
            }

        } catch (error) {
            console.error(
                "ERRO ao criar cobrança Pix com Split:",
                error.response?.data?.errors || error.response?.data || error.message
            );
            throw error;
        }
    },
    /**
     * Insere os dados de uma cobrança Pix na tabela 'pagamentos_asaas' do seu BD.
     * @param {Object} paymentData - O objeto de pagamento retornado pela API Asaas.
     * @param {number} vendaId - O ID da venda no seu sistema.
     */
    insertAsaasPayment: function (paymentData, vendaId) {
        return new Promise((resolve, reject) => {
            // Garantindo que todos os dados essenciais estão presentes
            if (!paymentData || !paymentData.id || !paymentData.customer || !vendaId) {
                return reject(new Error("Dados incompletos para registro no BD."));
            }

            // Você deve ajustar as colunas conforme a sua tabela pagamentos_asaas
            functions.executeSql(
                `
                INSERT INTO
                    pagamentos_asaas
                    (
                        id_venda,
                        asaas_payment_id,
                        asaas_customer_id,
                        valor,
                        status_cobranca,
                        data_vencimento
                    )
                VALUES
                    (?, ?, ?, ?, ?, ?)
            `,
                [
                    vendaId,                                    // id_venda
                    paymentData.id,                             // asaas_payment_id (pay_xxxxxx)
                    paymentData.customer,                       // asaas_customer_id (cus_xxxxxx)
                    paymentData.value,                          // valor
                    'PENDENTE',                                 // status_cobranca inicial
                    paymentData.dueDate                         // data_vencimento
                ]
            )
                .then((results) => {
                    console.log(`Pagamento Asaas ${paymentData.id} registrado no BD.`);
                    resolve(results.insertId);
                })
                .catch((error) => {
                    // Rejeitar se o registro falhar (ex: chave única duplicada)
                    reject(error);
                });
        });
    },
    /**
     * Busca o QR Code (Base64) e o código Pix Copia e Cola.
     * @param {string} paymentId - ID da cobrança (payment_id) retornado.
     */
    getPixQrCode: async function (paymentId) {
        try {
            if (!paymentId) throw new Error("ID de pagamento não fornecido.");

            const response = await asaasAPI.get(`/payments/${paymentId}/pixQrCode`);

            if (response.data && response.data.encodedImage && response.data.payload) {
                return {
                    pix_img: response.data.encodedImage, 
                    pix_key: response.data.payload                       
                };
            } else {
                throw new Error("Erro ao obter dados do QR Code.");
            }
        } catch (error) {
            console.error("ERRO ao buscar QR Code:", error.message);
            throw error;
        }
    },
    /**
     * Busca um cliente Asaas pelo CPF/CNPJ ou E-mail.
     * Utiliza o endpoint /customers com o parâmetro 'query'.
     * @param {string} identifier - CPF/CNPJ ou E-mail do cliente final.
     * @returns {Promise<Object | null>} - O objeto cliente Asaas ou null se não for encontrado.
     */
    findCustomer: async function (identifier) {
        try {
            // GET para /customers com o identificador como parâmetro de query
            const response = await asaasAPI.get('/customers', {
                params: {
                    // O Asaas utiliza 'query' para buscar por email
                    email: identifier // Tenta buscar pelo email
                }
            });

            // O endpoint retorna um objeto com 'data' sendo um array de clientes
            if (response.data && response.data.data.length > 0) {
                // Retorna o primeiro cliente encontrado
                return response.data.data[0];
            }

            return null; // Cliente não encontrado

        } catch (error) {
            console.error(
                "ERRO ao buscar cliente no Asaas:",
                error.response?.data?.errors || error.response?.data || error.message
            );
            // É importante lançar o erro para que a função chamadora saiba da falha
            throw error;
        }
    },

    /**
     * Cria um novo cliente Asaas.
     * @param {Object} clientData - Dados do cliente.
     * @param {string} clientData.name - Nome completo do cliente.
     * @param {string} clientData.email - E-mail do cliente.
     * @param {string} clientData.cpfCnpj - CPF ou CNPJ.
     * @param {string} clientData.phone - Telefone (somente dígitos).
     * @returns {Promise<Object>} - O objeto cliente Asaas criado.
     */
    createCustomer: async function (clientData) {
        try {
            // Remove caracteres especiais dos documentos
            const cpfCnpj = clientData.cpfCnpj.replace(/[^\d]/g, '');
            const phone = clientData.phone.replace(/[^\d]/g, '');

            const payload = {
                name: clientData.name,
                email: clientData.email,
                cpfCnpj: cpfCnpj,
                mobilePhone: phone,
                // Outros campos opcionais podem ser adicionados aqui (ex: address, postalCode)
            };

            console.log("Enviando dados para criar cliente no Asaas:", payload);

            // POST para o endpoint /customers
            const response = await asaasAPI.post('/customers', payload);

            if (response.data && response.data.id) {
                console.log("Cliente Asaas criado com ID:", response.data.id);
                return response.data;
            } else {
                throw new Error("Resposta da API Asaas não continha o ID do cliente.");
            }

        } catch (error) {
            console.error(
                "ERRO ao criar cliente no Asaas:",
                error.response?.data?.errors || error.response?.data || error.message
            );
            throw error;
        }
    }
};

module.exports = asaasService;