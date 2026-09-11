// migra-storico.mjs — TAPPA 1 migrazione solare
// Popola solar_monthly (oggi vuota) con TUTTO lo storico, replicando la fusione
// di renderMensile() del vecchio index.html, e applica gli inserimenti manuali
// (bollette/GSE) da inserimenti-manuali.json. NON tocca il DB vivo senza --apply.
//
// Uso:  node migra-storico.mjs          -> costruisce storico-prova.db e verifica
//       node migra-storico.mjs --apply  -> (solo dopo OK) applica al DB vivo storico.db
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const DIR   = '/Users/lucagalluzzi/Projects/Pannelli';
const BK    = `${DIR}/backup-storico-2026-07-11`;
const LIVE  = `${DIR}/storico.db`;
const PROVA = `${DIR}/storico-prova.db`;
const APPLY = process.argv.includes('--apply');
const TARGET = APPLY ? LIVE : PROVA;

const MESI = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const mm = (mese) => String(MESI.indexOf(mese) + 1).padStart(2, '0');
const ymOf = (anno, mese) => `${anno}-${mm(mese)}`;

// --- fonti dalla cassaforte ---
const rawData    = JSON.parse(fs.readFileSync(`${BK}/rawData-2022-2025.json`, 'utf8')); // 44 mesi 2022-2025
const foglio2026 = JSON.parse(fs.readFileSync(`${BK}/mensile2026.json`, 'utf8'));       // Gen-Giu 2026 (editabili + kWh foglio)
const delios2026 = JSON.parse(fs.readFileSync(`${BK}/delios-monthly.json`, 'utf8'));    // Feb-Lug 2026 (kWh inverter)
const manuali    = fs.existsSync(`${DIR}/inserimenti-manuali.json`)
  ? JSON.parse(fs.readFileSync(`${DIR}/inserimenti-manuali.json`, 'utf8')) : [];        // bollette/GSE inserite a mano

// ========== COSTRUISCI LE RIGHE FINALI (fusione fedele a renderMensile) ==========
const righe = [];

// 2022-2025 da rawData
// [0]anno [1]mese [2]produzione [3]da_rete [4]legacy [5]immessa [6]autoconsumo [7]auto_val€ [8]kwh_eff [9]materia€ [10]€/kWh
for (const d of rawData) {
  righe.push({ ym: ymOf(d[0], d[1]), anno: d[0], mese: d[1],
    produzione: d[2], autoconsumo: d[6], da_rete: Math.round(d[3]), immessa: d[5],
    kwh_eff: d[8] || 0, materia: d[9] || 0, gse: 0, bolletta: 0,
    auto_val: d[7] || 0, prezzo_kwh: d[10] || 0, legacy4: d[4] || 0, source: 'rawData' });
}

// 2026: kWh dall'inverter Delios (autoritativo, come API), editabili dal foglio; foglio = fallback kWh
const deliosByMese = Object.fromEntries(delios2026.map(d => [d.mese, d]));
const foglioByMese = Object.fromEntries(foglio2026.map(d => [d.mese, d]));
const mesi2026 = [...new Set([...delios2026.map(d => d.mese), ...foglio2026.map(d => d.mese)])]
  .sort((a, b) => MESI.indexOf(a) - MESI.indexOf(b));
for (const mese of mesi2026) {
  const del = deliosByMese[mese];  // kWh inverter
  const fog = foglioByMese[mese];  // editabili + kWh foglio (fallback)
  const kwh = del || fog;
  righe.push({ ym: ymOf(2026, mese), anno: 2026, mese,
    produzione: kwh.produzione, autoconsumo: kwh.autoconsumo, da_rete: Math.round(kwh.da_rete), immessa: kwh.immessa,
    kwh_eff: fog?.kwh_eff || 0, materia: fog?.materia || 0, gse: fog?.gse || 0, bolletta: fog?.bolletta || 0,
    auto_val: 0, prezzo_kwh: 0, legacy4: 0, source: del ? 'delios' : 'foglio2026' });
}

// applica inserimenti manuali (override SOLO dei campi specificati: bollette/GSE)
const CAMPI_MAN = ['kwh_eff', 'materia', 'gse', 'bolletta'];
for (const m of manuali) {
  const r = righe.find(x => x.ym === m.ym);
  if (!r) { console.log(`⚠️  manuale ignorato: ${m.ym} non presente`); continue; }
  for (const c of CAMPI_MAN) if (m[c] !== undefined) r[c] = m[c];
}

