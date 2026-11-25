// Servidor MCP do Painel GM Consultoria (uso pessoal). Fala MCP por HTTP (Streamable HTTP, respostas JSON,
// sem sessão), sem dependências. O Claude usa estas ferramentas para lançar e consultar pelo chat:
// notas de entrada (fornecedores) e de saída (NFS-e emitidas), entradas e saídas, baixas, fluxo de caixa e custos.
// Tudo grava no mesmo dados/dados.json do painel, que mostra as mudanças sozinho.
import {
  r2, lerValor, soDig, hoje, somaDias, somaMeses, iniMes, fimMes, dataValida, uid, brl, RET, FORMAS,
  calcNota, criarNotaObj, xmlNota, lerXmlNota, sugerirCategoria, situacao, totais, saldoCaixaAte, statusNota, baseVazia,
} from './regras.mjs';

const VERSAO_PROTOCOLO = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'gm-consultoria', title: 'Painel GM Consultoria', version: '1.0.0' };
const INSTRUCOES = `Painel de Controle de Custos da GM Consultoria (uso pessoal do dono da empresa).
- Valores em reais; datas AAAA-MM-DD (fuso de Fortaleza). Sem período, use o mês atual.
- Nota de ENTRADA = nota de fornecedor (um gasto): registrar_nota_entrada. Com o XML em mãos, passe-o no campo xml.
- Nota de SAÍDA = NFS-e emitida pela GM: emitir_nfse. Antes de emitir, rode com simular=true, mostre o cálculo e só emita depois que o usuário confirmar.
- Gastos e receitas avulsos: registrar_lancamento. Pagamentos e recebimentos: dar_baixa.
- A NFS-e gerada aqui não tem validade fiscal até ser assinada com o certificado A1 e transmitida à prefeitura.`;

