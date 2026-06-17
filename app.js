'use strict';

/* ═══════════════════════════════════════════════════════════
   Zinc Anode Inspector — Application Logic (Electron)
   ─────────────────────────────────────────────────────────
   Sections (use Cmd+F to jump):
     CONFIG          — vessels, programs, checklist, anode layout
     DATABASE        — IndexedDB read/write (all local)
     ELECTRON BRIDGE — native OS features (file dialogs, PDF, notifications)
     STATE           — app state variables
     MAP PAGE        — keel SVG map, section tabs, anode panel
     INSPECT PAGE    — 3-step inspection wizard (steps 1–3)
     RECORDS PAGE    — browse, view, delete saved inspections
     STATS PAGE      — pass/fail analysis by section and side
     PRINT / PDF     — native PDF export via Electron
     EXPORT/IMPORT   — JSON backup and restore (native file dialogs)
     BOOT            — database open, menu listeners, first render
═══════════════════════════════════════════════════════════ */

/* ══════════ WEB APP MODE ══════════ */
const IS_ELECTRON = false;


/* ════════════════════════════════════════════════════════
   ANODE LAYOUT — derived from Section_Maping.pdf (AutoCAD)
   Vessel keel top-down view: AFT (left) → FWD (right)
   PORT = top half,  STARBOARD = bottom half
   5 sections × 60 anodes = 300 total anodes

   Per section, Port side (30 anodes):
     Outer top row:     P01–P06  (2 corners + 4 spaced)
     AFT outer mid:     P07
     FWD outer mid:     P08
     Inner upper band:  P09–P12  (4 anodes)
     Inner lower band:  P13–P16  (4 anodes)
     AFT lower outer:   P17
     FWD lower outer:   P18
     Keel edge dense:   P19–P30  (12 anodes, full span)

   Starboard = mirror: S01–S30
   ════════════════════════════════════════════════════════ */

const SECTIONS  = [1,2,3,4,5];
const VESSELS   = ['Vessel A','Vessel B','Vessel C','Vessel D'];
const PROGRAMS  = ['Maintenance Program 1','Maintenance Program 2','Maintenance Program 3','Maintenance Program 4'];

const CHECKLIST = [
  {id:'c1',text:'Remaining material ≥ 50%',     critical:true},
  {id:'c2',text:'No core metal exposed',          critical:true},
  {id:'c3',text:'No knife-edge or spike shape',   critical:true},
  {id:'c4',text:'Surface condition acceptable',   critical:false},
  {id:'c5',text:'Mounting bracket secure',        critical:false},
  {id:'c6',text:'Electrical contact confirmed',   critical:false},
  {id:'c7',text:'No unusual pitting or cracking', critical:false},
];

/* Build anode definitions for one section */
function mkAnodes(sec){
  const pad=n=>String(n).padStart(2,'0');
  const port=[
    {id:`S${sec}-P01`,side:'PORT',row:'outer-top',  seq:1},
    {id:`S${sec}-P02`,side:'PORT',row:'outer-top',  seq:2},
    {id:`S${sec}-P03`,side:'PORT',row:'outer-top',  seq:3},
    {id:`S${sec}-P04`,side:'PORT',row:'outer-top',  seq:4},
    {id:`S${sec}-P05`,side:'PORT',row:'outer-top',  seq:5},
    {id:`S${sec}-P06`,side:'PORT',row:'outer-top',  seq:6},
    {id:`S${sec}-P07`,side:'PORT',row:'mid-aft',    seq:1},
    {id:`S${sec}-P08`,side:'PORT',row:'mid-fwd',    seq:1},
    {id:`S${sec}-P09`,side:'PORT',row:'inner-upper',seq:1},
    {id:`S${sec}-P10`,side:'PORT',row:'inner-upper',seq:2},
    {id:`S${sec}-P11`,side:'PORT',row:'inner-upper',seq:3},
    {id:`S${sec}-P12`,side:'PORT',row:'inner-upper',seq:4},
    {id:`S${sec}-P13`,side:'PORT',row:'inner-lower',seq:1},
    {id:`S${sec}-P14`,side:'PORT',row:'inner-lower',seq:2},
    {id:`S${sec}-P15`,side:'PORT',row:'inner-lower',seq:3},
    {id:`S${sec}-P16`,side:'PORT',row:'inner-lower',seq:4},
    {id:`S${sec}-P17`,side:'PORT',row:'low-aft',    seq:1},
    {id:`S${sec}-P18`,side:'PORT',row:'low-fwd',    seq:1},
    ...[...Array(12)].map((_,i)=>({id:`S${sec}-P${pad(19+i)}`,side:'PORT',row:'keel-edge',seq:i+1})),
  ];
  const stbd=port.map((a,i)=>({
    ...a, id:`S${sec}-S${pad(i+1)}`, side:'STBD',
  }));
  return [...port,...stbd];
}

const ALL = {};
SECTIONS.forEach(s=>{ALL[s]=mkAnodes(s);});

/* ══════════ DATABASE ══════════ */
let db, inspections=[];
function openDB(){return new Promise((res,rej)=>{
  const req=indexedDB.open('ZincAnodeDB',4);
  req.onupgradeneeded=e=>{const d=e.target.result;if(!d.objectStoreNames.contains('inspections'))d.createObjectStore('inspections',{keyPath:'id'});};
  req.onsuccess=e=>{db=e.target.result;res();};req.onerror=rej;
});}
const dbAll=()=>new Promise((res,rej)=>{const r=db.transaction('inspections','readonly').objectStore('inspections').getAll();r.onsuccess=()=>res(r.result);r.onerror=rej;});
const dbPut=o=>new Promise((res,rej)=>{const r=db.transaction('inspections','readwrite').objectStore('inspections').put(o);r.onsuccess=res;r.onerror=rej;});
const dbDel=id=>new Promise((res,rej)=>{const r=db.transaction('inspections','readwrite').objectStore('inspections').delete(id);r.onsuccess=res;r.onerror=rej;});



/* ══════════ STATE ══════════ */
let page='session', activeSection=1, INS={}, step=1;
const OLLAMA_URL = 'http://localhost:11434';
let ollamaOK = false;
let ollamaModels = [];

async function pingOllama(){
  try{
    const r=await fetch(OLLAMA_URL+'/api/tags',{signal:AbortSignal.timeout(2000)});
    const d=await r.json();
    const all=(d.models||[]).map(m=>m.name);
    const vision=all.filter(m=>/llava|moondream|bakllava|minicpm|cogvlm/i.test(m));
    ollamaModels = vision.length ? vision : all;
    ollamaOK = ollamaModels.length > 0;
  } catch { ollamaOK=false; ollamaModels=[]; }
  return ollamaModels;
}



/* ══════════ PASSWORD ══════════
   To change the password:
   1. Go to https://emn178.github.io/online-tools/sha256.html
   2. Type your new password and copy the hash
   3. Replace the PASS_HASH value below
   Current password: Inspector2026
   ════════════════════════════ */
const PASS_HASH = '2ebfcbb9e3bf93091ed82632923f3ff322aceffb153de497a57a090195866326';
let authenticated = false;

/* Session defaults — persisted across inspections within the same session.
   Stored in localStorage so they survive app restarts too. */
function loadSession(){
  try { return JSON.parse(localStorage.getItem('zai_session')||'{}'); }
  catch { return {}; }
}
function saveSession(data){
  try { localStorage.setItem('zai_session', JSON.stringify(data)); }
  catch {}
}
let SESSION = loadSession(); // {vessel, program, inspector, date}
// Map display settings
let mapFontSize = 8;     // anode ID font size (px)
let mapBoxScale = 1.0;   // hotspot box size multiplier
let mapLegendSize = 12;  // legend dot size (px)
let mapLegendFont = 11;  // legend text size (px)

