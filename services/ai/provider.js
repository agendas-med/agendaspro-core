// Provedor de IA atrás de uma interface mínima (texto -> JSON estrito). Nada aqui conhece
// regras de negócio: orçamento, guarda e validação ficam em services/ai/client.js.
//
// Interface de provider:
//   name: string
//   chat({ model, messages:[{role,content}], maxTokens, schema:{name,schema}, timeoutMs })
//     -> { content: string, usage: { input, output }, model }
//   embed?({ model, input:[string] }) -> { vectors:[Float32Array], usage:{ input } }
//
// Implementações: OpenAI (SDK oficial, chat.completions + json_schema strict) e stub para testes.
// Sem OPENAI_API_KEY (e sem provider injetado) a IA fica desligada: getProvider() devolve null.

const DEFAULT_MODEL = 'gpt-6-luna';
const chatModel = () => process.env.OPENAI_MODEL_DEFAULT || DEFAULT_MODEL;
const embeddingModel = () => process.env.OPENAI_EMBEDDING_MODEL || null;

// Heroku corta a requisição em 30 s: timeout * (1 + retries) + backoff fica abaixo de ~25 s.
function timeouts() {
  const timeoutMs = Math.min(Math.max(Number(process.env.AI_TIMEOUT_MS) || 10000, 1000), 12000);
  const retries = Math.min(Math.max(Number.isFinite(Number(process.env.AI_MAX_RETRIES)) ? Number(process.env.AI_MAX_RETRIES) : 1, 0), 1);
  return { timeoutMs, retries };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = error => {
  const status = Number(error?.status);
  return status === 429 || status >= 500 || error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET';
};
const isTimeout = error => error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(error?.message || ''));

// client: objeto compatível com o SDK da OpenAI ({ chat: { completions: { create } }, embeddings? }).
function createOpenAIProvider({ client, apiKey = process.env.OPENAI_API_KEY, baseURL = process.env.OPENAI_BASE_URL } = {}) {
  let api = client || null;
  const sdk = () => {
    if (api) return api;
    const { OpenAI } = require('openai');
    const { timeoutMs } = timeouts();
    api = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), timeout: timeoutMs, maxRetries: 0 });
    return api;
  };

  async function withRetry(fn) {
    const { retries } = timeouts();
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= retries || !retryable(error)) throw Object.assign(error, { timeout: isTimeout(error) });
        attempt++;
        await sleep(300 * attempt);
      }
    }
  }

  return {
    name: 'openai',
    async chat({ model = chatModel(), messages, maxTokens = 200, schema, timeoutMs }) {
      const request = {
        model,
        messages,
        max_completion_tokens: maxTokens,
        ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } } } : {}),
      };
      const options = timeoutMs ? { timeout: timeoutMs } : undefined;
      const response = await withRetry(() => sdk().chat.completions.create(request, options));
      const usage = response?.usage || {};
      return {
        content: response?.choices?.[0]?.message?.content || '',
        usage: {
          input: Number(usage.prompt_tokens) || 0,
          output: Number(usage.completion_tokens) || 0,
          total: Number(usage.total_tokens) || (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0),
        },
        model: response?.model || model,
      };
    },
    async embed({ model = embeddingModel(), input }) {
      if (!model) throw Object.assign(new Error('OPENAI_EMBEDDING_MODEL não configurado.'), { code: 'embedding_disabled' });
      const response = await withRetry(() => sdk().embeddings.create({ model, input }));
      return {
        vectors: (response?.data || []).map(item => Float32Array.from(item.embedding || [])),
        usage: { input: Number(response?.usage?.prompt_tokens) || 0 },
      };
    },
  };
}

// Stub determinístico para testes: handler(request) -> { content, usage? } | string | objeto (vira JSON).
function createStubProvider(handler) {
  const calls = [];
  return {
    name: 'stub',
    calls,
    async chat(request) {
      calls.push(request);
      const out = await handler(request, calls.length);
      if (out instanceof Error) throw out;
      const content = typeof out === 'string' ? out : out && 'content' in out ? out.content : JSON.stringify(out ?? {});
      const usage = out && out.usage ? out.usage : { input: 100, output: 20 };
      return { content: typeof content === 'string' ? content : JSON.stringify(content), usage: { total: usage.input + usage.output, ...usage }, model: request.model || chatModel() };
    },
    async embed({ input }) {
      calls.push({ embed: input });
      return { vectors: input.map(() => new Float32Array(8)), usage: { input: input.length } };
    },
  };
}

let override = null;
let cached = null;

function getProvider() {
  if (override) return override;
  if (!process.env.OPENAI_API_KEY) return null;
  if (!cached) cached = createOpenAIProvider();
  return cached;
}

// Testes: injeta um provider (ou null para voltar ao padrão por ambiente).
function setProvider(provider) {
  override = provider || null;
  cached = null;
}

module.exports = { createOpenAIProvider, createStubProvider, getProvider, setProvider, chatModel, embeddingModel, timeouts, DEFAULT_MODEL };
