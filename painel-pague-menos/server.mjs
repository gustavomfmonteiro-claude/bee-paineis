// Painel Pague Menos + Extrafarma: leitura contínua da API da Bee (somente GET), histórico em cache/dias
// e a página que atualiza sozinha via SSE. Sem dependências (Node 20+).
//
// Buscando das lojas prioritárias: a cada minuto. Indicadores do grupo: a cada KPI_MINUTOS, só das lojas
// do grupo. Conferência às 04:00: relê ontem na franquia inteira, e é assim que uma loja nova aparece.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurar, coletar, lerBuscando, lerEntregadores, temAcesso } from './coletor.mjs';
import { analisarDia, rankingEntregadores } from './analise.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let arqEnv = '';
try { arqEnv = fs.readFileSync(path.join(DIR, '.env'), 'utf8'); } catch {}
const env = Object.fromEntries(arqEnv.split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const cfg = (k, padrao) => process.env[k] || env[k] || padrao;
const PORT = Number(cfg('PORT', 3070));
const KPI_MS = Number(cfg('KPI_MINUTOS', 5)) * 60e3;
const BUSCA_MS = Number(cfg('BUSCA_SEGUNDOS', 60)) * 1000;
const DIAS_ENTREGADORES = 30;
const CACHE = path.join(DIR, 'cache');
const DIAS = path.join(CACHE, 'dias');
const ARQ_COLETAS = path.join(CACHE, 'coletas.json');
const ARQ_USO = path.join(CACHE, 'uso.json');
const ARQ_ENTREGADORES = path.join(CACHE, 'entregadores.json');
fs.mkdirSync(DIAS, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }), ...a);
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };

// Login de quem abre o painel: no .env ficam só os hashes (configurar-senha-painel.ps1). Sem eles o painel
// fica aberto e o destino do cliente só com bairro; o endereço completo só existe com o login ativo.
const LOGIN = { usuario: cfg('PAINEL_USUARIO'), sal: cfg('PAINEL_SENHA_SAL'), hash: cfg('PAINEL_SENHA_HASH'), token: cfg('PAINEL_TOKEN_HASH') };
const TEM_LOGIN = !!(LOGIN.usuario && LOGIN.sal && LOGIN.hash && LOGIN.token);

configurar({ base: cfg('BEE_API_BASE_URL'), usuario: cfg('BEE_API_USERNAME'), senha: cfg('BEE_API_PASSWORD'), cache: CACHE, destinoCompleto: TEM_LOGIN });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const aceitos = new Set();   // hash do cabeçalho já conferido: evita refazer o PBKDF2 a cada requisição
const falhas = new Map();    // ip -> { n, ate }: limita tentativas de senha
const MAX_FALHAS = 10, JANELA_FALHAS = 15 * 60e3;

function conferirCabecalho(h) {
  if (h.startsWith('Bearer ')) return iguais(sha256(h.slice(7).trim()), LOGIN.token);
  if (!h.startsWith('Basic ')) return false;
  const texto = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = texto.indexOf(':');
  if (i < 0) return false;
  const hash = crypto.pbkdf2Sync(texto.slice(i + 1), Buffer.from(LOGIN.sal, 'hex'), 200000, 32, 'sha256').toString('hex');
  return iguais(texto.slice(0, i), LOGIN.usuario) && iguais(hash, LOGIN.hash);
}
// Devolve true quando a requisição pode seguir; senão já respondeu 401 ou 429.
function autorizar(req, res) {
  if (!TEM_LOGIN) return true;
  const h = req.headers.authorization || '';
  if (h && aceitos.has(sha256(h))) return true;
  // o Caddy acrescenta o ip real no fim da lista
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
  const f = falhas.get(ip);
  if (f && f.ate < Date.now()) falhas.delete(ip);
  if (falhas.get(ip)?.n >= MAX_FALHAS) {
    res.writeHead(429, { 'Retry-After': '900', 'Content-Type': 'text/plain; charset=utf-8' }).end('Muitas tentativas. Tente de novo em 15 minutos.');
    return false;
  }
  if (h && conferirCabecalho(h)) { aceitos.add(sha256(h)); falhas.delete(ip); return true; }
  if (h) falhas.set(ip, { n: (falhas.get(ip)?.n || 0) + 1, ate: falhas.get(ip)?.ate || Date.now() + JANELA_FALHAS });
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Painel Pague Menos", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Informe usuário e senha.');
  return false;
}

// Lojas do grupo, do cadastro; loja nova entra quando aparece na conferência das 04:00.
const LOJAS_CADASTRO = lerJson(path.join(DIR, 'lojas-pmef.json'), []);

// ---------------------------------------------------------------------- tempo
const OFFSET = '-03:00'; // Fortaleza não tem horário de verão
const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
const somaDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const momentoConferencia = (d) => Date.parse(`${d}T04:00:00${OFFSET}`);
function proximaConferencia() {
  const d = hoje();
  return Date.now() < momentoConferencia(d) ? momentoConferencia(d) : momentoConferencia(somaDias(d, 1));
}

