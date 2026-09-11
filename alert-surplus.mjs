#!/usr/bin/env node
/**
 * alert-surplus.mjs — avvisa su Telegram quando l'impianto sta REGALANDO energia alla rete
 * e conviene attaccare la ID.3 adesso.
 *
 * Nasce il 25/08/2026 con il tab ⚡ Auto: la wallbox è basic, non ha la modalità "solo surplus",
 * quindi la quota solare della ricarica dipende solo da QUANDO si attacca la spina. Questo è
 * il pezzo che sostituisce l'automatismo che la wallbox non ha.
 *
 * Condizione: immissione in rete >= SOGLIA per 2 campioni di fila (≈30 min, non un picco di nuvola),
 * in fascia diurna, auto già in casa, e nessuna ricarica già in corso.
 *
 * Uso:  node alert-surplus.mjs [--dry] [--forza]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readConfig, kmPerKwh, gasolioPerKwh } from './auto-lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(DIR, 'storico.db');
const STATO = path.join(DIR, 'data', 'alert-surplus-stato.json');
const DRY = process.argv.includes('--dry');
const FORZA = process.argv.includes('--forza');

// ── soglie ───────────────────────────────────────────────────────────────────
const SOGLIA_KW = 3.0;    // kW immessi: sotto questo non vale la pena attaccare
const ORA_DA = 9, ORA_A = 18;
const MAX_AL_GIORNO = 2;
const ORE_TRA_AVVISI = 3;

const cfg = readConfig();
const ora = new Date();
const oggi = `${ora.getFullYear()}-${String(ora.getMonth() + 1).padStart(2, '0')}-${String(ora.getDate()).padStart(2, '0')}`;

if (!FORZA) {
  if (ora.getHours() < ORA_DA || ora.getHours() > ORA_A) process.exit(0);
  if (oggi < cfg.data_inizio) process.exit(0);   // l'auto non è ancora in casa
}

const db = new DatabaseSync(DB, { readOnly: true });
const ultimi = db.prepare('SELECT ts, powerpv, powergrid, powerhouse, percentbattery FROM solar_live ORDER BY ts DESC LIMIT 3').all();
// consumo "normale" di casa oggi: serve a capire se una ricarica è già in corso
const medianaOggi = (() => {
  const v = db.prepare('SELECT powerhouse FROM solar_live WHERE substr(ts,1,10)=? ORDER BY powerhouse').all(oggi).map(x => x.powerhouse || 0);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
})();
db.close();

if (ultimi.length < 2) process.exit(0);
const r = ultimi[0];

// dato fresco: solar-fetch gira ogni 15 min
const minutiFa = (Date.now() - new Date(r.ts.replace(' ', 'T') + 'Z').getTime()) / 60000;
if (!FORZA && minutiFa > 40) process.exit(0);

// powergrid negativo = stiamo immettendo in rete
const surplus = (x) => Math.max(0, -(x.powergrid || 0));
const surplusOra = surplus(ultimi[0]), surplusPrima = surplus(ultimi[1]);
const stabile = surplusOra >= SOGLIA_KW && surplusPrima >= SOGLIA_KW;

// se la casa sta già tirando molto più del solito, probabilmente l'auto è già attaccata
const ricaricaInCorso = (r.powerhouse || 0) - medianaOggi >= 3.5;

if (!FORZA && (!stabile || ricaricaInCorso)) process.exit(0);

// quanto vale attaccare adesso, per un'ora
const kwPresi = Math.min(cfg.wallbox_kw, surplusOra);
const km = kwPresi * kmPerKwh(cfg);
const gasolio = kwPresi * gasolioPerKwh(cfg);

let stato = { giorno: oggi, inviati: 0, ultimoTs: null };
try { const s = JSON.parse(fs.readFileSync(STATO, 'utf8')); if (s.giorno === oggi) stato = s; } catch {}
if (!FORZA) {
  if (stato.inviati >= MAX_AL_GIORNO) process.exit(0);
  if (stato.ultimoTs && (Date.now() - new Date(stato.ultimoTs).getTime()) / 3.6e6 < ORE_TRA_AVVISI) process.exit(0);
}

const kw = (n) => `${(+n || 0).toFixed(1)} kW`;
const testo =
  `☀️🔌 <b>C'è sole in avanzo — attacca l'auto</b>\n\n` +
  `Ore ${r.ts.slice(11, 16)}:\n` +
  `• stiamo regalando alla rete <b>${kw(surplusOra)}</b>\n` +
  `• produzione ${kw(r.powerpv)} · casa ${kw(r.powerhouse)}` +
  (r.percentbattery ? ` · batteria ${Math.round(r.percentbattery)}%` : '') + `\n\n` +
  `<b>Se attacchi adesso</b>, in un'ora la ID.3 si prende ~<b>${kwPresi.toFixed(1)} kWh</b> gratis: ` +
  `circa <b>${Math.round(km)} km</b>, cioè <b>€${gasolio.toFixed(2)}</b> di gasolio che non compri.\n\n` +
  `<i>Lo stesso kWh venduto alla rete ci frutta €0,10. Nell'auto vale €${gasolioPerKwh(cfg).toFixed(2)}.</i>`;

if (DRY) { console.log('--- DRY RUN ---\n' + testo.replace(/<[^>]+>/g, '')); process.exit(0); }

const ENV = '/Users/lucagalluzzi/Projects/HQ/.env';
const env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const get = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const T = get('TELEGRAM_BOT_TOKEN'), C = get('TELEGRAM_CHAT_ID');
if (!T || !C) { console.error('Telegram non configurato'); process.exit(1); }

const resp = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: C, text: testo, parse_mode: 'HTML' }),
});
const esito = await resp.json();
if (esito.ok) {
  fs.writeFileSync(STATO, JSON.stringify({ giorno: oggi, inviati: stato.inviati + 1, ultimoTs: new Date().toISOString(), surplus: surplusOra }, null, 2));
  console.log(`📨 Avviso surplus inviato (${surplusOra} kW immessi)`);
} else {
  console.error('Telegram ha rifiutato:', JSON.stringify(esito).slice(0, 160));
  process.exit(1);
}
