// Regras do painel no lado do servidor: guarda dos dados (dados/dados.json) e os mesmos cálculos da página
// (public/index.html). Usado pelo servidor MCP para o Claude lançar e consultar pelo chat.
// Mudou um cálculo aqui? Mude igual na página (calcNota, criarNotaObj, xmlNota), e vice-versa.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------- datas e números ----------------
export const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
export function lerValor(s) {
  if (typeof s === 'number') return s;
  s = String(s || '').replace(/[R$\s]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const v = parseFloat(s);
  return isFinite(v) ? v : 0;
}
export const soDig = (s) => String(s || '').replace(/\D/g, '');
// "hoje" no fuso da empresa, independente do relógio do contêiner
export const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const dt = (s) => new Date(s + 'T12:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
export const somaDias = (s, n) => { const d = dt(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const somaMeses = (s, n) => { const d = dt(s); const dia = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const ult = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(dia, ult)); return iso(d); };
export const iniMes = (s) => s.slice(0, 8) + '01';
export const fimMes = (s) => { const d = dt(iniMes(s)); return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12))); };
export const dataValida = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dt(s));
export const uid = () => crypto.randomBytes(5).toString('hex') + Date.now().toString(36).slice(-4);
export const brl = (v) => r2(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------- guarda ----------------
export const RET = { pis: ['PIS', 0.65], cofins: ['COFINS', 3], csll: ['CSLL', 1], ir: ['IRRF', 1.5], inss: ['INSS', 11] };
export const FORMAS = ['Pix', 'Boleto', 'Transferência', 'Cartão de crédito', 'Cartão de débito', 'Dinheiro', 'Débito automático'];
export function baseVazia() {
  return {
    versao: 1, rev: 0,
    empresa: { razao: 'GM Consultoria', fantasia: 'GM Consultoria', cnpj: '', im: '', regime: 'simples', endereco: '', cep: '', municipio: 'Fortaleza', uf: 'CE', ibge: '2304400', email: '', fone: '', aliqISS: 5, serie: '1', proxNum: 1, saldoInicial: 0, prazo: 15, obs: '' },
    clientes: [],
    servicos: [{ id: uid(), nome: 'Consultoria empresarial', codigo: '17.01', cnae: '7020-4/00', descricao: 'Serviços de consultoria em gestão empresarial', valor: 0, aliq: 5, recorrente: false }],
    notas: [], lanc: [],
    categorias: {
      saida: ['Aluguel', 'Salários e encargos', 'Pró-labore', 'Impostos', 'Contabilidade', 'Software e sistemas', 'Energia e internet', 'Marketing', 'Combustível e deslocamento', 'Alimentação', 'Material de escritório', 'Serviços de terceiros', 'Tarifas bancárias', 'Outros'],
      entrada: ['Serviços prestados', 'Treinamentos', 'Rendimentos', 'Outras receitas'],
    },
    centros: ['Administrativo', 'Comercial', 'Operacional', 'Projetos'],
    demo: false,
  };
}
export function completar(db) {
  const b = baseVazia();
  db.empresa = Object.assign(b.empresa, db.empresa || {});
  for (const k of ['clientes', 'servicos', 'notas', 'lanc', 'centros']) db[k] = db[k] || b[k];
  db.categorias = Object.assign(b.categorias, db.categorias || {});
  db.rev = Number(db.rev) || 0;
  return db;
}

export function criarGuarda(dir) {
  const ARQ = path.join(dir, 'dados.json'), BKP = path.join(dir, 'backup');
  fs.mkdirSync(BKP, { recursive: true });
  let fila = Promise.resolve();
  const ler = () => {
    if (!fs.existsSync(ARQ)) return null;
    return { dados: completar(JSON.parse(fs.readFileSync(ARQ, 'utf8'))), salvoEm: fs.statSync(ARQ).mtime.toISOString() };
  };
  const gravar = (dados) => {
    fs.mkdirSync(BKP, { recursive: true });
    const bkp = path.join(BKP, `dados-${hoje()}.json`);
    if (fs.existsSync(ARQ) && !fs.existsSync(bkp)) fs.copyFileSync(ARQ, bkp);
    dados.rev = (Number(dados.rev) || 0) + 1;
    fs.writeFileSync(ARQ + '.tmp', JSON.stringify(dados));
    fs.renameSync(ARQ + '.tmp', ARQ);
    return dados.rev;
  };
  // Toda escrita passa por esta fila: o painel e o MCP nunca gravam ao mesmo tempo.
  const emFila = (fn) => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };
  return {
    ler,
    // alteração feita pelo MCP: lê, muda e grava numa vez só
    alterar: (fn) => emFila(() => { const atual = ler()?.dados || baseVazia(); const r = fn(atual); gravar(atual); return r; }),
    // gravação da página: só aceita se partiu da revisão atual (senão alguém mudou no meio)
    substituir: (dados, revBase) => emFila(() => {
      const atual = ler();
      if (atual && revBase != null && Number(revBase) !== atual.dados.rev) return { conflito: true, rev: atual.dados.rev };
      dados.rev = atual ? atual.dados.rev : 0;
      return { rev: gravar(completar(dados)) };
    }),
  };
}

