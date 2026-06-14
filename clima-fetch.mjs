#!/usr/bin/env node
/**
 * clima-fetch.mjs — Consumi climatizzatori Daikin (Onecta Cloud API). Sola lettura.
 * Scrive data/clima.json e accumula storico.db (clima_daily da w[], clima_monthly da m[]).
 * Token refresh ROTANTE in .daikin-token.json.
 * Uso: node --env-file=.env clima-fetch.mjs   (da ~/Projects/Pannelli)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, todayStr, dateMinus, ymStr, ymMinus } from './lib-db.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, 'data');
const DB = path.join(DIR, 'storico.db');
const TOKEN_FILE = path.join(DIR, '.daikin-token.json');

const CLIENT_ID = process.env.DAIKIN_CLIENT_ID, CLIENT_SECRET = process.env.DAIKIN_CLIENT_SECRET;
const IDP = 'https://idp.onecta.daikineurope.com/v1/oidc/token';
const API = 'https://api.onecta.daikineurope.com/v1/gateway-devices';
const AZIENDA = new Set(['Negozio', 'Magazzino', 'Imbottigliamento', 'Deposito']);
if (!CLIENT_ID || !CLIENT_SECRET) { console.error('❌ Mancano DAIKIN_CLIENT_ID/SECRET'); process.exit(1); }

function readRT() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).refresh_token; } catch { return process.env.DAIKIN_REFRESH_TOKEN; } }
function saveTok(rt, at, exp) { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: rt, access_token: at, access_expiry: new Date(Date.now() + (exp - 120) * 1000).toISOString(), updatedAt: new Date().toISOString() }, null, 2)); }
async function accessToken() {
  try { const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); if (t.access_token && new Date(t.access_expiry) > new Date()) return t.access_token; } catch {}
  const rt = readRT(); if (!rt) throw new Error('Nessun refresh_token');
  const r = await fetch(IDP, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rt }) });
  const j = await r.json(); if (!j.access_token) throw new Error('Refresh fallito: ' + JSON.stringify(j));
  saveTok(j.refresh_token || rt, j.access_token, j.expires_in || 3600);
  return j.access_token;
}
const arr = (x) => Array.isArray(x) ? x.map(v => (typeof v === 'number' ? v : 0)) : [];
function roomName(dev) { for (const mp of dev.managementPoints || []) { if (mp.name?.value) return mp.name.value; } return (dev.id || '?').slice(0, 6); }
function consumption(dev) { for (const mp of dev.managementPoints || []) { if (mp.consumptionData?.value?.electrical) return mp.consumptionData.value.electrical; } return null; }

async function main() {
  const token = await accessToken();
  const r = await fetch(API, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!r.ok) throw new Error('gateway-devices ' + r.status + ': ' + (await r.text()).slice(0, 150));
  const devices = await r.json();
  const now = new Date();

  const rooms = [];
  for (const dev of devices) {
    const el = consumption(dev); if (!el) continue;
    const name = roomName(dev);
    rooms.push({ name, group: AZIENDA.has(name) ? 'azienda' : 'casa',
      cooling: { d: arr(el.cooling?.d), w: arr(el.cooling?.w), m: arr(el.cooling?.m) },
      heating: { d: arr(el.heating?.d), w: arr(el.heating?.w), m: arr(el.heating?.m) } });
  }

  // accumula storico: clima_daily da w[] (14 gg che finiscono oggi), clima_monthly da m[] (24 mesi)
  const db = openDb(DB);
  const upD = db.prepare('INSERT INTO clima_daily(date,room,cooling,heating) VALUES (?,?,?,?) ON CONFLICT(date,room) DO UPDATE SET cooling=excluded.cooling,heating=excluded.heating');
  const upM = db.prepare('INSERT INTO clima_monthly(ym,room,cooling,heating) VALUES (?,?,?,?) ON CONFLICT(ym,room) DO UPDATE SET cooling=excluded.cooling,heating=excluded.heating');
  for (const rm of rooms) {
    const cw = rm.cooling.w, hw = rm.heating.w, n = Math.max(cw.length, hw.length);
    for (let i = 0; i < n; i++) upD.run(dateMinus(n - 1 - i, now), rm.name, cw[i] || 0, hw[i] || 0);
    // m[] = calendario fisso: idx0 = gennaio dell'anno scorso, 2 anni gen→dic
    const cm = rm.cooling.m, hm = rm.heating.m, nm = Math.max(cm.length, hm.length);
    const Y = now.getFullYear();
    for (let i = 0; i < nm; i++) { const yr = Y - 1 + Math.floor(i / 12), mo = (i % 12) + 1; upM.run(yr + '-' + String(mo).padStart(2, '0'), rm.name, cm[i] || 0, hm[i] || 0); }
  }
  db.close();

  const out = { generatedAt: now.toISOString(), unit: 'kWh', tariffDefault: 0.28, rooms };
  fs.writeFileSync(path.join(DATA, 'clima.json'), JSON.stringify(out, null, 2));
  const cool14 = rooms.reduce((s, r) => s + r.cooling.w.reduce((a, b) => a + b, 0), 0);
  console.log(`✅ Clima: ${rooms.length} stanze · cooling 14gg ${cool14.toFixed(1)}kWh · storico aggiornato`);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
