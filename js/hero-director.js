/* ==================== Hero Director V8 ====================
   Memory Cinema — Memory Handoff System

   核心职责:
     1. Memory Pool — 管理 photoIdx,每次 Handoff 后重新洗牌
     2. Hero Lifecycle — currentHero / incomingHero / outgoingHero
        每次 Handoff 都有完整的 4 阶段:
          a) DISCOVERY  (0~25%)  新 hero 在 BG 浮现,旧 hero 失焦
          b) APPROACH   (25~60%) 新 hero 从 BG 推进,旧 hero 退到 FG_LEFT
          c) CROSS      (60~85%) 新 hero 经过镜头前/越过旧 hero 位置
          d) SETTLE     (85~100%)新 hero 落位,旧 hero 退入 BG,Stage 重排
     3. Stage Recomposition — Handoff 完成后,所有配角重新洗到新 slot
     4. Handoff Schedule — 由 LYRIC_CUES 触发,与音乐情绪绑定
     5. Camera Tone — 每个 Handoff 携带 camera 倾向(push/pull/dolly)

   Determinism:
     - photo 池预洗牌(seeded)
     - Handoff 时间表硬编码到 lyric cues,确保 seek 重建一致
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

  /* ===================== Memory Pool ====================
     状态:
       - shuffled: 尚未被分配为 Hero 的 photoIdx 队列
       - usedHistory: 最近 6 个 Hero,保证不连续重复
       - retiredSet: 当前正在场景中的 photoIdx(避免选择它们做新 hero)
   */
  function makeMemoryPool(total){
    const rng = mulberry32(SCENE_SEED ^ 0xC0DECAFE);
    const pool = {
      total,
      shuffled: [],
      usedHistory: [],
      currentScene: new Set(),
      reshuffle(excludeSet){
        const arr = [];
        for(let i=0;i<total;i++){
          if(!excludeSet || !excludeSet.has(i)) arr.push(i);
        }
        for(let i = arr.length - 1; i > 0; i--){
          const j = Math.floor(rng() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        this.shuffled = arr;
      },
      pickNextHero(excludeSet){
        if(!excludeSet) excludeSet = this.currentScene;
        if(this.shuffled.length === 0) this.reshuffle(excludeSet);
        const idx = this.shuffled.pop();
        this.usedHistory.push(idx);
        if(this.usedHistory.length > 6) this.usedHistory.shift();
        return idx;
      },
      pickSupport(excludeSet){
        if(!excludeSet) excludeSet = this.currentScene;
        if(this.shuffled.length === 0) this.reshuffle(excludeSet);
        const idx = this.shuffled.pop();
        return idx;
      },
      setScene(arr){
        this.currentScene = new Set(arr);
      }
    };
    pool.reshuffle();
    return pool;
  }

  /* ===================== 9 个 Slot 固定布局 ====================
     每个 slot 是一个空间位置,不绑定 hero。
     卡片 (DOM) 永远占据某个 slot,但 slot 内的 photoIdx 可以换。
       0 HERO         中心 Hero (略微偏上留空间给歌词)
       1 FG_LEFT      左前(old hero 退场后停留)
       2 FG_RIGHT     右前(支撑)
       3 MG_L         左中
       4 MG_R         右中
       5 MG_FAR_L     左远中
       6 MG_FAR_R     右远中
       7 BG_L         左深后
       8 BG_R         右深后

     注意:x 范围控制在 25%~75% 之内,避免 cards 散布到边缘。
  */
  const SLOTS = [
    { name:'HERO',     x:50, y:46, z:0,    scale:1.00, blur:0,   opacity:1.00 },
    { name:'FG_LEFT',  x:38, y:48, z:-160, scale:0.70, blur:0.3, opacity:0.65 },
    { name:'FG_RIGHT', x:62, y:44, z:-160, scale:0.70, blur:0.3, opacity:0.65 },
    { name:'MG_L',     x:32, y:42, z:-300, scale:0.50, blur:0.6, opacity:0.40 },
    { name:'MG_R',     x:68, y:50, z:-300, scale:0.50, blur:0.6, opacity:0.40 },
    { name:'MG_FAR_L', x:28, y:38, z:-480, scale:0.36, blur:0.9, opacity:0.24 },
    { name:'MG_FAR_R', x:72, y:54, z:-480, scale:0.36, blur:0.9, opacity:0.24 },
    { name:'BG_L',     x:25, y:34, z:-680, scale:0.26, blur:1.3, opacity:0.13 },
    { name:'BG_R',     x:75, y:58, z:-680, scale:0.26, blur:1.3, opacity:0.13 },
  ];

  /* ===================== Handoff Presets ====================
     每个 preset 定义新 hero 从哪个 slot 出发,以什么轨迹接管。
     调用:preset(p) → { fromSlot, dx, dy, dz, scale, rotZ, rotY, blur, life }
       p: 0..1 handoff 进度
       返回的偏移叠加到 HERO slot 的目标位置之上

     8 种 preset,每种都有真正的"飞入/推入/穿越"动作:
       depth       从 BG 深处快速推向 HERO(大幅 z 推进)
       lateral-L   从屏幕左侧大幅滑入(120vw → 0)
       lateral-R   从屏幕右侧大幅滑入
       fly-top     从屏幕上方飞入(高 y 偏移)
       fly-bottom  从屏幕下方飞入
       cross       从右侧穿越到中心,中段短暂经过前景
       push        推进 hero (Camera 同时推进)
       camera-find Camera 先寻找,hero 从 BG 浮现
  */
  const PRESETS = {
    /* depth — 从 BG 深处向 HERO 推进,大 z 距离 */
    'depth': (p) => {
      const pre  = p < 0.20 ? smoothstep(p / 0.20) : 1;
      const main = clamp((p - 0.20) / 0.60, 0, 1);
      const settle = p > 0.85 ? smoothstep((p - 0.85) / 0.15) : 1;
      // easeInOut cubic for smooth cinematic motion
      const k = main < 0.5 ? 4*main*main*main : 1 - Math.pow(-2*main+2, 3)/2;
      return {
        fromSlot:'BG_R',
        dx: lerp(40, 0, k),
        dy: lerp(20, 0, k),
        dz: lerp(-1100, 0, k),
        scaleDelta: lerp(0.30, 1.0, k) - 1.0,
        rotZ: lerp(12, 0, k),
        rotY: lerp(-15, 0, k),
        blur: lerp(2.0, 0, k),
        opacity: lerp(0.0, 1.0, pre) * settle,
      };
    },
    /* lateral-L — 从屏幕左侧外大幅飞入 */
    'lateral-L': (p) => {
      const main = smoothstep(clamp((p - 0.15) / 0.70, 0, 1));
      const early = smoothstep(clamp(p / 0.25, 0, 1));
      return {
        fromSlot:'MG_FAR_L',
        dx: lerp(-1400, 0, main),  // 从屏幕外左侧飞入
        dy: lerp(80, 0, main),
        dz: lerp(-200, 0, main),
        scaleDelta: lerp(0.65, 1.0, main) - 1.0,
        rotZ: lerp(-15, 0, main),
        rotY: lerp(-25, 0, main),
        blur: lerp(1.5, 0, main),
        opacity: early,
      };
    },
    /* lateral-R — 从屏幕右侧外大幅飞入 */
    'lateral-R': (p) => {
      const main = smoothstep(clamp((p - 0.15) / 0.70, 0, 1));
      const early = smoothstep(clamp(p / 0.25, 0, 1));
      return {
        fromSlot:'MG_FAR_R',
        dx: lerp(1400, 0, main),  // 从屏幕外右侧飞入
        dy: lerp(-80, 0, main),
        dz: lerp(-200, 0, main),
        scaleDelta: lerp(0.65, 1.0, main) - 1.0,
        rotZ: lerp(15, 0, main),
        rotY: lerp(25, 0, main),
        blur: lerp(1.5, 0, main),
        opacity: early,
      };
    },
    /* fly-top — 从屏幕上方飞入 */
    'fly-top': (p) => {
      const main = smoothstep(clamp((p - 0.15) / 0.70, 0, 1));
      const early = smoothstep(clamp(p / 0.25, 0, 1));
      return {
        fromSlot:'BG_R',
        dx: lerp(30, 0, main),
        dy: lerp(-800, 0, main),  // 从屏幕上方飞入
        dz: lerp(-300, 0, main),
        scaleDelta: lerp(0.55, 1.0, main) - 1.0,
        rotZ: lerp(-8, 0, main),
        rotX: lerp(15, 0, main),
        blur: lerp(1.2, 0, main),
        opacity: early,
      };
    },
    /* fly-bottom — 从屏幕下方飞入 */
    'fly-bottom': (p) => {
      const main = smoothstep(clamp((p - 0.15) / 0.70, 0, 1));
      const early = smoothstep(clamp(p / 0.25, 0, 1));
      return {
        fromSlot:'BG_L',
        dx: lerp(-30, 0, main),
        dy: lerp(800, 0, main),  // 从屏幕下方飞入
        dz: lerp(-300, 0, main),
        scaleDelta: lerp(0.55, 1.0, main) - 1.0,
        rotZ: lerp(8, 0, main),
        rotX: lerp(-15, 0, main),
        blur: lerp(1.2, 0, main),
        opacity: early,
      };
    },
    /* cross — 从右侧穿越到中心,中段短暂经过前景 */
    'cross': (p) => {
      const main = smoothstep(clamp((p - 0.10) / 0.70, 0, 1));
      const early = smoothstep(clamp(p / 0.15, 0, 1));
      // arc: 中心时 z 短暂冲到 +120(前景)
      const arcZ = Math.sin(main * Math.PI) * 180;
      return {
        fromSlot:'MG_R',
        dx: lerp(900, 0, main),  // 从屏幕外右侧穿越
        dy: lerp(-100, 0, main),
        dz: lerp(-400, 0, main) + arcZ,
        scaleDelta: lerp(0.50, 1.0, main) - 1.0,
        rotZ: lerp(20, 0, main),
        rotY: lerp(35, 0, main),
        blur: lerp(1.5, 0, main),
        opacity: early,
      };
    },
    /* push — Camera 与新 hero 同时推进 */
    'push': (p) => {
      const main = smoothstep(clamp((p - 0.10) / 0.70, 0, 1));
      const early = smoothstep(clamp(p / 0.20, 0, 1));
      return {
        fromSlot:'BG_L',
        dx: lerp(-50, 0, main),
        dy: 0,
        dz: lerp(-1200, 0, main),
        scaleDelta: lerp(0.30, 1.0, main) - 1.0,
        rotZ: 0,
        rotY: lerp(-12, 0, main),
        blur: lerp(2.5, 0, main),
        opacity: early,
      };
    },
    /* camera-find — Camera 先寻找,hero 从 BG 浮现,带轻微 hover */
    'camera-find': (p) => {
      const pre  = smoothstep(clamp(p / 0.30, 0, 1));
      const main = smoothstep(clamp((p - 0.30) / 0.55, 0, 1));
      return {
        fromSlot:'MG_FAR_R',
        dx: lerp(60, 0, main),
        dy: lerp(-30, 0, main),
        dz: lerp(-900, 0, main),
        scaleDelta: lerp(0.35, 1.0, main) - 1.0,
        rotZ: 0,
        rotY: lerp(8, 0, main),
        blur: lerp(2.0, 0, main),
        opacity: pre,
      };
    },
  };

  const PRESET_NAMES = ['depth','lateral-L','lateral-R','cross','push','camera-find'];

  /* ===================== Handoff Schedule ====================
     硬编码 Handoff 时间点,与 LYRIC_CUES 一一对应(只挑关键句)。
     每个 Handoff:
       t          开始时间
       dur        持续 ms
       preset     入场方式
       camera     'push' | 'pull' | 'dolly' | 'orbit' | 'stillness'
       reason     'verse-flow' | 'chorus-arrival' | 'time-rewind' |
                  'bridge-arrival' | 'final-cycle' | 'afterglow-end'
     注意:Handoff 持续期间,该 lyric 后面的 lyric 推迟触发。

     时长: handoff 必须"看得见"。这里 2800ms 是 Handoff 主体,
     但 settle 阶段延伸到 4200ms 让用户看清楚新 hero。
  */
  const HANDOFF_DURATION = 4200;  // ms(主体 ~2.8s, settle 后续 ~1.4s)

  const HANDOFFS = [
    // INTRO: 第一张记忆浮现(飞入!)
    { t:8,    preset:'fly-top',       camera:'push',      reason:'intro-discovery' },
    // VERSE 1: 第二个 handoff,从右侧飞入
    { t:18,   preset:'lateral-R',     camera:'push',      reason:'verse-flow' },
    // VERSE 1 第三次
    { t:35,   preset:'lateral-L',     camera:'push',      reason:'verse-flow' },
    // VERSE 1 第四次
    { t:52,   preset:'cross',         camera:'drift',     reason:'verse-flow' },
    // CHORUS 1: 大穿越
    { t:66,   preset:'cross',         camera:'dolly',     reason:'chorus-arrival' },
    { t:85,   preset:'push',          camera:'push',      reason:'chorus-mid' },
    { t:97,   preset:'lateral-L',     camera:'dolly',     reason:'chorus-outro' },
    // VERSE 2
    { t:115,  preset:'fly-bottom',    camera:'drift',     reason:'verse-flow' },
    // CHORUS 2: 推入 + 穿越
    { t:135,  preset:'depth',         camera:'dolly',     reason:'chorus-arrival' },
    { t:152,  preset:'camera-find',   camera:'dolly',     reason:'time-rewind' },
    // BRIDGE: Hero 退后
    { t:172,  preset:'pull-away',     camera:'pull',      reason:'bridge-arrival' },
    // BRIDGE END: Hero Arrival(从下方飞入)
    { t:194,  preset:'fly-bottom',    camera:'push',      reason:'bridge-arrival' },
    // FINAL CHORUS
    { t:205,  preset:'cross',         camera:'dolly',     reason:'final-cycle' },
    { t:222,  preset:'lateral-R',     camera:'push',      reason:'final-cycle' },
    { t:232,  preset:'lateral-L',     camera:'dolly',     reason:'final-cycle' },
    // OUTRO
    { t:248,  preset:'camera-find',   camera:'pull',      reason:'afterglow-end' },
  ];

  // 注意 'pull-away' 不是 valid preset,需要兼容:旧 hero 退场,新 hero 已经在 hero 不动
  // 我们让 'pull-away' 等价 'depth' 但 camera=stillness(只拉远,不交接到新 hero)
  PRESETS['pull-away'] = PRESETS['depth']; // 占位,实际不换 hero

  /* 找到当前 handoff(基于 audioTime) */
  let scenePhotoIndices = null;
  function buildInitialScene(pool){
    // 初始场景: 选 9 张不同 photo,slot 0 = pool.pickNextHero
    const arr = [];
    const used = new Set();
    const heroIdx = pool.pickNextHero(used);
    arr.push(heroIdx); used.add(heroIdx);
    for(let i=1;i<9;i++){
      const idx = pool.pickSupport(used);
      arr.push(idx); used.add(idx);
    }
    pool.setScene(arr);
    return arr;
  }

  /* State machine
     sceneState.photoForSlot[i] = 当前 slot i 显示哪张照片
     sceneState.heroIdx = 当前 hero photoIdx
     sceneState.outgoingIdx = 上一任 hero photoIdx(已被新 hero 取代,正在退场)
     sceneState.handoff = { progress, preset, phaseName } | null
     sceneState.outgoingProgress = 0..1 旧 hero 退场进度
     sceneState.nextHandoffT = 下次 Handoff 时间
  */
  function getSceneState(time, numPhotos){
    if(!scenePhotoIndices){
      const pool = makeMemoryPool(numPhotos);
      scenePhotoIndices = buildInitialScene(pool);
      window._heroPool = pool;
    }
    const pool = window._heroPool;
    const poolSize = numPhotos || pool.total;

    /* 找到当前正在进行的 handoff */
    let activeHandoff = null;
    let nextHandoffT = null;
    for(let i=0;i<HANDOFFS.length;i++){
      const h = HANDOFFS[i];
      const start = h.t;
      const end = h.t + HANDOFF_DURATION / 1000;
      if(time >= start && time < end){
        activeHandoff = h;
        activeHandoff._start = start;
        activeHandoff._end = end;
        activeHandoff._progress = clamp((time - start) / (HANDOFF_DURATION / 1000), 0, 1);
        // phase
        if(activeHandoff._progress < 0.25) activeHandoff._phase = 'discovery';
        else if(activeHandoff._progress < 0.60) activeHandoff._phase = 'approach';
        else if(activeHandoff._progress < 0.85) activeHandoff._phase = 'cross';
        else activeHandoff._phase = 'settle';
      } else if(time < start && nextHandoffT === null){
        nextHandoffT = start;
      }
    }

    /* 处理 handoff 期间(0~0.85):分配 incomingHeroIdx(将担任 hero 的新照片)
       这样 memories.js 可以在 handoff 期间给 slot 0 DOM card 显示新照片 */
    let incomingHeroIdx = scenePhotoIndices[0];
    if(activeHandoff && activeHandoff._progress >= 0.10 && activeHandoff._progress < 0.85){
      // 检查是否已经为此 handoff 选过 incoming
      if(!pool._incomingMap) pool._incomingMap = new Map();
      const incomingKey = activeHandoff.t + '_incoming';
      if(!pool._incomingMap.has(incomingKey)){
        // 从 pool 中挑出下一个 hero(注意:此时 scene 还没 advance)
        const excludeSet = new Set(scenePhotoIndices);
        const next = pool.pickNextHero(excludeSet);
        pool._incomingMap.set(incomingKey, next);
      }
      incomingHeroIdx = pool._incomingMap.get(incomingKey);
    }

    /* 处理 handoff settle:扫描所有已结束的 handoff,执行 photo 重排
       (不能依赖 activeHandoff,因为 0.85 后 handoff 不再 active 但需 advance) */
    if(!pool._advancedKeys) pool._advancedKeys = new Set();
    for(const h of HANDOFFS){
      const hStart = h.t;
      const hEnd = hStart + HANDOFF_DURATION / 1000;
      const advanceKey = hStart + '_85';
      if(time >= hEnd && !pool._advancedKeys.has(advanceKey)){
        pool._advancedKeys.add(advanceKey);
        const incomingKey = hStart + '_incoming';
        const newHeroIdx = pool._incomingMap && pool._incomingMap.has(incomingKey)
          ? pool._incomingMap.get(incomingKey)
          : pool.pickNextHero();
        const oldHeroIdx = scenePhotoIndices[0];
        // 重组 slot photo:
        //   slot 0 (HERO) = newHeroIdx
        //   slot 1 (FG_left) = oldHeroIdx (退场 hero 在这里停留)
        const others = [];
        const used = new Set([newHeroIdx, oldHeroIdx]);
        const candidates = scenePhotoIndices.slice(1);
        for(const idx of candidates){
          if(!used.has(idx)) others.push(idx);
        }
        while(others.length + 2 < 9){
          const idx = pool.pickSupport(used);
          others.push(idx); used.add(idx);
        }
        const supportSlots = others.slice(0, 7);
        scenePhotoIndices = [newHeroIdx, oldHeroIdx, ...supportSlots];
        pool.setScene(scenePhotoIndices);
      }
    }

    /* 旧 hero 退场进度 (handoff 进度 0.85 ~ 1.0 + 之后 1.5s 持续 settle) */
    let outgoingProgress = 0;
    let outgoingIdx = null;
    if(activeHandoff && activeHandoff._progress >= 0.20){
      // 旧 hero 从 progress 0.20 开始退场(更早开始,让用户在 approach 阶段就能看到"老照片退")
      const op = clamp((activeHandoff._progress - 0.20) / 0.80, 0, 1);
      outgoingProgress = op;
      // 旧 hero = scenePhotoIndices[0](settle 之前),或 scenePhotoIndices[1](settle 之后)
      if(pool._advancedKeys && pool._advancedKeys.has(activeHandoff.t + '_85')){
        outgoingIdx = scenePhotoIndices[1]; // settle 后
      } else {
        outgoingIdx = scenePhotoIndices[0]; // settle 前:旧 hero 还在 HERO,但我们让 FG_LEFT 接收退场动画
      }
    }

    return {
      photoForSlot: scenePhotoIndices.slice(),
      heroIdx: scenePhotoIndices[0],
      incomingHeroIdx,
      outgoingIdx,
      outgoingProgress,
      handoff: activeHandoff,
      nextHandoffT,
      cameraTone: activeHandoff ? activeHandoff.camera : 'drift',
      poolSize,
    };
  }

  /* ===================== getHandoffMotionForCard ====================
     给某张 DOM card,根据当前 handoff 状态返回它在 HERO slot 上的偏移,
     以及它的"入场轨迹"是从哪个 slot 来的。
     这是新 hero 的可见"approach"运动。
  */
  function getHandoffMotionForCard(handoff, cardSlotName){
    if(!handoff || !handoff._progress) return null;
    const preset = PRESETS[handoff.preset];
    if(!preset) return null;
    const p = handoff._progress;
    const motion = preset(p);
    return motion;
  }

  /* ===================== getOutgoingMotion ====================
     给已经退到 FG_LEFT 的旧 hero card,返回它的"退场"偏移。
     旧 hero 在 handoff progress 0.20 开始退场,真的"飞出场":
       - 前 50%:从 HERO 中心 → FG_LEFT(抵消 base 偏移 + 轻微下沉 + 旋转)
       - 后 50%:从 FG_LEFT 飞向左下方出屏幕(大幅 x 偏移 + opacity → 0)
     返回的 dxRatio/dyRatio 由 memories.js 乘 rect.width/height 转像素。
  */
  function getOutgoingMotion(sceneState, cardSlotName){
    if(!sceneState.outgoingIdx) return null;
    if(sceneState.outgoingProgress <= 0) return null;
    const k = sceneState.outgoingProgress;

    if(cardSlotName === 'FG_LEFT'){
      if(k < 0.5){
        const kk = k / 0.5;
        return {
          dxRatio: lerp(0.20, 0, kk),
          dyRatio: lerp(-0.02, 0, kk),
          dz: lerp(160, 0, kk),
          scaleDelta: lerp(0, -0.22, kk),
          opacityDelta: lerp(0, -0.30, kk),
          blurDelta: lerp(0, 0.4, kk),
          rotZ: lerp(0, -12, kk),
          rotY: lerp(0, -20, kk),
        };
      } else {
        const kk = (k - 0.5) / 0.5;
        return {
          dxRatio: lerp(0, -0.35, kk),
          dyRatio: lerp(0, 0.20, kk),
          dz: lerp(0, 250, kk),
          scaleDelta: lerp(-0.22, -0.55, kk),
          opacityDelta: lerp(-0.30, -0.85, kk),
          blurDelta: lerp(0.4, 1.8, kk),
          rotZ: lerp(-12, -25, kk),
          rotY: lerp(-20, -45, kk),
        };
      }
    }
    return null;
  }

  /* ===================== Public API ==================== */
  window.HeroDirector = {
    SCENE_SEED,
    SLOTS,
    PRESETS,
    PRESET_NAMES,
    HANDOFFS,
    HANDOFF_DURATION,
    getSceneState,
    getHandoffMotionForCard,
    getOutgoingMotion,
  };
})();