// ---------------- regras financeiras (iguais às da página) ----------------
export const situacao = (l) => (l.status === 'pago' ? 'pago' : (l.venc || l.data) < hoje() ? 'atrasado' : 'pendente');

export function calcNota(w) {
  const valor = r2(lerValor(w.valor)), deducoes = r2(lerValor(w.deducoes)), desconto = r2(lerValor(w.desconto));
  const aliq = lerValor(w.aliq);
  const base = Math.max(0, r2(valor - deducoes - desconto));
  const iss = r2(base * aliq / 100);
  const ret = {}; let totalRet = 0;
  for (const k of Object.keys(RET)) if (w.ret && w.ret[k] != null && w.ret[k] !== false) { ret[k] = r2(valor * lerValor(w.ret[k]) / 100); totalRet += ret[k]; }
  totalRet = r2(totalRet);
  const liquido = r2(valor - desconto - totalRet - (w.issRetido ? iss : 0));
  return { valor, deducoes, desconto, aliq, base, iss, ret, totalRet, liquido };
}

export function criarNotaObj(base, w) {
  const e = base.empresa;
  const c = calcNota(w);
  const numero = Number(e.proxNum) || 1;
  e.proxNum = numero + 1;
  const emissao = w.emissao || hoje();
  const n = {
    id: uid(), numero, serie: e.serie || '1', emissao, criadaEm: new Date().toISOString(), competencia: w.competencia || iniMes(emissao),
    venc: w.venc || somaDias(emissao, Number(e.prazo) || 15), status: 'emitida', clienteId: w.clienteId || null,
    toma: { ...w.toma }, servicoId: w.servicoId || null, codigo: w.codigo, cnae: w.cnae || '', descricao: w.descricao, obs: w.obs || '',
    issRetido: !!w.issRetido, retPct: { ...(w.ret || {}) }, ...c, origem: w.origem || 'painel',
    prest: { razao: e.razao, cnpj: e.cnpj, im: e.im, endereco: e.endereco, municipio: e.municipio, uf: e.uf, ibge: e.ibge, email: e.email, fone: e.fone, regime: e.regime },
  };
  n.codVerif = (soDig(e.cnpj).slice(0, 4) + numero.toString(36) + n.id).toUpperCase().slice(0, 9).padEnd(9, 'X');
  const lanc = { id: uid(), tipo: 'entrada', data: emissao, venc: n.venc, descricao: `NFS-e ${numero} · ${n.toma.nome}`, categoria: 'Serviços prestados', centro: 'Projetos',
    contraparte: n.toma.nome, doc: String(numero), valor: n.liquido, status: 'pendente', pagoEm: '', forma: 'Pix', origem: 'nfse', notaId: n.id };
  n.lancId = lanc.id;
  base.notas.push(n); base.lanc.push(lanc);
  if (!n.issRetido && e.regime !== 'simples' && e.regime !== 'mei' && n.iss > 0) {
    const v = somaMeses(iniMes(n.competencia), 1).slice(0, 8) + '10';
    base.lanc.push({ id: uid(), tipo: 'saida', data: n.competencia, venc: v, descricao: `ISS NFS-e ${numero}`, categoria: 'Impostos', centro: 'Administrativo', contraparte: 'Prefeitura', doc: String(numero), valor: n.iss, status: 'pendente', pagoEm: '', forma: 'Boleto', origem: 'nfse', notaId: n.id });
  }
  return n;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function xmlNota(n, empresa) {
  const p = n.prest || empresa;
  const docT = soDig(n.toma.doc);
  const idDps = 'DPS' + String(p.ibge || '').padStart(7, '0') + '2' + soDig(p.cnpj).padStart(14, '0') + String(n.serie).padStart(5, '0') + String(n.numero).padStart(15, '0');
  const r = n.ret || {};
  const fed = Object.keys(r).length ? `<tribFed>${r.pis != null || r.cofins != null ? `<piscofins><CST>01</CST><vPis>${(r.pis || 0).toFixed(2)}</vPis><vCofins>${(r.cofins || 0).toFixed(2)}</vCofins><tpRetPisCofins>1</tpRetPisCofins></piscofins>` : ''}${r.inss != null ? `<vRetCP>${r.inss.toFixed(2)}</vRetCP>` : ''}${r.ir != null ? `<vRetIRRF>${r.ir.toFixed(2)}</vRetIRRF>` : ''}${r.csll != null ? `<vRetCSLL>${r.csll.toFixed(2)}</vRetCSLL>` : ''}</tribFed>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Gerado pelo Painel GM Consultoria · layout DPS da NFS-e Nacional (sem assinatura digital) -->
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00">
  <infDPS Id="${idDps}">
    <tpAmb>2</tpAmb>
    <dhEmi>${n.criadaEm || n.emissao + 'T09:00:00-03:00'}</dhEmi>
    <verAplic>PainelGM-1.0</verAplic>
    <serie>${esc(n.serie)}</serie>
    <nDPS>${n.numero}</nDPS>
    <dCompet>${n.competencia}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${esc(p.ibge)}</cLocEmi>
    <prest>
      <CNPJ>${soDig(p.cnpj)}</CNPJ>${p.im ? `<IM>${esc(p.im)}</IM>` : ''}
      <xNome>${esc(p.razao)}</xNome>${p.email ? `<email>${esc(p.email)}</email>` : ''}
      <regTrib><opSimpNac>${p.regime === 'simples' ? 3 : p.regime === 'mei' ? 2 : 1}</opSimpNac><regEspTrib>0</regEspTrib></regTrib>
    </prest>
    <toma>
      ${docT.length === 11 ? `<CPF>${docT}</CPF>` : `<CNPJ>${docT}</CNPJ>`}
      <xNome>${esc(n.toma.nome)}</xNome>${n.toma.email ? `<email>${esc(n.toma.email)}</email>` : ''}
    </toma>
    <serv>
      <locPrest><cLocPrestacao>${esc(p.ibge)}</cLocPrestacao></locPrest>
      <cServ><cTribNac>${soDig(n.codigo).padEnd(6, '0').slice(0, 6)}</cTribNac><xDescServ>${esc(n.descricao)}</xDescServ></cServ>
    </serv>
    <valores>
      <vServPrest><vServ>${n.valor.toFixed(2)}</vServ></vServPrest>${n.desconto ? `\n      <vDescCondIncond><vDescIncond>${n.desconto.toFixed(2)}</vDescIncond></vDescCondIncond>` : ''}${n.deducoes ? `\n      <vDedRed><vDR>${n.deducoes.toFixed(2)}</vDR></vDedRed>` : ''}
      <trib>
        <tribMun><tribISSQN>1</tribISSQN><pAliq>${lerValor(n.aliq).toFixed(2)}</pAliq><tpRetISSQN>${n.issRetido ? 2 : 1}</tpRetISSQN></tribMun>${fed ? '\n        ' + fed : ''}
      </trib>
    </valores>
  </infDPS>
</DPS>
`;
}

// Lê o XML de uma NF-e, NFC-e ou NFS-e (de fornecedor) sem dependências: só os campos que o painel usa.
export function lerXmlNota(txt) {
  const bloco = (nomes, fonte = txt) => { for (const n of nomes) { const m = fonte.match(new RegExp(`<(?:\\w+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${n}>`)); if (m) return m[1]; } return ''; };
  const tag = (nomes, fonte = txt) => { for (const n of nomes) { const m = fonte.match(new RegExp(`<(?:\\w+:)?${n}\\b[^>]*>([^<]+)</(?:\\w+:)?${n}>`)); if (m && m[1].trim()) return m[1].trim(); } return ''; };
  const emit = bloco(['emit', 'prest', 'PrestadorServico', 'Prestador', 'emitente']) || txt;
  const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const c = {
    fornecedor: dec(tag(['xNome', 'RazaoSocial', 'xFant'], emit)),
    cnpj: tag(['CNPJ', 'Cnpj', 'CPF'], emit),
    numero: tag(['nNF', 'nNFSe', 'Numero', 'nDPS']),
    data_emissao: (tag(['dhEmi', 'dEmi', 'DataEmissao', 'dhProc']) || '').slice(0, 10),
    valor_total: Number(tag(['vNF', 'vLiq', 'ValorLiquidoNfse', 'vServ', 'ValorServicos'])) || 0,
    vencimento: (tag(['dVenc']) || '').slice(0, 10),
    descricao: [...txt.matchAll(/<(?:\w+:)?xProd>([^<]+)</g)].map((m) => dec(m[1])).slice(0, 3).join(', ') || dec(tag(['xDescServ', 'Discriminacao', 'xTribNac'])),
  };
  const id = txt.match(/<(?:\w+:)?infNFe[^>]*Id="([^"]+)"/);
  c.chave_acesso = id ? soDig(id[1]) : tag(['chNFe', 'chNFSe']);
  return c;
}