const s = (desc, extra = {}) => ({ type: 'string', description: desc, ...extra });
const n = (desc, extra = {}) => ({ type: 'number', description: desc, ...extra });
const b = (desc) => ({ type: 'boolean', description: desc });
const PERIODO = { de: s('Data inicial AAAA-MM-DD (padrão: 1º dia do mês atual)'), ate: s('Data final AAAA-MM-DD (padrão: último dia do mês atual)') };
const SO_LEITURA = { readOnlyHint: true, openWorldHint: false };
const ESCRITA = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const FERRAMENTAS = [
  { name: 'resumo_financeiro', title: 'Resumo financeiro', annotations: SO_LEITURA,
    description: 'Números do período: entradas, saídas, resultado e margem, saldo em caixa, a receber, a pagar, atrasados e notas emitidas.',
    inputSchema: { type: 'object', properties: { ...PERIODO } } },
  { name: 'listar_lancamentos', title: 'Listar entradas e saídas', annotations: SO_LEITURA,
    description: 'Lista lançamentos pela data de competência. Filtra por tipo, situação e texto. Devolve o id de cada um (usado em dar_baixa e excluir_lancamento).',
    inputSchema: { type: 'object', properties: { ...PERIODO, tipo: s('entrada ou saida', { enum: ['entrada', 'saida'] }), situacao: s('pago, pendente ou atrasado', { enum: ['pago', 'pendente', 'atrasado'] }), busca: s('Texto na descrição, fornecedor/cliente, nº do documento ou categoria'), limite: n('Máximo de itens (padrão 50)') } } },
  { name: 'registrar_lancamento', title: 'Registrar entrada ou saída', annotations: ESCRITA,
    description: 'Registra um gasto (saida) ou uma receita (entrada) avulsos. Pode repetir por vários meses (ex.: aluguel).',
    inputSchema: { type: 'object', required: ['tipo', 'descricao', 'valor'], properties: {
      tipo: s('entrada ou saida', { enum: ['entrada', 'saida'] }), descricao: s('O que é'), valor: n('Valor em reais'),
      data: s('Competência AAAA-MM-DD (padrão: hoje)'), vencimento: s('AAAA-MM-DD (padrão: a própria data)'),
      categoria: s('Categoria (veja listar_cadastros); se faltar, o painel sugere'), centro: s('Centro de custo'),
      contraparte: s('Fornecedor ou cliente'), cnpj: s('CNPJ/CPF da contraparte'), documento: s('Nº do documento/nota'),
      pago: b('true se já foi pago/recebido (padrão: true quando a data é hoje ou passada)'), pago_em: s('Data do pagamento AAAA-MM-DD'),
      forma: s('Forma de pagamento', { enum: FORMAS }), repetir_meses: n('Repetir por N meses, 2 a 24 (cria os seguintes como pendentes)') } } },
  { name: 'registrar_nota_entrada', title: 'Registrar nota de entrada (fornecedor)', annotations: ESCRITA,
    description: 'Registra a nota fiscal de um fornecedor como gasto. Aceita os campos lidos de uma foto/PDF da nota ou o XML da NF-e/NFS-e (campo xml), que é lido no servidor. Recusa nota repetida (mesma chave ou mesmo nº + CNPJ), a não ser com permitir_repetida.',
    inputSchema: { type: 'object', properties: {
      xml: s('Conteúdo XML da NF-e, NFC-e ou NFS-e (opcional; preenche os demais campos)'),
      fornecedor: s('Razão social do emitente'), cnpj: s('CNPJ/CPF do emitente'), numero: s('Nº da nota'),
      data_emissao: s('AAAA-MM-DD'), valor_total: n('Valor total da nota'), vencimento: s('AAAA-MM-DD, se for a pagar'),
      chave_acesso: s('Chave de 44 dígitos'), descricao: s('O que foi comprado'), categoria: s('Categoria de saída'), centro: s('Centro de custo'),
      pago: b('true se já foi paga (padrão: true sem vencimento futuro)'), forma: s('Forma de pagamento', { enum: FORMAS }),
      permitir_repetida: b('Registrar mesmo se parecer repetida') } } },
  { name: 'emitir_nfse', title: 'Emitir NFS-e (nota de saída)', annotations: ESCRITA,
    description: 'Gera uma NFS-e de serviço da GM para um tomador e lança o valor líquido em "a receber". Use simular=true primeiro para mostrar o cálculo (ISS, retenções, líquido) sem gravar. Informe cliente_id OU os dados do tomador; servico_id preenche código, descrição, valor e alíquota do catálogo.',
    inputSchema: { type: 'object', properties: {
      simular: b('true para só calcular e mostrar a prévia, sem emitir'),
      cliente_id: s('Id de um cliente cadastrado (listar_cadastros)'), tomador_nome: s('Nome/razão social do tomador'), tomador_doc: s('CPF ou CNPJ do tomador'),
      tomador_email: s('E-mail do tomador'), tomador_municipio: s('Município'), tomador_uf: s('UF'), tomador_endereco: s('Endereço'),
      salvar_cliente: b('Salvar o tomador novo nos clientes (padrão true)'),
      servico_id: s('Id de um serviço do catálogo'), codigo_servico: s('Item da LC 116, ex.: 17.01'), cnae: s('CNAE'), descricao: s('Discriminação do serviço'),
      valor: n('Valor do serviço'), aliquota_iss: n('Alíquota do ISS em %'), iss_retido: b('ISS retido pelo tomador'),
      retencoes: { type: 'object', description: 'Retenções federais que o tomador faz, em % sobre o valor. Ex.: {"ir":1.5,"pis":0.65,"cofins":3,"csll":1}. Use true para a alíquota padrão.',
        properties: Object.fromEntries(Object.entries(RET).map(([k, [nome, p]]) => [k, { type: ['number', 'boolean'], description: `${nome} (padrão ${p}%)` }])) },
      deducoes: n('Deduções'), desconto: n('Desconto incondicionado'), competencia: s('AAAA-MM-DD (padrão: 1º dia do mês)'), vencimento: s('Vencimento do recebimento AAAA-MM-DD'),
      observacoes: s('Informações complementares') } } },
  { name: 'listar_notas', title: 'Listar notas fiscais', annotations: SO_LEITURA,
    description: 'Notas de saída (NFS-e emitidas, pela data de emissão) ou de entrada (notas de fornecedores registradas como gasto).',
    inputSchema: { type: 'object', required: ['tipo'], properties: { tipo: s('saida = NFS-e emitidas; entrada = notas de fornecedores', { enum: ['saida', 'entrada'] }), ...PERIODO, busca: s('Tomador/fornecedor, CNPJ ou número'), limite: n('Máximo de itens (padrão 50)') } } },
  { name: 'ver_nfse', title: 'Ver NFS-e e XML', annotations: SO_LEITURA,
    description: 'Detalhes de uma NFS-e emitida pelo número, com o XML no layout DPS da NFS-e Nacional (sem assinatura).',
    inputSchema: { type: 'object', required: ['numero'], properties: { numero: n('Número da NFS-e'), com_xml: b('Incluir o XML (padrão true)') } } },
  { name: 'cancelar_nfse', title: 'Cancelar NFS-e', annotations: { ...ESCRITA, destructiveHint: true },
    description: 'Marca a NFS-e como cancelada e remove o "a receber" ligado a ela. Confirme com o usuário antes.',
    inputSchema: { type: 'object', required: ['numero'], properties: { numero: n('Número da NFS-e'), motivo: s('Motivo do cancelamento') } } },
  { name: 'dar_baixa', title: 'Dar baixa (pagar/receber)', annotations: ESCRITA,
    description: 'Marca lançamentos como pagos/recebidos. Informe ids (de listar_lancamentos) ou numero_nfse para receber uma nota emitida.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Ids dos lançamentos' }, numero_nfse: n('Receber a NFS-e com este número'),
      data: s('Data do pagamento AAAA-MM-DD (padrão: hoje)'), forma: s('Forma', { enum: FORMAS }), valor: n('Valor efetivamente pago (só com um lançamento; juros/desconto)') } } },
  { name: 'desfazer_baixa', title: 'Desfazer baixa', annotations: ESCRITA,
    description: 'Volta um lançamento pago para pendente.', inputSchema: { type: 'object', required: ['id'], properties: { id: s('Id do lançamento') } } },
  { name: 'excluir_lancamento', title: 'Excluir lançamento', annotations: { ...ESCRITA, destructiveHint: true },
    description: 'Exclui um lançamento. Confirme com o usuário antes.', inputSchema: { type: 'object', required: ['id'], properties: { id: s('Id do lançamento') } } },
  { name: 'fluxo_caixa', title: 'Fluxo de caixa', annotations: SO_LEITURA,
    description: 'Entradas, saídas e saldo acumulado por dia ou por mês. realizado = só o que já foi baixado; previsto = inclui pendentes pelo vencimento.',
    inputSchema: { type: 'object', properties: { ...PERIODO, modo: s('realizado ou previsto (padrão realizado)', { enum: ['realizado', 'previsto'] }), agrupar: s('dia ou mes (padrão: dia até 62 dias, senão mês)', { enum: ['dia', 'mes'] }) } } },
  { name: 'custos_por_categoria', title: 'Custos por categoria', annotations: SO_LEITURA,
    description: 'Saídas do período por categoria, centro de custo e fornecedor, com comparação ao período anterior de mesmo tamanho.',
    inputSchema: { type: 'object', properties: { ...PERIODO } } },
  { name: 'listar_cadastros', title: 'Cadastros', annotations: SO_LEITURA,
    description: 'Dados da empresa (prestador), clientes, catálogo de serviços, categorias e centros de custo.', inputSchema: { type: 'object', properties: {} } },
  { name: 'salvar_cliente', title: 'Salvar cliente', annotations: ESCRITA,
    description: 'Cria ou atualiza (com id) um cliente/tomador.',
    inputSchema: { type: 'object', required: ['nome'], properties: { id: s('Id para atualizar'), nome: s('Nome/razão social'), doc: s('CPF/CNPJ'), email: s('E-mail'), municipio: s('Município'), uf: s('UF'), endereco: s('Endereço'), servico_id: s('Serviço padrão'), valor: n('Valor padrão') } } },
  { name: 'salvar_servico', title: 'Salvar serviço', annotations: ESCRITA,
    description: 'Cria ou atualiza (com id) um serviço do catálogo usado na emissão.',
    inputSchema: { type: 'object', required: ['nome', 'codigo'], properties: { id: s('Id para atualizar'), nome: s('Nome curto'), codigo: s('Item da LC 116'), cnae: s('CNAE'), descricao: s('Discriminação padrão'), valor: n('Valor padrão'), aliquota_iss: n('Alíquota ISS %'), mensal: b('Cobrança mensal recorrente') } } },
  { name: 'atualizar_empresa', title: 'Atualizar dados da empresa', annotations: ESCRITA,
    description: 'Atualiza os dados do prestador usados nas notas (razão social, CNPJ, inscrição municipal, regime, endereço, ISS padrão, série, próximo número, saldo inicial do caixa, prazo de recebimento).',
    inputSchema: { type: 'object', properties: { razao: s('Razão social'), fantasia: s('Nome fantasia'), cnpj: s('CNPJ'), im: s('Inscrição municipal'), regime: s('Regime', { enum: ['simples', 'presumido', 'real', 'mei'] }),
      endereco: s('Endereço'), cep: s('CEP'), municipio: s('Município'), uf: s('UF'), ibge: s('Código IBGE do município'), email: s('E-mail'), fone: s('Telefone'),
      aliqISS: n('ISS padrão %'), serie: s('Série'), proxNum: n('Próximo número de nota'), saldoInicial: n('Saldo inicial do caixa'), prazo: n('Prazo de recebimento em dias'), obs: s('Informações complementares padrão') } } },
  // usadas pelo painel publicado no claude.ai (artifact) para ler e gravar estes mesmos dados
  { name: 'painel_revisao', title: 'Revisão dos dados (painel)', annotations: SO_LEITURA,
    description: 'Uso interno do painel no claude.ai: número da revisão atual dos dados. Não use na conversa.', inputSchema: { type: 'object', properties: {} } },
  { name: 'painel_obter', title: 'Obter dados (painel)', annotations: SO_LEITURA,
    description: 'Uso interno do painel no claude.ai: todos os dados do painel com a revisão. Não use na conversa; prefira as outras ferramentas.', inputSchema: { type: 'object', properties: {} } },
  { name: 'painel_salvar', title: 'Salvar dados (painel)', annotations: { ...ESCRITA, destructiveHint: true },
    description: 'Uso interno do painel no claude.ai: grava todos os dados do painel se a revisão base ainda for a atual. Nunca use na conversa.',
    inputSchema: { type: 'object', required: ['dados'], properties: { dados: { type: 'object', description: 'Estado completo do painel' }, rev: { type: ['number', 'null'], description: 'Revisão de onde a página partiu' } } } },
];

