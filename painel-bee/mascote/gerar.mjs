import { writeFileSync } from 'node:fs';
const OUT = process.argv[2];
const K = '#111008', Y = '#FFD200', Y2 = '#F2B800', W = '#FFFFFF', WING = '#E6F6FF', PINK = '#FF8A8A', KRAFT = '#E3A857';
const sw = 'stroke="' + K + '" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"';

const arm = (d, hand) => `
  <path d="${d}" fill="none" stroke="${K}" stroke-width="20" stroke-linecap="round"/>
  <path d="${d}" fill="none" stroke="${Y}" stroke-width="10" stroke-linecap="round"/>
  <circle cx="${hand[0]}" cy="${hand[1]}" r="12" fill="${Y}" ${sw}/>`;

const wings = (flap = 0) => `
  <g ${sw} fill="${WING}">
    <ellipse cx="72" cy="${132 - flap}" rx="40" ry="24" transform="rotate(${-32 - flap} 72 ${132 - flap})"/>
    <ellipse cx="188" cy="${132 - flap}" rx="40" ry="24" transform="rotate(${32 + flap} 188 ${132 - flap})"/>
    <path d="M60 128 Q74 122 90 130" fill="none" stroke-width="3" opacity=".5" transform="rotate(${-32 - flap} 72 ${132 - flap})"/>
    <path d="M170 130 Q186 122 200 128" fill="none" stroke-width="3" opacity=".5" transform="rotate(${32 + flap} 188 ${132 - flap})"/>
  </g>`;

const bag = `
  <g>
    <rect x="66" y="158" width="128" height="84" rx="16" fill="#1C1B18" ${sw}/>
    <rect x="66" y="158" width="128" height="16" rx="8" fill="#2A2922"/>
  </g>`;

const body = `
  <defs><clipPath id="cb"><ellipse cx="130" cy="206" rx="54" ry="50"/></clipPath></defs>
  <ellipse cx="130" cy="206" rx="54" ry="50" fill="${Y}"/>
  <g clip-path="url(#cb)" fill="${K}">
    <rect x="60" y="196" width="140" height="15"/>
    <rect x="60" y="226" width="140" height="15"/>
    <ellipse cx="112" cy="180" rx="16" ry="9" fill="#FFF3A6" opacity=".7"/>
  </g>
  <ellipse cx="130" cy="206" rx="54" ry="50" fill="none" ${sw}/>
  <!-- alças da mochila -->
  <path d="M96 168 Q92 200 100 238" fill="none" stroke="${K}" stroke-width="8" stroke-linecap="round"/>
  <path d="M164 168 Q168 200 160 238" fill="none" stroke="${K}" stroke-width="8" stroke-linecap="round"/>
  <path d="M124 250 L130 266 L136 250 Z" fill="${K}"/>`;

const legs = `
  <g>
    <path d="M112 248 V266" stroke="${K}" stroke-width="9" stroke-linecap="round"/>
    <path d="M148 248 V266" stroke="${K}" stroke-width="9" stroke-linecap="round"/>
    <path d="M96 272 Q96 260 112 262 Q124 263 124 272 Z" fill="${W}" ${sw}/>
    <path d="M136 272 Q136 263 148 262 Q164 260 164 272 Z" fill="${W}" ${sw}/>
    <path d="M100 268 H122 M138 268 H160" stroke="${Y}" stroke-width="3"/>
  </g>`;

const antennae = (tilt = 0) => `
  <g fill="none" stroke="${K}" stroke-width="5" stroke-linecap="round">
    <path d="M112 62 Q104 36 ${88 - tilt} 20"/>
    <path d="M148 62 Q156 36 ${172 + tilt} 20"/>
  </g>
  <circle cx="${88 - tilt}" cy="20" r="9" fill="${Y}" ${sw}/>
  <circle cx="${172 + tilt}" cy="20" r="9" fill="${Y}" ${sw}/>`;

const head = `
  <circle cx="130" cy="110" r="60" fill="${Y}" ${sw}/>
  <ellipse cx="104" cy="80" rx="14" ry="8" fill="#FFF3A6" opacity=".8" transform="rotate(-25 104 80)"/>`;

const cap = `
  <g>
    <path d="M73 100 C70 40 190 40 187 100 Q130 84 73 100 Z" fill="${K}" ${sw}/>
    <path d="M74 98 Q130 82 186 98" fill="none" stroke="${Y}" stroke-width="5"/>
    <path d="M64 102 Q130 80 200 100 Q206 108 198 110 Q130 94 66 112 Q58 108 64 102 Z" fill="#26251E" ${sw}/>
    <path d="M130 52 l12 7 v14 l-12 7 l-12 -7 v-14 Z" fill="${Y}" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>
    <text x="130" y="72" text-anchor="middle" font-family="'Open Sans','Segoe UI',sans-serif" font-style="italic" font-weight="700" font-size="15" fill="${K}">b</text>
  </g>`;

const eyesOpen = (dx = 0, dy = 0) => `
  <g>
    <ellipse cx="108" cy="126" rx="13" ry="16" fill="${W}" ${sw}/>
    <ellipse cx="152" cy="126" rx="13" ry="16" fill="${W}" ${sw}/>
    <circle cx="${109 + dx}" cy="${128 + dy}" r="8" fill="${K}"/>
    <circle cx="${153 + dx}" cy="${128 + dy}" r="8" fill="${K}"/>
    <circle cx="${112 + dx}" cy="${124 + dy}" r="3" fill="${W}"/>
    <circle cx="${156 + dx}" cy="${124 + dy}" r="3" fill="${W}"/>
  </g>`;
