/**
 * Riscrive il valore dell'autoconsumo 2024-2025 in `rawData` (index.html) usando le bollette VERE.
 *
 * PERCHÉ (11/09/2026). Le righe hardcoded valorizzavano l'autoconsumo a 0,1917 €/kWh nel 2024 e
 * 0,1997 nel 2025 — cioè la «quota per consumi» della bolletta, senza accisa erariale né IVA.
 * Ma non prelevando un kWh dalla rete quelle due voci si evitano anche loro: il valore giusto è il
 * COSTO MARGINALE, `(totale bolletta − fissi × 1,10) / kWh`, che sui 32 mesi scaricati sta fra
 * 0,2210 e 0,2933. Sottostima: **1.180 € su due anni**.
 * Stesso errore già corretto per il 2026 (dove il prezzo arriva dalla bolletta inserita).
 *
 * ✅ AGGIORNATO lo stesso giorno: anche 2022-2023 si correggono. Prima dell'01/01/2024 il fornitore
 *    non era Astea ma **FUTURA ENERGIE** (ricordato da Luca), e quelle bollette arrivavano **in
 *    allegato alle email**: 26 recuperate dalla casella con `HQ/scripts/scarica-bollette-futura.py`.
 * ⛔ Restano fuori **ottobre-dicembre 2023**: dal 01/09/2023 il contratto è stato ceduto a **TUA
 *    srl** e quelle bollette non sono in casella. Per quei mesi il valore cablato resta com'è.
 *
 * Uso:
 *   node ricalcola-storico-ammortamento.mjs          → mostra cosa cambierebbe, NON scrive
 *   node ricalcola-storico-ammortamento.mjs --scrivi  → riscrive rawData e la costante BASE
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const HTML = path.join(DIR, 'index.html');
const BOLLETTE = '/Users/lucagalluzzi/Projects/HQ/data/bollette-luce';
const LETTORE = '/Users/lucagalluzzi/Projects/HQ/scripts/leggi-bolletta-luce.py';
const LETTORE_FUTURA = '/Users/lucagalluzzi/Projects/HQ/scripts/leggi-bolletta-futura.py';
const scrivi = process.argv.includes('--scrivi');

// ── 1. i marginali veri, dalle bollette. Due fornitori, due lettori diversi.
const marginale = new Map();
const fonte = new Map();
const leggi = (script, file, etichetta) => {
  if (!file.length) return 0;
  const out = JSON.parse(execFileSync('python3', [script, '--json', ...file], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }));
  let n = 0;
  for (const b of [].concat(out)) {
    if (b.marginale && b.anno && b.mese) {
      marginale.set(`${b.anno}-${b.mese}`, b.marginale);
      fonte.set(`${b.anno}-${b.mese}`, etichetta);
      n++;
    }
  }
  return n;
};
const tutti = execFileSync('bash', ['-c', `ls -1 ${BOLLETTE}/*.pdf`], { encoding: 'utf8' }).trim().split('\n');
const nAstea = leggi(LETTORE, tutti.filter(f => f.includes('astea')), 'Astea');
const nFutura = leggi(LETTORE_FUTURA, tutti.filter(f => f.includes('futura')), 'Futura');
console.log(`marginali disponibili: ${nAstea} da Astea (2024→) · ${nFutura} da Futura (2021-2023)\n`);

// ── 2. le righe di rawData
const html = readFileSync(HTML, 'utf8');
const blocco = html.match(/const rawData = \[\n([\s\S]*?)\n\];/);
if (!blocco) { console.error('⛔ rawData non trovato in index.html: non tocco niente.'); process.exit(1); }

const righe = blocco[1].split('\n');
let sommaVecchia = 0, sommaNuova = 0, toccate = 0;
const nuove = righe.map(riga => {
  const m = riga.match(/^\s*\[(\d{4}),"(\w+)",(.*)\],?\s*$/);
  if (!m) return riga;
  const [, anno, mese, resto] = m;
  const campi = resto.split(',').map(Number);
  const autoconsumo = campi[4];            // d[6] nella riga completa
  const valoreVecchio = campi[5];          // d[7]
  sommaVecchia += valoreVecchio || 0;

  const p = marginale.get(`${anno}-${mese}`);
  if (!p || !autoconsumo) {
    sommaNuova += valoreVecchio || 0;
    return riga;                            // fuori portata: lasciata com'è
  }
  const valoreNuovo = Math.round(autoconsumo * p * 100) / 100;
  sommaNuova += valoreNuovo;
  toccate++;
  console.log(`  ${anno} ${mese.padEnd(10)} ${String(autoconsumo).padStart(5)} kWh · ` +
    `${(valoreVecchio / autoconsumo).toFixed(4)} → ${p.toFixed(4)} €/kWh · ` +
    `${valoreVecchio.toFixed(2)} → ${valoreNuovo.toFixed(2)} € ` +
    `[${fonte.get(`${anno}-${mese}`)}] ` +
    `(${valoreNuovo - valoreVecchio > 0 ? '+' : ''}${(valoreNuovo - valoreVecchio).toFixed(2)})`);

  campi[5] = valoreNuovo;
  campi[8] = p;                             // d[10], il prezzo mostrato in tabella
  return `[${anno},"${mese}",${campi.join(',')}],`;
});

// ── 3. la costante BASE: contiene Σd[7] più GSE e rimborsi una tantum, che non cambiano
const mBase = html.match(/const BASE = ([\d.]+);/);
const baseVecchia = Number(mBase[1]);
const nonAutoconsumo = baseVecchia - sommaVecchia;     // la parte che resta uguale
const baseNuova = Math.round((nonAutoconsumo + sommaNuova) * 1000) / 1000;

console.log(`\n  righe toccate: ${toccate}`);
console.log(`  autoconsumo storico: ${sommaVecchia.toFixed(2)} → ${sommaNuova.toFixed(2)} € ` +
  `(+${(sommaNuova - sommaVecchia).toFixed(2)})`);
console.log(`  GSE e rimborsi dentro BASE (invariati): ${nonAutoconsumo.toFixed(2)} €`);
console.log(`  BASE: ${baseVecchia} → ${baseNuova}`);
const INV = 24000;
console.log(`  recuperato solo-storico: ${(baseVecchia / INV * 100).toFixed(1)}% → ` +
  `${(baseNuova / INV * 100).toFixed(1)}% dell'investimento\n`);

if (!scrivi) { console.log('🔎 PROVA: non ho scritto niente. Rilancia con --scrivi.'); process.exit(0); }

if (sommaNuova < sommaVecchia) {
  console.error('⛔ il nuovo totale è MINORE del vecchio: qualcosa non torna, non scrivo.');
  process.exit(1);
}
let out = html.replace(blocco[0], `const rawData = [\n${nuove.join('\n')}\n];`);
out = out.replace(/const BASE = [\d.]+;[^\n]*/,
  `const BASE = ${baseNuova}; // Σ d[7] rawData 2022-2025 (autoconsumo al COSTO MARGINALE per ` +
  `2024-2025, dalle bollette vere — vedi ricalcola-storico-ammortamento.mjs) + GSE e rimborsi una tantum`);
writeFileSync(HTML, out);
console.log('✅ index.html riscritto. Ora: node build-solar-html.mjs');