// ---------------- execução ----------------
class ErroUso extends Error {}
const falha = (m) => { throw new ErroUso(m); };
function periodo(a) {
  const H = hoje();
  const de = a.de || iniMes(H), ate = a.ate || fimMes(H);
  if (!dataValida(de) || !dataValida(ate)) falha('Datas no formato AAAA-MM-DD.');
  return de <= ate ? [de, ate] : [ate, de];
}
const resumoLanc = (l) => ({ id: l.id, tipo: l.tipo, data: l.data, vencimento: l.venc, descricao: l.descricao, contraparte: l.contraparte || '', documento: l.doc || '', categoria: l.categoria, centro: l.centro, valor: l.valor, situacao: situacao(l), pago_em: l.pagoEm || '', forma: l.status === 'pago' ? l.forma : '', origem: l.origem || 'manual' });
const resumoNota = (db, nota) => ({ numero: nota.numero, serie: nota.serie, emissao: nota.emissao, competencia: nota.competencia, vencimento: nota.venc, tomador: nota.toma.nome, tomador_doc: nota.toma.doc, codigo_servico: nota.codigo, descricao: nota.descricao, valor: nota.valor, base_calculo: nota.base, aliquota_iss: nota.aliq, iss: nota.iss, iss_retido: nota.issRetido, retencoes: nota.ret, total_retencoes: nota.totalRet, valor_liquido: nota.liquido, situacao: statusNota(db, nota), codigo_verificacao: nota.codVerif });
const agrupar = (lista, f) => { const m = new Map(); for (const l of lista) { const k = f(l) || '—'; m.set(k, (m.get(k) || 0) + l.valor); } return [...m].map(([k, v]) => ({ nome: k, valor: r2(v) })).sort((a, b) => b.valor - a.valor); };
const notaEntrada = (l) => l.tipo === 'saida' && l.origem !== 'nfse' && (l.doc || l.chave || ['ocr', 'xml', 'mcp-nota'].includes(l.origem));

