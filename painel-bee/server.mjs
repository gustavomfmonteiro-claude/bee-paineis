// Painel Bee: o Radar Operacional (torre-operacional) servido localmente, lendo a API da Bee
// a cada REFRESH_MINUTES. Somente GET na API. Sem dependências (Node 20+). Uso: node server.mjs
//
// A página (public/radar.html) foi feita para o banco do artefato (window.claude.use('db'):
// live/geral|drogasil|pmef|americanas|demais, controle/status, controle/pedido). Aqui um adaptador
// injetado no HTML emula esse banco com /api/eventos (SSE) e /api/atualizar.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarEnvio, ErroEnvio } from './whatsapp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const cfg = (k, padrao) => process.env[k] || env[k] || padrao; // variável de ambiente (Docker) vence o .env
const REFRESH_MS = Number(cfg('REFRESH_MINUTES', 10)) * 60e3;
const PORT = Number(cfg('PORT', 3040));
const CACHE = path.join(DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }), ...a);

// Franquias do seletor do topo. A primeira é a principal: só ela tem observação, lojas selecionadas e WhatsApp.
// `caixa` descarta coordenada errada; `mapa` é o enquadramento quando há poucos pontos.
const FRANQUIAS = [
  { chave: 'fortaleza', id: 7, nome: 'FORTALEZA/CE', rotulo: 'Fortaleza', titulo: 'Fortaleza/CE', cidadeBase: 'fortaleza', caixa: { la0: -4.2, la1: -3.3, lo0: -38.9, lo1: -38.2 }, mapa: { la0: -3.89, la1: -3.69, lo0: -38.65, lo1: -38.43 } },
  { chave: 'campinas', id: 90, nome: 'CAMPINAS/SP', rotulo: 'Campinas', titulo: 'Campinas/SP', cidadeBase: 'campinas', caixa: { la0: -23.3, la1: -22.5, lo0: -47.6, lo1: -46.6 }, mapa: { la0: -23.02, la1: -22.78, lo0: -47.22, lo1: -46.95 } },
  { chave: 'itaitinga', id: 220, nome: 'CPTA - ITAITINGA/CE', rotulo: 'Itaitinga', titulo: 'Itaitinga/CE', cidadeBase: 'itaitinga', caixa: { la0: -4.2, la1: -3.3, lo0: -38.9, lo1: -38.2 }, mapa: { la0: -4.05, la1: -3.9, lo0: -38.62, lo1: -38.46 } },
];
const sessao = {};
// Campinas e Itaitinga: o login do Radar só enxerga Fortaleza. BEE_API_TOKEN_FRANQUIAS é o token de uma sessão aberta
// no site da Bee (como faz a extensão bee-export): sem login, para não derrubar quem está lá. Nada nesta sessão
// alcança Fortaleza, o WhatsApp ou a atribuição de entregas, que seguem no login próprio.
// BEE_API_USERNAME_FRANQUIAS é a alternativa com login, pedida pelo usuário: como cada login derruba a sessão no site,
// o Radar só lê essas franquias enquanto alguém está com uma delas aberta, e refaz o login no máximo a cada 10 min.
const tokenOutras = cfg('BEE_API_TOKEN_FRANQUIAS');
const loginOutras = !tokenOutras && cfg('BEE_API_USERNAME_FRANQUIAS') ? { usuario: cfg('BEE_API_USERNAME_FRANQUIAS'), senha: cfg('BEE_API_PASSWORD_FRANQUIAS') } : {};
const sobDemanda = !!loginOutras.usuario;
const sessaoOutras = tokenOutras ? { token: tokenOutras, semLogin: true } : sobDemanda ? { intervaloLogin: Number(cfg('FRANQUIAS_INTERVALO_LOGIN_MIN', 10)) * 60e3 } : sessao;
const baseColetor = {
  base: cfg('BEE_API_BASE_URL'),
  usuario: cfg('BEE_API_USERNAME'),
  senha: cfg('BEE_API_PASSWORD'),
  cache: CACHE,
  // cancelamentos por agente: arquivos gravados pela torre-cancelamentos (opcional)
  cancelamentos: cfg('CANCELAMENTOS_DIR') ? path.resolve(DIR, cfg('CANCELAMENTOS_DIR')) : null,
  // lojas em observação: ids de merchant separados por vírgula
  observacao: String(cfg('LOJAS_OBSERVACAO', '')).split(',').map((s) => s.trim()).filter(Boolean),
  // lojas que entram no alerta de busca além de sem rede e grupos regionais: ids de merchant separados por vírgula
  alertaLojas: String(cfg('ALERTA_LOJAS', '')).split(',').map((s) => s.trim()).filter(Boolean),
};
// O coletor guarda o estado em variáveis do módulo: `?f=` dá uma cópia independente para cada franquia.
for (const [i, f] of FRANQUIAS.entries()) {
  f.col = await import('./radar-coletor.mjs?f=' + f.id);
  f.col.configurar({ ...baseColetor, franquia: f, sessao: i ? sessaoOutras : sessao, ...(i ? { ...loginOutras, cancelamentos: null, observacao: [], alertaLojas: [] } : {}) });
}
const principal = FRANQUIAS[0], outras = FRANQUIAS.slice(1);
const { coletar, buscandoSemRede, entregadoresProximos, detalheAlerta, lerPedido, entregasAbertas, atribuirEntrega } = principal.col;
const franquiaDe = (url) => FRANQUIAS.find((f) => f.chave === url.searchParams.get('franquia')) || principal;

