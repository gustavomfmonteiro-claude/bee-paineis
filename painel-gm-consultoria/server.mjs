// Painel de Controle de Custos · GM Consultoria
// Serve a página (public/) e guarda os dados em dados/dados.json. Sem dependências.
// A página também funciona sozinha (abrindo o index.html): aí os dados ficam só no navegador.
//
//   GET  /api/dados   → { dados, salvoEm }   (404 se ainda não houver nada salvo)
//   PUT  /api/dados   ← { dados }            (grava com cópia de segurança diária em dados/backup/)
//
// Acesso: se PAINEL_SENHA estiver no .env, pede login básico (usuário PAINEL_USUARIO, padrão "gm").
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, 'public');
const DADOS = path.join(DIR, 'dados');
const ARQ = path.join(DADOS, 'dados.json');
const BKP = path.join(DADOS, 'backup');
fs.mkdirSync(BKP, { recursive: true });

const PORTA = Number(process.env.PORTA || 3110);
const USUARIO = process.env.PAINEL_USUARIO || 'gm';
const SENHA = process.env.PAINEL_SENHA || '';
const LIMITE = 25 * 1024 * 1024; // corpo máximo do PUT

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' }), ...a);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function autorizado(req) {
  if (!SENHA) return true;
  const [tipo, val] = String(req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !val) return false;
  const [u, ...s] = Buffer.from(val, 'base64').toString().split(':');
  return u === USUARIO && s.join(':') === SENHA;
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    const partes = []; let tam = 0;
    req.on('data', (c) => { tam += c.length; if (tam > LIMITE) { falha(new Error('corpo grande demais')); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}

http.createServer(async (req, res) => {
  try {
    if (!autorizado(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Painel GM Consultoria", charset="UTF-8"' });
      return res.end('Acesso restrito');
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/dados') {
      if (req.method === 'GET') {
        if (!fs.existsSync(ARQ)) return json(res, 404, { erro: 'sem dados' });
        const st = fs.statSync(ARQ);
        return json(res, 200, { dados: JSON.parse(fs.readFileSync(ARQ, 'utf8')), salvoEm: st.mtime.toISOString() });
      }
      if (req.method === 'PUT') {
        const corpo = JSON.parse(await lerCorpo(req));
        if (!corpo?.dados || typeof corpo.dados !== 'object') return json(res, 400, { erro: 'faltou { dados }' });
        fs.mkdirSync(BKP, { recursive: true });
        const dia = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
        const bkp = path.join(BKP, `dados-${dia}.json`);
        if (fs.existsSync(ARQ) && !fs.existsSync(bkp)) fs.copyFileSync(ARQ, bkp);
        fs.writeFileSync(ARQ + '.tmp', JSON.stringify(corpo.dados));
        fs.renameSync(ARQ + '.tmp', ARQ);
        return json(res, 200, { ok: true, salvoEm: new Date().toISOString() });
      }
      return json(res, 405, { erro: 'método não aceito' });
    }
    if (url.pathname === '/saude') return json(res, 200, { ok: true });
    // arquivos estáticos
    const alvo = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!alvo.startsWith(PUB) || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) { res.writeHead(404); return res.end('não encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(alvo).pipe(res);
  } catch (e) {
    log('erro', e.message);
    json(res, 500, { erro: e.message });
  }
}).listen(PORTA, () => log(`Painel GM Consultoria em http://localhost:${PORTA}${SENHA ? ' (com senha)' : ''}`));