const eyesHappy = `
  <g fill="none" stroke="${K}" stroke-width="5" stroke-linecap="round">
    <path d="M96 130 Q108 114 120 130"/><path d="M140 130 Q152 114 164 130"/>
  </g>`;
const cheeks = `<ellipse cx="88" cy="148" rx="10" ry="6" fill="${PINK}" opacity=".75"/><ellipse cx="172" cy="148" rx="10" ry="6" fill="${PINK}" opacity=".75"/>`;
const smile = `<path d="M116 150 Q130 164 144 150" fill="none" stroke="${K}" stroke-width="5" stroke-linecap="round"/>`;
const bigSmile = `<path d="M112 146 Q130 148 148 146 Q146 170 130 170 Q114 170 112 146 Z" fill="#7A1F1F" ${sw}/><path d="M120 162 Q130 156 140 162 Q136 168 130 168 Q124 168 120 162 Z" fill="${PINK}"/>`;
const worriedMouth = `<path d="M118 158 Q124 151 130 156 Q136 161 142 154" fill="none" stroke="${K}" stroke-width="5" stroke-linecap="round"/>`;
const brows = `<g stroke="${K}" stroke-width="5" stroke-linecap="round"><path d="M96 104 L118 110"/><path d="M164 104 L142 110"/></g>`;
const worriedBrows = `<g stroke="${K}" stroke-width="5" stroke-linecap="round"><path d="M96 110 L118 102"/><path d="M164 110 L142 102"/></g>`;
const sweat = `<path d="M184 108 Q194 124 184 130 Q174 124 184 108 Z" fill="#7FD3FF" ${sw} stroke-width="3"/>`;

const box = (x, y, s = 1) => `
  <g transform="translate(${x} ${y}) scale(${s})">
    <rect x="0" y="0" width="44" height="36" rx="4" fill="${KRAFT}" ${sw}/>
    <path d="M0 11 H44" stroke="${K}" stroke-width="4"/>
    <rect x="17" y="0" width="10" height="36" fill="${Y}" stroke="${K}" stroke-width="3"/>
    <path d="M6 24 h8 M6 29 h5" stroke="${K}" stroke-width="2.5" stroke-linecap="round" opacity=".55"/>
  </g>`;

const clock = (x, y) => `
  <g transform="translate(${x} ${y})">
    <circle r="20" fill="${W}" ${sw}/>
    <path d="M0 -11 V0 L8 5" fill="none" stroke="#FF5F6D" stroke-width="4" stroke-linecap="round"/>
    <circle r="2.5" fill="${K}"/>
  </g>`;

const confetti = `
  <g>
    <rect x="30" y="40" width="10" height="5" rx="2" fill="#35D6EE" transform="rotate(30 35 42)"/>
    <rect x="214" y="52" width="10" height="5" rx="2" fill="#FF5F6D" transform="rotate(-20 219 54)"/>
    <rect x="42" y="96" width="9" height="5" rx="2" fill="#34E0A1" transform="rotate(-40 46 98)"/>
    <rect x="210" y="110" width="9" height="5" rx="2" fill="#9C8CFF" transform="rotate(50 214 112)"/>
    <circle cx="200" cy="22" r="4" fill="#34E0A1"/><circle cx="58" cy="16" r="4" fill="#FF9A3C"/>
    <path d="M226 84 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="${Y}" stroke="${K}" stroke-width="2"/>
    <path d="M24 70 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" fill="${Y}" stroke="${K}" stroke-width="2"/>
  </g>`;

const svg = (inner, label, vb = '0 0 260 284') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${label}">${inner}\n</svg>\n`;

const poses = {
  'zum-acenando': svg(
    wings() + bag + arm('M86 196 Q60 178 50 146', [48, 140]) + legs + body +
    arm('M174 202 Q190 212 198 210', [198, 210]) + box(194, 170, 1.1) + `<circle cx="198" cy="210" r="11" fill="${Y}" ${sw}/>` +
    antennae() + head + cap + brows + eyesOpen() + cheeks + smile,
    'Zum, mascote da bee Delivery, acenando com um pacote'),
  'zum-comemorando': svg(
    confetti + wings(8) + bag + arm('M88 192 Q62 168 52 128', [50, 122]) + arm('M172 192 Q198 168 208 128', [210, 122]) + legs + body +
    antennae(6) + head + cap + eyesHappy + cheeks + bigSmile,
    'Zum comemorando: entregas no prazo'),
  'zum-preocupado': svg(
    wings(-6) + bag + legs + body +
    arm('M88 200 Q76 220 92 232', [96, 232]) + clock(168, 222) + `<circle cx="150" cy="226" r="11" fill="${Y}" ${sw}/>` +
    antennae(-8) + head + cap + worriedBrows + eyesOpen(-2, 3) + cheeks + worriedMouth + sweat,
    'Zum preocupado: entregas atrasadas'),
  'zum-avatar': svg(
    `<circle cx="130" cy="110" r="100" fill="#F3F1E8" stroke="${K}" stroke-width="8"/>` + antennae() + head + cap + brows + eyesOpen() + cheeks + smile,
    'Zum, avatar', '26 6 208 208'),
};
for (const [n, s] of Object.entries(poses)) writeFileSync(`${OUT}/${n}.svg`, s);
console.log(Object.keys(poses).join(' '));
