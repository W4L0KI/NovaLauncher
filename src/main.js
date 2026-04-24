const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const childProcess = require('child_process');
const https = require('https');
const http = require('http');

const DEFAULT_GAMES_DIR = 'D:\\Games';
const SGDB_BASE_URL = 'https://www.steamgriddb.com/api/v2';
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const THUMB_DIR = path.join(app.getPath('userData'), 'cache', 'thumbs');
const COVER_CACHE_DIR = path.join(app.getPath('userData'), 'cache', 'covers');

const EXCLUDED_DIRS = new Set(['node_modules','.git','dist','build','launcher','logs','_redist','_commonredist','redist','redistributables','directx','vcredist','crashreportclient','crashes','nodvd','crack','online fix','_windows 7 fix']);
const BAD_EXE_WORDS = ['setup','install','uninstall','unins','vcredist','vc_redist','dxsetup','crash','unitycrashhandler','ue4crashreporter','benchmark','server','editor','eac','easyanticheat','launcher','helper','redistributable'];

function readJSON(file, fallback){ try { return JSON.parse(fs.readFileSync(file,'utf-8')); } catch { return fallback; } }
function writeJSON(file, data){ fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(data,null,2),'utf-8'); }
function cfg(){
  const c = readJSON(CONFIG_FILE, {});
  return {
    gamesDir: c.gamesDir || DEFAULT_GAMES_DIR,
    favorites: c.favorites || {},
    hidden: c.hidden || {},
    customCovers: c.customCovers || {},
    sgdbCovers: c.sgdbCovers || {},
    sgdbMisses: c.sgdbMisses || {},
    steamGridDbApiKey: c.steamGridDbApiKey || '',
    autoFetchCovers: c.autoFetchCovers !== false,
    lastPlayed: c.lastPlayed || {},
    playCount: c.playCount || {}
  };
}
function saveConfigPatch(patch){ const c = cfg(); Object.assign(c, patch); writeJSON(CONFIG_FILE, c); return c; }
function normalizeName(name){ return name.replace(/[_\-.]+/g,' ').replace(/\b(win64|shipping|windows|x64|binaries|game|launcher)\b/gi,' ').replace(/\s+/g,' ').trim(); }
function slugify(name){ return normalizeName(name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function comparableName(name){ return normalizeName(name).toLowerCase().replace(/[^a-z0-9]+/g,''); }
async function exists(p){ try { await fsp.access(p); return true; } catch { return false; } }

async function walkForExes(dir, maxDepth=7, depth=0, acc=[]){
  if(depth > maxDepth) return acc;
  let entries; try { entries = await fsp.readdir(dir, {withFileTypes:true}); } catch { return acc; }
  for(const e of entries){
    const full = path.join(dir, e.name);
    if(e.isDirectory()){
      if(EXCLUDED_DIRS.has(e.name.toLowerCase())) continue;
      await walkForExes(full, maxDepth, depth+1, acc);
    } else if(e.isFile() && e.name.toLowerCase().endsWith('.exe')) acc.push(full);
  }
  return acc;
}
function scoreExe(exePath, gameName, gameRoot){
  const file = path.basename(exePath).toLowerCase();
  const rel = path.relative(gameRoot, exePath).toLowerCase();
  const gameSlug = slugify(gameName), fileSlug = slugify(file.replace(/\.exe$/i,''));
  let s = 0;
  if(path.dirname(exePath).toLowerCase() === gameRoot.toLowerCase()) s += 120;
  if(rel.includes('binaries\\win64') || rel.includes('binaries/win64')) s += 85;
  if(file.includes('win64-shipping')) s += 95;
  if(fileSlug.includes(gameSlug) || gameSlug.includes(fileSlug)) s += 110;
  if(fileSlug.split('-').some(t => t.length > 3 && gameSlug.includes(t))) s += 35;
  if(rel.includes('engine')) s -= 45;
  if(rel.split(/[\\/]/).some(p => ['nodvd','crack','online fix'].includes(p))) s -= 999;
  if(BAD_EXE_WORDS.some(w => file.includes(w))) s -= 300;
  try { const st = fs.statSync(exePath); if(st.size > 15*1024*1024) s += 12; if(st.size < 500*1024) s -= 25; } catch {}
  return s;
}
async function findBestExe(root, name){
  const exes = await walkForExes(root);
  if(!exes.length) return null;
  const ranked = exes.map(exe => ({exe, score: scoreExe(exe,name,root)})).sort((a,b)=>b.score-a.score);
  return ranked[0].score < -100 ? null : ranked[0].exe;
}
async function findLocalCover(root, name, config){
  const slug = slugify(name);
  if(config.customCovers[slug] && await exists(config.customCovers[slug])) return config.customCovers[slug];
  if(config.sgdbCovers[slug] && await exists(config.sgdbCovers[slug])) return config.sgdbCovers[slug];
  for(const ext of ['jpg','jpeg','png','webp']){ const p = path.join(app.getAppPath(),'assets','covers',`${slug}.${ext}`); if(await exists(p)) return p; }
  for(const n of ['cover','poster','art','capsule','banner','hero','folder']) for(const ext of ['jpg','jpeg','png','webp']){ const p = path.join(root,`${n}.${ext}`); if(await exists(p)) return p; }
  return null;
}
async function makeExeThumb(exePath, slug){
  if(!exePath) return null;
  await fsp.mkdir(THUMB_DIR,{recursive:true});
  const target = path.join(THUMB_DIR, `${slug}.png`);
  if(await exists(target)) return target;
  try { const img = await nativeImage.createThumbnailFromPath(exePath,{width:512,height:512}); if(!img.isEmpty()){ await fsp.writeFile(target,img.toPNG()); return target; } } catch {}
  return null;
}
function sgdbHeaders(apiKey){ return { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': 'NovaLauncher/1.1' }; }
async function sgdbGet(pathname, apiKey){
  const url = `${SGDB_BASE_URL}${pathname}`;
  const res = await fetch(url, { headers: sgdbHeaders(apiKey) });
  if(!res.ok){
    const body = await res.text().catch(()=> '');
    throw new Error(`SteamGridDB ${res.status}: ${body.slice(0,120) || res.statusText}`);
  }
  return res.json();
}
function scoreSgdbGame(candidate, query){
  const q = comparableName(query);
  const n = comparableName(candidate.name || '');
  let s = 0;
  if(n === q) s += 1000;
  if(n.includes(q) || q.includes(n)) s += 450;
  const qWords = normalizeName(query).toLowerCase().split(/\s+/).filter(w=>w.length>1);
  const nWords = normalizeName(candidate.name || '').toLowerCase().split(/\s+/);
  s += qWords.filter(w => nWords.includes(w)).length * 60;
  if(candidate.verified) s += 50;
  if(candidate.types?.includes?.('game')) s += 20;
  return s;
}
async function searchSgdbGameId(gameName, apiKey){
  const data = await sgdbGet(`/search/autocomplete/${encodeURIComponent(gameName)}`, apiKey);
  const results = Array.isArray(data.data) ? data.data : [];
  if(!results.length) return null;
  const ranked = results.map(g => ({...g, _score: scoreSgdbGame(g, gameName)})).sort((a,b)=>b._score-a._score);
  return ranked[0];
}
async function downloadFile(url, targetWithoutExt){
  await fsp.mkdir(path.dirname(targetWithoutExt), {recursive:true});
  const parsed = new URL(url);
  const mod = parsed.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: { 'User-Agent': 'NovaLauncher/1.1' } }, res => {
      if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        res.resume();
        return resolve(downloadFile(new URL(res.headers.location, url).toString(), targetWithoutExt));
      }
      if(res.statusCode !== 200){ res.resume(); return reject(new Error(`Téléchargement image ${res.statusCode}`)); }
      const contentType = String(res.headers['content-type'] || '');
      let ext = path.extname(parsed.pathname).replace('.','').toLowerCase();
      if(!['jpg','jpeg','png','webp'].includes(ext)){
        if(contentType.includes('png')) ext = 'png';
        else if(contentType.includes('webp')) ext = 'webp';
        else ext = 'jpg';
      }
      const target = `${targetWithoutExt}.${ext === 'jpeg' ? 'jpg' : ext}`;
      const out = fs.createWriteStream(target);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(target)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('Timeout téléchargement image')); });
  });
}
async function fetchSteamGridCover(gameName, slug, apiKey){
  if(!apiKey) return null;
  const game = await searchSgdbGameId(gameName, apiKey);
  if(!game?.id) return null;

  let artwork = await sgdbGet(`/grids/game/${game.id}?types=static&dimensions=600x900,342x482`, apiKey).catch(()=>null);
  let images = Array.isArray(artwork?.data) ? artwork.data : [];
  if(!images.length){
    artwork = await sgdbGet(`/grids/game/${game.id}?types=static`, apiKey).catch(()=>null);
    images = Array.isArray(artwork?.data) ? artwork.data : [];
  }
  if(!images.length){
    artwork = await sgdbGet(`/grids/game/${game.id}`, apiKey).catch(()=>null);
    images = Array.isArray(artwork?.data) ? artwork.data : [];
  }
  if(!images.length) return null;

  const selected = images
    .filter(img => img.url || img.thumb)
    .map(img => {
      const w = Number(img.width || 0), h = Number(img.height || 0);
      const verticalBonus = h > w ? 300 : 0;
      const sizeBonus = Math.min(w*h/10000, 80);
      const stylePenalty = String(img.style || '').toLowerCase().includes('blurred') ? -120 : 0;
      return {...img, _score: verticalBonus + sizeBonus + stylePenalty + Number(img.score || 0)};
    })
    .sort((a,b)=>b._score-a._score)[0];
  if(!selected) return null;

  const base = path.join(COVER_CACHE_DIR, slug);
  for(const ext of ['jpg','jpeg','png','webp']){ try { await fsp.unlink(`${base}.${ext}`); } catch {} }
  const downloaded = await downloadFile(selected.url || selected.thumb, base);
  return { path: downloaded, sgdbGameId: game.id, sgdbGameName: game.name };
}
async function coverForGame(root, name, config, { forceApi=false } = {}){
  const slug = slugify(name);
  const local = !forceApi ? await findLocalCover(root, name, config) : null;
  if(local) return { cover: local, source: config.sgdbCovers[slug] === local ? 'steamgriddb-cache' : 'local' };

  const miss = config.sgdbMisses[slug];
  const missStillFresh = miss && Date.now() - new Date(miss).getTime() < 1000 * 60 * 60 * 24 * 3;
  if(config.autoFetchCovers && config.steamGridDbApiKey && (!missStillFresh || forceApi)){
    try{
      const fetched = await fetchSteamGridCover(name, slug, config.steamGridDbApiKey);
      const c = cfg();
      if(fetched?.path){
        c.sgdbCovers[slug] = fetched.path;
        delete c.sgdbMisses[slug];
        writeJSON(CONFIG_FILE, c);
        return { cover: fetched.path, source: 'steamgriddb', sgdbGameId: fetched.sgdbGameId, sgdbGameName: fetched.sgdbGameName };
      }
      c.sgdbMisses[slug] = new Date().toISOString();
      writeJSON(CONFIG_FILE, c);
    } catch(e){
      console.warn(`SteamGridDB cover failed for ${name}:`, e.message);
    }
  }
  return { cover: null, source: null };
}
async function scanGames(){
  const config = cfg();
  let entries=[]; try { entries = await fsp.readdir(config.gamesDir,{withFileTypes:true}); } catch {}
  const dirs = entries.filter(e=>e.isDirectory() && !e.name.startsWith('.') && !EXCLUDED_DIRS.has(e.name.toLowerCase()));
  const games=[];
  for(const d of dirs){
    const root = path.join(config.gamesDir,d.name), name = normalizeName(d.name), id = slugify(name);
    if(config.hidden[id]) continue;
    const exe = await findBestExe(root,name);
    const coverInfo = await coverForGame(root,name,config);
    const thumb = coverInfo.cover ? null : await makeExeThumb(exe,id);
    games.push({id,name,root,exe,cover:coverInfo.cover||thumb,coverSource:coverInfo.cover?coverInfo.source:(thumb?'exe-icon':null),favorite:!!config.favorites[id],lastPlayed:config.lastPlayed[id]||null,playCount:config.playCount[id]||0,status:exe?'ready':'missing-exe'});
  }
  games.sort((a,b)=>Number(b.favorite)-Number(a.favorite)||a.name.localeCompare(b.name));
  return {gamesDir:config.gamesDir,games,settings:{hasSgdbKey:!!config.steamGridDbApiKey,autoFetchCovers:config.autoFetchCovers}};
}
function createWindow(){
  const win = new BrowserWindow({width:1380,height:860,minWidth:980,minHeight:680,backgroundColor:'#070914',title:'Nova Launcher',titleBarStyle:'hidden',titleBarOverlay:{color:'#070914',symbolColor:'#f5f7ff',height:42},webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  win.loadFile(path.join(__dirname,'index.html'));
}
app.whenReady().then(()=>{ createWindow(); app.on('activate',()=>{ if(BrowserWindow.getAllWindows().length===0) createWindow(); }); });
app.on('window-all-closed',()=>{ if(process.platform!=='darwin') app.quit(); });
ipcMain.handle('games:scan', scanGames);
ipcMain.handle('games:launch', async (_e, game)=>{ if(!game?.exe || !(await exists(game.exe))) return {ok:false,error:'Executable introuvable.'}; try { childProcess.spawn(game.exe,[],{cwd:path.dirname(game.exe),detached:true,stdio:'ignore'}).unref(); const c=cfg(); c.lastPlayed[game.id]=new Date().toISOString(); c.playCount[game.id]=(c.playCount[game.id]||0)+1; writeJSON(CONFIG_FILE,c); return {ok:true}; } catch(e){ return {ok:false,error:e.message}; } });
ipcMain.handle('games:open-folder', async (_e, folder)=>{ if(folder) await shell.openPath(folder); });
ipcMain.handle('games:choose-dir', async ()=>{ const res=await dialog.showOpenDialog({properties:['openDirectory'],title:'Choisir le dossier Games'}); if(res.canceled||!res.filePaths[0]) return null; const c=cfg(); c.gamesDir=res.filePaths[0]; writeJSON(CONFIG_FILE,c); return scanGames(); });
ipcMain.handle('games:toggle-favorite', async (_e,id)=>{ const c=cfg(); c.favorites[id]=!c.favorites[id]; writeJSON(CONFIG_FILE,c); return c.favorites[id]; });
ipcMain.handle('games:set-cover', async (_e,id)=>{ const res=await dialog.showOpenDialog({properties:['openFile'],title:'Choisir une image',filters:[{name:'Images',extensions:['jpg','jpeg','png','webp']} ]}); if(res.canceled||!res.filePaths[0]) return null; const c=cfg(); c.customCovers[id]=res.filePaths[0]; writeJSON(CONFIG_FILE,c); return res.filePaths[0]; });
ipcMain.handle('settings:get', async ()=>{ const c=cfg(); return { hasSgdbKey: !!c.steamGridDbApiKey, autoFetchCovers: c.autoFetchCovers, gamesDir: c.gamesDir }; });
ipcMain.handle('settings:set-sgdb-key', async (_e, apiKey)=>{ const clean = String(apiKey || '').trim(); const c = saveConfigPatch({ steamGridDbApiKey: clean }); return { ok:true, hasSgdbKey: !!c.steamGridDbApiKey }; });
ipcMain.handle('settings:toggle-auto-covers', async ()=>{ const c=cfg(); c.autoFetchCovers = !c.autoFetchCovers; writeJSON(CONFIG_FILE,c); return c.autoFetchCovers; });
ipcMain.handle('covers:refresh-one', async (_e, game)=>{
  if(!game?.id || !game?.root || !game?.name) return {ok:false,error:'Jeu invalide.'};
  const c = cfg();
  if(!c.steamGridDbApiKey) return {ok:false,error:'Ajoute d’abord ta clé API SteamGridDB.'};
  try{
    const fetched = await fetchSteamGridCover(game.name, game.id, c.steamGridDbApiKey);
    if(!fetched?.path) return {ok:false,error:'Aucune cover trouvée sur SteamGridDB.'};
    const fresh = cfg();
    fresh.sgdbCovers[game.id] = fetched.path;
    delete fresh.sgdbMisses[game.id];
    writeJSON(CONFIG_FILE, fresh);
    return {ok:true,cover:fetched.path,match:fetched.sgdbGameName};
  }catch(e){ return {ok:false,error:e.message}; }
});
