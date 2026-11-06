// Auditoria do WhatsApp de alocação: cruza o log de disparos (whatsapp-envios.jsonl), as respostas Sim/Não
// (whatsapp-respostas.jsonl + estado das ofertas) com o status final de cada mensagem no GHL e o desfecho de
// cada entrega na API da Bee. Somente leitura nas duas APIs. Resultado em cache/auditoria-cache.json.
import fs from 'node:fs';
import path from 'node:path';

const TZ = 'America/Fortaleza';
const FINAIS_MSG = new Set(['delivered', 'read', 'failed']);
const COBRADA = new Set(['delivered', 'read']); // a Meta cobra o template de marketing entregue
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
const diaLocal = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10);
const horaLocal = (iso) => Number(new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(11, 13));
const lerJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return padrao; } };

export function motivoFalha(erro) {
  const e = String(erro || '');
  if (/healthy ecosystem/i.test(e)) return 'Limite de marketing da Meta';
  if (/not a WhatsApp phone|Undeliverable/i.test(e)) return 'Número sem WhatsApp';
  if (/part of an experiment/i.test(e)) return 'Experimento da Meta (sem marketing)';
  if (/token|401/i.test(e)) return 'Erro de token do GHL';
  return e ? 'Outro erro' : 'Sem detalhe';
}

