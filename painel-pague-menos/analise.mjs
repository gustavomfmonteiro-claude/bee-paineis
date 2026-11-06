// Transforma um dia coletado nos KPIs, rankings, orientações e lojas prioritárias do painel e do relatório.
import { LOJAS_ENTREGADORES, PRAZO_MOD, ORDEM_MOD } from './coletor.mjs';

export const PRIORITARIAS = ['678', '7300', '933', '495', '890', '7362', '839'];
const MIN_DEMANDA_TAXA = 10;   // volume mínimo para taxa e tempo médio entrarem em ranking ou orientação
const TOP = 10;
const MIN_OTD_MOD = 5;         // entregas mínimas de uma modalidade na loja para virar orientação

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const media = (s, n) => (n ? Math.round((10 * s) / n) / 10 : null);
const br = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }));

// "678 - PAGUE MENOS - ALDEOTA" -> número, bandeira e bairro
function identificar(nome) {
  const m = String(nome).match(/^\s*(\d+)\s*-\s*(PAGUE MENOS|EXTRAFARMA)\s*-\s*(.+?)\s*$/i);
  const band = /EXTRAFARMA/i.test(nome) ? 'EF' : 'PM';
  return m ? { num: m[1], band, bairro: m[3] } : { num: '', band, bairro: String(nome) };
}

// OTD por modalidade: finalizada que chegou ao cliente dentro do prazo da modalidade (30 min, 60 min, 24 h).
// Agendada e Padrão não têm prazo e ficam fora do OTD. `fontes` = lojas brutas do coletor.
function porModalidade(fontes) {
  const t = {};
  for (const l of fontes) for (const [m, x] of Object.entries(l.m || {})) {
    const y = (t[m] ||= { dem: 0, fin: 0, canc: 0, n: 0, on: 0, soma: 0 });
    for (const k of Object.keys(y)) y[k] += x[k] || 0;
  }
  return ORDEM_MOD.filter((m) => t[m]?.dem).map((m) => {
    const x = t[m];
    return { mod: m, prazo: PRAZO_MOD[m] || null, dem: x.dem, fin: x.fin, canc: x.canc, taxaCanc: pct(x.canc, x.dem),
      otd: pct(x.on, x.n), otdN: x.n, noPrazo: x.on, tempo: media(x.soma, x.n) };
  });
}
// OTD de todas as modalidades juntas, cada entrega contra o próprio prazo
function otdGeral(mods) {
  const n = mods.reduce((t, m) => t + m.otdN, 0), on = mods.reduce((t, m) => t + m.noPrazo, 0);
  return { otd: pct(on, n), otdN: n, temModalidade: mods.length > 0 };
}

function linhaLoja(id, l, perdidas) {
  const pico = l.h.reduce((best, v, i) => (v > l.h[best] ? i : best), 0);
  const acimaDe5 = l.acN - l.ac5;
  const semAceite = l.semAceite - perdidas;
  const mods = porModalidade([l]);
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
    p1Med: media(l.p1Soma, l.otdN), p2Med: media(l.p2Soma, l.otdN), pontasN: l.otdN,
    mods, ...otdGeral(mods),
    pico: l.dem ? pico : null,
  };
}

