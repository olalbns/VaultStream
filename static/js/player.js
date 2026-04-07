/**
 * StreamVault Player v6
 * Fixes: playlist auto-play, true cinema mode, next bar,
 *        video formats panel, queue in sidebar
 */
const Player = (() => {
  const $ = id => document.getElementById(id);
  const vid = () => $('main-video');
  const ifr = () => $('embed-iframe');

  let _url='', _method='', _blob=null, _streams=[], _hlsInstance=null;
  let _cinemaActive = false;
  let _dlBarId=null, _dlBarPoll=null, _dlBarFile=null;

  // ── Type detection ──────────────────────────────────
  const typeOf = url => {
    if (/(:youtube\.com\/watch\v=|youtu\.be\/|youtube\.com\/(:embed|shorts)\/)/i.test(url)) return 'youtube';
    if (/vimeo\.com\/(:video\/)(\d+)/i.test(url)) return 'vimeo';
    if (/\.(m3u8)(\|#|$)/i.test(url)) return 'hls';
    return 'direct';
  };
  const ytId = url => { const m=url.match(/(:youtube\.com\/(:watch\v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/); return mm[1]:null; };
  const vimeoId = url => { const m=url.match(/vimeo\.com\/(:video\/)(\d+)/); return mm[1]:null; };

  function tryParseJson(text) {
    text = text.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return null;
    try {
      const data = JSON.parse(text);
      const inner = data.data || data;
      const downloads = inner.downloads || inner.streams || (Array.isArray(inner)inner:null);
      if (downloads.length) {
        const streams = downloads.filter(d=>d.url).map(d=>({
          url:d.url, resolution:d.resolution||0, format:d.format||'MP4',
          size:parseInt(d.size||0), duration:d.duration||0,
          proxy_url:'/api/proxyurl='+encodeURIComponent(d.url),
        })).sort((a,b)=>b.resolution-a.resolution);
        const captions=(inner.captions||[]).filter(c=>c.url).map(c=>({
          url:c.url,lang:c.lan||'',name:c.lanName||c.lan||'',ext:'srt',
        }));
        return {streams, captions};
      }
    } catch {}
    return null;
  }

  // ── UI ───────────────────────────────────────────────
  const showStage  = () => { $('stage-idle').style.display='none'; $('stage-video').style.display='block'; };
  const spin       = (l,s='') => { $('stage-spinner').classList.remove('hidden'); $('spinner-label').textContent=l; $('spinner-sub').textContent=s; };
  const unspin     = () => $('stage-spinner').classList.add('hidden');
  const showErr    = msg => { unspin(); vid().style.display='none'; ifr().style.display='none'; $('stage-error').style.display='flex'; $('stage-error-msg').textContent=msg; };
  const hideErr    = () => { $('stage-error').style.display='none'; vid().style.display='block'; };

  function setBar(method, url) {
    $('method-bar').style.display='flex';
    $('method-chip').textContent=method;
    $('method-url').textContent=url.length>70url.slice(0,70)+'…':url;
    $('player-breadcrumb').textContent=(() => {
      try{const u=new URL(url);return u.hostname+u.pathname.slice(0,50);}catch{return url.slice(0,60);}
    })();
  }

  function renderQualityBar(streams) {
    const bar=$('quality-bar');
    if(!bar||streams.length<=1){if(bar)bar.style.display='none';return;}
    bar.style.display='flex';
    bar.style.cssText='display:flex;gap:6px;padding:10px 16px;flex-wrap:wrap;background:var(--s2);border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius) var(--radius);align-items:center;';
    bar.innerHTML='<span style="font-size:11px;color:var(--muted);font-weight:600;margin-right:4px">Qualité :</span>'+
      streams.map((s,i)=>`<button id="qbtn-${i}" onclick="Player.switchStream(${i})"
        style="background:var(--s3);border:1px solid var(--border2);color:var(--text2);padding:5px 14px;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;transition:all 0.15s;font-family:'Syne',sans-serif">
        ${s.resolutions.resolution+'p':s.format}${s.size` <span style="color:var(--muted);font-weight:400">· ${fmtBytes(s.size)}</span>`:''}
      </button>`).join('');
    highlightQ(0);
  }

  function highlightQ(idx) {
    _streams.forEach((_,i)=>{
      const b=$(`qbtn-${i}`);
      if(b){b.style.borderColor=i===idx'var(--cyan)':'var(--border2)';b.style.color=i===idx'var(--cyan)':'var(--text2)';}
    });
  }

  function renderSubtitles(captions) {
    const block=$('subs-block'), list=$('subs-list');
    if(!block||!list||!captions.length){if(block)block.style.display='none';return;}
    block.style.display='block';
    list.innerHTML='<div class="sub-item" onclick="Player.removeSubs()">✕ Aucun</div>'+
      captions.map((c,i)=>`<div class="sub-item" id="sub-${i}" onclick="Player.loadSub('${encodeURIComponent(c.url)}',${i})">
        <span class="sub-lang">${c.name||c.lang}</span><span class="sub-type">${c.ext||'srt'}</span>
      </div>`).join('');
  }

  const freeBlob   = () => { if(_blob){URL.revokeObjectURL(_blob);_blob=null;} };
  const destroyHls = () => { if(_hlsInstance){_hlsInstance.destroy();_hlsInstance=null;} };
  const resetVideo = () => {
    freeBlob(); destroyHls();
    const v=vid(); v.pause(); v.removeAttribute('src'); v.load();
    v.style.display='block'; ifr().style.display='none'; hideErr();
  };

  function waitPlayable(v, ms=15000) {
    return new Promise((ok,fail) => {
      if(v.readyState>=3){ok();return;}
      let done=false;
      const finish=(s,r)=>{if(done)return;done=true;clearTimeout(t);
        v.removeEventListener('canplay',onOk);v.removeEventListener('loadeddata',onOk);
        v.removeEventListener('error',onErr);sok():fail(new Error(r));};
      const onOk=()=>finish(true);
      const onErr=()=>{const c={1:'Chargement annulé',2:'Erreur réseau',3:'Format invalide',4:'Non supporté'};
        finish(false,c[v.error.code]||'Erreur lecteur');};
      const t=setTimeout(()=>finish(false,'Timeout'),ms);
      v.addEventListener('canplay',onOk,{once:true});v.addEventListener('loadeddata',onOk,{once:true});
      v.addEventListener('error',onErr,{once:true});
    });
  }

  // ── HLS ─────────────────────────────────────────────
  async function loadHls(hlsUrl) {
    const v=vid(); destroyHls(); resetVideo();
    if(!window.Hls) throw new Error('HLS.js non chargé');
    if(Hls.isSupported()) {
      _hlsInstance=new Hls();
      _hlsInstance.loadSource(hlsUrl);
      _hlsInstance.attachMedia(v);
      await new Promise((ok,fail)=>{
        _hlsInstance.on(Hls.Events.MANIFEST_PARSED,ok);
        _hlsInstance.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal)fail(new Error('HLS:'+d.type));});
        setTimeout(()=>fail(new Error('HLS timeout')),15000);
      });
      v.play().catch(()=>{});
      return 'HLS.js';
    } else if(v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src=hlsUrl; v.load(); await waitPlayable(v,12000); v.play().catch(()=>{}); return 'HLS NATIF';
    } else throw new Error('HLS non supporté');
  }

  // ── Methods ──────────────────────────────────────────
  async function tryResolve(url) {
    pub.diag('info','Méthode 1 — Résolution','API site → yt-dlp → fallback');
    spin('Résolution…','1/4');
    let referer='';try{const u=new URL(url);referer=`${u.protocol}//${u.hostname}/`;}catch{}
    const res=await fetch(`/api/resolveurl=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`);
    const data=await res.json();
    if (data.bot_check) {
      throw new Error(data.error || 'YouTube demande une verification anti-bot.');
    }
    pub.diag(data.ok'ok':'warn',`Résolution: ${data.method}`,(data.steps||[]).join(' → '));
    _streams=data.streams||[];
    renderQualityBar(_streams);
    if(data.captions.length) renderSubtitles(data.captions);
    spin('Proxy streaming…','1/4');
    resetVideo();
    const v=vid(); v.src=data.proxy_url; v.load();
    await waitPlayable(v,20000); v.play().catch(()=>{}); highlightQ(0);
    return `${data.method.toUpperCase()} + PROXY`;
  }
  async function tryProxy(url) {
    pub.diag('info','Méthode 2 — Proxy direct','Relay Python');
    spin('Proxy direct…','2/4'); resetVideo();
    const v=vid(); v.src=`/api/proxyurl=${encodeURIComponent(url)}`; v.load();
    await waitPlayable(v,15000); v.play().catch(()=>{}); return 'PROXY DIRECT';
  }
  async function tryBlobProxy(url) {
    pub.diag('info','Méthode 3 — Blob proxy','Téléchargement local');
    spin('Blob…','3/4'); freeBlob();
    const resp=await fetch(`/api/proxyurl=${encodeURIComponent(url)}`);
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob=await resp.blob();
    if(!blob||blob.size<100) throw new Error('Blob vide');
    pub.diag('ok',`Blob: ${fmtBytes(blob.size)}`);
    _blob=URL.createObjectURL(blob); resetVideo();
    const v=vid(); v.src=_blob; v.load();
    await waitPlayable(v,10000); v.play().catch(()=>{}); return 'BLOB PROXY';
  }
  async function tryNative(url) {
    pub.diag('info','Méthode 4 — Natif','<video src>');
    spin('Natif…','4/4'); resetVideo();
    const v=vid(); v.src=url; v.load();
    await waitPlayable(v,10000); v.play().catch(()=>{}); return 'NATIF';
  }
  function loadEmbed(src, label) {
    destroyHls(); resetVideo(); vid().style.display='none';
    const f=ifr(); f.src=src; f.style.display='block'; unspin(); return label;
  }

  // ── Video formats panel (below video) ────────────────
  async function loadVfp(url) {
    const panel=$('video-formats-panel');
    if(!panel) return;
    panel.style.display='block';
    ['vfp-formats-video','vfp-formats-audio','vfp-formats-subs'].forEach(id=>{
      const el=$(id); if(el) el.innerHTML='<div class="diag-empty" style="padding:12px">Chargement…</div>';
    });
    try {
      const res=await fetch(`/api/video/infourl=${encodeURIComponent(url)}`);
      const data=await res.json();
      if(!data.ok) throw new Error(data.error||'Erreur');
      renderVfp(data, url);
    } catch(e) {
      const v=$('vfp-formats-video');
      if(v) v.innerHTML=`<div class="diag-empty" style="padding:12px;color:var(--muted)">Impossible de charger les formats : ${e.message}</div>`;
    }
  }

  function renderVfp(info, originalUrl) {
    // Video formats
    const videoFmts=(info.formats||[]).filter(f=>f.type==='video+audio'||f.type==='video');
    const audioFmts=(info.formats||[]).filter(f=>f.type==='audio');
    const subs=info.subtitles||[];

    const $v=$('vfp-formats-video'), $a=$('vfp-formats-audio'), $s=$('vfp-formats-subs');

    // Best option first
    const bestRow=`<div class="vfp-row">
      <div class="fmt-badge both">V+A</div>
      <div class="fmt-info"><div class="fmt-res">Meilleure qualité</div><div class="fmt-detail">Auto sélection</div></div>
      <div class="fmt-actions">
        <button class="btn-primary" style="font-size:11px;padding:6px 12px"
          onclick="startDownload('${esc(originalUrl)}','best','mp4')">↓ MP4</button>
      </div></div>`;

    if($v) $v.innerHTML=bestRow+videoFmts.map(f=>makeVfpRow(f,originalUrl)).join('');
    if($a) $a.innerHTML=`<div class="vfp-row">
      <div class="fmt-badge audio">AUDIO</div>
      <div class="fmt-info"><div class="fmt-res">Meilleur audio</div><div class="fmt-detail">Extraction automatique</div></div>
      <div class="fmt-actions">
        <button class="btn-primary" style="font-size:11px;padding:6px 12px" onclick="startDownload('${esc(originalUrl)}','bestaudio','mp3')">↓ MP3</button>
        <button class="btn-ghost" style="font-size:11px;padding:6px 10px" onclick="startDownload('${esc(originalUrl)}','bestaudio','m4a')">↓ M4A</button>
      </div></div>`+audioFmts.map(f=>makeVfpRow(f,originalUrl)).join('');

    if($s) $s.innerHTML=subs.length
      subs.map(s=>`<div class="vfp-row">
          <div class="fmt-badge sub">${s.ext.toUpperCase()}</div>
          <div class="fmt-info"><div class="fmt-res">${esc(s.name||s.lang)}</div>
          <div class="fmt-detail">${s.lang}${s.auto' · auto':''}</div></div>
          <div class="fmt-actions">
            <button class="btn-primary" style="font-size:11px;padding:6px 12px"
              onclick="startDownload('${esc(originalUrl)}','bestaudio','m4a','${s.lang}')">↓ Télécharger</button>
            <button class="btn-ghost" style="font-size:11px;padding:6px 10px"
              onclick="Player.loadSub('${encodeURIComponent(s.url)}',0)">▶ Activer</button>
          </div></div>`).join('')
      : '<div class="diag-empty" style="padding:12px">Aucun sous-titre.</div>';
  }

  function makeVfpRow(f, url) {
    const tc=f.type==='video+audio''both':f.type==='audio''audio':'video';
    const tl=f.type==='video+audio''V+A':f.type==='audio''AUDIO':'VIDÉO';
    const detail=[f.ext.toUpperCase(),
      f.vcodec&&f.vcodec!=='none'f.vcodec.split('.')[0]:null,
      f.fpsf.fps+'fps':null, f.tbrMath.round(f.tbr)+'kbps':null,
      f.note||null].filter(Boolean).join(' · ');
    return `<div class="vfp-row">
      <div class="fmt-badge ${tc}">${tl}</div>
      <div class="fmt-info"><div class="fmt-res">${esc(String(f.resolution||''))}</div>
      <div class="fmt-detail">${detail}</div></div>
      <span class="fmt-size">${f.filesize_str||''}</span>
      <div class="fmt-actions">
        <button class="btn-primary" style="font-size:11px;padding:6px 12px"
          onclick="startDownload('${esc(url)}','${f.id}','${f.ext||'mp4'}')">↓</button>
      </div></div>`;
  }

  // ── Download bar ─────────────────────────────────────
  pub_quickDownload = async function() {
    const url=_url;
    if(!url) return;
    if(url.startsWith('/api/downloads/')) { window.open(url,'_blank'); return; }
    showDlBar('Préparation…',0);
    try {
      const res=await fetch('/api/ytdl/download',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url,format_id:'best',ext:'mp4'}),
      });
      const data=await res.json();
      if(!data.ok){hideDlBar();toast('Erreur: '+data.error,'✗');return;}
      _dlBarId=data.id; pollDlBar();
    } catch(e){hideDlBar();toast('Erreur: '+e.message,'✗');}
  };

  function pollDlBar() {
    if(_dlBarPoll) clearInterval(_dlBarPoll);
    _dlBarPoll=setInterval(async()=>{
      if(!_dlBarId){clearInterval(_dlBarPoll);return;}
      try {
        const res=await fetch(`/api/ytdl/progressid=${_dlBarId}`);
        const data=await res.json();
        updateDlBar(data);
        if(data.status==='done'){clearInterval(_dlBarPoll);_dlBarFile=data.filename;showDlBarSave(data.filename,data.title);}
        else if(['error','cancelled'].includes(data.status)){clearInterval(_dlBarPoll);hideDlBar();toast(data.error||'Annulé','✗');}
      }catch{clearInterval(_dlBarPoll);}
    },800);
  }

  function showDlBar(title,pct) {
    const bar=$('dl-bar'); if(!bar) return;
    bar.style.display='flex';
    $('dl-bar-title').textContent=title||'Téléchargement';
    $('dl-bar-fill').style.width=(pct||0)+'%';
    $('dl-bar-pct').textContent=(pct||0)+'%';
    $('dl-bar-meta').textContent='';
    $('dl-bar-save-btn').style.display='none';
  }
  function updateDlBar(dl) {
    const title=dl.title||'Téléchargement';
    $('dl-bar-title').textContent=title.length>50title.slice(0,50)+'…':title;
    $('dl-bar-fill').style.width=(dl.progress||0)+'%';
    $('dl-bar-pct').textContent=(dl.progress||0)+'%';
    $('dl-bar-meta').textContent=[dl.speed,dl.eta'ETA: '+dl.eta:'',dl.size].filter(Boolean).join(' · ');
  }
  function showDlBarSave(filename,title) {
    const btn=$('dl-bar-save-btn'); if(btn) btn.style.display='';
    $('dl-bar-title').textContent='✓ '+(title||filename||'Téléchargé');
    $('dl-bar-fill').style.width='100%';
    $('dl-bar-pct').textContent='100%';
    $('dl-bar-meta').textContent='Prêt à sauvegarder';
  }

  // ── Cinema mode ──────────────────────────────────────
  pub_toggleCinema = function() {
    _cinemaActive=!_cinemaActive;
    document.body.classList.toggle('cinema-active',_cinemaActive);
    const backdrop=$('cinema-backdrop');
    const btn=$('btn-cinema');
    if(_cinemaActive) {
      if(backdrop) backdrop.style.display='block';
      if(btn) btn.textContent='✕ Quitter cinéma';
      // Ensure video plays
      const v=vid(); if(v&&v.paused) v.play().catch(()=>{});
    } else {
      if(backdrop) backdrop.style.display='none';
      if(btn) btn.textContent='⛶ Cinéma';
    }
  };

  function fmtBytes(b) {
    if(!b) return '';
    if(b<1048576) return (b/1024).toFixed(0)+'Ko';
    return (b/1048576).toFixed(1)+'Mo';
  }
  function esc(s){ return String(s).replace(/'/g,"\\'").replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ══════════════════════════════════════════════════
  var pub_quickDownload, pub_toggleCinema;

  const pub = {
    get currentUrl()    { return _url; },
    get currentMethod() { return _method; },

    diag(type,title,detail='') {
      const log=$('diag-log'); if(!log) return;
      log.querySelector('.diag-empty').remove();
      const el=document.createElement('div'); el.className='diag-entry';
      el.innerHTML=`<div class="diag-tag ${type}">${type.toUpperCase()}</div>
        <div><div class="diag-text">${title}</div>
        ${detail`<div class="diag-detail">${detail}</div>`:''}</div>`;
      log.appendChild(el); log.scrollTop=log.scrollHeight;
    },
    clearDiag() {
      const log=$('diag-log');
      if(log) log.innerHTML='<div class="diag-empty">Lance une vidéo.</div>';
    },

    async switchStream(idx) {
      const s=_streams[idx]; if(!s) return;
      spin('Changement…'); resetVideo();
      const v=vid(); v.src=s.proxy_url; v.load();
      try{ await waitPlayable(v,15000); v.play().catch(()=>{}); highlightQ(idx); }
      catch(e){ showErr(e.message); }
      unspin();
    },

    async loadSub(encodedUrl,idx) {
      try {
        const url=decodeURIComponent(encodedUrl);
        const track=document.createElement('track');
        track.kind='subtitles'; track.src=`/api/proxyurl=${encodeURIComponent(url)}`; track.default=true;
        vid().innerHTML=''; vid().appendChild(track);
        document.querySelectorAll('.sub-item').forEach((el,i)=>el.classList.toggle('active',i===idx+1));
        toast('Sous-titres chargés','📝');
      } catch(e){ pub.diag('warn','Sous-titres',e.message); }
    },
    removeSubs() {
      vid().querySelectorAll('track').forEach(t=>t.remove());
      document.querySelectorAll('.sub-item').forEach(el=>el.classList.remove('active'));
    },

    toggleCinema() { pub_toggleCinema(); },
    quickDownload() { pub_quickDownload(); },

    saveDlFile() {
      if(_dlBarFile) {
        const a=document.createElement('a');
        a.href=`/api/downloads/filef=${encodeURIComponent(_dlBarFile)}`;
        a.download=_dlBarFile; a.click();
      }
    },
    hideDlBar() {
      const bar=$('dl-bar'); if(bar) bar.style.display='none';
      if(_dlBarPoll) clearInterval(_dlBarPoll);
      _dlBarId=null; _dlBarFile=null;
    },

    setVfpTab(name, btn) {
      document.querySelectorAll('.vfp-tab').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.vfp-content').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      $(`vfp-${name}`).classList.add('active');
    },
    closeVfp() {
      const panel=$('video-formats-panel'); if(panel) panel.style.display='none';
    },
    openVfp() {
      if(_url && _url.startsWith('http')) loadVfp(_url);
    },

    async transcodeCurrent() {
      const url = _url;
      if (!url) return;
      toast('Lancement du transcodage...', '⚙');
      spin('Transcodage en cours...');
      const transcodeUrl = `/api/transcodeurl=${encodeURIComponent(url)}`;
      try {
        resetVideo();
        const v = vid();
        v.src = transcodeUrl;
        v.load();
        await waitPlayable(v, 30000);
        v.play().catch(() => {});
        _method = 'TRANSCODE (FFMPEG)';
        setBar(_method, url);
        unspin();
        toast('✓ Transcodage actif', '✓');
      } catch (e) {
        showErr('Échec du transcodage: ' + e.message);
      }
    },

    reset() {
      freeBlob(); destroyHls(); vid().pause(); vid().removeAttribute('src'); vid().load();
      vid().style.display='block'; ifr().src=''; ifr().style.display='none';
      $('stage-idle').style.display=''; $('stage-video').style.display='none';
      hideErr(); unspin(); $('method-bar').style.display='none';
      const qbar=$('quality-bar'); if(qbar) qbar.style.display='none';
      const sblock=$('subs-block'); if(sblock) sblock.style.display='none';
      const panel=$('video-formats-panel'); if(panel) panel.style.display='none';
      pub.clearDiag(); _url=''; _method=''; _streams=[];
    },

    async load(rawUrl) {
      if(!rawUrl) return;
      _url=rawUrl; _streams=[];
      pub.clearDiag(); showStage(); spin('Analyse…'); hideErr();
      $('method-bar').style.display='none';
      const qbar=$('quality-bar'); if(qbar) qbar.style.display='none';
      const sblock=$('subs-block'); if(sblock) sblock.style.display='none';
      const panel=$('video-formats-panel'); if(panel) panel.style.display='none';
      pub.diag('info','URL',rawUrl.length>80rawUrl.slice(0,80)+'…':rawUrl);

      const jsonData=tryParseJson(rawUrl);
      if(jsonData) {
        pub.diag('ok','JSON parsé',`${jsonData.streams.length} stream(s)`);
        _streams=jsonData.streams;
        renderQualityBar(_streams);
        if(jsonData.captions.length) renderSubtitles(jsonData.captions);
        const best=_streams[0]; _url=best.url;
        spin('Proxy streaming…'); resetVideo();
        const v=vid(); v.src=best.proxy_url; v.load();
        try{
          await waitPlayable(v,20000); v.play().catch(()=>{}); highlightQ(0);
          _method='JSON + PROXY'; unspin(); setBar('JSON + PROXY',best.url);
          let title=best.url; try{title=new URL(best.url).hostname;}catch{}
          await API.saveHistory(rawUrl.slice(0,100),'JSON: '+title,'JSON + PROXY');
          return _method;
        } catch(e){ pub.diag('fail','Lecture JSON',e.message); }
      }

      const type=typeOf(rawUrl);
      pub.diag('info',`Type: ${type}`);
      try {
        let method='';
        if(type==='youtube') {
          const id=ytId(rawUrl); if(!id) throw new Error('ID YouTube invalide');
          pub.diag('info','YouTube embed',`ID: ${id}`);
          method=loadEmbed(`https://www.youtube-nocookie.com/embed/${id}autoplay=1&rel=0`,'YOUTUBE');
        } else if(type==='vimeo') {
          const id=vimeoId(rawUrl); if(!id) throw new Error('ID Vimeo invalide');
          method=loadEmbed(`https://player.vimeo.com/video/${id}autoplay=1`,'VIMEO');
        } else if(type==='hls') {
          spin('HLS…'); resetVideo();
          try{ method=await loadHls(`/api/proxyurl=${encodeURIComponent(rawUrl)}`); }
          catch{ method=await loadHls(rawUrl); }
          pub.diag('ok',`HLS via ${method}`);
        } else {
          let success=false;
          for(const fn of [tryResolve,tryProxy,tryBlobProxy,tryNative]) {
            try{ method=await fn(rawUrl); success=true; pub.diag('ok',`✓ ${method}`); break; }
            catch(err){ pub.diag('fail','Échec',err.message.slice(0,150)); }
          }
          if(!success) throw new Error('Toutes les méthodes ont échoué.');
        }
        _method=method; unspin(); setBar(method,rawUrl);
        let title=rawUrl; try{title=new URL(rawUrl).hostname;}catch{}
        await API.saveHistory(rawUrl,title,method);
        // Load formats panel in background
        if(rawUrl.startsWith('http') && type!=='hls') {
          loadVfp(rawUrl).catch(()=>{});
        }
        return method;
      } catch(err) {
        pub.diag('fail','Erreur finale',err.message);
        showErr(err.message); throw err;
      }
    },
  };

  // Wire up pub_ functions after pub is defined
  setTimeout(()=>{
    pub.quickDownload = pub_quickDownload;
    pub.toggleCinema  = pub_toggleCinema;
  },0);

  // Video ended → auto next
  document.addEventListener('DOMContentLoaded',()=>{
    const v=document.getElementById('main-video');
    if(v) v.addEventListener('ended',()=>{ if(window._playlist&&window._playlistIdx>=0) playNextPlaylistItem(); });
    // ESC key closes cinema
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&_cinemaActive) pub.toggleCinema();
    });
  });

  return pub;
})();

