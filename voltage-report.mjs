#!/usr/bin/env node
/**
 * voltage-report.mjs — Legge data/voltage-midday.csv, isola i campioni di OGGI,
 * calcola il verdetto sul taglio PV di mezzogiorno (sovratensione vs config) e
 * manda un messaggio Telegram a Luca (@oliogalluzzisocialbot).
 * Gira alle 14:30 via LaunchAgent com.oliogalluzzi.voltage-report.
 * Flag --dry = stampa il messaggio invece di inviarlo (per test).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CSV = process.env.VCSV || path.join(DIR, 'data', 'voltage-midday.csv');
const DRY = process.argv.includes('--dry');

// credenziali Telegram da HQ/.env (bot alert tecnici per Luca)
const ENV = '/Users/lucagalluzzi/Projects/HQ/.env';
const env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const get = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TG_TOKEN = get('TELEGRAM_BOT_TOKEN'), TG_CHAT = get('TELEGRAM_CHAT_ID');

async function tg(text) {
  if (DRY) { console.log('--- DRY RUN, messaggio:\n' + text.replace(/<[^>]+>/g, '')); return; }
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' }),
  });
}

const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

if (!fs.existsSync(CSV)) { await tg('☀️ <b>Fotovoltaico</b> — oggi non ho catturato dati a mezzogiorno (file assente). Riprovo domani.'); process.exit(0); }

const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1);
const rows = lines.map(l => l.split(',')).filter(c => c[0] && c[0].startsWith(today)).map(c => ({
  ora: c[0].slice(11, 16), pv: +c[2], grid: +c[3], house: +c[4], soc: +c[5], vl1: +c[6], tbatt: +c[7],
})).filter(r => !isNaN(r.vl1));

if (rows.length < 3) {
  await tg('☀️ <b>Fotovoltaico — verdetto mezzogiorno</b>\nOggi pochi/nessun dato utile (cielo coperto, batteria non piena, o Mac spento a mezzogiorno). Non concludo nulla: ci riprovo domani. ☁️');
  process.exit(0);
}

const maxVL1 = Math.max(...rows.map(r => r.vl1));
const socMax = Math.max(...rows.map(r => r.soc));
const pvMax = Math.max(...rows.map(r => r.pv));
const gridMax = Math.max(...rows.map(r => r.grid));
const nHigh = rows.filter(r => r.vl1 >= 250).length;   // vicino soglia
const nTrip = rows.filter(r => r.vl1 >= 253).length;   // oltre soglia CEI 0-21
// tensione quando l'inverter spingeva di più
const rowMaxPV = rows.reduce((a, b) => (b.pv > a.pv ? b : a), rows[0]);
// ciclaggio: batteria piena + PV che oscilla molto (buchi e picchi)
const pvLows = rows.filter(r => r.soc >= 99 && r.pv < 0.5).length;
const pvHighs = rows.filter(r => r.soc >= 99 && r.pv > 3).length;
const cycling = socMax >= 99 && pvLows >= 2 && pvHighs >= 2;

let verdetto, azione, emoji;
if (nTrip > 0 || maxVL1 >= 252) {
  emoji = '🔴';
  verdetto = `<b>SOVRATENSIONE CONFERMATA.</b> La tensione di rete ha toccato <b>${maxVL1.toFixed(1)} V</b> (limite di stacco 253 V), ${nTrip > 0 ? `sopra soglia in ${nTrip} campioni` : 'a un soffio dallo stacco'}. È la rete di zona, non il tuo impianto.`;
  azione = '👉 <b>Si chiama e-Distribuzione</b> per "tensione fuori standard" (obbligo di legge: 230 V ±10%). Fai estrarre a Elettra anche i log degli stacchi dell\'inverter. Tienimi i dati: se serve, la segnalazione la prepariamo insieme.';
} else if (maxVL1 >= 247) {
  emoji = '🟠';
  verdetto = `<b>Tensione ALTA ma sotto lo stacco.</b> Max <b>${maxVL1.toFixed(1)} V</b> (quando il PV spingeva ${rowMaxPV.pv.toFixed(1)} kW era ${rowMaxPV.vl1.toFixed(1)} V). Sospetta sovratensione ma oggi non ha sforato: forse giornata non abbastanza carica.`;
  azione = '👉 Ricampioniamo un paio di giornate ben soleggiate: se sale ai 253 V è rete (e-Distribuzione). Intanto puoi girare la cosa a Elettra.';
} else if (cycling) {
  emoji = '🟡';
  verdetto = `<b>PV tagliato con tensione NELLA NORMA</b> (max ${maxVL1.toFixed(1)} V, batteria ${socMax}%). Se la rete è a posto ma il fotovoltaico si taglia lo stesso, punta più alla <b>configurazione/firmware</b> "immissione zero" che alla rete.`;
  azione = '👉 Giro decisivo all\'installatore <b>Elettra / Delios</b>: chiedi curva di derating dolce e verifica del settaggio immissione.';
} else {
  emoji = '🟢';
  verdetto = `Oggi <b>nessun taglio anomalo</b>: tensione max ${maxVL1.toFixed(1)} V, PV fino a ${pvMax.toFixed(1)} kW, batteria ${socMax}%. Vuol dire che il problema non si è presentato (poco surplus o rete tranquilla).`;
  azione = '👉 Aspettiamo una giornata piena per il confronto.';
}

const msg = `${emoji} <b>Fotovoltaico — verdetto mezzogiorno (${today.split('-').reverse().join('/')})</b>\n\n` +
  `${verdetto}\n\n` +
  `📊 Tensione max <b>${maxVL1.toFixed(1)} V</b> · picco PV ${pvMax.toFixed(1)} kW · batteria ${socMax}% · max prelievo rete ${gridMax.toFixed(1)} kW · campioni ${rows.length}${cycling ? ' · ciclaggio on/off rilevato' : ''}\n\n` +
  `${azione}`;

await tg(msg);
console.log('voltage-report inviato' + (DRY ? ' (dry)' : '') + ' — maxVL1=' + maxVL1);
