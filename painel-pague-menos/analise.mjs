// Transforma um dia coletado nos KPIs, rankings, orientações e lojas prioritárias do painel e do relatório.
import { IDS_PRIORITARIAS, LOJAS_ENTREGADORES, PRAZO_MOD, ORDEM_MOD, P } from './coletor.mjs';

export const PRIORITARIAS = ['678', '7300', '933', '495', '890', '7362', '839', '7356', '63', '715', '7515', '283', '51', '237', '7192', '1408', '1268', '616', '649', '7190', '7272', '938'];
const MIN_DEMANDA_TAXA = 10;   // volume mínimo para taxa e tempo médio entrarem em ranking ou orientação
const TOP = 10;
// Folga das comparações com prazo: os tempos de cada pedido são gravados com 3 casas (0,06 s), então
// a folga cobre o arredondamento de até dois tempos somados (0,0005 cada), menos de 0,07 s.
const EPS = 0.0011;
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

// OTD por modalidade: finalizada que chegou ao cliente dentro do prazo da modalidade (30 min, 60 min, 2 h).
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
      const prazo = m.prazo >= 120 ? m.prazo / 60 + ' h' : m.prazo + ' min';
      const pontas = l.p1Med != null ? ` No dia, a chegada à loja levou ${br(l.p1Med)} min e a saída até o cliente ${br(l.p2Med)} min, em média.` : '';
      add(m.otd < 50 ? 'alta' : 'media', 'OTD ' + m.mod,
        `${br(m.otd)}% das ${m.otdN} entregas ${m.mod} chegaram ao cliente em até ${prazo}; média de ${br(m.tempo)} min da criação à entrega.${pontas}`,
        l.p1Med != null && l.p1Med > l.p2Med
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
    lojas, horas, cancs, pedidos: dias.flatMap((d) => d.pedidos || []),
  };
}

// Quadro por KM (o mesmo do Power BI): faixas de 1 km pela distância do pedido, só finalizadas.
// On time geral = ponta 1 + ponta 2 até 30 min; loja = ponta 1 (criação -> chegada na loja) até 15 min;
// cliente = ponta 2 (saída da loja -> chegada no cliente) até 15 min. Base: finalizadas com os dois tempos.
// Também traz a espera média na loja e o OTD no prazo da modalidade, que é a regra do resto do painel.
function quadroKm(regs) {
  if (!regs) return null;
  const faixas = new Map();
  const novo = () => ({ fin: 0, base: 0, geral: 0, loja: 0, cliente: 0, esp: 0, espN: 0, modN: 0, modOn: 0 });
  const tot = novo();
  for (const r of regs) {
    if (r[P.st] !== 'F') continue;
    const i = r[P.km] == null ? -1 : Math.floor(r[P.km]);
    if (!faixas.has(i)) faixas.set(i, novo());
    for (const x of [faixas.get(i), tot]) {
      x.fin++;
      const a = r[P.p1], b = r[P.p2];
      if (a != null && b != null) {
        x.base++;
        if (a + b <= 30 + EPS) x.geral++;
        if (a <= 15 + EPS) x.loja++;
        if (b <= 15 + EPS) x.cliente++;
      }
      if (r[P.espera] != null) { x.esp += r[P.espera]; x.espN++; }
      const prazo = PRAZO_MOD[r[P.mod]];
      if (prazo && r[P.total] != null) { x.modN++; if (r[P.total] <= prazo + EPS) x.modOn++; }
    }
  }
  const linha = (rotulo, x) => ({
    faixa: rotulo, fin: x.fin, base: x.base,
    geralOn: x.geral, geralOff: x.base - x.geral, geral: pct(x.geral, x.base),
    lojaOn: x.loja, lojaOff: x.base - x.loja, loja: pct(x.loja, x.base),
    clienteOn: x.cliente, clienteOff: x.base - x.cliente, cliente: pct(x.cliente, x.base),
    espera: media(x.esp, x.espN), modalidade: pct(x.modOn, x.modN), modalidadeN: x.modN,
  });
  const linhas = [...faixas.entries()].sort((a, b) => (a[0] === -1) - (b[0] === -1) || a[0] - b[0])
    .map(([i, x]) => linha(i === -1 ? 'Sem distância' : `${i} km - ${i + 1} km`, x));
  return { linhas, total: linha('Total', tot) };
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
    porKm: quadroKm(d.pedidos),
  };
}