function montarWizard(db, a) {
  const e = db.empresa;
  const w = { toma: {}, ret: {}, origem: 'mcp' };
  if (a.cliente_id) {
    const c = db.clientes.find((x) => x.id === a.cliente_id) || falha(`Cliente ${a.cliente_id} não encontrado. Veja listar_cadastros.`);
    w.clienteId = c.id; w.toma = { nome: c.nome, doc: c.doc, email: c.email, municipio: c.municipio, uf: c.uf, endereco: c.endereco || '' };
    if (!a.servico_id && c.servicoId) a = { servico_id: c.servicoId, valor: a.valor ?? (c.valor || undefined), ...a };
  }
  for (const [k, campo] of [['tomador_nome', 'nome'], ['tomador_doc', 'doc'], ['tomador_email', 'email'], ['tomador_municipio', 'municipio'], ['tomador_uf', 'uf'], ['tomador_endereco', 'endereco']]) if (a[k] != null) w.toma[campo] = String(a[k]);
  w.toma.doc = soDig(w.toma.doc); w.toma.municipio = w.toma.municipio || e.municipio; w.toma.uf = (w.toma.uf || e.uf || '').toUpperCase(); w.toma.email = w.toma.email || ''; w.toma.endereco = w.toma.endereco || '';
  if (!w.toma.nome) falha('Informe cliente_id ou tomador_nome.');
  if (w.toma.doc && ![11, 14].includes(w.toma.doc.length)) falha('CPF/CNPJ do tomador incompleto.');
  if (!w.clienteId) { const igual = db.clientes.find((c) => (w.toma.doc && soDig(c.doc) === w.toma.doc) || c.nome.toLowerCase() === w.toma.nome.toLowerCase()); if (igual) w.clienteId = igual.id; }
  let sv = null;
  if (a.servico_id) sv = db.servicos.find((x) => x.id === a.servico_id) || falha(`Serviço ${a.servico_id} não encontrado. Veja listar_cadastros.`);
  w.servicoId = sv?.id || null;
  w.codigo = a.codigo_servico || sv?.codigo || ''; w.cnae = a.cnae || sv?.cnae || ''; w.descricao = a.descricao || sv?.descricao || '';
  w.valor = a.valor ?? sv?.valor ?? 0; w.aliq = a.aliquota_iss ?? sv?.aliq ?? e.aliqISS;
  w.deducoes = a.deducoes || 0; w.desconto = a.desconto || 0; w.issRetido = !!a.iss_retido; w.obs = a.observacoes ?? e.obs ?? '';
  for (const [k, v] of Object.entries(a.retencoes || {})) { if (!RET[k] || v === false || v == null) continue; w.ret[k] = v === true ? RET[k][1] : Number(v); }
  if (!w.codigo) falha('Falta o código do serviço (item da LC 116, ex.: 17.01) ou um servico_id.');
  if (!w.descricao) falha('Falta a discriminação do serviço.');
  if (!(lerValor(w.valor) > 0)) falha('Falta o valor do serviço.');
  if (a.competencia && !dataValida(a.competencia)) falha('competencia em AAAA-MM-DD.');
  if (a.vencimento && !dataValida(a.vencimento)) falha('vencimento em AAAA-MM-DD.');
  w.competencia = a.competencia ? iniMes(a.competencia) : iniMes(hoje());
  w.venc = a.vencimento || somaDias(hoje(), Number(e.prazo) || 15);
  return w;
}

