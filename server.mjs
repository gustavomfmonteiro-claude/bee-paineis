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
import { configurar, coletar, buscandoSemRede, entregadoresProximos, detalheAlerta, lerPedido, entregasAbertas, atribuirEntrega } from './radar-coletor.mjs';
import { criarEnvio, ErroEnvio } from './whatsapp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(fs.readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const cfg = (k, padrao) => process.env[k] || env[k] || padrao; // variável de ambiente (Docker) vence o .env
const REFRESH_MS = Number(cfg('REFRESH_MINUTES', 10)) * 60e3;
const PORT = Number(cfg('PORT', 3040));
const CACHE = path.join(DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }), ...a);

configurar({
  base: cfg('BEE_API_BASE_URL'),
  usuario: cfg('BEE_API_USERNAME'),
  senha: cfg('BEE_API_PASSWORD'),
  cache: CACHE,
  // cancelamentos por agente: arquivos gravados pela torre-cancelamentos (opcional)
  cancelamentos: cfg('CANCELAMENTOS_DIR') ? path.resolve(DIR, cfg('CANCELAMENTOS_DIR')) : null,
  // lojas em observação: ids de merchant separados por vírgula
  observacao: String(cfg('LOJAS_OBSERVACAO', '')).split(',').map((s) => s.trim()).filter(Boolean),
});

// Botão de WhatsApp: só aparece com token, location e tag do Workflow no .env. Sem senha, por decisão do usuário (04/11/2026)
const whatsapp = criarEnvio({
  base: cfg('GHL_BASE_URL', 'https://services.leadconnectorhq.com'),
  pit: cfg('GHL_PIT'),
  locationId: cfg('GHL_LOCATION_ID'),
  tag: cfg('GHL_TAG'),
  arquivo: path.join(CACHE, 'whatsapp-envios.jsonl'),
  arquivoOfertas: path.join(CACHE, 'whatsapp-ofertas.json'),
  chaveWebhook: cfg('GHL_WEBHOOK_CHAVE'),
  validadeOfertaMs: Number(cfg('WHATSAPP_VALIDADE_MIN', 10)) * 60e3,
  limiteAbertas: Number(cfg('WHATSAPP_LIMITE_ABERTAS', 3)),
  limiteHora: Number(cfg('WHATSAPP_LIMITE_HORA', 60)),
  esperaStatusMs: Number(cfg('WHATSAPP_ESPERA_MS', 24000)),
  intervaloStatusMs: Number(cfg('WHATSAPP_INTERVALO_MS', 4000)),
  log,
});
const COD_HTTP = { telefone: 422, repetido: 409, limite: 429, recusado: 502, token: 502, ghl: 502 };

// ---------- estado (documentos que a página lê)
const SEGMENTOS = ['geral', 'drogasil', 'pmef', 'americanas', 'demais'];
const ULTIMO = path.join(CACHE, 'ultimo.json');
const docs = { 'controle/status': null, 'controle/pedido': null };
try { const u = JSON.parse(fs.readFileSync(ULTIMO, 'utf8')); for (const s of SEGMENTOS) docs['live/' + s] = u[s] || null; } catch {}

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
    docs['live/alerta'] = await buscandoSemRede();
  } catch (e) {
    docs['live/alerta'] = { ...(docs['live/alerta'] || { lista: [] }), erro: String(e?.message || e).slice(0, 160), erroEm: new Date().toISOString() };
    log('alerta falhou:', docs['live/alerta'].erro);
  } finally {
    alertando = false;
    emitir(['live/alerta']);
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
const clientes = new Set();
function emitir(chaves) {
  const s = `data: ${JSON.stringify(Object.fromEntries(chaves.map((k) => [k, docs[k]])))}\n\n`;
  for (const c of clientes) c.write(s);
}

// emula window.claude.use('db') sobre o servidor local; tem de vir antes do script da página
const ADAPTADOR = `<script>
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
  new EventSource('/api/eventos').onmessage = function (e) {
    var d = JSON.parse(e.data);
    Object.keys(d).forEach(function (p) { docs[p] = d[p]; emite(p); });
  };
  window.claude = { use: function () { return Promise.resolve(db); } };
  window.WHATSAPP_ATIVO = ${whatsapp.ativo};
})();
</script>
`;
const MARCA = '<script>\nvar SNAP = /*__DADOS__*/null;';
function pagina() {
  const tpl = fs.readFileSync(path.join(DIR, 'public', 'radar.html'), 'utf8');
  const snap = docs['live/geral'] ? JSON.stringify(Object.fromEntries(SEGMENTOS.map((s) => [s, docs['live/' + s]]))).replace(/</g, '\\u003c') : 'null';
  return tpl.replace(MARCA, () => ADAPTADOR + '<script>\nvar SNAP = ' + snap + ';');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(pagina());
  }
  if (url.pathname === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(Object.fromEntries(Object.entries(docs).filter(([, v]) => v != null)))}\n\n`);
    clientes.add(res);
    return req.on('close', () => clientes.delete(res));
  }
  if (url.pathname === '/api/atualizar' && req.method === 'POST') {
    // "Atualizar agora": coleta na hora, mas no máximo uma por minuto (a leitura leva ~2 min)
    if (!coletando) {
      docs['controle/pedido'] = { pedido_em: new Date().toISOString() };
      const espera = Math.max(0, 60e3 - (Date.now() - ultimaTentativa));
      clearTimeout(adiada);
      adiada = setTimeout(rodar, espera);
      emitir(['controle/pedido']);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ pedido: docs['controle/pedido'] }));
  }
  if (url.pathname === '/api/proximos') {
    // só para entregas que estão no alerta agora: a rota não vira uma lista aberta de entregadores
    const json = (cod, o) => { res.writeHead(cod, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
    const x = (docs['live/alerta']?.lista || []).find((p) => String(p.id) === url.searchParams.get('pedido'));
    if (!x) return json(404, { erro: 'Esta entrega não está mais buscando entregador.' });
    if (!x.origem) return json(422, { erro: 'A API não informou a localização da loja neste pedido.' });
    return entregadoresProximos(x.origem).then((r) => json(200, { ...r, lista: r.lista.map((e) => ({ ...e, whatsappEnviado: whatsapp.jaEnviado(x.id, e.id) })) }), (e) => { log('proximos falhou:', e.message); json(502, { erro: 'Não foi possível ler os entregadores agora. Tente de novo em instantes.' }); });
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
    return res.end(JSON.stringify({ ...docs, coletando }));
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  log(`Painel Bee (Radar Operacional) em http://localhost:${PORT} — API ${cfg('BEE_API_BASE_URL')} — atualiza a cada ${REFRESH_MS / 60e3} min · alerta de busca a cada ${ALERTA_MS / 1000} s`);
  rodar();
  rodarAlerta();
  setInterval(rodarAlerta, ALERTA_MS);
});
