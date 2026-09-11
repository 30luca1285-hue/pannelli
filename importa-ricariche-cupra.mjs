#!/usr/bin/env node
/**
 * Importa le ricariche della CUPRA Born dal CSV esportato dall'app Cupra Connect.
 *
 * PERCHÉ (01/09/2026). Fino a oggi le ricariche si deducevano dai **plateau di consumo** del Delios
 * (`auto-detect.mjs`): metodo fragile, che quel giorno ha attribuito la ricarica a due ore prima
 * (12:46 invece di 14:31) e con la casa accesa non la vedeva affatto — di giorno il consumo sta già
 * sopra la soglia e il filtro di piattezza scartava la sessione. L'app dell'auto invece dà il dato
 * esatto, **comprese le ricariche fatte fuori casa**, che nessuna misura sulla wallbox potrà mai
 * vedere. Deciso con Luca: rilevatore spento, CSV una volta al mese.
 *
 * ⚙️ CONVENZIONE SUL PREZZO (Luca, 01/09/2026): *«mettiamo 0,162 € come se il sole non ci fosse»*.
 * Senza una misura sulla wallbox non sappiamo quanta energia venisse dal fotovoltaico, quindi
 * **tutti i kWh si contano come acquistati dalla rete**: `kwh_sole = 0`, `kwh_rete = kwh`.
 * È il conto prudente — non gonfia il risparmio sul gasolio.
 *
 * Uso:
 *   node importa-ricariche-cupra.mjs <file.csv> [--dry]
 *
 * Il CSV ha una riga d'intestazione e questi campi (virgole, valori fra virgolette):
 *   ID sessione · Sessione avviata (UTC) · Sessione terminata (UTC) · Tempo di ricarica (s) ·
 *   Durata effettiva (s) · Energia complessiva (kWh) · … · Stato iniziale (%) · Stato finale (%)
 *
 * L'ID sessione è la chiave: reimportare lo stesso file **non crea doppioni**, e un export che
 * copre mesi già caricati è innocuo.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureAutoTables, rigeneraAutoJson } from './auto-lib.mjs';

const file = process.argv[2];
const prova = process.argv.includes('--dry');
if (!file || !fs.existsSync(file)) {
  console.error('\nServe il CSV esportato da Cupra Connect:\n  node importa-ricariche-cupra.mjs <file.csv> [--dry]\n');
  process.exit(1);
}

// parser CSV minimo ma corretto sulle virgolette: i campi possono contenere virgole
function celle(riga) {
  const out = []; let cur = '', dentro = false;
  for (let i = 0; i < riga.length; i++) {
    const c = riga[i];
    if (c === '"') { if (dentro && riga[i + 1] === '"') { cur += '"'; i++; } else dentro = !dentro; }
    else if (c === ',' && !dentro) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// "2026-09-01T12:31:01Z" → "2026-09-01 14:31:01" (ora locale, come tutto il resto del db)
const locale = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const righe = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((r) => r.trim());
const intest = celle(righe[0]).map((c) => c.trim().toLowerCase());
const col = (nome) => intest.findIndex((c) => c.startsWith(nome));
const iId = col('id sessione'), iDa = col('sessione avviata'), iA = col('sessione terminata');
const iSec = col('tempo di ricarica'), iKwh = col('energia complessiva');
const iSoc0 = col('stato iniziale'), iSoc1 = col('stato finale');
if ([iId, iDa, iA, iKwh].some((x) => x < 0)) {
  console.error('\n❌ Intestazione inattesa: non riconosco le colonne del CSV Cupra.\n   Trovate: ' + intest.join(' · ') + '\n');
  process.exit(1);
}

const sessioni = [];
for (const r of righe.slice(1)) {
  const c = celle(r);
  const kwh = parseFloat(c[iKwh]);
  if (!c[iId] || !(kwh > 0)) continue;                      // righe vuote o senza energia: si saltano
  const secondi = parseInt(c[iSec], 10) || 0;
  const ore = secondi ? secondi / 3600 : (new Date(c[iA]) - new Date(c[iDa])) / 3.6e6;
  const soc0 = parseFloat(c[iSoc0]), soc1 = parseFloat(c[iSoc1]);
  sessioni.push({
    id: c[iId], inizio: locale(c[iDa]), fine: locale(c[iA]),
    ore: +ore.toFixed(3), kwh,
    kwh_sole: 0, kwh_rete: kwh,                             // convenzione: tutto come comprato
    kw_medi: ore > 0 ? +(kwh / ore).toFixed(2) : null,
    nota: Number.isFinite(soc0) && Number.isFinite(soc1) ? `batteria ${soc0}% → ${soc1}%` : null,
  });
}

if (!sessioni.length) { console.log('Nessuna sessione con energia nel file.'); process.exit(0); }

const db = ensureAutoTables(new DatabaseSync(DB_PATH));
const gia = new Set(db.prepare('SELECT id FROM auto_sessioni').all().map((r) => String(r.id)));
const nuove = sessioni.filter((s) => !gia.has(s.id));

console.log(`\n📄 ${file.split('/').pop()} — ${sessioni.length} sessioni nel file, ${nuove.length} nuove\n`);
for (const s of sessioni) {
  const segno = gia.has(s.id) ? '⏭️  già presente' : '✅ nuova       ';
  console.log(`${segno}  ${s.inizio} → ${s.fine.slice(11, 16)}  ${String(s.kwh).padStart(5)} kWh · ${s.ore.toFixed(2)} h · ${s.kw_medi} kW medi${s.nota ? '  (' + s.nota + ')' : ''}`);
}

if (prova) { console.log('\n🔎 PROVA: non ho scritto niente.\n'); db.close(); process.exit(0); }

const up = db.prepare(`INSERT INTO auto_sessioni (id,inizio,fine,ore,kwh,kwh_sole,kwh_rete,kw_medi,source,stato,nota)
  VALUES (?,?,?,?,?,?,?,?,'cupra','si',?)
  ON CONFLICT(id) DO UPDATE SET fine=excluded.fine, ore=excluded.ore, kwh=excluded.kwh,
    kwh_sole=excluded.kwh_sole, kwh_rete=excluded.kwh_rete, kw_medi=excluded.kw_medi, nota=excluded.nota
  WHERE auto_sessioni.source='cupra'`);
for (const s of sessioni) up.run(s.id, s.inizio, s.fine, s.ore, s.kwh, s.kwh_sole, s.kwh_rete, s.kw_medi, s.nota);

const out = rigeneraAutoJson(db);
db.close();
const t = out.totali;
console.log(`\n⚡ Totali dell'auto: ${t.ricariche} ricariche · ${t.kwh} kWh · ${t.km} km`);
console.log(`   costo ${t.costo} € · gasolio evitato ${t.gasolio_evitato} € · risparmio ${t.risparmio} €\n`);