// -------------------------------------------------------------------- histórico
const historico = {};
for (const f of fs.readdirSync(DIAS)) {
  if (!f.endsWith('.json')) continue;
  try { const d = JSON.parse(fs.readFileSync(path.join(DIAS, f), 'utf8')); historico[d.dia] = d; } catch (e) { log('dia ilegível:', f, e.message); }
}
let coletas = lerJson(ARQ_COLETAS, []);
let entregadoresHist = lerJson(ARQ_ENTREGADORES, { dias: {} });

function gravarDia(d) {
  const arq = path.join(DIAS, d.dia + '.json');
  fs.writeFileSync(arq + '.tmp', JSON.stringify(d));
  fs.renameSync(arq + '.tmp', arq);
  historico[d.dia] = d;
}

const idsDoGrupo = () => {
  const s = new Set(LOJAS_CADASTRO.map(String));
  for (const d of Object.values(historico)) for (const id of Object.keys(d.lojas)) s.add(id);
  return [...s];
};

// ------------------------------------------------------------------ requisições
// Quantas requisições cada leitura gasta e o acumulado do dia: é o que o painel mostra.
const usoVazio = (dia) => ({ dia, kpi: { leituras: 0, total: 0, login: 0, paginas: 0, motivos: 0, repeticoes: 0 }, busca: { leituras: 0, total: 0, login: 0, paginas: 0, repeticoes: 0 }, ultimaKpi: null, ultimaBusca: null });
let uso = lerJson(ARQ_USO, usoVazio(hoje()));
function somarUso(chave, r, extra) {
  if (uso.dia !== hoje()) uso = usoVazio(hoje());
  const u = uso[chave];
  u.leituras++;
  for (const k of Object.keys(u)) if (k !== 'leituras' && r[k]) u[k] += r[k];
  uso[chave === 'kpi' ? 'ultimaKpi' : 'ultimaBusca'] = { em: new Date().toISOString(), ...r, ...extra };
  fs.writeFileSync(ARQ_USO, JSON.stringify(uso));
}

// ---------------------------------------------------------------------- leituras
let lendo = false, ultimoErro = null;

async function lerIndicadores() {
  if (lendo || !temAcesso()) return;
  lendo = true;
  try {
    // Virou o dia: a primeira leitura também fecha ontem até 23:59.
    const d = hoje(), ontem = somaDias(d, -1);
    const dias = [...(historico[ontem]?.fechado ? [] : [{ dia: ontem, fechado: true }]), { dia: d, fechado: false }];
    const r = await coletar(dias, gravarDia, idsDoGrupo());
    somarUso('kpi', r.reqs, { segundos: r.segundos, pedidos: r.pedidos });
    ultimoErro = null;
    log(`indicadores ok: ${r.pedidos} pedidos em ${r.segundos} s · ${r.reqs.total} requisições (login ${r.reqs.login}, páginas ${r.reqs.paginas}, motivos ${r.reqs.motivos}; ${r.reqs.repeticoes} repetidas)`);
  } catch (e) {
    ultimoErro = { em: new Date().toISOString(), erro: String(e?.message || e).slice(0, 160) };
    log('indicadores falharam:', ultimoErro.erro);
  } finally {
    lendo = false;
    emitir();
  }
}

// Conferência diária: relê ontem na franquia inteira. Se falhar, tenta de novo em 15 min, até 4 vezes.
async function conferir(tentativa = 0) {
  if (lendo) { setTimeout(() => conferir(tentativa), 60e3); return; }
  lendo = true;
  const ontem = somaDias(hoje(), -1);
  try {
    const r = await coletar([{ dia: ontem, fechado: true }], gravarDia);
    coletas = [...coletas, { em: new Date().toISOString(), tipo: 'conferência 04:00', dias: [ontem], ...r.reqs, pedidos_lidos: r.pedidos, segundos: r.segundos }].slice(-60);
    fs.writeFileSync(ARQ_COLETAS, JSON.stringify(coletas));
    log(`conferência ok: ${r.pedidos} pedidos em ${r.segundos} s · ${r.reqs.total} requisições`);
    agendarConferencia();
  } catch (e) {
    log('conferência falhou:', String(e?.message || e).slice(0, 160));
    if (tentativa < 4) setTimeout(() => conferir(tentativa + 1), 15 * 60e3);
    else agendarConferencia();
  } finally {
    lendo = false;
    emitir();
  }
}
function agendarConferencia() {
  setTimeout(() => conferir(), Math.max(1000, proximaConferencia() - Date.now()));
}

