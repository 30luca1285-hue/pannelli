#!/usr/bin/env node
/**
 * auto-detect.mjs — ricostruisce le ricariche della ID.3 dai campioni Delios (solar_live, 15 min)
 * e scrive data/auto.json per il tab ⚡ Auto.
 *
 * Perché "a plateau" e non "sopra tot kW": il consumo di casa arriva già a 4-6 kW da solo
 * (7 split Daikin + azienda). Quello che distingue una ricarica è la FORMA — gradino netto,
 * potenza piatta per ore — non il livello. Resta comunque una STIMA: ogni sessione nasce
 * 'auto' e Luca può confermarla (ok) o scartarla (no) dall'app.
 * Quando WeConnect è attivo (auto-vw.mjs) le sessioni vere arrivano da lì con source='vw'
 * e queste servono solo ad attribuire la quota sole/rete.
 *
 * Uso: node auto-detect.mjs   (da ~/Projects/Pannelli)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA, DB_PATH, readConfig, ensureAutoTables, rigeneraAutoJson } from './auto-lib.mjs';

const cfg = readConfig();
const db = ensureAutoTables(new DatabaseSync(DB_PATH));

const mediana = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const devstd = (a) => { const m = media(a); return a.length ? Math.sqrt(media(a.map((x) => (x - m) ** 2))) : 0; };
const ore = (a, b) => Math.min(0.5, Math.max(0, (new Date(b + 'Z') - new Date(a + 'Z')) / 3.6e6)); // buchi cappati a 30'

const righe = db.prepare('SELECT ts, powerpv, powerhouse, powergrid, powerbatt FROM solar_live WHERE ts >= ? ORDER BY ts')
  .all(cfg.data_inizio + ' 00:00:00');

// --- rilevamento plateau ---
const sessioni = [];
let i = 0;
while (i < righe.length) {
  if ((righe[i].powerhouse || 0) < cfg.soglia_kw) { i++; continue; }
  let j = i;
  while (j + 1 < righe.length && (righe[j + 1].powerhouse || 0) >= cfg.soglia_kw
         && ore(righe[j].ts, righe[j + 1].ts) <= 0.5) j++;
  const seq = righe.slice(i, j + 1);

  if (seq.length >= cfg.campioni_min) {
    const pot = seq.map((r) => r.powerhouse || 0);
    const prima = righe.slice(Math.max(0, i - 4), i).map((r) => r.powerhouse || 0);
    const baseline = prima.length ? mediana(prima) : Math.min(...pot) * 0.5;
    const gradino = media(pot) - baseline;

    // plateau: gradino netto + potenza piatta (i condizionatori oscillano, la wallbox no)
    if (gradino >= cfg.gradino_kw && devstd(pot) <= 1.8) {
      const cap = cfg.wallbox_kw * 1.15;
      let kwh = 0, rete = 0, kwSum = 0, oreTot = 0;
      for (let k = 0; k < seq.length; k++) {
        const dt = k === 0 ? ore(righe[Math.max(0, i - 1)].ts, seq[0].ts) : ore(seq[k - 1].ts, seq[k].ts);
        const p = Math.min(cap, Math.max(0, (seq[k].powerhouse || 0) - baseline));
        // l'auto è il carico marginale: il prelievo dalla rete è "colpa" sua fino a concorrenza
        const daRete = Math.min(p, Math.max(0, seq[k].powergrid || 0));
        kwh += p * dt; rete += daRete * dt; kwSum += p; oreTot += dt;
      }
      const fine = seq[seq.length - 1].ts;
      sessioni.push({
        id: seq[0].ts, inizio: seq[0].ts, fine,
        ore: +oreTot.toFixed(2),
        kwh: +kwh.toFixed(2), kwh_sole: +(kwh - rete).toFixed(2), kwh_rete: +rete.toFixed(2),
        kw_medi: +(kwSum / seq.length).toFixed(2), baseline_kw: +baseline.toFixed(2),
        source: 'stima',
      });
    }
  }
  i = j + 1;
}

// --- salvataggio: aggiorna i numeri, NON tocca lo stato deciso da Luca ---
const up = db.prepare(`INSERT INTO auto_sessioni (id,inizio,fine,ore,kwh,kwh_sole,kwh_rete,kw_medi,baseline_kw,source,stato)
  VALUES (?,?,?,?,?,?,?,?,?,?,'auto')
  ON CONFLICT(id) DO UPDATE SET fine=excluded.fine, ore=excluded.ore, kwh=excluded.kwh,
    kwh_sole=excluded.kwh_sole, kwh_rete=excluded.kwh_rete, kw_medi=excluded.kw_medi,
    baseline_kw=excluded.baseline_kw
  WHERE auto_sessioni.source='stima'`);
for (const s of sessioni) up.run(s.id, s.inizio, s.fine, s.ore, s.kwh, s.kwh_sole, s.kwh_rete, s.kw_medi, s.baseline_kw, s.source);

// --- rigenerazione del json (stime + eventuali sessioni vere da WeConnect/manuali) ---
const out = rigeneraAutoJson(db);
db.close();

const t = out.totali;
console.log(`✅ Auto: ${t.ricariche} ricariche · ${t.kwh} kWh (${t.quota_sole}% dal sole) · ${t.km} km stimati`);
console.log(`   costo ${t.costo}€ · gasolio evitato ${t.gasolio_evitato}€ · risparmio ${t.risparmio}€ · delta ammortamento ${t.delta_ammortamento}€`);
if (t.scartate) console.log(`   (${t.scartate} sessioni scartate a mano, escluse)`);
