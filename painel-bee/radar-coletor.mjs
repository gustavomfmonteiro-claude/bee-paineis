/**
 * Coletor operacional — Bee Delivery Fortaleza
 * --------------------------------------------
 * Lê a API oficial da Bee (somente GET) e monta o acompanhamento do dia:
 * finalizações e cancelamentos por bairro, tempo de aceite, OTD em duas pernas
 * (regra da RD: criação -> chegada à origem; saída da loja -> chegada ao destino,
 * soma das duas <= 2x limite), mapa de calor e entregadores online por modal.
 *
 * Drogasil e demais lojas são o mesmo cálculo em segmentos separados.
 *
 * Saída: db-geral.json, db-drogasil.json, db-pmef.json, db-demais.json (um documento cada no
 * banco do artefato, todos bem abaixo do limite de 256 KiB).
 *
 * Painel Bee: cópia de torre-operacional/coletor.mjs como módulo. O server.mjs chama
 * configurar() uma vez e coletar() a cada ciclo; nada é gravado aqui além do cache de lojas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const TZ = 'America/Fortaleza';
const FRANQUIA = 'FORTALEZA/CE';
const FRANQUIA_ID = 7;
const META_MIN = 15;
const META_AMERICANAS = 30;   // prazo da Americanas por ponta, definido pelo usuário em 03/11/2026
const MAX_PAGINAS = 120;

// ---------------------------------------------------------------- credenciais
// vêm do server.mjs (.env do painel-bee)
let BASE = '', USUARIO = '', SENHA = '', DIR_CACHE = '.', DIR_CANC = null, OBSERVACAO = [], ALERTA_LOJAS = [];
export function configurar(o) {
  BASE = String(o.base || '').replace(/\/+$/, '');
  USUARIO = o.usuario; SENHA = o.senha;
  DIR_CACHE = o.cache; DIR_CANC = o.cancelamentos || null;
  OBSERVACAO = (o.observacao || []).map(String);
  ALERTA_LOJAS = (o.alertaLojas || []).map(String);
}

// ---------------------------------------------------------------------- HTTP
// Contador de requisições por rodada (coleta completa ou alerta). AsyncLocalStorage separa as
// duas mesmo quando rodam ao mesmo tempo. Cada fetch conta uma vez (repetição inclusive);
// "repeticoes" diz quantas delas foram por 401/429/5xx.
const CONTA = new AsyncLocalStorage();
function contar(tipo) { const c = CONTA.getStore(); if (c) { c.total++; c[tipo] = (c[tipo] || 0) + 1; } }
function contarRepeticao() { const c = CONTA.getStore(); if (c) c.repeticoes = (c.repeticoes || 0) + 1; }
const tipoReq = (caminho) => caminho.startsWith('/orders?') ? 'pedidos'
  : /^\/orders\/\d+\/events/.test(caminho) ? 'eventos'
  : caminho.startsWith('/merchants/') ? 'lojas'
  : caminho.startsWith('/dashboard') ? 'entregadores' : 'outros';

let TOKEN = null;
let loginEmVoo = null;
async function login() {
  if (loginEmVoo) return loginEmVoo;
  loginEmVoo = (async () => {
    contar('login');
    const r = await fetch(BASE + '/public/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: USUARIO, password: SENHA }),
    });
    const j = await r.json().catch(() => null);
    TOKEN = j?.data?.token || null;
    if (!TOKEN) throw new Error('login falhou (HTTP ' + r.status + ')');
    return TOKEN;
  })().finally(() => { loginEmVoo = null; });
  return loginEmVoo;
}
async function api(caminho, tentativa = 0) {
  if (!TOKEN) await login();
  contar(tipoReq(caminho));
  const r = await fetch(BASE + caminho, {
    headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' },
  });
  // o mesmo usuário é usado pelo coletor de cancelamentos: um login derruba o outro
  if (r.status === 401 && tentativa < 4) {
    contarRepeticao();
    await new Promise((s) => setTimeout(s, 1500 * (tentativa + 1)));
    TOKEN = null; await login(); return api(caminho, tentativa + 1);
  }
  // 429: a API limita o login (compartilhado com outras torres) — respeita Retry-After
  // e insiste por até ~2,5 min antes de desistir
  if (r.status === 429 && tentativa < 6) {
    contarRepeticao();
    const ra = Number(r.headers.get('retry-after'));
    const espera = isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * 2 ** tentativa;
    await new Promise((s) => setTimeout(s, Math.min(espera, 60000)));
    return api(caminho, tentativa + 1);
  }
  if (r.status >= 500 && tentativa < 3) {
    contarRepeticao();
    await new Promise((s) => setTimeout(s, 1000 * 2 ** (tentativa + 1)));
    return api(caminho, tentativa + 1);
  }
  if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + caminho.slice(0, 60));
  return r.json();
}

// ---------------------------------------------------------------------- tempo
const ymd = (d) => d.toISOString().slice(0, 10);
const localStr = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ });
const localDia = (iso) => (iso ? localStr(iso).slice(0, 10) : null);
const localHora = (iso) => (iso ? Number(localStr(iso).slice(11, 13)) : null);
const minutos = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 60000 : null);
let HOJE = null, DIA = null;   // definidos a cada coleta

// ------------------------------------------------------------------- domínio
const ehDrogasil = (p) => /DROGASIL|RAIA/i.test(p.merchant?.name || '');
// Pague Menos + Extrafarma (mesmo grupo) viram segmento próprio, com o OTD da Drogasil:
// ponta 1 criação → chegada à loja, ponta 2 saída → chegada ao cliente, 15 min cada,
// on time = soma ≤ 30 min. Não têm modalidade no pedido, então o limite vale para todos.
const ehPMEF = (p) => !ehDrogasil(p) && /PAGUE MENOS|EXTRAFARMA/i.test(p.merchant?.name || '');
// Americanas também é segmento próprio: mesmo cálculo de Pague Menos / Extrafarma, com 30 min por ponta (on time = soma ≤ 60).
const ehAmericanas = (p) => /AMERICANAS/i.test(p.merchant?.name || '');

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const titulo = (s) => s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (w) => w.toLowerCase());

// "Rua Costa Freire, 595 - Vila Peri, Fortaleza - CE, 60730135, BR" -> "Vila Peri"
const CIDADES = /,\s*(Fortaleza|Caucaia|Maracana[uú]|Eus[eé]bio|Aquiraz|Itaitinga|Pacatuba|Maranguape|Horizonte|Pacajus)\b/i;
function bairro(endereco) {
  let s = String(endereco || '').replace(/\s+/g, ' ').trim();
  if (!s) return { nome: 'Sem endereço', chave: 'sem endereco' };
  // Três formatos convivem: "Rua, 595 - Bairro, Fortaleza - CE, CEP, BR" (Drogasil),
  // "RUA, 308, BAIRRO, CIDADE - CE" (integrações) e "Cliente | Rua. Nº 55, Bairro".
  let cidade = null;
  const mc = s.match(CIDADES);
  if (mc) { cidade = mc[1]; s = s.slice(0, mc.index); }
  else s = s.replace(/,\s*(BRA?|\d{5}-?\d{3}|CE)\b.*$/i, '').replace(/\s*-\s*CE$/i, '');
  const segs = s.split(',');
  let b = segs.length > 1 || cidade ? segs[segs.length - 1].trim() : '';
  b = b.replace(/\s*\([^)]*$/, '');   // "NOVA METROPOLE (JURE" — parêntese cortado na origem
  if (/\s-\s/.test(b)) b = b.split(/\s+-\s+/).pop().trim();
  if (!b || /^(\d|n[ºo°]\.?\s*\d|casa\b|apto?\b|bloco\b|lote\b|km\b)/i.test(b) || b.length < 3) {
    const partes = s.split(/\s+-\s+/);
    b = partes.length > 1 ? partes[partes.length - 1].split(',')[0].trim() : '';
  }
  if (!b || /^\d/.test(b) || b.length < 3) b = 'Não identificado';
  let nome = titulo(b).replace(/\b(I{1,3}|Iv|Vi{0,3})\b/g, (r) => r.toUpperCase()).replace(/\bIi\b/g, 'II').replace(/\bIii\b/g, 'III');
  if (cidade && !/^fortaleza$/i.test(cidade)) nome += ' (' + titulo(cidade) + ')';
  const chave = semAcento(nome.toLowerCase()).replace(/[^a-z0-9() ]/g, '').replace(/\s+/g, ' ').trim();
  return { nome, chave };
}

function coordsDestino(p) {
  const w = (p.waypoints || []).find((x) => x.type === 'delivery' && x.latitude && x.longitude);
  if (!w) return null;
  const lat = Number(w.latitude), lng = Number(w.longitude);
  if (!isFinite(lat) || !isFinite(lng) || lat > -3.3 || lat < -4.2 || lng > -38.2 || lng < -38.9) return null;
  return [Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4];
}

const inicioBusca = (p) => p.dates?.searching || p.searching || p.dates?.created_at || p.created_at;

// Regra de OTD da RD ("Eficiência Transportadora"), reproduzida número a número contra o
// painel deles em 22/09/2026 (Turbo60: 1.074 entregas, 933 on time, ponta 1 on 912,
// ponta 2 on 920, médias 19:41 / 09:34 / 10:07 / aceite 02:33 / espera 04:35):
//   ponta 1 = created_at -> arrival_at_origin
//   ponta 2 = departure_at_origin -> arrival_at_destination   (released_at dá 743, não 920)
//   on time geral = ponta 1 + ponta 2 <= 2 x limite (não "as duas pontas no prazo")
//   dia = dia da finalização; limite por ponta: Turbo60 15 min, Turbo120 45 min.
// Demais modalidades da Drogasil (D+1, AGENDADO, Turbo90, sem badge) ficam fora do OTD.
// Demais lojas: mesmo cálculo, 15 min por ponta para todo pedido.
const LIMITE_RD = { turbo60: 15, turbo120: 45 };
const modalidade = (p) => { const t = String(p.badges?.type ?? '').trim(); return t && t !== '0' ? t : 'Sem modalidade'; };
function limiteOtd(p, drog) {
  if (ehAmericanas(p)) return META_AMERICANAS;
  if (!drog) return META_MIN;
  return LIMITE_RD[modalidade(p).toLowerCase().replace(/\s+/g, '')] ?? null;
}
function pontas(p) {
  const d = p.dates || {};
  const a = minutos(d.created_at || p.created_at, d.arrival_at_origin);
  const b = minutos(d.departure_at_origin, d.arrival_at_destination);
  if (a == null || b == null || a < 0 || b < 0) return null;
  return {
    a, b,
    aceite: minutos(d.created_at || p.created_at, d.accepted_at),
    chegada: minutos(d.accepted_at, d.arrival_at_origin),
    espera: minutos(d.arrival_at_origin, d.departure_at_origin),
  };
}

function valido(m, teto = 8 * 60) { return m != null && m >= 0 && m <= teto ? m : null; }

// ------------------------------------------------------------------- coleta
// Janela do monitoramento: pedidos CRIADOS no dia, das 00:00 às 23:59 (horário de Fortaleza —
// conferido em 31/10: a API aplica o filtro no horário local). Antes eram 3 dias (ontem a amanhã)
// para pegar o agendado criado na véspera e fechado hoje; trocado a pedido em 31/10 — corta
// ~62 páginas para ~25 num dia cheio. Fechado hoje mas criado ontem fica fora da conta.
async function listarPedidos() {
  const todos = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const qs = new URLSearchParams({
      'filters[created_at][$gte]': DIA + ' 00:00:00',
      'filters[created_at][$lte]': DIA + ' 23:59:59',
      'sort[0]': 'created_at:desc',
      per_page: '100',
      page: String(page),
    });
    const j = await api('/orders?' + qs);
    const itens = Array.isArray(j?.data) ? j.data : [];
    todos.push(...itens);
    if (!itens.length || !j?.links?.next) break;
    await new Promise((s) => setTimeout(s, 400));   // ritmo: o login é compartilhado e a API limita
  }
  const vistos = new Set();
  return todos.filter((p) => (p.franchise?.name || '') === FRANQUIA && !vistos.has(p.id) && vistos.add(p.id));
}

// Classe comercial da loja, lida do cadastro (GET /merchants/{id}) e guardada em cache:
//   key_account PAGUE MENOS/EXTRAFARMA -> 'pmef'; outro key_account -> 'rede';
//   sem key_account e com regional_group -> 'gr'; nenhum dos dois -> 'sr'.
const MERCH = {};
const cacheLojas = () => path.join(DIR_CACHE, 'cache-lojas.json');
const VALIDADE_CACHE = 7 * 86400e3;
async function carregarLojas(pedidos) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheLojas(), 'utf8')); } catch {}
  const ids = [...new Set(pedidos.filter((p) => !ehDrogasil(p)).map((p) => p.merchant?.id).filter(Boolean))];
  const faltam = ids.filter((id) => !cache[id] || Date.now() - cache[id].t > VALIDADE_CACHE);
  let i = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (i < faltam.length) {
      const id = faltam[i++];
      try {
        const d = (await api('/merchants/' + id))?.data || {};
        cache[id] = { ka: d.key_account?.name || null, rg: d.regional_group?.name || null, t: Date.now() };
      } catch { /* loja sem leitura fica sem classe nesta coleta */ }
    }
  }));
  if (faltam.length) fs.writeFileSync(cacheLojas(), JSON.stringify(cache), 'utf8');
  Object.assign(MERCH, cache);
}
function classeLoja(p) {
  const c = MERCH[p.merchant?.id];
  if (!c) return { classe: '?', grupo: null };
  if (c.ka && /PAGUE MENOS|EXTRAFARMA/i.test(c.ka)) return { classe: 'pmef', grupo: c.ka };
  if (c.ka) return { classe: 'rede', grupo: c.ka };
  if (c.rg) return { classe: 'gr', grupo: c.rg };
  return { classe: 'sr', grupo: null };
}

