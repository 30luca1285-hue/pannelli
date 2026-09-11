/**
 * UNA FONTE SOLA per i dati energia.
 *
 * PERCHÉ ESISTE (11/09/2026). Luca: «ma perché tutti questi pasticci?» — e aveva ragione.
 * Per il 2026 c'erano TRE registri che non si parlavano:
 *   · storico.db (solar_monthly) — scritto dall'inverter da solar-fetch ogni 15 min: 9 mesi
 *   · foglio Delios              — quello che disegna il grafico dell'app:            8 mesi
 *   · foglio Mensile_2026        — le bollette, compilato a mano dall'app:            7 mesi
 * Nessuno coincideva con gli altri: mancavano mesi diversi in ciascuno, e giugno sul foglio
 * aveva una produzione sbagliata (792 invece di 1165). Da qui i «pasticci».
 *
 * COME FUNZIONA ORA
 *   il DATABASE è la fonte. Questo script lo specchia sul foglio Mensile_2026, che è quello
 *   che l'app legge. Il foglio Delios resta dov'è: i mesi che gli mancano l'app li prende
 *   comunque da Mensile_2026 (fallback in renderMensile, corretto l'11/09).
 *
 * ⛔ NON inventa e non sovrascrive a vuoto: scrive solo i mesi che differiscono davvero.
 * ⛔ I dati delle BOLLETTE (kwh_eff, materia, gse, bolletta) stanno nel database e li
 *    registra `--bolletta`. L'inverter non li tocca (solar-fetch aggiorna solo i kWh).
 *
 * Uso:
 *   node allinea-energia.mjs                                  → mostra le differenze, non scrive
 *   node allinea-energia.mjs --scrivi                          → allinea il foglio al database
 *   node allinea-energia.mjs --bolletta Settembre 500 95.50    → registra una bolletta e allinea
 *                                                                (mese, kWh fatturati, € materia)
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const DB = path.join(DIR, 'storico.db');
const GAS = 'https://script.google.com/macros/s/AKfycbxXVLk-UsEycb1ItdqnjGqdmIULCTazUbVf1SE7xK8184eDrVWT4FwBcddtP_sUrfY9Ug/exec';
const ANNO = new Date().getFullYear();
const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

const args = process.argv.slice(2);
const scrivi = args.includes('--scrivi');
const iBolletta = args.indexOf('--bolletta');

// ── 1. se c'è una bolletta da registrare, va nel DATABASE (la fonte), non sul foglio
if (iBolletta >= 0) {
  const [mese, kwh, euro] = args.slice(iBolletta + 1, iBolletta + 4);
  const meseOk = MESI.find(m => m.toLowerCase() === String(mese).toLowerCase());
  if (!meseOk || !kwh || !euro) {
    console.error('Uso: --bolletta <Mese> <kWh fatturati> <€ materia energia>');
    process.exit(1);
  }
  const db = new DatabaseSync(DB);
  const ym = `${ANNO}-${String(MESI.indexOf(meseOk) + 1).padStart(2, '0')}`;
  const esiste = db.prepare('SELECT ym FROM solar_monthly WHERE ym = ?').get(ym);
  if (!esiste) {
    console.error(`⚠️ ${meseOk} ${ANNO} non è ancora nel database: l'inverter non ha chiuso il mese. Non scrivo.`);
    db.close(); process.exit(1);
  }
  db.prepare('UPDATE solar_monthly SET kwh_eff = ?, materia = ? WHERE ym = ?')
    .run(Number(kwh), Number(euro), ym);
  db.close();
  console.log(`✅ bolletta registrata nel database: ${meseOk} ${ANNO} — ${kwh} kWh, ${euro} € di materia (${(euro/kwh).toFixed(4)} €/kWh)\n`);
}

// ── 2. leggo la fonte
const db = new DatabaseSync(DB);
const righe = db.prepare(
  'SELECT mese, produzione, autoconsumo, da_rete, immessa, kwh_eff, materia, gse, bolletta FROM solar_monthly WHERE anno = ? ORDER BY ym'
).all(ANNO);
db.close();

// ── 3. leggo com'è il foglio adesso
const rispostaFoglio = await fetch(`${GAS}?action=loadMensile2026`).then(r => r.json()).catch(() => null);
if (!Array.isArray(rispostaFoglio)) {
  console.error('⚠️ non riesco a leggere il foglio Mensile_2026: non tocco niente.');
  process.exit(1);
}
const suFoglio = new Map(rispostaFoglio.filter(r => r.anno == ANNO).map(r => [r.mese, r]));

// ── 4. confronto e (se richiesto) allineo
const campi = ['produzione','autoconsumo','da_rete','immessa','kwh_eff','materia','gse','bolletta'];
let daAllineare = 0;
console.log(`fonte = database (${righe.length} mesi ${ANNO}) · foglio = ${suFoglio.size} mesi\n`);

for (const r of righe) {
  const f = suFoglio.get(r.mese);
  const diff = campi.filter(c => Math.abs((f?.[c] ?? -1) - (r[c] ?? 0)) > 0.01);
  if (!f) {
    console.log(`  ${r.mese.padEnd(10)} ASSENTE dal foglio → da aggiungere`);
  } else if (diff.length) {
    console.log(`  ${r.mese.padEnd(10)} diverso su: ${diff.map(c => `${c} ${f[c]}→${r[c]}`).join(' · ')}`);
  } else {
    continue;   // già allineato
  }
  daAllineare++;
  if (scrivi) {
    const p = new URLSearchParams({ action: 'saveMensile2026', anno: ANNO, mese: r.mese });
    campi.forEach(c => p.set(c, r[c] ?? 0));
    const esito = await fetch(`${GAS}?${p}`).then(x => x.text()).catch(e => 'errore: ' + e.message);
    console.log(`     → ${esito.slice(0, 40)}`);
    await new Promise(res => setTimeout(res, 800));
  }
}

if (!daAllineare) console.log('  ✅ foglio e database già allineati, niente da fare.');
else if (!scrivi) console.log(`\n🔎 PROVA: ${daAllineare} mesi da allineare. Rilancia con --scrivi.`);
else console.log(`\n✅ ${daAllineare} mesi allineati.`);
