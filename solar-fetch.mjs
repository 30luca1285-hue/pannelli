#!/usr/bin/env node
/**
 * solar-fetch.mjs — Pannelli solari (inverter Delios). Legge live + energia giornaliera,
 * scrive data/solar.json e accumula nell'archivio storico.db (solar_live 15min + solar_daily).
 * Uso: node --env-file=.env solar-fetch.mjs   (da ~/Projects/Pannelli)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, todayStr } from './lib-db.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const DB = path.join(DIR, 'storico.db');

const EMAIL = process.env.DELIOS_EMAIL, PASS = process.env.DELIOS_PASSWORD;
const PLANT = Number(process.env.DELIOS_PLANT_ID), BASE = process.env.DELIOS_BASE;
if (!EMAIL || !PASS || !BASE) { console.error('❌ Mancano credenziali Delios in env'); process.exit(1); }

async function login() {
  const r = await fetch(BASE + '/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) });
  const j = await r.json();
  if (!j.token) throw new Error('Login Delios fallito: ' + JSON.stringify(j).slice(0, 150));
  return j.token;
}
async function general(token) {
  const r = await fetch(BASE + '/machine_logs/get_machine_log_general', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ plant_id: PLANT, machine_id: '' }) });
  if (!r.ok) throw new Error('general ' + r.status);
  return r.json();
}
async function trend(token, type) {
  try {
    const r = await fetch(BASE + '/machine_logs/get_machine_log_trend', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ plant_id: PLANT, machine_id: '', type }) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const num = (x) => (typeof x === 'number' ? x : 0);

async function main() {
  const token = await login();
  const g = await general(token);
  const now = new Date();
  const ts = now.toISOString().slice(0, 19).replace('T', ' ');

  const live = {
    powerpv: num(g.powerpv), powerbatt: num(g.powerbatt), powergrid: num(g.powergrid),
    powerhouse: num(g.powerhouse), percentbattery: num(g.percentbattery),
    energy_pv: num(g.energy_pv), energy_grid_consumed: num(g.energy_grid_consumed),
    energy_grid_feed_in: num(g.energy_grid_feed_in), energy_powerhouse: num(g.energy_powerhouse),
    energy_battery_char: num(g.energy_battery_char), energy_battery_discha: num(g.energy_battery_discha),
    self_sufficiency: num(g.self_sufficiency),
  };

  const db = openDb(DB);
  // log live 15-min (granulare, storico)
  db.prepare('INSERT OR REPLACE INTO solar_live(ts,powerpv,powerbatt,powergrid,powerhouse,percentbattery) VALUES (?,?,?,?,?,?)')
    .run(ts, live.powerpv, live.powerbatt, live.powergrid, live.powerhouse, live.percentbattery);
  // snapshot giorno (i valori energy_* sono cumulativi del giorno: l'ultimo del giorno = totale)
  db.prepare(`INSERT INTO solar_daily(date,energy_pv,energy_grid_consumed,energy_grid_feed_in,energy_powerhouse,energy_battery_char,energy_battery_discha,self_sufficiency)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET energy_pv=excluded.energy_pv,energy_grid_consumed=excluded.energy_grid_consumed,
      energy_grid_feed_in=excluded.energy_grid_feed_in,energy_powerhouse=excluded.energy_powerhouse,
      energy_battery_char=excluded.energy_battery_char,energy_battery_discha=excluded.energy_battery_discha,self_sufficiency=excluded.self_sufficiency`)
    .run(todayStr(now), live.energy_pv, live.energy_grid_consumed, live.energy_grid_feed_in, live.energy_powerhouse, live.energy_battery_char, live.energy_battery_discha, live.self_sufficiency);

  // serie per i grafici dal db
  const daily = db.prepare('SELECT * FROM solar_daily ORDER BY date DESC LIMIT 60').all().reverse();
  const monthly = db.prepare('SELECT * FROM solar_monthly ORDER BY ym').all();
  db.close();

  const out = { generatedAt: now.toISOString(), live, trendDay: await trend(token, 'day'), daily, monthly };
  fs.writeFileSync(path.join(DATA, 'solar.json'), JSON.stringify(out, null, 2));
  console.log(`✅ Solare: PV ${live.powerpv}kW · oggi PV ${live.energy_pv}kWh · batt ${live.percentbattery}% · autosuff ${live.self_sufficiency}% · daily storici=${daily.length} mensili=${monthly.length}`);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