async function entregadoresOnline() {
  if (DIA !== HOJE) return null;
  const j = await api('/dashboard?franchiseId=' + FRANQUIA_ID);
  const x = j?.data || j || {};
  return { od: x.online_deliverymen || {}, hoje: x.today_orders || null };
}

// ------------------------------------------------------------------ análise
const media = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 10) / 10 : null);
const mediana = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);

function segmento(pedidos, drog) {
  const fin = pedidos.filter((p) => p.status === '50' && localDia(p.dates?.finished_at || p.dates?.delivered_at) === DIA);
  const canc = pedidos.filter((p) => p.status === '60' && localDia(p.dates?.cancelled_at) === DIA);
  const ativos = pedidos.filter((p) => !['50', '60'].includes(p.status) && localDia(p.dates?.created_at || p.created_at) === DIA);

  const bairros = new Map();
  const B = (p) => {
    const b = bairro(p.address_destination);
    if (!bairros.has(b.chave)) bairros.set(b.chave, {
      nome: b.nome, fin: 0, canc: 0, aceiteFin: [], aceiteCanc: [], semAceite: 0,
      o1: 0, o1n: 0, o2: 0, o2n: 0, cheio: 0, cheion: 0, pts: [],
    });
    const reg = bairros.get(b.chave);
    // "COCO" e "Cocó" são o mesmo bairro: exibe a grafia acentuada
    const acentos = (s) => (s.match(/[^\x00-\x7f]/g) || []).length;
    if (acentos(b.nome) > acentos(reg.nome)) reg.nome = b.nome;
    return reg;
  };

  const horas = Array.from({ length: 24 }, (_, h) => ({ h, fin: 0, canc: 0, o1: 0, o1n: 0, o2: 0, o2n: 0 }));
  const aceiteFin = [], aceiteCanc = [];
  let o1 = 0, o2 = 0, cheio = 0, n = 0, semAceiteCanc = 0;
  const heat = [];   // [lat, lng, 0=finalizada|1=cancelada]
  const modal = new Map();   // por modalidade: contagens e somas no formato do painel RD
  const M = (tipo, lim) => {
    if (!modal.has(tipo)) modal.set(tipo, { tipo, limite: lim, fin: 0, n: 0, on: 0, on1: 0, on2: 0, s: { entrega: [], p1: [], p2: [], aceite: [], chegada: [], espera: [] } });
    return modal.get(tipo);
  };

  for (const p of fin) {
    const b = B(p); b.fin++;
    const h = horas[localHora(p.dates.finished_at || p.dates.delivered_at)]; h.fin++;
    const ac = valido(minutos(inicioBusca(p), p.dates?.accepted_at), 180);
    if (ac != null) { aceiteFin.push(ac); b.aceiteFin.push(ac); }
    const lim = limiteOtd(p, drog);
    const m = M(drog ? modalidade(p) : 'Todas', lim); m.fin++;
    const t = lim != null ? pontas(p) : null;
    if (t) {
      const ok1 = t.a <= lim, ok2 = t.b <= lim, ok = t.a + t.b <= 2 * lim;
      n++; b.cheion++; h.o1n++;
      if (ok1) { o1++; b.o1++; h.o1++; }
      if (ok2) { o2++; b.o2++; h.o2++; }
      if (ok) { cheio++; b.cheio++; h.ok = (h.ok || 0) + 1; }
      m.n++; if (ok) m.on++; if (ok1) m.on1++; if (ok2) m.on2++;
      m.s.entrega.push(t.a + t.b); m.s.p1.push(t.a); m.s.p2.push(t.b);
      if (t.aceite != null && t.aceite >= 0) m.s.aceite.push(t.aceite);
      if (t.chegada != null && t.chegada >= 0) m.s.chegada.push(t.chegada);
      if (t.espera != null && t.espera >= 0) m.s.espera.push(t.espera);
    }
    const c = coordsDestino(p); if (c) { heat.push([c[0], c[1], 0]); b.pts.push(c); }
  }
  const media2 = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);
  const modalidades = [...modal.values()].map((m) => ({
    tipo: m.tipo, limite: m.limite, fin: m.fin, n: m.n,
    on: m.on, on1: m.on1, on2: m.on2,
    otd: pct(m.on, m.n), otd1: pct(m.on1, m.n), otd2: pct(m.on2, m.n),
    medias: Object.fromEntries(Object.entries(m.s).map(([k, v]) => [k, media2(v)])),
  })).sort((x, y) => (y.limite != null) - (x.limite != null) || y.fin - x.fin);
  for (const p of canc) {
    const b = B(p); b.canc++;
    horas[localHora(p.dates.cancelled_at)].canc++;
    const ac = valido(minutos(inicioBusca(p), p.dates?.accepted_at), 180);
    if (ac != null) { aceiteCanc.push(ac); b.aceiteCanc.push(ac); } else { semAceiteCanc++; b.semAceite++; }
    const c = coordsDestino(p); if (c) { heat.push([c[0], c[1], 1]); b.pts.push(c); }
  }

  const lista = [...bairros.values()].map((b) => {
    const total = b.fin + b.canc;
    const cx = b.pts.length ? [
      Math.round((b.pts.reduce((s, q) => s + q[0], 0) / b.pts.length) * 1e4) / 1e4,
      Math.round((b.pts.reduce((s, q) => s + q[1], 0) / b.pts.length) * 1e4) / 1e4,
    ] : null;
    return {
      b: b.nome, fin: b.fin, canc: b.canc, total, taxa: pct(b.canc, total),
      aceiteFin: media(b.aceiteFin), aceiteCanc: media(b.aceiteCanc), semAceite: b.semAceite,
      otd1: pct(b.o1, b.cheion), otd2: pct(b.o2, b.cheion), otd: pct(b.cheio, b.cheion), otdN: b.cheion, c: cx,
    };
  }).sort((x, y) => y.total - x.total);

  // Rankings de loja. Drogasil: top 20 por demanda. Demais: top 30 por entregas (todas),
  // top 20 Pague Menos/Extrafarma por demanda e top 20 sem rede/grupo regional por entregas.
  const lojasM = new Map();
  const Lj = (p) => {
    const id = p.merchant?.id ?? p.merchant?.name;
    if (!lojasM.has(id)) lojasM.set(id, { loja: p.merchant?.name || '—', ...(drog ? {} : classeLoja(p)), fin: 0, canc: 0, n: 0, on: 0, aceite: [], p1: [], p2: [] });
    return lojasM.get(id);
  };
  for (const p of fin) {
    const l = Lj(p); l.fin++;
    const ac = valido(minutos(inicioBusca(p), p.dates?.accepted_at), 180); if (ac != null) l.aceite.push(ac);
    const lim = limiteOtd(p, drog), t = lim != null ? pontas(p) : null;
    if (t) { l.n++; if (t.a + t.b <= 2 * lim) l.on++; l.p1.push(t.a); l.p2.push(t.b); }
  }
  for (const p of canc) Lj(p).canc++;
  const todasLojas = [...lojasM.values()].map((l) => ({
    loja: l.loja.replace(/\s+/g, ' ').trim(), classe: l.classe, grupo: l.grupo,
    fin: l.fin, canc: l.canc, total: l.fin + l.canc, taxa: pct(l.canc, l.fin + l.canc),
    otd: pct(l.on, l.n), otdN: l.n, aceite: media(l.aceite), p1: media(l.p1), p2: media(l.p2),
  }));
  const porDemanda = (a, b) => b.total - a.total || b.fin - a.fin;
  const porEntregas = (a, b) => b.fin - a.fin || b.total - a.total;
  const rankings = drog
    ? { drogasil: todasLojas.sort(porDemanda).slice(0, 20) }
    : {
        pmef: todasLojas.filter((l) => l.classe === 'pmef').sort(porDemanda).slice(0, 20),
        americanas: todasLojas.filter((l) => /AMERICANAS/i.test(l.loja)).sort(porDemanda).slice(0, 20),
        srgr: todasLojas.filter((l) => l.classe === 'sr' || l.classe === 'gr').sort(porEntregas).slice(0, 20),
        todas: [...todasLojas].sort(porEntregas).slice(0, 30),
      };
  const classes = drog ? null : ['pmef', 'rede', 'gr', 'sr', '?'].map((c) => {
    const L = todasLojas.filter((l) => l.classe === c);
    return { classe: c, lojas: L.length, fin: L.reduce((s, l) => s + l.fin, 0), canc: L.reduce((s, l) => s + l.canc, 0) };
  }).filter((c) => c.lojas);

  return {
    rankings,
    classes,
    kpis: {
      finalizadas: fin.length,
      canceladas: canc.length,
      total: fin.length + canc.length,
      taxaCanc: pct(canc.length, fin.length + canc.length),
      emAndamento: ativos.length,
      aceiteFin: media(aceiteFin), aceiteFinMediana: mediana(aceiteFin),
      aceiteCanc: media(aceiteCanc), cancSemAceite: semAceiteCanc,
      // OTD sobre as finalizadas com regra (Drogasil: Turbo60 + Turbo120) e as duas pontas calculáveis
      otd1: pct(o1, n), otd2: pct(o2, n), otd: pct(cheio, n), otdN: n,
      lojas: new Set([...fin, ...canc].map((p) => p.merchant?.id)).size,
    },
    modalidades,
    horas: horas.filter((h) => h.fin || h.canc).map((h) => ({ h: h.h, fin: h.fin, canc: h.canc, otd1: h.o1n >= 5 ? pct(h.o1, h.o1n) : null, otd2: h.o1n >= 5 ? pct(h.o2, h.o1n) : null, otd: h.o1n >= 5 ? pct(h.ok || 0, h.o1n) : null, n: h.o1n })),
    bairros: lista,
    // documento do banco tem teto de 256 KiB: acima de 4.000 pontos, amostra uniforme
    heat: heat.length > 4000 ? heat.filter((_, i) => i % Math.ceil(heat.length / 4000) === 0) : heat,
  };
}

