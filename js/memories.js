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

    /* === 2) Photo Sync === */
    const photoForDOM = new Array(NUM_CARDS);
    photoForDOM[0] = scenePhotoIndices[0];
    for(let i=1;i<NUM_CARDS;i++){
      photoForDOM[i] = scenePhotoIndices[i];
    }
    for(let i=0;i<NUM_CARDS;i++){
      const target = photoForDOM[i];
      if(target !== cardCurrentPhoto[i] && target >= 0){
        cardCurrentPhoto[i] = target;
        setCardImage(cards[i], getPhotoSrc(target));
      }
    }

    /* === 3) Camera State ===
       Camera 是视觉变化的主体。Beat phase + cameraDir 决定 camera transform */
    const camTarget = window.HeroDirector.getCameraState(beat, phase, phaseProgress);

    /* 平滑插值 */
    const camLambda = (phase === 'locked') ? 2.0 : 3.0;
    camLive.x     = lerp(camLive.x,     camTarget.x,     damp(camLambda, dt));
    camLive.y     = lerp(camLive.y,     camTarget.y,     damp(camLambda, dt));
    camLive.z     = lerp(camLive.z,     camTarget.z,     damp(camLambda, dt));
    camLive.rotX  = lerp(camLive.rotX,  camTarget.rotX,  damp(1.8, dt));
    camLive.rotY  = lerp(camLive.rotY,  camTarget.rotY,  damp(1.8, dt));
    camLive.scale = lerp(camLive.scale, camTarget.scale, damp(1.5, dt));

    /* === 4) Composition ===
       target composition 平滑过渡 */
    const targetComp = window.HeroDirector.getCompositionForBeat(beat.beatType, cameraDir, phase);
    if(!tick._compCurrent){
      tick._compCurrent = {
        hero: {...targetComp.hero},
        supports: JSON.parse(JSON.stringify(targetComp.supports)),
      };
    }
    const cur = tick._compCurrent;
    const compLambda = 2.5;
    cur.hero.x = lerp(cur.hero.x, targetComp.hero.x, damp(compLambda, dt));
    cur.hero.y = lerp(cur.hero.y, targetComp.hero.y, damp(compLambda, dt));
    cur.hero.scale = lerp(cur.hero.scale, targetComp.hero.scale, damp(compLambda, dt));
    for(const role in targetComp.supports){
      const t2 = targetComp.supports[role];
      const c = cur.supports[role] || {};
      if(typeof t2.x === 'number') c.x = lerp(c.x == null ? t2.x : c.x, t2.x, damp(compLambda, dt));
      if(typeof t2.y === 'number') c.y = lerp(c.y == null ? t2.y : c.y, t2.y, damp(compLambda, dt));
      if(typeof t2.scale === 'number') c.scale = lerp(c.scale == null ? t2.scale : c.scale, t2.scale, damp(compLambda, dt));
      if(typeof t2.rotZ === 'number') c.rotZ = lerp(c.rotZ == null ? t2.rotZ : c.rotZ, t2.rotZ, damp(compLambda, dt));
      if(typeof t2.rotY === 'number') c.rotY = lerp(c.rotY == null ? t2.rotY : c.rotY, t2.rotY, damp(compLambda, dt));
      if(typeof t2.opacity === 'number') c.opacity = lerp(c.opacity == null ? t2.opacity : c.opacity, t2.opacity, damp(compLambda, dt));
      cur.supports[role] = c;
    }

    /* === 5) Hero Motion (releasing/incoming 的视觉变化) === */
    const heroMotion = window.HeroDirector.getHeroMotion(phase, phaseProgress);

    /* === 6) 每张 card 的 transform ===
       基础位置 = composition
       + Ambient Motion (LOCKED 阶段持续微动,让画面活着)
       + Beat Motion (DISCOVERING/RELEASING/INCOMING 的剧烈效果) */
    const rect = dom.carousel.getBoundingClientRect();

    /* 全局 camera ambient breathing(让画面有"呼吸"感) */
    const globalBreathX = Math.sin(t * 0.45) * 1.2;
    const globalBreathY = Math.cos(t * 0.52) * 0.8;

    for(let i=0;i<NUM_CARDS;i++){
      const card = cards[i];
      const slotRole = SLOT_ROLES[i];

      let px, py, pz, scale, opacity, blur, rotZ, rotY, rotX;

      /* === BASE POSITION (从 composition) === */
      if(i === 0){
        const heroPos = cur.hero;
        px = (heroPos.x - 50) / 100 * rect.width;
        py = (heroPos.y - 50) / 100 * rect.height;
        pz = heroPos.z;
        scale = heroPos.scale * heroMotion.scaleMul;
        opacity = heroMotion.opacityMul;
        blur = heroMotion.blurMul;
        rotZ = (heroPos.rotZ || 0) + heroMotion.rotZ;
        rotY = (heroPos.rotY || 0) + heroMotion.rotY;
        rotX = 0;
      } else {
        const sPos = cur.supports[slotRole] || {};
        if(typeof sPos.x !== 'number'){
          card.el.style.opacity = '0';
          card.el.style.zIndex = '0';
          continue;
        }
        px = (sPos.x - 50) / 100 * rect.width;
        py = (sPos.y - 50) / 100 * rect.height;
        pz = sPos.z || -400;
        scale = sPos.scale || 0.3;
        opacity = sPos.opacity || 0;
        blur = 0;
        rotZ = sPos.rotZ || 0;
        rotY = sPos.rotY || 0;
        rotX = 0;
      }

      /* === AMBIENT MOTION (始终开启,让画面' 一直活着') ===
         每张卡按 depth cluster 频率做缓慢漂浮,独立 phase 避免同步 */
      const phaseBase = i * 0.83 + slotRole.charCodeAt(0) * 0.1;
      let amb_driftX = 0, amb_driftY = 0, amb_driftRZ = 0, amb_driftRY = 0, amb_driftRX = 0;

      /* 振幅按 depth 调制:FG 卡片更活跃, BG 更静 */
      const depthAmp = clamp(1 + pz / 400, 0.3, 1.6);
      if(i !== 0){
        // Supporting cards: 各自独立的漂移
        const wave1 = Math.sin(t * 0.31 + phaseBase);
        const wave2 = Math.cos(t * 0.27 + phaseBase * 0.7);
        const wave3 = Math.sin(t * 0.19 + phaseBase * 1.3);
        const wave4 = Math.cos(t * 0.41 + phaseBase * 0.5);
        amb_driftX = wave1 * 4 * depthAmp;
        amb_driftY = wave2 * 3 * depthAmp;
        amb_driftRZ = wave3 * 1.2 * depthAmp;
        amb_driftRY = wave4 * 1.5 * depthAmp;
        amb_driftRX = Math.sin(t * 0.15 + phaseBase * 0.9) * 0.6 * depthAmp;
      } else {
        // Hero: 极轻微 breathing (LOCKED 阶段让画面"活着",但不过分)
        amb_driftX = Math.sin(t * 0.4) * 1.0;
        amb_driftY = Math.cos(t * 0.45) * 0.7;
        amb_driftRZ = Math.sin(t * 0.3) * 0.5;
      }

      /* === BEAT-SPECIFIC MOTION (大动作,只在过渡阶段) === */
      let beat_driftX = 0, beat_driftY = 0, beat_driftRZ = 0;
      let beat_scaleMul = 0, beat_opacityMul = 0, beat_blurMul = 0;
      let beat_rotZ = 0, beat_rotY = 0;

      if(phase === 'discovering'){
        /* 镜头在寻找: 镜头方向的卡片 scale 微增,其他不动 */
        const dir = cameraDir;
        const isTarget = (i !== 0 && (slotRole.includes('LEFT') && dir === 'right' || slotRole.includes('RIGHT') && dir === 'left' || slotRole.includes('TOP') && dir === 'down' || slotRole.includes('BOTTOM') && dir === 'up'));
        if(isTarget){
          beat_scaleMul = phaseProgress * 0.15;
        }
        // hero 暂时 scale 微减 (镜头移动时画面轻微缩放)
        if(i === 0){
          beat_scaleMul = -phaseProgress * 0.04;
        }
      }

      if(phase === 'releasing'){
        /* 旧 hero 真的退场:scale ↓ opacity ↓ blur ↑, 戏剧化旋转 */
        const k = smoothstep(phaseProgress);
        if(i === 0){
          beat_scaleMul = -k * 0.45;     // scale -45%
          beat_opacityMul = -k * 0.7;    // opacity 几乎消失
          beat_blurMul = k * 2.5;        // blur 大幅增加
          beat_rotZ = k * 18;            // 戏剧化旋转
          beat_rotY = k * 25;
        } else {
          // supporting cards 全部短暂 scale +20% (让位,扩展空间)
          beat_scaleMul = k * 0.20;
          beat_opacityMul = k * 0.15;
          // supporting cards 飞散 (向外推)
          const dirX = (px > 0 ? 1 : -1) * 80;
          const dirY = (py > 0 ? 1 : -1) * 60;
          beat_driftX = lerp(0, dirX, k);
          beat_driftY = lerp(0, dirY, k);
          beat_driftRZ = lerp(0, dirX * 0.05, k);
        }
      }

      if(phase === 'incoming'){
        /* 新 hero 真的飞入: 从屏幕外大幅滑入,overshoot,rotation */
        const k = smoothstep(phaseProgress);
        const easeOut = 1 - Math.pow(1 - k, 3);
        if(i === 0){
          // 新 hero 从 cameraDir 反方向飞入
          const dir = cameraDir;
          let enterX = 0, enterY = 0;
          if(dir === 'right'){ enterX = -1500; }
          else if(dir === 'left'){ enterX = 1500; }
          else if(dir === 'up'){ enterY = -1500; }
          else if(dir === 'down'){ enterY = 1500; }
          else if(dir === 'in'){ enterX = -800; enterY = -400; } // in: 从左上方
          else if(dir === 'pull'){ enterX = 1500; enterY = 800; }
          // 飞入: progress 0 → 1 时 enterX 从最大值 → 0
          const enterDX = enterX * (1 - easeOut);
          const enterDY = enterY * (1 - easeOut);
          beat_driftX = enterDX;
          beat_driftY = enterDY;
          beat_driftRZ = -enterX * 0.01 * (1 - easeOut); // 飞行中带点倾斜
          beat_scaleMul = (1 - easeOut) * 0.25; // 起始小 25%,ease 变大
          // overshoot: progress 0.85-1.0 时 scale 短暂 +8% 再回到 1.0
          if(k > 0.85){
            const ok = (k - 0.85) / 0.15;
            const overshoot = Math.sin(ok * Math.PI) * 0.08;
            beat_scaleMul += overshoot;
          }
          // opacity 从 0 到 1
          beat_opacityMul = (1 - easeOut);
          beat_blurMul = (1 - easeOut) * 2.0;
          // rotation: 进入时倾斜
          beat_rotZ = (1 - easeOut) * (dir === 'right' ? -15 : dir === 'left' ? 15 : 0);
          beat_rotY = (1 - easeOut) * (dir === 'right' ? -20 : dir === 'left' ? 20 : 0);
        } else {
          /* supporting cards: 先散开 → 再收拢 (explode → settle)
             progress 0~0.5: 散开 (远离 hero)
             progress 0.5~1.0: 收拢 (回原位) */
          const explodeT = phaseProgress < 0.5
            ? phaseProgress * 2  // 0~1
            : 1 - (phaseProgress - 0.5) * 2; // 1~0
          const smoothExp = Math.sin(explodeT * Math.PI); // 0→1→0 平滑曲线
          // 从 hero 中心向外散
          const angle = (i * 0.85 + phaseBase * 0.3) * Math.PI;
          beat_driftX = Math.cos(angle) * smoothExp * 60;
          beat_driftY = Math.sin(angle) * smoothExp * 60;
          beat_driftRZ = smoothExp * 6 * (i % 2 === 0 ? 1 : -1);
          beat_scaleMul = smoothExp * 0.10;
          beat_opacityMul = smoothExp * 0.20;
        }
      }

      /* === COMBINE: 应用所有 motion === */
      let finalX = px + amb_driftX + beat_driftX + globalBreathX + camLive.x;
      let finalY = py + amb_driftY + beat_driftY + globalBreathY + camLive.y;
      let finalZ = pz + camLive.z;
      let finalScale = scale + beat_scaleMul;
      let finalOpacity = opacity + beat_opacityMul;
      let finalBlur = blur + beat_blurMul;
      let finalRotZ = rotZ + amb_driftRZ + beat_driftRZ;
      let finalRotY = rotY + amb_driftRY + beat_rotY;
      let finalRotX = amb_driftRX;

      /* 写入 target */
      card.target.x = finalX;
      card.target.y = finalY;
      card.target.z = finalZ;
      const sz = cardSizeForSlot(slotRole);
      card.target.w = sz.w * finalScale;
      card.target.h = sz.h * finalScale;
      card.target.scale = 1;  // scale 已合并到 w/h
      card.target.rotZ = finalRotZ;
      card.target.rotY = finalRotY;
      card.target.rotX = finalRotX;
      card.target.blur = Math.max(0, finalBlur);
      card.target.opacity = clamp(finalOpacity, 0, 1);
      card.target.brightness = (i === 0 ? 1.05 : (i < 3 ? 0.92 : 0.78));
      card.target.saturate = (i === 0 ? 1.05 : 0.95);

      /* Lerp live → target — 不同 phase 用不同 damping */
      const L = card.live;
      let lambda;
      if(phase === 'locked'){
        lambda = 5.0;  // LOCKED:卡片始终跟随 ambient motion(快跟随)
      } else if(phase === 'incoming'){
        lambda = 4.0;  // INCOMING:快速追上飞入
      } else {
        lambda = 5.0;
      }
      L.x = lerp(L.x, card.target.x, damp(lambda, dt));
      L.y = lerp(L.y, card.target.y, damp(lambda, dt));
      L.z = lerp(L.z, card.target.z, damp(lambda, dt));
      L.w = lerp(L.w, card.target.w, damp(lambda*0.7, dt));
      L.h = lerp(L.h, card.target.h, damp(lambda*0.7, dt));
      L.scale = card.target.scale;
      L.rotX  = lerp(L.rotX,  card.target.rotX, damp(lambda*0.8, dt));
      L.rotY  = lerp(L.rotY,  card.target.rotY, damp(lambda*0.8, dt));
      L.rotZ  = lerp(L.rotZ,  card.target.rotZ, damp(lambda*0.8, dt));
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

    /* === 7) Hero Light === */
    if(dom.fx.heroLight){
      const heroCard = cards[0];
      const carouselRect = dom.carousel.getBoundingClientRect();
      const heroScreenX = carouselRect.left + carouselRect.width / 2 + heroCard.live.x;
      const heroScreenY = carouselRect.top  + carouselRect.height / 2 + heroCard.live.y;
      const vpX = (heroScreenX / window.innerWidth) * 100;
      const vpY = (heroScreenY / window.innerHeight) * 100;
      let op = 0.12;
      if(phase === 'incoming'){
        const k = Math.sin(phaseProgress * Math.PI);
        op = 0.12 + k * 0.14;
      } else if(phase === 'locked'){
        op = 0.12 + Math.sin(t * 0.5) * 0.03;
      }
      dom.fx.heroLight.style.setProperty('--hero-x', vpX.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-y', vpY.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-r', '24');
      dom.fx.heroLight.style.setProperty('--hero-op', op.toFixed(3));
    }

    /* === 8) 粒子 (静态位置 + opacity 微闪) === */
    particles.forEach(p => {
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

    /* === 11) Camera Rig Transform (写 DOM) === */
    if(dom.cameraRig){
      dom.cameraRig.style.transform =
        `translate3d(${camLive.x.toFixed(2)}px, ${camLive.y.toFixed(2)}px, ${camLive.z.toFixed(2)}px)` +
        ` rotateX(${camLive.rotX.toFixed(3)}deg) rotateY(${camLive.rotY.toFixed(3)}deg)` +
        ` scale(${camLive.scale.toFixed(4)})`;
    }

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