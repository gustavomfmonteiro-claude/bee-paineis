// Relatório Executivo Operacional Pague Menos: roda neste computador às 23:00 (tarefa agendada), lê os
// dados do painel e grava um PDF com a data na pasta de relatórios. Se o PC estava desligado às 23:00, a
// tarefa roda quando ele ligar e o relatório sai do dia anterior, já fechado até 23:59.
// Uso: node relatorio.mjs [--url=http://localhost:3070] [--saida=pasta] [--dia=AAAA-MM-DD]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (nome, padrao) => {
  const a = process.argv.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : padrao;
};
const URL_PAINEL = arg('url', 'https://pague-menos.179-197-229-171.sslip.io').replace(/\/+$/, '');
const PASTA = arg('saida', 'C:\\Users\\lojaa\\OneDrive\\Desktop\\Gustavo IA\\relatorios pague menos');
const DIA_PEDIDO = arg('dia', '');
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
const somaDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toLocaleString('pt-BR'), ...a);
// Acesso do relatório, criado por configurar-senha-painel.ps1
let cabecalhos = {};
try { cabecalhos = { Authorization: 'Bearer ' + fs.readFileSync(path.join(os.homedir(), '.bee_painel_pm_token'), 'utf8').trim() }; } catch {}
async function ler(dia) {
  const r = await fetch(`${URL_PAINEL}/api/dados${dia ? '?dia=' + dia : ''}`, { cache: 'no-store', headers: cabecalhos });
  if (!r.ok) throw new Error('painel respondeu HTTP ' + r.status);
  return r.json();
}

// ------------------------------------------------------------------ formatação
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const pc = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%');
const min = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' min');
const br = (d) => d.split('-').reverse().join('/');
const nome = (l) => `${l.num ? l.num + ' · ' : ''}${esc(l.bairro)} (${l.band})`;

