// Aba "Evidências de notificações": casos levantados pela equipe, lidos ao vivo da Bee e explicados.
// Pedido pelo MCP (get_order com histórico: só campos de status, entregador, aceite e quem fez) +
// lista de notificações pela rota REST. Nada sensível do evento "created" é guardado.
import fs from 'node:fs';
import path from 'node:path';
import { notificacoesCompletas } from './notificacoes.mjs';

// Casos já levantados pela equipe (26/11), com o relato como veio na conversa
const CASOS_INICIAIS = [
  { pedido: '55919129', relato: 'Essa entrega teve aceitação do entregador, porém os outros dois aparecem como agendado e não conseguimos entender de maneira intuitiva o que seria esse status.', criadoEm: '2026-11-26T13:17:00.000Z' },
  { pedido: '55893486', relato: 'O entregador que está com a entrega está com a situação apenas de enviado, ao invés de aceite.', criadoEm: '2026-11-26T13:33:00.000Z' },
  { pedido: '55887317', relato: 'Entrega sem lista de notificação.', criadoEm: '2026-11-26T13:34:00.000Z' },
];
// Pessoas do painel já identificadas (creator_id → nome), ver memória usuarios-painel-ids
const PESSOAS = { 1292181: 'Sara dos Santos Pereira', 1415288: 'Paulo Henrique da Silva', 1411811: 'Lucas Labor da Silva', 1416082: 'Victor Ramires',
  1416091: 'Linda Evelyn', 1416690: 'Daniel Lima', 1415986: 'Renan Lima Gomes', 1412288: 'Gustavo Monteiro', 1415985: 'Pedro Costa Maia',
  1413590: 'Gisele dos Santos da Silva', 1292209: 'Letícia Almeida de Souza' };
export const SITUACAO = { waiting_send: 'Agendado', sent: 'Enviado', received: 'Recebido', accepted: 'Aceite', refused: 'Cancelado', send_error: 'Erro' };

function quem(tipo, id) {
  const nome = PESSOAS[id] ? ` (${PESSOAS[id]})` : '';
  if (/deliveryman/.test(tipo)) return `app do entregador ${id}`;
  if (tipo === 'franchise_api_user') return `painel da franquia, usuário ${id}${nome}`;
  if (tipo === 'bee2b_api_user') return `painel/integração B2B, usuário ${id}${nome}`;
  if (tipo === 'entregame_api_user') return `painel, usuário ${id}${nome}`;
  if (/system/.test(tipo) || id === 'system') return 'sistema da Bee';
  return `${tipo} ${id}`;
}
const BR = (iso) => iso ? new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(11, 19) : null;
const dt = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null);
const dur = (sg) => sg == null ? '—' : Math.abs(sg) < 120 ? Math.abs(sg) + ' s' : Math.floor(Math.abs(sg) / 60) + ' min' + (Math.abs(sg) % 60 ? ' ' + (Math.abs(sg) % 60) + ' s' : '');
// datas sem fuso no histórico ("2026-11-26 09:51:48") estão em horário de Brasília
const iso = (v) => !v ? null : /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? new Date(v).toISOString() : new Date(v.replace(' ', 'T') + '-03:00').toISOString();