// ========== SCRIVI NEL DB ==========
if (!APPLY) fs.copyFileSync(LIVE, PROVA);
const db = new DatabaseSync(TARGET);
db.exec(`
  DROP TABLE IF EXISTS solar_monthly;
  CREATE TABLE solar_monthly(
    ym TEXT PRIMARY KEY, anno INTEGER, mese TEXT,
    produzione REAL, autoconsumo REAL, da_rete REAL, immessa REAL,
    kwh_eff REAL, materia REAL, gse REAL, bolletta REAL,
    auto_val REAL, prezzo_kwh REAL, legacy4 REAL, source TEXT);
`);
const ins = db.prepare(`INSERT OR REPLACE INTO solar_monthly
  (ym,anno,mese,produzione,autoconsumo,da_rete,immessa,kwh_eff,materia,gse,bolletta,auto_val,prezzo_kwh,legacy4,source)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (const r of righe) ins.run(r.ym, r.anno, r.mese, r.produzione, r.autoconsumo, r.da_rete, r.immessa,
  r.kwh_eff, r.materia, r.gse, r.bolletta, r.auto_val, r.prezzo_kwh, r.legacy4, r.source);

console.log(`\nImportati ${righe.length} mesi (${rawData.length} da rawData 2022-25 + ${mesi2026.length} del 2026)`);
console.log(`DB: ${TARGET}${APPLY ? '  ⚠️ VIVO' : '  (copia di prova, vivo intatto)'}\n`);

// ========== VERIFICA: DB riletto vs righe costruite ==========
const round1 = x => Math.round(x * 10) / 10;
const att = {};
for (const r of righe) {
  (att[r.anno] ??= { prod:0,auto:0,imm:0,rete:0,gse:0,materia:0,n:0 });
  const a = att[r.anno];
  a.prod+=r.produzione; a.auto+=r.autoconsumo; a.imm+=r.immessa; a.rete+=r.da_rete; a.gse+=r.gse; a.materia+=r.materia; a.n++;
}
const rows = db.prepare(`SELECT anno, SUM(produzione) prod, SUM(autoconsumo) auto, SUM(immessa) imm,
  SUM(da_rete) rete, SUM(gse) gse, SUM(materia) materia, COUNT(*) n FROM solar_monthly GROUP BY anno ORDER BY anno`).all();

console.log('Anno | mesi |  Produz |  Autoc. | Immessa | Da rete |  GSE€ | Materia€ | ✓');
console.log('-----|------|---------|---------|---------|---------|-------|----------|---');
let ok = true;
for (const r of rows) {
  const a = att[r.anno];
  const good = a && round1(r.prod)===round1(a.prod) && round1(r.auto)===round1(a.auto) && round1(r.imm)===round1(a.imm)
    && round1(r.rete)===round1(a.rete) && round1(r.gse)===round1(a.gse) && round1(r.materia)===round1(a.materia);
  if (!good) ok = false;
  console.log(`${r.anno} |  ${String(r.n).padStart(2)}  | ${String(Math.round(r.prod)).padStart(7)} | ${String(Math.round(r.auto)).padStart(7)} | ${String(Math.round(r.imm)).padStart(7)} | ${String(Math.round(r.rete)).padStart(7)} | ${String(Math.round(r.gse)).padStart(5)} | ${String(Math.round(r.materia)).padStart(8)} | ${good?'✅':'❌'}`);
}
console.log(`\n${ok ? '✅ VERIFICA OK — DB coincide con le fonti + inserimenti manuali' : '❌ DISCREPANZA'}`);

// dettaglio giugno 2026 (mese della bolletta appena inserita)
const g = db.prepare(`SELECT * FROM solar_monthly WHERE ym='2026-06'`).get();
if (g) {
  const eurokwh = g.kwh_eff > 0 ? (g.materia / g.kwh_eff).toFixed(4) : '—';
  const netto = (g.materia - g.gse).toFixed(2);
  console.log(`\n── Giugno 2026 (con bolletta) ──`);
  console.log(`   Produzione ${g.produzione} kWh · Autoconsumo ${g.autoconsumo} · Immessa ${g.immessa} · Da rete ${g.da_rete}  [fonte kWh: ${g.source}]`);
  console.log(`   Bolletta: ${g.kwh_eff} kWh · Materia €${g.materia}  → €/kWh ${eurokwh}`);
  console.log(`   GSE €${g.gse}  →  Netto materia-GSE = €${netto} ${netto<0?'(mese in ATTIVO ✅)':''}`);
}
db.close();
