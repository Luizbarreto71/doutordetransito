// =====================================================================
//  Backend seguro (Vercel Function) — análise por IA (Anthropic).
//  Endereço público: /api/analisar   (POST, JSON)
//
//  A chave da Anthropic NUNCA vai para o navegador: fica na variável de
//  ambiente ANTHROPIC_API_KEY do projeto na Vercel.
//
//  Variáveis de ambiente (Vercel → Project Settings → Environment Variables):
//
//    ANTHROPIC_API_KEY  (obrigatória) sua chave sk-ant-...
//
//    ALLOWED_ORIGINS    (opcional) domínios do seu site, separados por
//                       vírgula. Ex.: https://seusite.vercel.app
//
//  Esta função repassa o streaming (SSE) da Anthropic direto ao navegador,
//  para o texto ir aparecendo enquanto é gerado.
// =====================================================================

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const MODELOS_PERMITIDOS = ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];

export default {
  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Método não permitido." }, 405);

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return json(
        { error: "Servidor sem chave configurada. Defina ANTHROPIC_API_KEY nas variáveis de ambiente da Vercel." },
        500
      );
    }

    // Trava simples de origem (opcional): bloqueia chamadas de outros sites.
    const allowed = (process.env.ALLOWED_ORIGINS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length) {
      const origin = request.headers.get("origin") || "";
      const referer = request.headers.get("referer") || "";
      if (!allowed.some((a) => origin.startsWith(a) || referer.startsWith(a))) {
        return json({ error: "Origem não autorizada." }, 403);
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Corpo da requisição inválido (JSON)." }, 400);
    }

    // Sanitiza e limita o que o cliente pode pedir (evita abuso/custo descontrolado).
    const model = MODELOS_PERMITIDOS.includes(payload.model) ? payload.model : "claude-sonnet-5";
    const max_tokens = Math.min(Math.max(parseInt(payload.max_tokens, 10) || 8000, 256), 32000);

    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      return json({ error: "Requisição sem mensagens." }, 400);
    }

    const body = {
      model,
      max_tokens,
      stream: true,
      system: payload.system,
      messages: payload.messages,
    };
    if (payload.output_config && model !== "claude-haiku-4-5") body.output_config = payload.output_config;
    if (payload.thinking && model !== "claude-haiku-4-5") body.thinking = payload.thinking;

    // Permite APENAS a ferramenta de busca na web (para manter a fundamentação
    // atualizada). Qualquer outra ferramenta é ignorada por segurança/custo.
    if (Array.isArray(payload.tools)) {
      const safe = payload.tools.filter(
        (t) => t && typeof t.type === "string" && t.type.startsWith("web_search")
      );
      if (safe.length) body.tools = safe;
    }

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json({ error: "Falha ao contatar a IA: " + e.message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Repassa o streaming (SSE) direto ao navegador — sem bufferizar.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  },
};