// ----------------------------------------------------- cancelamentos por agente
// Quem cancelou está só no evento de cada pedido (GET /orders/{id}/events). A torre de
// cancelamentos já lê esses eventos e guarda em cache-motivos.json; o Radar só consulta
// esse arquivo — nenhuma requisição extra à API, que tem limite apertado.
// Finalizações por agente não dá: exigiria ler o evento de TODAS as entregas do dia
// (nenhum campo do pedido separa as ~1,6% finalizadas por agente) — vêm do extrato.
const cacheMotivos = () => path.join(DIR_CANC || '/nao-montado', 'cache-motivos.json');
const LOJA_RE = /\b(LTDA|EIRELI|ME|EPP|S\/?A|FARM[AÁ]CIA|DROGARIAS?|DROGASIL|PAGUE MENOS|CHURRASCARIA|PIZZARIA|LANCHONETE|PADARIA|SORVETERIA|A[CÇ]A[IÍ]|EXTRAFARMA|COMERCIO|COM[EÉ]RCIO|RESTAURANTE|DELIVERY|LOJA)\b/i;
const tituloNome = (s) => s.trim().toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (w) => w.toLowerCase());
function quemFechou(by) {
  const s = String(by || '').replace(/^\|/, '').split(/\s*\|\s*Modifica/)[0].trim();
  if (!s) return { tipo: 'sem_registro' };
  if (/APP Entregador/i.test(s)) return { tipo: 'entregador' };
  const ia = s.match(/^IA:\s*(?:\[[^\]]*\]\s*)?([^\[]+)/i);
  if (ia) return { tipo: 'ia', nome: 'IA · ' + tituloNome(ia[1].split(/\s+/)[0]) };
  if (/PAINEL EMPRESA|Painel Central/i.test(s)) return { tipo: 'loja' };
  if (/API P[úu]blica|integra/i.test(s)) return { tipo: 'integracao' };
  if (/Autom[áa]tico/i.test(s)) return { tipo: 'sistema' };
  const p = s.match(/(?:Finalizad|Cancelad)[ao] por:\s*(.+)/i);
  if (p && p[1].trim()) return LOJA_RE.test(p[1]) ? { tipo: 'loja' } : { tipo: 'agente', nome: tituloNome(p[1]) };
  return { tipo: 'outro' };
}
function cancelamentosPorAgente(pedidos) {
  let cache = {}, cacheEm = null;
  try { cache = JSON.parse(fs.readFileSync(cacheMotivos(), 'utf8')); cacheEm = fs.statSync(cacheMotivos()).mtime.toISOString(); } catch { return null; }
  const canc = pedidos.filter((p) => p.status === '60' && localDia(p.dates?.cancelled_at) === DIA);
  const origem = {}, ag = new Map();
  let semLeitura = 0;
  for (const p of canc) {
    const info = cache[p.id];
    if (!info) { semLeitura++; continue; }
    const q = quemFechou(info.by);
    origem[q.tipo] = (origem[q.tipo] || 0) + 1;
    if (!q.nome) continue;
    if (!ag.has(q.nome)) ag.set(q.nome, { nome: q.nome, ia: q.tipo === 'ia', canc: 0, drog: 0, demais: 0, antesAceite: 0, emRota: 0, motivos: {} });
    const a = ag.get(q.nome);
    a.canc++; a[ehDrogasil(p) ? 'drog' : 'demais']++;
    if (!p.dates?.accepted_at) a.antesAceite++;
    if (p.dates?.departure_at_origin) a.emRota++;
    const m = String(info.motivo || '').trim() || 'sem motivo informado';
    a.motivos[m] = (a.motivos[m] || 0) + 1;
  }
  const lista = [...ag.values()].map(({ motivos, ...a }) => {
    const top = Object.entries(motivos).sort((x, y) => y[1] - x[1])[0];
    return { ...a, motivo: top ? top[0].slice(0, 80) : null, motivoN: top ? top[1] : 0 };
  }).sort((x, y) => y.canc - x.canc);
  return { cacheEm, canceladas: canc.length, lidos: canc.length - semLeitura, semLeitura, origem, lista };
}

