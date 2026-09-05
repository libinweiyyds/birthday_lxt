/* ==================== Cinematic Memory Director V10 ====================
   《特别的人》Cinematic Memory V10 — 完整电影级转场系统

   12 种 Transition Type (per Beat):
     1.  depth-fly-in       从 z=-1200 推进到 z=0,blur 同步减少 (推荐默认)
     2.  camera-find        Camera 横移/推进,发现后面照片,focus pull
     3.  foreground-pass    前景卡 z=+500 快速划过,遮挡期间完成 Hero 交接
     4.  flip-reveal        rotateY 12° 微翻,新照片出现
     5.  cross-pass         新旧 Hero 在镜头前擦肩
     6.  memory-echo        旧 Hero 退场后,残影留在 BG
     7.  focus-pull         当前照片渐模糊,下一张渐清晰
     8.  slow-spiral        一次性旋转 + Z 推进进入
     9.  restack            几张散落照片慢慢叠成新构图
     10. orbit-fly-in       Z 推进 + 轻微 orbit
     11. drift-settle       几乎不动的切换(适合安静段)
     12. parallax-shift     Camera 横移产生视差(BG 移得少)

   Beat 状态机:
     LOCKED         Hero 占据画面
     DISCOVERING    镜头寻找下一张记忆
     RELEASING      旧 hero 退场
     INCOMING       新 hero 浮现
     (state 是通用的,transition type 只影响 INCOMING/RELEASING 的具体 motion)
*/

