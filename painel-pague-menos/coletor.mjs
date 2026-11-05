// Coletor do Painel Pague Menos + Extrafarma: lê a API da Bee (somente GET). Três leituras:
//   coletar()           indicadores por dia e por loja (a cada 5 min, filtrada pelas lojas do grupo)
//   lerBuscando()       entregas em busca e em andamento nas lojas prioritárias (a cada minuto, só em memória)
//   lerEntregadores()   histórico de entregadores das lojas 933, 495 e 7362
//   entregadoresProximos()  entregadores até 3 km da loja de uma entrega aberta, sob demanda
// Dado de cliente não é guardado; do entregador ficam só id e nome.
import fs from 'node:fs';
import path from 'node:path';

const FRANQUIA = 'FORTALEZA/CE';
const FRANQUIA_ID = '7';
const POR_PAGINA = 1000;       // a API aceita 1000 em /orders; cada página cheia pesa ~3,6 MB
const MAX_PAGINAS = 300;
const LOJAS_POR_LEITURA = 80;  // a URL com 89 lojas (~5 kB) já foi testada; acima disso divide em mais leituras
const META_MIN = 15;           // OTD: 15 min em cada ponta
const espera = (ms) => new Promise((s) => setTimeout(s, ms));

// Ids de merchant, do cadastro de lojas: 678, 7300, 933, 495, 890, 7362, 839
export const IDS_PRIORITARIAS = ['114197', '145754', '145862', '106419', '145854', '146414', '145810'];
// 933, 495 e 7362: lojas com ranking de entregadores
export const LOJAS_ENTREGADORES = { 145862: '933 · Centro · Pague Menos', 106419: '495 · Tamatanduba · Pague Menos', 146414: '7362 · Tamatanduba · Extrafarma' };

let BASE = '', USUARIO = '', SENHA = '', ARQ_MOTIVOS = '', DESTINO_COMPLETO = false;
export function configurar(o) {
  BASE = String(o.base || '').replace(/\/+$/, '');
  USUARIO = o.usuario; SENHA = o.senha;
  DESTINO_COMPLETO = !!o.destinoCompleto;
  ARQ_MOTIVOS = path.join(o.cache, 'motivos.json');
}
export const temAcesso = () => !!(BASE && USUARIO && SENHA);

// ---------------------------------------------------------------------- HTTP
// Cada fetch soma em `reqs`, repetição inclusive: é o número mostrado no painel.
let TOKEN = null, loginEmVoo = null;
function login(reqs) {
  // leituras simultâneas dividem o mesmo login: um segundo login derrubaria o token do primeiro
  loginEmVoo ||= (async () => {
    reqs.total++; reqs.login++;
    const r = await fetch(BASE + '/public/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: USUARIO, password: SENHA }),
    });
    const j = await r.json().catch(() => null);
    TOKEN = j?.data?.token || null;
    if (!TOKEN) throw new Error('login falhou (HTTP ' + r.status + ')');
  })().finally(() => { loginEmVoo = null; });
  return loginEmVoo;
}
async function api(caminho, reqs, tipo, tentativa = 0) {
  if (!TOKEN) await login(reqs);
  reqs.total++; reqs[tipo]++;
  const r = await fetch(BASE + caminho, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' } });
  // o login é dividido com o Radar: um login derruba o outro
  if (r.status === 401 && tentativa < 6) {
    reqs.repeticoes++;
    await espera(1500 * (tentativa + 1));
    TOKEN = null;
    return api(caminho, reqs, tipo, tentativa + 1);
  }
  if (r.status === 429 && tentativa < 6) {
    reqs.repeticoes++;
    const ra = Number(r.headers.get('retry-after'));
    await espera(Math.min(isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * 2 ** tentativa, 60000));
    return api(caminho, reqs, tipo, tentativa + 1);
  }
  if (r.status >= 500 && tentativa < 3) {
    reqs.repeticoes++;
    await espera(1000 * 2 ** (tentativa + 1));
    return api(caminho, reqs, tipo, tentativa + 1);
  }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status + ' em ' + caminho.slice(0, 60));
  return r.json();
}