// Período (01/10 até hoje): os cancelamentos de cada dia que a torre de cancelamentos
// gravou da API (db-detalhe-AAAA-MM-DD.json; o de hoje é db-detalhe.json) + o autor de
// cada um no cache de eventos. Pedido fora do cache fica só com o tipo de origem, sem nome.
const PERIODO_DE = '2026-10-01';
const ORIGEM_TIPO = {
  'Operador Bee': 'agente', 'IA da Bee': 'ia', 'Painel da loja': 'loja', 'API pública': 'integracao',
  'Integração RD': 'integracao', 'Integração Abbiamo': 'integracao', 'Automático do sistema': 'sistema',
};
function cancelamentosPeriodo() {
  const pasta = DIR_CANC;
  if (!pasta) return null;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheMotivos(), 'utf8')); } catch { return null; }
  const origem = {}, ag = new Map(), dias = [];
  let total = 0, semNome = 0;
  for (let d = new Date(PERIODO_DE + 'T12:00:00Z'); ymd(d) <= HOJE; d = new Date(d.getTime() + 86400e3)) {
    const dia = ymd(d);
    let j = null;
    for (const f of [`db-detalhe-${dia}.json`, 'db-detalhe.json']) {
      try { const x = JSON.parse(fs.readFileSync(path.join(pasta, f), 'utf8')); if (x.dia === dia) { j = x; break; } } catch {}
    }
    if (!j) continue;
    const c = Object.fromEntries((j.campos || []).map((k, i) => [k, i]));
    dias.push(dia);
    for (const r of j.linhas || []) {
      total++;
      const info = cache[r[c.id]];
      const q = info ? quemFechou(info.by) : { tipo: ORIGEM_TIPO[r[c.origem]] || 'outro' };
      origem[q.tipo] = (origem[q.tipo] || 0) + 1;
      if (!q.nome) { if (q.tipo === 'agente') semNome++; continue; }
      if (!ag.has(q.nome)) ag.set(q.nome, { nome: q.nome, ia: q.tipo === 'ia', canc: 0, drog: 0, demais: 0, antesAceite: 0, naLoja: 0, emRota: 0, dias: new Set(), motivos: {} });
      const a = ag.get(q.nome);
      a.canc++; a[r[c.rede] === 'Drogasil' ? 'drog' : 'demais']++;
      a[['antesAceite', 'naLoja', 'emRota'][r[c.fase]] || 'antesAceite']++;
      a.dias.add(dia);
      const m = String((info && info.motivo) || r[c.motivo] || '').trim() || 'sem motivo informado';
      a.motivos[m] = (a.motivos[m] || 0) + 1;
    }
  }
  const lista = [...ag.values()].map(({ motivos, dias: ds, ...a }) => {
    const top = Object.entries(motivos).sort((x, y) => y[1] - x[1])[0];
    return { ...a, diasAtivos: ds.size, motivo: top ? top[0].slice(0, 80) : null, motivoN: top ? top[1] : 0 };
  }).sort((x, y) => y.canc - x.canc);
  return { de: dias[0] || PERIODO_DE, ate: dias[dias.length - 1] || HOJE, diasLidos: dias.length, canceladas: total, origem, semNome, lista };
}

