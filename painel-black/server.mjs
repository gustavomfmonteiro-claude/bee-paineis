// Painel de conferência da promoção Black: digita ID ou CPF do entregador e vê, dia a dia,
// se ele cumpriu os três critérios. Fala direto com o MCP bee-franchising (mesmo acesso do Claude Code).
//
// Critérios do dia (00h00–23h59, Brasília):
//   ≥ 10 entregas finalizadas · aceite ≥ 70% · cancelamentos ≤ 5%
// Aceite (aproximado): pedidos que ficaram com ele ÷ (esses + desistências).
//   Desistência = o histórico do pedido mostra o próprio entregador saindo dele (volta para "Buscando").
//   Oferta recusada/ignorada não fica registrada em lugar nenhum da API, então não entra.
// Cancelamentos: cancelados no nome dele ÷ (finalizados + cancelados no nome dele).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliente, toolTela, saidasDeEntregador, ritmo } from './mcp.mjs';
const VARRE = [cliente('v1'), cliente('v2'), cliente('v3')]; // sessões da varredura; o ritmo é único (mcp.mjs)

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const PORTA = Number(process.env.PORTA || 3095);
const DESDE = process.env.BLACK_DESDE || '2026-11-23';
const ATE = process.env.BLACK_ATE || '2026-11-30';
const RELER_HOJE_MIN = Number(process.env.RELER_HOJE_MIN || 60);
const META = { finalizadas: 10, aceite: 70, cancelamento: 5 };

const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }), ...a);
const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
const hojeBR = () => diaBR(new Date().toISOString());
const somaDia = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dias = (de, ate) => { const o = []; for (let d = de; d <= ate; d = somaDia(d, 1)) o.push(d); return o; };
const seg = (a, b) => (new Date(a) - new Date(b)) / 1000;

// ---------- leitura das desistências do dia (franquias ativas inteiras) ----------
const arq = (dia) => path.join(CACHE, `desistencias-${dia}.json`);
const lerCache = (dia) => { try { return JSON.parse(fs.readFileSync(arq(dia), 'utf8')); } catch { return null; } };
const leitura = {}; // dia → { fase, feito, total, inicio }

// O filtro de data do MCP corta pelo dia em UTC (pedido criado às 21h de Brasília já cai no dia seguinte).
// Por isso cada dia de Brasília junta duas listagens UTC (dia e dia+1) e filtra pelo horário de Brasília.
// A listagem de um dia UTC já encerrado fica em cache e serve aos dois dias de Brasília que a usam.
const arqLista = (d) => path.join(CACHE, `lista-utc-${d}.json`);
async function listarUTC(d, st) {
  const encerrado = Date.now() >= Date.parse(somaDia(d, 1) + 'T00:00:00Z') + 30 * 60e3;
  if (encerrado) { try { return JSON.parse(fs.readFileSync(arqLista(d), 'utf8')); } catch {} }
  const pedidos = [];
  let prox = 1, fim = false;
  async function trab(tool) {
    while (!fim) {
      const page = prox++;
      const r = await tool('search_orders', { created_from: d, created_to: d, page });
      if (!r.data?.length) { fim = true; break; }
      for (const o of r.data) pedidos.push({ id: o.id, criado: o.created_at, busca: o.searching, st: String(o.status),
        ent: o.deliveryman?.id != null ? String(o.deliveryman.id) : null, nome: o.deliveryman?.name || '',
        loja: o.merchant?.name || '', cancEm: o.dates?.cancelled_at || null });
      st.feito++;
      if (!r.meta?.next_page) fim = true;
    }
  }
  await Promise.all(VARRE.map(trab));
  const lista = [...new Map(pedidos.map((p) => [p.id, p])).values()];
  if (encerrado) fs.writeFileSync(arqLista(d), JSON.stringify(lista));
  return lista;
}
async function listarDia(dia, st) {
  const todos = [...await listarUTC(dia, st), ...await listarUTC(somaDia(dia, 1), st)];
  return [...new Map(todos.filter((p) => diaBR(p.criado) === dia).map((p) => [p.id, p])).values()];
}

