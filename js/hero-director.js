/* ==================== Hero Director V7 ====================
   Memory Card Stage Rotation System。

   核心职责:
     1. MemoryPool — 管理所有 photoIdx 的 lifecycle (active history / recycle pool)
     2. HeroDirector — 决定哪个 photoIdx 是 Hero / Foreground / Midground / Background
     3. Hero Rotation Presets — 12 种 Hero 入场方式(depth-promote / left-promote /
        right-promote / diagonal-promote / foreground-promote / camera-pass-promote /
        occlusion-promote / flip-promote / perspective-promote / cross-promote /
        scale-match-promote / direction-match-promote)
     4. Stage Recomposition — Hero 切换后整个舞台重新分配
     5. Next Hero Preview — 提前让下一张卡片在 BG 出现(opacity 0.2-0.4)
     6. Rotation Schedule — 基于 audioTime + seed + phase 的轮换时间表

   集成:
     - MotionDirector(tick) 调用 HeroDirector.getSceneState(time)
     - 返回 { photoIdxForCard: [...], rotation: {currentHero, nextHero, progress, preset}, cameraTone }
     - 然后 tick() 根据 photoIdxForCard 决定每张 DOM card 显示哪张照片
     - Preset 决定 hero 卡片如何 transform

   Determinism:
     - 同一个 audioTime 永远得到同一个 photoIdxForCard 状态
     - rotation schedule 由 seeded RNG 预生成
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

  /* ===================== MemoryPool ====================
     管理所有可用 photoIdx,避免连续重复。
     状态:
       - history: 最近 5 个 photoIdx(避免连续重复)
       - allIndices: 0..(NUM_PHOTOS-1) 的全部可选项(动态由调用方提供)
       - shuffled: 当前尚未使用过的随机顺序队列
   */
  function makeMemoryPool(totalPhotos){
    const pool = {
      total: totalPhotos,
      history: [],          // 最近使用顺序
      usedInWindow: new Set(),
      shuffled: [],
    };
    const rng = mulberry32(SCENE_SEED ^ 0xC0DECAFE);
    pool.reshuffle = function(){
      const arr = [];
      for(let i=0;i<this.total;i++) arr.push(i);
      // Fisher-Yates with seeded rng
      for(let i = arr.length - 1; i > 0; i--){
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      this.shuffled = arr;
      this.usedInWindow.clear();
    };
    pool.nextEligible = function(){
      // 返回下一个 candidate (shuffled 队首) 同时记录到 history
      if(this.shuffled.length === 0) this.reshuffle();
      const idx = this.shuffled.pop();
      this.history.push(idx);
      if(this.history.length > 5){
        const dropped = this.history.shift();
        this.usedInWindow.delete(dropped);
      }
      this.usedInWindow.add(idx);
      return idx;
    };
    pool.canAvoid = function(candidate){
      // 返回 true 如果 candidate 不在 usedInWindow(可以选)
      return !this.usedInWindow.has(candidate);
    };
    pool.reshuffle();
    return pool;
  }

  /* ===================== Stage Layout ====================
     每张 card DOM slot 在当前 stage 的目标 (x, y, z, scale, ...)。
     一张 photoIdx 占据哪个 slot 由 HeroDirector 决定。

     9 个 slot 的固定 layout(不随 hero rotation 改变):
       slot 0: HERO       (z=0, scale=1, opacity=1)
       slot 1: FG_LEFT    (z=200, scale=0.95, opacity=0.85, x偏左)
       slot 2: FG_RIGHT   (z=200, scale=0.95, opacity=0.85, x偏右)
       slot 3: MG_L      (z=-80, scale=0.88, opacity=0.65)
       slot 4: MG_R      (z=-80, scale=0.88, opacity=0.65)
       slot 5: MG_FAR_L  (z=-220, scale=0.74, opacity=0.45)
       slot 6: MG_FAR_R  (z=-220, scale=0.74, opacity=0.45)
       slot 7: BG_L      (z=-450, scale=0.55, opacity=0.25)
       slot 8: BG_R      (z=-450, scale=0.55, opacity=0.25)
  */
  const SLOTS = [
    { name:'HERO',       x:50,  y:50,  z:0,    scale:1.00, blur:0,   opacity:1.00 },
    { name:'FG_LEFT',    x:30,  y:42,  z:200,  scale:0.95, blur:0,   opacity:0.85 },
    { name:'FG_RIGHT',   x:70,  y:58,  z:200,  scale:0.95, blur:0,   opacity:0.85 },
    { name:'MG_L',       x:22,  y:48,  z:-80,  scale:0.88, blur:0.2, opacity:0.65 },
    { name:'MG_R',       x:78,  y:52,  z:-80,  scale:0.88, blur:0.2, opacity:0.65 },
    { name:'MG_FAR_L',  x:12,  y:40,  z:-220, scale:0.74, blur:0.6, opacity:0.45 },
    { name:'MG_FAR_R',  x:88,  y:60,  z:-220, scale:0.74, blur:0.6, opacity:0.45 },
    { name:'BG_L',      x:6,   y:30,  z:-450, scale:0.55, blur:1.2, opacity:0.25 },
    { name:'BG_R',      x:94,  y:70,  z:-450, scale:0.55, blur:1.2, opacity:0.25 },
  ];

  /* ===================== Hero Rotation Presets ====================
     每个 preset 定义一张 card 从某个 slot 到 HERO slot 的轨迹。
     调用:preset.fromSlot(idx, t) → {dx, dy, dz, scale, rotZ, ...} (0..1)
     duration 决定整个 motion 的长度(由 caller 决定)。

     12 种 preset:
       depth-promote        从 BG 深处推进
       left-promote         从左侧滑入
       right-promote        从右侧滑入
       diagonal-promote     对角线
       foreground-promote   从前景遮挡后出现
       camera-pass-promote  先掠过镜头前,再回到中心
       occlusion-promote    被前景卡遮挡后出现
       flip-promote         3D 翻转入场
       perspective-promote  perspective sweep
       cross-promote        从对侧穿越
       scale-match-promote  scale 匹配过渡
       direction-match-promote  direction match
  */
  const PRESETS = {
    'depth-promote': (p) => ({
      dx: lerp(8, 0, p),          // 起点轻微偏右
      dy: lerp(-4, 0, p),
      dz: lerp(-700, 60, p, 0, 1),  // z -700 → +60 → 0
      dz2: lerp(60, 0, p),          // overshoot 到 +60 后回 0
      scale: lerp(0.72, 1.04, p) * lerp(1.04, 1, clamp(p > 0.7 ? (p-0.7)/0.3 : 0, 0, 1)),
      rotZ: lerp(8, 0, p),
      blur: lerp(6, 0, p),
      opacity: lerp(0.2, 1, p),
    }),
    'left-promote': (p) => ({
      dx: lerp(-120, 0, p),       // -120vw → 0
      dy: lerp(8, 0, p),
      dz: lerp(-150, 0, p),
      scale: lerp(0.82, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: lerp(-8, 0, p),
      blur: lerp(3, 0, p),
      opacity: lerp(0.3, 1, p),
    }),
    'right-promote': (p) => ({
      dx: lerp(120, 0, p),
      dy: lerp(-8, 0, p),
      dz: lerp(-150, 0, p),
      scale: lerp(0.82, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: lerp(8, 0, p),
      blur: lerp(3, 0, p),
      opacity: lerp(0.3, 1, p),
    }),
    'diagonal-promote': (p) => ({
      dx: lerp(70, 0, p),
      dy: lerp(-50, 0, p),
      dz: lerp(-200, 0, p),
      scale: lerp(0.78, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: lerp(12, 0, p),
      rotY: lerp(-15, 0, p),
      blur: lerp(4, 0, p),
      opacity: lerp(0.25, 1, p),
    }),
    'foreground-promote': (p) => ({
      // 假装从前景遮挡后出现: z +200 → -100 → 0
      dx: lerp(-15, 0, p),
      dy: 0,
      dz: lerp(200, -100, p) + lerp(100, 0, p > 0.5 ? (p-0.5)/0.5 : 0),
      scale: lerp(1.5, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: lerp(-5, 0, p),
      blur: lerp(2, 0, p),
      opacity: lerp(0.5, 1, p),
    }),
    'camera-pass-promote': (p) => {
      // 0..0.5 掠过镜头前 (z=+400), 0.5..1 回到中心
      const k = Math.sin(p * Math.PI);
      const early = lerp(-150, 0, p);  // 左 → 中心
      return {
        dx: early,
        dy: lerp(0, -10, k),
        dz: 400 * k - 100 * (1 - p),
        scale: lerp(0.6, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
        rotZ: lerp(8, 0, p),
        blur: -1 * k,  // 前景不模糊
        opacity: lerp(0.4, 1, p),
      };
    },
    'occlusion-promote': (p) => {
      // 模拟被前景卡片遮挡:opacity 突然归零再恢复
      const occ = p < 0.3 ? (p / 0.3) : (p < 0.5 ? 0 : (p - 0.5) / 0.5);
      return {
        dx: lerp(20, 0, p),
        dy: lerp(-10, 0, p),
        dz: lerp(-150, 0, p),
        scale: lerp(0.85, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
        rotZ: lerp(-6, 0, p),
        blur: lerp(3, 0, p),
        opacity: occ,
      };
    },
    'flip-promote': (p) => {
      // 3D 翻转 rotateY -90 → 0
      const rotY = lerp(-90, 0, p);
      return {
        dx: 0,
        dy: 0,
        dz: lerp(-100, 0, p),
        scale: lerp(0.9, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
        rotZ: 0,
        rotY,
        blur: lerp(2, 0, p),
        opacity: lerp(0.5, 1, p),
      };
    },
    'perspective-promote': (p) => ({
      // Perspective Sweep: rotateY 大角度 → 0
      dx: lerp(-30, 0, p),
      dy: 0,
      dz: lerp(-250, 0, p),
      scale: lerp(0.7, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: 0,
      rotY: lerp(-30, 0, p),
      blur: lerp(5, 0, p),
      opacity: lerp(0.3, 1, p),
    }),
    'cross-promote': (p) => ({
      // 从对侧穿越 (从右后到左前)
      dx: lerp(120, -60, p) + lerp(60, 0, p > 0.6 ? (p-0.6)/0.4 : 0),
      dy: 0,
      dz: lerp(-100, 200, p) + lerp(200, 0, p > 0.7 ? (p-0.7)/0.3 : 0),
      scale: lerp(0.75, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: lerp(15, 0, p),
      blur: lerp(3, 0, p),
      opacity: lerp(0.3, 1, p),
    }),
    'scale-match-promote': (p) => ({
      // 当前 hero scale 1.05 → 新 hero scale 0.95 → 1
      dx: 0,
      dy: 0,
      dz: lerp(-50, 30, p) + lerp(30, 0, p > 0.7 ? (p-0.7)/0.3 : 0),
      scale: lerp(1.05, 0.92, p) * lerp(0.92, 1.04, p > 0.5 ? (p-0.5)/0.5 : 0) * lerp(1.04, 1, p > 0.85 ? (p-0.85)/0.15 : 0),
      rotZ: 0,
      blur: lerp(2, 0, p),
      opacity: lerp(0.4, 1, p),
    }),
    'direction-match-promote': (p) => ({
      // 方向匹配:旧 hero 向左退出 → 新 hero 从左侧进入
      dx: lerp(-80, 0, p),
      dy: 0,
      dz: lerp(-50, 0, p),
      scale: lerp(0.85, 1.04, p) * lerp(1.04, 1, p > 0.7 ? (p-0.7)/0.3 : 0),
      rotZ: lerp(-10, 0, p),
      blur: lerp(2, 0, p),
      opacity: lerp(0.4, 1, p),
    }),
  };

  /* ===================== Hero Rotation Schedule ====================
     基于 seeded RNG + phase density 预生成 rotation 时刻表:
       INTRO:  第一个 hero 在 t=2s 出现
       VERSE:  每 5-10 秒一次
       CHORUS: 每 3-7 秒一次
       BRIDGE: 每 9-11 秒一次
       OUTRO:  几乎停止

     每个 rotation:
       { t, preset, heroPhotoIdx, slotAssignments: {slot: photoIdx} }
  */
  const PRESET_SEQUENCE = [
    'depth-promote', 'left-promote', 'right-promote', 'diagonal-promote',
    'foreground-promote', 'camera-pass-promote', 'occlusion-promote',
    'flip-promote', 'perspective-promote', 'cross-promote',
    'scale-match-promote', 'direction-match-promote',
  ];

  /* 不可用 seed:RECENTLY_USED 来防止同一个 preset 连续 */
  const recentPresets = [];
  function pickPreset(rng){
    let tries = 0;
    while(tries < 10){
      const idx = Math.floor(rng() * PRESET_SEQUENCE.length);
      const p = PRESET_SEQUENCE[idx];
      if(!recentPresets.includes(p) || recentPresets.filter(x => x === p).length < 2){
        recentPresets.push(p);
        if(recentPresets.length > 5) recentPresets.shift();
        return p;
      }
      tries++;
    }
    const fallback = PRESET_SEQUENCE[Math.floor(rng() * PRESET_SEQUENCE.length)];
    recentPresets.push(fallback);
    if(recentPresets.length > 5) recentPresets.shift();
    return fallback;
  }

  /* Phase density for rotation frequency */
  function rotationGapRange(phaseName){
    switch(phaseName){
      case 'INTRO':   return [3.0, 4.0];
      case 'VERSE1':  return [5.5, 8.5];
      case 'VERSE2':  return [5.0, 9.0];
      case 'CHORUS1': return [3.5, 5.5];
      case 'VERSE3':  return [6.0, 8.0];
      case 'CHORUS2': return [3.0, 4.5];
      case 'BRIDGE':  return [9.0, 13.0];
      case 'CHORUS3': return [3.5, 5.0];
      case 'OUTRO':   return [120, 180];  // 基本不再换
      default: return [5.0, 8.0];
    }
  }

  /* 找当前 time 所在的 phase — 复用 MotionScheduler.PHASE_TABLE */
  function getPhaseForTime(time, phases){
    if(!phases || phases.length === 0) return null;
    for(let i=phases.length-1; i>=0; i--){
      if(time >= phases[i].start) return phases[i];
    }
    return phases[0];
  }

  /* ===================== Build Rotation Timeline ====================
     预生成完整的 rotation timeline(基于 seed + phase 顺序)。
     这是 Memory Pool + Preset 选择 + Slot 重新分配的整体规划。
  */
  const ROTATION_TIMELINE = [];
  function buildRotationTimeline(totalPhotos){
    const phases = (window.MotionScheduler && window.MotionScheduler.PHASE_TABLE) || [];
    if(phases.length === 0) return;
    const rng = mulberry32(SCENE_SEED ^ 0xC4FEC0DE);
    const pool = makeMemoryPool(totalPhotos);
    let t = 1.5;  // 第一个 hero rotation 在 t=1.5s(INTRO 段)
    // 当前 hero 是 photoIdx 0, slot 0
    let currentHeroIdx = 0;
    // 初始 stage 分配: hero = idx 0, FG/MG/BG = 后续几个
    let slotPhotoIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    // 记录初始状态(不作为 rotation,但存储初始 photoIdx)
    ROTATION_TIMELINE.push({
      t: 0,
      type: 'init',
      heroPhotoIdx: 0,
      slotPhotoIdx: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      preset: null,
    });
    pool.history.push(0);
    pool.usedInWindow.add(0);
    while(t < 259){
      const phase = getPhaseForTime(t, phases);
      const [gapMin, gapMax] = rotationGapRange(phase.name);
      const gap = gapMin + rng() * (gapMax - gapMin);
      t += gap;
      if(t >= 259) break;
      // 选 preset
      const preset = pickPreset(rng);
      // 从 pool 选下一个 hero photoIdx(避免最近 5 张)
      const nextHeroIdx = pool.nextEligible();
      // 当前 hero 退到某个 slot(优先 FG 或 MG)
      // 选择下一个 nextHero preview(让观众潜意识看到下一张记忆正在靠近)
      const prevPhotoIdx = pool.nextEligible();
      // 重组 slot assignments:
      //   slot 0 (HERO)  = nextHeroIdx
      //   slot 1 (FG_L)  = currentHeroIdx (当前 hero 退到这里)
      //   slot 2 (FG_R)  = prevPhotoIdx
      //   slot 3..8      = pool 中剩余的不同 photoIdx
      const remaining = [];
      for(let i=0;i<totalPhotos;i++){
        if(i !== nextHeroIdx && i !== currentHeroIdx && i !== prevPhotoIdx){
          remaining.push(i);
        }
      }
      const slotPhotoIdxNew = [
        nextHeroIdx,           // HERO
        currentHeroIdx,        // FG_LEFT (旧 hero)
        prevPhotoIdx,          // FG_RIGHT (preview)
        remaining[0], remaining[1],
        remaining[2], remaining[3],
        remaining[4], remaining[5],
      ];
      ROTATION_TIMELINE.push({
        t,
        type: 'rotate',
        preset,
        heroPhotoIdx: nextHeroIdx,
        outgoingHeroIdx: currentHeroIdx,
        previewIdx: prevPhotoIdx,
        slotPhotoIdx: slotPhotoIdxNew,
      });
      currentHeroIdx = nextHeroIdx;
    }
  }

  /* 立即用默认 42 张初始化(会被 memories.js 加载完后用真实 NUM_PHOTOS 重建) */
  buildRotationTimeline(42);

  /* ===================== Rebuild ====================
     让外部调用者(NUM_PHOTOS 准备好后)重建 timeline */
  function rebuildRotationTimeline(totalPhotos){
    ROTATION_TIMELINE.length = 0;
    recentPresets.length = 0;
    buildRotationTimeline(totalPhotos);
  }

  /* ===================== getSceneState ====================
     根据 audioTime 计算当前 Scene State:
       - heroPhotoIdx          (主视觉)
       - slotPhotoIdx[9]       (每个 DOM slot 当前显示哪张照片)
       - rotation              (进行中的 rotation:{progress, preset, fromIdx, toIdx, previewIdx})
       - nextRotation          (下一次 rotation 信息,用于 preview)
       - cameraTone            (建议的 Camera 状态,例如 push/pull/drift)
   */
  function findActiveRotation(time){
    // 二分/线性搜索:找最后一条 t <= time 的 rotation
    let active = null;
    let nextIdx = -1;
    for(let i=0;i<ROTATION_TIMELINE.length;i++){
      const item = ROTATION_TIMELINE[i];
      if(item.type === 'rotate'){
        if(item.t <= time){
          active = item;
        } else if(nextIdx === -1){
          nextIdx = i;
          break;
        }
      }
    }
    return { active, nextIdx };
  }

  const ROTATION_DURATION = 2200;  // ms,一个 rotation 的总长

  function getSceneState(time){
    if(ROTATION_TIMELINE.length === 0){
      return {
        heroPhotoIdx: 0,
        slotPhotoIdx: [0,1,2,3,4,5,6,7,8],
        rotation: { progress: 0, preset: null, active: false },
        nextRotation: null,
        cameraTone: 'drift',
      };
    }
    const { active, nextIdx } = findActiveRotation(time);
    // 找到当前正在进行的 rotation(可能 progress < 1)
    let currentIdx = 0;
    for(let i=0;i<ROTATION_TIMELINE.length;i++){
      if(ROTATION_TIMELINE[i].t <= time) currentIdx = i;
    }
    const current = ROTATION_TIMELINE[currentIdx];
    // 寻找下一次 rotation
    let nextRot = null;
    for(let i=currentIdx+1;i<ROTATION_TIMELINE.length;i++){
      if(ROTATION_TIMELINE[i].type === 'rotate'){ nextRot = ROTATION_TIMELINE[i]; break; }
    }
    // 当前 rotation progress
    let rotation = { progress: 0, preset: null, active: false, fromIdx: current.heroPhotoIdx, toIdx: current.heroPhotoIdx, outgoingIdx: null, previewIdx: null };
    if(active && active.type === 'rotate'){
      const dur = ROTATION_DURATION / 1000;
      const elapsed = time - active.t;
      const progress = clamp(elapsed / dur, 0, 1);
      // 找前一条 rotation 的 heroPhotoIdx 作为 outgoing
      const prevRot = (currentIdx > 0) ? ROTATION_TIMELINE[currentIdx - 1] : null;
      rotation = {
        progress,
        preset: active.preset,
        active: true,
        fromIdx: prevRot ? prevRot.heroPhotoIdx : active.outgoingHeroIdx,
        toIdx: active.heroPhotoIdx,
        outgoingIdx: active.outgoingHeroIdx,
        previewIdx: active.previewIdx,
      };
    }
    // Next rotation preview (用于让下一张照片提前在 BG 出现)
    let nextRotation = null;
    if(nextRot){
      const previewTime = Math.max(nextRot.t - 3.0, 0);  // 提前 3 秒开始 preview
      const previewProgress = clamp((time - previewTime) / 3.0, 0, 1);
      nextRotation = {
        progress: previewProgress,
        heroPhotoIdx: nextRot.heroPhotoIdx,
        previewSlotIdx: 7,  // BG slot
        t: nextRot.t,
      };
    }
    // CameraTone:基于 phase(简化)
    let cameraTone = 'drift';
    if(active) cameraTone = 'push';
    return {
      heroPhotoIdx: current.heroPhotoIdx,
      slotPhotoIdx: current.slotPhotoIdx.slice(),
      rotation,
      nextRotation,
      cameraTone,
    };
  }

  /* ===================== getSlotMotionForRotation ====================
     给定 rotation progress + preset,计算:
       - heroToHero: 下一张 hero (slot 0) 的 motion offset
       - oldHeroRetreat: 退场 hero (在 FG) 的 motion offset
       - previewMotion: BG preview card 的 motion offset
     返回值用于 tick() 叠加到对应 DOM card 的 transform 上。
   */
  function getSlotMotionForRotation(rotation, slotIdx, slotName, totalTime){
    if(!rotation || !rotation.active) return null;
    const p = rotation.progress;
    const preset = rotation.preset;
    if(!PRESETS[preset]) return null;
    const motion = PRESETS[preset](p);

    // 决定这张 slot 的角色:
    //   - slotIdx === 0 (HERO)  → 新 hero,接收 motion
    //   - slotName === 'FG_LEFT' → 退场 hero,retreat motion
    //   - slotName === 'BG_L' or 'BG_R' → preview,等待下一张
    const offset = { dx:0, dy:0, dz:0, dscale:0, drotZ:0, drotY:0, dopacity:0, dblur:0 };
    if(slotIdx === 0){
      // 新 hero 接收 preset motion
      offset.dx = motion.dx || 0;
      offset.dy = motion.dy || 0;
      offset.dz = motion.dz || 0;
      offset.dscale = (motion.scale || 1) - 1;
      offset.drotZ = motion.rotZ || 0;
      offset.drotY = motion.rotY || 0;
      offset.dopacity = (motion.opacity || 1) - 1;
      offset.dblur = motion.blur || 0;
    } else if(slotName === 'FG_LEFT' && rotation.fromIdx !== null && rotation.fromIdx !== rotation.toIdx){
      // 退场 hero: scale 1 → 0.9, Z 0 → -250, rotateZ 0 → -10
      offset.dx = lerp(0, -25, p);
      offset.dy = 0;
      offset.dz = lerp(0, -200, p);
      offset.dscale = lerp(0, -0.15, p);
      offset.drotZ = lerp(0, -8, p);
      offset.dopacity = lerp(0, -0.20, p);  // opacity 1 → 0.80
      offset.dblur = lerp(0, 1.5, p);
    } else if((slotName === 'BG_L' || slotName === 'BG_R') && rotation.previewIdx !== null){
      // 下一张 preview card 在 BG 位置 — opacity 微变,但 photoIdx 由 SceneState 决定
      // 这里不修改 offset,因为 SceneState 已经把 previewIdx 分配到某个 BG slot
    }
    return offset;
  }

  /* ===================== Public API ==================== */
  window.HeroDirector = {
    SCENE_SEED,
    SLOTS,
    PRESETS,
    ROTATION_TIMELINE,
    ROTATION_DURATION,
    rebuildRotationTimeline,
    getSceneState,
    getSlotMotionForRotation,
  };
})();