// ------------------------------------------------------------ análise de lojas
// Aba "Análise de lojas": tudo sai dos pedidos gravados um a um (P), filtrados pela loja e pelo período,
// para os números serem só da loja escolhida. Sem loja = análise geral do grupo.
const FAIXA_KM = 2;            // faixas de 2 km: 0 a 2, 3 a 4 (acima de 2 até 4), 5 a 6...
const LIMITE_LISTA = 400;      // cancelamentos listados um a um, do mais recente para o mais antigo
const MIN_BUSCA = 5;           // "cancelado com menos de 5 min de busca"

const novoAcc = () => ({ dem: 0, fin: 0, canc: 0, and: 0, n: 0, on: 0, tot: 0, totN: 0, p1: 0, p1N: 0, esp: 0, espN: 0, p2: 0, p2N: 0,
  ac: 0, acN: 0, ac5: 0, semBusca: 0, km: 0, kmN: 0, cOp: 0, c5: 0 });
function acumular(a, r, prazo) {
  a.dem++;
  if (r[P.aceite] != null) { a.ac += r[P.aceite]; a.acN++; if (r[P.aceite] <= 5 + EPS) a.ac5++; }
  if (r[P.semBusca]) a.semBusca++;
  if (r[P.km] != null) { a.km += r[P.km]; a.kmN++; }
  if (r[P.st] === 'F') {
    a.fin++;
    const t = r[P.total];
    if (t != null) { a.tot += t; a.totN++; if (prazo) { a.n++; if (t <= prazo + EPS) a.on++; } }
    if (r[P.p1] != null) { a.p1 += r[P.p1]; a.p1N++; }
    if (r[P.espera] != null) { a.esp += r[P.espera]; a.espN++; }
    if (r[P.p2] != null) { a.p2 += r[P.p2]; a.p2N++; }
  } else if (r[P.st] === 'C') {
    a.canc++;
    if (r[P.cancBusca] != null && r[P.cancBusca] < MIN_BUSCA) a.c5++;
  } else a.and++;
}
const fechar = (a) => ({
  dem: a.dem, fin: a.fin, canc: a.canc, and: a.and, taxaCanc: pct(a.canc, a.dem), taxaFin: pct(a.fin, a.dem),
  otd: pct(a.on, a.n), otdN: a.n, noPrazo: a.on,
  total: media(a.tot, a.totN), totalN: a.totN, p1: media(a.p1, a.p1N), espera: media(a.esp, a.espN), p2: media(a.p2, a.p2N), pontasN: a.p2N,
  aceite: media(a.ac, a.acN), aceiteN: a.acN, ate5: pct(a.ac5, a.acN), semBusca: a.semBusca,
  km: media(a.km, a.kmN), c5: a.c5,
});
const faixaDe = (km) => (km <= FAIXA_KM ? 0 : Math.ceil(km / FAIXA_KM) - 1);
const rotuloFaixa = (i) => (i === 0 ? `0 a ${FAIXA_KM} km` : `${i * FAIXA_KM + 1} a ${(i + 1) * FAIXA_KM} km`);

// Agrupa os registros por faixa de distância; pedidos sem distância ficam numa linha à parte.
function porFaixa(regs, prazoDe) {
  const f = new Map();
  for (const r of regs) {
    const i = r[P.km] == null ? -1 : faixaDe(r[P.km]);
    if (!f.has(i)) f.set(i, novoAcc());
    acumular(f.get(i), r, prazoDe(r));
  }
  return [...f.entries()].sort((a, b) => (a[0] === -1) - (b[0] === -1) || a[0] - b[0])
    .map(([i, a]) => ({ faixa: i === -1 ? 'Sem distância' : rotuloFaixa(i), ...fechar(a) }));
}