function kpis(lojas) {
  const t = { dem: 0, fin: 0, canc: 0, and: 0, acSoma: 0, acN: 0, ac5: 0, semAceite: 0, direto: 0, c05: 0, cOp: 0, otdN: 0, p1On: 0, p2On: 0, geralOn: 0, p1Soma: 0, p2Soma: 0 };
  for (const l of lojas) for (const k of Object.keys(t)) t[k] += l[k] || 0;
  const mods = porModalidade(lojas);
  return {
    dem: t.dem, fin: t.fin, canc: t.canc, and: t.and, lojas: lojas.length,
    taxaCanc: pct(t.canc, t.dem),
    aceite: media(t.acSoma, t.acN), pctAte5: pct(t.ac5, t.acN), semAceite: t.semAceite, direto: t.direto,
    cOp: t.cOp, pctOpDosCanc: pct(t.cOp, t.canc), c05: t.c05, pctC05: pct(t.c05, t.canc),
    p1Med: media(t.p1Soma, t.otdN), p2Med: media(t.p2Soma, t.otdN), pontasN: t.otdN,
    mods, ...otdGeral(mods),
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
    for (const m of l.mods) {
      if (!m.prazo || m.otdN < MIN_OTD_MOD || m.otd >= 70) continue;
      const prazo = m.prazo >= 1440 ? '24 h' : m.prazo + ' min';
      const pontas = l.p1Med != null ? ` No dia, a chegada à loja levou ${br(l.p1Med)} min e a saída até o cliente ${br(l.p2Med)} min, em média.` : '';
      add(m.otd < 50 ? 'alta' : 'media', 'OTD ' + m.mod,
        `${br(m.otd)}% das ${m.otdN} entregas ${m.mod} chegaram ao cliente em até ${prazo}; média de ${br(m.tempo)} min da criação à entrega.${pontas}`,
        m.prazo >= 1440
          ? 'Entrega econômica passou de 24 h: levantar com a operação por que ficou sem entregador.'
          : l.p1Med != null && l.p1Med > l.p2Med
            ? 'O atraso está antes da coleta: priorizar a oferta perto da loja e o aceite nas entregas com prazo curto.'
            : 'O atraso está depois da coleta: conferir a espera na loja, a distância das entregas e o raio de atendimento.');
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

// ------------------------------------------------------------------- evolução
// Compara só dias fechados. `porDia` = { dia: { lojaId: [demanda, finalizadas, canceladas] } }.
const somaData = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const diaSemana = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const ultimoDoMes = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const curta = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const ESTAVEL_PCT = 5;

function somaPeriodo(porDia, de, ate) {
  const lojas = {};
  let dias = 0;
  for (let d = de; d <= ate; d = somaData(d, 1)) {
    const v = porDia[d];
    if (!v) continue;
    dias++;
    for (const [id, x] of Object.entries(v)) {
      const t = (lojas[id] ||= [0, 0, 0]);
      for (let i = 0; i < 3; i++) t[i] += x[i] || 0;
    }
  }
  return { dias, lojas };
}
const variacao = (atual, base) => (base ? Math.round((1000 * (atual - base)) / base) / 10 : null);

function visao(porDia, nomes, periodo, titulo, serie) {
  const atual = somaPeriodo(porDia, periodo.de, periodo.ate);
  const base = somaPeriodo(porDia, periodo.baseDe, periodo.baseAte);
  const temBase = base.dias > 0;
  const band = (id) => (/EXTRAFARMA/i.test(nomes[id] || '') ? 'EF' : 'PM');
  const grupo = { total: [0, 0, 0, 0, 0, 0], PM: [0, 0, 0, 0, 0, 0], EF: [0, 0, 0, 0, 0, 0] };
  const ids = new Set([...Object.keys(atual.lojas), ...Object.keys(base.lojas)]);
  const lojas = [...ids].map((id) => {
    const a = atual.lojas[id] || [0, 0, 0], b = base.lojas[id] || [0, 0, 0], g = band(id);
    for (const c of ['total', g]) for (let i = 0; i < 3; i++) { grupo[c][i] += a[i]; grupo[c][i + 3] += b[i]; }
    const nome = nomes[id] || 'Loja ' + id;
    return { id, ...identificar(nome), prio: PRIORITARIAS.includes(identificar(nome).num), dem: a[0], fin: a[1], canc: a[2], base: b[0], dif: a[0] - b[0], pct: temBase ? variacao(a[0], b[0]) : null, taxaCanc: pct(a[2], a[0]), taxaCancBase: pct(b[2], b[0]) };
  });
  const resumo = (x) => ({ dem: x[0], fin: x[1], canc: x[2], base: x[3], finBase: x[4], cancBase: x[5], pct: temBase ? variacao(x[0], x[3]) : null, taxaCanc: pct(x[2], x[0]), taxaCancBase: pct(x[5], x[3]) });
  const comBase = temBase ? lojas : [];
  return {
    titulo, de: periodo.de, ate: periodo.ate, baseDe: periodo.baseDe, baseAte: periodo.baseAte, temBase,
    diasAtual: atual.dias, diasBase: base.dias,
    grupo: { total: resumo(grupo.total), PM: resumo(grupo.PM), EF: resumo(grupo.EF) },
    contagem: {
      ganhando: comBase.filter((l) => l.base && l.pct >= ESTAVEL_PCT).length,
      perdendo: comBase.filter((l) => l.base && l.pct <= -ESTAVEL_PCT).length,
      estaveis: comBase.filter((l) => l.base && Math.abs(l.pct) < ESTAVEL_PCT).length,
      novas: comBase.filter((l) => !l.base && l.dem).length,
    },
    ganhos: comBase.filter((l) => l.dif > 0).sort((a, b) => b.dif - a.dif || b.dem - a.dem).slice(0, TOP),
    perdas: comBase.filter((l) => l.dif < 0).sort((a, b) => a.dif - b.dif || b.base - a.base).slice(0, TOP),
    lojas: lojas.sort((a, b) => b.dif - a.dif || b.dem - a.dem),
    serie,
  };
}

function pontoSerie(porDia, nomes, rotulo, de, ate, limite, parcial) {
  const s = somaPeriodo(porDia, de, ate > limite ? limite : ate);
  let PM = 0, EF = 0;
  for (const [id, x] of Object.entries(s.lojas)) { if (/EXTRAFARMA/i.test(nomes[id] || '')) EF += x[0]; else PM += x[0]; }
  return { rotulo, de, ate: ate > limite ? limite : ate, PM, EF, parcial: !!parcial };
}

export function evolucao(porDia, nomes, pedidoAte) {
  const fechados = Object.keys(porDia).sort();
  if (!fechados.length) return null;
  const primeiro = fechados[0], ultimo = fechados[fechados.length - 1];
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(pedidoAte || '') && pedidoAte >= primeiro && pedidoAte <= ultimo ? pedidoAte : ultimo;
  const [ano, mes, dia] = ate.split('-').map(Number);

  const inicioSemana = (d) => somaData(d, -((diaSemana(d) + 6) % 7)); // segunda-feira
  const seg = inicioSemana(ate), diasSemana = Math.round((Date.parse(ate) - Date.parse(seg)) / 86400e3);
  const iniMes = ate.slice(0, 8) + '01';
  const anoBase = mes === 1 ? ano - 1 : ano, mesBase = mes === 1 ? 12 : mes - 1;
  const fimBase = Math.min(dia, ultimoDoMes(anoBase, mesBase));
  const baseMes = `${anoBase}-${String(mesBase).padStart(2, '0')}`;

  const serieDias = [];
  for (let i = 29; i >= 0; i--) { const d = somaData(ate, -i); if (d >= primeiro) serieDias.push(pontoSerie(porDia, nomes, curta(d), d, d, ate)); }
  const serieSemanas = [];
  for (let i = 15; i >= 0; i--) { const d = somaData(seg, -7 * i); if (somaData(d, 6) >= primeiro) serieSemanas.push(pontoSerie(porDia, nomes, curta(d), d, somaData(d, 6), ate, somaData(d, 6) > ate)); }
  const serieMeses = [];
  for (let m = Number(primeiro.slice(5, 7)); m <= mes; m++) {
    const ini = `${ano}-${String(m).padStart(2, '0')}-01`, fim = `${ano}-${String(m).padStart(2, '0')}-${String(ultimoDoMes(ano, m)).padStart(2, '0')}`;
    serieMeses.push(pontoSerie(porDia, nomes, MESES[m - 1], ini, fim, ate, fim > ate));
  }

  return {
    ate, primeiro, ultimo,
    visoes: {
      dia: visao(porDia, nomes, { de: ate, ate, baseDe: somaData(ate, -7), baseAte: somaData(ate, -7) }, 'Dia contra o mesmo dia da semana anterior', serieDias),
      diaAnterior: visao(porDia, nomes, { de: ate, ate, baseDe: somaData(ate, -1), baseAte: somaData(ate, -1) }, 'Dia contra o dia anterior', serieDias),
      semana: visao(porDia, nomes, { de: seg, ate, baseDe: somaData(seg, -7), baseAte: somaData(seg, diasSemana - 7) }, diasSemana === 6 ? 'Semana contra a semana anterior' : 'Semana até o dia escolhido contra os mesmos dias da semana anterior', serieSemanas),
      mes: visao(porDia, nomes, { de: iniMes, ate, baseDe: `${baseMes}-01`, baseAte: `${baseMes}-${String(fimBase).padStart(2, '0')}` }, 'Mês até o dia escolhido contra o mesmo intervalo do mês anterior', serieMeses),
    },
  };
}

// Junta vários dias num só para o filtro De/Até: soma os contadores de cada loja, as horas e as modalidades
// e junta os cancelamentos, cada um com a data dele. `dias` em ordem de data.
export function somarDias(dias) {
  if (dias.length === 1) return dias[0];
  const lojas = {}, horas = Array.from({ length: 24 }, () => [0, 0, 0]), cancs = [];
  for (const d of dias) {
    for (const [id, l] of Object.entries(d.lojas)) {
      const t = (lojas[id] ||= { n: l.n, h: Array(24).fill(0), m: {} });
      t.n = l.n;
      for (const [k, v] of Object.entries(l)) if (typeof v === 'number') t[k] = (t[k] || 0) + v;
      l.h.forEach((v, i) => { t.h[i] += v; });
      for (const [m, x] of Object.entries(l.m || {})) {
        const y = (t.m[m] ||= {});
        for (const [k, v] of Object.entries(x)) y[k] = (y[k] || 0) + v;
      }
    }
    (d.horas || []).forEach((h, i) => { for (let j = 0; j < 3; j++) horas[i][j] += h[j] || 0; });
    for (const c of d.cancs) cancs.push({ ...c, dia: d.dia });
  }
  return {
    dia: dias[dias.length - 1].dia, de: dias[0].dia, ate: dias[dias.length - 1].dia,
    fechado: dias.every((d) => d.fechado), lido_em: dias.map((d) => d.lido_em).sort().pop(),
    lojas, horas, cancs,
  };
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
    const cs = d.cancs.filter((c) => c.l === l.id).sort((a, b) => ((a.dia || '') + a.h).localeCompare((b.dia || '') + b.h));
    return { ...l, grupos: contarMotivos(cs), motivos: contarTextos(cs), cancelamentos: cs.map((c) => ({ id: c.id, dia: c.dia || d.dia, h: c.h, min: c.min, fase: c.f, motivo: c.m || 'Sem motivo informado', grupo: c.g, op: c.op, mod: c.md || null })) };
  });

  return {
    dia: d.dia, de: d.de || d.dia, ate: d.ate || d.dia, periodo: !!d.de && d.de !== d.ate,
    fechado: !!d.fechado, lido_em: d.lido_em,
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