(function(){
  'use strict';

  const SCENE_SEED = 91732191;
  const clamp = (v,a,b) => v < a ? a : (v > b ? b : v);
  const lerp  = (a,b,t) => a + (b-a) * t;
  const smoothstep = t => t*t*(3 - 2*t);

  function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ===================== Memory Pool ==================== */
  function makeMemoryPool(total){
    const rng = mulberry32(SCENE_SEED ^ 0xC0DECAFE);
    const pool = {
      total,
      shuffled: [],
      usedHistory: [],
      reshuffle(){
        const arr = [];
        for(let i=0;i<this.total;i++) arr.push(i);
        for(let i = arr.length - 1; i > 0; i--){
          const j = Math.floor(rng() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        this.shuffled = arr;
      },
      pickNextHero(){
        if(this.shuffled.length === 0) this.reshuffle();
        const idx = this.shuffled.pop();
        this.usedHistory.push(idx);
        if(this.usedHistory.length > 8) this.usedHistory.shift();
        return idx;
      },
    };
    pool.reshuffle();
    return pool;
  }

  let memoryPool = null;
  let sceneInitialized = false;
  let scenePhotoIndices = null;
  /* 状态:上次 hero (用于 focus-pull) */
  let lastHeroIdx = -1;

  function initScene(numPhotos){
    if(sceneInitialized) return;
    if(!memoryPool || memoryPool.total !== numPhotos){
      memoryPool = makeMemoryPool(numPhotos);
    }
    const used = new Set();
    scenePhotoIndices = [];
    const hero = memoryPool.pickNextHero();
    scenePhotoIndices.push(hero);
    used.add(hero);
    for(let i=1;i<9;i++){
      const idx = memoryPool.pickNextHero();
      scenePhotoIndices.push(idx);
      used.add(idx);
    }
    lastHeroIdx = hero;
    sceneInitialized = true;
  }

  /* ===================== Beat Schedule ====================
     每个 Beat 包含:
       t              开始时间
       dur            持续 ms
       reason         'verse' | 'chorus' | 'bridge' | 'final' | 'outro' | 'intro'
       transitionType 12 种 transition 中的一种
       cameraDir      'right' | 'left' | 'up' | 'down' | 'in' | 'pull' | 'parallax-right' | 'parallax-left'
   */
  const BEATS = [
    // INTRO
    { t: 1.5,  dur: 5500,  reason: 'intro',    transitionType: 'depth-fly-in',    cameraDir: 'in' },
    // VERSE 1 - 亲密、安静
    { t: 18,   dur: 5500,  reason: 'verse',    transitionType: 'camera-find',     cameraDir: 'parallax-right' },
    { t: 35,   dur: 5500,  reason: 'verse',    transitionType: 'focus-pull',      cameraDir: 'parallax-left' },
    { t: 52,   dur: 5500,  reason: 'verse',    transitionType: 'memory-echo',     cameraDir: 'up' },
    // CHORUS 1
    { t: 66,   dur: 6000,  reason: 'chorus',   transitionType: 'foreground-pass', cameraDir: 'in' },
    { t: 86,   dur: 6000,  reason: 'chorus',   transitionType: 'depth-fly-in',    cameraDir: 'right' },
    // VERSE 2
    { t: 115,  dur: 5500,  reason: 'verse',    transitionType: 'flip-reveal',     cameraDir: 'down' },
    // CHORUS 2
    { t: 135,  dur: 6000,  reason: 'chorus',   transitionType: 'cross-pass',      cameraDir: 'left' },
    { t: 155,  dur: 6000,  reason: 'chorus',   transitionType: 'foreground-pass', cameraDir: 'right' },
    // BRIDGE
    { t: 172,  dur: 6000,  reason: 'bridge',   transitionType: 'memory-echo',     cameraDir: 'pull' },
    // BRIDGE ARRIVAL
    { t: 194,  dur: 6000,  reason: 'bridge',   transitionType: 'slow-spiral',     cameraDir: 'in' },
    // FINAL CHORUS
    { t: 207,  dur: 5500,  reason: 'final',    transitionType: 'depth-fly-in',    cameraDir: 'right' },
    { t: 222,  dur: 5500,  reason: 'final',    transitionType: 'restack',         cameraDir: 'left' },
    { t: 234,  dur: 5500,  reason: 'final',    transitionType: 'cross-pass',      cameraDir: 'in' },
    // OUTRO
    { t: 250,  dur: 6500,  reason: 'outro',    transitionType: 'drift-settle',    cameraDir: 'pull' },
  ];

  function getBeatState(time, numPhotos){
    if(!sceneInitialized) initScene(numPhotos || 42);

    let currentBeatIdx = 0;
    let nextBeatIdx = -1;
    for(let i=0;i<BEATS.length;i++){
      const b = BEATS[i];
      const end = b.t + b.dur / 1000;
      if(time >= b.t && time < end){
        currentBeatIdx = i;
        nextBeatIdx = (i + 1 < BEATS.length) ? i + 1 : -1;
        break;
      } else if(time < b.t){
        nextBeatIdx = i;
        break;
      }
    }
    const beat = BEATS[currentBeatIdx];
    const beatDur = beat.dur / 1000;
    const beatProgress = clamp((time - beat.t) / beatDur, 0, 1);

    /* Beat 内部阶段:
       0~0.30  DISCOVERING
       0.30~0.50 RELEASING
       0.50~0.80 INCOMING
       0.80~1.00 LOCKED
       (foreground-pass 类型把 RELEASING 延长为 0.30~0.60,让前景卡有更多时间划过)
    */
    let phase, phaseProgress;
    const isLongReleasing = beat.transitionType === 'foreground-pass' || beat.transitionType === 'cross-pass';
    if(beatProgress < 0.25){
      phase = 'discovering';
      phaseProgress = beatProgress / 0.25;
    } else if(beatProgress < (isLongReleasing ? 0.55 : 0.50)){
      phase = 'releasing';
      phaseProgress = (beatProgress - 0.25) / (isLongReleasing ? 0.30 : 0.25);
    } else if(beatProgress < 0.80){
      phase = 'incoming';
      phaseProgress = (beatProgress - (isLongReleasing ? 0.55 : 0.50)) / (isLongReleasing ? 0.25 : 0.30);
    } else {
      phase = 'locked';
      phaseProgress = (beatProgress - 0.80) / 0.20;
    }

    /* Beat 切换时的 photo 切换:
       depth-fly-in: 0.50 切换
       camera-find / parallax: 0.45 (提前) 切换
       focus-pull: 0.40 切换 (focus 已经在前面转移)
       foreground-pass: 0.55 (延后,等前景卡划过) 切换
       cross-pass: 0.55 切换 (两张卡交叉时)
    */
    if(!beat._advanced) beat._advanced = false;
    if(!beat._advanced){
      const advancePoint = beat.transitionType === 'focus-pull' ? 0.40
                        : beat.transitionType === 'camera-find' ? 0.45
                        : beat.transitionType === 'foreground-pass' ? 0.55
                        : beat.transitionType === 'cross-pass' ? 0.55
                        : 0.50;
      if((phase === 'releasing' && phaseProgress >= (advancePoint - 0.25) / 0.25) ||
         (phase === 'incoming' && beatProgress >= advancePoint)){
        beat._advanced = true;
        const oldHeroIdx = scenePhotoIndices[0];
        const newHeroIdx = memoryPool.pickNextHero();
        lastHeroIdx = oldHeroIdx;
        const newScene = [newHeroIdx, oldHeroIdx];
        const remaining = scenePhotoIndices.slice(2);
        for(let i = remaining.length - 1; i > 0; i--){
          const j = Math.floor(Math.random() * (i + 1));
          [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
        }
        for(let i=0;i<7;i++) newScene.push(remaining[i] || memoryPool.pickNextHero());
        scenePhotoIndices = newScene;
        memoryPool.currentHero = newHeroIdx;
      }
    }

    return {
      beat,
      beatProgress,
      phase,
      phaseProgress,
      heroIdx: scenePhotoIndices[0],
      previousHeroIdx: lastHeroIdx,
      scenePhotoIndices: scenePhotoIndices.slice(),
      cameraDir: beat.cameraDir,
      transitionType: beat.transitionType,
      reason: beat.reason,
    };
  }

  /* ===================== Camera Parallax ====================
     关键设计:不是 cards 各自漂移,而是 Camera 移动时,
     不同 depth 层的 cards 跟着移动但位移不同
     (Hero 几乎不动,BG 微移,MG 稍多,FG 最多)

     接收 cameraPos (camLive.x, camLive.y, camLive.z),
     返回每张卡的目标 parallax 偏移

     但目前 camLive.x/y 直接加到 card.target.x/y,
     实现方式是:让 cards 的 parallax 与 camLive 同步反转
     (camLive.x = +100px, 卡片视觉上 = -100px * depthFactor)
   */
  function getParallaxFactor(depthZ){
    /* depthZ 越负(更远),factor 越接近 0 (几乎不动)
       depthZ 越正(更近/前景),factor 越接近 1.5 (移动更大)
       depthZ = 0 (Hero),factor = 0.3 (轻微反向移动,制造"超稳"感)
    */
    if(depthZ > 0){
      // 前景 (FG) — factor 1.0~1.5
      return clamp(1 + depthZ / 600, 1.0, 1.5);
    }
    if(depthZ >= -300){
      // MG
      return clamp(0.5 + depthZ / 600, 0.3, 0.7);
    }
    if(depthZ >= -600){
      // BG
      return clamp(0.2 + depthZ / 1200, 0.1, 0.35);
    }
    return 0.05;  // 极远
  }

  /* ===================== Compositions ==================== */
  const COMPOSITIONS = {
    centered: {
      hero: { x:50, y:50, z:0, scale:1.0, rotZ:0, rotY:0 },
      supports: {
        FG_LEFT:  { x:18, y:56, z:-380, scale:0.42, rotZ:-6,  rotY:-18, opacity:0.40 },
        FG_RIGHT: { x:82, y:44, z:-380, scale:0.42, rotZ:7,   rotY:16,  opacity:0.40 },
        MG_LEFT:  { x:8,  y:30, z:-580, scale:0.28, rotZ:-4,  rotY:-22, opacity:0.18 },
        MG_RIGHT: { x:92, y:70, z:-580, scale:0.28, rotZ:5,   rotY:22,  opacity:0.18 },
        BG_LEFT:  { x:4,  y:78, z:-780, scale:0.16, rotZ:-3,  rotY:-28, opacity:0.08 },
        BG_RIGHT: { x:96, y:22, z:-780, scale:0.16, rotZ:4,   rotY:26,  opacity:0.08 },
        BG_TOP:   { x:78, y:8,  z:-780, scale:0.18, rotZ:-2,  rotY:0,   opacity:0.10 },
        BG_BOTTOM:{ x:22, y:92, z:-780, scale:0.18, rotZ:2,   rotY:0,   opacity:0.10 },
      },
    },
    'left-pan': {
      hero: { x:62, y:50, z:0, scale:0.96, rotZ:1, rotY:0 },
      supports: {
        FG_LEFT:  { x:28, y:54, z:-340, scale:0.45, rotZ:-8,  rotY:-14, opacity:0.42 },
        FG_RIGHT: { x:78, y:42, z:-440, scale:0.32, rotZ:4,   rotY:12,  opacity:0.28 },
        MG_LEFT:  { x:14, y:28, z:-560, scale:0.30, rotZ:-10, rotY:-20, opacity:0.20 },
        MG_RIGHT: { x:88, y:66, z:-560, scale:0.24, rotZ:6,   rotY:18,  opacity:0.14 },
        BG_LEFT:  { x:6,  y:74, z:-780, scale:0.16, rotZ:-5,  rotY:-25, opacity:0.08 },
        BG_RIGHT: { x:94, y:18, z:-780, scale:0.16, rotZ:3,   rotY:22,  opacity:0.08 },
        BG_TOP:   { x:60, y:6,  z:-780, scale:0.18, rotZ:-1,  rotY:0,   opacity:0.10 },
        BG_BOTTOM:{ x:32, y:90, z:-780, scale:0.16, rotZ:2,   rotY:0,   opacity:0.08 },
      },
    },
    'right-pan': {
      hero: { x:38, y:50, z:0, scale:0.96, rotZ:-1, rotY:0 },
      supports: {
        FG_LEFT:  { x:22, y:46, z:-440, scale:0.32, rotZ:-4,  rotY:-12, opacity:0.28 },
        FG_RIGHT: { x:72, y:54, z:-340, scale:0.45, rotZ:8,   rotY:14,  opacity:0.42 },
        MG_LEFT:  { x:12, y:72, z:-560, scale:0.24, rotZ:-6,  rotY:-18, opacity:0.14 },
        MG_RIGHT: { x:86, y:34, z:-560, scale:0.30, rotZ:10,  rotY:20,  opacity:0.20 },
        BG_LEFT:  { x:6,  y:26, z:-780, scale:0.16, rotZ:-3,  rotY:-22, opacity:0.08 },
        BG_RIGHT: { x:94, y:82, z:-780, scale:0.16, rotZ:5,   rotY:25,  opacity:0.08 },
        BG_TOP:   { x:40, y:6,  z:-780, scale:0.18, rotZ:1,   rotY:0,   opacity:0.10 },
        BG_BOTTOM:{ x:68, y:90, z:-780, scale:0.16, rotZ:-2,  rotY:0,   opacity:0.08 },
      },
    },
    'up-pan': {
      hero: { x:50, y:60, z:0, scale:0.96, rotZ:0 },
      supports: {
        FG_LEFT:  { x:24, y:30, z:-340, scale:0.42, rotZ:-8,  rotY:-16, opacity:0.40 },
        FG_RIGHT: { x:76, y:22, z:-340, scale:0.42, rotZ:8,   rotY:16,  opacity:0.40 },
        MG_LEFT:  { x:10, y:70, z:-540, scale:0.28, rotZ:-6,  rotY:-20, opacity:0.18 },
        MG_RIGHT: { x:90, y:76, z:-540, scale:0.28, rotZ:6,   rotY:20,  opacity:0.18 },
        BG_LEFT:  { x:4,  y:12, z:-780, scale:0.16, rotZ:-3,  rotY:-25, opacity:0.08 },
        BG_RIGHT: { x:96, y:6,  z:-780, scale:0.16, rotZ:4,   rotY:25,  opacity:0.08 },
        BG_TOP:   { x:50, y:4,  z:-780, scale:0.20, rotZ:0,   rotY:0,   opacity:0.10 },
        BG_BOTTOM:{ x:50, y:92, z:-780, scale:0.18, rotZ:0,   rotY:0,   opacity:0.10 },
      },
    },
    'down-pan': {
      hero: { x:50, y:40, z:0, scale:0.96, rotZ:0 },
      supports: {
        FG_LEFT:  { x:24, y:74, z:-340, scale:0.42, rotZ:-8,  rotY:-16, opacity:0.40 },
        FG_RIGHT: { x:76, y:70, z:-340, scale:0.42, rotZ:8,   rotY:16,  opacity:0.40 },
        MG_LEFT:  { x:10, y:18, z:-540, scale:0.28, rotZ:-6,  rotY:-20, opacity:0.18 },
        MG_RIGHT: { x:90, y:12, z:-540, scale:0.28, rotZ:6,   rotY:20,  opacity:0.18 },
        BG_LEFT:  { x:4,  y:90, z:-780, scale:0.16, rotZ:-3,  rotY:-25, opacity:0.08 },
        BG_RIGHT: { x:96, y:96, z:-780, scale:0.16, rotZ:4,   rotY:25,  opacity:0.08 },
        BG_TOP:   { x:50, y:92, z:-780, scale:0.18, rotZ:0,   rotY:0,   opacity:0.10 },
        BG_BOTTOM:{ x:50, y:4,  z:-780, scale:0.20, rotZ:0,   rotY:0,   opacity:0.10 },
      },
    },
    'pulled-back': {
      hero: { x:50, y:50, z:0, scale:0.78, rotZ:0 },
      supports: {
        FG_LEFT:  { x:18, y:60, z:-560, scale:0.30, rotZ:-8,  rotY:-18, opacity:0.28 },
        FG_RIGHT: { x:82, y:40, z:-560, scale:0.30, rotZ:8,   rotY:18,  opacity:0.28 },
        MG_LEFT:  { x:6,  y:24, z:-700, scale:0.22, rotZ:-5,  rotY:-22, opacity:0.14 },
        MG_RIGHT: { x:94, y:76, z:-700, scale:0.22, rotZ:5,   rotY:22,  opacity:0.14 },
        BG_LEFT:  { x:2,  y:84, z:-880, scale:0.14, rotZ:-3,  rotY:-28, opacity:0.06 },
        BG_RIGHT: { x:98, y:16, z:-880, scale:0.14, rotZ:3,   rotY:28,  opacity:0.06 },
        BG_TOP:   { x:76, y:4,  z:-880, scale:0.16, rotZ:-1,  rotY:0,   opacity:0.08 },
        BG_BOTTOM:{ x:24, y:96, z:-880, scale:0.16, rotZ:1,   rotY:0,   opacity:0.08 },
      },
    },
    'isolation': {
      hero: { x:50, y:50, z:0, scale:1.05, rotZ:0 },
      supports: {
        FG_LEFT:  { opacity:0 }, FG_RIGHT: { opacity:0 },
        MG_LEFT:  { opacity:0 }, MG_RIGHT: { opacity:0 },
        BG_LEFT:  { opacity:0 }, BG_RIGHT: { opacity:0 },
        BG_TOP:   { opacity:0 }, BG_BOTTOM:{ opacity:0 },
      },
    },
    'chorus': {
      hero: { x:50, y:50, z:0, scale:1.02, rotZ:0 },
      supports: {
        FG_LEFT:  { x:22, y:60, z:-260, scale:0.58, rotZ:-8,  rotY:-16, opacity:0.55 },
        FG_RIGHT: { x:78, y:40, z:-260, scale:0.58, rotZ:8,   rotY:16,  opacity:0.55 },
        MG_LEFT:  { x:8,  y:28, z:-480, scale:0.36, rotZ:-6,  rotY:-22, opacity:0.24 },
        MG_RIGHT: { x:92, y:72, z:-480, scale:0.36, rotZ:6,   rotY:22,  opacity:0.24 },
        BG_LEFT:  { x:2,  y:80, z:-700, scale:0.20, rotZ:-3,  rotY:-28, opacity:0.10 },
        BG_RIGHT: { x:98, y:20, z:-700, scale:0.20, rotZ:3,   rotY:28,  opacity:0.10 },
        BG_TOP:   { x:60, y:6,  z:-700, scale:0.22, rotZ:-1,  rotY:0,   opacity:0.12 },
        BG_BOTTOM:{ x:40, y:94, z:-700, scale:0.22, rotZ:1,   rotY:0,   opacity:0.12 },
      },
    },
  };

  function getCompositionForBeat(beatType, cameraDir, phase){
    if(phase === 'discovering'){
      if(cameraDir === 'parallax-right') return COMPOSITIONS['left-pan'];
      if(cameraDir === 'parallax-left')  return COMPOSITIONS['right-pan'];
      switch(cameraDir){
        case 'right': return COMPOSITIONS['left-pan'];
        case 'left':  return COMPOSITIONS['right-pan'];
        case 'up':    return COMPOSITIONS['down-pan'];
        case 'down':  return COMPOSITIONS['up-pan'];
        case 'in':    return COMPOSITIONS['chorus'];
        case 'pull':  return COMPOSITIONS['pulled-back'];
      }
    }
    if(phase === 'locked' || phase === 'incoming'){
      switch(beatType){
        case 'chorus-reveal': return COMPOSITIONS['chorus'];
        case 'isolation':     return COMPOSITIONS['isolation'];
        case 'pulled-back':   return COMPOSITIONS['pulled-back'];
        default: return COMPOSITIONS['centered'];
      }
    }
    return COMPOSITIONS['centered'];
  }

  /* ===================== Camera State ==================== */
  function getCameraState(beat, phase, phaseProgress){
    const cam = { x:0, y:0, z:0, rotX:0, rotY:0, scale:1 };
    const ease = smoothstep(phaseProgress);
    const dir = beat.cameraDir;

    /* DISCOVERING 阶段: Camera 移动寻找 */
    if(phase === 'discovering'){
      const panAmount = 100;
      if(dir === 'parallax-right'){
        cam.x = -ease * panAmount;  // 镜头向左 pan
        cam.rotY = ease * 1.8;
        cam.scale = 1 + ease * 0.05;
      } else if(dir === 'parallax-left'){
        cam.x = ease * panAmount;
        cam.rotY = -ease * 1.8;
        cam.scale = 1 + ease * 0.05;
      } else if(dir === 'right'){ cam.x = -ease * panAmount; cam.rotY = ease * 2.0; }
      else if(dir === 'left'){ cam.x = ease * panAmount; cam.rotY = -ease * 2.0; }
      else if(dir === 'up'){ cam.y = ease * panAmount; cam.rotX = -ease * 1.2; }
      else if(dir === 'down'){ cam.y = -ease * panAmount; cam.rotX = ease * 1.2; }
      else if(dir === 'in'){ cam.z = -ease * 140; cam.scale = 1 + ease * 0.06; }
      else if(dir === 'pull'){ cam.z = ease * 100; cam.scale = 1 - ease * 0.08; }
      return cam;
    }

    /* RELEASING 阶段: 旧 hero 退场,Camera 可能 pull back */
    if(phase === 'releasing'){
      const tt = beat.transitionType;
      if(tt === 'foreground-pass'){
        /* 前台划过时 Camera 静止,让前景卡做大动作 */
        cam.scale = 1 - ease * 0.04;
      } else if(tt === 'memory-echo' || tt === 'pulled-back'){
        cam.z = ease * 130;
        cam.scale = 1 - ease * 0.12;
      } else {
        cam.z = ease * 100;
        cam.scale = 1 - ease * 0.08;
      }
      return cam;
    }

    /* INCOMING 阶段: 新 hero 进入,Camera push in */
    if(phase === 'incoming'){
      const tt = beat.transitionType;
      if(tt === 'foreground-pass'){
        /* 前台划过后,Camera 推近 */
        cam.z = -ease * 80;
        cam.scale = 1 + ease * 0.04;
      } else if(tt === 'cross-pass'){
        /* 交叉时 camera 横移跟随 */
        if(dir === 'left'){ cam.x = -ease * 60; }
        else if(dir === 'right'){ cam.x = ease * 60; }
        cam.scale = 1 + ease * 0.05;
      } else {
        cam.z = -ease * 100;
        cam.scale = 1 + ease * 0.04;
      }
      return cam;
    }

    /* LOCKED: 静止,只极轻微 breathing */
    return cam;
  }

  /* ===================== Transition Motion ====================
     返回每张 DOM card 在当前 phase 的特殊 motion
     包括:
       - beat_driftX/Y/Z   位置偏移
       - beat_scaleMul     scale 偏移
       - beat_opacityMul   opacity 偏移
       - beat_blurMul      blur 偏移
       - beat_rotZ/Y/X     rotation 偏移
     memories.js 会把这些叠加到 composition position 上

     cardIndex: 0=HERO, 1-8=supporting
     slotRole: 'HERO' / 'FG_LEFT' / 'FG_RIGHT' / 'MG_LEFT' / 'MG_RIGHT' / 'BG_LEFT' / 'BG_RIGHT' / 'BG_TOP' / 'BG_BOTTOM'
   */
  function getTransitionMotion(transitionType, phase, phaseProgress, cardIndex, slotRole, cameraDir){
    const out = {
      driftX:0, driftY:0, driftZ:0, scaleMul:0, opacityMul:0, blurMul:0,
      rotZ:0, rotY:0, rotX:0,
    };
    const k = smoothstep(phaseProgress);
    const isHero = (cardIndex === 0);

    /* ========== RELEASING 阶段: 旧 hero / supporting 让位 ========== */
    if(phase === 'releasing'){
      const tt = transitionType;
      if(isHero){
        if(tt === 'focus-pull'){
          // focus-pull: 旧 hero 渐模糊但保持位置
          out.opacityMul = -k * 0.30;
          out.blurMul = k * 2.5;
        } else if(tt === 'memory-echo'){
          // memory-echo: 旧 hero 缩小后退,留残影
          out.scaleMul = -k * 0.20;  // 不要缩太多,保留可见
          out.driftZ = -k * 60;
          out.opacityMul = -k * 0.15;  // 不完全消失
          out.rotZ = -k * 5;
        } else if(tt === 'cross-pass'){
          // cross-pass: 旧 hero 向左滑出,准备和新的交叉
          out.driftX = -easeOutCubic(k) * 600;  // 强烈左滑
          out.opacityMul = -k * 0.4;
          out.rotZ = k * 8;
        } else if(tt === 'foreground-pass'){
          // foreground-pass: 旧 hero 在前台卡划过时仍可见
          out.opacityMul = -k * 0.20;
          out.scaleMul = -k * 0.10;
        } else {
          // 默认:旧 hero 缩退
          out.scaleMul = -k * 0.45;
          out.opacityMul = -k * 0.6;
          out.blurMul = k * 2.0;
          out.rotZ = -k * 12;
          out.rotY = -k * 18;
        }
      } else {
        // supporting cards: 各种让位效果
        if(tt === 'foreground-pass'){
          // supporting 让位,但有一张 FG 卡片准备做前景
          // 我们用 isHero=false 标记的所有 supporting cards 都轻微让位
          out.scaleMul = k * 0.18;
          out.driftX = Math.cos(cardIndex * 1.2) * k * 60;
          out.driftY = Math.sin(cardIndex * 1.5) * k * 40;
        } else if(tt === 'cross-pass'){
          // cross-pass: supporting cards 向两边散开
          out.driftX = (slotRole.includes('LEFT') ? -1 : 1) * k * 200;
          out.rotZ = (slotRole.includes('LEFT') ? -1 : 1) * k * 10;
          out.scaleMul = k * 0.15;
        } else if(tt === 'restack'){
          // restack: supporting 散开,准备重新叠
          const angle = cardIndex * 0.7;
          out.driftX = Math.cos(angle) * k * 200;
          out.driftY = Math.sin(angle) * k * 150;
          out.rotZ = (cardIndex % 2 === 0 ? 1 : -1) * k * 12;
          out.scaleMul = k * 0.10;
        } else if(tt === 'memory-echo'){
          // memory-echo: supporting cards 留下残影
          out.opacityMul = -k * 0.15;
        } else {
          // 默认: 支持卡向外散
          const dirX = (slotRole.includes('LEFT') || slotRole === 'FG_LEFT' || slotRole === 'MG_LEFT' || slotRole === 'BG_LEFT') ? -1 : 1;
          out.driftX = dirX * k * 80;
          out.driftY = (slotRole === 'BG_TOP' ? -1 : 1) * k * 50;
          out.scaleMul = k * 0.15;
        }
      }
      return out;
    }

    /* ========== INCOMING 阶段: 新 hero / supporting 迎接 ========== */
    if(phase === 'incoming'){
      const tt = transitionType;
      const easeOut = 1 - Math.pow(1 - phaseProgress, 3);
      const easeOutQuart = 1 - Math.pow(1 - phaseProgress, 4);
      if(isHero){
        if(tt === 'depth-fly-in'){
          // ★ 深度飞入:从 z=-1200 推进到 z=0,blur 同步减少
          out.driftZ = lerp(-1300, 0, easeOutQuart);
          out.scaleMul = (1 - easeOut) * 0.20;
          out.blurMul = (1 - easeOut) * 3.5;
          out.opacityMul = (1 - easeOut) * 0.5;
          out.rotZ = (1 - easeOut) * 6;
          out.rotY = (1 - easeOut) * 8;
          // overshoot
          if(phaseProgress > 0.85){
            const ok = (phaseProgress - 0.85) / 0.15;
            out.scaleMul += Math.sin(ok * Math.PI) * 0.06;
          }
        } else if(tt === 'camera-find'){
          // ★ Camera Find: Camera 推近 + 旋转,新 hero 从 BG浮现
          out.scaleMul = (1 - easeOut) * 0.10;
          out.driftZ = (1 - easeOut) * 200;  // 从 BG 推近
          out.blurMul = (1 - easeOut) * 1.5;
          out.opacityMul = (1 - easeOut) * 0.4;
          out.rotZ = (1 - easeOut) * 3;
        } else if(tt === 'foreground-pass'){
          // ★ Foreground Pass: 在前台卡划过后,新 hero 已经稳定
          out.scaleMul = (1 - easeOut) * 0.05;
          out.opacityMul = (1 - easeOut) * 0.3;
        } else if(tt === 'focus-pull'){
          // ★ Focus Pull: 新 hero 渐清晰,blur 同步减少
          out.blurMul = -(1 - easeOut) * 2.5;  // 减少 blur
          out.opacityMul = (1 - easeOut) * 0.2;
          out.scaleMul = (1 - easeOut) * 0.05;
        } else if(tt === 'memory-echo'){
          // memory-echo: 新 hero 从 BG 推到中心
          out.driftZ = (1 - easeOut) * 800;
          out.scaleMul = (1 - easeOut) * 0.15;
          out.opacityMul = (1 - easeOut) * 0.4;
          out.blurMul = (1 - easeOut) * 2.0;
        } else if(tt === 'cross-pass'){
          // cross-pass: 新 hero 从右侧滑入
          out.driftX = lerp(800, 0, easeOut);
          out.opacityMul = (1 - easeOut) * 0.3;
          out.rotZ = (1 - easeOut) * 5;
        } else if(tt === 'flip-reveal'){
          // ★ 3D Flip Reveal: rotateY 12° 翻入
          out.rotY = lerp(35, 0, easeOut);  // 从 +35° 翻到 0
          out.rotZ = (1 - easeOut) * 5;
          out.scaleMul = (1 - easeOut) * 0.05;
          out.opacityMul = (1 - easeOut) * 0.2;
        } else if(tt === 'restack'){
          // restack: 新 hero 从顶部缓缓落下
          out.driftY = lerp(-400, 0, easeOut);
          out.opacityMul = (1 - easeOut) * 0.3;
          out.rotZ = (1 - easeOut) * 4;
        } else if(tt === 'slow-spiral'){
          // ★ Slow Spiral: rotateZ + rotateY + Z 推进,一次性
          const k2 = phaseProgress;
          out.rotZ = lerp(15, 0, easeOut);   // 旋转 Z
          out.rotY = lerp(25, 0, easeOut);   // 旋转 Y
          out.driftZ = lerp(-300, 0, easeOut);  // Z 推进
          out.scaleMul = (1 - easeOut) * 0.05;
          out.opacityMul = (1 - easeOut) * 0.2;
        } else if(tt === 'drift-settle'){
          // drift-settle: 几乎不动
          out.opacityMul = (1 - easeOut) * 0.5;
        } else {
          // 默认
          out.opacityMul = (1 - easeOut) * 0.3;
          out.scaleMul = (1 - easeOut) * 0.10;
        }
        // overshoot (大部分 transition 共用)
        if(tt !== 'drift-settle' && phaseProgress > 0.85){
          const ok = (phaseProgress - 0.85) / 0.15;
          out.scaleMul += Math.sin(ok * Math.PI) * 0.04;
        }
      } else {
        // supporting cards 迎接效果
        if(tt === 'foreground-pass'){
          // 有一张 FG 卡片准备做前景 — 它在 RELEASING 时已经在前方
          // INCOMING 时这张 FG 卡片快速从前方撤退
          // 为了简化,让所有 supporting 收回原位
          out.scaleMul = (1 - easeOut) * 0.10;
        } else if(tt === 'cross-pass'){
          // supporting cards 收向 hero
          out.driftX = (slotRole.includes('LEFT') ? 1 : -1) * (1 - easeOut) * 150;
          out.driftY = (1 - easeOut) * 80;
          out.rotZ = (1 - easeOut) * 5;
          out.scaleMul = (1 - easeOut) * 0.10;
        } else if(tt === 'restack'){
          // 散开 → 重新叠
          const angle = cardIndex * 0.7;
          out.driftX = Math.cos(angle) * (1 - easeOut) * 250;
          out.driftY = Math.sin(angle) * (1 - easeOut) * 200;
          out.rotZ = (cardIndex % 2 === 0 ? 1 : -1) * (1 - easeOut) * 15;
          out.scaleMul = (1 - easeOut) * 0.15;
        } else if(tt === 'flip-reveal'){
          out.rotY = (1 - easeOut) * 20;
          out.scaleMul = (1 - easeOut) * 0.10;
        } else if(tt === 'slow-spiral'){
          out.rotZ = (1 - easeOut) * 8;
          out.rotY = (1 - easeOut) * 12;
        } else {
          // 默认 supporting cards 收拢
          out.scaleMul = (1 - easeOut) * 0.12;
        }
      }
      return out;
    }

    /* ========== DISCOVERING 阶段: 镜头寻找 ========== */
    if(phase === 'discovering'){
      const tt = transitionType;
      if(isHero){
        // hero 在 discovering 时 微缩(scale -4%),等待
        out.scaleMul = -phaseProgress * 0.04;
        if(tt === 'focus-pull'){
          // focus-pull 在 discovering 时已经模糊
          out.blurMul = phaseProgress * 1.5;
        }
      } else {
        // supporting cards: 根据 camera direction 表现
        const dir = cameraDir;
        const isTargetSide = (slotRole.includes('LEFT') && (dir === 'right' || dir === 'parallax-right')) ||
                              (slotRole.includes('RIGHT') && (dir === 'left' || dir === 'parallax-left'));
        if(isTargetSide){
          out.scaleMul = phaseProgress * 0.18;
          out.opacityMul = phaseProgress * 0.15;
        }
        if(tt === 'memory-echo'){
          // memory-echo: supporting cards 轻微 drift (为 echo 做准备)
          out.driftX = Math.cos(cardIndex * 0.8) * phaseProgress * 30;
          out.driftY = Math.sin(cardIndex * 1.1) * phaseProgress * 20;
        }
      }
      return out;
    }

    return out;
  }

  /* helper: easeOutCubic */
  function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }

  /* ===================== Public API ==================== */
  window.HeroDirector = {
    SCENE_SEED,
    BEATS,
    COMPOSITIONS,
    initScene,
    getBeatState,
    getCompositionForBeat,
    getCameraState,
    getTransitionMotion,
    getParallaxFactor,
  };
})();