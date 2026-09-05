/* ==================== Cinematic Memory Director V9 ====================
   《特别的人》Cinematic Memory System V9 — 镜头驱动的电影回忆蒙太奇

   核心架构转变 (vs V8):
     - V8: Hero 基于固定 SLOTS,Preset motion 让 hero 入场,其他 cards 持续 drift
     - V9: Hero 是动态状态,Beat 状态机控制整个场景,Camera 是视觉变化的主体

   Beat 状态机:
     LOCKED         Hero 占据画面,Camera 静止(只有极轻微 breathing)
     DISCOVERING    Camera 移动寻找下一张记忆 (pan + zoom + 寻找远方 card)
     RELEASING      旧 hero 退场 (相机拉远,old hero 自然变小)
     INCOMING       新 hero 浮现 (相机推近,new hero 越来越大)
     ISOLATION      镜头只看到 hero,其他 cards 全部消失

   核心职责:
     1. MemoryPool - 管理所有 photoIdx (避免连续重复)
     2. BeatSchedule - 硬编码 Beat 时间表(绑定 lyric cues)
     3. getCurrentBeat(time) - 返回当前 Beat 状态(hero, beat type, progress)
     4. getNextHandoffInfo - 在 DISCOVERING 时返回下一张记忆的视觉信息

   摄影机不是"卡片的位置",而是"摄影机本身在 3D 空间中移动"。
   卡片位置由 Slot + Composition Type + Beat progress 计算。
*/