async function lerDesistencias(dia) {
  const st = leitura[dia] = { fase: 'listando pedidos', feito: 0, total: null, inicio: Date.now() };
  try {
    const pedidos = await listarDia(dia, st);
    // Quem desiste faz o pedido voltar a "Buscando", e isso renova o searching. Sem essa marca
    // não há rebusca (amostra de 80 pedidos no relatório de rebuscas: zero). Agendados também entram aqui.
    const cand = pedidos.filter((p) => p.busca && p.criado && seg(p.busca, p.criado) > 60);
    Object.assign(st, { fase: 'lendo históricos com rebusca', feito: 0, total: cand.length, listados: pedidos.length });
    const porEntregador = {};
    const fila = [...cand];
    async function trab(tool) {
      while (fila.length) {
        const p = fila.shift();
        try {
          const d = await tool('get_order', { order_id: p.id, include_events: true });
          for (const s of saidasDeEntregador(d.events)) {
            if (diaBR(s.quando) !== dia) continue; // saída noutro dia conta no dia em que aconteceu
            (porEntregador[s.entregador] ||= []).push({ pedido: p.id, loja: d.order?.merchant?.name || '',
              quando: s.quando, proprio: s.por_id === s.entregador, por: s.por });
          }
        } catch (e) { log('histórico', p.id, String(e).slice(0, 120)); }
        st.feito++;
      }
    }
    await Promise.all(VARRE.map(trab));
    const fechado = dia < hojeBR();
    // Placar de todos os entregadores do dia, pela mesma listagem (pedidos criados no dia, no nome dele)
    const entregadores = {};
    for (const p of pedidos) {
      if (!p.ent || diaBR(p.criado) !== dia) continue;
      const e = entregadores[p.ent] ||= { nome: p.nome, fin: 0, canc: 0, tot: 0, cancs: [] };
      e.tot++; if (p.st === '50') e.fin++; else if (p.st === '60') { e.canc++; e.cancs.push({ pedido: p.id, loja: p.loja, quando: p.cancEm }); }
    }
    const res = { dia, fechado, lidoEm: new Date().toISOString(), listados: pedidos.length, rebuscas: cand.length, porEntregador, entregadores };
    fs.writeFileSync(arq(dia), JSON.stringify(res));
    log('desistências', dia, fechado ? 'fechado' : 'parcial', pedidos.length, 'pedidos', cand.length, 'rebuscas');
    return res;
  } finally { delete leitura[dia]; }
}

// Saídas que aconteceram depois da meia-noite em pedidos criados na véspera ficam no cache da véspera;
// por isso cada dia olha o próprio arquivo e o do dia anterior.
function desistenciasDe(id, dia) {
  const out = [];
  for (const d of [somaDia(dia, -1), dia]) for (const s of lerCache(d)?.porEntregador?.[id] || []) if (diaBR(s.quando) === dia) out.push(s);
  return [...new Map(out.map((s) => [s.pedido + s.quando, s])).values()];
}

let fila = Promise.resolve();
function agendar() {
  const hoje = hojeBR();
  // ontem primeiro (é o dia que se confere), depois os outros dias fechados do mais novo ao mais velho, hoje por último
  const alvo = dias(somaDia(DESDE, -1), ATE < hoje ? ATE : hoje).sort((a, b) => (a === hoje) - (b === hoje) || b.localeCompare(a));
  for (const d of alvo) {
    const c = lerCache(d);
    const velho = !c || (!c.fechado && (d < hoje || Date.now() - Date.parse(c.lidoEm) > RELER_HOJE_MIN * 60e3));
    if (velho && !leitura[d]) { leitura[d] = { fase: 'na fila' }; fila = fila.then(() => lerDesistencias(d)).catch((e) => log('erro dia', d, String(e).slice(0, 200))); }
  }
}

// ---------- consulta do entregador ----------
async function acharEntregador(q) {
  const dig = String(q || '').replace(/\D/g, '');
  if (!dig) throw Object.assign(new Error('Digite o ID ou o CPF do entregador.'), { codigo: 400 });
  if (dig.length === 11) { // CPF
    const r = await toolTela('search_deliverymen', { cpf: dig });
    const e = (r.data || r.deliverymen || [])[0];
    if (e) return { id: String(e.id), nome: e.name, status: e.status };
  }
  try {
    const r = await toolTela('get_deliveryman', { deliveryman_id: Number(dig) });
    const e = r.deliveryman;
    if (e) return { id: String(e.id), nome: e.name, status: e.status, franquia: e.franchise?.name };
  } catch (e) { if (!/não encontrad/i.test(String(e))) throw e; }
  throw Object.assign(new Error('Entregador não encontrado nas franquias ativas.'), { codigo: 404 });
}

