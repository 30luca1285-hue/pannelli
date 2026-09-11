// build-solar-html.mjs — genera data/solar.html dalla grafica v37 (index.html)
// sostituendo SOLO il layer gasGet (Google Apps Script) con letture di solar.json.
// La grafica resta identica byte-per-byte; cambia solo il motore dati sotto.
import fs from 'node:fs';
const DIR = '/Users/lucagalluzzi/Projects/Pannelli';
const src = fs.readFileSync(`${DIR}/index.html`, 'utf8');

const START = '// ===================== APPS SCRIPT API =====================';
const ENDM  = '// ============================================================';
const i = src.indexOf(START);
const j = src.indexOf(ENDM) + ENDM.length;
if (i < 0 || j < ENDM.length) { console.error('❌ marcatori gasGet non trovati'); process.exit(1); }

const SHIM = `// ===================== MOTORE LOCALE (solar.json) =====================
// Sostituisce le chiamate a Google Apps Script con letture del file locale
// prodotto da solar-fetch.mjs. Zero dipendenza da script.google.com => nessun ritardo.
const MESI_IT = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
function ymToAnnoMese(ym){ const p = String(ym).split('-'); return { anno:+p[0], mese:MESI_IT[+p[1]-1] }; }
async function loadSolar(){ const r = await fetch('solar.json?_=' + Date.now()); return await r.json(); }

async function gasGet(action, params = {}) {
  try {
    const s = await loadSolar();
    const M = s.monthly || [];
    switch (action) {
      case 'live':
        return s.live;
      case 'history':
        return (s.live24h && s.live24h.length) ? s.live24h
          : (s.daily || []).map(d => ({ timestamp:d.date, powerpv:0, powerbatt:0, powergrid:0, powerhouse:0, percentbattery:0, energy_pv:d.energy_pv, self_sufficiency:d.self_sufficiency }));
      case 'monthly': // solo mesi realmente misurati dall'inverter (come getDeliosMonthly)
        // ⚠️ 11/09/2026: anche 'delios-auto' è dato dell'inverter (import automatico).
        //    Con l'uguaglianza esatta agosto e settembre restavano fuori dal grafico.
        return M.filter(r => String(r.source || '').startsWith('delios')).map(r => ({ ...ymToAnnoMese(r.ym), produzione:r.produzione, autoconsumo:r.autoconsumo, da_rete:r.da_rete, immessa:r.immessa }));
      case 'loadMensile2026':
        return M.filter(r => r.anno === 2026).map(r => ({ ...ymToAnnoMese(r.ym), produzione:r.produzione, autoconsumo:r.autoconsumo, da_rete:r.da_rete, immessa:r.immessa, kwh_eff:r.kwh_eff, materia:r.materia, gse:r.gse, bolletta:r.bolletta }));
      case 'prices':
        return s.prices || { acquisto:0.18, vendita:0.10 };
      case 'savePrices':
      case 'saveMensile2026': // scrittura: al server locale (endpoint Tappa 2b); best-effort
        try { await fetch('api/' + action, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(params) }); } catch (e) {}
        return { ok:true };
      default:
        return null;
    }
  } catch (e) { console.warn('motore locale [' + action + ']', e); return null; }
}
// ============================================================`;

let out = src.slice(0, i) + SHIM + src.slice(j);
// il salvataggio bolletta/GSE va nel DB via endpoint per OGNI anno (non solo 2026)
out = out.replace('if (parseInt(yr) >= 2026) {', 'if (true) {');
fs.writeFileSync(`${DIR}/data/solar.html`, out);
console.log(`✅ data/solar.html generato (${out.length} byte). gasGet -> solar.json locale.`);
