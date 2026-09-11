// Archivio permanente storico energia (SQLite). Cresce ogni giorno, entra nei backup.
import { DatabaseSync } from 'node:sqlite';

export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS solar_live(
      ts TEXT PRIMARY KEY, powerpv REAL, powerbatt REAL, powergrid REAL,
      powerhouse REAL, percentbattery REAL);
    CREATE TABLE IF NOT EXISTS solar_daily(
      date TEXT PRIMARY KEY, energy_pv REAL, energy_grid_consumed REAL,
      energy_grid_feed_in REAL, energy_powerhouse REAL, energy_battery_char REAL,
      energy_battery_discha REAL, self_sufficiency REAL);
    CREATE TABLE IF NOT EXISTS solar_monthly(
      ym TEXT PRIMARY KEY, produzione REAL, autoconsumo REAL, da_rete REAL,
      immessa REAL, bolletta REAL, costo_kwh REAL, source TEXT);
    CREATE TABLE IF NOT EXISTS clima_daily(
      date TEXT, room TEXT, cooling REAL, heating REAL, PRIMARY KEY(date,room));
    CREATE TABLE IF NOT EXISTS clima_monthly(
      ym TEXT, room TEXT, cooling REAL, heating REAL, PRIMARY KEY(ym,room));
  `);
  // colonne aggiunte dopo la v1 (energia + autosufficienza per i grafici Live 24h) — ALTER idempotente
  for (const col of ['energy_pv REAL', 'self_sufficiency REAL']) {
    try { db.exec(`ALTER TABLE solar_live ADD COLUMN ${col}`); } catch {}
  }
  return db;
}

// helpers data
export const todayStr = (d = new Date()) => d.toISOString().slice(0, 10);
export const ymStr = (d = new Date()) => d.toISOString().slice(0, 7);
export function dateMinus(days, base = new Date()) { const d = new Date(base); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); }
export function ymMinus(months, base = new Date()) { const d = new Date(base.getFullYear(), base.getMonth() - months, 1); return d.toISOString().slice(0, 7); }
