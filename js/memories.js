/* ==================== Cinematic Memory Director V9 ====================
   《Memory Director V9 — Cinematic Memory / 电影式回忆蒙太奇》

   核心转变 (vs V8):
     - 抛弃"卡片永远在动"的思路
     - 抛弃"卡片基于固定 SLOTS"的思路
     - 改为 Beat 状态机: LOCKED / DISCOVERING / RELEASING / INCOMING
     - 每个 Beat 是一个完整的镜头故事(发现 → 交接 → 停留)
     - 镜头 (Camera) 是视觉变化的主体,卡片只在过渡期间有动作
     - 平时画面几乎静止,只有非常细微的 breathing
     - Hero 真的切换:每次 Beat 切换时,新 photoIdx 进入中心

   渲染层级:
     L0 星空背景 (固定)
     L1 大气光 (固定,微闪)
     L2 粒子 (固定)
     L3 Photos (.layer-photo) — 由 Camera + Composition 驱动
       .camera-rig 整体 3D 移动
       .memory-cards-stack 内有 9 张 cards
     L4 Effects (固定)
     L5 Lyrics (固定)
     L6 UI (固定)

   Memories 页面的所有视觉变化都集中在 L3。
*/

(function(){
  'use strict';

  /* ===================== 工具 ===================== */
  const lerp       = (a,b,t) => a + (b-a) * t;
  const clamp      = (v,a,b) => v < a ? a : (v > b ? b : v);
  const smoothstep = t => t*t*(3 - 2*t);
  const damp       = (lambda, dt) => 1 - Math.exp(-lambda * dt);

  /* ===================== DOM 引用 ===================== */
  const dom = {
    carousel:    document.querySelector('.carousel-area'),
    layerBg:     document.getElementById('layerBg'),
    layerAmbient:document.getElementById('layerAmbient'),
    layerParts:  document.getElementById('layerParticles'),
    layerPhoto:  document.querySelector('.layer-photo'),
    layerFx:     document.getElementById('layerEffects'),
    layerType:   document.querySelector('.layer-typography'),
    cameraRig:   document.getElementById('cameraRig'),
    cardsStack:  document.getElementById('memoryCarousel'),
    lyricsText:  document.getElementById('lyricsText'),
    skipBtn:     document.getElementById('skipBtn'),
    diskCover:   document.getElementById('diskCoverImg'),
    progressTrack:document.getElementById('progressTrack'),
    progressFill:document.getElementById('progressFill'),
    progressThumb:document.getElementById('progressThumb'),
    currentTime: document.getElementById('currentTime'),
    totalTime:   document.getElementById('totalTime'),
    leftZone:    document.getElementById('memoryLeftZone'),
    rightZone:   document.getElementById('memoryRightZone'),
    fx: {
      grain:    document.getElementById('fxGrain'),
      leak:     document.getElementById('fxLightLeak'),
      vignette: document.getElementById('fxVignette'),
      scan:     document.getElementById('fxScanlines'),
      stars:    document.getElementById('fxStars'),
      particles:document.getElementById('fxParticles'),
      rgb:      document.getElementById('fxRgbSplit'),
      heroLight:document.getElementById('fxHeroLight'),
    },
  };

  Object.values(dom.fx).forEach(el => { el.style.setProperty('--fx-op', '0'); el.classList.add('fx'); });

  /* ===================== 照片索引 ===================== */
  function getPhotoSrc(idx){
    if(typeof imageUrls === 'undefined') return '';
    return imageUrls[clamp(idx, 0, imageUrls.length-1)] || '';
  }
  function getTotalDuration(){
    return (window.musicBox && window.musicBox.totalDuration) || 259;
  }

  /* ===================== 双层 Image Buffer + 预加载 ===================== */
  const NUM_CARDS = 9;

  const preloadCache = new Map();
  const brokenSet = new Set();
  function preloadImage(src){
    if(!src) return Promise.resolve(null);
    if(brokenSet.has(src)) return Promise.resolve(null);
    if(preloadCache.has(src)){
      const im = preloadCache.get(src);
      if(im.complete){
        if(im.naturalWidth === 0){
          brokenSet.add(src);
          return Promise.resolve(null);
        }
        return Promise.resolve(im);
      }
      return new Promise(res => {
        im.addEventListener('load',  () => res(im),  {once:true});
        im.addEventListener('error', () => { brokenSet.add(src); res(null); }, {once:true});
      });
    }
    return new Promise(res => {
      const im = new Image();
      im.onload  = () => res(im);
      im.onerror = () => { brokenSet.add(src); res(null); };
      im.src = src;
      preloadCache.set(src, im);
    });
  }

  const cards = [];
  function buildCards(){
    for(let i=0;i<NUM_CARDS;i++){
      const el = document.createElement('div');
      el.className = 'memory-card';
      const imgA = document.createElement('div');
      const imgB = document.createElement('div');
      imgA.className = 'card-img visible';
      imgB.className = 'card-img';
      const cap = document.createElement('div');
      cap.className = 'caption';
      el.appendChild(imgA); el.appendChild(imgB); el.appendChild(cap);
      dom.cardsStack.appendChild(el);

      cards.push({
        el, imgA, imgB, cap,
        activeLayer:'A',
        currentSrc:'',
        target:{x:0,y:0,z:0,w:300,h:400,rotX:0,rotY:0,rotZ:0,scale:1,blur:0,opacity:0,brightness:1,saturate:1},
        live:{x:0,y:0,z:0,w:300,h:400,rotX:0,rotY:0,rotZ:0,scale:1,blur:0,opacity:0,brightness:1,saturate:1},
      });
    }
  }
  buildCards();

  const FALLBACK_SRC = 'img/1.jpg';
  async function setCardImage(c, src){
    let useSrc = src;
    if(!useSrc || useSrc === c.currentSrc) return;
    let im = await preloadImage(useSrc);
    if(!im){
      if(useSrc === FALLBACK_SRC) return;
      useSrc = FALLBACK_SRC;
      im = await preloadImage(useSrc);
      if(!im) return;
    }
    const target = c.activeLayer === 'A' ? c.imgB : c.imgA;
    const hide   = c.activeLayer === 'A' ? c.imgA : c.imgB;
    target.style.backgroundImage = `url("${useSrc}")`;
    requestAnimationFrame(() => {
      target.classList.add('visible');
      hide.classList.remove('visible');
      c.activeLayer = c.activeLayer === 'A' ? 'B' : 'A';
      c.currentSrc = useSrc;
    });
  }

  /* ===================== Slot 映射 =====================
     9 张 DOM cards 的角色:
       slot 0: HERO (当前主角)
       slot 1: FG_NEAR_LEFT (左前遮挡)
       slot 2: FG_NEAR_RIGHT (右前遮挡)
       slot 3: MG_LEFT (中景左)
       slot 4: MG_RIGHT (中景右)
       slot 5: BG_LEFT (远景左)
       slot 6: BG_RIGHT (远景右)
       slot 7: BG_TOP (远景上)
       slot 8: BG_BOTTOM (远景下)
   */
  const SLOT_ROLES = [
    'HERO',          // 0
    'FG_LEFT',       // 1
    'FG_RIGHT',      // 2
    'MG_LEFT',       // 3
    'MG_RIGHT',      // 4
    'BG_LEFT',       // 5
    'BG_RIGHT',      // 6
    'BG_TOP',        // 7
    'BG_BOTTOM',     // 8
  ];

  /* 默认 card 尺寸 */
  function cardSizeForSlot(slotRole){
    if(slotRole === 'HERO')      return { w: 460, h: 580 };
    if(slotRole === 'FG_LEFT' || slotRole === 'FG_RIGHT') return { w: 280, h: 360 };
    return { w: 220, h: 280 };  // MG/BG 较小
  }

  /* ===================== 状态 ===================== */
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastT = performance.now();
  let rafId = 0;

  /* Camera live 平滑插值 */
  const camLive = { x:0, y:0, z:0, rotX:0, rotY:0, scale:1 };

  /* 每张 card 当前显示的 photoIdx */
  const cardCurrentPhoto = new Array(NUM_CARDS).fill(-1);
  /* 上一次的 scenePhotoIndices,用于检测 hero 是否切换 */
  let lastHeroPhotoIdx = -1;

  /* ===================== RAF Render Loop ===================== */
  function tick(now){
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const time = window.musicBox ? window.musicBox.currentTime : 0;
    const t = now / 1000;

    /* === 1) Beat State === */
    const numPhotos = (typeof NUM_PHOTOS !== 'undefined') ? NUM_PHOTOS : 42;
    const beatState = window.HeroDirector.getBeatState(time, numPhotos);
    const { beat, beatProgress, phase, phaseProgress, heroIdx, scenePhotoIndices, cameraDir, reason } = beatState;

    /* === 2) Photo Sync ===
       把 photoForSlot[i] 同步到 DOM card i
       - HERO (slot 0): 在 INCOMING 阶段(phase='incoming' 且 progress < 0.5)时,显示 old hero (退场中的)
         之后显示 new heroIdx
       - 其他 slot: 直接显示 scenePhotoIndices[i] */
    const photoForDOM = new Array(NUM_CARDS);
    const showIncoming = (phase === 'incoming');
    const useOldHeroForDOM0 = showIncoming && phaseProgress < 0.5;
    /* DOM card 0 (HERO 位置) 应该显示的内容:
       - RELEASING 阶段: 当前 heroIdx (退场中)
       - INCOMING 阶段 early: heroIdx (旧的还在退)
       - INCOMING 阶段 late (>=0.5): 新 hero (已切换 scenePhotoIndices)
       - LOCKED: heroIdx */
    photoForDOM[0] = scenePhotoIndices[0];  // beat.js 已经在 0.50 时切换了 scenePhotoIndices
    for(let i=1;i<NUM_CARDS;i++){
      photoForDOM[i] = scenePhotoIndices[i];
    }
    /* 写入 DOM (用 setCardImage 做 crossfade) */
    for(let i=0;i<NUM_CARDS;i++){
      const target = photoForDOM[i];
      if(target !== cardCurrentPhoto[i] && target >= 0){
        cardCurrentPhoto[i] = target;
        setCardImage(cards[i], getPhotoSrc(target));
      }
    }

    /* === 3) Camera State ===
       基于 Beat phase + cameraDir 计算 camera target,然后平滑插值到 camLive */
    const camTarget = window.HeroDirector.getCameraState(beat, phase, phaseProgress);

    /* 平滑插值 */
    const camLambda = (phase === 'locked') ? 1.5 : 2.5;  // LOCKED 时更慢的 damping 让 camera 完全静止
    camLive.x     = lerp(camLive.x,     camTarget.x,     damp(camLambda, dt));
    camLive.y     = lerp(camLive.y,     camTarget.y,     damp(camLambda, dt));
    camLive.z     = lerp(camLive.z,     camTarget.z,     damp(camLambda, dt));
    camLive.rotX  = lerp(camLive.rotX,  camTarget.rotX,  damp(1.5, dt));
    camLive.rotY  = lerp(camLive.rotY,  camTarget.rotY,  damp(1.5, dt));
    camLive.scale = lerp(camLive.scale, camTarget.scale, damp(1.2, dt));

    if(dom.cameraRig){
      dom.cameraRig.style.transform =
        `translate3d(${camLive.x.toFixed(2)}px, ${camLive.y.toFixed(2)}px, ${camLive.z.toFixed(2)}px)` +
        ` rotateX(${camLive.rotX.toFixed(3)}deg) rotateY(${camLive.rotY.toFixed(3)}deg)` +
        ` scale(${camLive.scale.toFixed(4)})`;
    }

    /* === 4) Composition ===
       根据 beat 状态决定当前 composition (镜头视角对应 cards 布局)
       使用 lerp 在 composition 之间过渡,让画面构图平滑变化 */
    const targetComp = window.HeroDirector.getCompositionForBeat(beat.beatType, cameraDir, phase);
    /* 把 targetComp.hero 和 targetComp.supports 存到全局 lerp state */
    if(!tick._compCurrent){
      tick._compCurrent = {
        hero: {...targetComp.hero},
        supports: JSON.parse(JSON.stringify(targetComp.supports)),
      };
    }
    /* 在 RELEASING 阶段 (即将切换 hero),composition 应该已经在 discovering 时调整过
       简单 lerp: targetComp vs current */
    const cur = tick._compCurrent;
    const compLambda = 2.0;
    /* lerp hero */
    cur.hero.x = lerp(cur.hero.x, targetComp.hero.x, damp(compLambda, dt));
    cur.hero.y = lerp(cur.hero.y, targetComp.hero.y, damp(compLambda, dt));
    cur.hero.scale = lerp(cur.hero.scale, targetComp.hero.scale, damp(compLambda, dt));
    /* lerp supports */
    for(const role in targetComp.supports){
      const t = targetComp.supports[role];
      const c = cur.supports[role] || {};
      if(typeof t.x === 'number') c.x = lerp(c.x || t.x, t.x, damp(compLambda, dt));
      if(typeof t.y === 'number') c.y = lerp(c.y || t.y, t.y, damp(compLambda, dt));
      if(typeof t.scale === 'number') c.scale = lerp(c.scale || t.scale, t.scale, damp(compLambda, dt));
      if(typeof t.rotZ === 'number') c.rotZ = lerp(c.rotZ || t.rotZ, t.rotZ, damp(compLambda, dt));
      if(typeof t.rotY === 'number') c.rotY = lerp(c.rotY || t.rotY, t.rotY, damp(compLambda, dt));
      if(typeof t.opacity === 'number') c.opacity = lerp(c.opacity == null ? t.opacity : c.opacity, t.opacity, damp(compLambda, dt));
      cur.supports[role] = c;
    }

    /* === 5) Hero Motion ===
       Hero card 在 beat 内的特殊 motion (releasing/incoming/discovering) */
    const heroMotion = window.HeroDirector.getHeroMotion(phase, phaseProgress);

    /* === 6) 每张 card 的 transform ===
       hero = HERO card (slot 0)
       其他 = composition.supports[role] */
    const rect = dom.carousel.getBoundingClientRect();
    for(let i=0;i<NUM_CARDS;i++){
      const card = cards[i];
      const slotRole = SLOT_ROLES[i];

      let px, py, pz, scale, opacity, blur, rotZ, rotY;

      if(i === 0){
        // HERO card
        const heroPos = cur.hero;
        px = (heroPos.x - 50) / 100 * rect.width + camLive.x;
        py = (heroPos.y - 50) / 100 * rect.height + camLive.y;
        pz = heroPos.z + camLive.z;
        scale = heroPos.scale * heroMotion.scaleMul;
        opacity = heroMotion.opacityMul;
        blur = heroMotion.blurMul;
        rotZ = (heroPos.rotZ || 0) + heroMotion.rotZ;
        rotY = (heroPos.rotY || 0) + heroMotion.rotY;
      } else {
        // Supporting card
        const sPos = cur.supports[slotRole] || {};
        // 如果 composition 是 isolation,opacity=0,直接 hide
        if(typeof sPos.opacity === 'number' && sPos.opacity <= 0.01){
          card.el.style.opacity = '0';
          card.el.style.zIndex = '0';
          continue;
        }
        if(typeof sPos.x !== 'number'){
          // 没定义的 slot (例如 isolation 中的所有 supports),跳过
          card.el.style.opacity = '0';
          card.el.style.zIndex = '0';
          continue;
        }
        px = (sPos.x - 50) / 100 * rect.width + camLive.x;
        py = (sPos.y - 50) / 100 * rect.height + camLive.y;
        pz = (sPos.z || -400) + camLive.z;
        scale = sPos.scale || 0.3;
        opacity = sPos.opacity || 0;
        blur = 0;
        rotZ = sPos.rotZ || 0;
        rotY = sPos.rotY || 0;
      }

      /* 写入 target */
      card.target.x = px;
      card.target.y = py;
      card.target.z = pz;
      const sz = cardSizeForSlot(slotRole);
      card.target.w = sz.w * scale;
      card.target.h = sz.h * scale;
      card.target.scale = 1;  // scale 已合并到 w/h
      card.target.rotZ = rotZ;
      card.target.rotY = rotY;
      card.target.rotX = 0;
      card.target.blur = blur;
      card.target.opacity = opacity;
      card.target.brightness = (i === 0 ? 1.05 : (i < 3 ? 0.92 : 0.78));
      card.target.saturate = (i === 0 ? 1.05 : 0.95);

      /* Lerp live → target — 不同 phase 用不同 damping */
      const L = card.live;
      let lambda;
      if(phase === 'locked'){
        lambda = 4.0;  // LOCKED 时快速稳定(让画面几乎静止)
      } else {
        lambda = 5.0;  // 过渡时跟随运动
      }
      L.x = lerp(L.x, card.target.x, damp(lambda, dt));
      L.y = lerp(L.y, card.target.y, damp(lambda, dt));
      L.z = lerp(L.z, card.target.z, damp(lambda, dt));
      L.w = lerp(L.w, card.target.w, damp(lambda*0.7, dt));
      L.h = lerp(L.h, card.target.h, damp(lambda*0.7, dt));
      L.scale = card.target.scale;
      L.rotX  = lerp(L.rotX,  card.target.rotX || 0, damp(lambda*0.8, dt));
      L.rotY  = lerp(L.rotY,  card.target.rotY || 0, damp(lambda*0.8, dt));
      L.rotZ  = lerp(L.rotZ,  card.target.rotZ || 0, damp(lambda*0.8, dt));
      L.blur  = lerp(L.blur,  card.target.blur, damp(lambda*1.4, dt));
      L.opacity = lerp(L.opacity, card.target.opacity, damp(lambda*1.2, dt));
      L.brightness = card.target.brightness;
      L.saturate   = card.target.saturate;

      /* is-main class */
      if(i === 0){
        card.el.classList.add('is-main');
      } else {
        card.el.classList.remove('is-main');
      }

      /* 写入 DOM */
      card.el.style.width  = L.w.toFixed(1) + 'px';
      card.el.style.height = L.h.toFixed(1) + 'px';
      card.el.style.transform =
        `translate3d(-50%, -50%, 0)` +
        ` translate3d(${L.x.toFixed(2)}px, ${L.y.toFixed(2)}px, ${L.z.toFixed(2)}px)` +
        ` rotateX(${L.rotX.toFixed(2)}deg) rotateY(${L.rotY.toFixed(2)}deg) rotateZ(${L.rotZ.toFixed(2)}deg)` +
        ` scale(${L.scale.toFixed(4)})`;
      card.el.style.opacity = L.opacity.toFixed(3);
      card.el.style.zIndex = Math.round(1000 + L.z);
      card.el.style.filter = `blur(${L.blur.toFixed(2)}px) brightness(${L.brightness.toFixed(3)}) saturate(${L.saturate.toFixed(3)})`;
    }

    /* === 7) Hero Light 跟随 hero position === */
    if(dom.fx.heroLight){
      const heroCard = cards[0];
      const carouselRect = dom.carousel.getBoundingClientRect();
      const heroScreenX = carouselRect.left + carouselRect.width / 2 + heroCard.live.x;
      const heroScreenY = carouselRect.top  + carouselRect.height / 2 + heroCard.live.y;
      const vpX = (heroScreenX / window.innerWidth) * 100;
      const vpY = (heroScreenY / window.innerHeight) * 100;
      // base opacity 0.10; INCOMING/RELEASING 略增强
      let op = 0.10;
      if(phase === 'incoming'){
        const k = Math.sin(phaseProgress * Math.PI);
        op = 0.10 + k * 0.10;
      } else if(phase === 'locked'){
        // 静止,只有极轻微 breathing
        op = 0.10 + Math.sin(t * 0.5) * 0.02;
      }
      dom.fx.heroLight.style.setProperty('--hero-x', vpX.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-y', vpY.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-r', '24');
      dom.fx.heroLight.style.setProperty('--hero-op', op.toFixed(3));
    }

    /* === 8) 粒子 (静止,只微闪) === */
    particles.forEach(p => {
      // 粒子不再 random 移动,只 opacity 微闪
      const opacity = (0.18 + Math.sin(t*0.5 + p.phase)*0.10) * 0.6;
      p.el.style.transform = `translate3d(${p.x}vw, ${p.y}vh, 0)`;
      p.el.style.opacity = opacity.toFixed(3);
    });

    /* === 9) fx 元素基础 opacity === */
    if(dom.fx.vignette) dom.fx.vignette.style.setProperty('--fx-op', '0.85');
    if(dom.fx.leak){
      const op = 0.20 + Math.sin(t*0.13)*0.05;
      dom.fx.leak.style.setProperty('--fx-op', op.toFixed(3));
      dom.fx.leak.style.transform = `translateX(${Math.sin(t*0.12)*2}%)`;
    }
    if(dom.fx.stars){
      const flick = 0.65 + Math.sin(t*1.7)*0.12;
      dom.fx.stars.style.opacity = flick.toFixed(3);
      dom.fx.stars.style.setProperty('--fx-op', '1');
    }
    if(dom.fx.particles) dom.fx.particles.style.setProperty('--fx-op', '0.4');
    if(dom.fx.grain) dom.fx.grain.style.setProperty('--fx-op', '0.20');
    // scanlines / rgb 仅 beat transition 期间轻微出现
    if(dom.fx.scan){
      const op = (phase === 'incoming' || phase === 'releasing') ? 0.10 * Math.sin(phaseProgress * Math.PI) : 0;
      dom.fx.scan.style.setProperty('--fx-op', op.toFixed(3));
    }
    if(dom.fx.rgb){
      const op = phase === 'incoming' ? 0.08 * Math.sin(phaseProgress * Math.PI) : 0;
      dom.fx.rgb.style.setProperty('--fx-op', op.toFixed(3));
    }

    /* === 10) 歌词 === */
    updateLyrics(time);

    rafId = requestAnimationFrame(tick);
  }

  /* ===================== 粒子 ===================== */
  const MAX_PARTICLES = 8;
  const particles = [];
  const particleRng = (function(){
    let s = 91732191;
    return () => { s = (s*1103515245+12345) & 0x7fffffff; return s / 0x80000000; };
  })();
  function initParticles(){
    for(let i=0;i<MAX_PARTICLES;i++){
      const p = document.createElement('div');
      p.className = 'ambient-particle';
      const w = (1.5 + particleRng()*2);
      p.style.width = w + 'px';
      p.style.height = p.style.width;
      p.style.opacity = '0';
      dom.layerParts.appendChild(p);
      particles.push({
        el:p, x: particleRng()*100, y: particleRng()*100,
        phase: particleRng()*Math.PI*2, w,
      });
    }
  }
  initParticles();

  /* ===================== 唱片封面 fallback ===================== */
  function imgFallback(imgEl){
    imgEl.addEventListener('error', function(){
      if(this.dataset.fallbackApplied === '1') return;
      this.dataset.fallbackApplied = '1';
      this.src = 'img/1.jpg';
    });
  }
  imgFallback(dom.diskCover);

  /* ===================== 辅助 ===================== */
  let cachedRect = null;
  function getCarouselRect(){
    if(!cachedRect) cachedRect = dom.carousel.getBoundingClientRect();
    return cachedRect;
  }
  window.addEventListener('resize', () => { cachedRect = null; });

  /* ===================== 歌词 ===================== */
  const lyricsData = (typeof LYRICS_DATA !== 'undefined') ? LYRICS_DATA : [];
  let currentLyricIdx = -1;

  function updateLyrics(time){
    if(lyricsData.length === 0) return;
    let idx = 0;
    for(let i=0;i<lyricsData.length;i++){
      if(time >= lyricsData[i].time) idx = i;
      else break;
    }
    if(idx !== currentLyricIdx){
      currentLyricIdx = idx;
      const text = lyricsData[idx].text;
      dom.lyricsText.classList.remove('show', 'fading', 'cue-micro', 'cue-emotion', 'cue-key', 'cue-time-rewind', 'cue-final');
      dom.lyricsText.textContent = '';
      requestAnimationFrame(() => {
        dom.lyricsText.textContent = text;
        dom.lyricsText.classList.add('cue-micro');
        requestAnimationFrame(() => {
          dom.lyricsText.classList.add('show');
        });
      });
    }
  }

  /* ===================== 进度条 ===================== */
  function formatTime(s){
    if(!isFinite(s) || isNaN(s)) s = 0;
    const m = Math.floor(s/60);
    const sec = Math.floor(s%60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  }
  function updateProgressBar(time){
    const total = getTotalDuration();
    const pct = (time / total) * 100;
    dom.progressFill.style.width = pct + '%';
    dom.progressThumb.style.left = pct + '%';
    dom.currentTime.textContent = formatTime(time);
    dom.totalTime.textContent   = formatTime(total);
  }
  let isDragging = false;
  function seekToX(clientX){
    const rect = dom.progressTrack.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = clamp(x / rect.width, 0, 1);
    const total = getTotalDuration();
    const time = ratio * total;
    if(window.musicBox) window.musicBox.seek(time);
    updateLyrics(time);
    updateProgressBar(time);
  }
  dom.progressTrack.addEventListener('mousedown', (e) => { isDragging = true; seekToX(e.clientX); });
  document.addEventListener('mousemove', (e) => { if(isDragging) seekToX(e.clientX); });
  document.addEventListener('mouseup',   () => { isDragging = false; });

  dom.progressTrack.addEventListener('touchstart', (e) => { isDragging = true; seekToX(e.touches[0].clientX); });
  document.addEventListener('touchmove',  (e) => { if(isDragging) seekToX(e.touches[0].clientX); });
  document.addEventListener('touchend',   () => { isDragging = false; });

  /* 翻页 ±10s */
  dom.leftZone.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.musicBox) window.musicBox.seek(Math.max(0, window.musicBox.currentTime - 10));
  });
  dom.rightZone.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.musicBox) window.musicBox.seek(Math.min(window.musicBox.totalDuration, window.musicBox.currentTime + 10));
  });

  /* Skip */
  dom.skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.Router) window.Router.go('interactive');
  });

  /* 唱片封面 */
  let currentVinylIdx = -1;
  let vinylSwapTimer = null;
  function nextVinylIdx(){
    const total = (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42);
    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * total);
      attempts++;
    } while((idx === currentVinylIdx) && attempts < 30);
    return idx;
  }
  function swapVinyl(){
    const idx = nextVinylIdx();
    if(idx < 0) return;
    currentVinylIdx = idx;
    dom.diskCover.style.opacity = '0';
    dom.diskCover.style.transform = 'scale(0.92)';
    setTimeout(() => {
      dom.diskCover.src = getPhotoSrc(idx);
      dom.diskCover.style.opacity = '1';
      dom.diskCover.style.transform = 'scale(1)';
    }, 350);
  }
  function startVinylSwap(){
    if(currentVinylIdx < 0){
      const idx = nextVinylIdx();
      if(idx < 0) return;
      currentVinylIdx = idx;
      dom.diskCover.src = getPhotoSrc(idx);
    }
    if(vinylSwapTimer) clearInterval(vinylSwapTimer);
    vinylSwapTimer = setInterval(swapVinyl, 4000);
  }
  startVinylSwap();

  /* RAF 启动 */
  function startRAF(){
    if(rafId) return;
    if(reduceMotion){
      return;
    }
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function stopRAF(){ if(rafId){ cancelAnimationFrame(rafId); rafId = 0; } }

  /* 时间驱动回调 */
  window._memoriesTick = function(time){
    updateLyrics(time);
    updateProgressBar(time);
  };

  /* 初始化 */
  if(dom.totalTime) dom.totalTime.textContent = formatTime(getTotalDuration());
  // 初始化场景 (让 HeroDirector 知道 photo 总数)
  window.HeroDirector.initScene(typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42);
  const initScene = window.HeroDirector.getBeatState(0, typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42);
  initScene.scenePhotoIndices.forEach((photoIdx, i) => {
    cardCurrentPhoto[i] = photoIdx;
    setCardImage(cards[i], getPhotoSrc(photoIdx));
  });

  startRAF();
  window._memoriesStart = startRAF;
  window._memoriesStop  = stopRAF;
})();