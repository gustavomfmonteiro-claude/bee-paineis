// Envio do template de WhatsApp pelo GHL (LeadConnector API v2), acionado pelo botão do painel.
// A API não envia template aprovado direto: `templateId` com o ID do Meta volta 422. O envio é
// aplicar uma tag no contato; o Workflow "Painel Radar - alocar" do GHL ouve a tag e manda o template.
// O telefone nunca vem do navegador: server.mjs entrega aqui o entregador lido da API da Bee.
import crypto from 'node:crypto';
import fs from 'node:fs';

const HORA_MS = 60 * 60e3, INTERVALO_STATUS_MS = 4000;
// Recusa do Meta (limite de marketing por pessoa): o automático não gasta nova mensagem com ele por um tempo
const RECUSA_MS = 6 * HORA_MS;
// Por quanto tempo depois de vencer a oferta o painel ainda lê a conversa, para o "Sim" não ficar sem resposta
const LEITURA_TARDIA_MS = 20 * 60e3;
const FOLGA_PAUSA_MS = 5000;
// Campos do contato que o template alocar_detalhes lê
const CAMPOS = { loja: 'contact.bee__loja', origem: 'contact.bee__endereco_origem', destino: 'contact.bee__endereco_destino', distancia: 'contact.bee__distancia_km', valor: 'contact.bee__valor_entregador' };
// O Meta recusa variável com quebra de linha, tabulação ou 4+ espaços seguidos
const limpa = (s, max = 150) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || '-';
const virgula = (n) => n.toFixed(2).replace('.', ',');
export const camposDoTemplate = (d) => ({
  loja: limpa(d.loja, 80), origem: limpa(d.origem), destino: limpa(d.destino),
  distancia: (d.distanciaM / 1000).toFixed(1).replace('.', ','),
  valor: virgula(d.valorCentavos / 100),
});
const nomeOferta = (o) => o.loja || 'a loja';
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

export class ErroEnvio extends Error {
  constructor(cod, mensagem) { super(mensagem); this.cod = cod; }
}

// A API da Bee traz o telefone em 5 formatos; devolve só DDD + número (10 ou 11 dígitos).
export function normalizaTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}
// O GHL guarda muitos contatos sem o 9 depois do DDD; a busca precisa tentar as duas formas.
export function variantesTelefone(d) {
  if (d.length === 11 && d[2] === '9') return ['+55' + d, '+55' + d.slice(0, 2) + d.slice(3)];
  if (d.length === 10) return ['+55' + d, '+55' + d.slice(0, 2) + '9' + d.slice(2)];
  return ['+55' + d];
}
const tituloNome = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
export function separaNome(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: tituloNome(partes[0] || 'Entregador'), lastName: partes.slice(1).map(tituloNome).join(' ') };
}