// Percorre as páginas de /orders. `filtros` = pares [chave, valor]; `ids` limita às lojas informadas.
async function listar(filtros, ids, reqs, aoPedido) {
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const qs = new URLSearchParams([['franchise_id', FRANQUIA_ID], ...filtros, ['sort[0]', 'created_at:asc'], ['per_page', String(POR_PAGINA)], ['page', String(page)]]);
    (ids || []).forEach((id, k) => qs.append(`filters[merchant][id][$in][${k}]`, String(id)));
    const j = await api('/orders?' + qs, reqs, 'paginas');
    const itens = Array.isArray(j?.data) ? j.data : [];
    for (const p of itens) aoPedido(p);
    if (!itens.length || !j?.links?.next) break;
    await espera(500);
  }
}

// ---------------------------------------------------------------------- tempo
const TZ = 'America/Fortaleza';
const local = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ });
const minutos = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null);
const valido = (m, teto = 480) => (m != null && m >= 0 && m <= teto ? m : null);
const somaDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

// Início da busca por entregador. `searching` às vezes vem como marcador (~0), então só vale data real.
function inicioBusca(p) {
  for (const x of [p.dates?.searching, p.searching, p.dates?.created_at, p.created_at]) {
    const t = x ? Date.parse(x) : NaN;
    if (!isNaN(t) && t > Date.parse('2020-01-01')) return x;
  }
  return null;
}

// Pedido de integração pode nascer com entregador: `searching` nulo e aceite no mesmo segundo da criação.
// Não houve busca, então ele não entra no tempo de aceite.
function buscaReal(p) {
  for (const x of [p.dates?.searching, p.searching]) {
    const t = x ? Date.parse(x) : NaN;
    if (!isNaN(t) && t > Date.parse('2020-01-01')) return x;
  }
  return null;
}

// Fase em que a corrida morreu. Sem aceite é sempre "antes do aceite": num cancelamento a API pode
// gravar arrival_at_origin no mesmo segundo do cancelled_at.
function fase(d) {
  if (!d.accepted_at) return 'Antes do aceite';
  if (!d.departure_at_origin) return 'Entregador a caminho ou na loja';
  return 'Já em rota';
}