// `dias` = dias do período (com pedidos um a um), `loja` = id do merchant ou vazio para o grupo.
// Visão cliente: o prazo que o cliente enxerga em cada modalidade, o dobro do prazo da operação Bee.
export const PRAZO_CLIENTE = { 'Super Expressa': 60, Expressa: 120, 'Econômica': 240 };

// Loja prioritária (ou escolhida) sem pedido no período continua na lista, com zero, pelo nome do catálogo.
function completarLojas(nomes, demanda, catalogo, loja) {
  const pedidas = Array.isArray(loja) ? loja : loja ? String(loja).split(',') : [];
  for (const id of [...IDS_PRIORITARIAS, ...pedidas]) if (!nomes[id] && catalogo[id]) { nomes[id] = catalogo[id]; demanda[id] = 0; }
}

export function analisarLojas(dias, loja, prazos = PRAZO_MOD, catalogo = {}) {
  const nomes = {}, demanda = {};
  for (const d of dias) for (const [id, l] of Object.entries(d.lojas)) { nomes[id] = l.n; demanda[id] = (demanda[id] || 0) + l.dem; }
  completarLojas(nomes, demanda, catalogo, loja);
  const lojas = Object.keys(nomes).map((id) => ({ id, ...identificar(nomes[id]), dem: demanda[id], prio: PRIORITARIAS.includes(identificar(nomes[id]).num) }))
    .sort((a, b) => Number(b.prio) - Number(a.prio) || b.dem - a.dem);
  // uma loja ou várias (ids separados por vírgula): a análise soma todas as entregas das escolhidas
  const sel = new Set((Array.isArray(loja) ? loja : String(loja || '').split(',')).map((x) => x.trim()).filter((x) => nomes[x]));
  const escolhida = sel.size === 1 ? [...sel][0] : '';
  const semRegistro = dias.filter((d) => !Array.isArray(d.pedidos)).map((d) => d.dia);

  const regs = [], cancs = [];
  const evDias = [];
  for (const d of dias) {
    const e = { dia: d.dia, dem: 0, fin: 0, canc: 0, grupo: 0 };
    for (const r of d.pedidos || []) {
      e.grupo++;
      if (!sel.size || sel.has(r[P.loja])) { regs.push(r); e.dem++; if (r[P.st] === 'F') e.fin++; else if (r[P.st] === 'C') e.canc++; }
    }
    evDias.push(e);
    for (const c of d.cancs) if (!sel.size || sel.has(c.l)) cancs.push({ ...c, dia: d.dia });
  }
  // evolução das prioritárias, dia a dia, para o painel de evolução (sempre, com ou sem seleção)
  const prioIds = lojas.filter((l) => l.prio).map((l) => l.id);
  const evPrio = prioIds.map((id) => ({ id, ...identificar(nomes[id]), selecionada: sel.has(id), dias: Object.fromEntries(dias.map((d) => [d.dia, d.lojas[id] ? [d.lojas[id].dem, d.lojas[id].fin, d.lojas[id].canc] : [0, 0, 0]])) }));
  const prazoDe = (r) => prazos[r[P.mod]] || null;

  // geral e por modalidade
  const geral = novoAcc();
  for (const r of regs) acumular(geral, r, prazoDe(r));
  const mods = ORDEM_MOD.map((m) => {
    const rs = regs.filter((r) => r[P.mod] === m);
    if (!rs.length) return null;
    const a = novoAcc();
    for (const r of rs) acumular(a, r, prazos[m]);
    return { mod: m, prazo: prazos[m] || null, ...fechar(a), faixas: porFaixa(rs, () => prazos[m]) };
  }).filter(Boolean);

  // cancelamentos: motivos, operacional e não operacional, menos de 5 min de busca
  const motivos = new Map(), grupos = new Map(), fases = new Map();
  for (const c of cancs) {
    const k = c.m || 'Sem motivo informado';
    const x = motivos.get(k) || { motivo: k, grupo: c.g, op: !!c.op, n: 0, c5: 0 };
    x.n++; if (c.mb != null && c.mb < MIN_BUSCA) x.c5++;
    motivos.set(k, x);
    const g = grupos.get(c.g) || { grupo: c.g, op: !!c.op, n: 0, c5: 0 };
    g.n++; if (c.mb != null && c.mb < MIN_BUSCA) g.c5++;
    grupos.set(c.g, g);
    fases.set(c.f, (fases.get(c.f) || 0) + 1);
  }
  const ordena = (m) => [...m.values()].sort((a, b) => b.n - a.n).map((x) => ({ ...x, pct: pct(x.n, cancs.length) }));
  const op = cancs.filter((c) => c.op).length, c5 = cancs.filter((c) => c.mb != null && c.mb < MIN_BUSCA).length;
  const semMb = cancs.filter((c) => c.mb == null).length;
  const cancPorMod = ORDEM_MOD.map((m) => {
    const cs = cancs.filter((c) => c.md === m);
    const dem = regs.filter((r) => r[P.mod] === m).length;
    return cs.length || dem ? { mod: m, dem, canc: cs.length, taxa: pct(cs.length, dem), op: cs.filter((c) => c.op).length, naoOp: cs.filter((c) => !c.op).length, c5: cs.filter((c) => c.mb != null && c.mb < MIN_BUSCA).length } : null;
  }).filter(Boolean);
  const lista = [...cancs].sort((a, b) => (b.dia + b.h).localeCompare(a.dia + a.h)).slice(0, LIMITE_LISTA).map((c) => ({
    id: c.id, dia: c.dia, h: c.h, loja: identificar(nomes[c.l] || '').num || c.l, bairro: identificar(nomes[c.l] || '').bairro,
    mod: c.md || null, minBusca: c.mb ?? null, minCriacao: c.min ?? null, fase: c.f, motivo: c.m || 'Sem motivo informado', grupo: c.g, op: !!c.op, pendente: !!c.pendente,
  }));

  return {
    de: dias[0]?.dia || null, ate: dias[dias.length - 1]?.dia || null, fechado: dias.every((d) => d.fechado), lido_em: dias.map((d) => d.lido_em).sort().pop() || null,
    loja: escolhida ? lojas.find((l) => l.id === escolhida) : null, selecao: lojas.filter((l) => sel.has(l.id)), lojas, semRegistro,
    evolucao: { dias: evDias, prioridades: evPrio },
    prazos, visao: prazos === PRAZO_CLIENTE ? 'cliente' : 'bee', faixaKm: FAIXA_KM, minBusca: MIN_BUSCA,
    geral: { ...fechar(geral), faixas: porFaixa(regs, prazoDe) },
    modalidades: mods,
    cancelamentos: {
      total: cancs.length, taxa: pct(cancs.length, regs.length), op, naoOp: cancs.length - op, pctOp: pct(op, cancs.length),
      c5, pctC5: pct(c5, cancs.length), semMinBusca: semMb,
      pendentes: cancs.filter((c) => c.pendente).length,
      fases: [...fases.entries()].sort((a, b) => b[1] - a[1]).map(([fase, n]) => ({ fase, n, pct: pct(n, cancs.length) })),
      grupos: ordena(grupos), motivos: ordena(motivos), porModalidade: cancPorMod,
      lista, listaCortada: cancs.length > LIMITE_LISTA,
    },
  };
}

