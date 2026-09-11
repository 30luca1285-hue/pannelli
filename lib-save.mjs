// lib-save.mjs — salvataggio autonomo dei valori editabili (bolletta/GSE/kwh_eff/materia)
// e dei prezzi €/kWh. Scrive nel DB (solar_monthly) + in inserimenti-manuali.json (casa stabile,
// versionata) + rigenera monthly/prices dentro solar.json così l'app li rilegge subito.
// Usato dalle route POST /energia/api/* del server SOCIAL.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DIR = '/Users/lucagalluzzi/Projects/Pannelli';
const DB = `${DIR}/storico.db`;
const DATA = `${DIR}/data`;
const MANUALI = `${DIR}/inserimenti-manuali.json`;
const PREZZI = `${DATA}/prezzi.json`;
const SOLARJSON = `${DATA}/solar.json`;

const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const mm = (mese) => String(MESI.indexOf(mese) + 1).padStart(2, '0');
const num = (x) => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };

export function readPrices() {
  try { return JSON.parse(fs.readFileSync(PREZZI, 'utf8')); }
  catch { return { acquisto: 0.18, vendita: 0.10 }; }
}

// aggiorna SOLO monthly + prices dentro solar.json, preservando live/daily/trendDay
function refreshSolarJson() {
  const db = new DatabaseSync(DB);
  const monthly = db.prepare('SELECT * FROM solar_monthly ORDER BY ym').all();
  db.close();
  let j = {};
  try { j = JSON.parse(fs.readFileSync(SOLARJSON, 'utf8')); } catch {}
  j.monthly = monthly;
  j.prices = readPrices();
  fs.writeFileSync(SOLARJSON, JSON.stringify(j, null, 2));
}

// Salva i valori editabili di un mese (bolletta/GSE/kwh_eff/materia).
// I kWh (produzione/autoconsumo/da_rete/immessa) restano gestiti dall'inverter Delios:
// li usa SOLO per creare un mese non ancora presente.
export function saveMensile(params = {}) {
  const anno = parseInt(params.anno, 10);
  const mese = String(params.mese || '');
  if (!anno || MESI.indexOf(mese) < 0) throw new Error(`anno/mese non validi: ${anno}/${mese}`);
  const ym = `${anno}-${mm(mese)}`;
  const ed = { kwh_eff: num(params.kwh_eff), materia: num(params.materia), gse: num(params.gse), bolletta: num(params.bolletta) };

  const db = new DatabaseSync(DB);
  const exists = db.prepare('SELECT ym FROM solar_monthly WHERE ym=?').get(ym);
  if (exists) {
    db.prepare('UPDATE solar_monthly SET kwh_eff=?, materia=?, gse=?, bolletta=? WHERE ym=?')
      .run(ed.kwh_eff, ed.materia, ed.gse, ed.bolletta, ym);
  } else {
    db.prepare(`INSERT INTO solar_monthly (ym,anno,mese,produzione,autoconsumo,da_rete,immessa,kwh_eff,materia,gse,bolletta,auto_val,prezzo_kwh,legacy4,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ym, anno, mese, num(params.produzione), num(params.autoconsumo), Math.round(num(params.da_rete)), num(params.immessa),
        ed.kwh_eff, ed.materia, ed.gse, ed.bolletta, 0, 0, 0, 'manuale');
  }
  db.close();

  // casa stabile versionata: aggiorna/aggiunge la voce per questo ym
  let man = [];
  try { man = JSON.parse(fs.readFileSync(MANUALI, 'utf8')); } catch {}
  const i = man.findIndex(m => m.ym === ym);
  const entry = { ym, kwh_eff: ed.kwh_eff, materia: ed.materia, gse: ed.gse, bolletta: ed.bolletta,
    nota: `Salvato dall'app il ${new Date().toISOString().slice(0,16).replace('T',' ')}` };
  if (i >= 0) man[i] = entry; else man.push(entry);
  man.sort((a, b) => a.ym.localeCompare(b.ym));
  fs.writeFileSync(MANUALI, JSON.stringify(man, null, 2));

  refreshSolarJson();
  return { ok: true, ym, salvato: ed };
}

// Salva i prezzi €/kWh (acquisto/vendita) del Solare.
export function savePrices(params = {}) {
  const prices = { acquisto: num(params.acquisto) || 0.18, vendita: num(params.vendita) || 0.10 };
  fs.writeFileSync(PREZZI, JSON.stringify(prices, null, 2));
  refreshSolarJson();
  return { ok: true, prices };
}
