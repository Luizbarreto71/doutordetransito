// =====================================================================
//  Backend seguro (Vercel Function) — consulta de veículo via Infosimples.
//  Endereço público: /api/consulta   (POST, JSON)
//
//  Na Vercel, o caminho vem do nome do arquivo: api/consulta.js -> /api/consulta
//
//  O TOKEN NUNCA vai para o navegador: fica em variável de ambiente.
//
//  -------------------------------------------------------------------
//  REGRA DE OURO — ESTE SITE NUNCA COLETA SENHA DO GOV.BR
//  -------------------------------------------------------------------
//  O FAQ, os Termos de Uso e a Política de Privacidade do site prometem
//  publicamente: "não pedimos e não aceitamos a sua senha do gov.br".
//  Este arquivo faz essa promessa valer no servidor:
//
//    1. A consulta usa APENAS placa + Renavam (+ código de segurança do
//       CRLV, quando o Detran do estado exigir). Nada de CPF ou senha.
//    2. Se alguma requisição chegar com campo de credencial
//       (login_senha, senha, password...), ela é RECUSADA na porta.
//    3. Por isso o endpoint da Infosimples precisa ser um que funcione
//       só com dados do veículo (ex.: consulta de Detran estadual).
//       Ele é configurado por variável de ambiente — sem padrão embutido,
//       para nunca cair por engano num endpoint que exija login.
//
//  Variáveis de ambiente (Vercel → Project Settings → Environment Variables):
//
//    INFOSIMPLES_TOKEN     (obrigatória) seu token da Infosimples.
//
//    INFOSIMPLES_ENDPOINT  (obrigatória) URL completa do endpoint que
//                          consulta por placa + renavam. O caminho exato
//                          está no seu painel em api.infosimples.com.
//                          Ex.: https://api.infosimples.com/api/v2/consultas/detran/se/veiculo
//
//    INFOSIMPLES_EXTRA     (opcional) parâmetros fixos em formato de query
//                          string. Ex.: uf=SE
//
//    ALLOWED_ORIGINS       (MUITO recomendada) domínios do seu site,
//                          separados por vírgula. Cada consulta é PAGA —
//                          sem isso, qualquer site gasta o seu saldo.
// =====================================================================

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Resultado tem dado pessoal: não pode ficar em cache em lugar nenhum.
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "pragma": "no-cache",
    },
  });
}

// Campos de identificação do veículo que o navegador pode mandar.
const CAMPOS_SIMPLES = ["placa", "renavam", "chassi", "codigo_seguranca"];

// Qualquer um destes no corpo = tentativa de mandar credencial. Recusar.
const CAMPOS_PROIBIDOS = ["login_senha", "login_cpf", "senha", "password", "cpf", "certificado"];

const RE_PLACA = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/; // ABC1234 e ABC1D23

// A consulta raspa o site do órgão e é lenta. Na Vercel esta função pode durar
// até 180s (ver vercel.json), então damos folga de verdade para a Infosimples.
const TIMEOUT_INFOSIMPLES = 120;

export default {
  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Método não permitido." }, 405);

    const token = process.env.INFOSIMPLES_TOKEN;
    const endpoint = process.env.INFOSIMPLES_ENDPOINT;
    if (!token || !endpoint) {
      return json(
        { error: "Consulta automática ainda não configurada. Defina INFOSIMPLES_TOKEN e INFOSIMPLES_ENDPOINT nas variáveis de ambiente da Vercel." },
        503
      );
    }

    // Trava de origem: cada chamada custa dinheiro.
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

    // Regra de ouro: credencial na requisição = recusa imediata.
    for (const campo of CAMPOS_PROIBIDOS) {
      if (campo in payload) {
        return json(
          { error: "Esta consulta não usa senha nem CPF — apenas placa e Renavam. Nunca informe a sua senha do gov.br." },
          400
        );
      }
    }

    // ---- Validação ANTES de gastar uma chamada paga ----
    const placa = String(payload.placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const renavam = String(payload.renavam || "").replace(/\D/g, "");

    if (!RE_PLACA.test(placa)) {
      return json({ error: "Placa inválida. Use o formato ABC1234 ou ABC1D23." }, 400);
    }
    if (!/^\d{9,11}$/.test(renavam)) {
      return json({ error: "Renavam inválido. Informe de 9 a 11 dígitos." }, 400);
    }

    // ---- Monta o corpo ----
    const form = new URLSearchParams();
    form.set("token", token);
    form.set("timeout", String(TIMEOUT_INFOSIMPLES));
    form.set("placa", placa);
    form.set("renavam", renavam);

    for (const campo of CAMPOS_SIMPLES) {
      if (campo === "placa" || campo === "renavam") continue;
      const v = payload[campo];
      if (typeof v === "string" && v.trim()) {
        form.set(campo, v.trim().replace(/[^\w.\-]/g, "").slice(0, 64));
      }
    }

    // Parâmetros fixos configurados por você. Não podem sobrescrever o token,
    // os dados do veículo nem contrabandear credencial.
    if (process.env.INFOSIMPLES_EXTRA) {
      const proibidos = new Set(["token", "placa", "renavam", ...CAMPOS_PROIBIDOS]);
      for (const [k, v] of new URLSearchParams(process.env.INFOSIMPLES_EXTRA)) {
        if (!proibidos.has(k)) form.set(k, v);
      }
    }

    const ctrl = new AbortController();
    const corta = setTimeout(() => ctrl.abort(), (TIMEOUT_INFOSIMPLES + 5) * 1000);

    let dados;
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: ctrl.signal,
      });
      dados = await resp.json();
    } catch (e) {
      const demorou = e.name === "AbortError";
      return json(
        {
          error: demorou
            ? "O sistema do órgão demorou demais para responder. Tente de novo em alguns minutos."
            : "Falha ao contatar o serviço de consulta: " + e.message,
        },
        504
      );
    } finally {
      clearTimeout(corta);
      form.delete("token");
    }

    if (dados && typeof dados === "object") {
      // "header" traz nome do token, preço e assinatura — dado interno de
      // faturamento. E "parameters" ecoa os campos enviados. Nada disso
      // pode chegar ao navegador.
      delete dados.header;
      delete dados.parameters;
    }

    return json(dados, 200);
  },
};