export function criarAuditoria({ cache, ghlBase, pit, versaoGhl = '2021-04-15', lerPedidoAuditoria, custoUsd = 0.0625, cambio = 5.4, intervaloMs = 10 * 60e3, log = () => {} }) {
  const ARQ = path.join(cache, 'auditoria-cache.json');
  const ENVIOS = path.join(cache, 'whatsapp-envios.jsonl');
  const RESPOSTAS = path.join(cache, 'whatsapp-respostas.jsonl');
  const OFERTAS = path.join(cache, 'whatsapp-ofertas.json');
  let base = lerJson(ARQ, { pedidos: {}, mensagens: {}, ofertas: {}, atualizadoEm: null });
  base.ofertas ||= {};
  let rodando = null, erroUltimo = null;

  // O arquivo de ofertas apaga o que tem mais de 24 h: guarda aqui o estado final de cada par entrega:entregador
  function guardaOfertas() {
    const o = lerJson(OFERTAS, {});
    for (const x of Object.values(o)) {
      const k = x.pedido + ':' + x.entregador, velho = base.ofertas[k];
      if (!velho || velho.estado !== x.estado || velho.atribuidaEm !== x.atribuidaEm) base.ofertas[k] = { estado: x.estado, em: x.em, atribuidaEm: x.atribuidaEm || null, loja: x.loja || null };
    }
  }

  async function statusMensagem(id) {
    const r = await fetch(`${ghlBase}/conversations/messages/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + pit, Version: versaoGhl, Accept: 'application/json' }, signal: AbortSignal.timeout(15e3) });
    if (r.status === 429) { await dorme(10e3); return null; }
    if (!r.ok) throw new Error('GHL HTTP ' + r.status);
    const j = await r.json();
    const m = j?.message || j;
    return { status: m?.status || null, erro: m?.error ? String(m.error).slice(0, 200) : null };
  }

  async function atualizar() {
    if (rodando) return rodando;
    rodando = (async () => {
      const t0 = Date.now();
      guardaOfertas();
      const envios = lerJsonl(ENVIOS);
      // 1. status final da mensagem no GHL (o log grava o que viu nos primeiros 24 s)
      let lidasMsg = 0;
      if (pit) {
        for (const e of envios) {
          if (!e.messageId || FINAIS_MSG.has(e.status)) continue;
          const c = base.mensagens[e.messageId];
          if (c && (FINAIS_MSG.has(c.status) || Date.now() - Date.parse(e.em) > 48 * 3600e3 && c.lidoEm)) continue;
          if (c && Date.now() - Date.parse(c.lidoEm) < 5 * 60e3) continue;
          try { const s = await statusMensagem(e.messageId); if (s) { base.mensagens[e.messageId] = { ...s, lidoEm: new Date().toISOString() }; lidasMsg++; } } catch (err) { log('auditoria: status GHL falhou', err.message); break; }
          await dorme(150);
        }
      }
      // 2. desfecho da entrega na Bee: relê só as que não fecharam (50/60)
      let lidosPed = 0;
      const pedidos = [...new Set(envios.map((e) => String(e.pedido)))];
      for (const id of pedidos) {
        const c = base.pedidos[id];
        if (c && ['50', '60'].includes(c.status) && c.camposValor) continue;
        if (c && Date.now() - Date.parse(c.lidoEm) < 4 * 60e3) continue;
        try { base.pedidos[id] = { ...(await lerPedidoAuditoria(id)), lidoEm: new Date().toISOString() }; lidosPed++; } catch (err) { log('auditoria: pedido', id, 'falhou', err.message); if (/401|429|422/.test(err.message)) break; }
        await dorme(400);
      }
      base.atualizadoEm = new Date().toISOString();
      fs.writeFileSync(ARQ, JSON.stringify(base));
      erroUltimo = null;
      log(`auditoria ok: ${lidasMsg} mensagens e ${lidosPed} pedidos relidos em ${Math.round((Date.now() - t0) / 1000)} s`);
    })().catch((e) => { erroUltimo = e.message; log('auditoria falhou:', e.message); }).finally(() => { rodando = null; });
    return rodando;
  }

  // ---------- cálculo (sem chamadas externas)
  function calcular({ de, ate } = {}) {
    guardaOfertas();
    const dentro = (iso) => { const d = diaLocal(iso); return (!de || d >= de) && (!ate || d <= ate); };
    const envios = lerJsonl(ENVIOS).filter((e) => e.tag !== false && dentro(e.em));
    const respostas = lerJsonl(RESPOSTAS);
    const statusFinal = (e) => {
      const c = e.messageId && base.mensagens[e.messageId];
      return c?.status && (FINAIS_MSG.has(c.status) || !FINAIS_MSG.has(e.status)) ? c.status : e.status;
    };
    const erroFinal = (e) => (e.messageId && base.mensagens[e.messageId]?.erro) || e.erro;

    // resposta de cada par: o log de respostas vence; o estado guardado da oferta cobre o que veio antes dele
    const resp = new Map();
    for (const [k, o] of Object.entries(base.ofertas)) if (!['aberta', 'processando', 'falhou'].includes(o.estado)) resp.set(k, { resultado: o.estado, em: o.atribuidaEm || null, resposta: o.estado === 'recusada' ? 'nao' : 'sim' });
    for (const r of respostas) if (r.pedido && r.pedido !== '-' && r.resultado !== 'repetida' && r.resultado !== 'sem oferta') resp.set(r.pedido + ':' + r.entregador, { resultado: r.resultado, em: r.em, resposta: r.resposta });

    const k = { disparos: envios.length, chegaram: 0, cobradas: 0, lidas: 0, falhas: 0, semConfirmacao: 0, respostasSim: 0, respostasNao: 0, atribuidas: 0, outroJaPegou: 0, expiradas: 0, limiteAbertas: 0, falhaAtribuir: 0 };
    const falhas = {}, porDia = {}, porHora = Array.from({ length: 24 }, () => ({ disparos: 0, sim: 0, atribuidas: 0 }));
    const porPedido = new Map(), porEntregador = new Map();
    for (const e of envios) {
      const st = statusFinal(e), dia = diaLocal(e.em), kk = e.pedido + ':' + e.entregador;
      const d = (porDia[dia] ||= { dia, disparos: 0, chegaram: 0, cobradas: 0, falhas: 0, sim: 0, nao: 0, atribuidas: 0, pedidos: new Set(), entregadores: new Set() });
      d.disparos++; d.pedidos.add(String(e.pedido)); d.entregadores.add(String(e.entregador));
      porHora[horaLocal(e.em)].disparos++;
      const p = porPedido.get(String(e.pedido)) || { id: String(e.pedido), disparos: 0, chegaram: 0, primeiro: e.em, ultimo: e.em, ofertados: new Set(), sim: [], atribuidoA: null, atribuidoEm: null };
      p.disparos++; if (e.em < p.primeiro) p.primeiro = e.em; if (e.em > p.ultimo) p.ultimo = e.em;
      const en = porEntregador.get(String(e.entregador)) || { id: String(e.entregador), recebidas: 0, sim: 0, nao: 0, atribuidas: 0, falhas: 0 };
      if (st === 'failed') {
        k.falhas++; d.falhas++; en.falhas++;
        const m = motivoFalha(erroFinal(e)); falhas[m] = (falhas[m] || 0) + 1;
      } else {
        k.chegaram++; d.chegaram++; p.chegaram++; p.ofertados.add(String(e.entregador)); en.recebidas++;
        if (COBRADA.has(st)) { k.cobradas++; d.cobradas++; } else k.semConfirmacao++;
        if (st === 'read') k.lidas++;
      }
      const r = resp.get(kk);
      if (r) {
        if (r.resposta === 'nao' || r.resultado === 'recusada') { k.respostasNao++; d.nao++; en.nao++; }
        else {
          k.respostasSim++; d.sim++; en.sim++; porHora[horaLocal(e.em)].sim++; p.sim.push(String(e.entregador));
          if (r.resultado === 'atribuida') { k.atribuidas++; d.atribuidas++; en.atribuidas++; porHora[horaLocal(e.em)].atribuidas++; p.atribuidoA = String(e.entregador); p.atribuidoEm = r.em; }
          else if (r.resultado === 'outro') k.outroJaPegou++;
          else if (r.resultado === 'expirada') k.expiradas++;
          else if (r.resultado === 'limite') k.limiteAbertas++;
          else if (r.resultado === 'falha') k.falhaAtribuir++;
        }
      }
      porPedido.set(String(e.pedido), p); porEntregador.set(String(e.entregador), en);
    }

    // desfecho de cada entrega alcançada
    const desfecho = { workflowFinalizada: 0, workflowEmAndamento: 0, workflowDevolvida: 0, appOfertado: 0, outroEntregador: 0, cancelada: 0, aberta: 0, semLeitura: 0 };
    const lojas = new Map(), atribuicoes = [];
    let somaEsperaSim = 0, nEsperaSim = 0, valorEntregadorWorkflow = 0, valorLojaWorkflow = 0;
    const lista = [];
    for (const p of porPedido.values()) {
      const b = base.pedidos[p.id];
      let cat = 'semLeitura';
      if (b) {
        const fim = b.entregador != null ? String(b.entregador) : null;
        if (p.atribuidoA && fim === p.atribuidoA && b.status !== '60') cat = b.status === '50' ? 'workflowFinalizada' : 'workflowEmAndamento';
        else if (p.atribuidoA) cat = b.status === '60' ? 'cancelada' : 'workflowDevolvida';
        else if (b.status === '60') cat = 'cancelada';
        else if (fim && p.ofertados.has(fim)) cat = 'appOfertado';
        else if (fim) cat = 'outroEntregador';
        else cat = 'aberta';
      }
      desfecho[cat]++;
      const loja = b?.loja || base.ofertas[p.id + ':' + [...p.ofertados][0]]?.loja || '—';
      const l = lojas.get(loja) || { loja, entregas: 0, disparos: 0, workflow: 0, app: 0, outro: 0, cancelada: 0 };
      l.entregas++; l.disparos += p.disparos;
      if (cat.startsWith('workflow') && cat !== 'workflowDevolvida') l.workflow++; else if (cat === 'appOfertado') l.app++; else if (cat === 'outroEntregador' || cat === 'workflowDevolvida') l.outro++; else if (cat === 'cancelada') l.cancelada++;
      lojas.set(loja, l);
      if (p.atribuidoA && b?.criado && p.atribuidoEm) { somaEsperaSim += (Date.parse(p.atribuidoEm) - Date.parse(b.criado)) / 60e3; nEsperaSim++; }
      if (cat === 'workflowFinalizada') { valorEntregadorWorkflow += b.valorEntregador || 0; valorLojaWorkflow += b.valorLoja || 0; }
      if (p.atribuidoA) atribuicoes.push({ pedido: p.id, loja, entregador: p.atribuidoA, em: p.atribuidoEm, disparosAntes: p.disparos, criado: b?.criado || null, status: b?.status || null, ficou: b ? String(b.entregador) === p.atribuidoA : null, minutosAteSim: b?.criado && p.atribuidoEm ? Math.round((Date.parse(p.atribuidoEm) - Date.parse(b.criado)) / 60e3) : null });
      lista.push({ pedido: p.id, loja, disparos: p.disparos, chegaram: p.chegaram, sim: p.sim.length, desfecho: cat, status: b?.status || null, primeiro: p.primeiro });
    }
    const alcancadas = porPedido.size;
    const custoMsgBrl = custoUsd * cambio;
    const custoTotal = k.cobradas * custoMsgBrl;
    const alocadasWorkflow = desfecho.workflowFinalizada + desfecho.workflowEmAndamento;
    const pct = (a, b) => (b ? a / b : null);
    return {
      periodo: { de: de || null, ate: ate || null, primeiro: envios.reduce((m, e) => (!m || e.em < m ? e.em : m), null), ultimo: envios.reduce((m, e) => (!m || e.em > m ? e.em : m), null) },
      atualizadoEm: base.atualizadoEm, erro: erroUltimo, emAtualizacao: !!rodando,
      kpis: {
        ...k, entregasAlcancadas: alcancadas, entregadoresAlcancados: [...porEntregador.values()].filter((e) => e.recebidas).length,
        alocadasWorkflow, alocadasFinalizadas: desfecho.workflowFinalizada, comOfertado: alocadasWorkflow + desfecho.appOfertado,
        taxaEntrega: pct(k.chegaram, k.disparos), taxaResposta: pct(k.respostasSim + k.respostasNao, k.chegaram), taxaSim: pct(k.respostasSim, k.chegaram),
        conversaoSimAtribuida: pct(k.atribuidas, k.respostasSim), alocacaoPorEntrega: pct(alocadasWorkflow, alcancadas), mensagensPorAlocacao: alocadasWorkflow ? k.disparos / alocadasWorkflow : null,
        esperaMediaAteSimMin: nEsperaSim ? somaEsperaSim / nEsperaSim : null,
        valorEntregadorWorkflow, valorLojaWorkflow,
      },
      custo: { usdPorMensagem: custoUsd, cambio, brlPorMensagem: custoMsgBrl, mensagensCobradas: k.cobradas, total: custoTotal, porAlocacao: alocadasWorkflow ? custoTotal / alocadasWorkflow : null, porComOfertado: alocadasWorkflow + desfecho.appOfertado ? custoTotal / (alocadasWorkflow + desfecho.appOfertado) : null, porEntregaAlcancada: alcancadas ? custoTotal / alcancadas : null, semConfirmacao: k.semConfirmacao, totalSeSemConfirmacaoCobrar: (k.cobradas + k.semConfirmacao) * custoMsgBrl, desperdicioFalhas: k.falhas },
      falhas: Object.entries(falhas).map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n),
      desfecho,
      porDia: Object.values(porDia).sort((a, b) => a.dia.localeCompare(b.dia)).map((d) => ({ ...d, pedidos: d.pedidos.size, entregadores: d.entregadores.size, custo: d.cobradas * custoMsgBrl })),
      porHora: porHora.map((h, i) => ({ hora: i, ...h })),
      lojas: [...lojas.values()].sort((a, b) => b.disparos - a.disparos).slice(0, 25),
      entregadores: [...porEntregador.values()].filter((e) => e.sim || e.nao).sort((a, b) => b.atribuidas - a.atribuidas || b.sim - a.sim || b.nao - a.nao).slice(0, 25),
      atribuicoes: atribuicoes.sort((a, b) => String(b.em).localeCompare(String(a.em))),
      entregas: lista.sort((a, b) => b.primeiro.localeCompare(a.primeiro)).slice(0, 200),
    };
  }

  setInterval(() => atualizar(), intervaloMs).unref?.();
  setTimeout(() => atualizar(), 30e3).unref?.();
  return { atualizar, calcular, idadeMs: () => (base.atualizadoEm ? Date.now() - Date.parse(base.atualizadoEm) : Infinity) };
}
