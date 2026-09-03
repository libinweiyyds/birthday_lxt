/* ==================== Memory Director V8 ====================
   《Memory Director V8 — Memory Cinema》
   重新设计的核心:
     - 单张照片不能再"无限抖动":每张卡片基于 HeroDirector.SLOTS 的固定位置
     - 真实的故事推进来自 HeroDirector.HANDOFFS 列表的 Hero 交接
     - 每次交接都有 DISCOVERY → APPROACH → CROSS → SETTLE 四阶段
     - 卡片只在交接期间明显运动,其它时间只有"呼吸"级微动
     - Camera 由 handoff.camera 决定(push/pull/dolly/orbit/stillness)
     - 歌词决定 hero 交接的"理由",但不直接驱动运动

   模块:
     HeroDirector      谁是主角 / 何时交接 / 以何种方式入场
     Camera Director    当前镜头处于什么 Shot
     Card Choreographer 单张卡片的 transform:slot + handoff + outgoing + ambient
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

  /* 每张 card 的 DOM 结构: <card> <img-A/> <img-B/> <caption/> </card> */
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
        target:{x:0,y:0,w:300,h:400,rotX:0,rotY:0,rotZ:0,scale:1,blur:0,opacity:0,brightness:1,saturate:1},
        live:{x:0,y:0,w:300,h:400,rotX:0,rotY:0,rotZ:0,scale:1,blur:0,opacity:0,brightness:1,saturate:1,z:0},
      });
    }
  }
  buildCards();

  /* 跨预加载 + crossfade 设置卡片图片 */
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

  /* ===================== Camera Tone → Shot 函数 ====================
     Camera 在 handoff 期间根据 cameraTone 做对应运动,
     平时只有 ambient breathing。
  */
  const CAMERA_SHOTS = {
    'push': (p, t) => {
      const k = smoothstep(clamp(p, 0, 1));
      return {
        x: Math.sin(t*0.04)*2,
        y: Math.sin(t*0.05)*1.5,
        z: k * 180,
        rotX: 0, rotY: 0,
        scale: 1 + k*0.06,
      };
    },
    'pull': (p, t) => {
      const k = smoothstep(clamp(p, 0, 1));
      return {
        x: Math.sin(t*0.04)*2,
        y: Math.sin(t*0.05)*1.5,
        z: -k * 220,
        rotX: 0, rotY: 0,
        scale: 1 - k*0.10,
      };
    },
    'dolly': (p, t) => {
      // dolly: 摄影机横向轻微扫过,配合 cross preset
      const k = smoothstep(clamp(p, 0, 1));
      return {
        x: lerp(40, -40, k),
        y: Math.sin(t*0.04)*1,
        z: k * 80,
        rotX: 0,
        rotY: lerp(2, -2, k),
        scale: 1 + k*0.04,
      };
    },
    'drift': (p, t) => {
      const k = smoothstep(clamp(p, 0, 1));
      return {
        x: lerp(-30, 30, k),
        y: Math.sin(t*0.04)*1,
        z: 0,
        rotX: 0,
        rotY: lerp(1, -1, k),
        scale: 1,
      };
    },
    'orbit': (p, t) => {
      const k = smoothstep(clamp(p, 0, 1));
      return {
        x: Math.sin(t*0.04)*1.5,
        y: Math.sin(t*0.05)*1,
        z: 0,
        rotX: Math.sin(t*0.03)*0.2,
        rotY: -3 + k*6,
        scale: 1,
      };
    },
    'stillness': (p, t) => ({
      x: Math.sin(t*0.04)*1.5,
      y: Math.sin(t*0.05)*1,
      z: 0, rotX: 0, rotY: 0, scale: 1,
    }),
    '__none': (p, t) => ({ x:0, y:0, z:0, rotX:0, rotY:0, scale:1 }),
  };

  /* ===================== 粒子(Layer 2) ===================== */
  const MAX_PARTICLES = 10;
  const particles = [];
  const particleRng = (window.MotionScheduler && window.MotionScheduler.mulberry32
                       ? window.MotionScheduler.mulberry32(91732191 ^ 0x917321)
                       : (() => { let s=0; return () => { s=(s*1103515245+12345)&0x7fffffff; return s/0x80000000; }; })());
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
        vx: (particleRng()-0.5)*0.015, vy: (particleRng()-0.5)*0.015 - 0.003,
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

  /* ===================== 状态 ===================== */
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastT = performance.now();
  let rafId = 0;
  const camLive = { x:0, y:0, rotX:0, rotY:0, z:0, scale:1 };

  /* 每张 card 的 "currentPhotoIdx" — 跟踪每张 DOM card 当前显示的照片 */
  const cardCurrentPhoto = new Array(NUM_CARDS).fill(-1);
  /* 上一次 handoff 状态 — 用于检测 handoff 边界 */
  let lastHandoffKey = '';

  /* ===================== RAF Render Loop ===================== */
  function tick(now){
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const time = window.musicBox ? window.musicBox.currentTime : 0;
    const t = now / 1000;

    /* === 1) Scene State: HeroDirector 决定每张 DOM card 显示哪张照片、是否在 handoff === */
    const numPhotos = (typeof NUM_PHOTOS !== 'undefined') ? NUM_PHOTOS : 42;
    const scene = window.HeroDirector.getSceneState(time, numPhotos);
    const handoff = scene.handoff;
    const handoffPhase = handoff ? handoff._phase : null;

    /* === 2) Photo Sync:决定每张 DOM card 该显示哪张照片 ===
       关键:handoff 期间 (progress 0.10~0.85) slot 0 (HERO) 显示 NEW hero
       (从 BG 推进过来的新照片),让用户真的看到"新照片变成主角"。
       其他 slot 保持当前 scene 分配(不变,避免突然跳变)。*/
    const photoForDOM = new Array(NUM_CARDS);

    if(handoff && handoff._progress >= 0.10 && handoff._progress < 0.85
       && scene.incomingHeroIdx !== undefined && scene.incomingHeroIdx !== scene.heroIdx){
      // 在 handoff 期间:slot 0 显示新 hero
      photoForDOM[0] = scene.incomingHeroIdx;
      // 旧 hero 此时在 FG_LEFT 位置上 — 但 DOM card 1 (FG_LEFT) 是固定显示 photoForSlot[1]
      // 在 settle 之前,photoForSlot[1] 还是旧值(因为还没 advance)
      // — 而旧 hero 仍然在 photoForSlot[0]。我们希望 FG_LEFT 显示旧 hero:
      // 实际:scene.photoForSlot[0] = old hero (在 settle 之前)
      // 所以把 slot 0 设为 incomingHeroIdx,其它 slot 仍按 photoForSlot
      // — 这样 DOM card 1 继续显示 photoForSlot[1](不是旧 hero)
      // 改进:让 slot 1 也显示 photoForSlot[0](旧 hero)
      photoForDOM[1] = scene.photoForSlot[0]; // 旧 hero 暂时占据 FG_LEFT slot
      for(let i=2;i<NUM_CARDS;i++){
        photoForDOM[i] = scene.photoForSlot[i];
      }
    } else {
      // 平时或 settle 后:slot 0 = 当前 hero, slot 1 = photoForSlot[1]
      photoForDOM[0] = scene.photoForSlot[0];
      for(let i=1;i<NUM_CARDS;i++){
        photoForDOM[i] = scene.photoForSlot[i];
      }
    }

    /* 写入 DOM src (用 setCardImage 做 crossfade) */
    for(let i=0;i<NUM_CARDS;i++){
      const target = photoForDOM[i];
      if(target !== cardCurrentPhoto[i] && target >= 0){
        cardCurrentPhoto[i] = target;
        setCardImage(cards[i], getPhotoSrc(target));
      }
    }

    /* === 3) Camera ===
       - handoff 期间:用 handoff.camera 对应的 Shot 函数
       - 平时:stillness(只有 ambient breathing)
    */
    let camTarget;
    if(handoff){
      const tone = handoff.camera || 'stillness';
      const shotFn = CAMERA_SHOTS[tone] || CAMERA_SHOTS.stillness;
      camTarget = shotFn(handoff._progress, t);
    } else {
      // 平时 ambient breathing
      camTarget = CAMERA_SHOTS.stillness(0, t);
    }

    /* 平滑插值 */
    camLive.x     = lerp(camLive.x,     camTarget.x,     damp(2.0, dt));
    camLive.y     = lerp(camLive.y,     camTarget.y,     damp(2.0, dt));
    camLive.z     = lerp(camLive.z,     camTarget.z,     damp(2.0, dt));
    camLive.rotX  = lerp(camLive.rotX,  camTarget.rotX,  damp(1.2, dt));
    camLive.rotY  = lerp(camLive.rotY,  camTarget.rotY,  damp(1.2, dt));
    camLive.scale = lerp(camLive.scale, camTarget.scale, damp(1.0, dt));

    if(dom.cameraRig){
      dom.cameraRig.style.transform =
        `translate3d(${camLive.x.toFixed(2)}px, ${camLive.y.toFixed(2)}px, ${camLive.z.toFixed(2)}px)` +
        ` rotateX(${camLive.rotX.toFixed(3)}deg) rotateY(${camLive.rotY.toFixed(3)}deg)` +
        ` scale(${camLive.scale.toFixed(4)})`;
    }

    /* === 4) 每张 card 的 transform ===
       基础位置 = HeroDirector.SLOTS[i] (固定空间位置)
       + handoff motion (新 hero 从 origin 到 HERO 的轨迹)
       + outgoing motion (旧 hero 从 FG_LEFT 退向 BG)
       + 极小的 breathing 微动
    */
    const rect = dom.carousel.getBoundingClientRect();
    const handoffMotion = (handoff)
      ? window.HeroDirector.getHandoffMotionForCard(handoff, 'HERO')
      : null;
    const outgoingMotion = window.HeroDirector.getOutgoingMotion(scene, 'FG_LEFT');

    for(let i=0;i<NUM_CARDS;i++){
      const slotBase = window.HeroDirector.SLOTS[i];
      const card = cards[i];

      /* Slot 像素位置 */
      let px = (slotBase.x - 50) / 100 * rect.width;
      let py = (slotBase.y - 50) / 100 * rect.height;
      let pz = slotBase.z;
      let scale = slotBase.scale;
      let opacity = slotBase.opacity;
      let blur = slotBase.blur;

      /* === HERO card (slot 0) ===
         在 handoff 期间,根据 handoffMotion 从 BG 推进到 HERO */
      if(i === 0 && handoffMotion){
        // 用 motion 覆盖 base position
        // handoffMotion.dz 表示"目标 z 偏移量",我们要让 card 从 origin z → 0
        // 我们用 slotBase.z + motion.dz 即可
        // 同时 scale, opacity, blur, dx, dy, rotZ, rotY 由 motion 提供
        px += handoffMotion.dx;
        py += handoffMotion.dy;
        pz += handoffMotion.dz;
        scale += handoffMotion.scaleDelta;
        opacity = handoffMotion.opacity; // 完全由 motion 决定(从 BG 浮现)
        blur = handoffMotion.blur;
        // rotation
        card.target.rotZ = handoffMotion.rotZ || 0;
        card.target.rotY = handoffMotion.rotY || 0;
      } else {
        card.target.rotZ = 0;
        card.target.rotY = 0;
      }

      /* === FG_LEFT card (slot 1) ===
         如果 scene.outgoingIdx 不为 null,这张卡显示旧 hero,正在退场 */
      if(i === 1 && outgoingMotion){
        if(outgoingMotion.dxRatio !== undefined){
          px += outgoingMotion.dxRatio * rect.width;
        } else {
          px += outgoingMotion.dx || 0;
        }
        if(outgoingMotion.dyRatio !== undefined){
          py += outgoingMotion.dyRatio * rect.height;
        } else {
          py += outgoingMotion.dy || 0;
        }
        pz += outgoingMotion.dz;
        scale += outgoingMotion.scaleDelta;
        opacity += outgoingMotion.opacityDelta;
        blur += outgoingMotion.blurDelta;
        card.target.rotZ = outgoingMotion.rotZ || 0;
      }

      /* === handoff 期间,非 HERO/FG_LEFT 卡片保持 SLOTS 位置,但轻微 blur/opacity 调整 === */
      if(handoff){
        if(i !== 0 && i !== 1){
          // 配角:在 CROSS 阶段(0.6~0.85)轻微退后,景深加强
          if(handoff._progress > 0.60){
            const k = smoothstep(clamp((handoff._progress - 0.60) / 0.25, 0, 1));
            opacity -= k * 0.10;
            blur += k * 0.3;
          }
        }
      }

      /* 极轻微 breathing — 不随机旋转,只在 hero 处允许 ±1.5px scale breathing */
      let breathX = 0, breathY = 0;
      if(i === 0){
        breathX = Math.sin(t*0.4) * 1.2;
        breathY = Math.cos(t*0.5) * 0.8;
      }

      /* 写入 target */
      const targetX = px + breathX - camLive.x * 0.4;
      const targetY = py + breathY - camLive.y * 0.4;
      const targetZ = pz - camLive.z * 0.3;
      card.target.x = targetX;
      card.target.y = targetY;
      card.target.z = targetZ;
      // Hero 卡片适度大小,配角更小(让 Hero 不会巨大铺满)
      if(i === 0){
        card.target.w = 480;
        card.target.h = 600;
      } else if(i === 1 || i === 2){
        card.target.w = 360;
        card.target.h = 450;
      } else {
        card.target.w = 280;
        card.target.h = 350;
      }
      card.target.scale = scale;
      card.target.blur = blur;
      card.target.opacity = opacity;
      card.target.brightness = (i === 0 ? 1.05 : (i === 1 || i === 2 ? 0.92 : 0.78));
      card.target.saturate = (i === 0 ? 1.05 : 0.95);

      /* Lerp live → target */
      const L = card.live;
      const lambda = (i === 0) ? 4.5 : 3.5;
      L.x = lerp(L.x, card.target.x, damp(lambda, dt));
      L.y = lerp(L.y, card.target.y, damp(lambda, dt));
      L.z = lerp(L.z, card.target.z, damp(lambda, dt));
      L.w = lerp(L.w, card.target.w, damp(lambda*0.7, dt));
      L.h = lerp(L.h, card.target.h, damp(lambda*0.7, dt));
      L.scale = lerp(L.scale, card.target.scale, damp(lambda, dt));
      L.rotX  = lerp(L.rotX,  card.target.rotX || 0, damp(lambda*0.8, dt));
      L.rotY  = lerp(L.rotY,  card.target.rotY || 0, damp(lambda*0.8, dt));
      L.rotZ  = lerp(L.rotZ,  card.target.rotZ || 0, damp(lambda*0.8, dt));
      L.blur  = lerp(L.blur,  card.target.blur, damp(lambda*1.4, dt));
      L.opacity = lerp(L.opacity, card.target.opacity, damp(lambda*1.2, dt));
      L.brightness = lerp(L.brightness, card.target.brightness, damp(lambda, dt));
      L.saturate   = lerp(L.saturate,   card.target.saturate,   damp(lambda, dt));

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

    /* === 5) Hero Light 跟随 HERO card 位置 === */
    if(dom.fx.heroLight){
      const heroCard = cards[0];
      const carouselRect = dom.carousel.getBoundingClientRect();
      const heroScreenX = carouselRect.left + carouselRect.width / 2 + heroCard.live.x;
      const heroScreenY = carouselRect.top  + carouselRect.height / 2 + heroCard.live.y;
      const vpX = (heroScreenX / window.innerWidth) * 100;
      const vpY = (heroScreenY / window.innerHeight) * 100;
      // 基础 opacity 0.10; handoff 期间略增(0.20)
      let op = 0.10;
      if(handoff){
        const k = Math.sin(handoff._progress * Math.PI);
        op = 0.10 + k * 0.10;
      }
      dom.fx.heroLight.style.setProperty('--hero-x', vpX.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-y', vpY.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-r', '24');
      dom.fx.heroLight.style.setProperty('--hero-op', op.toFixed(3));
    }

    /* === 6) 粒子 === */
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      if(p.x < 0) p.x = 100;
      if(p.x > 100) p.x = 0;
      if(p.y < 0) p.y = 100;
      if(p.y > 100) p.y = 0;
      const opacity = (0.25 + Math.sin(t*0.5 + p.phase)*0.2) * 0.6;
      p.el.style.transform = `translate3d(${p.x}vw, ${p.y}vh, 0)`;
      p.el.style.opacity = opacity.toFixed(3);
    });

    /* === 7) fx 元素基础 opacity === */
    // vignette 始终
    if(dom.fx.vignette){
      const baseOp = 0.85;
      dom.fx.vignette.style.setProperty('--fx-op', baseOp.toFixed(3));
    }
    // leak 始终微弱
    if(dom.fx.leak){
      const op = 0.25 + Math.sin(t*0.13)*0.05;
      dom.fx.leak.style.setProperty('--fx-op', op.toFixed(3));
      dom.fx.leak.style.transform = `translateX(${Math.sin(t*0.12)*3}%)`;
    }
    // stars 始终,微闪
    if(dom.fx.stars){
      const flick = 0.65 + Math.sin(t*1.7)*0.12;
      dom.fx.stars.style.opacity = flick.toFixed(3);
      dom.fx.stars.style.setProperty('--fx-op', '1');
    }
    // particles layer 始终
    if(dom.fx.particles){
      dom.fx.particles.style.setProperty('--fx-op', '0.5');
    }
    // grain 始终
    if(dom.fx.grain){
      dom.fx.grain.style.setProperty('--fx-op', '0.25');
    }
    // scanlines / rgb 仅 handoff 期间
    if(dom.fx.scan){
      const op = handoff ? 0.15 * Math.sin(handoff._progress * Math.PI) : 0;
      dom.fx.scan.style.setProperty('--fx-op', op.toFixed(3));
    }
    if(dom.fx.rgb){
      const op = handoff ? 0.10 * Math.sin(handoff._progress * Math.PI) : 0;
      dom.fx.rgb.style.setProperty('--fx-op', op.toFixed(3));
    }

    /* === 8) 歌词 === */
    updateLyrics(time);

    rafId = requestAnimationFrame(tick);
  }

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

  /* 唱片封面 — 每 4s 切换一次,但不与 hero 同 */
  let currentVinylIdx = -1;
  let vinylSwapTimer = null;
  function nextVinylIdx(){
    const total = (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42);
    let heroIdx = -1;
    try {
      const sc = window.HeroDirector.getSceneState(window.musicBox ? window.musicBox.currentTime : 0, total);
      heroIdx = sc.photoForSlot[0];
    } catch(e){}
    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * total);
      attempts++;
    } while((idx === heroIdx || idx === currentVinylIdx) && attempts < 30);
    return idx === heroIdx ? -1 : idx;
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
      const slot = window.HeroDirector.SLOTS[0];
      const heroSrc = getPhotoSrc(0);
      cards.forEach((c,i) => setCardImage(c, getPhotoSrc(i)));
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
  // 立即设置 initial photos (slot 0 = hero, 1..8 = initial pool)
  const numPhotos = (typeof NUM_PHOTOS !== 'undefined') ? NUM_PHOTOS : 42;
  const initScene = window.HeroDirector.getSceneState(0, numPhotos);
  initScene.photoForSlot.forEach((photoIdx, i) => {
    cardCurrentPhoto[i] = photoIdx;
    setCardImage(cards[i], getPhotoSrc(photoIdx));
  });

  // 在 lyricsData 准备好后构建 EVENT_TIMELINE
  startRAF();
  window._memoriesStart = startRAF;
  window._memoriesStop  = stopRAF;
})();