// Botão de WhatsApp: só aparece com token, location e tag do Workflow no .env. Sem senha, por decisão do usuário (04/11/2026)
const whatsapp = criarEnvio({
  base: cfg('GHL_BASE_URL', 'https://services.leadconnectorhq.com'),
  pit: cfg('GHL_PIT'),
  locationId: cfg('GHL_LOCATION_ID'),
  tag: cfg('GHL_TAG'),
  arquivo: path.join(CACHE, 'whatsapp-envios.jsonl'),
  arquivoOfertas: path.join(CACHE, 'whatsapp-ofertas.json'),
  chaveWebhook: cfg('GHL_WEBHOOK_CHAVE'),
  // igual ao tempo limite da ação do Workflow: depois disso o botão não aciona mais o webhook
  validadeOfertaMs: Number(cfg('WHATSAPP_VALIDADE_MIN', 5)) * 60e3,
  // Tolerância depois do prazo: "Sim" ainda atribui, por este tempo, se a entrega seguir em Buscando. Com 0, só avisa que expirou.
  respostaTardiaMs: Number(cfg('WHATSAPP_TARDIA_MIN', 20)) * 60e3,
  limiteAbertas: Number(cfg('WHATSAPP_LIMITE_ABERTAS', 3)),
  blocoPorEntrega: Number(cfg('WHATSAPP_BLOCO_POR_ENTREGA', 10)),
  pausaBlocoMs: Number(cfg('WHATSAPP_PAUSA_BLOCO_MIN', 2)) * 60e3,
  limiteGhl10s: Number(cfg('WHATSAPP_GHL_POR_10S', 80)),
  pausaAposAtribuirMs: Number(cfg('WHATSAPP_PAUSA_MIN', 15)) * 60e3,
  limiteHora: Number(cfg('WHATSAPP_LIMITE_HORA', 60)),
  esperaStatusMs: Number(cfg('WHATSAPP_ESPERA_MS', 24000)),
  intervaloStatusMs: Number(cfg('WHATSAPP_INTERVALO_MS', 4000)),
  log,
});
const COD_HTTP = { telefone: 422, repetido: 409, ocupado: 423, limite: 429, pausa: 429, recusado: 502, token: 502, ghl: 502 };
// Envio automático: 1 liga. Sem isso, só o botão manual envia.
const WHATSAPP_AUTO = whatsapp.ativo && cfg('WHATSAPP_AUTO') === '1';
// Minutos de busca até a primeira oferta: lojas de ALERTA_LOJAS têm prazo próprio, as demais seguem em 5.
const WHATSAPP_MIN_LOJAS = Number(cfg('WHATSAPP_MIN_LOJAS', 1));
const limiteOferta = (x) => (x.classe === 'loja' ? WHATSAPP_MIN_LOJAS : 5);
// Americanas aparece no alerta, com o botão manual; a oferta automática só com WHATSAPP_AUTO_AMERICANAS=1.
const WHATSAPP_AUTO_AMERICANAS = cfg('WHATSAPP_AUTO_AMERICANAS') === '1';