// Entregas buscando entregador no momento da coleta (status 10): ninguém aceitou ainda.
// Tempo de espera contado do início da busca (searching), não da criação — agendados
// e D+1 começam a buscar só na hora marcada.
function buscandoAgora(pedidos) {
  const agora = Date.now();
  const L = pedidos.filter((p) => p.status === '10').map((p) => {
    const ini = inicioBusca(p);
    const min = ini ? Math.max(0, (agora - new Date(ini)) / 60e3) : null;
    return {
      id: p.id,
      loja: (p.merchant?.name || '—').replace(/\s+/g, ' ').trim(),
      drog: ehDrogasil(p),
      bairro: bairro(p.address_destination).nome,
      min: min == null ? null : Math.round(min * 10) / 10,
      desde: ini ? localStr(ini).slice(11, 16) : null,
      modalidade: ehDrogasil(p) ? modalidade(p) : null,
      veiculo: p.vehicle && p.vehicle !== 'ANY' ? p.vehicle : null,
    };
  }).sort((a, b) => (b.min ?? -1) - (a.min ?? -1));
  const faixa = (m) => (m == null ? 'sem' : m < 5 ? 'ate5' : m < 15 ? 'ate15' : m < 30 ? 'ate30' : 'mais30');
  const faixas = { ate5: 0, ate15: 0, ate30: 0, mais30: 0, sem: 0 };
  for (const x of L) faixas[faixa(x.min)]++;
  const ms = L.map((x) => x.min).filter((m) => m != null);
  return {
    em: new Date(agora).toISOString(),
    total: L.length,
    drog: L.filter((x) => x.drog).length,
    demais: L.filter((x) => !x.drog).length,
    mediaMin: ms.length ? Math.round((ms.reduce((s, m) => s + m, 0) / ms.length) * 10) / 10 : null,
    maxMin: ms.length ? Math.max(...ms) : null,
    faixas,
    lista: L.slice(0, 60),
  };
}

// D+1 e agendadas: a Drogasil marca a modalidade em badges.type ("D+1", "AGENDADO");
// nas demais lojas o agendamento aparece como schedule_time. Fechadas contam pelo dia
// de fechamento; as abertas (em andamento ou aguardando o horário, status 07) contam
// todas, com a data marcada para separar hoje de amanhã em diante.
function agendadasHoje(pedidos) {
  const tipoDe = (p) => {
    const m = modalidade(p).toUpperCase().replace(/\s+/g, '');
    if (m === 'D+1') return 'd1';
    if (m === 'AGENDADO' || p.schedule_time || p.status === '07') return 'agendada';
    return null;
  };
  const vazio = () => ({ fin: 0, canc: 0, andamento: 0, aguardando: 0, aguardandoHoje: 0, aguardandoDepois: 0, drog: 0, demais: 0 });
  const out = { d1: vazio(), agendada: vazio() };
  for (const p of pedidos) {
    const t = tipoDe(p); if (!t) continue;
    const o = out[t];
    let conta = false;
    if (p.status === '50') { if (localDia(p.dates?.finished_at || p.dates?.delivered_at) === DIA) { o.fin++; conta = true; } }
    else if (p.status === '60') { if (localDia(p.dates?.cancelled_at) === DIA) { o.canc++; conta = true; } }
    else if (p.status === '07' || p.status === '05') {
      o.aguardando++; conta = true;
      const quando = p.schedule_time ? localDia(p.schedule_time) : null;
      if (quando && quando > DIA) o.aguardandoDepois++; else o.aguardandoHoje++;
    } else { o.andamento++; conta = true; }
    if (conta) o[ehDrogasil(p) ? 'drog' : 'demais']++;
  }
  for (const o of Object.values(out)) o.total = o.fin + o.canc + o.andamento + o.aguardando;
  return out;
}

// Tipos de entrega do dia (mesma leitura do relatório semanal): modalidade do serviço em
// todas as lojas — Drogasil pelo badges.type; demais lojas não têm badge, então "padrão"
// (sob demanda) ou "agendada" (schedule_time) —, veículo de quem entregou, paradas e
// retorno à loja. Fechadas contam pelo dia de fechamento; em andamento = abertas de hoje.
const VEICULO_ROT = { motorcycle: 'Moto', bike: 'Bike', bicycle: 'Bike', car: 'Carro', van: 'Van', pickup: 'Picape' };
function tiposDeEntrega(pedidos) {
  const seg = { drog: null, demais: null };
  const novo = () => ({ fin: 0, canc: 0, andamento: 0, modalidade: {}, veiculo: {}, paradas: { '1': 0, '2': 0, '3+': 0 }, retorno: 0, canal: {} });
  for (const p of pedidos) {
    const fin = p.status === '50' && localDia(p.dates?.finished_at || p.dates?.delivered_at) === DIA;
    const canc = p.status === '60' && localDia(p.dates?.cancelled_at) === DIA;
    const aberto = !['50', '60', '05', '07'].includes(p.status) && localDia(p.dates?.created_at || p.created_at) === DIA;
    if (!fin && !canc && !aberto) continue;
    const drog = ehDrogasil(p), t = seg[drog ? 'drog' : 'demais'] ||= novo();
    let m = modalidade(p);
    if (!drog || m === 'Sem modalidade') m = drog ? 'Sem modalidade' : (p.schedule_time ? 'Agendada' : 'Padrão');
    const mm = t.modalidade[m] ||= { fin: 0, canc: 0, andamento: 0 };
    const k = fin ? 'fin' : canc ? 'canc' : 'andamento';
    mm[k]++; t[k]++;
    t.canal[p.channel || '—'] = (t.canal[p.channel || '—'] || 0) + 1;
    if (fin) {
      const v = VEICULO_ROT[String(p.deliveryman?.vehicle || '').toLowerCase()] || 'Sem registro';
      t.veiculo[v] = (t.veiculo[v] || 0) + 1;
      const n = (p.waypoints || []).filter((w) => w.type === 'delivery').length || Number(p.waypoint_quantity) || 1;
      t.paradas[n >= 3 ? '3+' : n === 2 ? '2' : '1']++;
      if (p.return) t.retorno++;
    }
  }
  for (const k of Object.keys(seg)) seg[k] ||= novo();
  return seg;
}

