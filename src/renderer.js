let allGames=[], selected=null, filter='all', settings={hasSgdbKey:false, autoFetchCovers:true};
const $=s=>document.querySelector(s), grid=$('#grid'), searchInput=$('#searchInput'), gameCount=$('#gameCount'), statusText=$('#statusText'), gamesDirEl=$('#gamesDir'), heroTitle=$('#heroTitle'), heroText=$('#heroText'), heroLabel=$('#heroLabel'), heroPlay=$('#heroPlay'), heroCover=$('#heroCover'), apiStatus=$('#apiStatus'), apiKeyInput=$('#apiKeyInput'), autoCoversBtn=$('#autoCoversBtn');
function fileUrl(p){return p?`file:///${p.replace(/\\/g,'/').replace(/#/g,'%23')}`:null}
function initials(n){return n.split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase()}
function gradientFor(id){let h=0;for(const c of id)h=c.charCodeAt(0)+((h<<5)-h);const a=Math.abs(h)%360,b=(a+75)%360;return `linear-gradient(135deg, hsl(${a} 82% 48%), hsl(${b} 86% 44%))`}
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600)}
function updateApiUi(){apiStatus.textContent=settings.hasSgdbKey?'Clé configurée':'Aucune clé configurée';autoCoversBtn.textContent=`Covers auto : ${settings.autoFetchCovers?'ON':'OFF'}`;heroCover.disabled=!selected||!settings.hasSgdbKey}
function filtered(){const q=searchInput.value.trim().toLowerCase();return allGames.filter(g=>{if(q&&!g.name.toLowerCase().includes(q))return false;if(filter==='favorites'&&!g.favorite)return false;if(filter==='ready'&&g.status!=='ready')return false;if(filter==='missing'&&g.status!=='missing-exe')return false;return true})}
function coverLabel(g){if(g.coverSource==='steamgriddb'||g.coverSource==='steamgriddb-cache')return 'Cover SteamGridDB';if(g.coverSource==='local')return 'Image locale';if(g.coverSource==='exe-icon')return 'Icône .exe';return 'Pas d’image'}
function selectGame(g){selected=g;heroTitle.textContent=g.name;heroLabel.textContent=g.status==='ready'?'Prêt à lancer':'Executable non trouvé';heroText.textContent=(g.exe||'Aucun .exe fiable trouvé automatiquement. Ouvre le dossier et vérifie le nom de l’exécutable.')+` • ${coverLabel(g)}`;heroPlay.disabled=g.status!=='ready';updateApiUi();render()}
async function launch(g){if(!g||g.status!=='ready')return toast('Executable introuvable');const r=await window.nova.launchGame(g);toast(r.ok?`Lancement de ${g.name}`:(r.error||'Erreur au lancement'));await scan(false)}
async function refreshSelectedCover(g=selected){if(!g)return;toast(`Recherche de cover pour ${g.name}...`);const r=await window.nova.refreshCover(g);if(!r.ok)return toast(r.error||'Aucune cover trouvée');toast(`Cover trouvée : ${r.match||g.name}`);await scan(false);const updated=allGames.find(x=>x.id===g.id);if(updated)selectGame(updated)}
function render(){
  const games=filtered();
  gameCount.textContent=`${games.length} jeu${games.length>1?'x':''}`;
  grid.innerHTML='';
  if(!games.length){
    grid.innerHTML='<div class="empty"><div><h3>Aucun jeu trouvé</h3><p>Vérifie le dossier sélectionné ou ta recherche.</p></div></div>';
    return;
  }

  for(const g of games){
    const cover=fileUrl(g.cover);
    const card=document.createElement('article');
    card.className='game-card';

    card.innerHTML=`
      <div class="cover ${cover?'has-image':'placeholder'}">
        ${cover
          ? `<img src="${cover}" alt="Cover de ${g.name}" loading="lazy" />`
          : `<span>${initials(g.name)}</span>`}
      </div>
      <div class="card-body">
        <h3 class="card-title">${g.name}</h3>
        <div class="card-actions">
          <button class="card-btn" ${g.status!=='ready'?'disabled':''}>Jouer</button>
          <button class="icon-btn fav ${g.favorite?'active':''}" title="Favori">★</button>
          <button class="icon-btn folder" title="Ouvrir le dossier">↗</button>
        </div>
      </div>`;

    card.addEventListener('click',e=>{if(e.target.closest('button'))return;selectGame(g)});
    card.querySelector('.card-btn').addEventListener('click',()=>launch(g));
    card.querySelector('.folder').addEventListener('click',()=>window.nova.openFolder(g.root));
    card.querySelector('.fav').addEventListener('click',async()=>{await window.nova.toggleFavorite(g.id);await scan(false)});

    if(selected?.id===g.id) card.classList.add('selected');
    grid.appendChild(card);
  }
}

async function loadSettings(){settings=await window.nova.getSettings();updateApiUi()}
async function scan(show=true){if(show)statusText.textContent=settings.hasSgdbKey&&settings.autoFetchCovers?'Scan + recherche covers API...':'Scan en cours...';try{const data=await window.nova.scanGames();allGames=data.games;settings={...settings,...data.settings};gamesDirEl.textContent=data.gamesDir;statusText.textContent=`${data.games.filter(g=>g.status==='ready').length} prêt(s), ${data.games.filter(g=>g.status!=='ready').length} à corriger`;updateApiUi();if(!selected&&allGames.length)selectGame(allGames[0]);else{const refreshed=selected?allGames.find(g=>g.id===selected.id):null;if(refreshed)selected=refreshed;render()}}catch(e){statusText.textContent='Erreur de scan';toast(e.message)}}
$('#refreshBtn').addEventListener('click',()=>scan(true));
$('#chooseDir').addEventListener('click',async()=>{const data=await window.nova.chooseDir();if(data){allGames=data.games;gamesDirEl.textContent=data.gamesDir;selected=allGames[0]||null;settings={...settings,...data.settings};updateApiUi();render()}});
$('#saveApiKey').addEventListener('click',async()=>{const key=apiKeyInput.value.trim();const r=await window.nova.setSteamGridDbKey(key);settings.hasSgdbKey=r.hasSgdbKey;apiKeyInput.value='';updateApiUi();toast(r.hasSgdbKey?'Clé API enregistrée':'Clé API supprimée');await scan(true)});
autoCoversBtn.addEventListener('click',async()=>{settings.autoFetchCovers=await window.nova.toggleAutoCovers();updateApiUi();toast(`Covers automatiques ${settings.autoFetchCovers?'activées':'désactivées'}`);if(settings.autoFetchCovers)await scan(true)});
heroPlay.addEventListener('click',()=>launch(selected));
heroCover.addEventListener('click',()=>refreshSelectedCover(selected));
searchInput.addEventListener('input',render);
document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));btn.classList.add('active');filter=btn.dataset.filter;render()}));
loadSettings().then(()=>scan(true));