// ---------- estado (documentos que a página lê)
const SEGMENTOS = ['geral', 'drogasil', 'pmef', 'americanas', 'demais'];
const ultimoDe = (f) => path.join(CACHE, f === principal ? 'ultimo.json' : `ultimo-${f.chave}.json`);
for (const f of FRANQUIAS) {
  f.docs = { 'controle/status': null, 'controle/pedido': null };
  try { const u = JSON.parse(fs.readFileSync(ultimoDe(f), 'utf8')); for (const s of SEGMENTOS) f.docs['live/' + s] = u[s] || null; } catch {}
}
const docs = principal.docs, ULTIMO = ultimoDe(principal);

let coletando = false, ultimaTentativa = 0, seguidas = 0, timer = null, adiada = null;

async function rodar() {
  if (coletando) return;
  coletando = true;
  ultimaTentativa = Date.now();
  clearTimeout(adiada);
  log('coleta iniciada');
  try {
    const r = await coletar();
    for (const s of SEGMENTOS) docs['live/' + s] = r[s];
    fs.writeFileSync(ULTIMO, JSON.stringify(Object.fromEntries(SEGMENTOS.map((s) => [s, r[s]]))));
    seguidas = 0;
    docs['controle/status'] = { estado: 'ok', em: new Date().toISOString() };
    log('coleta ok:', r.resumo);
  } catch (e) {
    seguidas++;
    const erro = String(e?.message || e).slice(0, 160);
    docs['controle/status'] = { estado: 'falha', em: new Date().toISOString(), seguidas, limite: /429/.test(erro), erro };
    log('coleta falhou:', erro);
  } finally {
    coletando = false;
    agendar();
    emitir(Object.keys(docs));
    rodarOutras();
  }
}

// Campinas e Itaitinga: logo depois da principal, aproveitando a mesma leitura de /orders. Só as que estão
// selecionadas no login; falha ou falta de acesso aqui nunca afeta Fortaleza.
let ativas = null, rodandoOutras = false, repetirOutras = false, sessaoExpirada = false;
const temViewer = (f) => [...clientes.values()].includes(f);
async function rodarOutras() {
  if (rodandoOutras) { repetirOutras = true; return; }
  const alvo = outras.filter((f) => !sobDemanda || temViewer(f));
  if (!alvo.length) return;
  rodandoOutras = true;
  try {
    try { ativas = await outras[0].col.franquiasAtivas(); sessaoExpirada = false; } catch (e) {
      sessaoExpirada = e?.message === outras[0].col.ERRO_SESSAO;
      log('franquias ativas falhou:', e?.message);
    }
    for (const f of alvo) {
      f.coletadaEm = Date.now();
      const agora = new Date().toISOString();
      if (sessaoExpirada) { f.docs['controle/status'] = { estado: 'sessao-expirada', em: agora }; }
      else if (!ativas) { f.docs['controle/status'] = { estado: 'falha', em: agora, proxima_em: new Date(Date.now() + REFRESH_MS).toISOString(), erro: 'franquias ativas indisponíveis' }; }
      else if (!ativas.includes(f.id)) { f.docs['controle/status'] = { estado: 'sem-acesso', em: agora }; }
      else {
        try {
          const r = await f.col.coletar();
          for (const s of SEGMENTOS) f.docs['live/' + s] = r[s];
          fs.writeFileSync(ultimoDe(f), JSON.stringify(Object.fromEntries(SEGMENTOS.map((s) => [s, r[s]]))));
          f.docs['controle/status'] = { estado: 'ok', em: new Date().toISOString() };
          log(`coleta ${f.chave} ok:`, r.resumo);
        } catch (e) {
          const erro = String(e?.message || e).slice(0, 160);
          f.docs['controle/status'] = { estado: 'falha', em: new Date().toISOString(), proxima_em: new Date(Date.now() + REFRESH_MS).toISOString(), limite: /429/.test(erro), erro };
          log(`coleta ${f.chave} falhou:`, erro);
        }
      }
      emitir(Object.keys(f.docs), f);
    }
  } finally {
    rodandoOutras = false;
    if (repetirOutras) { repetirOutras = false; rodarOutras().catch((e) => log('coleta outras falhou:', e?.message)); }
  }
}
async function alertaOutras() {
  for (const f of outras) {
    if ((sobDemanda && !temViewer(f)) || sessaoExpirada || !ativas?.includes(f.id)) continue;
    try { f.docs['live/alerta'] = await f.col.buscandoSemRede(); }
    catch (e) { f.docs['live/alerta'] = { ...(f.docs['live/alerta'] || { lista: [] }), erro: String(e?.message || e).slice(0, 160), erroEm: new Date().toISOString() }; log(`alerta ${f.chave} falhou:`, f.docs['live/alerta'].erro); }
    emitir(['live/alerta'], f);
  }
}