async function pedidosDoEntregador(id, de, ate) {
  const out = [];
  for (let page = 1; page < 200; page++) {
    const r = await toolTela('search_orders', { deliveryman_id: Number(id), created_from: de, created_to: ate, page });
    for (const o of r.data || []) out.push({ id: o.id, st: String(o.status), dia: diaBR(o.created_at), loja: o.merchant?.name || '',
      criado: o.created_at, fim: o.dates?.finished_at || null, canc: o.dates?.cancelled_at || null });
    if (!r.meta?.next_page) break;
  }
  // pedido novo chegando durante a paginação empurra a lista e repete itens: um por id
  return [...new Map(out.map((p) => [p.id, p])).values()];
}

async function consulta(q, de, ate) {
  const ent = await acharEntregador(q);
  const hoje = hojeBR();
  if (ate > hoje) ate = hoje;
  // Dia fechado e já varrido sai do cache; só o resto vai ao MCP
  const doCache = (dia) => { const c = lerCache(dia); return c?.fechado && c.entregadores ? c : null; };
  const faltam = dias(de, ate).filter((d) => !doCache(d));
  // +1 dia porque o filtro do MCP é por dia UTC (noite de Brasília cai no dia seguinte)
  const peds = faltam.length ? await pedidosDoEntregador(ent.id, faltam[0], somaDia(faltam[faltam.length - 1], 1)) : [];
  const linhas = dias(de, ate).map((dia) => {
    const cc = doCache(dia);
    let p, fin, canc, andamento, cancelados;
    if (cc) {
      const e = cc.entregadores[ent.id] || { fin: 0, canc: 0, tot: 0, cancs: [] };
      fin = e.fin; canc = e.canc; andamento = e.tot - e.fin - e.canc; p = { length: e.tot }; cancelados = e.cancs || [];
    } else {
      p = peds.filter((x) => x.dia === dia);
      fin = p.filter((x) => x.st === '50').length;
      canc = p.filter((x) => x.st === '60').length;
      andamento = p.length - fin - canc;
      cancelados = p.filter((x) => x.st === '60').map((x) => ({ pedido: x.id, loja: x.loja, quando: x.canc }));
    }
    const desist = desistenciasDe(ent.id, dia);
    const propria = desist.filter((d) => d.proprio);
    const aceitas = p.length;
    const lido = !!lerCache(dia);
    const aceite = lido && aceitas + propria.length ? (100 * aceitas) / (aceitas + propria.length) : null;
    const cancPct = fin + canc ? (100 * canc) / (fin + canc) : null;
    const ok = { finalizadas: fin >= META.finalizadas, aceite: aceite != null && aceite >= META.aceite, cancelamento: cancPct != null && cancPct <= META.cancelamento };
    const c = lerCache(dia);
    return { dia, parcial: dia === hoje, fin, canc, andamento, aceitas, desistencias: propria.length,
      retiradas: desist.length - propria.length, aceite, cancPct, ok, premio: ok.finalizadas && ok.aceite && ok.cancelamento,
      aceiteLido: !!c, aceiteFechado: !!c?.fechado, lidoEm: c?.lidoEm || null, emLeitura: leitura[dia]?.fase || null,
      detalhe: { desistencias: desist, cancelados } };
  });
  return { entregador: ent, de, ate, meta: META, dias: linhas, premiados: linhas.filter((l) => l.premio && l.aceiteLido && !l.parcial).length };
}

// ---------- vencedores do dia ----------
function avaliar({ fin, canc, tot }, desist) {
  const aceite = tot + desist ? (100 * tot) / (tot + desist) : null;
  const cancPct = fin + canc ? (100 * canc) / (fin + canc) : null;
  const ok = { finalizadas: fin >= META.finalizadas, aceite: aceite != null && aceite >= META.aceite, cancelamento: cancPct != null && cancPct <= META.cancelamento };
  return { aceite, cancPct, ok, falhas: Object.values(ok).filter((v) => !v).length };
}
function vencedores(dia) {
  const c = lerCache(dia);
  if (!c?.entregadores) return { dia, lido: false, leitura: leitura[dia] || null };
  const todos = new Set([...Object.keys(c.entregadores), ...Object.keys(c.porEntregador || {})]);
  const lista = [];
  for (const id of todos) {
    const e = c.entregadores[id] || { nome: '', fin: 0, canc: 0, tot: 0 };
    const d = desistenciasDe(id, dia).filter((x) => x.proprio).length;
    if (!e.tot && !d) continue;
    lista.push({ id, nome: e.nome, fin: e.fin, canc: e.canc, aceitas: e.tot, desistencias: d, ...avaliar(e, d) });
  }
  lista.sort((a, b) => a.falhas - b.falhas || b.fin - a.fin);
  const ganhou = lista.filter((x) => x.falhas === 0);
  // "quase": falhou num critério só e chegou perto do volume (bateu 10, ou ficou em 8–9 cumprindo o resto)
  const quase = lista.filter((x) => x.falhas === 1 && (x.ok.finalizadas || x.fin >= META.finalizadas - 2));
  return { dia, lido: true, fechado: c.fechado, lidoEm: c.lidoEm, entregadores: lista.length, vencedores: ganhou,
    quase: quase.slice(0, 60),
    totais: { vencedores: ganhou.length, quase: quase.length, entregas: lista.reduce((s, x) => s + x.fin, 0), atingiram10: lista.filter((x) => x.ok.finalizadas).length } };
}