function tabela(cab, linhas, vazio) {
  if (!linhas.length) return `<p class="vazio">${vazio}</p>`;
  return `<table><thead><tr>${cab.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// OTD por modalidade: no prazo da própria modalidade (Super Expressa 30 min, Expressa 60 min, Econômica 2 h)
const PRAZO_TXT = { 'Super Expressa': '30 min', Expressa: '60 min', 'Econômica': '2 h' };
const MODS = ['Super Expressa', 'Expressa', 'Econômica'];
const otdMod = (k, m) => { const x = (k?.mods || []).find((y) => y.mod === m); return x?.otdN ? `${pc(x.otd)} <small>(${num(x.otdN)})</small>` : '—'; };
const textoMods = (k) => (k.mods || []).filter((x) => x.prazo && x.otdN).map((x) => `${x.mod} ${pc(x.otd)}`).join(', ');

function resumo(a) {
  const k = a.kpis, f = [];
  f.push(`O grupo teve <b>${num(k.dem)} pedidos</b> em ${num(k.lojas)} lojas: ${num(k.fin)} finalizados e ${num(k.canc)} cancelados (${pc(k.taxaCanc)} da demanda).`);
  f.push(`O OTD no prazo da modalidade ficou em <b>${pc(k.otd)}</b>${textoMods(k) ? ` (${textoMods(k)})` : ''}; o aceite levou ${min(k.aceite)} em média${k.direto ? `, sem contar ${num(k.direto)} pedidos de integração que já nasceram com entregador` : ''}.`);
  f.push(`${num(k.cOp)} cancelamentos foram operacionais (${pc(k.pctOpDosCanc)} do total) e ${num(k.c05)} saíram de 0 a 5 minutos (${pc(k.pctC05)}).`);
  const alta = a.orientacoes.filter((o) => o.nivel === 'alta').length;
  f.push(a.orientacoes.length ? `As regras apontaram ${num(a.orientacoes.length)} ajustes, ${num(alta)} de prioridade alta.` : 'Nenhuma loja acionou as regras de ajuste.');
  return f.join(' ');
}

function montar(d, ontem) {
  const a = d.atual, k = a.kpis, r = a.rankings, u = d.uso;
  const periodo = a.fechado ? 'das 00:00 às 23:59' : 'das 00:00 até a leitura abaixo';
  const kpi = (t, v, s) => `<div class="kpi"><span>${t}</span><b>${v}</b><small>${s}</small></div>`;
  const prio = a.prioridade.map((l) => {
    if (l.semPedidos) return `<h3>Loja ${esc(l.num)}</h3><p class="vazio">Sem pedidos neste dia.</p>`;
    return `<div class="bloco"><h3>Loja ${esc(l.num)} · ${esc(l.bairro)} (${l.band === 'EF' ? 'Extrafarma' : 'Pague Menos'})</h3>
      <p>Demanda ${num(l.dem)} · finalizadas ${num(l.fin)} · em andamento ${num(l.and)} · canceladas ${num(l.canc)} · operacionais ${num(l.cOp)} · de 0 a 5 min ${num(l.c05)} · aceite ${min(l.aceite)}${l.direto ? ` (${num(l.direto)} sem busca)` : ''} · OTD ${pc(l.otd)} (${num(l.otdN)} entregas)${textoMods(l) ? `: ${textoMods(l)}` : ''}</p>
      ${tabela(['Motivo de cancelamento', 'Tipo', 'Qtde', 'De 0 a 5 min'], l.motivos.map((m) => [esc(m.motivo), m.op ? 'Operacional' : esc(m.grupo), num(m.n), num(m.c05)]), 'Nenhum cancelamento neste dia.')}</div>`;
  }).join('');
  const ontemKpis = ontem?.atual?.dia === somaDias(a.dia, -1) && ontem.atual.fechado ? ontem.atual.kpis : null;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório Executivo Operacional Pague Menos ${br(a.dia)}</title><style>
  @page{size:A4;margin:14mm 13mm}
  *{box-sizing:border-box}
  body{font:11px/1.45 "Segoe UI",Arial,sans-serif;color:#1c1b18;margin:0}
  h1{font-size:20px;margin:0}h2{font-size:13.5px;margin:18px 0 6px;padding-bottom:3px;border-bottom:2px solid #FFD200;break-after:avoid}
  h3{font-size:12px;margin:12px 0 3px;break-after:avoid}p{margin:0 0 6px}
  .sub{color:#65625a}.resumo{background:#f6f4ea;border-left:3px solid #FFD200;padding:9px 12px;margin:12px 0;font-size:12px}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}.kpi{border:1px solid #dedbcd;border-radius:6px;padding:7px 8px}
  .kpi span,.kpi small{display:block;color:#65625a;font-size:9.5px}.kpi b{font-size:17px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px;font-variant-numeric:tabular-nums}
  th{text-align:right;font-weight:600;color:#65625a;font-size:9.5px;border-bottom:1px solid #b9b5a4;padding:3px 5px}
  td{text-align:right;padding:3px 5px;border-bottom:1px solid #ecead9}
  th:first-child,td:first-child{text-align:left;padding-left:0}tr{break-inside:avoid}
  td small{color:#65625a;font-size:9px}
  .duas{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.vazio{color:#65625a}
  .bloco{break-inside:avoid}.ori{margin-bottom:6px;break-inside:avoid}.ori b.alta{color:#b3122a}.ori b.media{color:#a85a00}
  footer{margin-top:16px;color:#65625a;font-size:9.5px;border-top:1px solid #dedbcd;padding-top:6px}
  </style></head><body>
  <h1>Relatório Executivo Operacional · Pague Menos e Extrafarma</h1>
  <div class="sub">${br(a.dia)}, ${periodo} · Fortaleza · leitura de ${new Date(a.lido_em).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' })}</div>
  <div class="resumo">${resumo(a)}</div>
  <div class="kpis">
    ${kpi('Demanda', num(k.dem), `${num(k.lojas)} lojas`)}${kpi('Finalizadas', num(k.fin), k.and ? `${num(k.and)} em outros status` : '&nbsp;')}${kpi('Cancelamentos', num(k.canc), pc(k.taxaCanc))}
    ${kpi('Aceite médio', min(k.aceite), `${pc(k.pctAte5)} até 5 min`)}${kpi('OTD da modalidade', pc(k.otd), `${num(k.otdN)} entregas`)}${kpi('Tempo das pontas', `${min(k.p1Med)} · ${min(k.p2Med)}`, 'até a loja · loja ao cliente')}
  </div>
  ${ontemKpis ? `<p style="margin-top:8px"><b>Fechamento de ${br(somaDias(a.dia, -1))} (00:00 às 23:59):</b> ${num(ontemKpis.dem)} pedidos, ${num(ontemKpis.fin)} finalizados, ${num(ontemKpis.canc)} cancelados (${pc(ontemKpis.taxaCanc)}), OTD ${pc(ontemKpis.otd)}${textoMods(ontemKpis) ? ` (${textoMods(ontemKpis)})` : ''}, aceite ${min(ontemKpis.aceite)}.</p>` : ''}
  <h2>OTD por modalidade</h2>
  ${tabela(['Modalidade', 'Prazo', 'Demanda', 'Finalizadas', 'Canceladas', 'OTD', 'No prazo', 'Até o cliente', 'OTD Pague Menos', 'OTD Extrafarma'], (k.mods || []).map((x) => [esc(x.mod), PRAZO_TXT[x.mod] || 'sem prazo', num(x.dem), num(x.fin), `${num(x.canc)} <small>(${pc(x.taxaCanc)})</small>`, x.prazo ? pc(x.otd) : '—', x.prazo ? `${num(x.noPrazo)} de ${num(x.otdN)}` : '—', min(x.tempo), otdMod(a.bandeiras.PM, x.mod), otdMod(a.bandeiras.EF, x.mod)]), 'Dia sem separação por modalidade.')}
  <h2>Por bandeira</h2>
  ${tabela(['Bandeira', 'Demanda', 'Finalizadas', 'Canceladas', '% canc.', 'Operacional', '0 a 5 min', 'Aceite', ...MODS.map((m) => 'OTD ' + m), 'OTD geral'], [['Pague Menos', a.bandeiras.PM], ['Extrafarma', a.bandeiras.EF]].map(([n, b]) => [n, num(b.dem), num(b.fin), num(b.canc), pc(b.taxaCanc), num(b.cOp), num(b.c05), min(b.aceite), ...MODS.map((m) => otdMod(b, m)), pc(b.otd)]), '')}
  <h2>Lojas com prioridade de observação</h2>${prio}
  <h2>Orientação de ajustes</h2>
  ${a.orientacoes.length ? a.orientacoes.slice(0, 15).map((o) => `<div class="ori"><b class="${o.nivel}">${o.nivel === 'alta' ? 'Alta' : 'Média'}</b> · <b>${esc(o.loja)}</b> · ${esc(o.area)}. ${esc(o.evidencia)} <b>Ajuste:</b> ${esc(o.acao)}</div>`).join('') : '<p class="vazio">Nenhuma loja acionou as regras de ajuste neste dia.</p>'}
  ${a.orientacoes.length > 15 ? `<p class="vazio">Mostrando 15 de ${num(a.orientacoes.length)}; o painel traz as demais.</p>` : ''}
  <div class="duas">
    <div><h2>Maior demanda</h2>${tabela(['Loja', 'Demanda', 'Canc.'], r.demanda.map((l) => [nome(l), num(l.dem), num(l.canc)]), 'Sem pedidos.')}</div>
    <div><h2>Maior dificuldade para aceitar</h2>${tabela(['Loja', 'Dificuldade', 'Aceite'], r.aceite.map((l) => [nome(l), pc(l.dificuldade), min(l.aceite)]), 'Nenhuma loja com volume suficiente.')}</div>
    <div><h2>Cancelamento operacional</h2>${tabela(['Loja', 'Operacional', '% demanda'], r.operacional.map((l) => [nome(l), num(l.cOp), pc(l.pctOp)]), 'Nenhum.')}</div>
    <div><h2>Cancelamento de 0 a 5 minutos</h2>${tabela(['Loja', '0 a 5 min', '% canc.'], r.ate5.map((l) => [nome(l), num(l.c05), pc(l.pctC05)]), 'Nenhum.')}</div>
  </div>
  <h2>Motivos de cancelamento do grupo</h2>
  ${tabela(['Motivo', 'Tipo', 'Qtde', '%'], a.motivos.map((m) => [esc(m.grupo), m.op ? 'Operacional' : 'Não operacional', num(m.n), pc(m.pct)]), 'Nenhum cancelamento.')}
  <footer>${u?.kpi ? `Requisições à API até agora em ${br(u.dia)}: ${num(u.kpi.total + u.busca.total)} (indicadores ${num(u.kpi.total)} em ${num(u.kpi.leituras)} leituras, buscando ${num(u.busca.total)} em ${num(u.busca.leituras)} leituras, logins ${num(u.kpi.login + u.busca.login)}). ` : ''}Aceite: só pedidos que passaram por busca. OTD: finalizada que chegou ao cliente dentro do prazo da modalidade, contado da criação (Super Expressa 30 min, Expressa 60 min, Econômica 2 h); a modalidade vem do prazo do pedido, como no Radar. Pontas: tempo médio até a loja e da loja ao cliente. Operacional: falta de entregador ou atraso/problema do entregador. Painel: ${esc(URL_PAINEL)}</footer>
  </body></html>`;
}

