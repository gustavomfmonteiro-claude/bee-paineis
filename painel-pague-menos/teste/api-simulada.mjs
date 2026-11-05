// API falsa da Bee para testar o painel sem tocar na produção. Gera pedidos com os mesmos campos da
// API real e confere, no fim, os números que o painel precisa chegar. Uso: node teste/api-simulada.mjs
import http from 'node:http';

const PORTA = 3071;
const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
const ontem = new Date(Date.parse(hoje + 'T12:00:00Z') - 86400e3).toISOString().slice(0, 10);
const iso = (dia, hhmm, somaMin = 0) => new Date(Date.parse(`${dia}T${hhmm}:00-03:00`) + somaMin * 60e3).toISOString();

const LOJAS = [[114197, '678 - PAGUE MENOS - MESSEJANA'], [145754, '7300 - EXTRAFARMA - PREFEITO JOSE WALTER'], [145862, '933 - PAGUE MENOS - CENTRO'], [93033, '1 - PAGUE MENOS - CENTRO'], [145798, '10 - PAGUE MENOS - BARRA DO CEARA'], [999, 'OUTRA FARMACIA - FORA DO GRUPO']];
const MOTIVOS = ['Tempo limite de 15 minutos para aceite', 'Cliente desistiu da compra', 'Demora do entregador', 'Produto não estava pronto', 'Aceite de outra transportadora', ''];
const ROTULOS = { 10: 'Buscando', 20: 'Indo a origem', 28: 'Liberado para entrega', 30: 'Indo ao destino', 35: 'Chegou no destino', 50: 'Finalizado', 60: 'Cancelado' };
const pedidos = [];
let id = 1000;
function pedido(dia, hhmm, [mid, nome], st, t = {}) {
  const c = iso(dia, hhmm);
  const d = { created_at: c };
  if (t.aceite != null) d.accepted_at = iso(dia, hhmm, t.aceite);
  if (t.p1 != null) d.arrival_at_origin = iso(dia, hhmm, t.p1);
  if (t.saida != null) d.departure_at_origin = iso(dia, hhmm, t.saida);
  if (t.p2 != null) d.arrival_at_destination = iso(dia, hhmm, t.saida + t.p2);
  if (t.canc != null) d.cancelled_at = iso(dia, hhmm, t.canc);
  pedidos.push({ id: ++id, status: st, status_label: ROTULOS[st], franchise: { id: 7, name: 'FORTALEZA/CE' }, merchant: { id: mid, name: nome }, created_at: c, searching: t.semBusca ? null : c, dates: d, customer_name: 'NAO GUARDAR', motivo: t.motivo,
    address_origin: nome + ' - Av Teste, 100', address_destination: 'Rua Sigilosa, 595 - Vila Peri, Fortaleza - CE, 60730135, BR', badges: { type: st === '10' ? 'Turbo60' : '0' },
    deliveryman: t.ent ? { id: t.ent, name: 'Entregador ' + t.ent, phone: 'NAO GUARDAR' } : null,
    waypoints: [{ type: 'pickup', position: 0, description: 'x', latitude: '-3.7300', longitude: '-38.5200' }, { type: 'delivery', position: 1, description: 'Rua Sigilosa, 595 - Vila Peri, Fortaleza - CE, 60730135, BR' }, ...(t.retorno ? [{ type: 'return', position: 2, description: 'x' }] : [])] });
}
for (const dia of [ontem, hoje]) {
  for (let i = 0; i < 12; i++) pedido(dia, `${String(8 + i).padStart(2, '0')}:10`, LOJAS[3], '50', { aceite: 2, p1: 10, saida: 14, p2: 9 });
  for (let i = 0; i < 12; i++) pedido(dia, `${String(8 + i).padStart(2, '0')}:20`, LOJAS[4], '50', { aceite: 8, p1: 25, saida: 28, p2: 25 });
  for (let i = 0; i < 6; i++) pedido(dia, `10:${String(i * 5).padStart(2, '0')}`, LOJAS[0], '60', { canc: 3, motivo: MOTIVOS[i % 3] });
  for (let i = 0; i < 4; i++) pedido(dia, `11:${String(i * 5).padStart(2, '0')}`, LOJAS[0], '50', { aceite: 3, p1: 12, saida: 15, p2: 11 });
  for (let i = 0; i < 3; i++) pedido(dia, `12:${String(i * 5).padStart(2, '0')}`, LOJAS[1], '60', { aceite: 4, p1: 9, canc: 20, motivo: MOTIVOS[3 + i] });
  pedido(dia, '13:00', LOJAS[2], '60', { aceite: 2, p1: 10, saida: 12, canc: 30, motivo: 'Entregador sofreu acidente <script>alert(1)</script>' });
  pedido(dia, '14:00', LOJAS[2], '30', { aceite: 2 });
  pedido(dia, '15:00', LOJAS[5], '50', { aceite: 1, p1: 5, saida: 6, p2: 5 });
  pedido(dia, '22:50', LOJAS[3], '50', { aceite: 1, p1: 5, saida: 6, p2: 5 }); // 01:50 UTC do dia seguinte: testa o fuso
  for (let i = 0; i < 5; i++) pedido(dia, '09:0' + i, LOJAS[2], '50', { aceite: 1, p1: 5, saida: 6, p2: 5, ent: i < 3 ? 11 : 22 });
  // integração que já nasce com entregador: sem busca, aceite no segundo da criação; não entra no aceite
  for (let i = 0; i < 3; i++) pedido(dia, '10:3' + i, LOJAS[0], '30', { aceite: 0, p1: 0, saida: 20, semBusca: true });
  for (let i = 0; i < 2; i++) pedido(dia, '09:1' + i, [146414, '7362 - EXTRAFARMA - TAMATANDUBA'], '50', { aceite: 1, p1: 5, saida: 6, p2: 5, ent: 33 });
}
// Buscando agora: uma há 7 min, com retorno, e outra recém-criada; a 1 min atrás fica em loja fora das prioritárias.
const horaLocal = (minAtras) => new Date(Date.now() - minAtras * 60e3).toLocaleTimeString('sv-SE', { timeZone: 'America/Fortaleza' }).slice(0, 5);
pedido(hoje, horaLocal(40), LOJAS[1], '30', { aceite: 2, p1: 9, saida: 25, ent: 44 });
pedido(hoje, horaLocal(12), LOJAS[2], '20', { aceite: 3, ent: 55, retorno: true });
pedido(hoje, horaLocal(7), LOJAS[0], '10', { retorno: true });
pedido(hoje, horaLocal(1), LOJAS[1], '10', {});
pedido(hoje, horaLocal(1), LOJAS[3], '10', {});
let chamadas = 0;
http.createServer((req, res) => {
  chamadas++;
  const u = new URL(req.url, 'http://x');
  const js = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/public/login') return js(200, { data: { token: 't' } });
  if (req.headers.authorization !== 'Bearer t') return js(401, {});
  if (u.pathname === '/api/orders') {
    const por = 20, pag = Number(u.searchParams.get('page'));
    // mesmos filtros da API real: lojas e status
    const lojas = [...u.searchParams.entries()].filter(([k]) => k.startsWith('filters[merchant][id][$in]')).map(([, v]) => v);
    const st = [...u.searchParams.entries()].filter(([k]) => k.startsWith('filters[status][$in]')).map(([, v]) => v);
    const base = pedidos.filter((p) => (!lojas.length || lojas.includes(String(p.merchant.id))) && (!st.length || st.includes(p.status)));
    const fatia = base.slice((pag - 1) * por, pag * por);
    return js(200, { data: fatia, links: { next: pag * por < base.length ? 'x' : null } });
  }
  // Um entregador a ~1 km, outro a ~2,5 km em entrega, outro a ~9 km e outro sem GPS
  if (u.pathname === '/api/dashboard') return js(200, { data: { online_deliverymen: {
    available: [{ id: 71, name: 'Fulano  De Tal Silva', phone: '85998470001', photo: 'NAO GUARDAR', latitude: -3.7390, longitude: -38.5200, vehicle_type: 'moto' }, { id: 72, name: 'Longe Demais', phone: 'NAO GUARDAR', latitude: -3.8100, longitude: -38.5200 }, { id: 74, name: 'Sem Gps', latitude: null, longitude: null }],
    in_delivery: [{ id: 73, name: 'Ciclana Souza Lima', phone: '(85) 99847-0002', latitude: -3.7525, longitude: -38.5200 }],
  } } });
  const m = u.pathname.match(/^\/api\/orders\/(\d+)$/);
  if (m) { const p = pedidos.find((x) => x.id === Number(m[1])); return p ? js(200, { data: { cancellation_reason: p.motivo || '' } }) : js(404, {}); }
  js(404, {});
}).listen(PORTA, () => {
  // Radar falso: o envio cai aqui e nunca sai do computador
  const envios = [];
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const js = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const buscando = pedidos.filter((p) => p.status === '10');
    if (u.pathname === '/envios') return js(200, envios);
    if (u.pathname === '/api/dados') return js(200, { 'live/alerta': { lista: buscando.map((p) => ({ id: p.id, whatsapp: 2, whatsappMax: 10 })) } });
    if (u.pathname === '/api/proximos') return buscando.some((p) => String(p.id) === u.searchParams.get('pedido')) ? js(200, { lista: [{ id: 71, whatsappEnviado: true }, { id: 73, whatsappEnviado: false }] }) : js(404, { erro: 'não está no alerta' });
    if (u.pathname === '/api/whatsapp' && req.method === 'POST') { let c = ''; req.on('data', (x) => { c += x; }); req.on('end', () => { envios.push(JSON.parse(c)); const d = JSON.parse(c); return d.entregador === 99 ? js(429, { erro: 'Limite de 60 envios por hora atingido.' }) : js(200, { status: 'delivered', confirmado: true }); }); return; }
    js(404, {});
  }).listen(PORTA + 1);
});
console.log(`API simulada em http://localhost:${PORTA}/api · ${pedidos.length} pedidos`);