// Entregas buscando e em andamento: ficam só em memória, porque trazem o destino da entrega.
let buscando = { em: null, lista: [], andamento: [], erro: null, destinoCompleto: TEM_LOGIN };
let buscandoEmVoo = false;
async function lerBuscandoAgora() {
  if (buscandoEmVoo || !temAcesso()) return;
  buscandoEmVoo = true;
  try {
    const r = await lerBuscando(hoje());
    buscando = { em: r.em, lista: r.lista, andamento: r.andamento, erro: null, destinoCompleto: TEM_LOGIN };
    somarUso('busca', r.reqs, { encontradas: r.lista.length, andamento: r.andamento.length });
  } catch (e) {
    buscando = { ...buscando, erro: String(e?.message || e).slice(0, 160), erroEm: new Date().toISOString() };
    log('buscando falhou:', buscando.erro);
  } finally {
    buscandoEmVoo = false;
    emitir('buscando');
  }
}

// Histórico de entregadores: carrega os dias que faltam da janela, uma vez ao iniciar e depois a cada dia.
async function completarEntregadores() {
  if (!temAcesso()) return;
  const d = hoje(), de = somaDias(d, -DIAS_ENTREGADORES), ate = somaDias(d, -1);
  const lidoAte = entregadoresHist.ate;
  if (lidoAte === ate && entregadoresHist.de <= de) return;
  const inicio = lidoAte && lidoAte >= de && entregadoresHist.de <= de ? somaDias(lidoAte, 1) : de;
  try {
    const r = await lerEntregadores(inicio, ate);
    const dias = { ...entregadoresHist.dias, ...r.dias };
    for (const k of Object.keys(dias)) if (k < de) delete dias[k];
    entregadoresHist = { de, ate, dias };
    fs.writeFileSync(ARQ_ENTREGADORES, JSON.stringify(entregadoresHist));
    log(`entregadores ok: ${inicio} → ${ate} · ${r.reqs.total} requisições`);
    emitir();
  } catch (e) { log('entregadores falharam:', String(e?.message || e).slice(0, 160)); }
}

// --------------------------------------------------------------------- dados
function montarDados(diaPedido) {
  const lista = Object.keys(historico).sort().reverse();
  const dia = historico[diaPedido] ? diaPedido : lista[0];
  // o dia lido pela leitura ao vivo vale sobre o histórico carregado antes
  const porDia = { ...entregadoresHist.dias };
  for (const [d, h] of Object.entries(historico)) if (h.entregadores) porDia[d] = h.entregadores;
  return JSON.stringify({
    gerado_em: new Date().toISOString(),
    dias: lista.map((d) => ({ dia: d, fechado: !!historico[d].fechado })),
    atual: dia ? analisarDia(historico[dia]) : null,
    entregadores: rankingEntregadores(porDia, hoje()),
    coletas: [...coletas].reverse().slice(0, 15),
    uso, kpiMinutos: KPI_MS / 60e3, buscaSegundos: BUSCA_MS / 1000,
    proximaConferencia: new Date(proximaConferencia()).toISOString(),
    coletando: lendo, erro: ultimoErro, semAcesso: !temAcesso(),
  });
}

// ---------------------------------------------------------------------- web
const clientes = new Set();
function emitir(evento) { for (const c of clientes) c.write(evento ? `event: ${evento}\ndata: 1\n\n` : 'data: atualizado\n\n'); }
setInterval(() => { for (const c of clientes) c.write(': ping\n\n'); }, 25e3).unref();

const HTML = 'text/html; charset=utf-8';
const ESTATICOS = { '/': ['index.html', HTML], '/index.html': ['index.html', HTML], '/bee.png': ['bee.png', 'image/png'], '/logo-pm.webp': ['logo-pm.webp', 'image/webp'], '/logo-ef.webp': ['logo-ef.webp', 'image/webp'] };
http.createServer((req, res) => {
  if (!autorizar(req, res)) return;
  const url = new URL(req.url, 'http://x');
  const est = ESTATICOS[url.pathname];
  if (est) {
    res.writeHead(200, { 'Content-Type': est[1], 'Cache-Control': TEM_LOGIN ? 'private, no-cache' : 'no-cache' });
    return fs.createReadStream(path.join(DIR, 'public', est[0])).pipe(res);
  }
  if (url.pathname === '/api/dados') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(montarDados(url.searchParams.get('dia')));
  }
  if (url.pathname === '/api/buscando') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(buscando));
  }
  if (url.pathname === '/api/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': conectado\n\n');
    clientes.add(res);
    return req.on('close', () => clientes.delete(res));
  }
  res.writeHead(404).end();
}).listen(PORT, '0.0.0.0', async () => {
  log(`Painel Pague Menos em http://localhost:${PORT} — ${Object.keys(historico).length} dia(s) em cache · indicadores a cada ${KPI_MS / 60e3} min · buscando a cada ${BUSCA_MS / 1000} s · login ${TEM_LOGIN ? 'ativo' : 'desligado'}`);
  if (!temAcesso()) return log('sem acesso à API no .env: rode configurar-acesso.ps1');
  agendarConferencia();
  lerBuscandoAgora();
  setInterval(lerBuscandoAgora, BUSCA_MS);
  await lerIndicadores();
  setInterval(lerIndicadores, KPI_MS);
  await completarEntregadores();
  setInterval(completarEntregadores, 6 * 3600e3).unref();
});