export function criarEnvio({ base = 'https://services.leadconnectorhq.com', pit, locationId, tag, arquivo, arquivoOfertas, chaveWebhook, validadeOfertaMs = 5 * 60e3, respostaTardiaMs = 20 * 60e3, limiteAbertas = 3, blocoPorEntrega = 10, pausaBlocoMs = 2 * 60e3, porRodada = 3, pausaAposAtribuirMs = 15 * 60e3, limiteHora = 60, esperaStatusMs = 24000, intervaloStatusMs = INTERVALO_STATUS_MS, log = () => {} }) {
  const ativo = !!(pit && locationId && tag);
  const enviados = new Set(), emAndamento = new Set(), pedidosEmAtribuicao = new Set();
  const entregadoresEmEnvio = new Set(), tentativas = new Map(), jaTentados = new Set(), recusadosAte = new Map();
  let ofertas = {}, idsCampos = null, pausadoAte = 0, conferindoTardias = false;
  const conversasLidas = new Map(), ultimoEnvio = new Map();
  // A cada `blocoPorEntrega` mensagens a entrega descansa `pausaBlocoMs`, contados da última mensagem do
  // bloco, e depois segue para os entregadores que ainda não receberam. A folga evita que a variação de
  // 1 ou 2 s entre as leituras do alerta, que rodam de minuto em minuto, transforme 2 min em 3.
  const retomaEm = (pedido) => {
    const p = String(pedido), n = tentativas.get(p) || 0;
    if (!n || n % blocoPorEntrega) return 0;
    const fim = (ultimoEnvio.get(p) || 0) + pausaBlocoMs;
    return Date.now() < fim - FOLGA_PAUSA_MS ? fim : 0;
  };
  // O Workflow espera o botão por 5 min e ignora nova entrada enquanto isso: uma segunda oferta
  // nesse intervalo não sairia, e o "Sim" da primeira cairia na oferta errada.
  // Quem acabou de receber uma entrega também fica um tempo sem ofertas, mesmo se a devolver.
  const ofertaAberta = (id) => Object.values(ofertas).some((o) => String(o.entregador) === String(id) && (
    (['aberta', 'processando'].includes(o.estado) && Date.now() < Date.parse(o.expira) + 60e3) ||
    (o.atribuidaEm && Date.now() < Date.parse(o.atribuidaEm) + pausaAposAtribuirMs)
  ));
  if (arquivoOfertas) { try { ofertas = JSON.parse(fs.readFileSync(arquivoOfertas, 'utf8')); } catch {} }
  // A oferta é gravada antes da tag e o log só depois da confirmação (até 24 s): sem isto, reiniciar
  // o servidor nesse intervalo faria o mesmo entregador receber a mesma entrega de novo.
  for (const o of Object.values(ofertas)) if (o.estado !== 'falhou') jaTentados.add(o.pedido + ':' + o.entregador);
  const salvaOfertas = () => {
    if (!arquivoOfertas) return;
    for (const [c, o] of Object.entries(ofertas)) if (Date.now() - Date.parse(o.em) > 24 * HORA_MS) delete ofertas[c];
    try { fs.writeFileSync(arquivoOfertas, JSON.stringify(ofertas)); } catch (e) { log('whatsapp: ofertas nao salvas', e.message); }
  };
  let envios = [];
  if (arquivo) {
    try {
      for (const l of fs.readFileSync(arquivo, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        const r = JSON.parse(l);
        // `tag: false` = parou antes de acionar o Workflow, nenhuma mensagem saiu
        if (r.tag !== false) {
          const p = String(r.pedido);
          tentativas.set(p, (tentativas.get(p) || 0) + 1);
          ultimoEnvio.set(p, Math.max(ultimoEnvio.get(p) || 0, Date.parse(r.em)));
          jaTentados.add(r.pedido + ':' + r.entregador);
        }
        if (r.tag && r.status === 'failed') recusadosAte.set(String(r.entregador), Date.parse(r.em) + RECUSA_MS);
        if (r.status !== 'failed') { enviados.add(r.pedido + ':' + r.entregador); envios.push(Date.parse(r.em)); }
      }
    } catch {}
  }
  const chave = (pedido, id) => pedido + ':' + id;

  async function ghl(caminho, versao, opcoes = {}) {
    const r = await fetch(base + caminho, {
      ...opcoes,
      headers: { Authorization: 'Bearer ' + pit, Version: versao, Accept: 'application/json', ...(opcoes.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(20e3),
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch {}
    if (!r.ok) throw new ErroEnvio(r.status === 401 || r.status === 403 ? 'token' : 'ghl', `GHL respondeu ${r.status} em ${caminho.split('?')[0]}: ${String(json?.message || texto).slice(0, 160)}`);
    return json;
  }

  async function contatoDe(entregador, digitos) {
    const { firstName, lastName } = separaNome(entregador.nome);
    for (const numero of variantesTelefone(digitos)) {
      const j = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&number=${encodeURIComponent(numero)}`, '2021-07-28');
      const c = j?.contact;
      if (c?.id) {
        // O cabeçalho do template usa o primeiro nome e tem limite de 60 caracteres: sem nome ou
        // com o nome completo nesse campo, o Meta recusa. Só nesses casos o contato é ajustado.
        const atual = String(c.firstName || '').trim();
        if (!atual) await ghl('/contacts/' + c.id, '2021-07-28', { method: 'PUT', body: JSON.stringify({ firstName, lastName }) });
        else if (/\s/.test(atual)) await ghl('/contacts/' + c.id, '2021-07-28', { method: 'PUT', body: JSON.stringify({ firstName: tituloNome(atual.split(/\s+/)[0]) }) });
        return c.id;
      }
    }
    const novo = await ghl('/contacts/', '2021-07-28', { method: 'POST', body: JSON.stringify({ locationId, firstName, lastName, phone: variantesTelefone(digitos)[0], source: 'Painel Radar' }) });
    if (!novo?.contact?.id) throw new ErroEnvio('ghl', 'O GHL não devolveu o contato criado.');
    return novo.contact.id;
  }

  async function gravaCampos(contactId, valores) {
    if (!idsCampos) {
      const j = await ghl(`/locations/${encodeURIComponent(locationId)}/customFields?model=contact`, '2021-07-28');
      idsCampos = Object.fromEntries((j?.customFields || []).map((c) => [c.fieldKey, c.id]));
    }
    const customFields = Object.entries(CAMPOS).map(([k, chave]) => {
      if (!idsCampos[chave]) throw new ErroEnvio('ghl', 'Campo não encontrado no GHL: ' + chave);
      return { id: idsCampos[chave], field_value: valores[k] };
    });
    await ghl('/contacts/' + contactId, '2021-07-28', { method: 'PUT', body: JSON.stringify({ customFields }) });
  }
  const responde = (contactId, message) => ghl('/conversations/messages', '2021-04-15', { method: 'POST', body: JSON.stringify({ type: 'WhatsApp', contactId, message }) })
    .catch((e) => log('whatsapp: resposta ao entregador falhou', e.message));

  // O Workflow roda depois da resposta da tag e não devolve o id da mensagem: procura na conversa
  // do contato a mensagem de saída criada a partir de agora. O Meta recusa segundos depois.
  async function acompanhar(contactId, desde) {
    const limite = Date.now() + esperaStatusMs;
    let ultima = null;
    while (Date.now() < limite) {
      await dorme(intervaloStatusMs);
      try {
        const s = await ghl(`/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=1`, '2021-04-15');
        const conv = s?.conversations?.[0]?.id;
        if (!conv) continue;
        const j = await ghl(`/conversations/${conv}/messages?limit=5`, '2021-04-15');
        const lista = j?.messages?.messages || [];
        const m = lista.find((x) => x.direction === 'outbound' && x.messageType === 'TYPE_WHATSAPP' && Date.parse(x.dateAdded) >= desde - 2000);
        if (m) {
          ultima = m;
          if (m.status === 'failed' || ['sent', 'delivered', 'read'].includes(m.status)) return m;
        }
      } catch (e) { log('whatsapp: leitura de status falhou', e.message); }
    }
    return ultima;
  }

  return {
    ativo,
    // null = nunca recebeu esta entrega; 'falhou' = o WhatsApp recusou, e também não recebe de novo
    situacao(pedido, id) {
      const k = chave(pedido, id);
      if (emAndamento.has(k)) return 'enviando';
      if (enviados.has(k)) return 'enviado';
      return jaTentados.has(k) ? 'falhou' : null;
    },

    webhookAtivo: !!chaveWebhook,
    tentativas: (pedido) => tentativas.get(String(pedido)) || 0,
    retomaEm,

    // Uma rodada por leitura do alerta: até `porRodada` entregadores disponíveis mais próximos por entrega,
    // sem passar do fim do bloco. Entrega em pausa fica de fora; entrega que sai do alerta sai da rodada seguinte.
    // `limiteDe(entrega)` diz em quantos minutos de busca a entrega passa a receber ofertas.
    async rodadaAuto(alertas, { proximos, detalhe, limiteDe = () => 5 }) {
      if (Date.now() < pausadoAte) return 0;
      const agora = Date.now();
      const lista = alertas.filter((x) => x.origem && !x.agendado && x.desdeIso && agora - Date.parse(x.desdeIso) >= limiteDe(x) * 60e3).sort((a, b) => a.desdeIso.localeCompare(b.desdeIso));
      let disparados = 0;
      for (const x of lista) {
        const restam = blocoPorEntrega - (tentativas.get(String(x.id)) || 0) % blocoPorEntrega;
        const dados = detalhe(x.id);
        if (retomaEm(x.id) || !dados) continue;
        const { lista: perto } = await proximos(x.origem);
        const escolhidos = perto.filter((e) => !e.emEntrega && normalizaTelefone(e.telefone) && !jaTentados.has(x.id + ':' + e.id) && !enviados.has(chave(x.id, e.id)) && !entregadoresEmEnvio.has(String(e.id)) && !ofertaAberta(e.id) && !((recusadosAte.get(String(e.id)) || 0) > agora)).slice(0, Math.min(restam, porRodada));
        for (const e of escolhidos) {
          disparados++;
          // não espera a confirmação de entrega (até 24 s): a rodada não pode segurar a leitura do alerta
          this.enviar(x.id, e, dados).catch((erro) => {
            if (erro?.cod === 'token' || erro?.cod === 'ghl') { pausadoAte = Date.now() + 5 * 60e3; log('whatsapp auto: pausado por 5 min,', erro.message); }
            else if (erro?.cod === 'limite') { pausadoAte = Date.now() + 60e3; log('whatsapp auto:', erro.message); }
            else log('whatsapp auto:', x.id, e.id, erro?.message);
          });
        }
      }
      return disparados;
    },
    // Depois do prazo do Workflow o "SIm" chega na conversa, mas não aciona o
    // webhook. Uma busca por leitura do alerta acha quem escreveu depois de vencer a oferta, e só essas
    // conversas são lidas. Vale só o texto exato do botão: texto livre ("bota") não atribui entrega.
    // `responder` decide: passado `respostaTardiaMs`, só avisa que expirou; antes disso, só atribui se o
    // pedido ainda estiver em Buscando.
    async respostasTardias(bee) {
      if (conferindoTardias) return 0;
      const agora = Date.now();
      const pendentes = Object.entries(ofertas).filter(([, o]) => o.estado === 'aberta' && agora > Date.parse(o.expira) && agora <= Date.parse(o.expira) + LEITURA_TARDIA_MS);
      if (!pendentes.length) return 0;
      conferindoTardias = true;
      try {
        const j = await ghl(`/conversations/search?locationId=${encodeURIComponent(locationId)}&sortBy=last_message_date&sort=desc&limit=100`, '2021-04-15');
        const conversas = new Map((j?.conversations || []).map((c) => [c.contactId, c]));
        const respostas = [];
        for (const [contactId, o] of pendentes) {
          const c = conversas.get(contactId);
          const ultima = new Date(c?.lastMessageDate).getTime();
          if (!(ultima >= Date.parse(o.em)) || conversasLidas.get(contactId) === ultima) continue;
          const m = await ghl(`/conversations/${c.id}/messages?limit=10`, '2021-04-15');
          conversasLidas.set(contactId, ultima);
          const botao = (m?.messages?.messages || [])
            .filter((x) => x.direction === 'inbound' && Date.parse(x.dateAdded) >= Date.parse(o.em))
            .map((x) => ({ contactId, em: Date.parse(x.dateAdded), resposta: String(x.body || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase() }))
            .filter((x) => x.resposta === 'sim' || x.resposta === 'nao')
            .sort((a, b) => b.em - a.em)[0]; // vale o último toque
          if (botao) respostas.push(botao);
        }
        // quem respondeu primeiro fica com a entrega
        for (const r of respostas.sort((a, b) => a.em - b.em)) {
          log('whatsapp resposta tardia:', r.contactId, r.resposta);
          await this.responder(r.contactId, r.resposta, bee);
        }
        return respostas.length;
      } finally {
        conferindoTardias = false;
      }
    },
    confereChave(tentativa) {
      if (!chaveWebhook) return false;
      const a = crypto.createHash('sha256').update(String(tentativa ?? '')).digest();
      const b = crypto.createHash('sha256').update(String(chaveWebhook)).digest();
      return crypto.timingSafeEqual(a, b);
    },

    // Resposta do botão do template. bee = { lerPedido, entregasAbertas, atribuirEntrega }.
    async responder(contactId, resposta, bee) {
      const o = ofertas[contactId];
      const reg = (resultado, extra = '') => log('whatsapp resposta:', contactId, resposta, o?.pedido ?? '-', o?.entregador ?? '-', resultado, extra);
      if (!o) { reg('sem oferta'); if (resposta === 'sim') await responde(contactId, 'Não encontramos uma oferta de entrega ativa para você. Fique de olho nas próximas!'); return 'sem oferta'; }
      if (o.estado !== 'aberta') { reg('repetida', o.estado); return 'repetida'; } // reenvio do webhook ou segundo toque
      if (resposta === 'nao') { o.estado = 'recusada'; salvaOfertas(); reg('recusada'); return 'recusada'; }
      const encerra = async (estado, msg, extra) => { o.estado = estado; salvaOfertas(); reg(estado, extra); await responde(contactId, msg); return estado; };
      if (Date.now() > Date.parse(o.expira) + respostaTardiaMs) return encerra('expirada', 'Esta oferta de entrega já expirou. Obrigado pelo retorno!');
      if (pedidosEmAtribuicao.has(o.pedido)) return encerra('outro', 'Outro entregador já ficou com esta entrega. Obrigado pelo retorno!');
      pedidosEmAtribuicao.add(o.pedido);
      o.estado = 'processando';
      salvaOfertas();
      try {
        const p = await bee.lerPedido(o.pedido);
        if (p.status !== '10' || p.entregador) return await encerra('outro', 'Outro entregador já ficou com esta entrega. Obrigado pelo retorno!', 'status ' + p.status);
        const abertas = await bee.entregasAbertas(o.entregador);
        if (abertas >= limiteAbertas) return await encerra('limite', 'Você já está com muitas entregas em andamento, então esta não foi atribuída. Conclua as atuais para receber novas.', abertas + ' abertas');
        let r = null, erro = null;
        try { r = await bee.atribuirEntrega(o.pedido, o.merchantId, o.entregador); } catch (e) { erro = e.message; }
        const depois = await bee.lerPedido(o.pedido);
        if (Number(depois.entregador) === Number(o.entregador)) o.atribuidaEm = new Date().toISOString();
        if (o.atribuidaEm) return await encerra('atribuida', `Entrega #${o.pedido} atribuída a você! Vá até ${nomeOferta(o)} e confira os detalhes no aplicativo da Bee.`, 'http ' + (r?.http ?? '-'));
        if (depois.entregador || depois.status !== '10') return await encerra('outro', 'Outro entregador já ficou com esta entrega. Obrigado pelo retorno!', 'status ' + depois.status);
        return await encerra('falha', 'Não conseguimos atribuir esta entrega agora. Nossa equipe vai verificar.', erro || `http ${r?.http} ${r?.mensagem}`);
      } catch (e) {
        return await encerra('falha', 'Não conseguimos atribuir esta entrega agora. Nossa equipe vai verificar.', e.message);
      } finally {
        pedidosEmAtribuicao.delete(o.pedido);
      }
    },

    async enviar(pedido, entregador, dados) {
      if (!dados || !/^[1-9]\d*$/.test(String(dados.merchantId))) throw new ErroEnvio('ghl', 'Os dados desta entrega não estão disponíveis agora. Tente de novo em instantes.');
      const k = chave(pedido, entregador.id);
      const digitos = normalizaTelefone(entregador.telefone);
      if (!digitos) throw new ErroEnvio('telefone', 'A API da Bee não trouxe um telefone válido para este entregador.');
      if (emAndamento.has(k)) throw new ErroEnvio('repetido', 'Este envio já está em andamento.');
      if (enviados.has(k) || jaTentados.has(k)) throw new ErroEnvio('repetido', 'Este entregador já recebeu a mensagem desta entrega.');
      const pid = String(pedido), idEnt = String(entregador.id);
      const retoma = retomaEm(pid);
      if (retoma) throw new ErroEnvio('pausa', `Esta entrega está em pausa depois de ${tentativas.get(pid)} mensagens. O envio volta às ${new Date(retoma).toLocaleTimeString('pt-BR', { timeZone: 'America/Fortaleza' })}.`);
      if (entregadoresEmEnvio.has(idEnt) || ofertaAberta(entregador.id)) throw new ErroEnvio('ocupado', 'Este entregador recebeu uma oferta ou uma entrega há pouco. Tente de novo em alguns minutos.');
      envios = envios.filter((t) => Date.now() - t < HORA_MS);
      if (envios.length >= limiteHora) throw new ErroEnvio('limite', `Limite de ${limiteHora} envios por hora atingido.`);
      emAndamento.add(k);
      entregadoresEmEnvio.add(idEnt);
      jaTentados.add(pedido + ':' + entregador.id);
      tentativas.set(pid, (tentativas.get(pid) || 0) + 1);
      const marca = Date.now();
      ultimoEnvio.set(pid, marca);
      envios.push(marca);
      const registro = { em: new Date(marca).toISOString(), pedido, entregador: entregador.id, messageId: null, status: 'erro', erro: null, tag: false };
      let contactId = null;
      try {
        contactId = await contatoDe(entregador, digitos);
        // preenche o que o template lê e guarda a oferta antes da tag: o "Sim" pode chegar a qualquer momento
        await gravaCampos(contactId, camposDoTemplate(dados));
        ofertas[contactId] = { pedido, entregador: entregador.id, merchantId: dados.merchantId, loja: dados.loja, em: new Date(marca).toISOString(), expira: new Date(marca + validadeOfertaMs).toISOString(), estado: 'aberta' };
        salvaOfertas();
        // remove antes de reaplicar: só uma tag nova gera o evento que aciona o Workflow
        await ghl(`/contacts/${contactId}/tags`, '2021-07-28', { method: 'DELETE', body: JSON.stringify({ tags: [tag] }) });
        await ghl(`/contacts/${contactId}/tags`, '2021-07-28', { method: 'POST', body: JSON.stringify({ tags: [tag] }) });
        registro.status = 'tag aplicada';
        registro.tag = true;
        const m = await acompanhar(contactId, marca);
        if (m) {
          registro.messageId = m.id || null;
          registro.status = m.status || 'sem status';
          if (m.error) registro.erro = String(m.error).slice(0, 200);
        }
        if (registro.status === 'failed') throw new ErroEnvio('recusado', 'O WhatsApp recusou a entrega' + (registro.erro ? ': ' + registro.erro : '.'));
        enviados.add(k);
        return { status: registro.status, confirmado: !!m };
      } catch (e) {
        if (!registro.erro) registro.erro = String(e?.message || e).slice(0, 200);
        registro.status = 'failed';
        envios = envios.filter((t) => t !== marca);
        if (!registro.tag) { tentativas.set(pid, Math.max(0, (tentativas.get(pid) || 1) - 1)); jaTentados.delete(pedido + ':' + entregador.id); }
        if (e?.cod === 'recusado') recusadosAte.set(idEnt, Date.now() + RECUSA_MS);
        if (contactId && ofertas[contactId]?.pedido === pedido && ofertas[contactId].estado === 'aberta') { ofertas[contactId].estado = 'falhou'; salvaOfertas(); }
        throw e instanceof ErroEnvio ? e : new ErroEnvio('ghl', 'Não foi possível falar com o GHL agora.');
      } finally {
        emAndamento.delete(k);
        entregadoresEmEnvio.delete(idEnt);
        log('whatsapp:', registro.pedido, registro.entregador, registro.status, registro.erro || '');
        if (arquivo) { try { fs.appendFileSync(arquivo, JSON.stringify(registro) + '\n'); } catch (e) { log('whatsapp: log falhou', e.message); } }
      }
    },
  };
}