function resumoEntregadores(online) {
  if (!online) return null;
  const modal = (v) => {
    const s = String(v || '').toLowerCase();
    if (/moto/.test(s)) return 'moto';
    if (/bike|bicy|bicicleta/.test(s)) return 'bike';
    if (/car|carro|van|pickup/.test(s)) return 'carro';
    return 'outro';
  };
  const out = { disponiveis: 0, emEntrega: 0, modal: {}, pts: [] };
  for (const [lista, emEntrega] of [[online.od.available || [], false], [online.od.in_delivery || [], true]]) {
    for (const e of lista) {
      const m = modal(e.vehicle_type);
      out.modal[m] = out.modal[m] || { disponiveis: 0, emEntrega: 0 };
      out.modal[m][emEntrega ? 'emEntrega' : 'disponiveis']++;
      out[emEntrega ? 'emEntrega' : 'disponiveis']++;
      const lat = Number(e.latitude), lng = Number(e.longitude);
      if (isFinite(lat) && isFinite(lng) && lat < -3.3 && lat > -4.2 && lng < -38.2 && lng > -38.9)
        out.pts.push([Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, emEntrega ? 1 : 0, m[0]]);
    }
  }
  out.total = out.disponiveis + out.emEntrega;
  out.hojeApi = online.hoje;
  return out;
}

