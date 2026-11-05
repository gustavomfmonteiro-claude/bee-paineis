// Transforma um dia coletado nos KPIs, rankings, orientações e lojas prioritárias do painel e do relatório.
import { LOJAS_ENTREGADORES } from './coletor.mjs';

export const PRIORITARIAS = ['678', '7300', '933', '495', '890', '7362', '839'];
const MIN_DEMANDA_TAXA = 10;   // volume mínimo para taxa e tempo médio entrarem em ranking ou orientação
const TOP = 10;

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const media = (s, n) => (n ? Math.round((10 * s) / n) / 10 : null);
const br = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }));

// "678 - PAGUE MENOS - ALDEOTA" -> número, bandeira e bairro
function identificar(nome) {
  const m = String(nome).match(/^\s*(\d+)\s*-\s*(PAGUE MENOS|EXTRAFARMA)\s*-\s*(.+?)\s*$/i);
  const band = /EXTRAFARMA/i.test(nome) ? 'EF' : 'PM';
  return m ? { num: m[1], band, bairro: m[3] } : { num: '', band, bairro: String(nome) };
}

function linhaLoja(id, l, perdidas) {
  const pico = l.h.reduce((best, v, i) => (v > l.h[best] ? i : best), 0);
  const acimaDe5 = l.acN - l.ac5;
  const semAceite = l.semAceite - perdidas;
  return {
    id, nome: l.n, ...identificar(l.n),
    dem: l.dem, fin: l.fin, canc: l.canc, and: l.and,
    taxaCanc: pct(l.canc, l.dem),
    direto: l.direto || 0,
    aceite: media(l.acSoma, l.acN), acimaDe5, pctAcimaDe5: pct(acimaDe5, l.acN), semAceite,
    // dificuldade: pedidos que passaram de 5 min até o aceite ou que nem chegaram a ser aceitos,
    // sem contar os que caíram antes do aceite porque outra transportadora aceitou primeiro
    dificuldade: pct(acimaDe5 + semAceite, l.acN + semAceite),
    cOp: l.cOp, pctOp: pct(l.cOp, l.dem),
    c05: l.c05, pctC05: pct(l.c05, l.canc),
    otd1: pct(l.p1On, l.otdN), otd2: pct(l.p2On, l.otdN), otd: pct(l.geralOn, l.otdN), otdN: l.otdN,
    p1Med: media(l.p1Soma, l.otdN), p2Med: media(l.p2Soma, l.otdN),
    pico: l.dem ? pico : null,
  };
}

function kpis(lojas) {
  const t = { dem: 0, fin: 0, canc: 0, and: 0, acSoma: 0, acN: 0, ac5: 0, semAceite: 0, direto: 0, c05: 0, cOp: 0, otdN: 0, p1On: 0, p2On: 0, geralOn: 0, p1Soma: 0, p2Soma: 0 };
  for (const l of lojas) for (const k of Object.keys(t)) t[k] += l[k] || 0;
  return {
    dem: t.dem, fin: t.fin, canc: t.canc, and: t.and, lojas: lojas.length,
    taxaCanc: pct(t.canc, t.dem),
    aceite: media(t.acSoma, t.acN), pctAte5: pct(t.ac5, t.acN), semAceite: t.semAceite, direto: t.direto,
    cOp: t.cOp, pctOpDosCanc: pct(t.cOp, t.canc), c05: t.c05, pctC05: pct(t.c05, t.canc),
    otd1: pct(t.p1On, t.otdN), otd2: pct(t.p2On, t.otdN), otd: pct(t.geralOn, t.otdN), otdN: t.otdN,
    p1Med: media(t.p1Soma, t.otdN), p2Med: media(t.p2Soma, t.otdN),
  };
}

