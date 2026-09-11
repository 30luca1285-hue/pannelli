// auto-save.mjs — scritture del tab ⚡ Auto (config, conferma/scarto sessioni, odometro).
// Usato dalle route POST /energia/api/saveAuto* del server SOCIAL. Ogni scrittura rigenera
// data/auto.json così l'app rilegge i numeri aggiornati senza aspettare il cron.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureAutoTables, writeConfig, rigeneraAutoJson } from './auto-lib.mjs';

const apri = () => ensureAutoTables(new DatabaseSync(DB_PATH));

export function saveAutoConfig(params = {}) {
  const cfg = writeConfig(params);
  const db = apri();
  const out = rigeneraAutoJson(db);
  db.close();
  return { ok: true, config: cfg, totali: out.totali };
}

// stato: 'ok' (è davvero l'auto) | 'no' (falso positivo, esclusa dai conti) | 'auto' (torna in dubbio)
export function saveAutoSessione(params = {}) {
  const id = String(params.id || '');
  const stato = ['ok', 'no', 'auto'].includes(params.stato) ? params.stato : 'auto';
  if (!id) throw new Error('id sessione mancante');
  const db = apri();
  const r = db.prepare('UPDATE auto_sessioni SET stato=? WHERE id=?').run(stato, id);
  if (!r.changes) { db.close(); throw new Error('sessione non trovata: ' + id); }
  const out = rigeneraAutoJson(db);
  db.close();
  return { ok: true, id, stato, totali: out.totali };
}

export function saveAutoKm(params = {}) {
  const data = String(params.data || new Date().toISOString().slice(0, 10));
  const odometro = parseFloat(params.odometro);
  if (!odometro || odometro < 0) throw new Error('odometro non valido');
  const db = apri();
  db.prepare(`INSERT INTO auto_km (data,odometro,source,nota) VALUES (?,?,'manuale',?)
    ON CONFLICT(data) DO UPDATE SET odometro=excluded.odometro`)
    .run(data, odometro, `Inserito dall'app il ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  const out = rigeneraAutoJson(db);
  db.close();
  return { ok: true, data, odometro, km_reali: out.totali.km_reali };
}

// Sessione inserita a mano (o importata da WeConnect in futuro): non viene sovrascritta dal detect.
export function saveAutoSessioneManuale(params = {}) {
  const inizio = String(params.inizio || '');
  const kwh = parseFloat(params.kwh);
  if (!inizio || !kwh) throw new Error('inizio e kwh obbligatori');
  const sole = parseFloat(params.kwh_sole) || 0;
  const db = apri();
  db.prepare(`INSERT INTO auto_sessioni (id,inizio,fine,ore,kwh,kwh_sole,kwh_rete,kw_medi,baseline_kw,source,stato,nota)
    VALUES (?,?,?,?,?,?,?,?,0,?,'ok',?)
    ON CONFLICT(id) DO UPDATE SET kwh=excluded.kwh, kwh_sole=excluded.kwh_sole, kwh_rete=excluded.kwh_rete,
      fine=excluded.fine, ore=excluded.ore, source=excluded.source`)
    .run(inizio, inizio, String(params.fine || inizio), parseFloat(params.ore) || 0, kwh, sole,
      Math.max(0, kwh - sole), parseFloat(params.kw_medi) || 0, String(params.source || 'manuale'),
      String(params.nota || ''));
  const out = rigeneraAutoJson(db);
  db.close();
  return { ok: true, inizio, totali: out.totali };
}
