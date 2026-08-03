/* ==================================================================
   Service worker do Doutor Detrânsito

   Serve para o sistema abrir INSTANTANEAMENTE e continuar funcionando
   sem internet — você consegue abrir um caso salvo, ler a peça,
   baixar o .docx e imprimir mesmo sem sinal. Só a geração por IA
   precisa de conexão, porque depende da Anthropic.

   Estratégia:
   - a própria página: rede primeiro, cache como reserva (assim uma
     versão nova aparece assim que houver internet, sem ficar presa
     numa cópia velha);
   - ícones e manifesto: cache primeiro (não mudam).

   Nunca guardamos em cache as chamadas de IA nem nada do Supabase:
   são dados do caso e não podem ficar parados numa cópia.
   ================================================================== */
const VERSAO = 'doutor-detransito-v5.2';

// ATENÇÃO: aqui no site, o APP instalado é o "ferramenta.html" (é o
// start_url do manifest) — o "index.html" é a página de vendas. Por isso
// esta lista difere da do sw.js da raiz do projeto, onde o próprio
// index.html é a ferramenta. Se trocar de lugar, o app offline abre a
// página de vendas em vez do sistema.
const APP = './ferramenta.html';
const ESSENCIAIS = [
  './',
  './index.html',
  APP,
  './manifest.webmanifest',
  './icone-192.png',
  './icone-512.png',
  './icone-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSAO)
      .then((c) => Promise.allSettled(ESSENCIAIS.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // fora do nosso site (IA, Supabase, fontes, cotação) passa direto, sem cache
  if (url.origin !== self.location.origin) return;

  const ehPagina = req.mode === 'navigate' || /\.html?$/i.test(url.pathname) || url.pathname.endsWith('/') || /manifest\.webmanifest$/i.test(url.pathname);

  if (ehPagina) {
    // rede primeiro: a versão nova chega assim que houver internet
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(VERSAO).then((c) => c.put(req, copia)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req).then((r) => {
          if (r) return r;
          // Sem internet e sem cópia desta página: o app cai na ferramenta,
          // o navegador cai na página de vendas.
          const ehApp = /ferramenta\.html$/i.test(url.pathname) || req.mode === 'navigate' && !/index\.html$/i.test(url.pathname) && url.pathname !== '/';
          return caches.match(ehApp ? APP : './index.html');
        }))
    );
    return;
  }

  // demais arquivos nossos (ícones, manifesto): cache primeiro
  e.respondWith(
    caches.match(req).then((r) => r || fetch(req).then((resp) => {
      const copia = resp.clone();
      caches.open(VERSAO).then((c) => c.put(req, copia)).catch(() => {});
      return resp;
    }))
  );
});