const PALAVRAS = [
  [/aluguel|imobili|condom[ií]nio/i, 'Aluguel'],
  [/posto|combust|gasolina|diesel|etanol|uber|99\s?pop|estacionamento|ped[aá]gio|passagem/i, 'Combustível e deslocamento'],
  [/restaurante|lanchonete|padaria|aliment|refei[cç]|caf[eé]|ifood|pizz/i, 'Alimentação'],
  [/software|licen[cç]a|assinatura|google|microsoft|adobe|aws|nuvem|hospedagem|dom[ií]nio|saas/i, 'Software e sistemas'],
  [/energia|enel|coelce|internet|telefon|vivo|claro|oi\b|tim\b/i, 'Energia e internet'],
  [/papelaria|escrit[oó]rio|kalunga|toner|impress/i, 'Material de escritório'],
  [/an[uú]ncio|marketing|publicidade|meta\s|facebook|instagram|ads/i, 'Marketing'],
  [/contab|cont[aá]bil/i, 'Contabilidade'],
  [/tarifa|banco|bancária/i, 'Tarifas bancárias'],
  [/das\b|simples nacional|darf|iss\b|gps|imposto/i, 'Impostos'],
];
export const sugerirCategoria = (texto, cats) => { const c = PALAVRAS.find(([re]) => re.test(texto))?.[1]; return c && cats.includes(c) ? c : 'Outros'; };

export function totais(lista) {
  const t = { entradas: 0, saidas: 0, entradas_pendentes: 0, saidas_pendentes: 0 };
  for (const l of lista) { const k = l.tipo === 'entrada' ? 'entradas' : 'saidas'; t[k] += l.valor; if (l.status !== 'pago') t[k + '_pendentes'] += l.valor; }
  for (const k in t) t[k] = r2(t[k]);
  return t;
}
export function saldoCaixaAte(db, data) {
  let s = lerValor(db.empresa.saldoInicial);
  for (const l of db.lanc) if (l.status === 'pago' && l.pagoEm && l.pagoEm <= data) s += l.tipo === 'entrada' ? l.valor : -l.valor;
  return r2(s);
}
export function statusNota(db, n) {
  if (n.status === 'cancelada') return 'cancelada';
  const l = db.lanc.find((x) => x.id === n.lancId);
  return l?.status === 'pago' ? 'recebida' : l && situacao(l) === 'atrasado' ? 'atrasada' : 'a receber';
}
