// Painel de Controle de Custos · GM Consultoria (uso pessoal)
// Um contêiner com três coisas, todas sobre o mesmo dados/dados.json:
//   /            a página do painel (public/), com login básico se PAINEL_SENHA estiver no .env
//   /api/dados   leitura e gravação da página (com revisão: quem gravar por cima de mudança alheia recebe 409)
//   /mcp         servidor MCP para o Claude lançar e consultar pelo chat (chave MCP_TOKEN)
//
// A chave do MCP vai no cabeçalho "Authorization: Bearer <chave>" (Claude Code, Claude Desktop, .mcp.json)
// ou no próprio endereço /mcp/<chave> (conector personalizado do claude.ai, que não manda cabeçalho).
// Sem MCP_TOKEN no .env, o servidor cria uma chave em dados/mcp-token.txt e mostra o endereço no log.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { criarGuarda } from './regras.mjs';
import { tratarMensagem } from './mcp.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, 'public');
const DADOS = path.join(DIR, 'dados');
fs.mkdirSync(DADOS, { recursive: true });
const guarda = criarGuarda(DADOS);

const PORTA = Number(process.env.PORTA || 3110);
const USUARIO = process.env.PAINEL_USUARIO || 'gm';
const SENHA = process.env.PAINEL_SENHA || '';
const URL_PUBLICA = (process.env.URL_PUBLICA || `http://localhost:${PORTA}`).replace(/\/$/, '');
const LIMITE = 25 * 1024 * 1024;

const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }), ...a);

function chaveMcp() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN.trim();
  const arq = path.join(DADOS, 'mcp-token.txt');
  if (fs.existsSync(arq)) return fs.readFileSync(arq, 'utf8').trim();
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(arq, t + '\n', { mode: 0o600 });
  return t;
}
const MCP_TOKEN = chaveMcp();
const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };

function loginOk(req) {
  if (!SENHA) return true;
  const [tipo, val] = String(req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !val) return false;
  const [u, ...s] = Buffer.from(val, 'base64').toString().split(':');
  return igual(u, USUARIO) && igual(s.join(':'), SENHA);
}
function lerCorpo(req) {
  return new Promise((ok, falha) => {
    const partes = []; let tam = 0;
    req.on('data', (c) => { tam += c.length; if (tam > LIMITE) { falha(new Error('corpo grande demais')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

async function rotaMcp(req, res, chaveNoCaminho) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!igual(chaveNoCaminho || bearer || '', MCP_TOKEN)) {
    // registra a tentativa sem a chave: ajuda a ver um conector configurado com o endereço errado
    log('mcp 401', req.method, chaveNoCaminho ? 'chave no endereço' : bearer ? 'chave no cabeçalho' : 'sem chave', String(req.headers['user-agent'] || '').slice(0, 60));
    return json(res, 401, { erro: 'chave do MCP inválida' }, { 'WWW-Authenticate': 'Bearer' });
  }
  if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); } // sem fluxo SSE: tudo responde no próprio POST
  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  let corpo;
  try { corpo = JSON.parse(await lerCorpo(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); }
  const lote = Array.isArray(corpo);
  const respostas = (await Promise.all((lote ? corpo : [corpo]).map((m) => tratarMensagem(guarda, m, log)))).filter(Boolean);
  if (!respostas.length) { res.writeHead(202); return res.end(); }
  json(res, 200, lote ? respostas : respostas[0]);
}

// registro de acesso (sem a chave do MCP; /saude e /api/rev ficam de fora porque repetem o tempo todo)
function registrarAcesso(req, res, pathname) {
  if (pathname === '/saude' || pathname === '/api/rev' || /\.(js|css|png|svg|ico|webp|woff2?)$/.test(pathname)) return;
  const inicio = Date.now();
  res.on('finish', () => log('http', req.method, pathname.replace(/^\/mcp\/[^/]+/, '/mcp/<chave>'), res.statusCode, `${Date.now() - inicio}ms`, String(req.headers['user-agent'] || '-').slice(0, 50)));
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    registrarAcesso(req, res, url.pathname);
    if (url.pathname === '/saude') return json(res, 200, { ok: true });
    // o MCP não usa OAuth (a chave vai no cabeçalho ou no endereço): a descoberta responde 404, sem pedir senha
    if (url.pathname.startsWith('/.well-known/')) return json(res, 404, { erro: 'não encontrado' });
    const mcp = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (mcp) return await rotaMcp(req, res, mcp[1] ? decodeURIComponent(mcp[1]) : '');

    if (!loginOk(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Painel GM Consultoria", charset="UTF-8"' });
      return res.end('Acesso restrito');
    }
    if (url.pathname === '/api/rev') { const a = guarda.ler(); return json(res, 200, { rev: a ? a.dados.rev : null }); }
    if (url.pathname === '/api/dados') {
      if (req.method === 'GET') {
        const a = guarda.ler();
        if (!a) return json(res, 404, { erro: 'sem dados' });
        return json(res, 200, { dados: a.dados, salvoEm: a.salvoEm, rev: a.dados.rev });
      }
      if (req.method === 'PUT') {
        const corpo = JSON.parse(await lerCorpo(req));
        if (!corpo?.dados || typeof corpo.dados !== 'object') return json(res, 400, { erro: 'faltou { dados }' });
        const r = await guarda.substituir(corpo.dados, corpo.rev);
        if (r.conflito) return json(res, 409, { erro: 'os dados mudaram (provavelmente pelo Claude); recarregue', rev: r.rev });
        return json(res, 200, { ok: true, rev: r.rev, salvoEm: new Date().toISOString() });
      }
      return json(res, 405, { erro: 'método não aceito' });
    }
    const alvo = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!alvo.startsWith(PUB) || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) { res.writeHead(404); return res.end('não encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(alvo).pipe(res);
  } catch (e) {
    log('erro', e.message);
    if (!res.headersSent) json(res, 500, { erro: e.message });
  }
}).listen(PORTA, () => {
  log(`Painel GM Consultoria em ${URL_PUBLICA}${SENHA ? ' (com senha)' : ' (sem senha: defina PAINEL_SENHA)'}`);
  log(`MCP: ${URL_PUBLICA}/mcp  (cabeçalho Authorization: Bearer <MCP_TOKEN>)`);
  if (!process.env.MCP_TOKEN) log(`Chave do MCP gerada em dados/mcp-token.txt · endereço para o claude.ai: ${URL_PUBLICA}/mcp/${MCP_TOKEN}`);
});