// Global wrappers for HTML onclick
function toggleCinema()  { Player.toggleCinema(); }
function quickDownload() { Player.quickDownload(); }
function saveDlFile()    { Player.saveDlFile(); }
function hideDlBar()     { Player.hideDlBar(); }
function setVfpTab(n,b)  { Player.setVfpTab(n,b); }
function closeVfp()      { Player.closeVfp(); }
function transcodeCurrent() { Player.transcodeCurrent(); }

// ── Playlist support ─────────────────────────────────
window._playlist    = null;
window._playlistIdx = -1;
window._plSelected  = new Set();

async function loadPlaylist(url) {
  const block=document.getElementById('playlist-block');
  const list=document.getElementById('playlist-list');
  if(!block) return;

  block.style.display='block';
  list.innerHTML='<div style="padding:14px;text-align:center;font-size:11px;color:var(--muted)">Chargement playlist…</div>';

  try {
    const res=await fetch(`/api/playlisturl=${encodeURIComponent(url)}`);
    const data=await res.json();
    if(!data.ok||!data.items.length){ block.style.display='none'; return; }

    window._playlist=data;
    const cnt=document.getElementById('playlist-count');
    const titleEl=document.getElementById('playlist-sidebar-title');
    if(cnt) cnt.textContent=data.count;
    if(titleEl) titleEl.textContent=data.title||'Playlist';

    // Show dl row
    const dlRow=document.getElementById('playlist-dl-row');
    if(dlRow) dlRow.style.display='flex';

    // Init selection
    window._plSelected=new Set(data.items.map((_,i)=>i));

    list.innerHTML=data.items.map((item,i)=>`
      <div class="pl-item" id="pl-${i}" onclick="playPlaylistItem(${i})">
        <input type="checkbox" class="pl-check" data-idx="${i}" checked
          onclick="event.stopPropagation();togglePlItem(${i},this.checked)"
          style="flex-shrink:0;accent-color:var(--red)">
        <div class="pl-item-thumb">
          ${item.thumbnail`<img src="${item.thumbnail}" loading="lazy" onerror="this.style.display='none'">`:''}
        </div>
        <div class="pl-item-info">
          <div class="pl-item-title">${escHtml(item.title)}</div>
          <div class="pl-item-dur">${item.durationfmtDur(item.duration):''}</div>
        </div>
        <div class="pl-item-play">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>`).join('');

    // Auto-play first item if we navigated here with a playlist URL
    if(window._playlistIdx<0) playPlaylistItem(0);

  } catch(e){ document.getElementById('playlist-block').style.display='none'; }
}