let calibrateMode=false, calibrateSelected=null, calibrateOffsets={
  'S1-P01': {dx:200, dy:-58, dw:9, dh:20},
  'S1-P02': {dx:176, dy:-58, dw:9, dh:19},
  'S1-P03': {dx:146, dy:-58, dw:8, dh:19},
  'S1-P04': {dx:166, dy:-58, dw:8, dh:19},
  'S1-P05': {dx:-747, dy:50, dw:8, dh:20},
  'S1-P06': {dx:-892, dy:322, dw:8, dh:20},
  'S1-P07': {dx:893, dy:-145, dw:20, dh:8},
  'S1-P08': {dx:-77, dy:127, dw:20, dh:8},
  'S1-P09': {dx:35, dy:-186, dw:8, dh:20},
  'S1-P10': {dx:16, dy:-186, dw:8, dh:20},
  'S1-P11': {dx:-4, dy:-186, dw:8, dh:20},
  'S1-P12': {dx:-24, dy:-186, dw:8, dh:20},
  'S1-P13': {dx:35, dy:-211, dw:8, dh:20},
  'S1-P14': {dx:16, dy:-212, dw:8, dh:20},
  'S1-P15': {dx:-4, dy:-212, dw:8, dh:20},
  'S1-P16': {dx:-24, dy:-212, dw:8, dh:20},
  'S1-P17': {dx:132, dy:-5, dw:20, dh:8},
  'S1-P18': {dx:-783, dy:-5, dw:20, dh:8},
  'S1-P19': {dx:242, dy:-49, dw:10, dh:25},
  'S1-P20': {dx:208, dy:-49, dw:10, dh:25},
  'S1-P21': {dx:174, dy:-49, dw:10, dh:25},
  'S1-P22': {dx:140, dy:-49, dw:10, dh:25},
  'S1-P23': {dx:106, dy:-49, dw:10, dh:25},
  'S1-P24': {dx:72, dy:-49, dw:10, dh:25},
  'S1-P25': {dx:38, dy:-49, dw:10, dh:25},
  'S1-P26': {dx:4, dy:-49, dw:10, dh:25},
  'S1-P27': {dx:-30, dy:-49, dw:10, dh:25},
  'S1-P28': {dx:-64, dy:-49, dw:10, dh:25},
  'S1-P29': {dx:-98, dy:-49, dw:10, dh:25},
  'S1-P30': {dx:-132, dy:-49, dw:10, dh:25},
  'S1-S01': {dx:200, dy:62, dw:8, dh:20},
  'S1-S02': {dx:176, dy:62, dw:8, dh:20},
  'S1-S03': {dx:146, dy:62, dw:8, dh:20},
  'S1-S04': {dx:166, dy:62, dw:8, dh:20},
  'S1-S05': {dx:-747, dy:-318, dw:8, dh:20},
  'S1-S06': {dx:-892, dy:-46, dw:8, dh:20},
  'S1-S07': {dx:893, dy:-113, dw:20, dh:6},
  'S1-S08': {dx:-77, dy:159, dw:19, dh:7},
  'S1-S09': {dx:35, dy:185, dw:8, dh:20},
  'S1-S10': {dx:16, dy:185, dw:8, dh:20},
  'S1-S11': {dx:-4, dy:185, dw:8, dh:20},
  'S1-S12': {dx:-24, dy:185, dw:8, dh:20},
  'S1-S13': {dx:35, dy:211, dw:8, dh:20},
  'S1-S14': {dx:16, dy:211, dw:8, dh:20},
  'S1-S15': {dx:-4, dy:211, dw:8, dh:20},
  'S1-S16': {dx:-24, dy:211, dw:8, dh:20},
  'S1-S17': {dx:133, dy:9, dw:20, dh:8},
  'S1-S18': {dx:-783, dy:9, dw:20, dh:8},
  'S1-S19': {dx:241, dy:49, dw:10, dh:25},
  'S1-S20': {dx:208, dy:49, dw:10, dh:25},
  'S1-S21': {dx:173, dy:49, dw:10, dh:25},
  'S1-S22': {dx:139, dy:49, dw:10, dh:25},
  'S1-S23': {dx:105, dy:49, dw:10, dh:25},
  'S1-S24': {dx:72, dy:49, dw:10, dh:25},
  'S1-S25': {dx:38, dy:49, dw:10, dh:25},
  'S1-S26': {dx:4, dy:49, dw:10, dh:25},
  'S1-S27': {dx:-30, dy:49, dw:10, dh:25},
  'S1-S28': {dx:-64, dy:49, dw:10, dh:25},
  'S1-S29': {dx:-97, dy:49, dw:10, dh:25},
  'S1-S30': {dx:-131, dy:49, dw:10, dh:25},
  'S2-P01': {dx:200, dy:-58, dw:9, dh:20},
  'S2-P02': {dx:176, dy:-58, dw:9, dh:19},
  'S2-P03': {dx:146, dy:-58, dw:8, dh:19},
  'S2-P04': {dx:166, dy:-58, dw:8, dh:19},
  'S2-P05': {dx:-747, dy:50, dw:8, dh:20},
  'S2-P06': {dx:-892, dy:322, dw:8, dh:20},
  'S2-P07': {dx:893, dy:-145, dw:20, dh:8},
  'S2-P08': {dx:-77, dy:127, dw:20, dh:8},
  'S2-P09': {dx:35, dy:-186, dw:8, dh:20},
  'S2-P10': {dx:16, dy:-186, dw:8, dh:20},
  'S2-P11': {dx:-4, dy:-186, dw:8, dh:20},
  'S2-P12': {dx:-24, dy:-186, dw:8, dh:20},
  'S2-P13': {dx:35, dy:-211, dw:8, dh:20},
  'S2-P14': {dx:16, dy:-212, dw:8, dh:20},
  'S2-P15': {dx:-4, dy:-212, dw:8, dh:20},
  'S2-P16': {dx:-24, dy:-212, dw:8, dh:20},
  'S2-P17': {dx:132, dy:-5, dw:20, dh:8},
  'S2-P18': {dx:-783, dy:-5, dw:20, dh:8},
  'S2-P19': {dx:242, dy:-49, dw:10, dh:25},
  'S2-P20': {dx:208, dy:-49, dw:10, dh:25},
  'S2-P21': {dx:174, dy:-49, dw:10, dh:25},
  'S2-P22': {dx:140, dy:-49, dw:10, dh:25},
  'S2-P23': {dx:106, dy:-49, dw:10, dh:25},
  'S2-P24': {dx:72, dy:-49, dw:10, dh:25},
  'S2-P25': {dx:38, dy:-49, dw:10, dh:25},
  'S2-P26': {dx:4, dy:-49, dw:10, dh:25},
  'S2-P27': {dx:-30, dy:-49, dw:10, dh:25},
  'S2-P28': {dx:-64, dy:-49, dw:10, dh:25},
  'S2-P29': {dx:-98, dy:-49, dw:10, dh:25},
  'S2-P30': {dx:-132, dy:-49, dw:10, dh:25},
  'S2-S01': {dx:200, dy:62, dw:8, dh:20},
  'S2-S02': {dx:176, dy:62, dw:8, dh:20},
  'S2-S03': {dx:146, dy:62, dw:8, dh:20},
  'S2-S04': {dx:166, dy:62, dw:8, dh:20},
  'S2-S05': {dx:-747, dy:-318, dw:8, dh:20},
  'S2-S06': {dx:-892, dy:-46, dw:8, dh:20},
  'S2-S07': {dx:893, dy:-113, dw:20, dh:6},
  'S2-S08': {dx:-77, dy:159, dw:19, dh:7},
  'S2-S09': {dx:35, dy:185, dw:8, dh:20},
  'S2-S10': {dx:16, dy:185, dw:8, dh:20},
  'S2-S11': {dx:-4, dy:185, dw:8, dh:20},
  'S2-S12': {dx:-24, dy:185, dw:8, dh:20},
  'S2-S13': {dx:35, dy:211, dw:8, dh:20},
  'S2-S14': {dx:16, dy:211, dw:8, dh:20},
  'S2-S15': {dx:-4, dy:211, dw:8, dh:20},
  'S2-S16': {dx:-24, dy:211, dw:8, dh:20},
  'S2-S17': {dx:133, dy:9, dw:20, dh:8},
  'S2-S18': {dx:-783, dy:9, dw:20, dh:8},
  'S2-S19': {dx:241, dy:49, dw:10, dh:25},
  'S2-S20': {dx:208, dy:49, dw:10, dh:25},
  'S2-S21': {dx:173, dy:49, dw:10, dh:25},
  'S2-S22': {dx:139, dy:49, dw:10, dh:25},
  'S2-S23': {dx:105, dy:49, dw:10, dh:25},
  'S2-S24': {dx:72, dy:49, dw:10, dh:25},
  'S2-S25': {dx:38, dy:49, dw:10, dh:25},
  'S2-S26': {dx:4, dy:49, dw:10, dh:25},
  'S2-S27': {dx:-30, dy:49, dw:10, dh:25},
  'S2-S28': {dx:-64, dy:49, dw:10, dh:25},
  'S2-S29': {dx:-97, dy:49, dw:10, dh:25},
  'S2-S30': {dx:-131, dy:49, dw:10, dh:25},
  'S3-P01': {dx:200, dy:-58, dw:9, dh:20},
  'S3-P02': {dx:176, dy:-58, dw:9, dh:19},
  'S3-P03': {dx:146, dy:-58, dw:8, dh:19},
  'S3-P04': {dx:166, dy:-58, dw:8, dh:19},
  'S3-P05': {dx:-747, dy:50, dw:8, dh:20},
  'S3-P06': {dx:-892, dy:322, dw:8, dh:20},
  'S3-P07': {dx:893, dy:-145, dw:20, dh:8},
  'S3-P08': {dx:-77, dy:127, dw:20, dh:8},
  'S3-P09': {dx:35, dy:-186, dw:8, dh:20},
  'S3-P10': {dx:16, dy:-186, dw:8, dh:20},
  'S3-P11': {dx:-4, dy:-186, dw:8, dh:20},
  'S3-P12': {dx:-24, dy:-186, dw:8, dh:20},
  'S3-P13': {dx:35, dy:-211, dw:8, dh:20},
  'S3-P14': {dx:16, dy:-212, dw:8, dh:20},
  'S3-P15': {dx:-4, dy:-212, dw:8, dh:20},
  'S3-P16': {dx:-24, dy:-212, dw:8, dh:20},
  'S3-P17': {dx:132, dy:-5, dw:20, dh:8},
  'S3-P18': {dx:-783, dy:-5, dw:20, dh:8},
  'S3-P19': {dx:242, dy:-49, dw:10, dh:25},
  'S3-P20': {dx:208, dy:-49, dw:10, dh:25},
  'S3-P21': {dx:174, dy:-49, dw:10, dh:25},
  'S3-P22': {dx:140, dy:-49, dw:10, dh:25},
  'S3-P23': {dx:106, dy:-49, dw:10, dh:25},
  'S3-P24': {dx:72, dy:-49, dw:10, dh:25},
  'S3-P25': {dx:38, dy:-49, dw:10, dh:25},
  'S3-P26': {dx:4, dy:-49, dw:10, dh:25},
  'S3-P27': {dx:-30, dy:-49, dw:10, dh:25},
  'S3-P28': {dx:-64, dy:-49, dw:10, dh:25},
  'S3-P29': {dx:-98, dy:-49, dw:10, dh:25},
  'S3-P30': {dx:-132, dy:-49, dw:10, dh:25},
  'S3-S01': {dx:200, dy:62, dw:8, dh:20},
  'S3-S02': {dx:176, dy:62, dw:8, dh:20},
  'S3-S03': {dx:146, dy:62, dw:8, dh:20},
  'S3-S04': {dx:166, dy:62, dw:8, dh:20},
  'S3-S05': {dx:-747, dy:-318, dw:8, dh:20},
  'S3-S06': {dx:-892, dy:-46, dw:8, dh:20},
  'S3-S07': {dx:893, dy:-113, dw:20, dh:6},
  'S3-S08': {dx:-77, dy:159, dw:19, dh:7},
  'S3-S09': {dx:35, dy:185, dw:8, dh:20},
  'S3-S10': {dx:16, dy:185, dw:8, dh:20},
  'S3-S11': {dx:-4, dy:185, dw:8, dh:20},
  'S3-S12': {dx:-24, dy:185, dw:8, dh:20},
  'S3-S13': {dx:35, dy:211, dw:8, dh:20},
  'S3-S14': {dx:16, dy:211, dw:8, dh:20},
  'S3-S15': {dx:-4, dy:211, dw:8, dh:20},
  'S3-S16': {dx:-24, dy:211, dw:8, dh:20},
  'S3-S17': {dx:133, dy:9, dw:20, dh:8},
  'S3-S18': {dx:-783, dy:9, dw:20, dh:8},
  'S3-S19': {dx:241, dy:49, dw:10, dh:25},
  'S3-S20': {dx:208, dy:49, dw:10, dh:25},
  'S3-S21': {dx:173, dy:49, dw:10, dh:25},
  'S3-S22': {dx:139, dy:49, dw:10, dh:25},
  'S3-S23': {dx:105, dy:49, dw:10, dh:25},
  'S3-S24': {dx:72, dy:49, dw:10, dh:25},
  'S3-S25': {dx:38, dy:49, dw:10, dh:25},
  'S3-S26': {dx:4, dy:49, dw:10, dh:25},
  'S3-S27': {dx:-30, dy:49, dw:10, dh:25},
  'S3-S28': {dx:-64, dy:49, dw:10, dh:25},
  'S3-S29': {dx:-97, dy:49, dw:10, dh:25},
  'S3-S30': {dx:-131, dy:49, dw:10, dh:25},
  'S4-P01': {dx:200, dy:-58, dw:9, dh:20},
  'S4-P02': {dx:176, dy:-58, dw:9, dh:19},
  'S4-P03': {dx:146, dy:-58, dw:8, dh:19},
  'S4-P04': {dx:166, dy:-58, dw:8, dh:19},
  'S4-P05': {dx:-747, dy:50, dw:8, dh:20},
  'S4-P06': {dx:-892, dy:322, dw:8, dh:20},
  'S4-P07': {dx:893, dy:-145, dw:20, dh:8},
  'S4-P08': {dx:-77, dy:127, dw:20, dh:8},
  'S4-P09': {dx:35, dy:-186, dw:8, dh:20},
  'S4-P10': {dx:16, dy:-186, dw:8, dh:20},
  'S4-P11': {dx:-4, dy:-186, dw:8, dh:20},
  'S4-P12': {dx:-24, dy:-186, dw:8, dh:20},
  'S4-P13': {dx:35, dy:-211, dw:8, dh:20},
  'S4-P14': {dx:16, dy:-212, dw:8, dh:20},
  'S4-P15': {dx:-4, dy:-212, dw:8, dh:20},
  'S4-P16': {dx:-24, dy:-212, dw:8, dh:20},
  'S4-P17': {dx:132, dy:-5, dw:20, dh:8},
  'S4-P18': {dx:-783, dy:-5, dw:20, dh:8},
  'S4-P19': {dx:242, dy:-49, dw:10, dh:25},
  'S4-P20': {dx:208, dy:-49, dw:10, dh:25},
  'S4-P21': {dx:174, dy:-49, dw:10, dh:25},
  'S4-P22': {dx:140, dy:-49, dw:10, dh:25},
  'S4-P23': {dx:106, dy:-49, dw:10, dh:25},
  'S4-P24': {dx:72, dy:-49, dw:10, dh:25},
  'S4-P25': {dx:38, dy:-49, dw:10, dh:25},
  'S4-P26': {dx:4, dy:-49, dw:10, dh:25},
  'S4-P27': {dx:-30, dy:-49, dw:10, dh:25},
  'S4-P28': {dx:-64, dy:-49, dw:10, dh:25},
  'S4-P29': {dx:-98, dy:-49, dw:10, dh:25},
  'S4-P30': {dx:-132, dy:-49, dw:10, dh:25},
  'S4-S01': {dx:200, dy:62, dw:8, dh:20},
  'S4-S02': {dx:176, dy:62, dw:8, dh:20},
  'S4-S03': {dx:146, dy:62, dw:8, dh:20},
  'S4-S04': {dx:166, dy:62, dw:8, dh:20},
  'S4-S05': {dx:-747, dy:-318, dw:8, dh:20},
  'S4-S06': {dx:-892, dy:-46, dw:8, dh:20},
  'S4-S07': {dx:893, dy:-113, dw:20, dh:6},
  'S4-S08': {dx:-77, dy:159, dw:19, dh:7},
  'S4-S09': {dx:35, dy:185, dw:8, dh:20},
  'S4-S10': {dx:16, dy:185, dw:8, dh:20},
  'S4-S11': {dx:-4, dy:185, dw:8, dh:20},
  'S4-S12': {dx:-24, dy:185, dw:8, dh:20},
  'S4-S13': {dx:35, dy:211, dw:8, dh:20},
  'S4-S14': {dx:16, dy:211, dw:8, dh:20},
  'S4-S15': {dx:-4, dy:211, dw:8, dh:20},
  'S4-S16': {dx:-24, dy:211, dw:8, dh:20},
  'S4-S17': {dx:133, dy:9, dw:20, dh:8},
  'S4-S18': {dx:-783, dy:9, dw:20, dh:8},
  'S4-S19': {dx:241, dy:49, dw:10, dh:25},
  'S4-S20': {dx:208, dy:49, dw:10, dh:25},
  'S4-S21': {dx:173, dy:49, dw:10, dh:25},
  'S4-S22': {dx:139, dy:49, dw:10, dh:25},
  'S4-S23': {dx:105, dy:49, dw:10, dh:25},
  'S4-S24': {dx:72, dy:49, dw:10, dh:25},
  'S4-S25': {dx:38, dy:49, dw:10, dh:25},
  'S4-S26': {dx:4, dy:49, dw:10, dh:25},
  'S4-S27': {dx:-30, dy:49, dw:10, dh:25},
  'S4-S28': {dx:-64, dy:49, dw:10, dh:25},
  'S4-S29': {dx:-97, dy:49, dw:10, dh:25},
  'S4-S30': {dx:-131, dy:49, dw:10, dh:25},
  'S5-P01': {dx:200, dy:-58, dw:9, dh:20},
  'S5-P02': {dx:176, dy:-58, dw:9, dh:19},
  'S5-P03': {dx:146, dy:-58, dw:8, dh:19},
  'S5-P04': {dx:166, dy:-58, dw:8, dh:19},
  'S5-P05': {dx:-747, dy:50, dw:8, dh:20},
  'S5-P06': {dx:-892, dy:322, dw:8, dh:20},
  'S5-P07': {dx:893, dy:-145, dw:20, dh:8},
  'S5-P08': {dx:-77, dy:127, dw:20, dh:8},
  'S5-P09': {dx:35, dy:-186, dw:8, dh:20},
  'S5-P10': {dx:16, dy:-186, dw:8, dh:20},
  'S5-P11': {dx:-4, dy:-186, dw:8, dh:20},
  'S5-P12': {dx:-24, dy:-186, dw:8, dh:20},
  'S5-P13': {dx:35, dy:-211, dw:8, dh:20},
  'S5-P14': {dx:16, dy:-212, dw:8, dh:20},
  'S5-P15': {dx:-4, dy:-212, dw:8, dh:20},
  'S5-P16': {dx:-24, dy:-212, dw:8, dh:20},
  'S5-P17': {dx:132, dy:-5, dw:20, dh:8},
  'S5-P18': {dx:-783, dy:-5, dw:20, dh:8},
  'S5-P19': {dx:242, dy:-49, dw:10, dh:25},
  'S5-P20': {dx:208, dy:-49, dw:10, dh:25},
  'S5-P21': {dx:174, dy:-49, dw:10, dh:25},
  'S5-P22': {dx:140, dy:-49, dw:10, dh:25},
  'S5-P23': {dx:106, dy:-49, dw:10, dh:25},
  'S5-P24': {dx:72, dy:-49, dw:10, dh:25},
  'S5-P25': {dx:38, dy:-49, dw:10, dh:25},
  'S5-P26': {dx:4, dy:-49, dw:10, dh:25},
  'S5-P27': {dx:-30, dy:-49, dw:10, dh:25},
  'S5-P28': {dx:-64, dy:-49, dw:10, dh:25},
  'S5-P29': {dx:-98, dy:-49, dw:10, dh:25},
  'S5-P30': {dx:-132, dy:-49, dw:10, dh:25},
  'S5-S01': {dx:200, dy:62, dw:8, dh:20},
  'S5-S02': {dx:176, dy:62, dw:8, dh:20},
  'S5-S03': {dx:146, dy:62, dw:8, dh:20},
  'S5-S04': {dx:166, dy:62, dw:8, dh:20},
  'S5-S05': {dx:-747, dy:-318, dw:8, dh:20},
  'S5-S06': {dx:-892, dy:-46, dw:8, dh:20},
  'S5-S07': {dx:893, dy:-113, dw:20, dh:6},
  'S5-S08': {dx:-77, dy:159, dw:19, dh:7},
  'S5-S09': {dx:35, dy:185, dw:8, dh:20},
  'S5-S10': {dx:16, dy:185, dw:8, dh:20},
  'S5-S11': {dx:-4, dy:185, dw:8, dh:20},
  'S5-S12': {dx:-24, dy:185, dw:8, dh:20},
  'S5-S13': {dx:35, dy:211, dw:8, dh:20},
  'S5-S14': {dx:16, dy:211, dw:8, dh:20},
  'S5-S15': {dx:-4, dy:211, dw:8, dh:20},
  'S5-S16': {dx:-24, dy:211, dw:8, dh:20},
  'S5-S17': {dx:133, dy:9, dw:20, dh:8},
  'S5-S18': {dx:-783, dy:9, dw:20, dh:8},
  'S5-S19': {dx:241, dy:49, dw:10, dh:25},
  'S5-S20': {dx:208, dy:49, dw:10, dh:25},
  'S5-S21': {dx:173, dy:49, dw:10, dh:25},
  'S5-S22': {dx:139, dy:49, dw:10, dh:25},
  'S5-S23': {dx:105, dy:49, dw:10, dh:25},
  'S5-S24': {dx:72, dy:49, dw:10, dh:25},
  'S5-S25': {dx:38, dy:49, dw:10, dh:25},
  'S5-S26': {dx:4, dy:49, dw:10, dh:25},
  'S5-S27': {dx:-30, dy:49, dw:10, dh:25},
  'S5-S28': {dx:-64, dy:49, dw:10, dh:25},
  'S5-S29': {dx:-97, dy:49, dw:10, dh:25},
  'S5-S30': {dx:-131, dy:49, dw:10, dh:25}
};
// Each offset entry: {dx, dy, dw, dh} — position and size adjustments

function showPage(p){
  // Always allow login page; block everything else if not authenticated
  if(!authenticated && p!=='login'){
    renderLogin();
    return;
  }
  page=p;
  ['map','inspect','records','stats'].forEach(x=>
    document.getElementById('nav-'+x)?.classList.toggle('active',x===p));
  if(p==='session')  renderSession();
  else if(p==='map')      renderMap();
  else if(p==='inspect')  renderInspect();
  else if(p==='records')  renderRecords();
  else if(p==='stats')    renderStats();
  else if(p==='login')    renderLogin();
}

/* ══════════════════════════════════════
   KEEL MAP PAGE
   ══════════════════════════════════════ */
function toggleMapSettings(){
  const p=document.getElementById('map-settings-panel');
  if(p) p.style.display=p.style.display==='none'?'block':'none';
}

function redrawHotspots(){
  // Redraw only the SVG hotspots without full re-render (faster)
  const filtered=inspections.filter(r=>r.vessel===SESSION.vessel&&r.program===SESSION.program);
  const status={};
  [...filtered].sort((a,b)=>a.id-b.id).forEach(r=>{status[r.anodeId]={verdict:r.verdict};});
  const svg=document.getElementById('keel-hotspots');
  if(svg) svg.innerHTML=buildHotspots(activeSection,status);
}

