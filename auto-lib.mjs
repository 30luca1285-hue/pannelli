// auto-lib.mjs — tab ⚡ Auto dell'app Energia (VW ID.3).
// Config, schema tabelle e le due conversioni che contano:
//   kWh -> km  (consumo dichiarato alla presa)
//   km  -> € gasolio evitato (auto sostituita: Discovery 10 km/l)
// Regola contabile (vedi CLAUDE.md / memoria project_app_auto_elettrica):
//   i kWh solari finiti nell'auto sono GIÀ dentro l'autoconsumo dell'ammortamento,
//   valorizzati a €/kWh. Il valore mobilità va contato SOLO come DELTA rispetto a quello,
//   altrimenti lo stesso kWh vale due volte.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(DIR, 'data');
export const DB_PATH = path.join(DIR, 'storico.db');
const CONFIG = path.join(DATA, 'auto-config.json');

// Ripiego usato solo se data/auto-config.json manca o è illeggibile: deve descrivere
// l'auto VERA, altrimenti un file mancante fa tornare i conti a un'auto che non esiste.
// 08/09/2026: era la VW ID.3, ordine poi annullato — al suo posto è arrivata la CUPRA Born.
export const DEFAULT_CONFIG = {
  modello: 'CUPRA Born 204 CV',
  batteria_kwh: 58,
  consumo_kwh_100km: 15,
  wallbox_kw: 6,
  data_inizio: '2026-08-25',
  auto_sostituita: 'Land Rover Discovery',
  km_litro_sostituita: 10,
  prezzo_gasolio: 1.75,
  soglia_kw: 4.0,
  gradino_kw: 3.5,
  campioni_min: 3,
};

export function readConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

export function writeConfig(patch = {}) {
  const cfg = { ...readConfig() };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_CONFIG)) continue;
    cfg[k] = typeof DEFAULT_CONFIG[k] === 'number' ? (parseFloat(v) || DEFAULT_CONFIG[k]) : String(v);
  }
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  return cfg;
}

// --- conversioni ---
export const kmPerKwh = (cfg) => 100 / (cfg.consumo_kwh_100km || DEFAULT_CONFIG.consumo_kwh_100km);
// quanto vale UN kWh messo nell'auto, in gasolio non comprato
export const gasolioPerKwh = (cfg) =>
  (kmPerKwh(cfg) / (cfg.km_litro_sostituita || 10)) * (cfg.prezzo_gasolio || 1.75);
export const gasolioPerKm = (cfg) => (cfg.prezzo_gasolio || 1.75) / (cfg.km_litro_sostituita || 10);