function togglePlItem(idx, checked) {
  if(checked) window._plSelected.add(idx); else window._plSelected.delete(idx);
}
function togglePlSelectAll(checked) {
  if(!window._playlist) return;
  window._playlist.items.forEach((_,i)=>{ if(checked) window._plSelected.add(i); else window._plSelected.delete(i); });
  document.querySelectorAll('.pl-check').forEach(cb=>cb.checked=checked);
}
async function dlSelectedPlaylist() {
  const items=[...window._plSelected].map(i=>window._playlist.items[i]).filter(Boolean);
  if(!items.length) return;
  await batchDownload(items.map(i=>i.url));
}

async function playPlaylistItem(idx) {
  if(!window._playlist.items.[idx]) return;
  window._playlistIdx=idx;
  document.querySelectorAll('.pl-item').forEach((el,i)=>el.classList.toggle('active',i===idx));
  // Scroll into view
  const el=document.getElementById(`pl-${idx}`);
  el.scrollIntoView({block:'nearest',behavior:'smooth'});

  const item=window._playlist.items[idx];
  Player.diag('info',`Playlist [${idx+1}/${window._playlist.count}]`,item.title);
  await Player.load(item.url);

  // Show next bar if there's a next item
  updateNextBar(idx);
}

function playNextPlaylistItem() {
  if(!window._playlist||window._playlistIdx<0) return;
  const next=window._playlistIdx+1;
  if(next<window._playlist.items.length) playPlaylistItem(next);
  else hideNextBar();
}