function renderMap(){
  document.getElementById('topbar-title').textContent='Keel Anode Map';
  document.getElementById('topbar-sub').textContent=
    `${SESSION.vessel||''} · ${SESSION.program||''} · Section ${activeSection}`;

  // Filter inspections by current session vessel + program only
  const filtered = inspections.filter(r=>
    r.vessel  === SESSION.vessel &&
    r.program === SESSION.program
  );

  // Build status from filtered records — latest record per anode wins
  const status={};
  [...filtered].sort((a,b)=>a.id-b.id).forEach(r=>{
    status[r.anodeId]={verdict:r.verdict,date:r.date,inspector:r.inspector};
  });

  const anodes=ALL[activeSection];
  const pass=anodes.filter(a=>status[a.id]?.verdict==='PASS').length;
  const fail=anodes.filter(a=>status[a.id]?.verdict==='FAIL').length;
  const pending=anodes.length-anodes.filter(a=>status[a.id]).length;

  document.getElementById('content').innerHTML=`
    <!-- Vessel + Program banner -->
    <div style="background:var(--navy);color:#fff;border-radius:var(--rs);padding:8px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
      <div>
        <div style="font-size:13px;font-weight:800">${SESSION.vessel||'—'}</div>
        <div style="font-size:11px;opacity:.75;margin-top:1px">${SESSION.program||'—'}</div>
      </div>
      <div style="font-size:11px;opacity:.7">Inspector: ${SESSION.inspector||'—'} · ${SESSION.date||'—'}</div>
    </div>

    <!-- Section selector (dropdown) + stats -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <select id="sec-select" onchange="switchSec(this.value)"
        style="padding:6px 10px;border:1.5px solid var(--navy);border-radius:20px;background:var(--white);
               font-size:12px;font-weight:700;color:var(--navy);cursor:pointer;appearance:none;
               padding-right:24px;background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22%3E%3Cpath d=%22M1 1l4 4 4-4%22 stroke=%22%230C447C%22 stroke-width=%221.5%22 fill=%22none%22/%3E%3C/svg%3E');
               background-repeat:no-repeat;background-position:right 8px center">
        ${SECTIONS.map(s=>`<option value="${s}" ${s===activeSection?'selected':''}>Section ${s}</option>`).join('')}
      </select>
      <div class="stats-bar" style="margin:0;flex:1">
        <span class="spill">${anodes.length} anodes</span>
        <span class="spill" style="color:var(--pass)">${pass} PASS</span>
        <span class="spill" style="color:var(--fail)">${fail} FAIL</span>
        <span class="spill" style="color:var(--text3)">${pending} pending</span>
      </div>
    </div>

    <!-- Legend + display controls -->
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <div class="legend" style="margin:0;flex:1;flex-wrap:wrap">
        <span style="display:flex;align-items:center;gap:3px">
          <span style="width:${mapLegendSize}px;height:${mapLegendSize}px;border-radius:2px;display:inline-block;background:var(--pass-bg);border:1px solid var(--pass-br)"></span>
          <span style="font-size:${mapLegendFont}px">PASS</span>
        </span>
        <span style="display:flex;align-items:center;gap:3px">
          <span style="width:${mapLegendSize}px;height:${mapLegendSize}px;border-radius:2px;display:inline-block;background:var(--fail-bg);border:1px solid var(--fail-br)"></span>
          <span style="font-size:${mapLegendFont}px">FAIL</span>
        </span>
        <span style="display:flex;align-items:center;gap:3px">
          <span style="width:${mapLegendSize}px;height:${mapLegendSize}px;border-radius:2px;display:inline-block;background:var(--warn-bg);border:1px solid var(--warn-br)"></span>
          <span style="font-size:${mapLegendFont}px">REVIEW</span>
        </span>
        <span style="display:flex;align-items:center;gap:3px">
          <span style="width:${mapLegendSize}px;height:${mapLegendSize}px;border-radius:2px;display:inline-block;background:#fff;border:1px solid var(--gray-br)"></span>
          <span style="font-size:${mapLegendFont}px">Pending</span>
        </span>
      </div>
      <!-- Display settings button -->
      <button class="btn btn-sm" style="font-size:10px;padding:3px 8px;flex-shrink:0"
        onclick="toggleMapSettings()" id="map-settings-btn">⚙ Display</button>
    </div>

    <!-- Display settings panel (hidden by default) -->
    <div id="map-settings-panel" style="display:none;background:var(--gray-lt);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px;font-size:12px">
      <div style="font-weight:700;color:var(--text2);margin-bottom:8px">Map display settings</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Anode ID font size: <b id="font-val">${mapFontSize}px</b></label>
          <input type="range" min="5" max="16" value="${mapFontSize}" style="width:100%"
            oninput="mapFontSize=parseInt(this.value);document.getElementById('font-val').textContent=this.value+'px';redrawHotspots()">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Box size: <b id="box-val">${Math.round(mapBoxScale*100)}%</b></label>
          <input type="range" min="50" max="200" value="${Math.round(mapBoxScale*100)}" style="width:100%"
            oninput="mapBoxScale=parseInt(this.value)/100;document.getElementById('box-val').textContent=this.value+'%';redrawHotspots()">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Legend dot size: <b id="ldot-val">${mapLegendSize}px</b></label>
          <input type="range" min="8" max="24" value="${mapLegendSize}" style="width:100%"
            oninput="mapLegendSize=parseInt(this.value);document.getElementById('ldot-val').textContent=this.value+'px';renderMap()">
        </div>
        <div>
          <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Legend font: <b id="lfont-val">${mapLegendFont}px</b></label>
          <input type="range" min="8" max="18" value="${mapLegendFont}" style="width:100%"
            oninput="mapLegendFont=parseInt(this.value);document.getElementById('lfont-val').textContent=this.value+'px';renderMap()">
        </div>
      </div>
      <div style="margin-top:8px">
        <button class="btn btn-sm" data-action="toggle-calibrate"
          style="font-size:10px;${calibrateMode?'background:var(--warn-bg);color:var(--warn);border-color:var(--warn-br)':''}">
          ${calibrateMode?'✓ Exit calibration':'Calibrate anode positions'}
        </button>
      </div>
    </div>
${calibrateMode ? `<div style="background:var(--warn-bg);border:1px solid var(--warn-br);border-radius:var(--rs);padding:10px 12px;margin-bottom:8px;font-size:12px;color:var(--warn)">
      <b>Calibration mode active</b> — click an anode (turns blue) then use arrow keys to move, W/A/S/D to resize
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm" data-action="copy-offsets">Copy offsets</button>
        <button class="btn btn-sm" data-action="reset-offsets">Reset all</button>
        <button class="btn btn-sm" data-action="reset-selected">Reset selected</button>
        <span id="calib-status" style="font-size:11px;color:var(--text3);flex:1;text-align:right">No anode selected</span>
      </div>
    </div>` : ''}
    <div class="keel-wrap" style="padding:0;overflow:hidden">
      <div id="keel-map-container" style="position:relative;display:inline-block;width:100%">
        <img id="keel-img" src="assets/keel_section.png"
             style="width:100%;display:block;user-select:none"
             alt="Vessel keel section drawing — Section ${activeSection}">
        <svg id="keel-hotspots"
             viewBox="0 0 1200 1314"
             style="position:absolute;top:0;left:0;width:100%;height:100%"
             xmlns="http://www.w3.org/2000/svg">
          ${buildHotspots(activeSection, status)}
        </svg>
      </div>
    </div>
    <div id="anode-panel" style="display:none;margin-top:10px"></div>`;
}

function switchSec(s){activeSection=parseInt(s);renderMap();}

/* ── Hotspot positions — mapped to actual anode X positions in the image ──
   Image size: 1200 x 1314 px
   AFT = left, FWD = right, PORT = top half, STBD = bottom half
   Centreline Y ≈ 657

   Measured from the AutoCAD drawing:
   Outer boundary: x≈96 to x≈1104,  y≈100 to y≈1200
   PORT top row:         y≈145
   PORT mid-outer sides: y≈340  (AFT x≈115, FWD x≈1085)
   PORT inner upper:     y≈490
   PORT inner lower:     y≈570
   PORT low-outer sides: y≈580  (AFT x≈115, FWD x≈1085)
   PORT keel edge:       y≈625
   KEEL CENTRELINE:      y≈657
   STBD keel edge:       y≈690
   STBD inner upper:     y≈745
   STBD inner lower:     y≈825
   STBD mid-outer sides: y≈960  (AFT x≈115, FWD x≈1085)
   STBD bottom row:      y≈1165

   Outer top/bottom corners at AFT x≈115 and FWD x≈1085
   4 spaced anodes across at x≈330, 550, 720, 940
   12 keel edge anodes: x≈115 to x≈1085 evenly spaced
   4 inner anodes:      x≈280, 490, 700, 910
   ── */
function buildHotspots(sec, status){
  const an = ALL[sec];
  const port = an.slice(0, 30);
  const stbd = an.slice(30);

  // Anode colours based on verdict
  function col(id){
    const s=status[id];
    if(!s)               return {f:'rgba(255,255,255,0.1)', st:'rgba(150,150,150,0.5)'};
    if(s.verdict==='PASS') return {f:'rgba(234,243,222,0.75)', st:'#97C459'};
    if(s.verdict==='FAIL') return {f:'rgba(252,235,235,0.85)', st:'#F09595'};
                         return {f:'rgba(250,238,218,0.8)',   st:'#FAC775'};
  }

  function spot(cx, cy, w, h, id){
    const {f, st} = col(id);
    const label = id.split('-')[1];
    const off = calibrateOffsets[id] || {dx:0, dy:0, dw:0, dh:0};
    const rx = cx + off.dx, ry = cy + off.dy;
    // Apply box scale multiplier on top of calibration adjustments
    const rw = (w + (off.dw||0)) * mapBoxScale;
    const rh = (h + (off.dh||0)) * mapBoxScale;
    const isSelected = calibrateMode && calibrateSelected === id;
    const fillCol   = isSelected ? 'rgba(24,95,165,0.5)' : f;
    const strokeCol = isSelected ? '#0C447C' : st;
    const sw = isSelected ? 3 : 2;
    return `<g style="cursor:${calibrateMode?'move':'pointer'}" data-id="${id}" data-base-cx="${cx}" data-base-cy="${cy}" data-base-w="${w}" data-base-h="${h}">
      <rect x="${rx-rw/2}" y="${ry-rh/2}" width="${rw}" height="${rh}" rx="3"
            fill="${fillCol}" stroke="${strokeCol}" stroke-width="${sw}"/>
      <text x="${rx}" y="${ry+1}" text-anchor="middle" dominant-baseline="central"
            font-size="${mapFontSize}" font-weight="700"
            fill="${isSelected ? '#0C447C' : (st === 'rgba(150,150,150,0.5)' ? '#999' : st)}"
            font-family="sans-serif">${label}</text>
    </g>`;
  }

  // Hotspot dimensions
  const NW=46, NH=34;   // normal anode box
  const KW=44, KH=28;   // keel edge (smaller gap)

  let s='';

  // ── PORT (top half) ──────────────────────────────────────
  // P01–P06: outer top row (2 corners + 4 spaced)
  const portTopY=145;
  [115, 330, 550, 720, 940, 1085].forEach((cx,i)=>{
    s+=spot(cx, portTopY, NW, NH, port[i].id);
  });
  // P07: AFT mid side,  P08: FWD mid side
  s+=spot(115, 340, NH, NW, port[6].id);  // rotated (side mount)
  s+=spot(1085,340, NH, NW, port[7].id);
  // P09–P12: inner upper band
  [280,490,700,910].forEach((cx,i)=>{
    s+=spot(cx, 490, NW, NH, port[8+i].id);
  });
  // P13–P16: inner lower band
  [280,490,700,910].forEach((cx,i)=>{
    s+=spot(cx, 570, NW, NH, port[12+i].id);
  });
  // P17: AFT lower outer,  P18: FWD lower outer
  s+=spot(115, 580, NH, NW, port[16].id);
  s+=spot(1085,580, NH, NW, port[17].id);
  // P19–P30: keel edge dense (12 anodes)
  [...Array(12)].forEach((_,i)=>{
    const cx = 115 + i*(970/11);
    s+=spot(cx, 625, KW, KH, port[18+i].id);
  });

  // ── STARBOARD (bottom half) — vertical mirror ────────────
  // S01–S06: outer bottom row
  const stbdBotY=1165;
  [115, 330, 550, 720, 940, 1085].forEach((cx,i)=>{
    s+=spot(cx, stbdBotY, NW, NH, stbd[i].id);
  });
  // S07: AFT mid,  S08: FWD mid
  s+=spot(115, 960, NH, NW, stbd[6].id);
  s+=spot(1085,960, NH, NW, stbd[7].id);
  // S09–S12: inner upper (stbd)
  [280,490,700,910].forEach((cx,i)=>{
    s+=spot(cx, 825, NW, NH, stbd[8+i].id);
  });
  // S13–S16: inner lower (stbd)
  [280,490,700,910].forEach((cx,i)=>{
    s+=spot(cx, 745, NW, NH, stbd[12+i].id);
  });
  // S17: AFT lower outer,  S18: FWD lower outer
  s+=spot(115, 730, NH, NW, stbd[16].id);
  s+=spot(1085,730, NH, NW, stbd[17].id);
  // S19–S30: keel edge dense
  [...Array(12)].forEach((_,i)=>{
    const cx = 115 + i*(970/11);
    s+=spot(cx, 690, KW, KH, stbd[18+i].id);
  });

  return s;
}


/* ── Anode detail panel ── */
function selectAnode(id){
  if(!SESSION.vessel){ alert('Please set up your inspection session first.'); showPage('session'); return; }
  startInsp(id, id.split('-')[0].replace('S',''));
}

function startInsp(anodeId, sec){
  INS = {anodeId, section:parseInt(sec), side:anodeId.includes('-P')?'PORT':'STARBOARD',
    vessel:SESSION.vessel||'', program:SESSION.program||'',
    inspector:SESSION.inspector||'', date:SESSION.date||'',
    checklistAnswers:{}, remarks:'', notes:''};
  step=1; showPage('inspect');
}


/* ══════════════════════════════════════
   SESSION PAGE — select vessel/program/inspector/date once
   ══════════════════════════════════════ */
