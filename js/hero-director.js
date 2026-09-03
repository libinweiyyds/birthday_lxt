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
     调用:preset(p) → { fromSlot, dx, dy, dz, scale, rotZ, blur, life }
       p: 0..1 handoff 进度
       返回的偏移叠加到 HERO slot 的目标位置之上

     6 种 preset,每种有不同"叙事签名":
       depth       从 BG 深处直接推向 HERO
       lateral-L   从左后方斜推入
       lateral-R   从右后方斜推入
       cross       新 hero 从对侧穿越 + 旧 hero 同时退到 FG_LEFT
       push        Camera 推进 + 新 hero 推进 + 旧 hero 后退
       camera-find Camera 先移动寻找,新 hero 浮现
  */
  const PRESETS = {
    'depth': (p) => {
      // 0..0.3 从 BG_R 浮现;0.3..0.85 推进到 HERO;0.85..1 settle
      const pre  = p < 0.30 ? smoothstep(p / 0.30) : 1;
      const main = clamp((p - 0.30) / 0.55, 0, 1);
      const settle = p > 0.85 ? smoothstep((p - 0.85) / 0.15) : 1;
      return {
        fromSlot:'BG_R',
        fromZ:-680, fromScale:0.36, fromOpacity:0.16, fromBlur:1.4,
        dx: lerp(30, 0, main),
        dy: lerp(15, 0, main),
        dz: lerp(-680, 0, main),
        scaleDelta: lerp(0.36, 1.0, main) - 1.0,
        rotZ: lerp(8, 0, main),
        blur: lerp(1.4, 0, main),
        opacity: lerp(0.16, 1.0, pre) * settle,
      };
    },
    'lateral-L': (p) => {
      const main = smoothstep(clamp((p - 0.20) / 0.65, 0, 1));
      return {
        fromSlot:'MG_FAR_L',
        fromZ:-480, fromScale:0.48, fromOpacity:0.28, fromBlur:1.0,
        dx: lerp(-40, 0, main),
        dy: lerp(10, 0, main),
        dz: lerp(-480, 0, main),
        scaleDelta: lerp(0.48, 1.0, main) - 1.0,
        rotZ: lerp(-6, 0, main),
        rotY: lerp(-10, 0, main),
        blur: lerp(1.0, 0, main),
        opacity: smoothstep(clamp(p / 0.25, 0, 1)),
      };
    },
    'lateral-R': (p) => {
      const main = smoothstep(clamp((p - 0.20) / 0.65, 0, 1));
      return {
        fromSlot:'MG_FAR_R',
        fromZ:-480, fromScale:0.48, fromOpacity:0.28, fromBlur:1.0,
        dx: lerp(40, 0, main),
        dy: lerp(-10, 0, main),
        dz: lerp(-480, 0, main),
        scaleDelta: lerp(0.48, 1.0, main) - 1.0,
        rotZ: lerp(6, 0, main),
        rotY: lerp(10, 0, main),
        blur: lerp(1.0, 0, main),
        opacity: smoothstep(clamp(p / 0.25, 0, 1)),
      };
    },
    'cross': (p) => {
      // 新 hero 从右侧穿越到中心,中段经过中心偏前(z=+60 短暂前景)
      const main = clamp((p - 0.20) / 0.60, 0, 1);
      const early = clamp(p / 0.20, 0, 1);
      const arcZ = Math.sin(main * Math.PI) * 80;
      return {
        fromSlot:'MG_R',
        fromZ:-300, fromScale:0.62, fromOpacity:0.45, fromBlur:0.7,
        dx: lerp(35, 0, main),
        dy: lerp(-12, 0, main),
        dz: lerp(-300, 0, main) + arcZ,
        scaleDelta: lerp(0.62, 1.05, main) * (main > 0.85 ? lerp(1.05, 1.0, (main-0.85)/0.15) : 1) - 1.0,
        rotZ: lerp(10, 0, main),
        rotY: lerp(15, 0, main),
        blur: lerp(0.7, 0, main),
        opacity: early,
      };
    },
    'push': (p) => {
      // Camera 与新 hero 同时推进;新 hero 从 BG 直接推到近景
      const main = smoothstep(clamp((p - 0.10) / 0.70, 0, 1));
      const early = clamp(p / 0.20, 0, 1);
      return {
        fromSlot:'BG_L',
        fromZ:-680, fromScale:0.36, fromOpacity:0.16, fromBlur:1.4,
        dx: lerp(-15, 0, main),
        dy: 0,
        dz: lerp(-680, 0, main),
        scaleDelta: lerp(0.36, 1.0, main) - 1.0,
        rotZ: 0,
        rotY: lerp(-6, 0, main),
        blur: lerp(1.4, 0, main),
        opacity: early,
      };
    },
    'camera-find': (p) => {
      // Camera 先寻找:hero 在远处微动,后段快速推进
      const pre  = smoothstep(clamp(p / 0.35, 0, 1));
      const main = smoothstep(clamp((p - 0.35) / 0.55, 0, 1));
      return {
        fromSlot:'MG_FAR_R',
        fromZ:-480, fromScale:0.48, fromOpacity:0.28, fromBlur:1.0,
        dx: lerp(25, 0, main),
        dy: 0,
        dz: lerp(-480, 0, main),
        scaleDelta: lerp(0.48, 1.0, main) - 1.0,
        rotZ: 0,
        rotY: 0,
        blur: lerp(1.0, 0, main),
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
    // INTRO: 0:00 - 0:15 - 第一张记忆浮现(让 30s 测试能通过)
    // 8s: 第一张记忆被发现 (建立 Hero)
    { t:8,    preset:'depth',         camera:'push',      reason:'intro-discovery' },
    // VERSE 1: 第一个 lyric 之前,第二次 handoff
    { t:18,   preset:'lateral-R',     camera:'push',      reason:'verse-flow' },
    // VERSE 1 第二次 (34s - "最后没有了对白")
    { t:35,   preset:'lateral-L',     camera:'push',      reason:'verse-flow' },
    // VERSE 1 第三次 (42s - "生命的起伏要认可")
    { t:52,   preset:'cross',         camera:'drift',     reason:'verse-flow' },
    // CHORUS 1: 1:08 - "我们是对方 特别的人" — 大转场
    { t:66,   preset:'cross',         camera:'dolly',     reason:'chorus-arrival' },
    { t:85,   preset:'push',          camera:'push',      reason:'chorus-mid' },
    { t:97,   preset:'lateral-R',     camera:'dolly',     reason:'chorus-outro' },
    // VERSE 2: 1:48 - 续 verse
    { t:115,  preset:'lateral-R',     camera:'drift',     reason:'verse-flow' },
    // CHORUS 2: 2:13 - Memory Explosion
    { t:135,  preset:'cross',         camera:'dolly',     reason:'chorus-arrival' },
    { t:152,  preset:'camera-find',   camera:'dolly',     reason:'time-rewind' },
    // BRIDGE: 2:50 - Hero 退后,等待
    { t:172,  preset:'pull-away',     camera:'pull',      reason:'bridge-arrival' },
    // BRIDGE END / FINAL CHORUS: 3:14 - Hero Arrival
    { t:194,  preset:'depth',         camera:'push',      reason:'bridge-arrival' },
    // FINAL CHORUS
    { t:205,  preset:'cross',         camera:'dolly',     reason:'final-cycle' },
    { t:222,  preset:'lateral-L',     camera:'push',      reason:'final-cycle' },
    { t:232,  preset:'cross',         camera:'dolly',     reason:'final-cycle' },
    // OUTRO: 3:50 之后 — 最后一次微弱 handoff
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
     给已经退到 FG_LEFT 的旧 hero card,返回它的"退场"偏移(pixels)。
     旧 hero 在 handoff progress 0.20 开始退场(从 HERO 中心 → FG_LEFT → BG):
       - 前 50% (progress 0.20~0.60):从 HERO (z=0) 退到 FG_LEFT (z=-160, x 偏左)
       - 后 50% (progress 0.60~1.00):从 FG_LEFT 进一步退到 BG (z=-480)
     dx/dy/dz 在 memories.js 中以像素单位叠加到 card.transform 上。
     注意:由于 memories.js 已经把 base slot 转成 pixels,这里的 dx/dy/dz 是 pixel delta。
  */
  function getOutgoingMotion(sceneState, cardSlotName){
    if(!sceneState.outgoingIdx) return null;
    if(sceneState.outgoingProgress <= 0) return null;
    const k = sceneState.outgoingProgress;

    if(cardSlotName === 'FG_LEFT'){
      /* FG_LEFT base = (x:30, y:52, z:-160) 相对 viewport 中心 */
      /* 在 memories.js 中,px = (30-50)/100 * rect.width = -20% width */
      /* 要把 card 推到屏幕中心 (x:50),需要 dx = +20% width = ~384px on 1920 */
      /* 视口大小不固定,所以我们让 memories.js 传 rect 参数,然后这里用相对单位 */
      /* 实际实现:memories.js 已经做了 base slot 转 pixel,所以这里给 pixel 增量 */
      /* 前 50%:card 从中心 → FG_LEFT(但 base 已经把它放到 FG_LEFT,所以需要抵消 base) */
      if(k < 0.5){
        const kk = k / 0.5;
        return {
          /* FG_LEFT base 占 -20% width(1920px 屏幕 = -384px),把它推到中心需要 dx ≈ +384px */
          /* 但 dx 是绝对像素,这里用 viewport 比例,所以 memories.js 需要先乘 width */
          /* 改为:让 memories.js 传 rect width,这里返回百分比偏移 */
          dxRatio: lerp(0.20, 0, kk),   /* +20% width → 0 */
          dyRatio: lerp(-0.02, 0, kk),
          dz: lerp(160, 0, kk),
          scaleDelta: lerp(0, -0.22, kk),
          opacityDelta: lerp(0, -0.30, kk),
          blurDelta: lerp(0, 0.4, kk),
          rotZ: lerp(0, -8, kk),
        };
      } else {
        const kk = (k - 0.5) / 0.5;
        return {
          dxRatio: lerp(0, -0.05, kk),
          dyRatio: lerp(0, 0.13, kk),
          dz: lerp(0, 320, kk),
          scaleDelta: lerp(-0.22, -0.52, kk),
          opacityDelta: lerp(-0.30, -0.55, kk),
          blurDelta: lerp(0.4, 1.2, kk),
          rotZ: lerp(-8, -10, kk),
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