// Alerta "sem rede / grupo regional buscando": leitura rápida (só status 10) a cada ALERTA_SEGUNDOS,
// independente da coleta completa; vira o documento live/alerta.
const ALERTA_MS = Number(cfg('ALERTA_SEGUNDOS', 60)) * 1000;
let alertando = false;
async function rodarAlerta() {
  if (alertando) return;
  alertando = true;
  try {
    const leitura = await buscandoSemRede();
    // não espera: a leitura do alerta não pode ficar presa na atribuição
    if (whatsapp.ativo && whatsapp.webhookAtivo) whatsapp.respostasTardias({ lerPedido, entregasAbertas, atribuirEntrega }).catch((e) => log('whatsapp tardias falhou:', e?.message));
    if (WHATSAPP_AUTO) {
      await whatsapp.rodadaAuto(leitura.lista.filter((x) => WHATSAPP_AUTO_AMERICANAS || x.classe !== 'americanas'), { proximos: entregadoresProximos, detalhe: detalheAlerta, limiteDe: limiteOferta }).catch((e) => log('whatsapp auto falhou:', e?.message));
    }
    leitura.lista = leitura.lista.map((p) => ({ ...p, whatsapp: whatsapp.tentativas(p.id), whatsappRetoma: whatsapp.retomaEm(p.id), whatsappAviso: whatsapp.aviso(p.id) }));
    leitura.whatsappPausaAte = whatsapp.pausaGeralAte();
    docs['live/alerta'] = leitura;
  } catch (e) {
    docs['live/alerta'] = { ...(docs['live/alerta'] || { lista: [] }), erro: String(e?.message || e).slice(0, 160), erroEm: new Date().toISOString() };
    log('alerta falhou:', docs['live/alerta'].erro);
  } finally {
    alertando = false;
    emitir(['live/alerta']);
    alertaOutras().catch((e) => log('alerta outras falhou:', e?.message));
  }
}

// Depois de uma falha (quase sempre 401: outra ferramenta com o mesmo login da API derrubou o
// token no meio da leitura), tenta de novo em 2 min em vez de esperar o ciclo inteiro.
const REPETIR_FALHA_MS = 2 * 60e3;
function agendar() {
  clearTimeout(timer);
  const espera = docs['controle/status']?.estado === 'falha' ? Math.min(REFRESH_MS, REPETIR_FALHA_MS) : REFRESH_MS;
  const proxima = new Date(Date.now() + espera).toISOString();
  if (docs['controle/status']?.estado === 'falha') docs['controle/status'].proxima_em = proxima;
  timer = setTimeout(rodar, espera);
}

// ---------- servidor web
const clientes = new Map();   // resposta SSE -> franquia que a página está vendo
function emitir(chaves, f = principal) {
  const s = `data: ${JSON.stringify(Object.fromEntries(chaves.map((k) => [k, f.docs[k]])))}\n\n`;
  for (const [c, dela] of clientes) if (dela === f) c.write(s);
}