function executar(guarda, nome, a = {}) {
  const ler = () => guarda.ler()?.dados || baseVazia();
  switch (nome) {
    case 'resumo_financeiro': {
      const db = ler(); const [de, ate] = periodo(a); const H = hoje();
      const L = db.lanc.filter((l) => l.data >= de && l.data <= ate); const t = totais(L);
      const notas = db.notas.filter((x) => x.emissao >= de && x.emissao <= ate && x.status !== 'cancelada');
      const pend = (tipo) => db.lanc.filter((l) => l.tipo === tipo && l.status !== 'pago' && (l.venc || l.data) <= ate);
      const atr = (tipo) => db.lanc.filter((l) => l.tipo === tipo && situacao(l) === 'atrasado');
      const soma = (ls) => r2(ls.reduce((x, l) => x + l.valor, 0));
      const saldo = saldoCaixaAte(db, ate < H ? ate : H);
      return { periodo: { de, ate }, ...t, resultado: r2(t.entradas - t.saidas), margem_pct: t.entradas ? r2(((t.entradas - t.saidas) / t.entradas) * 100) : null,
        saldo_caixa: saldo, a_receber: soma(pend('entrada')), a_pagar: soma(pend('saida')), saldo_projetado: r2(saldo + soma(pend('entrada')) - soma(pend('saida'))),
        atrasados: { a_receber: { quantidade: atr('entrada').length, valor: soma(atr('entrada')) }, a_pagar: { quantidade: atr('saida').length, valor: soma(atr('saida')) } },
        nfse_emitidas: { quantidade: notas.length, valor: r2(notas.reduce((x, k) => x + k.valor, 0)), iss: r2(notas.reduce((x, k) => x + k.iss, 0)) },
        dados_de_exemplo: !!db.demo };
    }
    case 'listar_lancamentos': {
      const db = ler(); const [de, ate] = periodo(a); const q = (a.busca || '').toLowerCase();
      const L = db.lanc.filter((l) => l.data >= de && l.data <= ate && (!a.tipo || l.tipo === a.tipo) && (!a.situacao || situacao(l) === a.situacao || (a.situacao === 'pendente' && situacao(l) === 'atrasado'))
        && (!q || [l.descricao, l.contraparte, l.doc, l.categoria, l.centro].join(' ').toLowerCase().includes(q))).sort((x, y) => y.data.localeCompare(x.data));
      return { periodo: { de, ate }, total: L.length, ...totais(L), itens: L.slice(0, a.limite || 50).map(resumoLanc) };
    }
    case 'registrar_lancamento': return guarda.alterar((db) => {
      if (!['entrada', 'saida'].includes(a.tipo)) falha('tipo deve ser entrada ou saida.');
      const valor = r2(lerValor(a.valor)); if (!(valor > 0)) falha('valor deve ser maior que zero.');
      const data = a.data || hoje(); if (!dataValida(data)) falha('data em AAAA-MM-DD.');
      const venc = a.vencimento || data; if (!dataValida(venc)) falha('vencimento em AAAA-MM-DD.');
      const cats = db.categorias[a.tipo];
      const categoria = a.categoria && cats.includes(a.categoria) ? a.categoria : a.tipo === 'saida' ? sugerirCategoria(`${a.descricao} ${a.contraparte || ''}`, cats) : (a.categoria || cats[0]);
      if (a.categoria && !cats.includes(a.categoria) && a.tipo === 'saida') cats.splice(cats.length - 1, 0, a.categoria);
      const pago = a.pago ?? (venc <= hoje());
      const reg = { id: uid(), tipo: a.tipo, data, venc, descricao: String(a.descricao), categoria: a.categoria && a.tipo === 'saida' ? a.categoria : categoria,
        centro: a.centro || (a.tipo === 'entrada' ? 'Projetos' : 'Administrativo'), contraparte: a.contraparte || '', cnpj: soDig(a.cnpj), doc: a.documento || '', valor,
        status: pago ? 'pago' : 'pendente', pagoEm: pago ? (a.pago_em || (venc <= hoje() ? venc : hoje())) : '', forma: a.forma || 'Pix', origem: 'mcp' };
      if (a.centro && !db.centros.includes(a.centro)) db.centros.push(a.centro);
      const rep = Math.min(24, Math.max(0, Math.floor(a.repetir_meses || 0)));
      const criados = [reg];
      if (rep > 1) { reg.descricao += ` (1/${rep})`; for (let i = 1; i < rep; i++) criados.push({ ...reg, id: uid(), data: somaMeses(data, i), venc: somaMeses(venc, i), status: 'pendente', pagoEm: '', descricao: `${a.descricao} (${i + 1}/${rep})` }); }
      db.lanc.push(...criados);
      return { registrado: criados.map(resumoLanc), mensagem: `${criados.length} lançamento(s) de ${a.tipo} registrados · ${brl(valor)}${rep > 1 ? ' por mês' : ''}` };
    });
    case 'registrar_nota_entrada': return guarda.alterar((db) => {
      const x = a.xml ? lerXmlNota(String(a.xml)) : {};
      const c = { ...x, ...Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== 'xml' && v != null && v !== '')) };
      const valor = r2(lerValor(c.valor_total)); if (!(valor > 0)) falha('Falta o valor total da nota (ou um XML válido).');
      if (!c.fornecedor) falha('Falta o fornecedor (emitente).');
      const data = c.data_emissao || hoje(); if (!dataValida(data)) falha('data_emissao em AAAA-MM-DD.');
      if (c.vencimento && !dataValida(c.vencimento)) falha('vencimento em AAAA-MM-DD.');
      const cnpj = soDig(c.cnpj), chave = soDig(c.chave_acesso), numero = String(c.numero || '').replace(/^0+/, '');
      const dup = db.lanc.find((l) => l.tipo === 'saida' && ((chave && l.chave === chave) || (numero && cnpj && l.doc === numero && soDig(l.cnpj) === cnpj)));
      if (dup && !a.permitir_repetida) falha(`Esta nota parece já registrada: "${dup.descricao}", ${brl(dup.valor)} em ${dup.data} (id ${dup.id}). Use permitir_repetida=true se for outra.`);
      const cats = db.categorias.saida;
      const categoria = c.categoria && cats.includes(c.categoria) ? c.categoria : sugerirCategoria(`${c.fornecedor} ${c.descricao || ''}`, cats);
      const venc = c.vencimento || data;
      const pago = a.pago ?? !(c.vencimento && c.vencimento > hoje());
      const reg = { id: uid(), tipo: 'saida', data, venc, descricao: c.descricao ? `${c.descricao} · ${c.fornecedor}` : `Nota ${numero || ''} · ${c.fornecedor}`.replace('  ', ' '),
        categoria, centro: c.centro || 'Administrativo', contraparte: c.fornecedor, cnpj, doc: numero, chave, valor,
        status: pago ? 'pago' : 'pendente', pagoEm: pago ? data : '', forma: c.forma || 'Pix', origem: a.xml ? 'xml' : 'mcp-nota' };
      db.lanc.push(reg);
      return { registrado: resumoLanc(reg), lido_do_xml: a.xml ? x : undefined, mensagem: `Nota de entrada de ${c.fornecedor} registrada · ${brl(valor)} · ${categoria} · ${pago ? 'paga' : 'a pagar até ' + venc}` };
    });
    case 'emitir_nfse': {
      if (a.simular) {
        const db = ler(); const w = montarWizard(db, a); const c = calcNota(w);
        return { simulacao: true, proximo_numero: db.empresa.proxNum, tomador: w.toma, cliente_existente: !!w.clienteId, codigo_servico: w.codigo, descricao: w.descricao, competencia: w.competencia, vencimento: w.venc,
          valor: c.valor, deducoes: c.deducoes, desconto: c.desconto, base_calculo: c.base, aliquota_iss: c.aliq, iss: c.iss, iss_retido: w.issRetido, retencoes: c.ret, total_retencoes: c.totalRet, valor_liquido: c.liquido,
          avisos: [!db.empresa.cnpj && 'O CNPJ do prestador não está preenchido (use atualizar_empresa).', db.demo && 'O painel ainda tem dados de exemplo.'].filter(Boolean) };
      }
      return guarda.alterar((db) => {
        const w = montarWizard(db, a);
        if (!w.clienteId && a.salvar_cliente !== false) { const cl = { id: uid(), nome: w.toma.nome, doc: w.toma.doc, email: w.toma.email, municipio: w.toma.municipio, uf: w.toma.uf, endereco: w.toma.endereco, servicoId: w.servicoId, valor: lerValor(w.valor) }; db.clientes.push(cl); w.clienteId = cl.id; }
        const nota = criarNotaObj(db, w);
        return { emitida: resumoNota(db, nota), mensagem: `NFS-e nº ${nota.numero} gerada para ${nota.toma.nome} · ${brl(nota.valor)} (líquido ${brl(nota.liquido)}), a receber até ${nota.venc}. Sem validade fiscal até ser assinada e transmitida.` };
      });
    }
    case 'listar_notas': {
      const db = ler(); const [de, ate] = periodo(a); const q = (a.busca || '').toLowerCase();
      if (a.tipo === 'saida') {
        const ns = db.notas.filter((x) => x.emissao >= de && x.emissao <= ate && (!q || `${x.numero} ${x.toma.nome} ${x.toma.doc}`.toLowerCase().includes(q))).sort((x, y) => y.numero - x.numero);
        const val = ns.filter((x) => x.status !== 'cancelada');
        return { periodo: { de, ate }, tipo: 'saida', total: ns.length, valor_validas: r2(val.reduce((s2, x) => s2 + x.valor, 0)), iss: r2(val.reduce((s2, x) => s2 + x.iss, 0)), itens: ns.slice(0, a.limite || 50).map((x) => resumoNota(db, x)) };
      }
      const L = db.lanc.filter((l) => notaEntrada(l) && l.data >= de && l.data <= ate && (!q || `${l.contraparte} ${l.cnpj} ${l.doc} ${l.descricao}`.toLowerCase().includes(q))).sort((x, y) => y.data.localeCompare(x.data));
      return { periodo: { de, ate }, tipo: 'entrada', total: L.length, valor: r2(L.reduce((s2, l) => s2 + l.valor, 0)), itens: L.slice(0, a.limite || 50).map((l) => ({ ...resumoLanc(l), cnpj: l.cnpj || '', chave_acesso: l.chave || '' })) };
    }
    case 'ver_nfse': {
      const db = ler(); const nota = db.notas.find((x) => x.numero === Number(a.numero)) || falha(`NFS-e nº ${a.numero} não encontrada.`);
      return { ...resumoNota(db, nota), tomador_completo: nota.toma, prestador: nota.prest, observacoes: nota.obs, xml: a.com_xml === false ? undefined : xmlNota(nota, db.empresa) };
    }
    case 'cancelar_nfse': return guarda.alterar((db) => {
      const nota = db.notas.find((x) => x.numero === Number(a.numero)) || falha(`NFS-e nº ${a.numero} não encontrada.`);
      if (nota.status === 'cancelada') falha(`A NFS-e nº ${nota.numero} já está cancelada.`);
      const removidos = db.lanc.filter((l) => l.notaId === nota.id);
      nota.status = 'cancelada'; nota.canceladaEm = new Date().toISOString(); nota.motivoCancelamento = a.motivo || '';
      db.lanc = db.lanc.filter((l) => l.notaId !== nota.id);
      return { mensagem: `NFS-e nº ${nota.numero} cancelada; ${removidos.length} lançamento(s) ligado(s) a ela removido(s).` };
    });
    case 'dar_baixa': return guarda.alterar((db) => {
      let alvos = [];
      if (a.numero_nfse != null) { const nota = db.notas.find((x) => x.numero === Number(a.numero_nfse)) || falha(`NFS-e nº ${a.numero_nfse} não encontrada.`); alvos = db.lanc.filter((l) => l.id === nota.lancId); }
      for (const id of a.ids || []) { const l = db.lanc.find((x) => x.id === id) || falha(`Lançamento ${id} não encontrado.`); alvos.push(l); }
      if (!alvos.length) falha('Informe ids ou numero_nfse.');
      const data = a.data || hoje(); if (!dataValida(data)) falha('data em AAAA-MM-DD.');
      for (const l of alvos) { l.status = 'pago'; l.pagoEm = data; if (a.forma) l.forma = a.forma; if (a.valor && alvos.length === 1) l.valor = r2(lerValor(a.valor)); }
      return { baixados: alvos.map(resumoLanc), mensagem: `Baixa em ${alvos.length} lançamento(s) em ${data}.` };
    });
    case 'desfazer_baixa': return guarda.alterar((db) => {
      const l = db.lanc.find((x) => x.id === a.id) || falha(`Lançamento ${a.id} não encontrado.`);
      l.status = 'pendente'; l.pagoEm = '';
      return { lancamento: resumoLanc(l) };
    });
    case 'excluir_lancamento': return guarda.alterar((db) => {
      const l = db.lanc.find((x) => x.id === a.id) || falha(`Lançamento ${a.id} não encontrado.`);
      db.lanc = db.lanc.filter((x) => x.id !== a.id);
      return { excluido: resumoLanc(l) };
    });
    case 'fluxo_caixa': {
      const db = ler(); const [de, ate] = periodo(a); const modo = a.modo === 'previsto' ? 'previsto' : 'realizado';
      const mensal = a.agrupar ? a.agrupar === 'mes' : (Date.parse(ate) - Date.parse(de)) / 864e5 > 62;
      const quando = (l) => (l.status === 'pago' ? l.pagoEm || l.data : modo === 'previsto' ? l.venc || l.data : null);
      let saldo = lerValor(db.empresa.saldoInicial); const mapa = new Map();
      if (mensal) for (let m = iniMes(de); m <= ate; m = somaMeses(m, 1)) mapa.set(m.slice(0, 7), { entradas: 0, saidas: 0 });
      else for (let d = de; d <= ate; d = somaDias(d, 1)) mapa.set(d, { entradas: 0, saidas: 0 });
      for (const l of db.lanc) { const d = quando(l); if (!d) continue; const v = l.tipo === 'entrada' ? l.valor : -l.valor; if (d < de) { saldo += v; continue; } if (d > ate) continue; const bk = mapa.get(mensal ? d.slice(0, 7) : d); if (bk) bk[v > 0 ? 'entradas' : 'saidas'] += Math.abs(v); }
      const inicial = r2(saldo);
      const serie = [...mapa].map(([k, v]) => { saldo += v.entradas - v.saidas; return { [mensal ? 'mes' : 'dia']: k, entradas: r2(v.entradas), saidas: r2(v.saidas), saldo: r2(saldo) }; }).filter((x) => mensal || x.entradas || x.saidas);
      return { periodo: { de, ate }, modo, agrupado_por: mensal ? 'mes' : 'dia', saldo_inicial: inicial, saldo_final: r2(saldo), serie };
    }
    case 'custos_por_categoria': {
      const db = ler(); const [de, ate] = periodo(a);
      const dias = Math.round((Date.parse(ate) - Date.parse(de)) / 864e5) + 1; const aAte = somaDias(de, -1), aDe = somaDias(aAte, -(dias - 1));
      const S = db.lanc.filter((l) => l.tipo === 'saida' && l.data >= de && l.data <= ate), SA = db.lanc.filter((l) => l.tipo === 'saida' && l.data >= aDe && l.data <= aAte);
      const rec = db.lanc.filter((l) => l.tipo === 'entrada' && l.data >= de && l.data <= ate).reduce((x, l) => x + l.valor, 0);
      const tot = S.reduce((x, l) => x + l.valor, 0); const ant = new Map(agrupar(SA, (l) => l.categoria).map((x) => [x.nome, x.valor]));
      return { periodo: { de, ate }, periodo_anterior: { de: aDe, ate: aAte }, custo_total: r2(tot), custo_anterior: r2(SA.reduce((x, l) => x + l.valor, 0)), receita: r2(rec), custo_sobre_receita_pct: rec ? r2((tot / rec) * 100) : null,
        por_categoria: agrupar(S, (l) => l.categoria).map((c) => ({ ...c, pct: tot ? r2((c.valor / tot) * 100) : 0, anterior: r2(ant.get(c.nome) || 0) })),
        por_centro: agrupar(S, (l) => l.centro), maiores_fornecedores: agrupar(S, (l) => l.contraparte).slice(0, 10) };
    }
    case 'listar_cadastros': {
      const db = ler();
      return { empresa: db.empresa, clientes: db.clientes.map((c) => ({ id: c.id, nome: c.nome, doc: c.doc, email: c.email, municipio: c.municipio, uf: c.uf, servico_id: c.servicoId || null, valor: c.valor || 0 })),
        servicos: db.servicos.map((x) => ({ id: x.id, nome: x.nome, codigo: x.codigo, cnae: x.cnae, descricao: x.descricao, valor: x.valor, aliquota_iss: x.aliq, mensal: !!x.recorrente })),
        categorias: db.categorias, centros: db.centros, formas_pagamento: FORMAS, dados_de_exemplo: !!db.demo };
    }
    case 'salvar_cliente': return guarda.alterar((db) => {
      const doc = soDig(a.doc); if (doc && ![11, 14].includes(doc.length)) falha('CPF/CNPJ incompleto.');
      const campos = { nome: a.nome, ...(a.doc != null && { doc }), ...(a.email != null && { email: a.email }), ...(a.municipio != null && { municipio: a.municipio }), ...(a.uf != null && { uf: String(a.uf).toUpperCase() }), ...(a.endereco != null && { endereco: a.endereco }), ...(a.servico_id != null && { servicoId: a.servico_id }), ...(a.valor != null && { valor: lerValor(a.valor) }) };
      if (a.id) { const c = db.clientes.find((x) => x.id === a.id) || falha(`Cliente ${a.id} não encontrado.`); Object.assign(c, campos); return { cliente: c }; }
      const c = { id: uid(), doc: '', email: '', municipio: db.empresa.municipio, uf: db.empresa.uf, endereco: '', ...campos }; db.clientes.push(c); return { cliente: c };
    });
    case 'salvar_servico': return guarda.alterar((db) => {
      const campos = { nome: a.nome, codigo: a.codigo, ...(a.cnae != null && { cnae: a.cnae }), ...(a.descricao != null && { descricao: a.descricao }), ...(a.valor != null && { valor: lerValor(a.valor) }), ...(a.aliquota_iss != null && { aliq: lerValor(a.aliquota_iss) }), ...(a.mensal != null && { recorrente: !!a.mensal }) };
      if (a.id) { const x = db.servicos.find((y) => y.id === a.id) || falha(`Serviço ${a.id} não encontrado.`); Object.assign(x, campos); return { servico: x }; }
      const x = { id: uid(), cnae: '', descricao: a.nome, valor: 0, aliq: db.empresa.aliqISS, recorrente: false, ...campos }; db.servicos.push(x); return { servico: x };
    });
    case 'atualizar_empresa': return guarda.alterar((db) => {
      const e = db.empresa;
      for (const [k, v] of Object.entries(a)) { if (!(k in e) || v == null) continue; e[k] = ['aliqISS', 'saldoInicial'].includes(k) ? lerValor(v) : ['proxNum', 'prazo'].includes(k) ? Math.max(1, Math.floor(Number(v))) : k === 'cnpj' ? soDig(v) : k === 'uf' ? String(v).toUpperCase() : String(v); }
      if (e.cnpj && e.cnpj.length !== 14) falha('CNPJ deve ter 14 dígitos.');
      return { empresa: e };
    });
    case 'painel_revisao': { const at = guarda.ler(); return { rev: at ? at.dados.rev : null, salvoEm: at?.salvoEm || null }; }
    case 'painel_obter': { const at = guarda.ler(); return at ? { existe: true, rev: at.dados.rev, salvoEm: at.salvoEm, dados: at.dados } : { existe: false, rev: null, dados: null }; }
    case 'painel_salvar': {
      if (!a.dados || typeof a.dados !== 'object' || !Array.isArray(a.dados.lanc) || !Array.isArray(a.dados.notas)) falha('dados inválidos: faltam lanc/notas.');
      return guarda.substituir(a.dados, a.rev).then((r) => { if (r.conflito) falha(`conflito: os dados mudaram (revisão ${r.rev}). Recarregue.`); return { ok: true, rev: r.rev, salvoEm: new Date().toISOString() }; });
    }
    default: falha(`Ferramenta desconhecida: ${nome}`);
  }
}