// --- schema (idempotente) ---
export function ensureAutoTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_sessioni(
      id TEXT PRIMARY KEY,          -- ts di inizio, 'YYYY-MM-DD HH:MM:SS'
      inizio TEXT, fine TEXT, ore REAL,
      kwh REAL,                     -- kWh totali della ricarica (alla presa)
      kwh_sole REAL, kwh_rete REAL, -- ripartizione dal Delios nell'istante della carica
      kw_medi REAL, baseline_kw REAL,
      source TEXT,                  -- 'stima' (plateau Delios) | 'vw' (WeConnect) | 'manuale'
      stato TEXT DEFAULT 'auto',    -- 'auto' | 'ok' (confermata da Luca) | 'no' (scartata)
      nota TEXT);
    CREATE TABLE IF NOT EXISTS auto_km(
      data TEXT PRIMARY KEY, odometro REAL, source TEXT, nota TEXT);
  `);
  return db;
}

// Consumo REALE misurato: kWh caricati fra due letture del contachilometri / km percorsi.
// È il pezzo che rende superflua l'app Volkswagen — i km li dà il cruscotto, il resto si tara da solo.
export function consumoReale(sessioni, kmLog) {
  if (!kmLog || kmLog.length < 2) return null;
  const primo = kmLog[0], ultimo = kmLog[kmLog.length - 1];
  const kmFatti = (ultimo.odometro || 0) - (primo.odometro || 0);
  if (kmFatti < 200) return null;   // sotto i 200 km il dato è troppo ballerino per fidarsi
  const kwh = sessioni
    .filter((s) => s.inizio.slice(0, 10) > primo.data && s.inizio.slice(0, 10) <= ultimo.data)
    .reduce((a, s) => a + (s.kwh || 0), 0);
  if (kwh <= 0) return null;
  const v = +(kwh / kmFatti * 100).toFixed(1);
  const base = { kwh_100km: v, km: kmFatti, kwh: +kwh.toFixed(1), da: primo.data, a: ultimo.data };

  // ⚠️ guard-rail: se ha caricato FUORI casa (colonnina pubblica, amici) quei kWh non li misura
  // nessuno ma i km sì → il consumo risulta assurdamente basso e gonfierebbe km e gasolio evitato.
  // Fuori dalla forbice plausibile per una ID.3 (12-26 kWh/100 km alla presa) non si tara: si segnala.
  if (v < 12) return { ...base, valido: false, motivo: 'mancano dei kWh: hai caricato fuori casa?' };
  if (v > 26) return { ...base, valido: false, motivo: 'consumo troppo alto: qualche ricarica potrebbe essere contata due volte' };
  return { ...base, valido: true };
}

// Una sessione con tutti i numeri derivati (km, €, risparmio) calcolati dalla config.
// kmPerKwhEff: se il consumo reale è già stato misurato, batte quello dichiarato in config.
export function arricchisci(s, cfg, prezzoEnergia = 0.18, kmPerKwhEff = null) {
  const kwh = s.kwh || 0, sole = s.kwh_sole || 0, rete = s.kwh_rete || 0;
  const km = kwh * (kmPerKwhEff || kmPerKwh(cfg));
  const costo = rete * prezzoEnergia;              // il sole non si paga
  const gasolio = km * gasolioPerKm(cfg);          // quanto sarebbe costato con la Discovery
  return {
    ...s, km,
    costo_ricarica: costo,
    gasolio_evitato: gasolio,
    risparmio: gasolio - costo,
    // quota che spetta all'IMPIANTO nella barra ammortamento: solo i kWh solari,
    // e solo per la parte che eccede il valore già contato come autoconsumo
    delta_ammortamento: sole * Math.max(0, (kwh > 0 ? gasolio / kwh : gasolioPerKwh(cfg)) - prezzoEnergia),
  };
}

export const somma = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);

// Ricostruisce data/auto.json da quello che c'è nel DB (NON rileva: quello è auto-detect.mjs).
// Serve anche agli endpoint di salvataggio: cambiare il prezzo del gasolio deve aggiornare
// i numeri subito, senza aspettare il cron.
export function rigeneraAutoJson(dbIn) {
  const db = dbIn || ensureAutoTables(new DatabaseSync(DB_PATH));
  const cfg = readConfig();
  let prices = { acquisto: 0.18, vendita: 0.10 };
  try { prices = JSON.parse(fs.readFileSync(path.join(DATA, 'prezzi.json'), 'utf8')); } catch {}

  const mesiDb = db.prepare('SELECT ym, kwh_eff, materia FROM solar_monthly').all();
  const prezzoMese = (ym) => {
    const m = mesiDb.find((x) => x.ym === ym);
    return (m && m.kwh_eff > 0 && m.materia > 0) ? m.materia / m.kwh_eff : prices.acquisto;
  };

  const grezze = db.prepare("SELECT * FROM auto_sessioni WHERE stato != 'no' ORDER BY inizio").all();
  const scartate = db.prepare("SELECT COUNT(*) c FROM auto_sessioni WHERE stato='no'").get().c;
  const km = db.prepare('SELECT * FROM auto_km ORDER BY data').all();

  // se il consumo reale è stato misurato (2+ letture del contachilometri), vince sul dichiarato
  const reale = consumoReale(grezze, km);
  const kmPerKwhEff = (reale && reale.valido) ? 100 / reale.kwh_100km : null;
  const tutte = grezze.map((s) => arricchisci(s, cfg, prezzoMese(s.inizio.slice(0, 7)), kmPerKwhEff));

  const perMese = {};
  for (const s of tutte) {
    const ym = s.inizio.slice(0, 7);
    const m = perMese[ym] || (perMese[ym] = { ym, ricariche: 0, kwh: 0, kwh_sole: 0, kwh_rete: 0, km: 0, costo: 0, gasolio: 0, risparmio: 0, delta_ammortamento: 0 });
    m.ricariche++; m.kwh += s.kwh; m.kwh_sole += s.kwh_sole; m.kwh_rete += s.kwh_rete;
    m.km += s.km; m.costo += s.costo_ricarica; m.gasolio += s.gasolio_evitato;
    m.risparmio += s.risparmio; m.delta_ammortamento += s.delta_ammortamento;
  }

  const kmReali = km.length >= 2 ? km[km.length - 1].odometro - km[0].odometro : null;
  const out = {
    generatedAt: new Date().toISOString(),
    config: cfg,
    prezzi: prices,
    conversioni: {
      km_per_kwh: +(kmPerKwhEff || kmPerKwh(cfg)).toFixed(2),
      gasolio_per_kwh: +((kmPerKwhEff || kmPerKwh(cfg)) / (cfg.km_litro_sostituita || 10) * (cfg.prezzo_gasolio || 1.75)).toFixed(3),
      gasolio_per_km: +gasolioPerKm(cfg).toFixed(3),
      prezzo_energia: prices.acquisto,
      misurato: !!reale,   // true = consumo tarato sui km veri, non sul valore dichiarato
    },
    consumo_reale: reale,
    totali: {
      ricariche: tutte.length,
      kwh: +somma(tutte, 'kwh').toFixed(1),
      kwh_sole: +somma(tutte, 'kwh_sole').toFixed(1),
      kwh_rete: +somma(tutte, 'kwh_rete').toFixed(1),
      quota_sole: tutte.length ? +(somma(tutte, 'kwh_sole') / (somma(tutte, 'kwh') || 1) * 100).toFixed(0) : 0,
      km: +somma(tutte, 'km').toFixed(0),
      km_reali: kmReali,
      costo: +somma(tutte, 'costo_ricarica').toFixed(2),
      gasolio_evitato: +somma(tutte, 'gasolio_evitato').toFixed(2),
      risparmio: +somma(tutte, 'risparmio').toFixed(2),
      delta_ammortamento: +somma(tutte, 'delta_ammortamento').toFixed(2),
      scartate,
    },
    mesi: Object.values(perMese).sort((a, b) => a.ym.localeCompare(b.ym)),
    sessioni: tutte.slice(-60).reverse(),
    km_log: km,
  };
  fs.writeFileSync(path.join(DATA, 'auto.json'), JSON.stringify(out, null, 2));
  if (!dbIn) db.close();
  return out;
}