// --------------------------------------------------------------------- execução
async function principal() {
  // Às 23:00 sai o dia corrente. Rodando antes disso, é a tarefa atrasada de ontem.
  const hora = Number(new Date().toLocaleString('sv-SE', { timeZone: 'America/Fortaleza' }).slice(11, 13));
  const dia = DIA_PEDIDO || (hora >= 23 ? hoje() : somaDias(hoje(), -1));
  const atual = await ler(dia);
  if (atual.atual?.dia !== dia) throw new Error('o painel não tem dados de ' + dia);
  const ontem = await ler(somaDias(dia, -1)).catch(() => null);

  fs.mkdirSync(PASTA, { recursive: true });
  const base = path.join(PASTA, `Relatorio Executivo Operacional Pague Menos ${dia}`);
  const html = montar(atual, ontem);
  const tmp = path.join(os.tmpdir(), `relatorio-pm-${dia}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  let pronto = false;
  if (EDGE) {
    spawnSync(EDGE, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(os.tmpdir(), 'relatorio-pm-edge')}`, '--no-pdf-header-footer', `--print-to-pdf=${base}.pdf`, tmp], { timeout: 120000 });
    pronto = fs.existsSync(base + '.pdf') && fs.statSync(base + '.pdf').mtimeMs > Date.now() - 180000;
  }
  // Sem Edge ou se o PDF falhar, o relatório não se perde: fica em HTML, que abre em qualquer navegador.
  if (pronto) log('relatório gravado:', base + '.pdf');
  else { fs.writeFileSync(base + '.html', html, 'utf8'); log('PDF indisponível; relatório gravado em HTML:', base + '.html'); }
  fs.rmSync(tmp, { force: true });
}

principal().catch((e) => { log('relatório falhou:', e.message); process.exit(1); });