// ---------------- protocolo (JSON-RPC 2.0) ----------------
const resposta = (id, result) => ({ jsonrpc: '2.0', id, result });
const erroRpc = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function tratarMensagem(guarda, msg, log = () => {}) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return erroRpc(msg?.id, -32600, 'Requisição inválida');
  const { id, method, params = {} } = msg;
  const notificacao = id === undefined;
  switch (method) {
    case 'initialize': {
      const pedida = params.protocolVersion;
      log('mcp initialize', `${params.clientInfo?.name || '?'} ${params.clientInfo?.version || ''}`.trim(), pedida || '');
      return resposta(id, { protocolVersion: VERSAO_PROTOCOLO.includes(pedida) ? pedida : VERSAO_PROTOCOLO[0], capabilities: { tools: { listChanged: false } }, serverInfo: INFO, instructions: INSTRUCOES });
    }
    case 'ping': return resposta(id, {});
    case 'tools/list': log('mcp tools/list'); return resposta(id, { tools: FERRAMENTAS });
    case 'tools/call': {
      const nome = params.name; const args = params.arguments || {};
      if (!FERRAMENTAS.some((f) => f.name === nome)) return erroRpc(id, -32602, `Ferramenta desconhecida: ${nome}`);
      try {
        const r = await executar(guarda, nome, args);
        log('mcp', nome);
        return resposta(id, { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }], structuredContent: r, isError: false });
      } catch (e) {
        if (!(e instanceof ErroUso)) log('mcp erro', nome, e.stack || e.message);
        return resposta(id, { content: [{ type: 'text', text: e instanceof ErroUso ? e.message : `Erro interno: ${e.message}` }], isError: true });
      }
    }
    default:
      if (notificacao || method.startsWith('notifications/')) return null;
      if (method === 'resources/list') return resposta(id, { resources: [] });
      if (method === 'prompts/list') return resposta(id, { prompts: [] });
      return erroRpc(id, -32601, `Método não suportado: ${method}`);
  }
}

export const FERRAMENTAS_MCP = FERRAMENTAS;
