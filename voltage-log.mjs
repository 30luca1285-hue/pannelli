#!/usr/bin/env node
/**
 * voltage-log.mjs — Campiona la TENSIONE DI RETE (VL1) dell'inverter Delios ogni 40s
 * nella fascia di mezzogiorno, per diagnosticare il taglio PV a batteria piena
 * (sovratensione di rete vs curtailment). Scrive data/voltage-midday.csv.
 * Avvio: node --env-file=.env voltage-log.mjs   (o via LaunchAgent com.oliogalluzzi.voltage-midday)
 * Si autolimita alla finestra 11:00–15:00 e a ~220 campioni, poi esce.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CSV = path.join(DIR, 'data', 'voltage-midday.csv');
const BASE = process.env.DELIOS_BASE, EMAIL = process.env.DELIOS_EMAIL, PASS = process.env.DELIOS_PASSWORD;
const PLANT = Number(process.env.DELIOS_PLANT_ID);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

async function login() {
  const r = await fetch(BASE + '/authenticate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) });
  return (await r.json()).token;
}
async function machine(token) {
  const r = await fetch(BASE + '/machine_list/get_machine_list_table_data', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ plant_id: PLANT }) });
  return (await r.json()).machines[0];
}

if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, 'datetime,dato_ts,powerPV_kW,powerGrid_kW,powerHouse_kW,SOC,VL1_V,battTension_V,tempInv_C\n');

let token = await login();
let last = null;
for (let i = 0; i < 220; i++) {
  const h = new Date().getHours();
  if (h < 11 || h >= 15) break; // solo fascia mezzogiorno
  let m;
  try { m = await machine(token); }
  catch { token = await login(); await sleep(3000); continue; }
  if (m && m.lastReceivedData !== last) {           // scrivi solo quando il dato cambia (ogni ~1 min)
    last = m.lastReceivedData;
    const dt = new Date(m.lastReceivedData * 1000).toLocaleTimeString('it-IT');
    const row = [stamp(new Date()), dt, m.powerPV, m.powerGrid, m.powerHouse, m.SOC.slice(0, 3), m.VL1, m.batteryTension, m.temperature].join(',');
    fs.appendFileSync(CSV, row + '\n');
  }
  await sleep(40000);
}
console.log('voltage-log: finestra chiusa, ' + CSV);