// Lojas em observação (LOJAS_OBSERVACAO no .env, ids de merchant): o cálculo do segmento loja
// a loja, aberto por modalidade. Drogasil usa a modalidade do badge e o limite da RD; as demais
// não têm badge — "Padrão" (sob demanda) ou "Agendada" (schedule_time) — e 15 min por ponta.
// Transporte = veículo do entregador do pedido; sem entregador (cancelada antes do aceite,
// ainda buscando) fica em "Sem entregador".
// Cancelamentos: tempo = criação → cancelamento; fase pelo ponto em que caiu (sem aceite,
// aceito e ainda na loja, já saiu da loja); motivo e autor vêm do evento de status 60 em
// GET /orders/{id}/events (a listagem não traz). Lê primeiro o cache da torre-cancelamentos,
// depois o próprio (cache/motivos-obs.json); só chama a API para o que faltar.
// Modalidade de Pague Menos / Extrafarma: não vem em badges.type, mas em time_to_delivery (minutos).
// Conferido em 03/11/2026 contra os exports por loja do Power BI (tipo_entrega_rd, 01/08–20/10): contagens quase idênticas.
const MODALIDADE_PMEF = { 30: 'Super Expressa', 60: 'Expressa', 1440: 'Econômica' };
const ROT_QUEM = { entregador: 'App do entregador', loja: 'Painel da loja', integracao: 'Integração / sistema do cliente', sistema: 'Automático do sistema', sem_registro: 'Sem registro', outro: 'Outro' };
async function motivosObservacao(pedidos) {
  const ids = pedidos.filter((p) => OBSERVACAO.includes(String(p.merchant?.id)) && p.status === '60' && localDia(p.dates?.cancelled_at) === DIA).map((p) => p.id);
  if (!ids.length) return {};
  const arq = path.join(DIR_CACHE, 'motivos-obs.json');
  let proprio = {}, torre = {};
  try { proprio = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch {}
  try { torre = JSON.parse(fs.readFileSync(cacheMotivos(), 'utf8')); } catch {}
  const out = {};
  let novos = 0;
  for (const id of ids) {
    const c = proprio[id] || torre[id];
    if (c && (c.motivo || c.by)) { out[id] = c; continue; }
    try {
      const j = await api(`/orders/${id}/events`);
      const ev = (Array.isArray(j?.data) ? j.data : []).find((e) => e?.value?.current?.status === '60');
      out[id] = proprio[id] = { motivo: ev?.value?.current?.motivo_cancelamento || null, by: ev?.value?.current?.finalizada_by || null, ts: ev?.timestamp || null };
      novos++;
    } catch (e) { console.error('motivo do pedido', id + ':', e.message); }
  }
  if (novos) {
    const chaves = Object.keys(proprio);   // guarda só os 3.000 mais recentes
    if (chaves.length > 3000) chaves.slice(0, chaves.length - 3000).forEach((k) => delete proprio[k]);
    fs.writeFileSync(arq, JSON.stringify(proprio));
  }
  return out;
}

// Nome das lojas observadas ainda sem pedido no dia (de manhã cedo, por exemplo): vem do cadastro,
// uma chamada por loja, guardada em cache/nomes-obs.json. Assim o cartão nunca mostra só o id interno.
async function nomesObservacao(pedidos) {
  const comPedido = new Set(pedidos.map((p) => String(p.merchant?.id)));
  const faltam = OBSERVACAO.filter((id) => !comPedido.has(id));
  if (!faltam.length) return {};
  const arq = path.join(DIR_CACHE, 'nomes-obs.json');
  let nomes = {};
  try { nomes = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch {}
  let novos = 0;
  for (const id of faltam) {
    if (nomes[id]) continue;
    const d = (await api('/merchants/' + id))?.data || {};
    if (d.trade_name) { nomes[id] = d.trade_name; novos++; }
  }
  if (novos) fs.writeFileSync(arq, JSON.stringify(nomes));
  return nomes;
}

function lojasObservacao(pedidos, motivos = {}, nomes = {}) {
  if (!OBSERVACAO.length) return null;
  const novo = () => ({ fin: 0, canc: 0, andamento: 0, aceite: [], aceiteCanc: [], semAceite: 0, n: 0, on: 0, on1: 0, on2: 0, p1: [], p2: [], tcanc: [] });
  const fechar = (a) => ({
    fin: a.fin, canc: a.canc, andamento: a.andamento, total: a.fin + a.canc, taxa: pct(a.canc, a.fin + a.canc),
    aceite: media(a.aceite), aceiteMediana: mediana(a.aceite), aceiteCanc: media(a.aceiteCanc), semAceite: a.semAceite,
    otd: pct(a.on, a.n), otd1: pct(a.on1, a.n), otd2: pct(a.on2, a.n), otdN: a.n, p1: media(a.p1), p2: media(a.p2),
    tempoCanc: media(a.tcanc), tempoCancMediana: mediana(a.tcanc),
  });
  const faseDe = (p) => (!p.dates?.accepted_at ? 'antes do aceite' : p.dates?.departure_at_origin ? 'em rota' : 'na loja');
  const quem = (by) => { const q = quemFechou(by); return q.nome ? (q.tipo === 'ia' ? q.nome : 'Agente Bee · ' + q.nome) : ROT_QUEM[q.tipo] || q.tipo; };
  return OBSERVACAO.map((id) => {
    const ps = pedidos.filter((p) => String(p.merchant?.id) === id);
    const tot = novo(), mods = new Map(), veics = new Map(), cancelamentos = [];
    let limite = null;
    for (const p of ps) {
      const drog = ehDrogasil(p);
      const fin = p.status === '50' && localDia(p.dates?.finished_at || p.dates?.delivered_at) === DIA;
      const canc = p.status === '60' && localDia(p.dates?.cancelled_at) === DIA;
      const aberto = !fin && !canc && !['50', '60'].includes(p.status) && localDia(p.dates?.created_at || p.created_at) === DIA;
      if (!fin && !canc && !aberto) continue;
      let m = modalidade(p);
      if (!drog || m === 'Sem modalidade') m = drog ? 'Sem modalidade' : (ehPMEF(p) && MODALIDADE_PMEF[p.time_to_delivery]) || (p.schedule_time ? 'Agendada' : 'Padrão');
      if (!mods.has(m)) mods.set(m, novo());
      const v = p.deliveryman ? VEICULO_ROT[String(p.deliveryman.vehicle || '').toLowerCase()] || 'Sem registro' : 'Sem entregador';
      if (!veics.has(v)) veics.set(v, novo());
      const tc = canc ? valido(minutos(p.dates?.created_at || p.created_at, p.dates?.cancelled_at), 24 * 60) : null;
      if (canc) {
        const mo = motivos[p.id];
        cancelamentos.push({
          id: p.id, hora: localStr(p.dates.cancelled_at).slice(11, 16), criado: localStr(p.dates?.created_at || p.created_at).slice(11, 16),
          min: tc == null ? null : Math.round(tc * 10) / 10, fase: faseDe(p),
          motivo: mo ? String(mo.motivo || '').trim() || 'sem motivo informado' : 'motivo ainda não lido',
          quem: mo ? quem(mo.by) : '—', modalidade: m, veiculo: v,
        });
      }
      for (const a of [tot, mods.get(m), veics.get(v)]) {
        if (aberto) { a.andamento++; continue; }
        const ac = valido(minutos(inicioBusca(p), p.dates?.accepted_at), 180);
        if (canc) { a.canc++; if (tc != null) a.tcanc.push(tc); if (ac != null) a.aceiteCanc.push(ac); else a.semAceite++; continue; }
        a.fin++;
        if (ac != null) a.aceite.push(ac);
        const lim = limiteOtd(p, drog), t = lim != null ? pontas(p) : null;
        if (!t) continue;
        limite = lim;
        a.n++; a.p1.push(t.a); a.p2.push(t.b);
        if (t.a <= lim) a.on1++;
        if (t.b <= lim) a.on2++;
        if (t.a + t.b <= 2 * lim) a.on++;
      }
    }
    return {
      id, loja: (ps[0]?.merchant?.name || nomes[id] || 'Loja ' + id).replace(/\s+/g, ' ').trim(), limite, ...fechar(tot),
      modalidades: [...mods].map(([tipo, a]) => ({ tipo, ...fechar(a) })).sort((x, y) => y.total + y.andamento - x.total - x.andamento),
      veiculos: [...veics].map(([tipo, a]) => ({ tipo, ...fechar(a) })).sort((x, y) => y.total + y.andamento - x.total - x.andamento),
      cancelamentos: cancelamentos.sort((x, y) => y.hora.localeCompare(x.hora)),
      motivos: Object.entries(cancelamentos.reduce((o, c) => ((o[c.motivo] = (o[c.motivo] || 0) + 1), o), {})).map(([motivo, n]) => ({ motivo, n })).sort((x, y) => y.n - x.n),
      fases: ['antes do aceite', 'na loja', 'em rota'].map((f) => ({ fase: f, n: cancelamentos.filter((c) => c.fase === f).length })),
    };
  });
}

// ------------------------------------------------- alerta: sem rede / grupo regional buscando
// Leitura rápida, separada da coleta de 10 min: só pedidos com status 10 (buscando), uma página
// por minuto. Classe da loja pelo cadastro (classeLoja: sem key_account → grupo regional se tiver
// regional_group, senão sem rede), mais as lojas de ALERTA_LOJAS no .env (ids de merchant), que entram
// pelo id seja qual for a rede. Devolve todos com a hora do início da busca; quem passou de
// 5 min é decidido na página, que conta a espera ao vivo e toca o alerta.
const coordsColeta = (p) => {
  const w = (p.waypoints || []).find((x) => x.type === 'pickup');
  const lat = Number(w?.latitude), lng = Number(w?.longitude);
  return lat && lng ? [lat, lng] : null;
};
const distanciaKm = ([a, b], [c, d]) => {
  const rad = Math.PI / 180, s1 = Math.sin((c - a) * rad / 2), s2 = Math.sin((d - b) * rad / 2);
  return 2 * 6371 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(a * rad) * Math.cos(c * rad) * s2 * s2));
};
// Entregadores online até raioKm da loja, em linha reta (a API não tem busca por proximidade).
// O /dashboard fica 30 s em cache: vários cliques seguidos custam uma requisição só.
// Devolve id, nome, telefone, veículo, distância e situação; o GPS do entregador não sai daqui.
let cacheOnline = { t: 0, dados: null, voo: null };
async function onlineAgora() {
  if (cacheOnline.dados && Date.now() - cacheOnline.t < 30e3) return cacheOnline.dados;
  cacheOnline.voo ||= api('/dashboard?franchiseId=' + FRANQUIA_ID).then((j) => {
    cacheOnline.dados = (j?.data || j || {}).online_deliverymen || {};
    cacheOnline.t = Date.now();
    return cacheOnline.dados;
  }).finally(() => { cacheOnline.voo = null; });
  return cacheOnline.voo;
}
const veiculoDe = (v) => { const s = String(v || '').toLowerCase(); return /moto/.test(s) ? 'Moto' : /bike|bicy|bicicleta/.test(s) ? 'Bike' : /car|van|pickup/.test(s) ? 'Carro' : 'Outro'; };
export async function entregadoresProximos(origem, raioKm = 3) {
  const od = await onlineAgora();
  const lista = [[od.available || [], false], [od.in_delivery || [], true]].flatMap(([l, emEntrega]) => l.map((e) => {
    const lat = Number(e.latitude), lng = Number(e.longitude);
    return lat && lng ? { id: e.id, nome: e.name, telefone: e.phone ? String(e.phone) : null, veiculo: veiculoDe(e.vehicle_type), emEntrega, km: Math.round(distanciaKm(origem, [lat, lng]) * 100) / 100 } : null;
  })).filter((e) => e && e.km <= raioKm).sort((a, b) => a.emEntrega - b.emEntrega || a.km - b.km);
  return { em: new Date(cacheOnline.t).toISOString(), raioKm, online: (od.available || []).length + (od.in_delivery || []).length, lista };
}

let detalhesAlerta = new Map();
export const detalheAlerta = (id) => detalhesAlerta.get(String(id)) || null;

// ---- Atribuição pelo botão "Sim" do WhatsApp. Únicas escritas deste painel na API da Bee.
export async function lerPedido(id) {
  const j = await api('/orders/' + encodeURIComponent(id));
  const p = j?.data || j || {};
  return { id: p.id, status: String(p.status), entregador: p.deliveryman?.id ?? p.deliveryman_id ?? null, loja: (p.merchant?.name || '').replace(/\s+/g, ' ').trim() };
}
// A chave do filtro é `entregador_id`; com `deliveryman_id` a API ignora o filtro em silêncio.
// Confere o id de novo aqui para nunca contar entregas de outros se o filtro for ignorado.
export async function entregasAbertas(entregadorId) {
  const qs = new URLSearchParams({ 'filters[entregador_id][$eq][]': String(entregadorId), per_page: '100', page: '1' });
  qs.append('filters[status][$notIn][]', '50');
  qs.append('filters[status][$notIn][]', '60');
  const j = await api('/orders?' + qs);
  return (Array.isArray(j?.data) ? j.data : []).filter((p) => Number(p.deliveryman?.id ?? p.deliveryman_id) === Number(entregadorId) && !['50', '60'].includes(String(p.status))).length;
}
// Em Buscando a API só aceita o entregador junto com a saída do status 10 (teste real de 04/11/2026).
// Sem repetição em erro ou timeout: quem chama relê o pedido. Só 401 tenta de novo, pois nada foi gravado.
export async function atribuirEntrega(id, merchantId, entregadorId) {
  if (!TOKEN) await login();
  const envia = () => fetch(BASE + '/orders/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ merchant_id: Number(merchantId), deliveryman_id: Number(entregadorId), status: '20' }),
    signal: AbortSignal.timeout(20e3),
  });
  let r = await envia();
  if (r.status === 401) { TOKEN = null; await login(); r = await envia(); }
  const j = await r.json().catch(() => null);
  return { ok: r.ok && j?.status !== 'error', http: r.status, mensagem: String(j?.message || '').slice(0, 200) };
}

