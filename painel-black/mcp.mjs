// Cliente do MCP bee-franchising (só leitura). Usa o mesmo acesso do Claude Code:
// o endereço e o token são lidos do .claude.json na hora, nunca copiados nem gravados.
// Na VPS, MCP_URL + MCP_AUTH (o cabeçalho Authorization inteiro) vêm do .env e substituem o .claude.json.
// Cada "canal" tem a sua sessão do MCP: a varredura dos dias não trava as consultas da tela.
import fs from 'node:fs';

function servidor() {
  if (process.env.MCP_URL && process.env.MCP_AUTH)
    return { url: process.env.MCP_URL, headers: { Authorization: process.env.MCP_AUTH } };
  const cfg = JSON.parse(fs.readFileSync(process.env.USERPROFILE + '/.claude.json', 'utf8'));
  let srv = null;
  const busca = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (k === 'bee-franchising' && v?.url) srv = v; else busca(v); } };
  busca(cfg);
  if (!srv) throw new Error('servidor bee-franchising não achado no .claude.json');
  return srv;
}
const srv = servidor();
const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(srv.headers || {}) };
const espera = (ms) => new Promise((s) => setTimeout(s, ms));

// Ritmo único para o token inteiro (a Bee limita ~35–40 chamadas/min por token).
// Fila com prioridade: o que a tela pede passa na frente da varredura.
let GAP = 1500, ultimaSaida = 0, girando = false;
const filas = [[], []];
function vez(prio) {
  return new Promise((ok) => { filas[prio].push(ok); gira(); });
}
async function gira() {
  if (girando) return;
  girando = true;
  while (filas[0].length || filas[1].length) {
    const falta = ultimaSaida + GAP - Date.now();
    if (falta > 0) await espera(falta);
    ultimaSaida = Date.now();
    (filas[0].shift() || filas[1].shift())();
  }
  girando = false;
}
const freou = () => { GAP = Math.min(Math.round(GAP * 1.4), 6000); };
const fluiu = () => { GAP = Math.max(1300, Math.round(GAP * 0.97)); };

export function cliente(nome, prio = 1) {
  let sess = null, n = 1, iniciado = null;
  async function rpc(method, params) {
    let ultimo = '';
    for (let t = 0; t < 10; t++) {
      let r;
      await vez(prio);
      try {
        r = await fetch(srv.url, { method: 'POST', headers: { ...H, ...(sess ? { 'Mcp-Session-Id': sess } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: n++, method, params }), signal: AbortSignal.timeout(60000) });
      } catch (e) { ultimo = String(e); await espera(3000 * (t + 1)); continue; }
      if (r.headers.get('mcp-session-id')) sess = r.headers.get('mcp-session-id');
      if (r.status === 429 || r.status >= 500) { ultimo = 'HTTP ' + r.status; if (r.status === 429) freou(); await espera(2000 * (t + 1)); continue; }
      fluiu();
      if ((r.status === 400 || r.status === 404) && sess && method !== 'initialize') { sess = null; iniciado = null; await inicia(); continue; }
      let txt = await r.text();
      if (/^(event|data):/m.test(txt)) txt = txt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
      const j = JSON.parse(txt);
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    }
    throw new Error('MCP não respondeu (' + method + ', ' + ultimo + ')');
  }
  function inicia() {
    iniciado ||= rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'painel-black-' + nome, version: '1' } })
      .catch((e) => { iniciado = null; throw e; });
    return iniciado;
  }
  return async function tool(name, args) {
    await inicia();
    const res = await rpc('tools/call', { name, arguments: args });
    const txt = res.content?.[0]?.text || '';
    if (res.isError) throw new Error(txt.slice(0, 300));
    return JSON.parse(txt);
  };
}
export const tool = cliente('varredura');      // leitura dos dias
export const toolTela = cliente('tela', 0);    // consultas feitas na página (passam na frente)
export const ritmo = () => GAP;

// Do histórico só sai a troca de entregador. O evento "created" traz o registro cru
// da franquia e da empresa (chaves em texto puro), por isso nada além disso é lido ou guardado.
export function saidasDeEntregador(eventos) {
  const out = [];
  for (const e of eventos || []) {
    if (e.event_type === 'created') continue;
    const o = e.value?.old?.entregador_id, c = e.value?.current?.entregador_id;
    if (o != null && o !== '' && String(o) !== String(c ?? ''))
      out.push({ entregador: String(o), novo: c == null || c === '' ? null : String(c), quando: e.timestamp, por: e.creator_type, por_id: e.creator_id });
  }
  return out;
}