/* ══════════ LOGIN PAGE ══════════ */
async function hashPassword(pw){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function renderLogin(){
  document.getElementById('topbar-title').textContent = 'Zinc Anode Inspector';
  document.getElementById('topbar-sub').textContent   = 'Enter password to continue';

  document.getElementById('content').innerHTML = `
    <div style="max-width:360px;margin:48px auto 0">
      <div class="card">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:36px;margin-bottom:8px">🔒</div>
          <div style="font-size:17px;font-weight:800;color:var(--navy)">Zinc Anode Inspector</div>
          <div style="font-size:12px;color:var(--text3);margin-top:4px">Authorised personnel only</div>
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="login-pw" placeholder="Enter password"
            style="font-size:15px;padding:10px 12px;letter-spacing:.1em"
            autocomplete="current-password">
        </div>
        <div id="login-err" style="display:none;background:var(--fail-bg);color:var(--fail);
          border:1px solid var(--fail-br);border-radius:var(--rs);padding:8px 12px;
          font-size:12px;font-weight:600;margin-bottom:10px">
          Incorrect password. Please try again.
        </div>
        <button class="btn btn-primary" data-action="login-submit"
          style="width:100%;padding:11px;font-size:14px">
          Sign in →
        </button>
      </div>
      <div style="text-align:center;font-size:11px;color:var(--text3);margin-top:12px">
        All data stored locally on this device
      </div>
    </div>`;

  // Allow Enter key to submit
  setTimeout(()=>{
    const pw = document.getElementById('login-pw');
    if(pw){
      pw.focus();
      pw.addEventListener('keydown', e=>{ if(e.key==='Enter') loginSubmit(); });
    }
  }, 50);
}

async function loginSubmit(){
  const pw  = document.getElementById('login-pw')?.value || '';
  const err = document.getElementById('login-err');
  if(!pw){ if(err) err.style.display='block'; return; }

  const hash = await hashPassword(pw);
  if(hash === PASS_HASH){
    authenticated = true;
    sessionStorage.setItem('zai_auth','1'); // stays for this browser tab only
    showPage('session');
  } else {
    if(err) err.style.display='block';
    const input = document.getElementById('login-pw');
    if(input){ input.value=''; input.focus(); }
  }
}

function renderSession(){
  document.getElementById('topbar-title').textContent = 'Zinc Anode Inspector';
  document.getElementById('topbar-sub').textContent   = 'Set up your inspection session';

  const today = new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
  const vessel    = SESSION.vessel    || '';
  const program   = SESSION.program   || '';
  const inspector = SESSION.inspector || '';
  const date      = SESSION.date      || today;

  document.getElementById('content').innerHTML=`
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">Inspection session</div>
      <div class="grid2">
        <div class="field"><label>Vessel</label>
          <select id="sess-vessel">
            <option value="">Select…</option>
            ${VESSELS.map(v=>`<option ${vessel===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Maintenance program</label>
          <select id="sess-program">
            <option value="">Select…</option>
            ${PROGRAMS.map(p=>`<option ${program===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label>Inspector name</label>
          <input type="text" id="sess-inspector" placeholder="Full name" value="${inspector}">
        </div>
        <div class="field"><label>Inspection date</label>
          <input type="text" id="sess-date" value="${date}">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary btn-full" data-action="session-go">
          Start inspection →
        </button>
      </div>
    </div>
    ${SESSION.vessel ? `
    <div class="card" style="padding:10px 14px">
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Last session</div>
      <div style="font-size:13px;color:var(--text2)">
        ${SESSION.vessel} · ${SESSION.program||'—'} · ${SESSION.inspector||'—'} · ${SESSION.date||'—'}
      </div>
    </div>` : ''}`;
}

function sessionGo(){
  const v    = document.getElementById('sess-vessel')?.value    || '';
  const p    = document.getElementById('sess-program')?.value   || '';
  const insp = document.getElementById('sess-inspector')?.value || '';
  const date = document.getElementById('sess-date')?.value      || '';
  if(!v || !p){ alert('Please select vessel and program.'); return; }
  SESSION = {vessel:v, program:p, inspector:insp, date};
  saveSession(SESSION);
  showPage('map');
}

/* ══════════════════════════════════════
   INSPECT PAGE — checklist + verdict (2 steps)
   Inspector clicks anode on map → goes straight to checklist
   ══════════════════════════════════════ */
function dots(a){
  return`<div style="display:flex;gap:5px;align-items:center;margin-bottom:12px">
    ${[1,2,3].map(i=>`<div style="height:7px;border-radius:4px;transition:.2s;
      background:${i<a?'#639922':i===a?'#0C447C':'#D3D1C7'};
      width:${i===a?'20px':'7px'}"></div>`).join('')}
    <span style="font-size:11px;color:var(--text3);margin-left:5px">Step ${a} of 3</span>
  </div>`;
}

function renderInspect(){
  document.getElementById('topbar-title').textContent = 'Inspect Anode';
  document.getElementById('topbar-sub').textContent   = INS.anodeId || 'No anode selected';
  if(step===1)      rPhoto();
  else if(step===2) rChecklist();
  else              rVerdict();
}

/* Step 1 — Photo + Ollama AI analysis */
function rPhoto(){
  const hasPhoto = !!INS.photoB64;
  const aiDone   = !!INS.aiResult;

  document.getElementById('content').innerHTML=`
    ${dots(1)}
    <div class="card" style="padding:9px 14px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:700;color:var(--navy)">${INS.anodeId}</div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">
        Section ${INS.section} · ${INS.side} · ${SESSION.vessel} · ${SESSION.program}
      </div>
    </div>

    <!-- Ollama status -->
    <div class="card" style="padding:9px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
        <div style="font-size:12px;color:var(--text2)">
          <span id="ai-dot" style="width:8px;height:8px;border-radius:50%;background:#ccc;
            display:inline-block;margin-right:5px;vertical-align:middle"></span>
          <span id="ai-status">Checking Ollama…</span>
        </div>
        <span style="font-size:10px;color:var(--text3)">Optional — skip if not available</span>
      </div>
      <div id="ai-model-row" style="display:none;margin-top:8px">
        <select id="ai-model" style="width:100%;padding:7px 10px;border:1px solid var(--border);
          border-radius:var(--rs);font-size:12px;background:var(--white)"></select>
      </div>
      <div id="ollama-hint" class="hidden" style="margin-top:8px;font-size:11px;color:var(--text3);
        background:var(--gray-lt);border-radius:var(--rs);padding:7px 10px;line-height:1.6">
        To enable AI: run <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:3px">ollama serve</code>
        in Terminal, then refresh this page.
        Pull a model first: <code style="background:rgba(0,0,0,.07);padding:1px 5px;border-radius:3px">ollama pull llava</code>
      </div>
    </div>

    <!-- Photo upload -->
    <div class="card">
      <div class="card-title">Anode photo</div>
      <div id="upload-zone" onclick="document.getElementById('photo-file').click()"
        style="border:2px dashed ${hasPhoto?'var(--navy)':'var(--gray-br)'};
          border-style:${hasPhoto?'solid':'dashed'};
          border-radius:var(--rs);padding:20px;text-align:center;
          cursor:pointer;background:var(--gray-lt)">
        <div style="font-size:26px;margin-bottom:5px">📷</div>
        <div style="font-size:13px;color:var(--text2);font-weight:600">
          ${hasPhoto?'Tap to replace photo':'Tap to capture or upload'}
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Include a ruler if possible</div>
      </div>
      <input type="file" id="photo-file" accept="image/*" capture="environment"
        style="display:none" onchange="onInspPhoto(this)">
      ${hasPhoto
        ?`<img src="${INS.photoPreview}" style="width:100%;max-height:220px;object-fit:contain;
            border-radius:var(--rs);margin-top:10px;border:1px solid var(--border)">`
        :''}
    </div>

    <!-- AI analyse button -->
    <button class="btn btn-primary" id="ai-analyse-btn"
      onclick="runAIAnalysis()" ${hasPhoto&&ollamaOK?'':'disabled'} style="margin-bottom:8px">
      Analyse with AI (Ollama)
    </button>

    <!-- Progress -->
    <div id="ai-progress" style="display:none" class="card">
      <div style="font-size:13px;font-weight:600;color:var(--navy)" id="ai-prog-label">Analysing…</div>
      <div style="height:6px;background:var(--gray-lt);border-radius:3px;overflow:hidden;margin-top:8px">
        <div id="ai-prog-fill" style="height:100%;background:var(--navy);border-radius:3px;width:0%;transition:width .4s"></div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:5px">May take 30–90 seconds</div>
    </div>

    <!-- AI result -->
    <div id="ai-result-slot">
      ${aiDone ? renderAIResult(INS.aiResult) : ''}
    </div>

    <div class="btn-row">
      <button class="btn" data-action="show-page" data-arg="map">← Map</button>
      <button class="btn btn-primary" onclick="step=2;renderInspect()">
        ${aiDone?'Next: Checklist →':'Skip → Checklist'}
      </button>
    </div>`;

  // Ping Ollama
  pingOllama().then(models=>{
    const dot=document.getElementById('ai-dot');
    const st =document.getElementById('ai-status');
    const mr =document.getElementById('ai-model-row');
    const hint=document.getElementById('ollama-hint');
    const btn=document.getElementById('ai-analyse-btn');
    if(!dot) return;
    if(ollamaOK && models.length){
      dot.style.background='#97C459';
      st.textContent='Ollama ready — '+models[0];
      mr.style.display='block';
      const sel=document.getElementById('ai-model');
      if(sel) sel.innerHTML=models.map(m=>`<option value="${m}" ${/llava/i.test(m)?'selected':''}>${m}</option>`).join('');
      if(btn && INS.photoB64) btn.disabled=false;
    } else {
      dot.style.background='#F09595';
      st.textContent='Ollama not running — skip or start Ollama';
      if(hint) hint.classList.remove('hidden');
      if(btn) btn.disabled=true;
    }
  });
}

function renderAIResult(r){
  if(!r) return '';
  const v=r.verdict||'?';
  const vc=v==='PASS'?'var(--pass)':v==='FAIL'?'var(--fail)':'var(--warn)';
  const vbg=v==='PASS'?'var(--pass-bg)':v==='FAIL'?'var(--fail-bg)':'var(--warn-bg)';
  const checks=[
    {k:'c1_remaining_50pct',l:'≥50% remaining',  crit:true},
    {k:'c2_no_core_exposed',l:'No core exposed',  crit:true},
    {k:'c3_no_knife_edge',  l:'No knife-edge',    crit:true},
    {k:'c4_surface_acceptable',l:'Surface OK',    crit:false},
    {k:'c5_mounting_secure',   l:'Mounting OK',   crit:false},
  ];
  const chips=checks.map(c=>{
    const val=r[c.k];
    const bg=val===true?'var(--pass-bg)':val===false?'var(--fail-bg)':'var(--gray-lt)';
    const col=val===true?'var(--pass)':val===false?'var(--fail)':'var(--text3)';
    return`<span style="background:${bg};color:${col};font-size:10px;font-weight:700;
      padding:2px 7px;border-radius:20px;display:inline-block;margin:2px">
      ${c.l}: ${val===true?'✓':val===false?'✗':'?'}
    </span>`;
  }).join('');
  return`<div class="card" style="background:${vbg};border-color:${vc};margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="width:36px;height:36px;border-radius:50%;background:${vc};color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0">
        ${v==='PASS'?'✓':v==='FAIL'?'✗':'!'}
      </div>
      <div>
        <div style="font-size:16px;font-weight:800;color:${vc}">${v}</div>
        <div style="font-size:11px;color:${vc};margin-top:1px">${r.summary||''}</div>
      </div>
    </div>
    <div>${chips}</div>
    ${r.observations?`<div style="font-size:11px;color:var(--text2);margin-top:8px;line-height:1.5">${r.observations.split('\n')[0]||''}</div>`:''}
    <div style="font-size:10px;color:var(--text3);margin-top:6px">AI suggestion · Checklist pre-filled · Review on next step</div>
  </div>`;
}

function onInspPhoto(input){
  const file=input.files[0]; if(!file) return;
  const img=new Image(), url=URL.createObjectURL(file);
  img.onload=()=>{
    const MAX=1200; let w=img.width,h=img.height;
    if(w>MAX){h=Math.round(h*MAX/w);w=MAX;}
    const c=document.createElement('canvas');
    c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    INS.photoB64=c.toDataURL('image/jpeg',.88).split(',')[1];
    INS.photoPreview=c.toDataURL('image/jpeg',.88);
    URL.revokeObjectURL(url);
    // Re-render photo step to show preview and enable analyse btn
    rPhoto();
  };
  img.src=url;
}

async function runAIAnalysis(){
  const model=document.getElementById('ai-model')?.value;
  if(!model||!INS.photoB64) return;

  const btn =document.getElementById('ai-analyse-btn');
  const prog=document.getElementById('ai-progress');
  const fill=document.getElementById('ai-prog-fill');
  if(btn)  btn.disabled=true;
  if(prog) prog.style.display='block';

  const questions=[
    {key:'c1_remaining_50pct',inverted:false,prompt:`You are inspecting a sacrificial zinc anode on a ship's hull.

CRITICAL QUESTION: Is at least 50% of the zinc anode material STILL REMAINING?

A BRAND NEW anode is a THICK, SOLID, OVAL/ELLIPTICAL zinc block approximately 13cm wide x 10cm tall x 5cm thick.

Signs LESS THAN 50% remains (answer NO):
- Anode looks thin, flat, skeletal or like a thin shell
- Steel mounting rod/bracket visible through the zinc body
- Shape looks like a thin plate rather than solid oval block
- Orange rust or bare metal visible on the main body
- Most of the original zinc volume is clearly gone

Signs MORE THAN 50% remains (answer YES):
- Still a recognisably thick, solid, chunky oval shape
- More than half of original solid block is present
- Zinc body dominates over the steel hardware

Be STRICT — if unsure, answer NO.
Answer with ONLY one word: YES or NO`},
    {key:'c2_no_core_exposed',inverted:true,prompt:`You are inspecting a sacrificial zinc anode on a ship's hull.

QUESTION: Is the steel core or metal insert EXPOSED through the zinc body?

Brackets at the very top and bottom ends are NORMAL.
NOT normal: orange/rust/bare steel showing THROUGH the zinc body itself.

Answer ONLY:
YES — steel/rust/core IS exposed through the zinc body
NO — zinc body intact, no core exposure`},
    {key:'c3_no_knife_edge',inverted:true,prompt:`You are inspecting a sacrificial zinc anode on a ship's hull.

QUESTION: Has the anode worn into a knife-edge, spike, or dangerously thin sharp shape?

Good anode = solid rounded oval shape.
Dangerous = thin blade, pointed spike, extremely thin jagged shapes.

Answer ONLY:
YES — knife-edge or spike IS present (DANGEROUS)
NO — shape is acceptable`},
    {key:'c4_surface_acceptable',inverted:false,prompt:`Inspecting a zinc anode. Is the surface condition acceptable?
Normal pitting and rough grey/silver texture is fine.
Unacceptable: extreme deep pitting, large chunks missing, severe cracking.
Answer: YES (acceptable) or NO (unacceptable)`},
    {key:'c5_mounting_secure',inverted:false,prompt:`Inspecting a zinc anode. Do the mounting brackets appear secure and intact?
If unclear, answer YES.
Answer: YES (secure) or NO (damaged/missing)`},
  ];

  const answers={};
  let pct=5;
  const ticker=setInterval(()=>{
    pct=Math.min(pct+(pct<80?3:0.5),92);
    if(fill) fill.style.width=pct+'%';
    const lbl=document.getElementById('ai-prog-label');
    if(lbl){
      if(pct<30)      lbl.textContent='Sending photo to Ollama…';
      else if(pct<60) lbl.textContent='Assessing anode condition…';
      else            lbl.textContent='Generating assessment…';
    }
  },600);

  try{
    for(const q of questions){
      const lbl=document.getElementById('ai-prog-label');
      if(lbl) lbl.textContent='Checking: '+q.key.replace(/_/g,' ')+'…';
      const r=await fetch(OLLAMA_URL+'/api/generate',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model,prompt:q.prompt,images:[INS.photoB64],
          stream:false,options:{temperature:0.01,num_predict:10}}),
        signal:AbortSignal.timeout(60000)
      });
      const data=await r.json();
      const resp=(data.response||'').trim().toLowerCase();
      const positive=/yes|good|ok|acceptable|intact|secure|remaining|sufficient/i.test(resp);
      answers[q.key]=q.inverted?!positive:positive;
    }

    // Consistency: core exposed or knife-edge → remaining must be <50%
    if(!answers.c2_no_core_exposed||!answers.c3_no_knife_edge){
      answers.c1_remaining_50pct=false;
    }

    // Percentage from logic
    let estPct;
    if(!answers.c1_remaining_50pct&&!answers.c2_no_core_exposed&&!answers.c3_no_knife_edge) estPct=10;
    else if(!answers.c1_remaining_50pct&&!answers.c2_no_core_exposed) estPct=20;
    else if(!answers.c1_remaining_50pct&&!answers.c3_no_knife_edge)   estPct=15;
    else if(!answers.c2_no_core_exposed) estPct=30;
    else if(!answers.c1_remaining_50pct) estPct=35;
    else if(!answers.c3_no_knife_edge)   estPct=20;
    else estPct=70;

    // Verdict
    const f1=!answers.c1_remaining_50pct,f2=!answers.c2_no_core_exposed,f3=!answers.c3_no_knife_edge;
    const soft=!answers.c4_surface_acceptable||!answers.c5_mounting_secure;
    let verdict,summary;
    if(f1||f2||f3){
      verdict='FAIL';
      const reasons=[];
      if(f1)reasons.push('remaining<50%');
      if(f2)reasons.push('core exposed');
      if(f3)reasons.push('knife-edge');
      summary='Critical failure: '+reasons.join(', ')+' (~'+estPct+'% remaining)';
    } else if(soft){
      verdict='REVIEW REQUIRED';
      summary='Advisory items need attention (~'+estPct+'% remaining)';
    } else {
      verdict='PASS';
      summary='All criteria satisfied — approximately '+estPct+'% remaining';
    }

    INS.aiResult={...answers,estimated_remaining_pct:estPct,verdict,summary,
      observations:Object.entries(answers).map(([k,v])=>k.replace(/_/g,' ')+': '+(v?'PASS':'FAIL')).join('\n')};

    // Pre-fill checklist answers from AI
    INS.checklistAnswers.c1=answers.c1_remaining_50pct;
    INS.checklistAnswers.c2=answers.c2_no_core_exposed;
    INS.checklistAnswers.c3=answers.c3_no_knife_edge;
    INS.checklistAnswers.c4=answers.c4_surface_acceptable;
    INS.checklistAnswers.c5=answers.c5_mounting_secure;

    clearInterval(ticker);
    if(fill) fill.style.width='100%';
    setTimeout(()=>{
      if(prog) prog.style.display='none';
      if(btn)  btn.disabled=false;
      const slot=document.getElementById('ai-result-slot');
      if(slot) slot.innerHTML=renderAIResult(INS.aiResult);
      const skipBtn=document.querySelector('.btn-primary[onclick*="step=2"]');
      if(skipBtn) skipBtn.textContent='Next: Checklist →';
    },300);

  } catch(err){
    clearInterval(ticker);
    if(prog) prog.style.display='none';
    if(btn)  btn.disabled=false;
    showToast('AI failed: '+err.message,'error');
  }
}

/* Step 2 — Checklist */
function rChecklist(){
  const done = CHECKLIST.every(c=>INS.checklistAnswers[c.id]!==undefined);
  document.getElementById('content').innerHTML=`
    ${dots(2)}
    <div class="card" style="padding:9px 14px;margin-bottom:8px">
      <div style="font-size:13px;font-weight:700;color:var(--navy)">${INS.anodeId}</div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">
        Section ${INS.section} · ${INS.side} · ${SESSION.vessel} · ${SESSION.program}
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:1px">
        ${SESSION.inspector} · ${SESSION.date}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Inspection checklist</div>
      <div id="chklist">${mkChk()}</div>
    </div>
    <div class="card">
      <div class="card-title">Remarks</div>
      <div class="field">
        <textarea id="f-rem" placeholder="Additional observations…">${INS.remarks||''}</textarea>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn" data-action="show-page" data-arg="map">← Map</button>
      <button class="btn btn-primary" id="chk-next" ${done?'':'disabled'} data-action="checklist-go">
        Review →
      </button>
    </div>`;
}


function mkChk(){
  return CHECKLIST.map(c=>{
    const a=INS.checklistAnswers[c.id];
    return`<div class="chk-item">
      <div class="chk-label">${c.text}${c.critical?'<span class="chk-critical">CRITICAL</span>':''}</div>
      <div class="chk-btns">
        <button class="chk-btn chk-yes ${a===true?'on':''}" data-action="chk-answer" data-arg="${c.id},true">YES</button>
        <button class="chk-btn chk-no  ${a===false?'on':''}" data-action="chk-answer" data-arg="${c.id},false">NO</button>
      </div>
    </div>`;
  }).join('');
}

function calcVerdict(){
  const a=INS.checklistAnswers;
  const f1=a.c1===false,f2=a.c2===false,f3=a.c3===false;
  const soft=CHECKLIST.filter(c=>!c.critical&&a[c.id]===false);
  if(f1||f2||f3){
    INS.verdict='FAIL';
    const r=[];
    if(f1)r.push('Remaining < 50%');
    if(f2)r.push('Core metal exposed');
    if(f3)r.push('Knife-edge shape');
    INS.verdictReasons=r;
  } else if(soft.length){
    INS.verdict='REVIEW REQUIRED';
    INS.verdictReasons=soft.map(c=>c.text);
  } else {
    INS.verdict='PASS';
    INS.verdictReasons=['All criteria satisfied'];
  }
}

function chkAnswer(id, val){
  INS.checklistAnswers[id] = (val==='true'||val===true);
  const chk = document.getElementById('chklist');
  if(chk) chk.innerHTML = mkChk();
  const btn = document.getElementById('chk-next');
  if(btn) btn.disabled = !CHECKLIST.every(c=>INS.checklistAnswers[c.id]!==undefined);
}

function checklistGo(){
  INS.remarks = document.getElementById('f-rem')?.value || '';
  calcVerdict();
  step=3; renderInspect();
}



/* Step 3 — Verdict */
function rVerdict(){
  const v=INS.verdict;
  const vc=v==='PASS'?'var(--pass)':v==='FAIL'?'var(--fail)':'var(--warn)';
  const vbg=v==='PASS'?'var(--pass-bg)':v==='FAIL'?'var(--fail-bg)':'var(--warn-bg)';
  document.getElementById('content').innerHTML=`
    ${dots(3)}
    <div class="vbanner" style="background:${vbg}">
      <div class="vicon" style="background:${vc}">${v==='PASS'?'✓':v==='FAIL'?'✗':'!'}</div>
      <div>
        <div style="font-size:20px;font-weight:800;color:${vc}">${v}</div>
        <div style="font-size:12px;color:${vc};margin-top:2px">${INS.verdictReasons.join(' · ')}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Critical criteria</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
        ${[{id:'c1',l:'≥50%\nremaining'},{id:'c2',l:'Core not\nexposed'},{id:'c3',l:'No knife\nedge'}].map(c=>{
          const ok=INS.checklistAnswers[c.id]!==false;
          return`<div style="background:${ok?'var(--pass-bg)':'var(--fail-bg)'};border-radius:var(--rs);padding:9px;text-align:center">
            <div style="font-size:10px;font-weight:700;color:${ok?'var(--pass)':'var(--fail)'};white-space:pre-line">${c.l}</div>
            <div style="font-size:13px;font-weight:800;color:${ok?'var(--pass)':'var(--fail)'};margin-top:3px">${ok?'PASS':'FAIL'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Override verdict</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        <button class="btn btn-sm" style="background:var(--pass-bg);color:var(--pass);border-color:var(--pass-br)"
          data-action="override-verdict" data-arg="PASS">Set PASS</button>
        <button class="btn btn-sm" style="background:var(--fail-bg);color:var(--fail);border-color:var(--fail-br)"
          data-action="override-verdict" data-arg="FAIL">Set FAIL</button>
        <button class="btn btn-sm" style="background:var(--warn-bg);color:var(--warn);border-color:var(--warn-br)"
          data-action="override-verdict" data-arg="REVIEW REQUIRED">Set REVIEW</button>
      </div>
      <div class="field"><label>Notes</label>
        <textarea id="f-notes" placeholder="Additional notes…">${INS.notes||''}</textarea>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn" onclick="step=2;renderInspect()">← Checklist</button>
      <button class="btn btn-primary" data-action="save-inspection">Save</button>
      <button class="btn" data-action="print-report">Print / PDF</button>
    </div>`;
}

/* ══════════ SAVE & PRINT ══════════ */
async function saveInsp(){
  INS.notes = document.getElementById('f-notes')?.value || INS.notes || '';
  const rec = {
    id:        Date.now().toString(),
    anodeId:   INS.anodeId,
    section:   INS.section,
    side:      INS.side,
    vessel:    SESSION.vessel    || INS.vessel    || '',
    program:   SESSION.program   || INS.program   || '',
    inspector: SESSION.inspector || INS.inspector || '',
    date:      SESSION.date      || INS.date      || '',
    verdict:        INS.verdict,
    verdictReasons: INS.verdictReasons,
    checklistAnswers: INS.checklistAnswers,
    remarks:   INS.remarks || '',
    notes:     INS.notes   || '',
    savedAt:   new Date().toISOString(),
  };
  await dbPut(rec);
  inspections.push(rec);
  INS = {};
  step = 1;
  showToast('Saved — ' + rec.anodeId + ' — ' + rec.verdict);
  showPage('map');
}

function showToast(msg, type='success'){
  // Remove any existing toast
  document.querySelectorAll('.app-toast').forEach(t=>t.remove());
  const t = document.createElement('div');
  t.className = 'app-toast';
  t.textContent = msg;
  t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:${type==='error'?'#791F1F':'#27500A'};color:#fff;
    padding:10px 22px;border-radius:20px;font-size:13px;font-weight:600;
    z-index:9999;pointer-events:none;white-space:nowrap;
    box-shadow:0 4px 16px rgba(0,0,0,.25);animation:fadeIn .2s ease`;
  document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, 2800);
}

/* ══════════════════════════════════════
   RECORDS PAGE
   ══════════════════════════════════════ */
// Records filter state — persisted across re-renders
let recFilterVessel='', recFilterVerdict='';

function renderRecords(){
  document.getElementById('topbar-title').textContent='Records';
  document.getElementById('topbar-sub').textContent=`${inspections.length} inspections`;
  if(!inspections.length){document.getElementById('content').innerHTML=`<div style="text-align:center;padding:44px 20px;color:var(--text3)"><div style="font-size:40px;margin-bottom:12px">📋</div><div style="font-size:16px;font-weight:700;margin-bottom:6px">No records yet</div><div class="muted">Tap an anode on the keel map to start</div></div>`;return;}
  const sorted=[...inspections].sort((a,b)=>b.id-a.id);
  const uvs=[...new Set(sorted.map(r=>r.vessel))];
  document.getElementById('content').innerHTML=`
    <div class="card" style="padding:9px 12px;margin-bottom:8px"><div class="grid2" style="gap:7px">
      <select id="rfv" onchange="recFilterVessel=this.value;filterRecords()">
        <option value="">All vessels</option>
        ${uvs.map(v=>`<option ${recFilterVessel===v?'selected':''}>${v}</option>`).join('')}
      </select>
      <select id="rfvrd" onchange="recFilterVerdict=this.value;filterRecords()">
        <option value="">All verdicts</option>
        <option ${recFilterVerdict==='PASS'?'selected':''}>PASS</option>
        <option ${recFilterVerdict==='FAIL'?'selected':''}>FAIL</option>
        <option ${recFilterVerdict==='REVIEW REQUIRED'?'selected':''}>REVIEW REQUIRED</option>
      </select>
    </div></div>
    <div class="card" id="rlist"></div>
    <div class="btn-row">
      <button class="btn btn-sm" data-action="exp-json">Export JSON</button>
      <button class="btn btn-sm" onclick="document.getElementById('impf').click()">Import JSON</button>
      <input type="file" id="impf" accept=".json" style="display:none" onchange="impJSON(this)">
      <button class="btn btn-sm" style="color:var(--navy);border-color:var(--navy)" data-action="demo-data">Load demo data</button>
      <button class="btn btn-sm" style="color:var(--fail);border-color:var(--fail-br);margin-left:auto" data-action="reset-all-data">Reset all data</button>
    </div>`;
  filterRecords();
}

function filterRecords(){
  const sorted=[...inspections].sort((a,b)=>b.id-a.id);
  const fv=recFilterVessel, fvrd=recFilterVerdict;
  const f=sorted.filter(r=>(fv?r.vessel===fv:true)&&(fvrd?r.verdict===fvrd:true));
  document.getElementById('rlist').innerHTML=f.length
    ?f.map(r=>`<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:0.5px solid var(--border);cursor:pointer" onclick="openRec('${r.id}')">
        <span class="badge ${r.verdict==='PASS'?'badge-pass':r.verdict==='FAIL'?'badge-fail':'badge-review'}">${r.verdict}</span>
        <div style="flex:1"><div style="font-size:13px;font-weight:700">${r.anodeId} — ${r.vessel||'—'}</div>
          <div style="font-size:11px;color:var(--text3)">${r.program||''} · ${r.date||''} · ${r.inspector||'—'}</div>
        </div><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </div>`).join('')
    :'<div class="muted" style="padding:14px;text-align:center">No records match filter</div>';
}
function openRec(id){
  const r=inspections.find(x=>x.id===id);if(!r)return;
  const v=r.verdict,vc=v==='PASS'?'var(--pass)':v==='FAIL'?'var(--fail)':'var(--warn)',vbg=v==='PASS'?'var(--pass-bg)':v==='FAIL'?'var(--fail-bg)':'var(--warn-bg)';
  document.getElementById('content').innerHTML=`
    <div class="btn-row" style="margin-bottom:8px">
      <button class="btn btn-sm" onclick="renderRecords()">← Records</button>
      <button class="btn btn-sm" style="color:var(--fail)" onclick="delRec('${r.id}')">Delete</button>
      <button class="btn btn-sm" onclick="printSingle('${r.id}')">Print/PDF</button>
    </div>
    <div class="vbanner" style="background:${vbg}">
      <div class="vicon" style="background:${vc}">${v==='PASS'?'✓':v==='FAIL'?'✗':'!'}</div>
      <div><div style="font-size:18px;font-weight:800;color:${vc}">${v}</div><div style="font-size:12px;color:${vc}">${(r.verdictReasons||[]).join(' · ')}</div></div>
    </div>
    <div class="card">${[['Anode ID',r.anodeId],['Section',r.section],['Side',r.side||'—'],['Vessel',r.vessel],['Program',r.program],['Inspector',r.inspector||'—'],['Date',r.date],['Remarks',r.remarks||'—'],['Notes',r.notes||'—']].map(([k,val])=>`<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:0.5px solid var(--border);font-size:13px;gap:8px"><span style="color:var(--text2);font-weight:600;flex-shrink:0">${k}</span><span style="text-align:right">${val}</span></div>`).join('')}</div>
    <div class="card"><div class="card-title">Checklist</div>${CHECKLIST.map(c=>{const ok=(r.checklistAnswers||{})[c.id]!==false;return`<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:0.5px solid var(--border);font-size:13px"><span>${c.text}</span><span class="badge ${ok?'badge-pass':'badge-fail'}">${ok?'PASS':'FAIL'}</span></div>`;}).join('')}</div>`;
}
async function delRec(id){if(!confirm('Delete?'))return;await dbDel(id);inspections=inspections.filter(x=>x.id!==id);renderRecords();}

/* ══════════════════════════════════════
   STATS PAGE — hotspot analysis + comparison
   ══════════════════════════════════════ */
let statsView='overview'; // 'overview' | 'hotspot' | 'compare'

function renderStats(){
  document.getElementById('topbar-title').textContent='Analysis & Reports';
  document.getElementById('topbar-sub').textContent='Failure hotspots · Vessel comparison';

  if(!inspections.length){
    document.getElementById('content').innerHTML=`
      <div style="text-align:center;padding:44px 20px;color:var(--text3)">
        <div style="font-size:40px;margin-bottom:12px">📊</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:6px">No data yet</div>
        <div class="muted">Load demo data from Records tab to see analysis</div>
      </div>`;
    return;
  }

  const uvs  = [...new Set(inspections.map(r=>r.vessel))].sort();
  const upgs = [...new Set(inspections.map(r=>r.program))].sort();

  document.getElementById('content').innerHTML=`
    <!-- View tabs -->
    <div style="display:flex;gap:5px;margin-bottom:10px;overflow-x:auto">
      <button class="sec-tab ${statsView==='overview'?'active':''}" onclick="statsView='overview';updStats()">Overview</button>
      <button class="sec-tab ${statsView==='hotspot'?'active':''}" onclick="statsView='hotspot';updStats()">Hotspot Map</button>
      <button class="sec-tab ${statsView==='compare'?'active':''}" onclick="statsView='compare';updStats()">Program Compare</button>
    </div>

    <!-- Filters -->
    <div class="card" style="padding:10px 12px;margin-bottom:10px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <select id="sfv" onchange="updStats()">
          <option value="">All vessels</option>
          ${uvs.map(v=>`<option>${v}</option>`).join('')}
        </select>
        <select id="sfp" onchange="updStats()">
          <option value="">All programs</option>
          ${upgs.map(p=>`<option>${p}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- Dynamic content area -->
    <div id="stats-body"></div>

    <!-- PDF Reports -->
    <div class="card" style="margin-top:10px">
      <div class="card-title">Generate PDF reports</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <select id="pdf-sec-vessel" style="flex:1;min-width:110px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--rs);font-size:12px">
            ${uvs.map(v=>`<option>${v}</option>`).join('')}
          </select>
          <select id="pdf-sec-prog" style="flex:1;min-width:130px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--rs);font-size:12px">
            ${upgs.map(p=>`<option>${p}</option>`).join('')}
          </select>
          <select id="pdf-sec-num" style="width:110px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--rs);font-size:12px">
            ${SECTIONS.map(s=>`<option value="${s}">Section ${s}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-primary" data-action="pdf-section">Section PDF</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <select id="pdf-all-vessel" style="flex:1;min-width:110px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--rs);font-size:12px">
            ${uvs.map(v=>`<option>${v}</option>`).join('')}
          </select>
          <select id="pdf-all-prog" style="flex:1;min-width:130px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--rs);font-size:12px">
            ${upgs.map(p=>`<option>${p}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-primary" data-action="pdf-overall">Overall PDF</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <select id="pdf-cmp-vessel" style="flex:1;min-width:110px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--rs);font-size:12px">
            <option value="">All vessels</option>
            ${uvs.map(v=>`<option>${v}</option>`).join('')}
          </select>
          <button class="btn btn-sm btn-primary" data-action="pdf-compare">Comparison PDF</button>
        </div>
      </div>
    </div>`;

  updStats();
}

function updStats(){
  const fv   = document.getElementById('sfv')?.value  || '';
  const fp   = document.getElementById('sfp')?.value  || '';
  const data = inspections.filter(r=>(fv?r.vessel===fv:true)&&(fp?r.program===fp:true));
  const body = document.getElementById('stats-body');
  if(!body) return;

  // Update tab active states
  document.querySelectorAll('.sec-tab').forEach(b=>{
    const v=b.textContent.toLowerCase().replace(/ /g,'');
    b.classList.toggle('active',
      (v==='overview'&&statsView==='overview')||
      (v==='hotspotmap'&&statsView==='hotspot')||
      (v==='programcompare'&&statsView==='compare')
    );
  });

  if(statsView==='overview')  body.innerHTML = renderOverview(data, fv, fp);
  if(statsView==='hotspot')   body.innerHTML = renderHotspot(data, fv, fp);
  if(statsView==='compare')   body.innerHTML = renderCompare(fv);
}

/* ── VIEW 1: Overview ── */
function renderOverview(data, fv, fp){
  const pass  = data.filter(r=>r.verdict==='PASS').length;
  const fail  = data.filter(r=>r.verdict==='FAIL').length;
  const rev   = data.filter(r=>r.verdict==='REVIEW REQUIRED').length;
  const total = data.length;
  const failPct = total ? Math.round(fail/total*100) : 0;

  const mx = Math.max(...SECTIONS.map(s=>data.filter(r=>r.section==s).length), 1);

  const secBars = SECTIONS.map(s=>{
    const sd=data.filter(r=>r.section==s);
    const p=sd.filter(r=>r.verdict==='PASS').length;
    const f=sd.filter(r=>r.verdict==='FAIL').length;
    const r=sd.filter(r=>r.verdict==='REVIEW REQUIRED').length;
    const pw=Math.round(p/mx*100), fw=Math.round(f/mx*100), rw=Math.round(r/mx*100);
    return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="width:68px;font-size:11px;font-weight:700;color:var(--text2)">Section ${s}</div>
      <div style="flex:1;height:22px;background:var(--gray-lt);border-radius:4px;overflow:hidden;display:flex">
        <div style="background:var(--pass);width:${pw}%;display:flex;align-items:center;justify-content:flex-end;padding-right:3px">
          ${p?`<span style="font-size:9px;font-weight:800;color:#fff">${p}</span>`:''}
        </div>
        <div style="background:var(--fail);width:${fw}%;display:flex;align-items:center;padding-left:3px">
          ${f?`<span style="font-size:9px;font-weight:800;color:#fff">${f}</span>`:''}
        </div>
        <div style="background:var(--warn);width:${rw}%;"></div>
      </div>
      <div style="width:36px;font-size:10px;color:var(--text3);font-weight:600;text-align:right">${sd.length}</div>
    </div>`;
  }).join('');

  // Top 10 fail anodes
  const fm={};
  data.filter(r=>r.verdict==='FAIL').forEach(r=>{fm[r.anodeId]=(fm[r.anodeId]||0)+1;});
  const top=Object.entries(fm).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topHtml = top.length
    ? top.map(([id,cnt])=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:0.5px solid var(--border);font-size:12px">
        <span style="font-weight:700;min-width:80px;color:var(--navy)">${id}</span>
        <div style="flex:1;background:var(--gray-lt);border-radius:3px;height:8px;overflow:hidden">
          <div style="background:var(--fail);width:${Math.round(cnt/top[0][1]*100)}%;height:100%;border-radius:3px"></div>
        </div>
        <span style="font-weight:700;color:var(--fail);min-width:50px;text-align:right">${cnt} FAIL</span>
      </div>`).join('')
    : '<div class="muted" style="padding:12px;text-align:center">No fails recorded</div>';

  // Side breakdown
  const sideBars = ['PORT','STARBOARD'].map(side=>{
    const sd=data.filter(r=>r.side===side||r.anodeId?.includes(side==='PORT'?'-P':'-S'));
    const p=sd.filter(r=>r.verdict==='PASS').length;
    const f=sd.filter(r=>r.verdict==='FAIL').length;
    return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
      <div style="width:80px;font-size:11px;font-weight:700;color:var(--text2)">${side}</div>
      <div style="flex:1;height:22px;background:var(--gray-lt);border-radius:4px;overflow:hidden;display:flex">
        <div style="background:var(--pass);width:${sd.length?Math.round(p/sd.length*100):0}%;display:flex;align-items:center;justify-content:flex-end;padding-right:3px">
          ${p?`<span style="font-size:9px;font-weight:800;color:#fff">${p}</span>`:''}
        </div>
        <div style="background:var(--fail);width:${sd.length?Math.round(f/sd.length*100):0}%;display:flex;align-items:center;padding-left:3px">
          ${f?`<span style="font-size:9px;font-weight:800;color:#fff">${f}</span>`:''}
        </div>
      </div>
      <div style="width:36px;font-size:10px;color:var(--text3);font-weight:600;text-align:right">${sd.length}</div>
    </div>`;
  }).join('');

  return`
    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:10px">
      <div style="background:var(--gray-lt);border-radius:var(--rs);padding:10px;text-align:center">
        <div style="font-size:22px;font-weight:800">${total}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:2px">Total</div>
      </div>
      <div style="background:var(--pass-bg);border-radius:var(--rs);padding:10px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:var(--pass)">${pass}</div>
        <div style="font-size:10px;color:var(--pass);margin-top:2px">PASS</div>
      </div>
      <div style="background:var(--fail-bg);border-radius:var(--rs);padding:10px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:var(--fail)">${fail}</div>
        <div style="font-size:10px;color:var(--fail);margin-top:2px">FAIL</div>
      </div>
      <div style="background:var(--warn-bg);border-radius:var(--rs);padding:10px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:var(--warn)">${failPct}%</div>
        <div style="font-size:10px;color:var(--warn);margin-top:2px">Fail rate</div>
      </div>
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Pass / Fail by section</div>${secBars}
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Pass / Fail by side</div>${sideBars}
    </div>
    <div class="card" style="margin-bottom:10px">
      <div class="card-title">Top 10 FAIL anodes</div>${topHtml}
    </div>`;
}

/* ── VIEW 2: Hotspot Map ── */
function renderHotspot(data, fv, fp){
  // Build fail count per anode across all sections
  const failMap={}, totalMap={};
  data.forEach(r=>{
    totalMap[r.anodeId]=(totalMap[r.anodeId]||0)+1;
    if(r.verdict==='FAIL') failMap[r.anodeId]=(failMap[r.anodeId]||0)+1;
  });

  const maxFail = Math.max(...Object.values(failMap), 1);

  // Heat colour: white → yellow → orange → red based on fail count
  function heatCol(id){
    const f = failMap[id] || 0;
    const t = totalMap[id] || 0;
    if(!t) return {f:'rgba(255,255,255,0.05)', st:'rgba(200,200,200,0.3)', lbl:'#ccc'};
    const rate = f/t;
    if(rate===0)    return {f:'rgba(234,243,222,0.8)', st:'#97C459', lbl:'#27500A'};
    if(rate<0.25)   return {f:'rgba(255,237,180,0.85)', st:'#E8A800', lbl:'#7a5500'};
    if(rate<0.5)    return {f:'rgba(255,190,100,0.85)', st:'#E06000', lbl:'#7a3000'};
    if(rate<0.75)   return {f:'rgba(255,140,80,0.88)', st:'#CC3300', lbl:'#660000'};
    return           {f:'rgba(252,80,80,0.9)',  st:'#CC0000', lbl:'#660000'};
  }

  // Build hotspot SVG for selected section
  const [hotSec, setHotSec] = [parseInt(document.getElementById('hot-sec-sel')?.value||'1'), null];

  function hotSpot(cx, cy, w, h, id){
    const {f,st,lbl}=heatCol(id);
    const off=calibrateOffsets[id]||{dx:0,dy:0,dw:0,dh:0};
    const rx=cx+off.dx, ry=cy+off.dy;
    const rw=(w+(off.dw||0))*mapBoxScale;
    const rh=(h+(off.dh||0))*mapBoxScale;
    const fc=failMap[id]||0;
    const tc=totalMap[id]||0;
    const label=id.split('-')[1];
    return`<g>
      <rect x="${rx-rw/2}" y="${ry-rh/2}" width="${rw}" height="${rh}" rx="3" fill="${f}" stroke="${st}" stroke-width="2"/>
      <text x="${rx}" y="${ry+1}" text-anchor="middle" dominant-baseline="central"
            font-size="${mapFontSize}" font-weight="700" fill="${lbl}" font-family="sans-serif">${label}</text>
      ${fc>0?`<text x="${rx}" y="${ry-rh/2-3}" text-anchor="middle" font-size="7" fill="${st}" font-family="sans-serif" font-weight="800">${fc}F</text>`:''}
    </g>`;
  }

  const sec = parseInt(document.getElementById('hot-sec-sel')?.value||'1');
  const an=ALL[sec], port=an.slice(0,30), stbd=an.slice(30);
  const NW=46,NH=34,KW=44,KH=28;
  let svg='';
  [115,330,550,720,940,1085].forEach((cx,i)=>{ svg+=hotSpot(cx,145,NW,NH,port[i].id); });
  svg+=hotSpot(115,340,NH,NW,port[6].id); svg+=hotSpot(1085,340,NH,NW,port[7].id);
  [280,490,700,910].forEach((cx,i)=>{ svg+=hotSpot(cx,490,NW,NH,port[8+i].id); svg+=hotSpot(cx,570,NW,NH,port[12+i].id); });
  svg+=hotSpot(115,580,NH,NW,port[16].id); svg+=hotSpot(1085,580,NH,NW,port[17].id);
  [...Array(12)].forEach((_,i)=>{ svg+=hotSpot(115+i*(970/11),625,KW,KH,port[18+i].id); });
  [115,330,550,720,940,1085].forEach((cx,i)=>{ svg+=hotSpot(cx,1165,NW,NH,stbd[i].id); });
  svg+=hotSpot(115,960,NH,NW,stbd[6].id); svg+=hotSpot(1085,960,NH,NW,stbd[7].id);
  [280,490,700,910].forEach((cx,i)=>{ svg+=hotSpot(cx,825,NW,NH,stbd[8+i].id); svg+=hotSpot(cx,745,NW,NH,stbd[12+i].id); });
  svg+=hotSpot(115,730,NH,NW,stbd[16].id); svg+=hotSpot(1085,730,NH,NW,stbd[17].id);
  [...Array(12)].forEach((_,i)=>{ svg+=hotSpot(115+i*(970/11),690,KW,KH,stbd[18+i].id); });

  const totalFails=Object.values(failMap).reduce((a,b)=>a+b,0);
  const worstAnodes=Object.entries(failMap).sort((a,b)=>b[1]-a[1]).slice(0,5);

  return`
    <!-- Heat legend -->
    <div class="card" style="padding:10px 14px;margin-bottom:8px">
      <div style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px">Failure heat legend</div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px">
        <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:14px;border-radius:2px;background:rgba(234,243,222,0.8);border:1px solid #97C459;display:inline-block"></span>0%</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:14px;border-radius:2px;background:rgba(255,237,180,0.85);border:1px solid #E8A800;display:inline-block"></span>&lt;25%</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:14px;border-radius:2px;background:rgba(255,190,100,0.85);border:1px solid #E06000;display:inline-block"></span>&lt;50%</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:14px;border-radius:2px;background:rgba(255,140,80,0.88);border:1px solid #CC3300;display:inline-block"></span>&lt;75%</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:14px;height:14px;border-radius:2px;background:rgba(252,80,80,0.9);border:1px solid #CC0000;display:inline-block"></span>≥75%</span>
        <span style="color:var(--text3);margin-left:4px">= % of inspections that failed</span>
      </div>
    </div>

    <!-- Section selector for hotspot -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <select id="hot-sec-sel" onchange="updStats()"
        style="padding:6px 10px;border:1.5px solid var(--navy);border-radius:20px;background:var(--white);
               font-size:12px;font-weight:700;color:var(--navy);appearance:none;padding-right:24px;
               background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22%3E%3Cpath d=%22M1 1l4 4 4-4%22 stroke=%22%230C447C%22 stroke-width=%221.5%22 fill=%22none%22/%3E%3C/svg%3E');
               background-repeat:no-repeat;background-position:right 8px center">
        ${SECTIONS.map(s=>`<option value="${s}" ${s==sec?'selected':''}>Section ${s}</option>`).join('')}
      </select>
      <span style="font-size:12px;color:var(--text2)">${totalFails} total fails across ${Object.keys(failMap).length} anodes</span>
    </div>

    <!-- Hotspot map -->
    <div style="background:var(--gray-lt);border-radius:var(--rs);overflow:hidden;margin-bottom:10px">
      <div style="position:relative;display:inline-block;width:100%">
        <img src="assets/keel_section.png" style="width:100%;display:block;user-select:none">
        <svg viewBox="0 0 1200 1314" style="position:absolute;top:0;left:0;width:100%;height:100%">
          ${svg}
        </svg>
      </div>
    </div>

    <!-- Worst anodes -->
    ${worstAnodes.length?`
    <div class="card">
      <div class="card-title">Most failed anodes — Section ${sec}</div>
      ${worstAnodes.map(([id,cnt])=>{
        const tot=totalMap[id]||1;
        const rate=Math.round(cnt/tot*100);
        return`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid var(--border)">
          <span style="font-weight:700;min-width:80px;color:var(--navy);font-size:13px">${id}</span>
          <div style="flex:1">
            <div style="height:8px;background:var(--gray-lt);border-radius:4px;overflow:hidden">
              <div style="background:${rate>=75?'#CC0000':rate>=50?'#CC3300':rate>=25?'#E06000':'#E8A800'};width:${rate}%;height:100%;border-radius:4px"></div>
            </div>
          </div>
          <span style="font-size:12px;font-weight:700;color:var(--fail);min-width:70px;text-align:right">${cnt}/${tot} (${rate}%)</span>
        </div>`;
      }).join('')}
    </div>`:''}`;
}

/* ── VIEW 3: Program Comparison ── */
function renderCompare(fv){
  const vessels = fv ? [fv] : [...new Set(inspections.map(r=>r.vessel))].sort();
  const progs   = [...new Set(inspections.map(r=>r.program))].sort();

  if(progs.length<2){
    return`<div class="card"><div class="muted" style="padding:14px;text-align:center">Need at least 2 programs to compare</div></div>`;
  }

  // ── Per-vessel comparison cards ──────────────────────────────────
  const vesselCards = vessels.map(vessel=>{
    // Fail rate per program per section for this vessel
    const progSecs = progs.map(prog=>{
      return {
        prog,
        sections: SECTIONS.map(s=>{
          const recs = inspections.filter(r=>r.vessel===vessel&&r.program===prog&&r.section==s);
          const fails = recs.filter(r=>r.verdict==='FAIL').length;
          return {total:recs.length, fails, rate:recs.length?Math.round(fails/recs.length*100):null};
        }),
        total: inspections.filter(r=>r.vessel===vessel&&r.program===prog).length,
        fails: inspections.filter(r=>r.vessel===vessel&&r.program===prog&&r.verdict==='FAIL').length,
      };
    });

    // Overall vessel fail rate trend across programs
    const trendBars = progSecs.map(ps=>{
      const rate = ps.total ? Math.round(ps.fails/ps.total*100) : 0;
      const col  = rate>=25?'var(--fail)':rate>=10?'var(--warn)':'var(--pass)';
      return`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
        <div style="font-size:14px;font-weight:800;color:${col}">${rate}%</div>
        <div style="width:100%;height:40px;background:var(--gray-lt);border-radius:4px;overflow:hidden;display:flex;align-items:flex-end">
          <div style="width:100%;background:${col};height:${Math.max(rate,2)}%;border-radius:4px;transition:.3s"></div>
        </div>
        <div style="font-size:9px;color:var(--text3);text-align:center;white-space:nowrap">${ps.prog.replace('Maintenance Program ','P')}</div>
      </div>`;
    }).join('');

    // Section × Program grid
    const gridHeader = `<tr><th style="padding:5px 8px;background:var(--navy);color:#fff;font-size:10px;text-align:left">Section</th>${progs.map(p=>`<th style="padding:5px 8px;background:var(--navy);color:#fff;font-size:10px;text-align:center;white-space:nowrap">${p.replace('Maintenance Program ','P')}</th>`).join('')}</tr>`;

    const gridRows = SECTIONS.map((s,i)=>{
      const cells = progs.map(prog=>{
        const recs=inspections.filter(r=>r.vessel===vessel&&r.program===prog&&r.section==s);
        if(!recs.length) return`<td style="padding:5px 8px;text-align:center;font-size:11px;color:var(--text3);${i%2?'background:var(--gray-lt)':''}">—</td>`;
        const f=recs.filter(r=>r.verdict==='FAIL').length;
        const p=recs.filter(r=>r.verdict==='PASS').length;
        const rate=Math.round(f/recs.length*100);
        const bg=rate>=25?'rgba(252,235,235,0.6)':rate>=10?'rgba(250,238,218,0.6)':'rgba(234,243,222,0.4)';
        const col=rate>=25?'var(--fail)':rate>=10?'var(--warn)':'var(--pass)';
        return`<td style="padding:5px 8px;text-align:center;font-size:11px;background:${i%2?'rgba(241,239,232,0.5)':'white'};${f>0?'background:'+bg:''}">
          <span style="font-weight:700;color:${col}">${rate}%</span>
          <div style="font-size:9px;color:var(--text3)">${f}F/${p}P</div>
        </td>`;
      }).join('');
      return`<tr><td style="padding:5px 8px;font-weight:700;font-size:11px;${i%2?'background:var(--gray-lt)':''}">S${s}</td>${cells}</tr>`;
    }).join('');

    return`
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:14px;font-weight:800;color:var(--navy);margin-bottom:10px">${vessel}</div>

      <!-- Fail rate trend bars per program -->
      <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Fail rate by program</div>
      <div style="display:flex;gap:6px;align-items:flex-end;margin-bottom:12px;height:80px">
        ${trendBars}
      </div>

      <!-- Section × Program grid -->
      <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">Section breakdown</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>${gridHeader}</thead>
          <tbody>${gridRows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  // ── Cross-vessel summary table ────────────────────────────────────
  const crossHeader = `<tr><th style="padding:5px 8px;background:var(--navy);color:#fff;font-size:10px;text-align:left">Vessel</th>${progs.map(p=>`<th style="padding:5px 8px;background:var(--navy);color:#fff;font-size:10px;text-align:center;white-space:nowrap">${p.replace('Maintenance Program ','P')}</th>`).join('')}<th style="padding:5px 8px;background:var(--navy);color:#fff;font-size:10px;text-align:center">Trend</th></tr>`;

  const crossRows = vessels.map((v,i)=>{
    const cells = progs.map(p=>{
      const recs=inspections.filter(r=>r.vessel===v&&r.program===p);
      if(!recs.length) return`<td style="text-align:center;padding:5px 8px;color:var(--text3);${i%2?'background:var(--gray-lt)':''}">—</td>`;
      const f=recs.filter(r=>r.verdict==='FAIL').length;
      const rate=Math.round(f/recs.length*100);
      const col=rate>=25?'var(--fail)':rate>=10?'var(--warn)':'var(--pass)';
      return`<td style="text-align:center;padding:5px 8px;font-weight:700;font-size:12px;color:${col};${i%2?'background:var(--gray-lt)':''}">${rate}%</td>`;
    });
    // Trend: compare first and last program
    const rates=progs.map(p=>{
      const r=inspections.filter(x=>x.vessel===v&&x.program===p);
      return r.length?Math.round(r.filter(x=>x.verdict==='FAIL').length/r.length*100):null;
    }).filter(x=>x!==null);
    const trend = rates.length>=2
      ? (rates[rates.length-1]<rates[0]?'📉 Improving':rates[rates.length-1]>rates[0]?'📈 Worsening':'➡ Stable')
      : '—';
    return`<tr><td style="padding:5px 8px;font-weight:700;font-size:12px;${i%2?'background:var(--gray-lt)':''}">${v}</td>${cells.join('')}<td style="text-align:center;padding:5px 8px;font-size:11px;${i%2?'background:var(--gray-lt)':''}">${trend}</td></tr>`;
  }).join('');

  return`
    <!-- Cross-vessel summary -->
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">Vessel × Program — Fail rate summary</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>${crossHeader}</thead>
          <tbody>${crossRows}</tbody>
        </table>
      </div>
      <div style="font-size:10px;color:var(--text3);margin-top:8px">% = fail rate per program · Trend = first vs last program</div>
    </div>

    <!-- Per-vessel detail -->
    ${vesselCards}`;
}

/* ══════════ PRINT / PDF ══════════
   Three report types:
   1. Section report  — one section, one vessel/program
   2. Overall report  — all sections, one vessel/program
   3. Comparison report — all programs side by side
   ════════════════════════════════ */

/* ── Shared PDF styles ── */
function pdfStyles(){
  return `<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;font-size:10pt;color:#1a1a18;padding:15mm 18mm}
    h1{font-size:16pt;color:#0C447C;margin-bottom:2px}
    h2{font-size:12pt;color:#0C447C;margin:14px 0 6px;border-bottom:2px solid #0C447C;padding-bottom:3px}
    .sub{font-size:9pt;color:#888;margin-bottom:12px}
    table{width:100%;border-collapse:collapse;margin-bottom:12px}
    th{background:#0C447C;color:#fff;padding:5px 8px;text-align:left;font-size:9pt}
    td{padding:5px 8px;border-bottom:1px solid #e0dfd8;font-size:9pt}
    tr:nth-child(even) td{background:#f8f7f3}
    .pass{color:#27500A;font-weight:700}
    .fail{color:#791F1F;font-weight:700}
    .review{color:#633806;font-weight:700}
    .badge-pass{background:#EAF3DE;color:#27500A;padding:2px 7px;border-radius:10px;font-size:8pt;font-weight:700}
    .badge-fail{background:#FCEBEB;color:#791F1F;padding:2px 7px;border-radius:10px;font-size:8pt;font-weight:700}
    .badge-review{background:#FAEEDA;color:#633806;padding:2px 7px;border-radius:10px;font-size:8pt;font-weight:700}
    .kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
    .kpi{border-radius:6px;padding:10px;text-align:center}
    .kpi-val{font-size:22pt;font-weight:800;line-height:1}
    .kpi-lbl{font-size:8pt;margin-top:3px}
    .footer{margin-top:16px;font-size:7pt;color:#888;text-align:center;border-top:1px solid #e0dfd8;padding-top:7px}
    @media print{body{padding:8mm 10mm}}
  </style>`;
}

function pdfHeader(title, sub){
  return `<h1>${title}</h1><div class="sub">${sub} &nbsp;·&nbsp; Generated: ${new Date().toLocaleString()}</div>`;
}

function verdictBadge(v){
  if(!v) return '<span style="color:#888">—</span>';
  const cls = v==='PASS'?'badge-pass':v==='FAIL'?'badge-fail':'badge-review';
  return `<span class="${cls}">${v}</span>`;
}

/* ── 1. Section Report ── */
function buildSectionHTML(vessel, program, sectionNum){
  const data = inspections.filter(r=>r.vessel===vessel && r.program===program && r.section==sectionNum);
  // Get latest record per anode
  const latest = {};
  [...data].sort((a,b)=>a.id-b.id).forEach(r=>{ latest[r.anodeId]=r; });

  const anodes = ALL[sectionNum];
  const total  = anodes.length;
  const pass   = Object.values(latest).filter(r=>r.verdict==='PASS').length;
  const fail   = Object.values(latest).filter(r=>r.verdict==='FAIL').length;
  const review = Object.values(latest).filter(r=>r.verdict==='REVIEW REQUIRED').length;
  const pending = total - Object.keys(latest).length;

  const rows = anodes.map(a=>{
    const r = latest[a.id];
    const v = r?.verdict || '';
    return `<tr>
      <td><b>${a.id}</b></td>
      <td>${a.side}</td>
      <td>${r ? verdictBadge(v) : '<span style="color:#888">Not inspected</span>'}</td>
      <td>${r?.inspector||'—'}</td>
      <td>${r?.date||'—'}</td>
      <td>${r?.remarks||'—'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Section ${sectionNum} Report</title>${pdfStyles()}</head><body>
    ${pdfHeader(`Zinc Anode Inspection — Section ${sectionNum}`,`${vessel} · ${program}`)}
    <div class="kpi-grid">
      <div class="kpi" style="background:#f1f0e8"><div class="kpi-val">${total}</div><div class="kpi-lbl">Total anodes</div></div>
      <div class="kpi" style="background:#EAF3DE"><div class="kpi-val" style="color:#27500A">${pass}</div><div class="kpi-lbl" style="color:#27500A">PASS</div></div>
      <div class="kpi" style="background:#FCEBEB"><div class="kpi-val" style="color:#791F1F">${fail}</div><div class="kpi-lbl" style="color:#791F1F">FAIL</div></div>
    </div>
    ${review ? `<p style="font-size:9pt;margin-bottom:10px;color:#633806">${review} anodes require review &nbsp;·&nbsp; ${pending} not yet inspected</p>` : ''}
    <h2>Anode results — Section ${sectionNum}</h2>
    <table>
      <thead><tr><th>Anode ID</th><th>Side</th><th>Verdict</th><th>Inspector</th><th>Date</th><th>Remarks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="footer">Zinc Anode Inspector · ${vessel} · ${program} · Section ${sectionNum} · Confidential · No data transmitted</div>
  </body></html>`;
}

/* ── 2. Overall Vessel Report (all sections) ── */
function buildOverallHTML(vessel, program){
  const data = inspections.filter(r=>r.vessel===vessel && r.program===program);
  const latest = {};
  [...data].sort((a,b)=>a.id-b.id).forEach(r=>{ latest[r.anodeId]=r; });

  const totalAnodes = SECTIONS.length * 60;
  const pass   = Object.values(latest).filter(r=>r.verdict==='PASS').length;
  const fail   = Object.values(latest).filter(r=>r.verdict==='FAIL').length;
  const review = Object.values(latest).filter(r=>r.verdict==='REVIEW REQUIRED').length;
  const pending = totalAnodes - Object.keys(latest).length;

  const secSummary = SECTIONS.map(s=>{
    const anodes = ALL[s];
    const sp = anodes.filter(a=>latest[a.id]?.verdict==='PASS').length;
    const sf = anodes.filter(a=>latest[a.id]?.verdict==='FAIL').length;
    const sr = anodes.filter(a=>latest[a.id]?.verdict==='REVIEW REQUIRED').length;
    const si = anodes.filter(a=>latest[a.id]).length;
    return `<tr>
      <td><b>Section ${s}</b></td>
      <td class="pass">${sp}</td>
      <td class="fail">${sf}</td>
      <td class="review">${sr}</td>
      <td style="color:#888">${60-si}</td>
      <td>${si}/60</td>
    </tr>`;
  }).join('');

  const failList = Object.entries(latest)
    .filter(([,r])=>r.verdict==='FAIL')
    .map(([id,r])=>`<tr><td><b>${id}</b></td><td>${r.side}</td><td>${r.inspector||'—'}</td><td>${r.date||'—'}</td><td>${r.remarks||'—'}</td></tr>`)
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Overall Report — ${vessel}</title>${pdfStyles()}</head><body>
    ${pdfHeader(`Zinc Anode Inspection — Overall Report`,`${vessel} · ${program}`)}
    <div class="kpi-grid">
      <div class="kpi" style="background:#EAF3DE"><div class="kpi-val" style="color:#27500A">${pass}</div><div class="kpi-lbl" style="color:#27500A">PASS</div></div>
      <div class="kpi" style="background:#FCEBEB"><div class="kpi-val" style="color:#791F1F">${fail}</div><div class="kpi-lbl" style="color:#791F1F">FAIL</div></div>
      <div class="kpi" style="background:#f1f0e8"><div class="kpi-val">${pending}</div><div class="kpi-lbl" style="color:#888">Pending</div></div>
    </div>
    <h2>Summary by section</h2>
    <table>
      <thead><tr><th>Section</th><th>PASS</th><th>FAIL</th><th>Review</th><th>Pending</th><th>Progress</th></tr></thead>
      <tbody>${secSummary}</tbody>
    </table>
    ${failList ? `<h2>FAIL anodes — action required</h2>
    <table>
      <thead><tr><th>Anode ID</th><th>Side</th><th>Inspector</th><th>Date</th><th>Remarks</th></tr></thead>
      <tbody>${failList}</tbody>
    </table>` : '<p style="color:#27500A;font-weight:700;margin-bottom:12px">No FAIL anodes recorded.</p>'}
    <div class="footer">Zinc Anode Inspector · ${vessel} · ${program} · All Sections · Confidential · No data transmitted</div>
  </body></html>`;
}

/* ── 3. Comparison Report ── */
function buildCompareHTML(vessel){
  const filtered = vessel ? inspections.filter(r=>r.vessel===vessel) : inspections;
  const vessels  = vessel ? [vessel] : [...new Set(inspections.map(r=>r.vessel))];
  const progs    = [...new Set(filtered.map(r=>r.program))].sort();

  // For each vessel+program combination, get latest verdict per anode
  function getLatest(v, p){
    const d = filtered.filter(r=>r.vessel===v && r.program===p);
    const latest = {};
    [...d].sort((a,b)=>a.id-b.id).forEach(r=>{ latest[r.anodeId]=r; });
    return latest;
  }

  const combinations = [];
  vessels.forEach(v=>progs.forEach(p=>{
    const d = filtered.filter(r=>r.vessel===v && r.program===p);
    if(d.length) combinations.push({vessel:v, program:p});
  }));

  const colHeaders = combinations.map(c=>`<th style="background:#0C447C;color:#fff;padding:5px 8px;font-size:8pt;text-align:center;white-space:nowrap">${c.vessel}<br><span style="font-weight:400;opacity:.8">${c.program}</span></th>`).join('');

  const secRows = SECTIONS.map((s,i)=>{
    const cells = combinations.map(c=>{
      const lat = getLatest(c.vessel, c.program);
      const anodes = ALL[s];
      const pass = anodes.filter(a=>lat[a.id]?.verdict==='PASS').length;
      const fail = anodes.filter(a=>lat[a.id]?.verdict==='FAIL').length;
      const ins  = anodes.filter(a=>lat[a.id]).length;
      if(!ins) return `<td style="text-align:center;padding:5px 8px;border-bottom:1px solid #e0dfd8;color:#ccc;${i%2?'background:#f8f7f3':''}">—</td>`;
      return `<td style="text-align:center;padding:5px 8px;border-bottom:1px solid #e0dfd8;${i%2?'background:#f8f7f3':''}">
        <span style="color:#27500A;font-weight:700">${pass}P</span> / <span style="color:#791F1F;font-weight:700">${fail}F</span>
      </td>`;
    }).join('');
    return `<tr><td style="padding:5px 8px;border-bottom:1px solid #e0dfd8;font-weight:700;${i%2?'background:#f8f7f3':''}">Section ${s}</td>${cells}</tr>`;
  }).join('');

  // Totals row
  const totalCells = combinations.map(c=>{
    const lat = getLatest(c.vessel, c.program);
    const vals = Object.values(lat);
    const pass = vals.filter(r=>r.verdict==='PASS').length;
    const fail = vals.filter(r=>r.verdict==='FAIL').length;
    return `<td style="text-align:center;padding:6px 8px;font-weight:700;background:#e8e7e0">
      <span style="color:#27500A">${pass}P</span> / <span style="color:#791F1F">${fail}F</span>
    </td>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Comparison Report</title>${pdfStyles()}</head><body>
    ${pdfHeader('Zinc Anode Inspection — Comparison Report', vessel || 'All vessels')}
    <h2>Pass / Fail by section &amp; program</h2>
    <p style="font-size:8pt;color:#888;margin-bottom:8px">Each cell shows PASS / FAIL count for the latest inspection of each anode in that section.</p>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="background:#0C447C;color:#fff;padding:5px 8px;font-size:9pt;text-align:left">Section</th>
        ${colHeaders}
      </tr></thead>
      <tbody>
        ${secRows}
        <tr>
          <td style="padding:6px 8px;font-weight:700;background:#e8e7e0">TOTAL</td>
          ${totalCells}
        </tr>
      </tbody>
    </table></div>
    <div class="footer">Zinc Anode Inspector · Comparison Report · Confidential · No data transmitted</div>
  </body></html>`;
}

/* ── PDF trigger functions ── */
async function savePDF(html, defaultName){
  const w = window.open('','_blank');
  w.document.write(html);
  w.document.close();
  w.onload = ()=>{ w.focus(); w.print(); };
}

async function pdfSection(){
  const vessel = document.getElementById('pdf-sec-vessel')?.value || '';
  const prog   = document.getElementById('pdf-sec-prog')?.value   || '';
  const sec    = document.getElementById('pdf-sec-num')?.value    || '1';
  if(!vessel || !prog){ showToast('Select vessel and program', 'error'); return; }
  await savePDF(buildSectionHTML(vessel, prog, parseInt(sec)), `section-${sec}-report.pdf`);
}

async function pdfOverall(){
  const vessel = document.getElementById('pdf-all-vessel')?.value || '';
  const prog   = document.getElementById('pdf-all-prog')?.value   || '';
  if(!vessel || !prog){ showToast('Select vessel and program', 'error'); return; }
  await savePDF(buildOverallHTML(vessel, prog), `overall-report.pdf`);
}

async function pdfCompare(){
  const vessel = document.getElementById('pdf-cmp-vessel')?.value || '';
  await savePDF(buildCompareHTML(vessel), `comparison-report.pdf`);
}

/* Keep printRep for saving from the verdict screen */
async function printRep(){
  const r={...INS,id:Date.now().toString(),notes:document.getElementById('f-notes')?.value||INS.notes||''};
  // Use overall report for the current vessel/program as a quick save
  const html = buildSectionHTML(r.vessel||SESSION.vessel, r.program||SESSION.program, r.section||1);
  await savePDF(html, `inspection-report.pdf`);
}

async function printSingle(id){
  const r = inspections.find(x=>x.id===id);
  if(!r) return;
  const html = buildSectionHTML(r.vessel, r.program, r.section||1);
  await savePDF(html, `inspection-report.pdf`);
}

/* ══════════ RESET DATA ══════════ */
async function resetAllData(){
  if(!confirm('Delete ALL inspection records?\nThis cannot be undone.\n\nTip: Export JSON first to keep a backup.')) return;
  try{
    await new Promise((res,rej)=>{
      const req=indexedDB.deleteDatabase('ZincAnodeDB');
      req.onsuccess=res; req.onerror=rej;
    });
    inspections=[];
    localStorage.removeItem('zai');
    showToast('All records deleted');
    renderRecords();
  }catch(e){
    showToast('Reset failed: '+e.message,'error');
  }
}


/* ══════════ DEMO DATA ══════════ */
async function loadDemoData(){
  if(!confirm('Load demo data for ALL vessels (A B C D) and ALL programs (1 2 3 4)?\nAll 5 sections will be fully populated.\nExisting data is kept.')) return;

  const VESSELS_DEMO  = ['Vessel A','Vessel B','Vessel C','Vessel D'];
  const PROGRAMS_DEMO = ['Maintenance Program 1','Maintenance Program 2','Maintenance Program 3','Maintenance Program 4'];
  const INSPECTORS    = ['Ahmad','Siti','Rajan','Wei Ling','Omar','Priya','Jason','Sarah'];

  // Date spread per program (quarterly)
  const PROG_DATES = {
    'Maintenance Program 1': ['15 Jan 2026','16 Jan 2026','17 Jan 2026','18 Jan 2026','19 Jan 2026'],
    'Maintenance Program 2': ['15 Apr 2026','16 Apr 2026','17 Apr 2026','18 Apr 2026','19 Apr 2026'],
    'Maintenance Program 3': ['15 Jul 2026','16 Jul 2026','17 Jul 2026','18 Jul 2026','19 Jul 2026'],
    'Maintenance Program 4': ['15 Oct 2026','16 Oct 2026','17 Oct 2026','18 Oct 2026','19 Oct 2026'],
  };

  // Fail rate per vessel — randomised but each vessel has a distinct tendency
  const VESSEL_FAIL_RATE = {
    'Vessel A': 0.10,  // ~10% fail rate (best)
    'Vessel B': 0.18,  // ~18%
    'Vessel C': 0.25,  // ~25%
    'Vessel D': 0.35,  // ~35% (worst)
  };

  // Seeded random using vessel+program+anodeId for reproducibility
  function seededRand(seed){
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }
  function strHash(s){
    let h=0; for(let i=0;i<s.length;i++) h=(Math.imul(31,h)+s.charCodeAt(i))|0;
    return Math.abs(h);
  }
  function randomVerdict(vessel, program, anodeId, section){
    const failRate   = VESSEL_FAIL_RATE[vessel] || 0.15;
    const reviewRate = failRate * 0.5; // review ≈ half of fail rate
    // Add section weight — later sections slightly higher fail rate
    const secWeight  = 1 + (section-1)*0.04;
    const seed       = strHash(vessel+program+anodeId);
    const r1         = seededRand(seed);
    const r2         = seededRand(seed+1);
    if(r1 < failRate * secWeight)          return 'FAIL';
    if(r2 < reviewRate * secWeight)        return 'REVIEW REQUIRED';
    return 'PASS';
  }

  // Section completion — some sections partially inspected for realism
  const SEC_COMPLETION = {1:60, 2:60, 3:60, 4:45, 5:30}; // anodes inspected per section

  const demoRecs=[];
  let id=Date.now();

  VESSELS_DEMO.forEach((vessel, vi)=>{
    PROGRAMS_DEMO.forEach((program, pi)=>{
      const dates = PROG_DATES[program];
      const inspector = INSPECTORS[(vi*4+pi)%INSPECTORS.length];
      const inspector2 = INSPECTORS[(vi*4+pi+1)%INSPECTORS.length];

      // Each vessel×program gets all 5 sections
      [1,2,3,4,5].forEach(sec=>{
        const count = SEC_COMPLETION[sec];
        const anodes = ALL[sec].slice(0, count);

        anodes.forEach((anode, i)=>{
          // Vary fail rate slightly by section (later sections slightly worse)
          const verdict = randomVerdict(vessel, program, anode.id, sec);

          const f=verdict==='FAIL', rv=verdict==='REVIEW REQUIRED';
          const ans = {
            c1:!f, c2:!f, c3:!(f&&i%2===0),
            c4:!(rv||f), c5:!(rv&&i%3===0),
            c6:!(rv&&i%4===0), c7:!f
          };
          const reasons = verdict==='PASS' ? ['All criteria satisfied']
                        : verdict==='FAIL' ? (i%3===0?['Remaining<50%','Core metal exposed']:['Remaining<50%'])
                        : ['Surface condition advisory'];

          demoRecs.push({
            id:(id++).toString(),
            anodeId:anode.id,
            section:sec,
            side:anode.side,
            vessel, program,
            inspector: i%3===0 ? inspector2 : inspector,
            date: dates[Math.floor(i/12)%dates.length],
            verdict, verdictReasons:reasons,
            checklistAnswers:ans,
            remarks: verdict==='FAIL'?'Requires replacement before next sailing':'',
            notes:'',
            savedAt: new Date(2026, pi*3, 15+sec+i).toISOString()
          });
        });
      });
    });
  });

  // Save all
  let added=0;
  for(const r of demoRecs){
    if(!inspections.find(x=>x.id===r.id)){
      await dbPut(r); inspections.push(r); added++;
    }
  }
  showToast(`Demo data loaded — ${added} records added`);
  renderRecords();
}

/* ══════════ EXPORT / IMPORT ══════════ */
async function expJSON(){
  const json = JSON.stringify(inspections, null, 2);
  const name = `zinc-anode-${new Date().toISOString().slice(0,10)}.json`;
  const b = new Blob([json], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Records exported — ' + name);
}

async function impJSON(input){
  if(!input?.files[0]) return;
  try{
    const text = await input.files[0].text();
    const recs = JSON.parse(text);
    let added = 0;
    for(const r of recs){
      if(!inspections.find(x=>x.id===r.id)){
        await dbPut(r);
        inspections.push(r);
        added++;
      }
    }
    showToast(`Imported ${added} new records`);
    if(page==='records') renderRecords();
    if(page==='stats')   renderStats();
  } catch {
    showToast('Invalid JSON file', 'error');
  }
}



/* ══════════ EVENT DELEGATION ══════════
   All clicks inside #content are handled here.
   This avoids inline onclick= in static HTML (blocked by Electron CSP).
   Dynamically rendered HTML (via innerHTML) still uses onclick= fine,
   but the nav buttons in index.html need this approach.
   ════════════════════════════════════ */
document.addEventListener('click', e => {
  // Login submit
  const loginBtn = e.target.closest('[data-action="login-submit"]');
  if(loginBtn){ loginSubmit(); return; }

  // Block all other actions if not authenticated
  if(!authenticated) return;

  // Calibration mode: clicking a hotspot selects it for keyboard nudging
  const hotspot = e.target.closest('[data-id]');
  if (hotspot) {
    if (calibrateMode) {
      calibrateSelected = hotspot.dataset.id;
      const status2={};
      [...inspections].sort((a,b)=>a.id-b.id).forEach(r=>{status2[r.anodeId]={verdict:r.verdict};});
      document.getElementById('keel-hotspots').innerHTML = buildHotspots(activeSection, status2);
      const el = document.getElementById('calib-status');
      if(el) el.textContent = 'Selected: ' + calibrateSelected + ' — use arrow keys to move';
    } else {
      selectAnode(hotspot.dataset.id);
    }
    return;
  }

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const arg    = btn.dataset.arg || '';
  if (action === 'show-page')         showPage(arg);
  if (action === 'select-anode')      selectAnode(arg);
  if (action === 'start-insp')        startInsp(...arg.split(','));
  if (action === 'switch-sec')        switchSec(parseInt(arg));
  if (action === 'open-rec')          openRec(arg);
  if (action === 'del-rec')           delRec(arg);
  if (action === 'print-single')      printSingle(arg);
  if (action === 'session-go')        sessionGo();
  if (action === 'checklist-go')      checklistGo();
  if (action === 'chk-answer')        { const[cid,val]=arg.split(','); chkAnswer(cid,val); }
  if (action === 'override-verdict')  { INS.verdict=arg; INS.verdictReasons=['Manually overridden']; rVerdict(); }
  if (action === 'go-back-checklist') { step=1; renderInspect(); }
  if (action === 'save-inspection')   saveInsp();
  if (action === 'print-report')      printRep();
  if (action === 'exp-json')          { expJSON(); }
  if (action === 'demo-data')         { loadDemoData(); }
  if (action === 'reset-all-data')    { resetAllData(); }
  if (action === 'pdf-section')       pdfSection();
  if (action === 'pdf-overall')       pdfOverall();
  if (action === 'pdf-compare')       pdfCompare();
  if (action === 'toggle-calibrate'){
    calibrateMode = !calibrateMode;
    calibrateSelected = null;
    renderMap();
  }
  if (action === 'copy-offsets')   copyOffsets();
  if (action === 'reset-offsets')  { calibrateOffsets={}; calibrateSelected=null; renderMap(); }
  if (action === 'exp-json')          { expJSON(); }
  if (action === 'reset-all-data')   { resetAllData(); }
  if (action === 'reset-selected') {
    if(calibrateSelected){ delete calibrateOffsets[calibrateSelected]; }
    const status2={};
    [...inspections].sort((a,b)=>a.id-b.id).forEach(r=>{status2[r.anodeId]={verdict:r.verdict};});
    const svg=document.getElementById('keel-hotspots');
    if(svg) svg.innerHTML=buildHotspots(activeSection,status2);
    const el=document.getElementById('calib-status');
    if(el) el.textContent='Reset: '+calibrateSelected;
  }
});

// Keyboard controls for calibration (position + size)
document.addEventListener('keydown', e => {
  if (!calibrateMode || !calibrateSelected) return;

  const moveKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
  const sizeKeys = ['w','s','a','d','W','S','A','D'];
  if (![...moveKeys,...sizeKeys].includes(e.key)) return;

  // Prevent arrow keys from scrolling the page
  if (moveKeys.includes(e.key)) e.preventDefault();

  const step = e.shiftKey ? 10 : 1;
  const off = calibrateOffsets[calibrateSelected] || {dx:0, dy:0, dw:0, dh:0};
  if (!off.dw) off.dw = 0;
  if (!off.dh) off.dh = 0;

  // Position (arrow keys)
  if (e.key === 'ArrowLeft')  off.dx -= step;
  if (e.key === 'ArrowRight') off.dx += step;
  if (e.key === 'ArrowUp')    off.dy -= step;
  if (e.key === 'ArrowDown')  off.dy += step;

  // Size (W/S = height taller/shorter, A/D = width narrower/wider)
  if (e.key === 'D' || e.key === 'd') off.dw += step;  // wider
  if (e.key === 'A' || e.key === 'a') off.dw -= step;  // narrower
  if (e.key === 'S' || e.key === 's') off.dh += step;  // taller
  if (e.key === 'W' || e.key === 'w') off.dh -= step;  // shorter

  calibrateOffsets[calibrateSelected] = off;

  // Redraw hotspots only (fast)
  const status2={};
  [...inspections].filter(r=>r.vessel===SESSION.vessel&&r.program===SESSION.program)
    .sort((a,b)=>a.id-b.id).forEach(r=>{status2[r.anodeId]={verdict:r.verdict};});
  const svg = document.getElementById('keel-hotspots');
  if (svg) svg.innerHTML = buildHotspots(activeSection, status2);

  // Update status display
  const el = document.getElementById('calib-status');
  if (el) {
    el.textContent = calibrateSelected
      + '  pos(' + off.dx + ',' + off.dy + ')'
      + '  size(' + (off.dw>=0?'+':'') + off.dw + 'w, ' + (off.dh>=0?'+':'') + off.dh + 'h)';
  }
});

function copyOffsets(){
  const lines = Object.entries(calibrateOffsets)
    .filter(([,v])=>v.dx!==0||v.dy!==0||v.dw!==0||v.dh!==0)
    .map(([id,v])=>{
      const parts=[];
      if(v.dx) parts.push('dx:'+v.dx);
      if(v.dy) parts.push('dy:'+v.dy);
      if(v.dw) parts.push('dw:'+v.dw);
      if(v.dh) parts.push('dh:'+v.dh);
      return `  '${id}': {${parts.join(', ')}}`;
    });
  const out = 'calibrateOffsets = {\n' + lines.join(',\n') + '\n};';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(out).then(()=>{
      const el=document.getElementById('calib-status');
      if(el) el.textContent='Copied! Paste over the calibrateOffsets line in app.js';
    });
  } else {
    console.log('=== CALIBRATION OFFSETS — paste into app.js ===');
    console.log(out);
    const el=document.getElementById('calib-status');
    if(el) el.textContent='Check DevTools console (Cmd+Option+I) for offsets';
  }
}

/* ══════════ BOOT ══════════ */

// Clear SESSION on every launch — session setup is always required fresh
SESSION = {};

// Restore auth state for this browser tab (lost on tab close/app restart)
authenticated = sessionStorage.getItem('zai_auth') === '1';

// ── Startup visibility test ──────────────────────────────────────────
// Shows immediately so we know JS is running.
// Replaced by the real UI once the database loads.
(function startupTest(){
  const el = document.getElementById('content');
  if(el) el.innerHTML = '<div style="padding:40px;font-size:18px;font-family:sans-serif;color:#0C447C">Loading… JS is running.</div>';
})();

openDB()
  .then(()=>dbAll())
  .then(rows=>{
    inspections = rows;

    // Wire up nav buttons (not inline onclick — works with Electron CSP)
    document.getElementById('nav-map')    ?.addEventListener('click', ()=>showPage('map'));
    document.getElementById('nav-inspect') ?.addEventListener('click', ()=>showPage('session'));
    document.getElementById('nav-records') ?.addEventListener('click', ()=>showPage('records'));
    document.getElementById('nav-stats')   ?.addEventListener('click', ()=>showPage('stats'));

    showPage('session');


  })
  .catch(()=>{
    // IndexedDB unavailable — fall back to localStorage
    try{ inspections=JSON.parse(localStorage.getItem('zai')||'[]'); }
    catch{ inspections=[]; }
    document.getElementById('nav-map')    ?.addEventListener('click', ()=>showPage('map'));
    document.getElementById('nav-inspect') ?.addEventListener('click', ()=>showPage('session'));
    document.getElementById('nav-records') ?.addEventListener('click', ()=>showPage('records'));
    document.getElementById('nav-stats')   ?.addEventListener('click', ()=>showPage('stats'));
    authenticated ? showPage('session') : showPage('login');
  });