// ------------------------------------------------------------ aba Cancelamentos
// Leitura criteriosa dos cancelamentos de uma loja (ou do grupo), sempre ao lado da referência do grupo.
// Pedidos um a um (P) dão km, modalidade, hora e minutos até cancelar; a lista de cancelamentos dá motivo,
// tipo (operacional ou não) e fase. Minuto a minuto = do início da busca (ou da criação, sem busca) até cancelar.
const MIN_FAIXAS = 15;   // 0–1 ... 14–15 min e "15 min ou mais"
const KM_FAIXAS = 10;    // 0–1 ... 9–10 km e "10 km ou mais"
const MIN_TAXA = 10;     // pedidos mínimos para uma faixa entrar em comparação de taxa

function resumoCanc(regs, cancs) {
  const dem = regs.length, canc = regs.filter((r) => r[P.st] === 'C').length;
  const op = cancs.filter((c) => c.op).length, c5 = cancs.filter((c) => c.mb != null && c.mb < MIN_BUSCA).length;
  const antes = cancs.filter((c) => c.f === 'Antes do aceite').length;
  const mbs = cancs.map((c) => c.mb).filter((v) => v != null).sort((a, b) => a - b);
  const mediana = mbs.length ? Math.round(10 * (mbs.length % 2 ? mbs[(mbs.length - 1) / 2] : (mbs[mbs.length / 2 - 1] + mbs[mbs.length / 2]) / 2)) / 10 : null;
  return { dem, canc, taxa: pct(canc, dem), op, naoOp: cancs.length - op, pctOp: pct(op, cancs.length), c5, pctC5: pct(c5, cancs.length),
    antesAceite: antes, pctAntes: pct(antes, cancs.length), medianaBusca: mediana, mediaBusca: media(mbs.reduce((t, v) => t + v, 0), mbs.length) };
}