(function(){
  'use strict';

  const SCENE_SEED = 91732191;
  const TAU = Math.PI * 2;
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

  /* ===================== Memory Pool ====================
     管理 photoIdx,每次 Beat 切换时重新洗牌 */
  function makeMemoryPool(total){
    const rng = mulberry32(SCENE_SEED ^ 0xC0DECAFE);
    const pool = {
      total,
      shuffled: [],
      usedHistory: [],
      currentHero: null,
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
  /* 9 个 photoIdx 在场景中的状态:
     [HERO, FG_NEAR_LEFT, FG_NEAR_RIGHT, MG_LEFT, MG_RIGHT,
      BG_LEFT, BG_RIGHT, BG_TOP, BG_BOTTOM] */
  let scenePhotoIndices = null;

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
    memoryPool.currentHero = hero;
    sceneInitialized = true;
  }

  /* ===================== Beat Schedule ====================
     时间表:每个 Beat 描述一个完整的"镜头发现 → 交接 → 停留"周期
     Beats 与 lyrics 绑定
     每个 Beat 包含:
       t           开始时间
       duration    Beat 总长(ms)
       reason      'verse' | 'chorus' | 'bridge' | 'final' | 'outro'
       beatType    Beat 类型,定义整体节奏
       cameraDir   Camera 寻找方向 ('right' | 'left' | 'up' | 'down' | 'in')
   */
  const BEATS = [
    // INTRO - 开场建立
    { t: 1.5,  dur: 4500,  reason: 'intro',    beatType: 'establish', cameraDir: 'in' },
    // VERSE 1 - 亲密、安静
    { t: 18,   dur: 4500,  reason: 'verse',    beatType: 'memory-find', cameraDir: 'right' },
    { t: 35,   dur: 4500,  reason: 'verse',    beatType: 'memory-find', cameraDir: 'left' },
    { t: 52,   dur: 4500,  reason: 'verse',    beatType: 'memory-find', cameraDir: 'up' },
    // CHORUS 1 - 空间打开
    { t: 66,   dur: 5500,  reason: 'chorus',   beatType: 'chorus-reveal', cameraDir: 'in' },
    { t: 86,   dur: 5000,  reason: 'chorus',   beatType: 'chorus-reveal', cameraDir: 'right' },
    // VERSE 2
    { t: 115,  dur: 4500,  reason: 'verse',    beatType: 'memory-find', cameraDir: 'down' },
    // CHORUS 2 - 记忆爆发
    { t: 135,  dur: 5500,  reason: 'chorus',   beatType: 'chorus-reveal', cameraDir: 'left' },
    { t: 155,  dur: 5000,  reason: 'chorus',   beatType: 'chorus-reveal', cameraDir: 'right' },
    // BRIDGE - 孤独、留白
    { t: 172,  dur: 5000,  reason: 'bridge',   beatType: 'isolation',    cameraDir: 'pull' },
    // BRIDGE ARRIVAL - Hero 重新进入
    { t: 195,  dur: 5500,  reason: 'bridge',   beatType: 'memory-find', cameraDir: 'in' },
    // FINAL CHORUS
    { t: 207,  dur: 5000,  reason: 'final',    beatType: 'chorus-reveal', cameraDir: 'right' },
    { t: 222,  dur: 5000,  reason: 'final',    beatType: 'chorus-reveal', cameraDir: 'left' },
    { t: 234,  dur: 5000,  reason: 'final',    beatType: 'chorus-reveal', cameraDir: 'in' },
    // OUTRO
    { t: 250,  dur: 6000,  reason: 'outro',    beatType: 'isolation',    cameraDir: 'pull' },
  ];

  /* ===================== Beat 状态 ====================
     每个 Beat 的内部进度 0..1 划分:
     - 0.00 ~ 0.30  DISCOVERING  (Camera 寻找)
     - 0.30 ~ 0.50  RELEASING    (旧 hero 释放)
     - 0.50 ~ 0.80  INCOMING     (新 hero 浮现)
     - 0.80 ~ 1.00  LOCKED       (稳定停留)
   */
  function getBeatState(time, numPhotos){
    if(!sceneInitialized) initScene(numPhotos || 42);

    /* 找到当前 Beat */
    let currentBeatIdx = 0;
    let nextBeatIdx = BEATS.length;
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

    /* Beat 内部阶段 */
    let phase, phaseProgress;
    if(beatProgress < 0.30){
      phase = 'discovering';
      phaseProgress = beatProgress / 0.30;
    } else if(beatProgress < 0.50){
      phase = 'releasing';
      phaseProgress = (beatProgress - 0.30) / 0.20;
    } else if(beatProgress < 0.80){
      phase = 'incoming';
      phaseProgress = (beatProgress - 0.50) / 0.30;
    } else {
      phase = 'locked';
      phaseProgress = (beatProgress - 0.80) / 0.20;
    }

    /* Beat 切换时的 photo 切换:在 0.50 (RELEASING 末) 切换 heroIdx */
    // 用 beat.advanceKey 标记是否已切换
    if(!beat._advancedKey) beat._advancedKey = beat.t + '_advanced';
    if(!beat._advanced) beat._advanced = false;
    if(!beat._advanced && phaseProgress >= 0.5 && phase === 'releasing'){
      beat._advanced = true;
      // 切换 hero:旧的退到 FG_NEAR_LEFT,新的成为 hero
      const oldHeroIdx = scenePhotoIndices[0];
      const newHeroIdx = memoryPool.pickNextHero();
      const newScene = [newHeroIdx, oldHeroIdx];
      const remaining = scenePhotoIndices.slice(2);
      // 剩余 cards 洗牌(避免完全重复)
      const remainCopy = remaining.slice();
      for(let i = remainCopy.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        [remainCopy[i], remainCopy[j]] = [remainCopy[j], remainCopy[i]];
      }
      for(let i=0;i<7;i++) newScene.push(remainCopy[i] || memoryPool.pickNextHero());
      scenePhotoIndices = newScene;
      memoryPool.currentHero = newHeroIdx;
    }

    return {
      beat,
      beatProgress,
      phase,
      phaseProgress,
      heroIdx: scenePhotoIndices[0],
      scenePhotoIndices: scenePhotoIndices.slice(),
      nextBeatIdx,
      cameraDir: beat.cameraDir,
      reason: beat.reason,
    };
  }

  /* ===================== Composition ====================
     每个 Composition 决定:
       - Hero 的位置 (left/center/right)
       - 其他 cards 的位置 (在镜头中如何分布)
       - 整体 z depth (cards 离镜头多远)
   */
  const COMPOSITIONS = {
    /* 'centered': Hero 居中,supporting cards 在镜头外或远景 */
    centered: {
      hero:        { x: 50, y: 50, z: 0,    scale: 1.0,  rotZ: 0 },
      supports: {
        FG_LEFT:    { x: 18, y: 56, z: -380, scale: 0.42, rotZ: -6,  rotY: -18, opacity: 0.40 },
        FG_RIGHT:   { x: 82, y: 44, z: -380, scale: 0.42, rotZ: 7,   rotY: 16,  opacity: 0.40 },
        MG_LEFT:    { x: 8,  y: 30, z: -580, scale: 0.28, rotZ: -4,  rotY: -22, opacity: 0.18 },
        MG_RIGHT:   { x: 92, y: 70, z: -580, scale: 0.28, rotZ: 5,   rotY: 22,  opacity: 0.18 },
        BG_LEFT:    { x: 4,  y: 78, z: -780, scale: 0.16, rotZ: -3,  rotY: -28, opacity: 0.08 },
        BG_RIGHT:   { x: 96, y: 22, z: -780, scale: 0.16, rotZ: 4,   rotY: 26,  opacity: 0.08 },
        BG_TOP:     { x: 78, y: 8,  z: -780, scale: 0.18, rotZ: -2,  rotY: 0,   opacity: 0.10 },
        BG_BOTTOM:  { x: 22, y: 92, z: -780, scale: 0.18, rotZ: 2,   rotY: 0,   opacity: 0.10 },
      },
    },
    /* 'left-pan': Hero 在右侧,supporting 偏左 (镜头看向右) */
    'left-pan': {
      hero:        { x: 62, y: 50, z: 0,    scale: 0.96, rotZ: 1 },
      supports: {
        FG_LEFT:    { x: 28, y: 54, z: -340, scale: 0.45, rotZ: -8,  rotY: -14, opacity: 0.42 },
        FG_RIGHT:   { x: 78, y: 42, z: -440, scale: 0.32, rotZ: 4,   rotY: 12,  opacity: 0.28 },
        MG_LEFT:    { x: 14, y: 28, z: -560, scale: 0.30, rotZ: -10, rotY: -20, opacity: 0.20 },
        MG_RIGHT:   { x: 88, y: 66, z: -560, scale: 0.24, rotZ: 6,   rotY: 18,  opacity: 0.14 },
        BG_LEFT:    { x: 6,  y: 74, z: -780, scale: 0.16, rotZ: -5,  rotY: -25, opacity: 0.08 },
        BG_RIGHT:   { x: 94, y: 18, z: -780, scale: 0.16, rotZ: 3,   rotY: 22,  opacity: 0.08 },
        BG_TOP:     { x: 60, y: 6,  z: -780, scale: 0.18, rotZ: -1,  rotY: 0,   opacity: 0.10 },
        BG_BOTTOM:  { x: 32, y: 90, z: -780, scale: 0.16, rotZ: 2,   rotY: 0,   opacity: 0.08 },
      },
    },
    /* 'right-pan': Hero 在左侧 */
    'right-pan': {
      hero:        { x: 38, y: 50, z: 0,    scale: 0.96, rotZ: -1 },
      supports: {
        FG_LEFT:    { x: 22, y: 46, z: -440, scale: 0.32, rotZ: -4,  rotY: -12, opacity: 0.28 },
        FG_RIGHT:   { x: 72, y: 54, z: -340, scale: 0.45, rotZ: 8,   rotY: 14,  opacity: 0.42 },
        MG_LEFT:    { x: 12, y: 72, z: -560, scale: 0.24, rotZ: -6,  rotY: -18, opacity: 0.14 },
        MG_RIGHT:   { x: 86, y: 34, z: -560, scale: 0.30, rotZ: 10,  rotY: 20,  opacity: 0.20 },
        BG_LEFT:    { x: 6,  y: 26, z: -780, scale: 0.16, rotZ: -3,  rotY: -22, opacity: 0.08 },
        BG_RIGHT:   { x: 94, y: 82, z: -780, scale: 0.16, rotZ: 5,   rotY: 25,  opacity: 0.08 },
        BG_TOP:     { x: 40, y: 6,  z: -780, scale: 0.18, rotZ: 1,   rotY: 0,   opacity: 0.10 },
        BG_BOTTOM:  { x: 68, y: 90, z: -780, scale: 0.16, rotZ: -2,  rotY: 0,   opacity: 0.08 },
      },
    },
    /* 'up-pan': Hero 在下方,镜头略微俯视 */
    'up-pan': {
      hero:        { x: 50, y: 60, z: 0,    scale: 0.96, rotZ: 0 },
      supports: {
        FG_LEFT:    { x: 24, y: 30, z: -340, scale: 0.42, rotZ: -8,  rotY: -16, opacity: 0.40 },
        FG_RIGHT:   { x: 76, y: 22, z: -340, scale: 0.42, rotZ: 8,   rotY: 16,  opacity: 0.40 },
        MG_LEFT:    { x: 10, y: 70, z: -540, scale: 0.28, rotZ: -6,  rotY: -20, opacity: 0.18 },
        MG_RIGHT:   { x: 90, y: 76, z: -540, scale: 0.28, rotZ: 6,   rotY: 20,  opacity: 0.18 },
        BG_LEFT:    { x: 4,  y: 12, z: -780, scale: 0.16, rotZ: -3,  rotY: -25, opacity: 0.08 },
        BG_RIGHT:   { x: 96, y: 6,  z: -780, scale: 0.16, rotZ: 4,   rotY: 25,  opacity: 0.08 },
        BG_TOP:     { x: 50, y: 4,  z: -780, scale: 0.20, rotZ: 0,   rotY: 0,   opacity: 0.10 },
        BG_BOTTOM:  { x: 50, y: 92, z: -780, scale: 0.18, rotZ: 0,   rotY: 0,   opacity: 0.10 },
      },
    },
    /* 'down-pan': Hero 在上方 */
    'down-pan': {
      hero:        { x: 50, y: 40, z: 0,    scale: 0.96, rotZ: 0 },
      supports: {
        FG_LEFT:    { x: 24, y: 74, z: -340, scale: 0.42, rotZ: -8,  rotY: -16, opacity: 0.40 },
        FG_RIGHT:   { x: 76, y: 70, z: -340, scale: 0.42, rotZ: 8,   rotY: 16,  opacity: 0.40 },
        MG_LEFT:    { x: 10, y: 18, z: -540, scale: 0.28, rotZ: -6,  rotY: -20, opacity: 0.18 },
        MG_RIGHT:   { x: 90, y: 12, z: -540, scale: 0.28, rotZ: 6,   rotY: 20,  opacity: 0.18 },
        BG_LEFT:    { x: 4,  y: 90, z: -780, scale: 0.16, rotZ: -3,  rotY: -25, opacity: 0.08 },
        BG_RIGHT:   { x: 96, y: 96, z: -780, scale: 0.16, rotZ: 4,   rotY: 25,  opacity: 0.08 },
        BG_TOP:     { x: 50, y: 92, z: -780, scale: 0.18, rotZ: 0,   rotY: 0,   opacity: 0.10 },
        BG_BOTTOM:  { x: 50, y: 4,  z: -780, scale: 0.20, rotZ: 0,   rotY: 0,   opacity: 0.10 },
      },
    },
    /* 'pulled-back': Hero 缩小,周围 cards 拉远 (Bridge 阶段) */
    'pulled-back': {
      hero:        { x: 50, y: 50, z: 0,    scale: 0.78, rotZ: 0 },
      supports: {
        FG_LEFT:    { x: 18, y: 60, z: -560, scale: 0.30, rotZ: -8,  rotY: -18, opacity: 0.28 },
        FG_RIGHT:   { x: 82, y: 40, z: -560, scale: 0.30, rotZ: 8,   rotY: 18,  opacity: 0.28 },
        MG_LEFT:    { x: 6,  y: 24, z: -700, scale: 0.22, rotZ: -5,  rotY: -22, opacity: 0.14 },
        MG_RIGHT:   { x: 94, y: 76, z: -700, scale: 0.22, rotZ: 5,   rotY: 22,  opacity: 0.14 },
        BG_LEFT:    { x: 2,  y: 84, z: -880, scale: 0.14, rotZ: -3,  rotY: -28, opacity: 0.06 },
        BG_RIGHT:   { x: 98, y: 16, z: -880, scale: 0.14, rotZ: 3,   rotY: 28,  opacity: 0.06 },
        BG_TOP:     { x: 76, y: 4,  z: -880, scale: 0.16, rotZ: -1,  rotY: 0,   opacity: 0.08 },
        BG_BOTTOM:  { x: 24, y: 96, z: -880, scale: 0.16, rotZ: 1,   rotY: 0,   opacity: 0.08 },
      },
    },
    /* 'isolation': 只有 Hero,supporting 全部 opacity 0 */
    'isolation': {
      hero:        { x: 50, y: 50, z: 0,    scale: 1.05, rotZ: 0 },
      supports: {
        FG_LEFT:    { opacity: 0 },
        FG_RIGHT:   { opacity: 0 },
        MG_LEFT:    { opacity: 0 },
        MG_RIGHT:   { opacity: 0 },
        BG_LEFT:    { opacity: 0 },
        BG_RIGHT:   { opacity: 0 },
        BG_TOP:     { opacity: 0 },
        BG_BOTTOM:  { opacity: 0 },
      },
    },
    /* 'chorus': Hero 大,supporting 卡片环绕 */
    'chorus': {
      hero:        { x: 50, y: 50, z: 0,    scale: 1.02, rotZ: 0 },
      supports: {
        FG_LEFT:    { x: 22, y: 60, z: -260, scale: 0.58, rotZ: -8,  rotY: -16, opacity: 0.55 },
        FG_RIGHT:   { x: 78, y: 40, z: -260, scale: 0.58, rotZ: 8,   rotY: 16,  opacity: 0.55 },
        MG_LEFT:    { x: 8,  y: 28, z: -480, scale: 0.36, rotZ: -6,  rotY: -22, opacity: 0.24 },
        MG_RIGHT:   { x: 92, y: 72, z: -480, scale: 0.36, rotZ: 6,   rotY: 22,  opacity: 0.24 },
        BG_LEFT:    { x: 2,  y: 80, z: -700, scale: 0.20, rotZ: -3,  rotY: -28, opacity: 0.10 },
        BG_RIGHT:   { x: 98, y: 20, z: -700, scale: 0.20, rotZ: 3,   rotY: 28,  opacity: 0.10 },
        BG_TOP:     { x: 60, y: 6,  z: -700, scale: 0.22, rotZ: -1,  rotY: 0,   opacity: 0.12 },
        BG_BOTTOM:  { x: 40, y: 94, z: -700, scale: 0.22, rotZ: 1,   rotY: 0,   opacity: 0.12 },
      },
    },
  };

  /* Beat type → 起始/结束 composition
     每个 Beat 在 LOCKED 阶段用 'centered' 或当前 composition
     在 DISCOVERING 阶段用 transition composition (镜头移动)
   */
  function getCompositionForBeat(beatType, cameraDir, phase){
    // DISCOVERING 阶段: 镜头在移动,composition 反映移动方向
    if(phase === 'discovering'){
      switch(cameraDir){
        case 'right': return COMPOSITIONS['left-pan'];
        case 'left':  return COMPOSITIONS['right-pan'];
        case 'up':    return COMPOSITIONS['down-pan'];
        case 'down':  return COMPOSITIONS['up-pan'];
        case 'in':    return COMPOSITIONS['chorus'];
        case 'pull':  return COMPOSITIONS['pulled-back'];
      }
    }
    // LOCKED 阶段: 上一拍的 composition 已经稳定,新 hero 居于画面中央
    if(phase === 'locked' || phase === 'incoming'){
      switch(beatType){
        case 'isolation': return COMPOSITIONS['isolation'];
        case 'chorus-reveal': return COMPOSITIONS['chorus'];
        case 'pulled-back': return COMPOSITIONS['pulled-back'];
        default: return COMPOSITIONS['centered'];
      }
    }
    // RELEASING 阶段:composition 正在过渡 (使用入场方向)
    return COMPOSITIONS['centered'];
  }

  /* ===================== Camera Shots ====================
     每个 Beat 的 Camera 位置:
       - DISCOVERING: camera 移动 (pan/zoom/寻找)
       - LOCKED: camera 静止
       - RELEASING: camera 拉远
       - INCOMING: camera 推近
   */
  function getCameraState(beat, phase, phaseProgress){
    const cam = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, scale: 1 };
    const ease = smoothstep(phaseProgress);

    switch(phase){
      case 'discovering': {
        // Camera 寻找:基于 cameraDir 方向做 pan + slight zoom
        const dir = beat.cameraDir;
        const panAmount = 80;  // px
        if(dir === 'right'){ cam.x = -ease * panAmount; cam.rotY = ease * 1.5; }
        else if(dir === 'left'){ cam.x = ease * panAmount; cam.rotY = -ease * 1.5; }
        else if(dir === 'up'){ cam.y = ease * panAmount; cam.rotX = -ease * 1.0; }
        else if(dir === 'down'){ cam.y = -ease * panAmount; cam.rotX = ease * 1.0; }
        else if(dir === 'in'){ cam.z = -ease * 100; cam.scale = 1 + ease * 0.04; }
        else if(dir === 'pull'){ cam.z = ease * 80; cam.scale = 1 - ease * 0.06; }
        return cam;
      }
      case 'releasing': {
        // 旧 hero 退场:相机 pull back
        cam.z = ease * 120;
        cam.scale = 1 - ease * 0.10;
        return cam;
      }
      case 'incoming': {
        // 新 hero 浮现:相机 push in
        const k = 1 - ease;
        cam.z = k * 100;
        cam.scale = 1 + ease * 0.04;
        return cam;
      }
      case 'locked':
      default:
        // 静止,只有极轻微 breathing
        return cam;
    }
  }

  /* ===================== Hero Motion ====================
     Hero card 在 Beat 内的运动:
       - LOCKED: hero 静止
       - DISCOVERING: hero 还在原位(等待相机找到下一个)
       - RELEASING: hero 缩退 (scale ↓, opacity ↓)
       - INCOMING: 新 hero 出现 (scale ↑, opacity ↑)
   */
  function getHeroMotion(phase, phaseProgress){
    if(phase === 'releasing'){
      // 旧 hero 退场:缩小 + 模糊
      const k = smoothstep(phaseProgress);
      return {
        scaleMul: 1 - k * 0.4,
        opacityMul: 1 - k * 0.6,
        blurMul: k * 2.0,
        rotZ: -k * 6,
        rotY: k * 12,
      };
    }
    if(phase === 'incoming'){
      // 新 hero 浮现:从模糊变清晰,scale 微增
      const k = smoothstep(phaseProgress);
      const easeOut = 1 - Math.pow(1 - k, 3);
      return {
        scaleMul: 0.7 + easeOut * 0.32,
        opacityMul: k,
        blurMul: (1 - k) * 1.5,
        rotZ: 0,
        rotY: 0,
      };
    }
    if(phase === 'discovering'){
      // 微妙的"等待"感觉:hero scale 微减
      const k = phaseProgress;
      return {
        scaleMul: 1 - k * 0.04,
        opacityMul: 1 - k * 0.06,
        blurMul: 0,
        rotZ: 0,
        rotY: 0,
      };
    }
    // LOCKED: hero 静止
    return { scaleMul: 1, opacityMul: 1, blurMul: 0, rotZ: 0, rotY: 0 };
  }

  /* ===================== Public API ==================== */
  window.HeroDirector = {
    SCENE_SEED,
    BEATS,
    COMPOSITIONS,
    initScene,
    getBeatState,
    getCompositionForBeat,
    getCameraState,
    getHeroMotion,
  };
})();