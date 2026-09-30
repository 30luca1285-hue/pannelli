// build-solar-html.mjs — genera data/solar.html (la copia dell'app servita dal Mac su /energia)
// partendo da index.html (quella pubblicata su GitHub Pages).
// Dal 30/09/2026 il motore dati è UNO SOLO, dentro index.html: legge solar.json dal Mac e salva sul Mac.
// Qui cambia soltanto l'indirizzo: la copia sul Mac usa percorsi relativi (MAC_BASE = ''), così non
// dipende dal nome Tailscale e funziona anche aperta da http://100.88.88.123:3001/energia/.
// Prima questo script sostituiva l'intero blocco con un motore suo: due copie della stessa logica,
// che infatti divergevano (la copia del Mac mostrava «N/A» come ora e il grafico spostato di 2 ore).
import fs from 'node:fs';
const DIR = '/Users/lucagalluzzi/Projects/Pannelli';
const src = fs.readFileSync(`${DIR}/index.html`, 'utf8');

const BASE = /const MAC_BASE = '[^']*';/;
if (!BASE.test(src)) { console.error('❌ riga MAC_BASE non trovata in index.html'); process.exit(1); }

let out = src.replace(BASE, "const MAC_BASE = '';   // copia servita dal Mac: percorsi relativi");
// il salvataggio bolletta/GSE va nel DB via endpoint per OGNI anno (non solo 2026)
out = out.replace('if (parseInt(yr) >= 2026) {', 'if (true) {');
fs.writeFileSync(`${DIR}/data/solar.html`, out);
console.log(`✅ data/solar.html generato (${out.length} byte). MAC_BASE -> percorsi relativi.`);
