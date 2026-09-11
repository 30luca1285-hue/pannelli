#!/usr/bin/env node
/**
 * alert-pv-fermo.mjs — avvisa su Telegram QUANDO si presenta la condizione da verificare
 * di persona sull'inverter: **produzione a zero con batteria piena e sole disponibile**.
 *
 * Nasce il 09/08/2026: l'8 agosto il monitoraggio ha registrato 5 ore a 0,1 kW con batteria
 * al 100% e la casa alimentata dalla rete (63 kWh comprati). Ma le due fonti di dati si
 * CONTRADDICONO negli stessi minuti — `solar_live` diceva 0,1 kW mentre `data/voltage-midday.csv`
 * diceva 7 kW — quindi non si sa se l'impianto si fermi davvero o se sia il monitoraggio a
 * riportare valori falsi. **L'unico modo per saperlo è guardare l'inverter mentre succede.**
 * Questo alert serve a quello, e sostituisce il resoconto giornaliero delle 14:30
 * (`voltage-report`, spento su richiesta di Luca lo stesso giorno): meglio un avviso quando
 * c'è qualcosa da fare che un messaggio tutti i giorni.
 *
 * Uso:  node alert-pv-fermo.mjs [--dry] [--forza]
 *   --dry   stampa il messaggio invece di inviarlo
 *   --forza ignora il "una volta al giorno" (per provare)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';   // stessa libreria di lib-db.mjs: niente dipendenze in più

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(DIR, 'storico.db');
const STATO = path.join(DIR, 'data', 'alert-pv-fermo-stato.json');
const DRY = process.argv.includes('--dry');
const FORZA = process.argv.includes('--forza');

// ── soglie ───────────────────────────────────────────────────────────────────
const PV_FERMO = 0.5;    // kW: sotto questo la produzione è ferma
const BATT_PIENA = 99;   // %
const ORA_DA = 11, ORA_A = 17;   // solo con sole alto: prima/dopo sarebbe normale

const ora = new Date();
const oggi = `${ora.getFullYear()}-${String(ora.getMonth() + 1).padStart(2, '0')}-${String(ora.getDate()).padStart(2, '0')}`;
const h = ora.getHours();

if (!FORZA && (h < ORA_DA || h > ORA_A)) process.exit(0);

const db = new DatabaseSync(DB, { readOnly: true });
const r = db.prepare('SELECT ts, powerpv, powerbatt, powergrid, powerhouse, percentbattery, energy_pv FROM solar_live ORDER BY ts DESC LIMIT 1').get();
db.close();
if (!r) process.exit(0);

// il dato dev'essere fresco: solar-fetch gira ogni 15 min, oltre 40 non è più «adesso»
const minutiFa = (Date.now() - new Date(r.ts.replace(' ', 'T')).getTime()) / 60000;

// ⚠️ 14/08/2026 — SECONDO CASO DA SEGNALARE: «l'impianto non parla più».
// Il 13/08 alle 18 la batteria era al 6%, alle 03:45 è arrivata a 0 e da lì il portale Delios ha
// smesso di dare dati: oggi 0,0 kWh contro i 47,9 di ieri. Questo alert è rimasto MUTO tutto il
// giorno per due motivi, e sono lo stesso errore visto altrove — un controllo che tace proprio
// quando dovrebbe parlare:
//   1. usciva in silenzio se il dato era vecchio (`minutiFa > 40`) → cioè proprio quando mancava;
//   2. pretendeva batteria ≥ 99%, tarato sul caso opposto (sovratensione a batteria piena).
// Ora: se in pieno giorno i dati sono fermi o tutti a zero (la casa che consuma 0 kW è
// impossibile), lo dice. Vedi [[feedback_dato_vecchio_mai_come_attuale]].
const datiFermi = minutiFa > 40 || !r.ts.startsWith(oggi);
const tuttoZero = (+r.powerpv === 0) && (+r.powerhouse === 0) && (+r.percentbattery === 0);
const muto = datiFermi || tuttoZero;

const condizione = r.powerpv < PV_FERMO && r.percentbattery >= BATT_PIENA;
if (!condizione && !muto && !FORZA) process.exit(0);

// una volta al giorno basta: l'alert serve a mandarti a guardare, non a tempestarti
let stato = {};
try { stato = JSON.parse(fs.readFileSync(STATO, 'utf8')); } catch {}
if (!FORZA && stato.ultimo === oggi) process.exit(0);

// La TENSIONE è il dato che ha risolto il caso (09/08/2026): sta solo in voltage-midday.csv,
// che però viene riempito unicamente nella fascia di mezzogiorno. Se c'è un campione fresco lo
// si mostra, altrimenti si tace su quel punto invece di inventare.
function tensioneRecente() {
  try {
    const csv = fs.readFileSync(path.join(DIR, 'data', 'voltage-midday.csv'), 'utf8').trimEnd().split('\n');
    const ultima = csv[csv.length - 1].split(',');
    const quando = new Date(ultima[0].replace(' ', 'T'));
    if ((Date.now() - quando.getTime()) / 60000 > 20) return null;
    return { v: parseFloat(ultima[6]), ts: ultima[0].slice(11, 16) };
  } catch { return null; }
}

const kw = n => `${(+n || 0).toFixed(1)} kW`;
const volt = tensioneRecente();

// l'ultimo dato VERO che abbiamo visto: serve a dire da quando l'impianto tace
function ultimoDatoVero() {
  try {
    const d = new DatabaseSync(DB, { readOnly: true });
    const x = d.prepare('SELECT ts, powerpv, percentbattery, powerhouse FROM solar_live WHERE percentbattery > 0 OR powerpv > 0 ORDER BY ts DESC LIMIT 1').get();
    d.close();
    return x || null;
  } catch { return null; }
}

const testoMuto = (() => {
  const u = ultimoDatoVero();
  const da = u ? `${u.ts.slice(8, 10)}/${u.ts.slice(5, 7)} alle ${u.ts.slice(11, 16)}` : 'non so dire quando';
  const ore = u ? Math.round((Date.now() - new Date(u.ts.replace(' ', 'T')).getTime()) / 3600000) : null;
  return `🔌 <b>L'impianto non sta trasmettendo</b>\n\n` +
    `Ultimo dato vero: <b>${da}</b>${ore ? ` — ${ore} ore fa` : ''}.\n` +
    (u ? `Allora: produzione ${kw(u.powerpv)}, batteria <b>${Math.round(u.percentbattery)}%</b>, casa ${kw(u.powerhouse)}.\n` : '') +
    `Da lì il portale Delios risponde ma è vuoto.\n\n` +
    `<b>Cosa vuol dire:</b> o l'inverter si è fermato (e stiamo comprando tutto dalla rete), ` +
    `oppure lavora ma non comunica più. <b>Da qui non si distingue.</b>\n\n` +
    `👉 <b>Guarda il display dell'inverter</b>: se segna produzione, si è perso solo il monitoraggio; ` +
    `se è spento o in errore, segnati il codice.\n` +
    `<i>Se la batteria era a zero, molti ibridi dopo la protezione non ripartono da soli: serve riaccenderlo a mano.</i>`;
})();

const testoSovratensione =
  `⚡️ <b>Pannelli staccati — guarda adesso</b>\n\n` +
  `Ore ${r.ts.slice(11, 16)}:\n` +
  `• produzione <b>${kw(r.powerpv)}</b>\n` +
  `• batteria <b>${Math.round(r.percentbattery)}%</b> (piena)\n` +
  `• casa <b>${kw(r.powerhouse)}</b>, dalla rete <b>${kw(r.powergrid)}</b>\n` +
  (volt ? `• tensione di rete <b>${volt.v.toFixed(1)} V</b> (${volt.ts})\n` : '') +
  `\n<b>Cosa sappiamo</b> (misurato il 09/08/2026): appena la batteria è piena l'inverter immette in ` +
  `rete, la tensione sale fino a <b>~251 V</b> e lui si stacca per protezione; senza immissione la ` +
  `tensione ricade a ~240 V e riparte. Poi da capo, ogni ~10 minuti.\n\n` +
  `<b>Cosa puoi fare adesso, subito:</b>\n` +
  `👉 Accendi carichi in casa (pompa, condizionatori, boiler, lavatrice). Consumare invece di ` +
  `immettere abbassa la tensione: l'inverter resta agganciato e usi l'energia invece di comprarla.\n\n` +
  `<i>Se hai un minuto, guarda anche il display dell'inverter e segnati il codice di errore: ` +
  `serve per la segnalazione a e-distribuzione. Te lo dico una volta al giorno.</i>`;

// muto ha la precedenza: se non arrivano dati, il resto sarebbe fondato sul nulla
const testo = muto ? testoMuto : testoSovratensione;

if (DRY) {
  console.log('--- DRY RUN ---\n' + testo.replace(/<[^>]+>/g, ''));
  process.exit(0);
}

const ENV = '/Users/lucagalluzzi/Projects/HQ/.env';
const env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const get = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const T = get('TELEGRAM_BOT_TOKEN'), C = get('TELEGRAM_CHAT_ID');
if (!T || !C) { console.error('Telegram non configurato'); process.exit(1); }

const resp = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: C, text: testo, parse_mode: 'HTML' }),
});
const esito = await resp.json();
if (esito.ok) {
  fs.mkdirSync(path.dirname(STATO), { recursive: true });
  fs.writeFileSync(STATO, JSON.stringify({ ultimo: oggi, ts: r.ts, pv: r.powerpv, batt: r.percentbattery }, null, 2));
  console.log(`📨 Alert inviato (pv ${r.powerpv} · batt ${r.percentbattery}%)`);
} else {
  console.error('Telegram ha rifiutato:', JSON.stringify(esito).slice(0, 160));
  process.exit(1);
}