export function analisarCancelamentos(dias, loja, catalogo = {}) {
  const nomes = {}, demanda = {}, cancPorLoja = {};
  for (const d of dias) for (const [id, l] of Object.entries(d.lojas)) { nomes[id] = l.n; demanda[id] = (demanda[id] || 0) + l.dem; cancPorLoja[id] = (cancPorLoja[id] || 0) + l.canc; }
  completarLojas(nomes, demanda, catalogo, loja);
  for (const id of Object.keys(nomes)) cancPorLoja[id] ||= 0;
  const lojas = Object.keys(nomes).map((id) => ({ id, ...identificar(nomes[id]), dem: demanda[id], canc: cancPorLoja[id], prio: PRIORITARIAS.includes(identificar(nomes[id]).num) }))
    .sort((a, b) => Number(b.prio) - Number(a.prio) || b.canc - a.canc || b.dem - a.dem);
  const escolhida = loja && nomes[loja] ? String(loja) : '';
  const todosR = [], todosC = [];
  for (const d of dias) {
    for (const r of d.pedidos || []) todosR.push(r);
    for (const c of d.cancs) todosC.push({ ...c, dia: d.dia });
  }
  const regs = escolhida ? todosR.filter((r) => r[P.loja] === escolhida) : todosR;
  const cancs = escolhida ? todosC.filter((c) => c.l === escolhida) : todosC;
  const resumo = resumoCanc(regs, cancs), grupo = resumoCanc(todosR, todosC);

  // minuto a minuto: quanto tempo de busca até cancelar, operacional × não operacional
  const minutos = Array.from({ length: MIN_FAIXAS + 1 }, (_, i) => ({ faixa: i < MIN_FAIXAS ? `${i}–${i + 1}` : `${MIN_FAIXAS}+`, n: 0, op: 0, naoOp: 0 }));
  let semMinuto = 0;
  for (const c of cancs) {
    if (c.mb == null) { semMinuto++; continue; }
    const x = minutos[Math.min(MIN_FAIXAS, Math.floor(c.mb))];
    x.n++; if (c.op) x.op++; else x.naoOp++;
  }
  let acc = 0;
  for (const x of minutos) { acc += x.n; x.acumulado = pct(acc, cancs.length - semMinuto); }

  // distância: pedidos, cancelados e taxa por km (pedidos sem distância à parte)
  const kms = Array.from({ length: KM_FAIXAS + 1 }, (_, i) => ({ faixa: i < KM_FAIXAS ? `${i}–${i + 1}` : `${KM_FAIXAS}+`, dem: 0, canc: 0 }));
  let semKm = 0, semKmCanc = 0;
  for (const r of regs) {
    if (r[P.km] == null) { semKm++; if (r[P.st] === 'C') semKmCanc++; continue; }
    const x = kms[Math.min(KM_FAIXAS, Math.floor(r[P.km]))];
    x.dem++; if (r[P.st] === 'C') x.canc++;
  }
  for (const x of kms) x.taxa = pct(x.canc, x.dem);

  // modalidade: taxa, tipo e rapidez do cancelamento
  const modalidades = ORDEM_MOD.map((m) => {
    const rs = regs.filter((r) => r[P.mod] === m), cs = cancs.filter((c) => c.md === m);
    if (!rs.length) return null;
    const r = resumoCanc(rs, cs);
    return { mod: m, ...r };
  }).filter(Boolean);

  // hora do dia em que o pedido foi criado
  const horas = Array.from({ length: 24 }, (_, h) => ({ hora: h, dem: 0, canc: 0 }));
  for (const r of regs) { const h = Number(String(r[P.hora]).slice(0, 2)); if (horas[h]) { horas[h].dem++; if (r[P.st] === 'C') horas[h].canc++; } }
  for (const x of horas) x.taxa = pct(x.canc, x.dem);

  // motivos, tipos e fases
  const mapa = (chave) => {
    const m = new Map();
    for (const c of cancs) {
      const k = chave(c), x = m.get(k) || { nome: k, grupo: c.g, op: !!c.op, n: 0, c5: 0, antes: 0 };
      x.n++; if (c.mb != null && c.mb < MIN_BUSCA) x.c5++; if (c.f === 'Antes do aceite') x.antes++;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).map((x) => ({ ...x, pct: pct(x.n, cancs.length) }));
  };
  const motivos = mapa((c) => c.m || 'Sem motivo informado'), grupos = mapa((c) => c.g), fases = mapa((c) => c.f);

  // ranking das lojas (só na visão do grupo)
  // agrupa uma vez por loja: com o ano inteiro, filtrar todos os pedidos a cada loja ficaria lento
  const rPorLoja = new Map(), cPorLoja = new Map();
  if (!escolhida) {
    for (const r of todosR) { const k = r[P.loja]; if (!rPorLoja.has(k)) rPorLoja.set(k, []); rPorLoja.get(k).push(r); }
    for (const c of todosC) { if (!cPorLoja.has(c.l)) cPorLoja.set(c.l, []); cPorLoja.get(c.l).push(c); }
  }
  const ranking = escolhida ? [] : lojas.filter((l) => l.canc > 0).map((l) => {
    const rs = rPorLoja.get(l.id) || [], cs = cPorLoja.get(l.id) || [];
    const r = resumoCanc(rs, cs);
    const principal = (() => { const m = new Map(); for (const c of cs) m.set(c.m || 'Sem motivo informado', (m.get(c.m || 'Sem motivo informado') || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]; })();
    return { id: l.id, num: l.num, bairro: l.bairro, band: l.band, prio: l.prio, ...r, principal: principal ? { motivo: principal[0], n: principal[1] } : null };
  }).sort((a, b) => b.canc - a.canc || b.taxa - a.taxa).slice(0, 20);

  // pontos de atenção: cada um cita o número que o acionou e a referência do grupo
  const atencao = [];
  const ad = (nivel, titulo, texto) => atencao.push({ nivel, titulo, texto });
  if (escolhida && resumo.dem >= MIN_TAXA && resumo.taxa != null && grupo.taxa != null && resumo.taxa > grupo.taxa * 1.25)
    ad(resumo.taxa > grupo.taxa * 1.6 ? 'alta' : 'media', 'Cancelamento acima do grupo', `${br(resumo.taxa)}% dos pedidos cancelados, contra ${br(grupo.taxa)}% no grupo.`);
  if (resumo.canc >= 5 && resumo.pctC5 >= 50)
    ad(resumo.pctC5 >= 70 ? 'alta' : 'media', 'Cancela cedo', `${br(resumo.pctC5)}% dos cancelamentos saíram com menos de ${MIN_BUSCA} min de busca${escolhida ? ` (grupo: ${br(grupo.pctC5)}%)` : ''}. Mediana de ${br(resumo.medianaBusca)} min até cancelar.`);
  if (resumo.canc >= 5 && resumo.pctOp >= 50)
    ad(resumo.pctOp >= 65 ? 'alta' : 'media', 'Problema do lado do entregador', `${br(resumo.pctOp)}% dos cancelamentos são operacionais${escolhida ? ` (grupo: ${br(grupo.pctOp)}%)` : ''}: falta de entregador ou atraso/problema do entregador.`);
  const topM = motivos[0];
  if (topM && resumo.canc >= 5 && topM.pct >= 35)
    ad(topM.pct >= 55 ? 'alta' : 'media', 'Motivo concentrado', `"${topM.nome}" responde por ${br(topM.pct)}% dos cancelamentos (${topM.n}).`);
  const kmPior = kms.filter((x) => x.dem >= MIN_TAXA).sort((a, b) => b.taxa - a.taxa)[0];
  if (kmPior && resumo.taxa != null && kmPior.taxa >= resumo.taxa * 1.5 && kmPior.canc >= 3)
    ad('media', 'Distância pesa', `Na faixa de ${kmPior.faixa} km, ${br(kmPior.taxa)}% dos pedidos cancelam (${kmPior.canc} de ${kmPior.dem}), contra ${br(resumo.taxa)}% no total.`);
  const modPior = modalidades.filter((m) => m.dem >= MIN_TAXA).sort((a, b) => b.taxa - a.taxa)[0];
  if (modPior && resumo.taxa != null && modPior.taxa >= resumo.taxa * 1.4 && modPior.canc >= 3)
    ad('media', 'Modalidade com mais cancelamento', `${modPior.mod}: ${br(modPior.taxa)}% dos pedidos cancelados (${modPior.canc} de ${modPior.dem}).`);
  const horaPior = horas.filter((x) => x.dem >= MIN_TAXA).sort((a, b) => b.taxa - a.taxa)[0];
  if (horaPior && resumo.taxa != null && horaPior.taxa >= resumo.taxa * 1.5 && horaPior.canc >= 3)
    ad('media', 'Horário crítico', `Pedidos criados às ${String(horaPior.hora).padStart(2, '0')}h cancelam ${br(horaPior.taxa)}% (${horaPior.canc} de ${horaPior.dem}).`);
  atencao.sort((a, b) => (a.nivel === 'alta' ? 0 : 1) - (b.nivel === 'alta' ? 0 : 1));

  const lista = [...cancs].sort((a, b) => (b.dia + b.h).localeCompare(a.dia + a.h)).slice(0, LIMITE_LISTA).map((c) => ({
    id: c.id, dia: c.dia, h: c.h, loja: identificar(nomes[c.l] || '').num || c.l, bairro: identificar(nomes[c.l] || '').bairro,
    mod: c.md || null, minBusca: c.mb ?? null, minCriacao: c.min ?? null, fase: c.f, motivo: c.m || 'Sem motivo informado', grupo: c.g, op: !!c.op,
  }));

  return {
    de: dias[0]?.dia || null, ate: dias[dias.length - 1]?.dia || null, fechado: dias.every((d) => d.fechado),
    loja: escolhida ? lojas.find((l) => l.id === escolhida) : null, lojas, minBusca: MIN_BUSCA,
    resumo, grupo, minutos, semMinuto, kms, semKm, semKmCanc, modalidades, horas, motivos, grupos, fases, ranking, atencao,
    lista, listaCortada: cancs.length > LIMITE_LISTA, pendentes: cancs.filter((c) => c.pendente).length,
  };
}
