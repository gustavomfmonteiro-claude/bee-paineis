// Lista de notificações de cada entrega (a mesma tela "Lista de notificações" do painel da Bee):
// GET /api/orders/{id}/notifications com o acesso do MCP. Só leitura.
//
// Situação de cada linha (status_label):
//   waiting_send = Agendado (nunca chegou ao celular: outro entregador aceitou antes)
//   sent = Enviado · received = Recebido (chegou e ficou sem resposta) · accepted = Aceite
//   refused = Cancelado (recusou) · send_error = Erro
// Notificação enviada = sent + received + accepted + refused. Taxa de aceite = aceitas ÷ enviadas.
import fs from 'node:fs';
import { ACESSO } from './mcp.mjs';

const espera = (ms) => new Promise((s) => setTimeout(s, ms));
// A Bee limita 40 chamadas/min por token (x-ratelimit-limit), contando MCP e REST juntos.
let GAP = 1500, ultima = 0, fila = Promise.resolve();
function vez() { // ritmo da rota REST; a cota é a mesma do MCP
  const p = fila.then(async () => { const f = ultima + GAP - Date.now(); if (f > 0) await espera(f); ultima = Date.now(); });
  fila = p.catch(() => {});
  return p;
}
export async function notificacoesDoPedido(id) {
  for (let t = 0; t < 8; t++) {
    await vez();
    let r;
    try { r = await fetch(`${ACESSO.api}/orders/${id}/notifications`, { headers: { Authorization: ACESSO.auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); }
    catch { await espera(2000 * (t + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { GAP = Math.min(GAP * 1.5, 6000); await espera(Number(r.headers.get('retry-after')) * 1000 || 5000 * (t + 1)); continue; }
    GAP = Math.max(1500, Math.round(GAP * 0.97));
    const resta = Number(r.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(resta) && resta <= 3) await espera(8000); // cota do minuto quase no fim: deixa folga para o MCP
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('notificações HTTP ' + r.status);
    const j = await r.json();
    // "1395877-HELDER BRAGA DE SOUSA " → id + nome; telefone e afins nunca são guardados
    return (j.data || []).map((n) => {
      const m = String(n.deliveryman || '').match(/^\s*(\d+)\s*-\s*(.*)$/);
      return [m ? m[1] : null, m ? m[2].trim() : String(n.deliveryman || '').trim(), n.status_label, n.created_at, n.position ?? null];
    });
  }
  throw new Error('rota de notificações não respondeu');
}

export const ENVIADA = new Set(['sent', 'received', 'accepted', 'refused']);
const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
const horaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).getUTCHours();

// Lê (com cache por pedido) e resume as notificações do dia. `pedidos` = listagem do dia (com st, criado, busca).
export async function lerNotificacoesDia({ dia, pedidos, arqPedidos, st, log }) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(arqPedidos, 'utf8')); } catch {}
  const doDia = (iso) => !!iso && diaBR(iso) === dia;
  // Só tem notificação quem passou por "Buscando"; pré-atribuído (sem searching) não gera lista
  const alvo = pedidos.filter((p) => p.busca && (doDia(p.criado) || doDia(p.busca)));
  const ler = alvo.filter((p) => !cache[p.id]?.final);
  Object.assign(st, { fase: 'lendo notificações', feito: 0, total: ler.length });
  let erros = 0, n = 0;
  const filaP = [...ler];
  async function trab() { // 4 leitores em paralelo: a API demora ~1,5 s por resposta; o ritmo (GAP) continua único
    while (filaP.length) {
      const p = filaP.shift();
      try { cache[p.id] = { final: p.st === '50' || p.st === '60', linhas: await notificacoesDoPedido(p.id) }; }
      catch (e) { erros++; if (erros <= 5) log('notificações', p.id, String(e).slice(0, 100)); }
      st.feito++;
      if (++n % 300 === 0) fs.writeFileSync(arqPedidos, JSON.stringify(cache)); // guarda o progresso
    }
  }
  await Promise.all([trab(), trab(), trab(), trab()]);
  fs.writeFileSync(arqPedidos, JSON.stringify(cache));
  if (erros > ler.length * 0.05 + 5) throw new Error(`notificações com ${erros} erros em ${ler.length}`);

  // Resumo
  const porEntregador = {}, porHora = Array.from({ length: 24 }, () => ({ enviadas: 0, aceitas: 0, recusadas: 0 }));
  const totais = { waiting_send: 0, sent: 0, received: 0, accepted: 0, refused: 0, send_error: 0, outras: 0 };
  let pedidosComNotif = 0, pedidosAceitosPorNotif = 0, somaPosAceite = 0, nPosAceite = 0;
  for (const p of alvo) {
    const linhas = (cache[p.id]?.linhas || []).filter((l) => doDia(l[3]));
    if (!linhas.length) continue;
    pedidosComNotif++;
    let aceitou = false;
    for (const [id, nome, sit, criado, pos] of linhas) {
      if (sit in totais) totais[sit]++; else totais.outras++;
      if (!id) continue;
      const e = porEntregador[id] ||= { nome, enviadas: 0, aceitas: 0, recusadas: 0, recebidas: 0, semRecibo: 0, erros: 0, agendadas: 0 };
      if (!e.nome && nome) e.nome = nome;
      if (sit === 'waiting_send') e.agendadas++;
      else if (sit === 'send_error') e.erros++;
      if (ENVIADA.has(sit)) {
        e.enviadas++;
        const h = porHora[horaBR(criado)]; h.enviadas++;
        if (sit === 'accepted') { e.aceitas++; h.aceitas++; aceitou = true; if (pos != null) { somaPosAceite += Number(pos); nPosAceite++; } }
        else if (sit === 'refused') { e.recusadas++; h.recusadas++; }
        else if (sit === 'received') e.recebidas++;
        else if (sit === 'sent') e.semRecibo++;
      }
    }
    if (aceitou) pedidosAceitosPorNotif++;
  }
  const enviadas = totais.sent + totais.received + totais.accepted + totais.refused;
  return {
    porEntregador, porHora, totais, enviadas, pedidosLidos: alvo.length, pedidosComNotif, pedidosAceitosPorNotif,
    posicaoMediaAceite: nPosAceite ? somaPosAceite / nPosAceite : null,
    notifPorPedido: pedidosComNotif ? enviadas / pedidosComNotif : null,
  };
}
