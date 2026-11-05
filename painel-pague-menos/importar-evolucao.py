# Roda uma vez na VPS: copia do Painel de Evolução o histórico de Pague Menos e Extrafarma desde 01/01/2026
# para cache/evolucao-base.json. Só contagens por loja e dia; o outro painel é apenas lido. Daí em diante
# este painel soma os dias que ele mesmo fecha. Depois de rodar: docker restart painel-pague-menos
# Uso: ssh bee-vps python3 - < importar-evolucao.py
import glob
import json
import os
import re

ORIGEM = '/opt/painel-evolucao/cache'
DESTINO = '/opt/painel-pague-menos/cache/evolucao-base.json'
GRUPO = re.compile('PAGUE MENOS|EXTRAFARMA', re.I)

cad = json.load(open(os.path.join(ORIGEM, 'lojas.json'), encoding='utf-8'))
nomes = {i: re.sub(r'\s+', ' ', x['n']).strip() for i, x in cad.items() if x.get('n') and GRUPO.search(x['n'])}
dias = {}
for arq in sorted(glob.glob(os.path.join(ORIGEM, 'dias', '*.json'))):
    d = json.load(open(arq, encoding='utf-8'))
    if not d.get('fechado'):
        continue
    # vetor do outro painel: [demanda, finalizadas, canceladas, pontos, demanda das 23h]
    lojas = {i: v[:3] for i, v in d['lojas'].items() if i in nomes}
    if lojas:
        dias[d['dia']] = lojas
tmp = DESTINO + '.tmp'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump({'dias': dias, 'nomes': nomes}, f, ensure_ascii=False, separators=(',', ':'))
os.replace(tmp, DESTINO)
print('dias', len(dias), min(dias), '->', max(dias), '· lojas', len(nomes), '· pedidos', sum(v[0] for d in dias.values() for v in d.values()), '· bytes', os.path.getsize(DESTINO))