export function buscandoSemRede() {
  const reqs = { total: 0 };
  return CONTA.run(reqs, () => buscandoSemRedeDia(reqs));
}
async function buscandoSemRedeDia(reqs) {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  const ps = [];
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({
      'filters[created_at][$gte]': hoje + ' 00:00:00',
      'filters[created_at][$lte]': hoje + ' 23:59:59',
      'filters[status][$in][]': '10',
      per_page: '100', page: String(page),
    });
    const j = await api('/orders?' + qs);
    const itens = Array.isArray(j?.data) ? j.data : [];
    ps.push(...itens);
    if (!itens.length || !j?.links?.next) break;
  }
  const buscando = ps.filter((p) => p.status === '10' && (p.franchise?.name || '') === FRANQUIA && !ehDrogasil(p));
  await carregarLojas(buscando).catch((e) => console.error('cadastro de lojas (alerta):', e.message));
  // Dados do template de WhatsApp: ficam só no servidor, fora do live/alerta que vai ao navegador.
  detalhesAlerta = new Map(buscando.map((p) => [String(p.id), {
    merchantId: p.merchant?.id ?? p.merchant_id ?? null,
    loja: (p.merchant?.name || '').replace(/\s+/g, ' ').trim(),
    origem: String(p.address_origin || '').replace(/\s+/g, ' ').trim(),
    destino: bairro(p.address_destination).nome,
    distanciaM: Number(p.distance) || 0,      // metros
    valorCentavos: Number(p.price_deliveryman) || 0, // o que o entregador recebe; nunca `price`
  }]));
  const vistos = new Set();
  const classeAlerta = (p) => (ALERTA_LOJAS.includes(String(p.merchant?.id))
    ? { classe: 'loja', grupo: /EXTRAFARMA/i.test(p.merchant?.name || '') ? 'Extrafarma' : /PAGUE MENOS/i.test(p.merchant?.name || '') ? 'Pague Menos' : 'Loja selecionada' }
    : classeLoja(p));
  const lista = buscando.filter((p) => !vistos.has(p.id) && vistos.add(p.id)).map((p) => ({ p, c: classeAlerta(p) }))
    .filter(({ c }) => c.classe === 'sr' || c.classe === 'gr' || c.classe === 'loja')
    .map(({ p, c }) => {
      const ini = inicioBusca(p);
      return {
        id: p.id, loja: (p.merchant?.name || '—').replace(/\s+/g, ' ').trim(),
        classe: c.classe, grupo: c.grupo, bairro: bairro(p.address_destination).nome, origem: coordsColeta(p),
        desdeIso: ini ? new Date(ini).toISOString() : null, desde: ini ? localStr(ini).slice(11, 16) : null,
        agendado: !!p.schedule_time,
      };
    })
    .sort((a, b) => (a.desdeIso || '').localeCompare(b.desdeIso || ''));
  return { em: new Date().toISOString(), buscandoTotal: buscando.length, lista, requisicoes: reqs };
}

// ---------------------------------------------------------------------- main
// Uma coleta por chamada; o server.mjs agenda, guarda o status e serve o resultado.
export function coletar() {
  const reqs = { total: 0 };
  return CONTA.run(reqs, () => coletarDia(reqs));
}
const resumoReqs = (r) => `${r.total} requisições (` + ['login', 'pedidos', 'entregadores', 'lojas', 'eventos', 'outros'].filter((k) => r[k]).map((k) => `${k} ${r[k]}`).join(', ') + (r.repeticoes ? `; ${r.repeticoes} repetidas por erro` : '') + ')';
async function coletarDia(reqs) {
  HOJE = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  DIA = HOJE;
  const t0 = Date.now();
  const [pedidos, online] = await Promise.all([listarPedidos(), entregadoresOnline().catch((e) => { console.error('dashboard:', e.message); return null; })]);
  await carregarLojas(pedidos).catch((e) => console.error('cadastro de lojas:', e.message));
  // Nunca grava um painel zerado: nenhum pedido de Fortaleza quase sempre é acesso errado
  // (usuário cuja franquia ativa não é a 7), não um dia sem pedidos.
  if (!pedidos.length) throw new Error('nenhum pedido de ' + FRANQUIA + ' — confira a franquia ativa do usuário ' + USUARIO);
  const drog = segmento(pedidos.filter(ehDrogasil), true);
  const pmef = segmento(pedidos.filter(ehPMEF), false);
  const americanas = segmento(pedidos.filter(ehAmericanas), false);
  const demais = segmento(pedidos.filter((p) => !ehDrogasil(p) && !ehPMEF(p) && !ehAmericanas(p)), false);
  const gerado_em = new Date().toISOString();
  const geral = {
    dia: DIA, gerado_em, pedidosLidos: pedidos.length,
    entregadores: resumoEntregadores(online),
    totais: {
      finalizadas: drog.kpis.finalizadas + pmef.kpis.finalizadas + americanas.kpis.finalizadas + demais.kpis.finalizadas,
      canceladas: drog.kpis.canceladas + pmef.kpis.canceladas + americanas.kpis.canceladas + demais.kpis.canceladas,
      emAndamento: drog.kpis.emAndamento + pmef.kpis.emAndamento + americanas.kpis.emAndamento + demais.kpis.emAndamento,
    },
  };
  geral.totais.total = geral.totais.finalizadas + geral.totais.canceladas;
  geral.buscando = buscandoAgora(pedidos);
  geral.agendadas = agendadasHoje(pedidos);
  geral.tipos = tiposDeEntrega(pedidos);
  geral.agentes = cancelamentosPorAgente(pedidos);
  geral.agentesPeriodo = cancelamentosPeriodo();
  const motivos = await motivosObservacao(pedidos).catch((e) => { console.error('motivos (observação):', e.message); return {}; });
  const nomes = await nomesObservacao(pedidos).catch((e) => { console.error('nomes (observação):', e.message); return {}; });
  geral.observacao = lojasObservacao(pedidos, motivos, nomes);
  geral.requisicoes = reqs;
  return {
    geral,
    drogasil: { dia: DIA, gerado_em, ...drog },
    pmef: { dia: DIA, gerado_em, ...pmef },
    americanas: { dia: DIA, gerado_em, ...americanas },
    demais: { dia: DIA, gerado_em, ...demais },
    resumo: `${pedidos.length} pedidos lidos em ${((Date.now() - t0) / 1000).toFixed(0)} s · total ${geral.totais.total} = ${geral.totais.finalizadas} fin. + ${geral.totais.canceladas} canc. · ${geral.totais.emAndamento} em andamento · Drogasil on time ${drog.kpis.otd}% · ${resumoReqs(reqs)}`,
  };
}
export { resumoReqs };