function contarMotivos(cancs) {
  const grupos = new Map();
  for (const c of cancs) {
    const g = grupos.get(c.g) || { grupo: c.g, op: c.op, n: 0 };
    g.n++;
    grupos.set(c.g, g);
  }
  return [...grupos.values()].sort((a, b) => b.n - a.n).map((g) => ({ ...g, pct: pct(g.n, cancs.length) }));
}
function contarTextos(cancs) {
  const m = new Map();
  for (const c of cancs) {
    const k = c.m || 'Sem motivo informado';
    const x = m.get(k) || { motivo: k, grupo: c.g, op: c.op, n: 0, c05: 0 };
    x.n++;
    if (c.min != null && c.min <= 5) x.c05++;
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

// Orientações: cada regra só dispara com número suficiente e cita a evidência que a acionou.
// Elas apontam onde agir; a causa de cada caso precisa ser confirmada com a loja ou com a operação.
const h = (x) => String(x).padStart(2, '0') + 'h';
function orientar(linhas, cancs) {
  const out = [];
  const num = (l) => (l.num ? 'Loja ' + l.num : l.nome) + ' · ' + l.bairro;
  for (const l of linhas) {
    const prio = PRIORITARIAS.includes(l.num);
    const add = (nivel, area, evidencia, acao) => out.push({ loja: num(l), num: l.num, prio, nivel, area, evidencia, acao, peso: nivel === 'alta' ? 2 : 1 });
    if (l.dem >= MIN_DEMANDA_TAXA && l.dificuldade >= 40) {
      add(l.dificuldade >= 60 ? 'alta' : 'media', 'Aceite',
        `${br(l.dificuldade)}% dos pedidos passaram de 5 min até o aceite ou não foram aceitos; média de ${br(l.aceite)} min; ${l.semAceite} cancelada(s) sem aceite.`,
        `Reforçar a oferta de entregadores perto da loja, principalmente por volta das ${h(l.pico)}, o pico de demanda dela no dia.`);
    }
    if (l.cOp >= 3 && l.pctOp >= 10) {
      const top = contarMotivos(cancs.filter((c) => c.l === l.id && c.op))[0];
      add(l.pctOp >= 20 ? 'alta' : 'media', 'Cancelamento operacional',
        `${l.cOp} cancelamentos operacionais (${br(l.pctOp)}% da demanda); o principal é "${top?.grupo ?? '—'}".`,
        top?.grupo === 'Falta de entregador'
          ? 'Revisar a cobertura de entregadores na região da loja e o alcance da oferta.'
          : 'Levantar com a operação os casos de atraso ou problema do entregador nessa loja.');
    }
    if (l.c05 >= 3 && l.pctC05 >= 40) {
      const top = contarMotivos(cancs.filter((c) => c.l === l.id && c.min != null && c.min <= 5))[0];
      add(l.c05 >= 6 ? 'alta' : 'media', 'Cancelamento de 0 a 5 min',
        `${l.c05} de ${l.canc} cancelamentos saíram em até 5 min da criação; o principal é "${top?.grupo ?? '—'}".`,
        top?.grupo === 'Perdida para outra transportadora'
          ? 'Outra transportadora aceitou primeiro: alinhar com a loja se o acionamento em paralelo é intencional.'
          : top?.op
            ? 'Motivo ligado ao entregador: reforçar a oferta perto da loja e levantar os casos com a operação.'
            : 'Conferir com a loja o que motiva o cancelamento rápido e alinhar o tempo de espera pelo aceite.');
    }
    if (l.otdN >= MIN_DEMANDA_TAXA && l.otd1 < 70) {
      add(l.otd1 < 50 ? 'alta' : 'media', 'OTD ponta 1',
        `${br(l.otd1)}% chegaram à loja em até 15 min; média de ${br(l.p1Med)} min.`,
        'Entregador está chegando tarde na loja: rever a oferta ao redor dela e o tempo de aceite.');
    }
    if (l.otdN >= MIN_DEMANDA_TAXA && l.otd2 < 70) {
      add(l.otd2 < 50 ? 'alta' : 'media', 'OTD ponta 2',
        `${br(l.otd2)}% chegaram ao cliente em até 15 min depois da saída; média de ${br(l.p2Med)} min.`,
        'Conferir a distância das entregas dessa loja e se o raio de atendimento está adequado.');
    }
  }
  // Prioritárias primeiro dentro do mesmo nível: é onde a operação já está de olho.
  return out.sort((a, b) => b.peso - a.peso || Number(b.prio) - Number(a.prio)).map(({ peso, ...o }) => o);
}

// Entregadores com mais entregas finalizadas por loja, em cada período. Dia = data de criação do pedido.
export function rankingEntregadores(porDia, hoje) {
  const desde = (n) => new Date(Date.parse(hoje + 'T12:00:00Z') - (n - 1) * 86400e3).toISOString().slice(0, 10);
  const periodos = { hoje: hoje, d7: desde(7), d30: desde(30) };
  return Object.entries(LOJAS_ENTREGADORES).map(([id, nome]) => {
    const saida = { id, nome, periodos: {} };
    for (const [chave, inicio] of Object.entries(periodos)) {
      const soma = new Map();
      for (const [dia, lojas] of Object.entries(porDia)) {
        if (dia < inicio || dia > hoje) continue;
        for (const [eid, [enome, n]] of Object.entries(lojas[id] || {})) {
          const x = soma.get(eid) || { id: eid, nome: enome, n: 0 };
          x.n += n;
          soma.set(eid, x);
        }
      }
      const total = [...soma.values()].reduce((t, x) => t + x.n, 0);
      saida.periodos[chave] = { total, entregadores: soma.size, lista: [...soma.values()].sort((a, b) => b.n - a.n).slice(0, 15).map((x) => ({ ...x, pct: pct(x.n, total) })) };
    }
    return saida;
  });
}

export function analisarDia(d) {
  const brutas = Object.entries(d.lojas);
  const perdidas = {};
  for (const c of d.cancs) if (c.f === 'Antes do aceite' && c.g === 'Perdida para outra transportadora') perdidas[c.l] = (perdidas[c.l] || 0) + 1;
  const linhas = brutas.map(([id, l]) => linhaLoja(id, l, perdidas[id] || 0));
  const comVolume = linhas.filter((l) => l.dem >= MIN_DEMANDA_TAXA);
  const orden = (arr, f) => [...arr].sort(f).slice(0, TOP);
  const pm = brutas.filter(([, l]) => !/EXTRAFARMA/i.test(l.n)).map(([, l]) => l);
  const ef = brutas.filter(([, l]) => /EXTRAFARMA/i.test(l.n)).map(([, l]) => l);

  const prioridade = PRIORITARIAS.map((num) => {
    const l = linhas.find((x) => x.num === num);
    if (!l) return { num, semPedidos: true };
    const cs = d.cancs.filter((c) => c.l === l.id).sort((a, b) => a.h.localeCompare(b.h));
    return { ...l, grupos: contarMotivos(cs), motivos: contarTextos(cs), cancelamentos: cs.map((c) => ({ id: c.id, h: c.h, min: c.min, fase: c.f, motivo: c.m || 'Sem motivo informado', grupo: c.g, op: c.op })) };
  });

  return {
    dia: d.dia, fechado: !!d.fechado, lido_em: d.lido_em,
    kpis: kpis(brutas.map(([, l]) => l)),
    bandeiras: { PM: kpis(pm), EF: kpis(ef) },
    horas: d.horas,
    motivos: contarMotivos(d.cancs),
    motivosPendentes: d.cancs.filter((c) => c.pendente).length,
    rankings: {
      demanda: orden(linhas, (a, b) => b.dem - a.dem),
      aceite: orden(comVolume.filter((l) => l.dificuldade != null), (a, b) => b.dificuldade - a.dificuldade || (b.aceite ?? 0) - (a.aceite ?? 0)),
      operacional: orden(linhas.filter((l) => l.cOp > 0), (a, b) => b.cOp - a.cOp || b.pctOp - a.pctOp),
      ate5: orden(linhas.filter((l) => l.c05 > 0), (a, b) => b.c05 - a.c05 || b.pctC05 - a.pctC05),
    },
    orientacoes: orientar(linhas, d.cancs),
    prioridade,
    lojas: [...linhas].sort((a, b) => b.dem - a.dem),
    minDemandaTaxa: MIN_DEMANDA_TAXA,
  };
}