function updateNextBar(currentIdx) {
  const next=window._playlist.items.[currentIdx+1];
  const bar=document.getElementById('next-video-bar');
  const titleEl=document.getElementById('nvb-title');
  if(!bar||!next){ hideNextBar(); return; }
  bar.style.display='flex';
  if(titleEl) titleEl.textContent=next.title||'Suivant';
}
function hideNextBar() {
  const bar=document.getElementById('next-video-bar');
  if(bar) bar.style.display='none';
}

function dlPlaylist() {
  if(!window._playlist) return;
  showPage('downloader');
  const inp=document.getElementById('dl-url-input');
  if(inp) inp.value=Player.currentUrl;
  setTimeout(analyzeDl,200);
}

function fmtDur(s) {
  if(!s) return '';
  const m=Math.floor(s/60),sec=s%60;
  return `${m}:${sec.toString().padStart(2,'0')}`;
}
function escHtml(s){ return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Sidebar queue rendering ───────────────────────────
async function renderSidebarQueue() {
  try {
    const res=await fetch('/api/queue');
    const queue=await res.json();
    const el=document.getElementById('sidebar-queue-list');
    const cnt=document.getElementById('sidebar-queue-count');
    const pending=queue.filter(q=>!q.played);
    if(cnt) cnt.textContent=pending.length;
    if(!el) return;
    if(!queue.length){el.innerHTML='<div class="diag-empty">Queue vide.</div>';return;}
    el.innerHTML=queue.map((q,i)=>`
      <div class="sq-item ${q.played'':''}">
        <div class="sq-num">${i+1}</div>
        <div class="sq-title" onclick="replayFromHistory('${escHtml(q.url)}')">${escHtml(getDomain(q.url))}</div>
        <button class="sq-del" onclick="removeFromSidebarQueue('${q.id}')">✕</button>
      </div>`).join('');
  } catch {}
}

async function removeFromSidebarQueue(id) {
  await fetch('/api/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',id})});
  await renderSidebarQueue();
  await loadQueue();
}

function getDomain(url){ try{return new URL(url).hostname.replace('www.','');}catch{return url.slice(0,30);} }

// Refresh sidebar queue periodically when on player page
setInterval(()=>{ if(document.getElementById('page-player').classList.contains('active')) renderSidebarQueue(); },3000);