// "Rua Costa Freire, 595 - Vila Peri, Fortaleza - CE, 60730135, BR" -> "Vila Peri, Fortaleza".
// Sem login no painel, o destino do cliente aparece só com bairro e cidade.
const CIDADES = /,\s*(Fortaleza|Caucaia|Maracana[uú]|Eus[eé]bio|Aquiraz|Itaitinga|Pacatuba|Maranguape|Horizonte|Pacajus)\b/i;
function bairroDestino(endereco) {
  let s = String(endereco || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Destino não informado';
  const mc = s.match(CIDADES);
  const cidade = mc ? mc[1] : '';
  if (mc) s = s.slice(0, mc.index);
  else s = s.replace(/,\s*(BRA?|\d{5}-?\d{3}|CE)\b.*$/i, '').replace(/\s*-\s*CE$/i, '');
  const segs = s.split(',');
  let b = segs.length > 1 || cidade ? segs[segs.length - 1].trim() : '';
  if (/\s-\s/.test(b)) b = b.split(/\s+-\s+/).pop().trim();
  if (!b || /^(\d|n[ºo°]\.?\s*\d|casa\b|apto?\b|bloco\b|lote\b|km\b)/i.test(b) || b.length < 3) {
    const partes = s.split(/\s+-\s+/);
    b = partes.length > 1 ? partes[partes.length - 1].split(',')[0].trim() : '';
  }
  if (!b || /^\d/.test(b) || b.length < 3) return cidade || 'Bairro não identificado';
  return cidade ? `${b}, ${cidade}` : b;
}

// ------------------------------------------------------------------- motivos
// Mesma classificação da torre Pague Menos (montar.py): "operacional" são os motivos que o
// Power BI conta como Motivo Bee, ou seja, falta de entregador e atraso/problema do entregador.
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const GRUPOS = [
  ['Falta de entregador', true, /tempo limite de \d+ minutos para aceite|buscando sem entregador|demorando muito para encontrar|automatic|falta de entregador|sem entregador|nenhum (entregador|motoqueiro)/],
  ['Perdida para outra transportadora', false, /outra transportadora|enviado por outro|outro entregador|outra empresa|motoboy proprio|entrega propria/],
  ['Atraso ou problema do entregador', true, /entregador|motoqueiro|tempo limite apos o aceite|^demora|^atraso|esperando demais|comportamento inadequado|veiculo/],
  ['Cliente desistiu', false, /cliente|destinat|recus|desist|comprador/],
  ['Problema na loja', false, /loja|produto|estabelecimento|estoque|separacao|nota fiscal|farmacia/],
  ['Endereço, cadastro ou duplicidade', false, /endereco|duplicad|lancamento|lancar|nao reconhece|teste|^erro|errad|cadastr|repetid|\bvolta\b|retorno|outr[oa] tipo|^erado/],
  ['Integração ou parceiro', false, /integrac|abbiamo|ifood|parceiro|sistema/],
];
export function grupoDoMotivo(txt) {
  if (!txt || !String(txt).trim()) return { grupo: 'Sem motivo informado', op: false };
  const t = semAcento(String(txt));
  for (const [grupo, op, re] of GRUPOS) if (re.test(t)) return { grupo, op };
  return { grupo: 'Outro motivo', op: false };
}

function lerMotivos() { try { return JSON.parse(fs.readFileSync(ARQ_MOTIVOS, 'utf8')); } catch { return {}; } }
function gravarMotivos(m) {
  fs.writeFileSync(ARQ_MOTIVOS + '.tmp', JSON.stringify(m));
  fs.renameSync(ARQ_MOTIVOS + '.tmp', ARQ_MOTIVOS);
}

// A listagem /orders não traz o motivo: ele vem de GET /orders/{id}, um por cancelamento. O cache
// evita pagar de novo pelo mesmo pedido; quem falhou fica fora do cache e é relido na próxima leitura.
async function buscarMotivos(dias, reqs) {
  const cache = lerMotivos();
  let lidos = 0;
  for (const dia of Object.values(dias)) {
    for (const c of dia.cancs) {
      if (Object.hasOwn(cache, c.id)) continue;
      try {
        const j = await api('/orders/' + c.id, reqs, 'motivos');
        const p = j?.data || j;
        cache[c.id] = String(p?.cancellation_reason || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null;
        lidos++;
      } catch (e) { console.error('motivo do pedido', c.id, e.message); continue; }
      if (lidos % 100 === 0) gravarMotivos(cache);
      await espera(300);
    }
  }
  if (lidos) gravarMotivos(cache);
  return cache;
}

// --------------------------------------------------------------- indicadores
function novaLoja(nome) {
  return { n: nome, dem: 0, fin: 0, canc: 0, and: 0, acSoma: 0, acN: 0, ac5: 0, semAceite: 0, direto: 0, c05: 0, cOp: 0,
    otdN: 0, p1On: 0, p2On: 0, geralOn: 0, p1Soma: 0, p2Soma: 0, h: Array(24).fill(0) };
}

function somarEntregador(mapa, p) {
  const id = String(p.merchant.id), e = p.deliveryman;
  if (!LOJAS_ENTREGADORES[id] || !e?.id) return;
  const porLoja = (mapa[id] ||= {});
  const x = (porLoja[e.id] ||= [String(e.name || '—').replace(/\s+/g, ' ').trim(), 0]);
  x[1]++;
}

function somar(dias, p) {
  const d = p.dates || {};
  const criado = d.created_at || p.created_at;
  if (!criado) return false;
  const [dia, hora] = local(criado).split(' ');
  if (!dias[dia]) return false;
  const D = dias[dia], id = String(p.merchant.id), h = Number(hora.slice(0, 2));
  const l = (D.lojas[id] ||= novaLoja(String(p.merchant.name).replace(/\s+/g, ' ').trim()));
  const st = String(p.status);
  l.dem++; l.h[h]++; D.horas[h][0]++;

  const busca = buscaReal(p);
  if (d.accepted_at && !busca) l.direto++;
  const ac = busca ? valido(minutos(busca, d.accepted_at), 180) : null;
  if (ac != null) { l.acSoma += ac; l.acN++; if (ac <= 5) l.ac5++; }

  if (st === '50') {
    l.fin++; D.horas[h][1]++;
    somarEntregador(D.entregadores, p);
    // OTD: ponta 1 = criação -> chegada à loja; ponta 2 = saída -> chegada ao cliente; 15 min cada.
    // Geral = soma das pontas <= 30 min, a regra que o Radar Operacional usa para este grupo.
    const a = valido(minutos(criado, d.arrival_at_origin));
    const b = valido(minutos(d.departure_at_origin, d.arrival_at_destination));
    if (a != null && b != null) {
      l.otdN++; l.p1Soma += a; l.p2Soma += b;
      if (a <= META_MIN) l.p1On++;
      if (b <= META_MIN) l.p2On++;
      if (a + b <= 2 * META_MIN) l.geralOn++;
    }
  } else if (st === '60') {
    l.canc++; D.horas[h][2]++;
    if (!d.accepted_at) l.semAceite++;
    const min = valido(minutos(criado, d.cancelled_at));
    if (min != null && min <= 5) l.c05++;
    D.cancs.push({ id: p.id, l: id, h: hora.slice(0, 5), min: min == null ? null : Math.round(min * 10) / 10, f: fase(d) });
  } else l.and++;
  return true;
}

function dividir(lista, n) {
  const out = [];
  for (let i = 0; i < lista.length; i += n) out.push(lista.slice(i, i + n));
  return out;
}

// Lê os dias pedidos, de `de` até o dia seguinte ao último: a margem cobre as últimas horas do dia e a
// data local decide. Com `ids` lê só essas lojas, o que torna a leitura curta o bastante para repetir
// a cada poucos minutos; sem `ids` lê a franquia inteira e é assim que uma loja nova do grupo aparece.
// `dias` = [{dia, fechado}]. Grava cada dia lido por aoLerDia.
export async function coletar(dias, aoLerDia, ids = null) {
  const reqs = { total: 0, login: 0, paginas: 0, motivos: 0, repeticoes: 0 };
  const inicio = Date.now();
  const alvo = {};
  for (const { dia, fechado } of dias) alvo[dia] = { dia, fechado, lojas: {}, horas: Array.from({ length: 24 }, () => [0, 0, 0]), cancs: [], entregadores: {} };
  const nomes = dias.map((d) => d.dia).sort();
  const vistos = new Set();
  let daFranquia = 0;
  const filtros = [['filters[created_at][$gte]', nomes[0] + ' 00:00:00'], ['filters[created_at][$lte]', somaDias(nomes[nomes.length - 1], 1) + ' 23:59:59']];

  for (const lote of ids ? dividir(ids, LOJAS_POR_LEITURA) : [null]) {
    await listar(filtros, lote, reqs, (p) => {
      if ((p.franchise?.name || '') !== FRANQUIA || vistos.has(p.id) || !p.merchant?.id) return;
      vistos.add(p.id); daFranquia++;
      if (/PAGUE MENOS|EXTRAFARMA/i.test(p.merchant.name || '')) somar(alvo, p);
    });
  }
  // Nenhum pedido quase sempre é acesso errado, não um dia sem pedidos: não sobrescreve o dia com zeros.
  // Só a madrugada pode vir vazia de verdade, e só na leitura filtrada pelas lojas do grupo.
  const hora = Number(local(new Date().toISOString()).slice(11, 13));
  if (!daFranquia && !(ids && hora < 6)) throw new Error('nenhum pedido de ' + FRANQUIA + ' nesse acesso');

  const motivos = await buscarMotivos(alvo, reqs);
  let pedidos = 0;
  for (const D of Object.values(alvo)) {
    for (const c of D.cancs) {
      c.m = motivos[c.id] ?? null;
      c.pendente = !Object.hasOwn(motivos, c.id);
      const g = grupoDoMotivo(c.m);
      c.g = g.grupo; c.op = g.op;
      if (g.op) D.lojas[c.l].cOp++;
    }
    for (const l of Object.values(D.lojas)) pedidos += l.dem;
    aoLerDia({ ...D, lido_em: new Date().toISOString() });
  }
  return { reqs, pedidos, segundos: Math.round((Date.now() - inicio) / 1000) };
}

// ------------------------------------------------------------------- buscando
// Rota no formato da tela de entregas: origem, destino e, quando há retorno, a loja de novo.
function rotaDoPedido(p) {
  const origem = String(p.address_origin || p.merchant?.name || '').replace(/\s+/g, ' ').trim();
  const destino = (t) => (DESTINO_COMPLETO ? String(t || 'Destino não informado').replace(/\s+/g, ' ').trim() : bairroDestino(t));
  const pontos = (p.waypoints || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!pontos.length) return [origem, destino(p.address_destination)];
  return pontos.map((w) => (w.type === 'delivery' ? destino(w.description) : origem));
}

// Status abertos: 10 buscando; 20 indo à origem; 25 e 28 na loja/liberado; 30 indo ao destino;
// 35 chegou no destino; 40 retornando. O rótulo mostrado é o que a API manda.
const STATUS_ANDAMENTO = ['20', '25', '28', '30', '35', '40'];

// Último carimbo da entrega: o tempo na etapa atual conta a partir dele.
function inicioEtapa(d) {
  let ultimo = null;
  for (const x of [d.accepted_at, d.arrival_at_origin, d.released_at, d.departure_at_origin, d.arrival_at_destination]) {
    const t = x ? Date.parse(x) : NaN;
    if (!isNaN(t) && (ultimo == null || t > ultimo)) ultimo = t;
  }
  return ultimo;
}

// Coleta e status da entrega: só as entregas da última leitura aceitam a consulta de entregadores próximos.
const coordsColeta = (p) => {
  const w = (p.waypoints || []).find((x) => x.type === 'pickup');
  const lat = Number(w?.latitude), lng = Number(w?.longitude);
  return lat && lng ? [lat, lng] : null;
};
let origens = new Map();

export async function lerBuscando(hoje) {
  const reqs = { total: 0, login: 0, paginas: 0, motivos: 0, repeticoes: 0 };
  const lista = [], andamento = [];
  const novasOrigens = new Map();
  const agora = Date.now();
  const minutosDesde = (t) => (t == null || isNaN(t) ? null : Math.max(0, Math.floor((agora - t) / 60000)));
  const filtroStatus = ['10', ...STATUS_ANDAMENTO].map((s, i) => [`filters[status][$in][${i}]`, s]);
  // Desde ontem: uma entrega programada pode começar a buscar no dia seguinte ao da criação.
  await listar([['filters[created_at][$gte]', somaDias(hoje, -1) + ' 00:00:00'], ['filters[created_at][$lte]', hoje + ' 23:59:59'], ...filtroStatus], IDS_PRIORITARIAS, reqs, (p) => {
    const st = String(p.status);
    if (!IDS_PRIORITARIAS.includes(String(p.merchant?.id))) return;
    novasOrigens.set(String(p.id), { coords: coordsColeta(p), buscando: st === '10' });
    const base = {
      id: p.id,
      bandeira: /EXTRAFARMA/i.test(p.merchant.name) ? 'Extrafarma' : 'Pague Menos',
      lojaId: p.merchant.id,
      loja: String(p.merchant.name).replace(/\s+/g, ' ').trim(),
      franquia: p.franchise?.name || '',
      rota: rotaDoPedido(p),
      modalidade: p.badges?.type && String(p.badges.type) !== '0' ? String(p.badges.type) : null,
    };
    if (st === '10') {
      const ini = inicioBusca(p);
      lista.push({ ...base, min: ini ? minutosDesde(Date.parse(ini)) : null });
    } else if (STATUS_ANDAMENTO.includes(st)) {
      const d = p.dates || {}, e = p.deliveryman;
      andamento.push({
        ...base,
        status: String(p.status_label || st),
        entregador: e?.id ? `${e.id} - ${String(e.name || '').replace(/\s+/g, ' ').trim()}` : '—',
        minEtapa: minutosDesde(inicioEtapa(d)),
        minTotal: minutosDesde(Date.parse(d.created_at || p.created_at)),
      });
    }
  });
  lista.sort((a, b) => (b.min ?? 0) - (a.min ?? 0));
  andamento.sort((a, b) => (b.minTotal ?? 0) - (a.minTotal ?? 0));
  origens = novasOrigens;
  return { em: new Date().toISOString(), lista, andamento, reqs };
}

// ---------------------------------------------------- entregadores até 3 km
// Mesma conta do Radar: distância em linha reta da coleta até o GPS do /dashboard. O GPS e a foto do
// entregador não saem daqui.
const RAIO_KM = 3;
const distanciaKm = ([a, b], [c, d]) => {
  const rad = Math.PI / 180, s1 = Math.sin((c - a) * rad / 2), s2 = Math.sin((d - b) * rad / 2);
  return 2 * 6371 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(a * rad) * Math.cos(c * rad) * s2 * s2));
};
const veiculoDe = (v) => { const s = String(v || '').toLowerCase(); return /moto/.test(s) ? 'Moto' : /bike|bicy|bicicleta/.test(s) ? 'Bike' : /car|van|pickup/.test(s) ? 'Carro' : 'Outro'; };
export const pedidoBuscando = (pedido) => !!origens.get(String(pedido))?.buscando;
let cacheOnline = { t: 0, dados: null, voo: null };
async function onlineAgora(reqs) {
  // 30 s de cache: vários cliques seguidos custam uma requisição só
  if (cacheOnline.dados && Date.now() - cacheOnline.t < 30e3) return cacheOnline.dados;
  cacheOnline.voo ||= api('/dashboard?franchiseId=' + FRANQUIA_ID, reqs, 'dashboard').then((j) => {
    cacheOnline.dados = (j?.data || j || {}).online_deliverymen || {};
    cacheOnline.t = Date.now();
    return cacheOnline.dados;
  }).finally(() => { cacheOnline.voo = null; });
  return cacheOnline.voo;
}
// `null` = a entrega não está aberta nas lojas prioritárias
export async function entregadoresProximos(pedido) {
  const chave = String(pedido);
  if (!origens.has(chave)) return null;
  const reqs = { total: 0, login: 0, dashboard: 0, repeticoes: 0 };
  const { coords: origem, buscando } = origens.get(chave);
  if (!origem) return { em: new Date().toISOString(), raioKm: RAIO_KM, semColeta: true, lista: [], reqs };
  const od = await onlineAgora(reqs);
  const perto = [[od.available || [], false], [od.in_delivery || [], true]].flatMap(([l, emEntrega]) => l.map((e) => {
    const lat = Number(e.latitude), lng = Number(e.longitude);
    return lat && lng ? { id: e.id, nome: String(e.name || '—').replace(/\s+/g, ' ').trim(), telefone: e.phone ? String(e.phone) : null, veiculo: veiculoDe(e.vehicle_type), emEntrega, km: Math.round(distanciaKm(origem, [lat, lng]) * 100) / 100 } : null;
  })).filter((e) => e && e.km <= RAIO_KM).sort((a, b) => a.emEntrega - b.emEntrega || a.km - b.km);
  return { em: new Date().toISOString(), raioKm: RAIO_KM, buscando, online: (od.available || []).length + (od.in_delivery || []).length, reqs, lista: perto };
}

// ----------------------------------------------------------------- entregadores
// Histórico das lojas com ranking: { dia: { lojaId: { entregadorId: [nome, finalizadas] } } }.
export async function lerEntregadores(de, ate) {
  const reqs = { total: 0, login: 0, paginas: 0, motivos: 0, repeticoes: 0 };
  const dias = {};
  const vistos = new Set();
  await listar([['filters[created_at][$gte]', de + ' 00:00:00'], ['filters[created_at][$lte]', somaDias(ate, 1) + ' 23:59:59'], ['filters[status][$in][]', '50']], Object.keys(LOJAS_ENTREGADORES), reqs, (p) => {
    if (String(p.status) !== '50' || vistos.has(p.id) || !p.merchant?.id) return;
    vistos.add(p.id);
    const criado = p.dates?.created_at || p.created_at;
    if (!criado) return;
    const dia = local(criado).slice(0, 10);
    if (dia < de || dia > ate) return;
    somarEntregador((dias[dia] ||= {}), p);
  });
  return { dias, reqs };
}