export function criarEvidencias({ CACHE, toolTela, log }) {
  const arq = path.join(CACHE, 'evidencias.json');
  const arqCache = path.join(CACHE, 'evidencias-cache.json');
  const lerCasos = () => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return CASOS_INICIAIS; } };
  const gravarCasos = (c) => fs.writeFileSync(arq, JSON.stringify(c, null, 1));
  let cacheEv = {};
  try { cacheEv = JSON.parse(fs.readFileSync(arqCache, 'utf8')); } catch {}

  async function evidencia(id, forcar = false) {
    id = String(id).replace(/\D/g, '');
    if (!id) throw Object.assign(new Error('Informe o número da entrega.'), { codigo: 400 });
    if (!forcar && cacheEv[id]) return cacheEv[id]; // entrega finalizada/cancelada não muda mais
    let d;
    try { d = await toolTela('get_order', { order_id: Number(id), include_events: true }); }
    catch (e) { throw Object.assign(new Error(/não encontrad/i.test(String(e)) ? 'Entrega não encontrada nas franquias ativas.' : 'Falha ao ler a entrega: ' + String(e.message || e).slice(0, 120)), { codigo: /não encontrad/i.test(String(e)) ? 404 : 502 }); }
    const o = d.order || {};
    const notifs = await notificacoesCompletas(id);
    // histórico: só mudanças de status/entregador/aceite/busca, com quem fez
    let criacao = null;
    const passos = [];
    for (const e of [...(d.events || [])].reverse()) {
      const c = e.value?.current || {}, v = e.value?.old || {};
      if (e.event_type === 'created') {
        criacao = { quando: e.timestamp, status: c.status, agendada: c.sn_agendada === 'S', horarioAgendamento: c.horario_agendamento || null, buscando: c.buscando || null, escolhido: c.entregador_escolhido_id ?? null };
        continue;
      }
      const campos = ['status', 'entregador_id', 'aceite', 'buscando', 'sn_atribuida'].filter((k) => k in c);
      if (!campos.length) continue;
      passos.push({ quando: e.timestamp, quem: quem(e.creator_type, e.creator_id), tipo: e.creator_type, por: e.creator_id,
        mudou: Object.fromEntries(campos.map((k) => [k, [v[k] ?? null, c[k] ?? null]])) });
    }
    const ent = o.deliveryman ? { id: String(o.deliveryman.id), nome: o.deliveryman.name } : null;
    const aceiteEm = o.dates?.accepted_at || null;
    const atribuicao = passos.find((p) => p.mudou.entregador_id && p.mudou.entregador_id[1] != null && String(p.mudou.entregador_id[1]) === ent?.id);
    const foiBuscando = passos.some((p) => p.mudou.status && String(p.mudou.status[1]) === '10') || !!criacao?.buscando;

    // Diagnóstico automático, em linguagem da operação
    const diag = [];
    // Rodadas: a Bee notifica em filas; posição 0 abre uma rodada nova. Rodada sem aceite é encerrada e outra começa.
    notifs.sort((a, b) => (a.criada || '').localeCompare(b.criada || '') || (a.posicao ?? 0) - (b.posicao ?? 0));
    let rod = 0;
    notifs.forEach((n, i) => { if (i === 0 || n.posicao === 0) rod++; n.rodada = rod; });
    const nRodadas = rod;
    const agendadas = notifs.filter((n) => n.situacao === 'waiting_send');
    const aceitas = notifs.filter((n) => n.situacao === 'accepted');
    // o aceite que valeu: o de quem ficou com a entrega, na rodada mais próxima do horário do aceite
    const aceita = (ent && aceitas.filter((n) => n.ent === ent.id).pop()) || aceitas[aceitas.length - 1];
    const minha = ent && notifs.filter((n) => n.ent === ent.id).pop();
    const rodadaFinal = aceita ? aceita.rodada : nRodadas;
    if (nRodadas > 1) {
      const porRod = Array.from({ length: nRodadas }, (_, i) => notifs.filter((n) => n.rodada === i + 1));
      const ini = porRod[0][0]?.criada, fim = porRod[nRodadas - 1].map((n) => n.exclusao).filter(Boolean).sort().pop();
      diag.push({ tipo: 'rodadas', titulo: `${nRodadas} rodadas de notificação`,
        texto: `A Bee manda a entrega em rodadas: cada rodada é uma fila de até ${Math.max(...porRod.map((r) => r.length))} entregadores (ordem = mais perto primeiro, um a cada 20 s). Se ninguém aceita, a rodada é encerrada (coluna Exclusão) e começa outra, com a fila recalculada. Aqui foram ${nRodadas} rodadas, de ${BR(ini)} a ${BR(fim)}: ${porRod.map((r, i) => `${i + 1}ª às ${BR(r[0].criada)} (${r.length})`).join(', ')}. A tela da Bee mostra todas em sequência, por isso o mesmo entregador pode aparecer várias vezes.` });
    }
    // Aceite registrado numa rodada que foi encerrada sem a entrega ficar com ninguém (caso #55922278)
    for (const n of aceitas) {
      const valeu = ent && n.ent === ent.id && n === aceita;
      if (valeu || !aceiteEm || !n.exclusao) continue;
      if (Date.parse(n.exclusao) < Date.parse(aceiteEm) - 5000)
        diag.push({ tipo: 'aceite-sem-efeito', titulo: `Aceite na ${n.rodada}ª rodada que não ficou valendo`,
          texto: `${n.nome} (${n.ent}) aparece como "Aceite" na ${n.rodada}ª rodada (notificado às ${BR(n.envio)}), mas a rodada foi encerrada às ${BR(n.exclusao)} sem a entrega ficar com ele: ela continuou "Buscando" e só foi aceita às ${BR(aceiteEm)}${ent ? ` por ${ent.nome}${aceita && aceita.ent === ent.id ? ` na ${aceita.rodada}ª rodada` : ''}` : ''}. Provável falha ao confirmar o aceite no app (internet, ou o aceite chegou depois do tempo da rodada). Vale levar à Bee. No painel Black esse "Aceite" conta para ${n.nome.split(' ')[0]}.` });
    }
    // Quem ficou com a entrega não era o 1º da fila (caso #55925694)
    if (aceita && ent && aceita.ent === ent.id && (aceita.posicao ?? 0) > 0) {
      const acima = notifs.filter((n) => n.rodada === aceita.rodada && (n.posicao ?? 0) < aceita.posicao);
      const antesDoEnvio = aceita.envio && aceiteEm && Date.parse(aceiteEm) < Date.parse(aceita.envio);
      diag.push({ tipo: 'posicao', titulo: `Quem ficou com a entrega era o ${aceita.posicao + 1}º da fila`,
        texto: `A coluna Ordem é a posição na fila da rodada (do mais perto para o mais longe), não a ordem de quem aceitou. Antes dele, na ${aceita.rodada}ª rodada: ${acima.map((n) => `${n.nome.split(' ')[0]} ${n.envio ? `(notificado ${BR(n.envio)})` : ''} ficou "${SITUACAO[n.situacao] || n.situacao}"`).join('; ')}. "Recebido" = a notificação chegou e ele não respondeu a tempo; "Enviado" = saiu, mas o celular não confirmou; "Cancelado" = recusou. Por isso a vez chegou ao ${aceita.posicao + 1}º, ${ent.nome}, que aceitou às ${BR(aceiteEm)}${antesDoEnvio ? `, ${dur(dt(aceiteEm, aceita.envio))} ANTES do horário da própria notificação (${BR(aceita.envio)}): ele viu a entrega na lista de disponíveis do app e pegou` : aceita.envio ? `, ${dt(aceita.envio, aceiteEm)} s depois de ser notificado` : ''}.` });
    }
    if (!notifs.length) {
      if (!foiBuscando && atribuicao) diag.push({ tipo: 'sem-lista', titulo: 'Sem lista: a entrega não passou por "Buscando"',
        texto: `${criacao?.agendada ? `Entrega agendada${criacao.horarioAgendamento ? ` para ${criacao.horarioAgendamento.slice(11, 16)}` : ''}, ` : ''}atribuída direto a ${ent.nome} (${ent.id}) às ${BR(atribuicao.quando)} pelo ${atribuicao.quem}${atribuicao.mudou.sn_atribuida ? ' (marcada como atribuída)' : ''}. O app só manda notificação quando a entrega fica "Buscando entregador"; como ela foi direto do status ${atribuicao.mudou.status?.[0] ?? '—'} para ${atribuicao.mudou.status?.[1] ?? '—'}, ninguém foi notificado. No painel Black esse pedido não conta nem a favor nem contra o aceite.` });
      else if (!foiBuscando) diag.push({ tipo: 'sem-lista', titulo: 'Sem lista: entrega pré-atribuída', texto: 'A entrega já nasceu com entregador (não passou por "Buscando"), então não houve notificação. Não conta para o aceite.' });
      else diag.push({ tipo: 'sem-lista', titulo: 'Sem lista de notificação', texto: 'A entrega passou por "Buscando", mas a Bee não registrou notificação. Vale abrir com o suporte da Bee.' });
    }
    if (agendadas.length && (aceita || minha)) {
      const quemAceitou = aceita || minha;
      const fim = agendadas[0]?.exclusao;
      diag.push({ tipo: 'agendado', titulo: `${agendadas.length} notificação(ões) como "Agendado" = estavam na fila e não chegaram a sair`,
        texto: `A Bee notifica em fila: o 1º da lista recebe na hora e os seguintes ficam agendados com atraso crescente (coluna Delay: ${agendadas.slice(0, 3).map((n) => n.delay + ' s').join(', ')}${agendadas.length > 3 ? '…' : ''}). A entrega foi aceita por ${ent ? ent.nome : quemAceitou.nome}${aceiteEm ? ` às ${BR(aceiteEm)}` : ''}${minha?.envio && aceiteEm ? (dt(minha.envio, aceiteEm) >= 0 ? `, ${dur(dt(minha.envio, aceiteEm))} depois de receber a notificação` : `, ${dur(dt(minha.envio, aceiteEm))} antes do horário da própria notificação (pegou pela lista de disponíveis)`) : ent && !minha ? ' (sem ter sido notificado)' : ''}, e a fila foi encerrada às ${BR(fim)}, antes do horário de envio das demais. Por isso elas ficam "Agendado" (a hora de envio 21:00:00 na tela é só um valor vazio). Agendado não conta como notificação para ninguém.` });
    }
    if (ent && minha && !aceita && (minha.situacao === 'sent' || minha.situacao === 'received')) {
      diag.push({ tipo: 'aceite-nao-gravado', titulo: `Quem ficou com a entrega aparece como "${SITUACAO[minha.situacao]}", não como "Aceite"`,
        texto: `${ent.nome} (${ent.id}) foi notificado às ${BR(minha.envio || minha.criada)} e a entrega foi aceita às ${BR(aceiteEm)}${minha.envio && aceiteEm ? ` (${dt(minha.envio, aceiteEm)} s depois)` : ''}${atribuicao ? `, registrado pelo ${atribuicao.quem}` : ' (o histórico não traz o evento do aceite, só as etapas seguintes feitas pelo app dele)'}. A notificação não foi atualizada para Aceite: provável aceite pela lista de entregas do app, e não pelo aviso, ou o app não devolveu a confirmação. No painel Black esse caso conta como aceite do entregador.` });
    }
    if (aceita && ent && aceita.ent === ent.id && !diag.some((x) => ['agendado', 'posicao', 'rodadas', 'aceite-sem-efeito'].includes(x.tipo)))
      diag.push({ tipo: 'ok', titulo: 'Aceite registrado na notificação', texto: `${ent.nome} aceitou pela notificação${aceiteEm && aceita.envio ? `, ${dt(aceita.envio, aceiteEm)} s depois de receber` : ''}.` });
    // Caso #55909218: quem ficou com a entrega não está na lista e aceitou pelo próprio app = pegou direto da
    // lista de entregas disponíveis, sem notificação. Se alguém aparece como Aceite, chegou depois (perdeu a corrida).
    const foraDaLista = ent && notifs.length && !notifs.some((n) => n.ent === ent.id);
    if (foraDaLista && atribuicao && /deliveryman/.test(atribuicao.tipo)) {
      const fimFila = notifs.map((n) => n.exclusao).filter(Boolean).sort().pop();
      diag.push({ tipo: 'fora-da-lista', titulo: 'Quem ficou com a entrega não foi notificado: pegou direto da lista de entregas do app',
        texto: `${!aceitas.length ? `Ninguém da fila aceitou${nRodadas > 1 ? ` em ${nRodadas} rodadas` : ''} (${notifs.filter((n) => n.situacao === 'refused').length} recusas, o resto sem resposta). ` : ''}${ent.nome} (${ent.id}) aceitou às ${BR(aceiteEm || atribuicao.quando)} pelo próprio app${criacao?.buscando ? `, ${dur(dt(iso(criacao.buscando), aceiteEm || iso(atribuicao.quando)))} depois de a entrega entrar em "Buscando"` : ''}, sem estar na fila de notificação (a Bee só notifica os ${new Set(notifs.map((n) => n.ent)).size} entregadores da lista, mas a entrega também aparece para quem abre a lista de disponíveis no app). `
          + (aceita ? `${aceita.nome} (${aceita.ent}) aparece como "Aceite" porque respondeu à notificação, mas a entrega já tinha dono; a fila só foi encerrada às ${BR(fimFila)}, ${dt(aceiteEm || iso(atribuicao.quando), fimFila)} s depois. ` : '')
          + `No painel Black: o aceite de ${aceita ? aceita.nome.split(' ')[0] : 'quem respondeu'} conta para ele; para ${ent.nome.split(' ')[0]} a entrega não conta nem a favor nem contra o aceite, porque ele não foi notificado.` });
    } else if (aceita && ent && aceita.ent !== ent.id && !diag.some((x) => x.tipo === 'aceite-sem-efeito'))
      diag.push({ tipo: 'troca', titulo: 'Quem aceitou pela notificação não é quem ficou com a entrega', texto: `${aceita.nome} (${aceita.ent}) aparece como Aceite, mas a entrega está com ${ent.nome} (${ent.id}). Houve troca de entregador depois do aceite (ver histórico).` });
    const recusas = notifs.filter((n) => n.situacao === 'refused').length;
    if (recusas) diag.push({ tipo: 'recusa', titulo: `${recusas} recusa(s)`, texto: '"Cancelado" na lista = o entregador recebeu e recusou a oferta. Conta como notificação não aceita no painel Black.' });

    const res = {
      pedido: id, loja: o.merchant?.name || '', status: String(o.status ?? ''), canal: o.channel || '', origem: o.order_origin || '', entregador: ent,
      datas: { criado: o.dates?.created_at || null, aceite: aceiteEm, chegadaOrigem: o.dates?.arrival_at_origin || null, finalizado: o.dates?.finished_at || null, cancelado: o.dates?.cancelled_at || null },
      criacao: criacao && { ...criacao, quando: iso(criacao.quando), buscando: iso(criacao.buscando) },
      passos: passos.map((p) => ({ ...p, quando: iso(p.quando) })), notificacoes: notifs, diagnostico: diag, lidoEm: new Date().toISOString(),
    };
    if (res.status === '50' || res.status === '60') { cacheEv[id] = res; fs.writeFileSync(arqCache, JSON.stringify(cacheEv)); }
    return res;
  }
  function adicionar(pedido, relato) {
    pedido = String(pedido || '').replace(/\D/g, '');
    if (!pedido) throw Object.assign(new Error('Informe o número da entrega.'), { codigo: 400 });
    const casos = lerCasos().filter((c) => c.pedido !== pedido);
    casos.unshift({ pedido, relato: String(relato || '').slice(0, 600), criadoEm: new Date().toISOString() });
    gravarCasos(casos.slice(0, 200));
    log('evidência adicionada', pedido);
    return casos;
  }
  function remover(pedido) {
    const casos = lerCasos().filter((c) => c.pedido !== String(pedido));
    gravarCasos(casos);
    return casos;
  }
  return { lerCasos, evidencia, adicionar, remover };
}