// Lista geral: todos os dias da Black já lidos, um entregador por linha com os dias em que venceu.
function geral() {
  const hoje = hojeBR();
  const lista = dias(DESDE, ATE < hoje ? ATE : hoje);
  const porId = {};
  const diasInfo = lista.map((dia) => {
    const v = vencedores(dia);
    if (v.lido) for (const x of v.vencedores) {
      const e = porId[x.id] ||= { id: x.id, nome: x.nome, dias: [], fin: 0 };
      if (!e.nome && x.nome) e.nome = x.nome;
      e.dias.push({ dia, fin: x.fin, aceite: x.aceite, cancPct: x.cancPct, parcial: !v.fechado });
      e.fin += x.fin;
    }
    return { dia, lido: v.lido, fechado: !!v.fechado, vencedores: v.lido ? v.totais.vencedores : null };
  });
  const elegiveis = Object.values(porId).map((e) => ({ ...e, premios: e.dias.filter((d) => !d.parcial).length }))
    .sort((a, b) => b.premios - a.premios || b.fin - a.fin);
  return { desde: DESDE, ate: ATE, dias: diasInfo, elegiveis,
    totais: { entregadores: elegiveis.length, premios: elegiveis.reduce((s, e) => s + e.premios, 0) } };
}

// ---------- servidor ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(DIR, 'public', 'index.html')));
    }
    if (u.pathname === '/api/config') return json(res, 200, { desde: DESDE, ate: ATE, hoje: hojeBR(), meta: META, ritmoMs: ritmo() });
    if (u.pathname === '/api/status') {
      const lista = dias(DESDE, ATE < hojeBR() ? ATE : hojeBR()).map((d) => { const c = lerCache(d); return { dia: d, lido: !!c, fechado: !!c?.fechado, lidoEm: c?.lidoEm || null, pedidos: c?.listados ?? null, leitura: leitura[d] || null }; });
      return json(res, 200, { dias: lista });
    }
    if (u.pathname === '/api/geral') return json(res, 200, geral());
    if (u.pathname === '/api/geral.csv') {
      const g = geral();
      const linhas = [['ID', 'Entregador', 'Dias premiados', 'Dias', 'Finalizadas nos dias premiados'].join(';'),
        ...g.elegiveis.map((e) => [e.id, '"' + (e.nome || '').replace(/"/g, "'") + '"', e.premios,
          e.dias.filter((d) => !d.parcial).map((d) => d.dia.slice(8) + '/' + d.dia.slice(5, 7)).join(' '), e.fin].join(';'))];
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="elegiveis-black.csv"' });
      return res.end('﻿' + linhas.join('\r\n'));
    }
    if (u.pathname === '/api/vencedores') {
      const dia = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('dia')) ? u.searchParams.get('dia') : somaDia(hojeBR(), -1);
      return json(res, 200, vencedores(dia));
    }
    if (u.pathname === '/api/entregador') {
      const de = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('de')) ? u.searchParams.get('de') : DESDE;
      const ate = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('ate')) ? u.searchParams.get('ate') : ATE;
      if (de > ate) return json(res, 400, { erro: 'A data inicial é depois da final.' });
      if (dias(de, ate).length > 31) return json(res, 400, { erro: 'Use no máximo 31 dias.' });
      return json(res, 200, await consulta(u.searchParams.get('q'), de, ate));
    }
    json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    log('erro', u.pathname, String(e).slice(0, 200));
    json(res, e.codigo || 502, { erro: e.codigo ? e.message : 'Falha ao consultar o MCP da Bee: ' + String(e.message || e).slice(0, 160) });
  }
}).listen(PORTA, () => { log('painel black em http://localhost:' + PORTA); agendar(); setInterval(agendar, 10 * 60e3); });
