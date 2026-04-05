const axios = require("axios");

const ASAAS_URL =
  process.env.ASAAS_ENV === "production"
    ? "https://api.asaas.com/v3"
    : "https://sandbox.asaas.com/api/v3";

// Helper para alternar entre a sua API Key Principal e a API Key da Subconta (Empresa)
const getHeaders = (apiKey) => ({
  access_token: apiKey || process.env.ASAAS_API_KEY,
  "Content-Type": "application/json",
});

const asaasService = {
  // ---------------------------------------------------------------------------
  // 1. CRIAÇÃO DE SUBCONTA (Chamado com sua API Key Principal)
  // ---------------------------------------------------------------------------
  createSubaccount: async function (companyData) {
    try {
      const cleanCep = companyData.cep
        ? companyData.cep.replace(/\D/g, "")
        : null;
      if (!cleanCep)
        throw new Error("CEP é obrigatório para criar a subconta.");

      // Busca os dados do endereço no ViaCEP
      const viaCepResponse = await axios.get(
        `https://viacep.com.br/ws/${cleanCep}/json/`,
      );
      if (viaCepResponse.data.erro)
        throw new Error("CEP inválido ou não encontrado.");

      const addressFromCep = viaCepResponse.data;
      const document = companyData.cnpj_cpf.replace(/\D/g, "");

      const payload = {
        name: companyData.name,
        email: companyData.email,
        loginEmail: companyData.email,
        cpfCnpj: document,
        mobilePhone: companyData.phone.replace(/\D/g, ""),
        postalCode: cleanCep,
        address: addressFromCep.logradouro,
        addressNumber: companyData.address_number || "S/N",
        complement: companyData.complement || "",
        province: addressFromCep.bairro,
        incomeValue: parseFloat(companyData.incomeValue),
      };

      // Regras do Asaas para tipo de pessoa
      if (document.length === 11) {
        if (!companyData.birthDate)
          throw new Error(
            "Data de nascimento é obrigatória para pessoa física.",
          );
        payload.birthDate = companyData.birthDate; // Formato YYYY-MM-DD
      } else if (document.length === 14) {
        if (!companyData.companyType)
          throw new Error(
            "Tipo de empresa (MEI, LTDA, etc) é obrigatório para pessoa jurídica.",
          );
        payload.companyType = companyData.companyType;
      }

      const response = await axios.post(`${ASAAS_URL}/accounts`, payload, {
        headers: getHeaders(process.env.ASAAS_API_KEY), // Sempre usa a API principal aqui
      });

      // Retorna a Wallet e a API Key exclusivas dessa empresa
      return {
        walletId: response.data.walletId,
        apiKey: response.data.apiKey,
      };
    } catch (error) {
      console.error(
        "[Asaas Error - Create Subaccount]:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // 2. CRIAÇÃO DE CLIENTE (Chamado com a API Key da Subconta)
  // ---------------------------------------------------------------------------
  getOrCreateCustomer: async function (clientData, subaccountApiKey) {
    try {
      const cleanCpf = clientData.cpf
        ? clientData.cpf.replace(/\D/g, "")
        : null;
      const cleanPhone = clientData.tel
        ? clientData.tel.replace(/\D/g, "")
        : null;

      // Busca se o cliente já existe na subconta
      if (cleanCpf) {
        const search = await axios.get(
          `${ASAAS_URL}/customers?cpfCnpj=${cleanCpf}`,
          {
            headers: getHeaders(subaccountApiKey),
          },
        );
        if (search.data.data.length > 0) {
          return search.data.data[0].id;
        }
      }

      const payload = {
        name: clientData.name || "Cliente AgendasPRO",
        cpfCnpj: cleanCpf || undefined,
        email: clientData.email || undefined,
        mobilePhone: cleanPhone || undefined,
      };

      const response = await axios.post(`${ASAAS_URL}/customers`, payload, {
        headers: getHeaders(subaccountApiKey),
      });

      return response.data.id;
    } catch (error) {
      console.error(
        "[Asaas Error - Get/Create Customer]:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // 3. PIX FRENTE DE CAIXA COM SPLIT DE 5% (Chamado com a API Key da Subconta)
  // ---------------------------------------------------------------------------
  createPixCharge: async function (args, subaccountApiKey) {
    try {
      if (args.value < 5) {
        throw new Error(
          "O valor mínimo para gerar um Pix no Asaas é de R$ 5,00.",
        );
      }

      // 1. Gera a data de hoje no formato YYYY-MM-DD exigido pelo Asaas
      const today = new Date().toISOString().split("T")[0];

      // 2. Monta o payload garantindo os tipos de dados corretos
      const payload = {
        customer: args.customerAsaasId,
        billingType: "PIX",
        value: parseFloat(args.value), // Garante que seja um número (Float)
        dueDate: today, // OBRIGATÓRIO: Mesmo sendo imediato, exige vencimento
        description: args.description,
        externalReference: args.externalReference,
      };

      // 3. RASTREIO: Imprime no terminal o que está a ser enviado para o Asaas
      console.log(
        "[Asaas Rastreio - Payload Pix]:",
        JSON.stringify(payload, null, 2),
      );

      const response = await axios.post(`${ASAAS_URL}/payments`, payload, {
        headers: getHeaders(subaccountApiKey),
      });

      const qrCodeResponse = await axios.get(
        `${ASAAS_URL}/payments/${response.data.id}/pixQrCode`,
        { headers: getHeaders(subaccountApiKey) },
      );

      if (!qrCodeResponse.data.encodedImage || !qrCodeResponse.data.payload) {
        throw new Error(
          "O QR Code não foi gerado. A conta do Asaas pode estar restrita ou em análise.",
        );
      }

      return {
        paymentId: response.data.id,
        payload: qrCodeResponse.data.payload,
        expirationDate: qrCodeResponse.data.expirationDate,
      };
    } catch (error) {
      console.error(
        "[Asaas Error - Create Pix]:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },

  // ---------------------------------------------------------------------------
  // 4. LINK DE PAGAMENTO WHATSAPP COM SPLIT DE 5% (Chamado com API Key Subconta)
  // ---------------------------------------------------------------------------
  createPaymentLink: async function (args, subaccountApiKey) {
    try {
      const payload = {
        customer: args.customerAsaasId,
        billingType: "UNDEFINED",
        value: args.value,
        dueDate: new Date(new Date().getTime() + 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
        externalReference: args.externalReference,
        description: args.description,
        split: [
          {
            walletId: process.env.ASAAS_MAIN_WALLET_ID,
            percentualValue: 5,
          },
        ],
      };

      const response = await axios.post(`${ASAAS_URL}/payments`, payload, {
        headers: getHeaders(subaccountApiKey),
      });

      return {
        paymentId: response.data.id,
        url: response.data.invoiceUrl,
      };
    } catch (error) {
      console.error(
        "[Asaas Error - Create Payment Link]:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },
  // ---------------------------------------------------------------------------
  // 5. STATUS DA CONTA E ONBOARDING (Chamado com API Key Subconta)
  // ---------------------------------------------------------------------------
  getAccountStatus: async function (subaccountApiKey) {
    try {
      const statusResponse = await axios.get(`${ASAAS_URL}/myAccount/status`, {
        headers: getHeaders(subaccountApiKey),
      });

      const status = statusResponse.data.general;
      let onboardingUrl = "https://www.asaas.com/login";

      if (status !== "APPROVED") {
        const docsResponse = await axios.get(
          `${ASAAS_URL}/myAccount/documents`,
          {
            headers: getHeaders(subaccountApiKey),
          },
        );

        console.log(docsResponse.data.data);

        const pendingDocs = docsResponse.data.data || [];
        const docWithLink = pendingDocs.find((doc) => doc.onboardingUrl);

        if (docWithLink) {
          onboardingUrl = docWithLink.onboardingUrl;
        }
      }

      return {
        status: status,
        onboardingUrl: onboardingUrl,
      };
    } catch (error) {
      console.error(
        "[Asaas Error - Get Status]:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },
  // ---------------------------------------------------------------------------
  // 6. CONFIGURAÇÃO DE WEBHOOK (Chamado com API Key Subconta)
  // ---------------------------------------------------------------------------
  createWebhook: async function (subaccountApiKey) {
    try {
      const webhookUrl = process.env.WEBHOOK_URL;

      if (!webhookUrl) {
        console.log(
          "[Asaas] Aviso: WEBHOOK_URL não definida. Ignorando criação do Webhook.",
        );
        return null;
      }

      const payload = {
        name: "Webhook AgendasPRO", 
        url: webhookUrl,
        email: process.env.USER_EMAIL || "sistema.agendaspro@gmail.com",
        sendType: "NON_SEQUENTIALLY", 
        events: ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"],
        enabled: true,
        interrupted: false
      };

      const response = await axios.post(`${ASAAS_URL}/webhooks`, payload, {
        headers: getHeaders(subaccountApiKey),
      });

      return response.data;
    } catch (error) {
      console.error(
        "[Asaas Error - Create Webhook]:",
        error.response?.data || error.message,
      );
      throw error;
    }
  },
};

module.exports = asaasService;
