// =====================================================================
//  Backend seguro (Vercel Function) — consulta de infrações via Infosimples.
//  Endereço público: /api/consulta   (POST, JSON)
//
//  Na Vercel, o caminho vem do nome do arquivo: api/consulta.js -> /api/consulta
//
//  O TOKEN NUNCA vai para o navegador: fica em variável de ambiente.
//
//  -------------------------------------------------------------------
//  ATENÇÃO — ESTA FUNÇÃO TRAFEGA A SENHA DO GOV.BR DO CLIENTE
//  -------------------------------------------------------------------
//  O endpoint senatran/infracoes exige o login gov.br do dono do veículo.
//  Não existe alternativa: é assim que o SENATRAN autentica.
//
//  Por isso, as regras abaixo NÃO são opcionais. Quem mexer neste arquivo
//  precisa mantê-las:
//
//    1. A senha é REPASSADA e ESQUECIDA. Nunca gravar em banco, arquivo,
//       log ou cache. Ela só existe na memória durante a requisição.
//    2. NUNCA registrar em log o corpo da requisição ou o form.
//       Os logs da Vercel são legíveis por quem tem acesso ao projeto.
//    3. A resposta vai com no-store: não pode ficar em cache de navegador
//       nem de CDN.
//    4. A senha NÃO passa por sanitização que remova caracteres — isso
//       quebraria senhas legítimas. Ela é enviada exatamente como digitada.
//    5. Erros nunca devem ecoar a senha de volta.
//
//  Variáveis de ambiente (Vercel → Project Settings → Environment Variables):
//
//    INFOSIMPLES_TOKEN     (obrigatória) seu token da Infosimples.
//
//    INFOSIMPLES_ENDPOINT  (opcional) sobrescreve o endpoint padrão.
//                          Padrão: senatran/infracoes
//
//    INFOSIMPLES_EXTRA     (opcional) parâmetros fixos em formato de query
//                          string. Ex.: cnpj=12345678901234
//
//    CONSULTA_ANOS         (opcional) quantos anos para trás buscar.
//                          Padrão 3 (o máximo que o SENATRAN devolve).
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

const ENDPOINT_PADRAO = "https://api.infosimples.com/api/v2/consultas/senatran/infracoes";

// Campos de identificação do veículo que o navegador pode mandar.
// A senha é tratada à parte, de propósito (ver regra 4 acima).
const CAMPOS_SIMPLES = ["placa", "renavam", "chassi", "codigo_seguranca"];

const RE_PLACA = /^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/; // ABC1234 e ABC1D23

// A consulta raspa o portal do gov.br e é lenta. Na Vercel a função pode durar
// até 300s (ver vercel.json), então damos folga de verdade para a Infosimples.
// No Netlify isto tinha que ser 22s, e consulta lenta virava erro na cara do cliente.
const TIMEOUT_INFOSIMPLES = 120;

const ddmmaaaa = (d) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

// Valida CPF de verdade (dígitos verificadores). Cada consulta é paga:
// não vale a pena gastar chamada com CPF digitado errado.
function cpfValido(cpf) {
  const d = String(cpf).replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (base, peso) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (peso - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10]);
}

export default {
  async fetch(request) {
    if (request.method !== "POST") return json({ error: "Método não permitido." }, 405);

    const token = process.env.INFOSIMPLES_TOKEN;
    if (!token) {
      return json(
        { error: "Consulta automática ainda não configurada. Defina INFOSIMPLES_TOKEN nas variáveis de ambiente da Vercel." },
        503
      );
    }
    const endpoint = process.env.INFOSIMPLES_ENDPOINT || ENDPOINT_PADRAO;

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

    // ---- Validação ANTES de gastar uma chamada paga ----
    const placa = String(payload.placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const renavam = String(payload.renavam || "").replace(/\D/g, "");
    const loginCpf = String(payload.login_cpf || "").replace(/\D/g, "");
    const loginSenha = typeof payload.login_senha === "string" ? payload.login_senha : "";

    if (!RE_PLACA.test(placa)) {
      return json({ error: "Placa inválida. Use o formato ABC1234 ou ABC1D23." }, 400);
    }
    if (!/^\d{9,11}$/.test(renavam)) {
      return json({ error: "Renavam inválido. Informe de 9 a 11 dígitos." }, 400);
    }
    if (!cpfValido(loginCpf)) {
      return json({ error: "CPF inválido. Confira os números digitados." }, 400);
    }
    if (!loginSenha) {
      return json({ error: "Informe a senha do gov.br para a consulta." }, 400);
    }

    // ---- Monta o corpo ----
    const form = new URLSearchParams();
    form.set("token", token);
    form.set("timeout", String(TIMEOUT_INFOSIMPLES));
    form.set("placa", placa);
    form.set("renavam", renavam);
    form.set("login_cpf", loginCpf);
    // Regra 4: a senha vai EXATAMENTE como o cliente digitou. URLSearchParams
    // já faz o escape correto para o corpo. Não filtrar caracteres aqui.
    form.set("login_senha", loginSenha);

    // Período: o SENATRAN aceita até ~3 anos para trás.
    const anos = Math.min(Math.max(parseInt(process.env.CONSULTA_ANOS, 10) || 3, 1), 3);
    const hoje = new Date();
    const inicio = new Date(hoje);
    inicio.setFullYear(inicio.getFullYear() - anos);
    form.set("data_inicio", ddmmaaaa(inicio));
    form.set("data_fim", ddmmaaaa(hoje));

    for (const campo of CAMPOS_SIMPLES) {
      if (campo === "placa" || campo === "renavam") continue;
      const v = payload[campo];
      if (typeof v === "string" && v.trim()) {
        form.set(campo, v.trim().replace(/[^\w.\-]/g, "").slice(0, 64));
      }
    }

    // Parâmetros fixos configurados por você. Não podem sobrescrever o token
    // nem as credenciais.
    if (process.env.INFOSIMPLES_EXTRA) {
      const proibidos = new Set(["token", "placa", "renavam", "login_cpf", "login_senha"]);
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
      // Regra 5: só a mensagem do erro, nunca o corpo (que tem a senha).
      const demorou = e.name === "AbortError";
      return json(
        {
          error: demorou
            ? "O portal do gov.br demorou demais para responder. Tente de novo em alguns minutos."
            : "Falha ao contatar o serviço de consulta: " + e.message,
        },
        504
      );
    } finally {
      clearTimeout(corta);
      // A senha sai da memória junto com o form ao fim da requisição.
      form.delete("login_senha");
      form.delete("token");
    }

    if (dados && typeof dados === "object") {
      // "header" traz nome do token, preço e assinatura — dado interno de
      // faturamento. E "parameters" ecoa os campos enviados, incluindo hash
      // da senha. Nada disso pode chegar ao navegador.
      delete dados.header;
      delete dados.parameters;
    }

    return json(dados, 200);
  },
};