// emula window.claude.use('db') sobre o servidor local; tem de vir antes do script da página
const adaptador = (f) => `<script>
(function () {
  var docs = {}, ouvintes = {};
  function snap(p) { var v = docs[p]; return { exists: v != null, data: function () { return v; } }; }
  function emite(p) { (ouvintes[p] || []).forEach(function (cb) { cb(snap(p)); }); }
  var db = { doc: function (p) { return {
    onSnapshot: function (cb) { (ouvintes[p] = ouvintes[p] || []).push(cb); if (p in docs) cb(snap(p)); return function () {}; },
    set: function () {
      if (p !== 'controle/pedido') return Promise.reject({ code: 'somente-leitura' });
      return fetch('/api/atualizar', { method: 'POST' }).then(function (r) {
        if (!r.ok) throw { code: 'HTTP ' + r.status };
        return r.json();
      }).then(function (j) { docs[p] = j.pedido; emite(p); });
    },
  }; } };
  new EventSource('/api/eventos?franquia=${f.chave}').onmessage = function (e) {
    var d = JSON.parse(e.data);
    Object.keys(d).forEach(function (p) { docs[p] = d[p]; emite(p); });
  };
  window.claude = { use: function () { return Promise.resolve(db); } };
  window.WHATSAPP_ATIVO = ${whatsapp.ativo && f === principal};
  window.WHATSAPP_AUTO = ${WHATSAPP_AUTO && f === principal};
  window.FRANQUIA_ATUAL = ${JSON.stringify({ chave: f.chave, rotulo: f.rotulo, principal: f === principal, mapa: f.mapa, aviso: ['sem-acesso', 'sessao-expirada'].includes(f.docs['controle/status']?.estado) ? f.docs['controle/status'].estado : null })};
})();
</script>
`;
const MARCA = '<script>\nvar SNAP = /*__DADOS__*/null;';
function pagina(f) {
  const tpl = fs.readFileSync(path.join(DIR, 'public', 'radar.html'), 'utf8');
  const snap = f.docs['live/geral'] ? JSON.stringify(Object.fromEntries(SEGMENTOS.map((s) => [s, f.docs['live/' + s]]))).replace(/</g, '\\u003c') : 'null';
  const seletor = FRANQUIAS.map((x) => `<a href="/?franquia=${x.chave}"${x === f ? ' aria-current="page"' : ''}>${x.rotulo}</a>`).join('');
  return tpl
    .replace('<!--FRANQUIAS-->', () => seletor)
    .replace('Franquia Fortaleza/CE · API ao vivo', () => `Franquia ${f.titulo} · API ao vivo`)
    .replace('<title>Radar Operacional Bee</title>', () => `<title>Radar Operacional Bee${f === principal ? '' : ' · ' + f.rotulo}</title>`)
    .replace(MARCA, () => adaptador(f) + '<script>\nvar SNAP = ' + snap + ';');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(pagina(franquiaDe(url)));
  }
  if (url.pathname === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const dela = franquiaDe(url);
    res.write(`data: ${JSON.stringify(Object.fromEntries(Object.entries(dela.docs).filter(([, v]) => v != null)))}\n\n`);
    clientes.set(res, dela);
    // primeira pessoa a abrir a franquia: lê na hora, sem esperar o ciclo
    if (sobDemanda && dela !== principal && Date.now() - (dela.coletadaEm || 0) > 60e3) rodarOutras().then(alertaOutras).catch((e) => log('coleta outras falhou:', e?.message));
    return req.on('close', () => clientes.delete(res));
  }
  if (url.pathname === '/api/atualizar' && req.method === 'POST') {
    // "Atualizar agora": coleta na hora, mas no máximo uma por minuto (a leitura leva ~2 min)
    if (!coletando) {
      const pedido = { pedido_em: new Date().toISOString() };
      for (const f of FRANQUIAS) { f.docs['controle/pedido'] = pedido; emitir(['controle/pedido'], f); }
      const espera = Math.max(0, 60e3 - (Date.now() - ultimaTentativa));
      clearTimeout(adiada);
      adiada = setTimeout(rodar, espera);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ pedido: docs['controle/pedido'] }));
  }
  if (url.pathname === '/api/proximos') {
    // só para entregas que estão no alerta agora: a rota não vira uma lista aberta de entregadores
    const json = (cod, o) => { res.writeHead(cod, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    const dona = FRANQUIAS.find((f) => (f.docs['live/alerta']?.lista || []).some((p) => String(p.id) === url.searchParams.get('pedido')));
    const x = dona?.docs['live/alerta'].lista.find((p) => String(p.id) === url.searchParams.get('pedido'));
    if (!x) return json(404, { erro: 'Esta entrega não está mais buscando entregador.' });
    if (!x.origem) return json(422, { erro: 'A API não informou a localização da loja neste pedido.' });
    return dona.col.entregadoresProximos(x.origem).then((r) => json(200, { ...r, lista: r.lista.map((e) => ({ ...e, whatsappSituacao: whatsapp.situacao(x.id, e.id) })) }), (e) => { log('proximos falhou:', e.message); json(502, { erro: 'Não foi possível ler os entregadores agora. Tente de novo em instantes.' }); });
  }
  if ((url.pathname === '/api/whatsapp/sim' || url.pathname === '/api/whatsapp/nao') && req.method === 'POST') {
    // Webhook do Workflow do GHL. Responde na hora e processa depois, para o GHL não reenviar por demora.
    const json = (cod, o) => { res.writeHead(cod, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!whatsapp.webhookAtivo) return json(503, { erro: 'não configurado' });
    if (!whatsapp.confereChave(req.headers['x-painel-chave'])) return json(401, { erro: 'não autorizado' });
    let corpo = '', grande = false;
    req.on('data', (c) => { corpo += c; if (corpo.length > 200e3) { grande = true; req.destroy(); } });
    req.on('end', () => {
      if (grande) return;
      let d = {};
      try { d = JSON.parse(corpo); } catch { return json(400, { erro: 'corpo inválido' }); }
      const contato = d.contact_id || d.contactId || d.contact?.id;
      if (!contato) return json(400, { erro: 'sem contato' });
      json(200, { ok: true });
      whatsapp.responder(String(contato), url.pathname.endsWith('/sim') ? 'sim' : 'nao', { lerPedido, entregasAbertas, atribuirEntrega }).catch((e) => log('whatsapp resposta falhou:', e?.message));
    });
    return;
  }
  if (url.pathname === '/api/whatsapp' && req.method === 'POST') {
    const json = (cod, o) => { res.writeHead(cod, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    if (!whatsapp.ativo) return json(503, { erro: 'O envio de WhatsApp não está configurado neste servidor.' });
    let corpo = '', grande = false;
    req.on('data', (c) => { corpo += c; if (corpo.length > 2048) { grande = true; req.destroy(); } });
    req.on('end', async () => {
      if (grande) return;
      try {
        let d;
        try { d = JSON.parse(corpo); } catch { return json(400, { erro: 'Pedido inválido.' }); }
        // destinatário = entregador perto de uma entrega em alerta agora, com o telefone lido da API da Bee
        const x = (docs['live/alerta']?.lista || []).find((p) => String(p.id) === String(d.pedido));
        if (!x) return json(404, { erro: 'Esta entrega não está mais buscando entregador.' });
        if (!x.origem) return json(422, { erro: 'A API não informou a localização da loja neste pedido.' });
        const { lista } = await entregadoresProximos(x.origem);
        const e = lista.find((n) => String(n.id) === String(d.entregador));
        if (!e) return json(404, { erro: 'Este entregador não está mais online a até 3 km da loja.' });
        json(200, await whatsapp.enviar(x.id, e, detalheAlerta(x.id)));
      } catch (e) {
        if (e instanceof ErroEnvio) { log('whatsapp recusado:', e.message); return json(COD_HTTP[e.cod] || 502, { erro: e.cod === 'token' ? 'O GHL recusou o token do painel.' : e.cod === 'ghl' ? 'O GHL não aceitou o envio agora. Tente de novo em instantes.' : e.message }); }
        log('whatsapp falhou:', e?.message);
        json(502, { erro: 'Não foi possível enviar agora. Tente de novo em instantes.' });
      }
    });
    return;
  }
  if (url.pathname === '/api/dados') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...franquiaDe(url).docs, coletando }));
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  log(`Painel Bee (Radar Operacional) em http://localhost:${PORT} — API ${cfg('BEE_API_BASE_URL')} — atualiza a cada ${REFRESH_MS / 60e3} min · alerta de busca a cada ${ALERTA_MS / 1000} s`);
  rodar();
  rodarAlerta();
  setInterval(rodarAlerta, ALERTA_MS);
});
