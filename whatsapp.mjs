// Envio do template de WhatsApp pelo GHL (LeadConnector API v2), acionado pelo botão do painel.
// A API não envia template aprovado direto: `templateId` com o ID do Meta volta 422. O envio é
// aplicar uma tag no contato; o Workflow "Painel Radar - alocar" do GHL ouve a tag e manda o template.
// O telefone nunca vem do navegador: server.mjs entrega aqui o entregador lido da API da Bee.
import crypto from 'node:crypto';
import fs from 'node:fs';

const HORA_MS = 60 * 60e3, INTERVALO_STATUS_MS = 4000;
// Campos do contato que o template alocar_detalhes lê
const CAMPOS = { loja: 'contact.bee__loja', origem: 'contact.bee__endereco_origem', destino: 'contact.bee__endereco_destino', distancia: 'contact.bee__distancia_km', valor: 'contact.bee__valor_entregador' };
// O Meta recusa variável com quebra de linha, tabulação ou 4+ espaços seguidos
const limpa = (s, max = 150) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || '-';
const virgula = (n) => n.toFixed(2).replace('.', ',');
export const camposDoTemplate = (d) => ({
  loja: limpa(d.loja, 80), origem: limpa(d.origem), destino: limpa(d.destino, 80),
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

export function criarEnvio({ base = 'https://services.leadconnectorhq.com', pit, locationId, tag, arquivo, arquivoOfertas, chaveWebhook, validadeOfertaMs = 10 * 60e3, limiteAbertas = 3, limiteHora = 60, esperaStatusMs = 24000, intervaloStatusMs = INTERVALO_STATUS_MS, log = () => {} }) {
  const ativo = !!(pit && locationId && tag);
  const enviados = new Set(), emAndamento = new Set(), pedidosEmAtribuicao = new Set();
  let ofertas = {}, idsCampos = null;
  if (arquivoOfertas) { try { ofertas = JSON.parse(fs.readFileSync(arquivoOfertas, 'utf8')); } catch {} }
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
    jaEnviado: (pedido, id) => enviados.has(chave(pedido, id)),

    webhookAtivo: !!chaveWebhook,
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
      if (Date.now() > Date.parse(o.expira)) return encerra('expirada', 'Esta oferta de entrega já expirou. Obrigado pelo retorno!');
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
        if (Number(depois.entregador) === Number(o.entregador)) return await encerra('atribuida', `Entrega #${o.pedido} atribuída a você! Vá até ${nomeOferta(o)} e confira os detalhes no aplicativo da Bee.`, 'http ' + (r?.http ?? '-'));
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
      if (enviados.has(k)) throw new ErroEnvio('repetido', 'Este entregador já recebeu a mensagem desta entrega.');
      if (emAndamento.has(k)) throw new ErroEnvio('repetido', 'Este envio já está em andamento.');
      envios = envios.filter((t) => Date.now() - t < HORA_MS);
      if (envios.length >= limiteHora) throw new ErroEnvio('limite', `Limite de ${limiteHora} envios por hora atingido.`);
      emAndamento.add(k);
      const marca = Date.now();
      envios.push(marca);
      const registro = { em: new Date(marca).toISOString(), pedido, entregador: entregador.id, messageId: null, status: 'erro', erro: null };
      try {
        const contactId = await contatoDe(entregador, digitos);
        // preenche o que o template lê e guarda a oferta antes da tag: o "Sim" pode chegar a qualquer momento
        await gravaCampos(contactId, camposDoTemplate(dados));
        ofertas[contactId] = { pedido, entregador: entregador.id, merchantId: dados.merchantId, loja: dados.loja, em: new Date(marca).toISOString(), expira: new Date(marca + validadeOfertaMs).toISOString(), estado: 'aberta' };
        salvaOfertas();
        // remove antes de reaplicar: só uma tag nova gera o evento que aciona o Workflow
        await ghl(`/contacts/${contactId}/tags`, '2021-07-28', { method: 'DELETE', body: JSON.stringify({ tags: [tag] }) });
        await ghl(`/contacts/${contactId}/tags`, '2021-07-28', { method: 'POST', body: JSON.stringify({ tags: [tag] }) });
        registro.status = 'tag aplicada';
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
        throw e instanceof ErroEnvio ? e : new ErroEnvio('ghl', 'Não foi possível falar com o GHL agora.');
      } finally {
        emAndamento.delete(k);
        log('whatsapp:', registro.pedido, registro.entregador, registro.status, registro.erro || '');
        if (arquivo) { try { fs.appendFileSync(arquivo, JSON.stringify(registro) + '\n'); } catch (e) { log('whatsapp: log falhou', e.message); } }
      }
    },
  };
}
