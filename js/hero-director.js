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

     设计原则(电影镜头构图):
       - 非对称布局:不是左右镜像,而是 diagonal leading lines
       - 三层 FG 群(前景深度):FG1 在 Hero 左下强遮挡,FG2 在 Hero 右上,FG3 在 Hero 右下
       - 中景两簇:左上 cluster + 右下 cluster,引导视线从角落到 Hero
       - 远景三张:角落 + 顶部,营造空间深度
       - 强烈 z 差距:FG z=+80~+180(遮挡 Hero),MG z=-280~-380,BG z=-540~-780

       0  HERO          中心,略带偏离
       1  FG_NEARMID    Hero 左前遮挡(z=+180,最靠近镜头)
       2  FG_FARRIGHT   Hero 右上(z=+120,带强 3D 倾斜)
       3  FG_BOTTOM     Hero 下方遮挡(z=+80)
       4  MG_TOPLEFT    左上 cluster 引导线起点
       5  MG_BOTRIGHT   右下 cluster 引导线终点
       6  BG_FARLEFT    深后左,rotY -28 强烈 3D
       7  BG_FARRIGHT   深后右,rotY +25
       8  BG_TOP        Hero 正上方远处(平衡构图)
  */
  const SLOTS = [
    // HERO 略微偏左下(45,52),给 FG_FARRIGHT 更多空间
    { name:'HERO',       x:46, y:50, z:0,    scale:0.95, blur:0,    opacity:1.00, rotZ:0,   rotY:0 },
    // FG1: 强前景遮挡,在 Hero 左前方,3D 透视明显
    { name:'FG_NEARMID', x:32, y:55, z:180,  scale:0.72, blur:0,    opacity:0.92, rotZ:-7,  rotY:-18 },
    // FG2: Hero 右上,带 z=+120 推进 + rotY +18 的强 3D 透视
    { name:'FG_FARRIGHT',x:72, y:32, z:120,  scale:0.62, blur:0,    opacity:0.78, rotZ:8,   rotY:18 },
    // FG3: Hero 正下方前景,遮挡底层
    { name:'FG_BOTTOM',  x:55, y:78, z:90,   scale:0.55, blur:0.1,  opacity:0.70, rotZ:-2,  rotY:0 },
    // MG_TOPLEFT: 左上 cluster,引导线起点
    { name:'MG_TOPLEFT', x:14, y:24, z:-320,scale:0.42, blur:0.6,  opacity:0.38, rotZ:-12, rotY:-22 },
    // MG_BOTRIGHT: 右下 cluster,与 MG_TOPLEFT 形成对角线
    { name:'MG_BOTRIGHT',x:85, y:72, z:-380,scale:0.40, blur:0.6,  opacity:0.36, rotZ:14,  rotY:24 },
    // BG_FARLEFT: 深后左,rotY -28 强烈 3D 透视
    { name:'BG_FARLEFT', x:6,  y:62, z:-620,scale:0.28, blur:1.2,  opacity:0.18, rotZ:-9,  rotY:-30 },
    // BG_FARRIGHT: 深后右,rotY +25
    { name:'BG_FARRIGHT',x:92, y:30, z:-640,scale:0.26, blur:1.3,  opacity:0.16, rotZ:11,  rotY:26 },
    // BG_TOP: 顶部,rotY 中性,提供"上方空间"让 Hero 呼吸
    { name:'BG_TOP',     x:60, y:8,  z:-720,scale:0.22, blur:1.4,  opacity:0.12, rotZ:-3,  rotY:0 },
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
  /* Per-photo visual signature(rotation + 微位置 + 微 scale)
     让每张照片有独特视觉气质,避免"机器重复"感 */
  const photoRotZ = new Map();
  const photoRotY = new Map();
  const photoOffX = new Map();  // x 偏移(像素)
  const photoOffY = new Map();  // y 偏移(像素)
  const photoScaleDelta = new Map();
  const photoBlurDelta = new Map();

  /* Per-photo COMPOSITION — 每张 hero photo 关联一个独特的 "scene archetype"
     不同的 archetype 决定:
       - 哪些 slot 被填充(有些 archetype 只用 5 张卡,有些用 9 张)
       - 每个 slot 的 偏移倍数(让有些 archetype 把卡片推得更远/更近)
       - 整体 rotation tendency(整体偏左倾/右倾/正)
     这样每次 hero 变化时,即使 slot 不变,场景感觉也不同。
   */
  const COMPOSITION_TYPES = [
    'lone-hero',         // Hero 独自,几乎没有配角(适合安静 verse)
    'memory-crowd',     // 7-8 张环绕 Hero(适合高潮)
    'vertical-stack',   // 卡片垂直堆叠在 Hero 旁
    'horizontal-band',  // 卡片在水平线
    'diagonal-flow',    // 卡片沿对角线分布
    'scatter-radial',   // 卡片从 Hero 向外放射
    'cluster-left',     // 大部分卡片聚集在 Hero 左侧
    'cluster-right',    // 大部分卡片聚集在 Hero 右侧
    'float-above',      // 卡片主要在 Hero 上方(留出下方空间)
    'sink-below',       // 卡片主要在 Hero 下方
  ];

  const photoComposition = new Map();  // photoIdx → composition type
  const compositionRng = mulberry32(SCENE_SEED ^ 0xC0FFEE);

  function getPhotoComposition(photoIdx){
    if(!photoComposition.has(photoIdx)){
      const idx = Math.floor(compositionRng() * COMPOSITION_TYPES.length);
      photoComposition.set(photoIdx, COMPOSITION_TYPES[idx]);
    }
    return photoComposition.get(photoIdx);
  }

  /* 根据 composition type 返回 slot 修饰参数 */
  function getCompositionModifiers(compType, slotName){
    const mod = {
      // 默认:全部正常显示
      visibility: 1.0,
      scaleMul: 1.0,
      posMul: { x: 1.0, y: 1.0, z: 1.0 },
      rotOffset: { x: 0, y: 0, z: 0 },
      breathMul: 1.0,
    };
    switch(compType){
      case 'lone-hero':
        // 只有 Hero + 1 张 FG,其他全隐藏
        if(slotName === 'HERO') mod.posMul = { x: 1.0, y: 0.95, z: 1.0 };
        else if(slotName === 'FG_NEARMID') mod.visibility = 0.7;
        else mod.visibility = 0;
        break;
      case 'memory-crowd':
        // 全部可见,稍微缩小一点
        mod.scaleMul = 0.9;
        if(slotName === 'BG_FARLEFT' || slotName === 'BG_FARRIGHT') mod.scaleMul = 1.2;
        break;
      case 'vertical-stack':
        // 卡片在 Hero 上下堆叠
        if(slotName === 'MG_TOPLEFT' || slotName === 'BG_TOP'){
          mod.posMul = { x: 1.2, y: 0.7, z: 1.0 };
          mod.visibility = 1.2;
        }
        if(slotName === 'FG_BOTTOM' || slotName === 'MG_BOTRIGHT'){
          mod.posMul = { x: 1.0, y: 1.3, z: 1.0 };
          mod.visibility = 1.2;
        }
        // 隐藏左右两侧
        if(slotName === 'FG_NEARMID' || slotName === 'FG_FARRIGHT') mod.visibility = 0.4;
        break;
      case 'horizontal-band':
        if(slotName === 'BG_TOP') mod.visibility = 0;
        if(slotName === 'FG_BOTTOM') mod.visibility = 0;
        mod.posMul = { x: 1.1, y: 1.0, z: 1.0 };
        break;
      case 'diagonal-flow':
        mod.rotOffset = { x: 0, y: 0, z: 0 };
        if(slotName.includes('TOP')) mod.rotOffset.z = -3;
        if(slotName.includes('BOT')) mod.rotOffset.z = 3;
        break;
      case 'scatter-radial':
        mod.posMul = { x: 1.4, y: 1.4, z: 1.0 };
        mod.scaleMul = 0.85;
        break;
      case 'cluster-left':
        if(slotName === 'FG_FARRIGHT' || slotName === 'BG_FARRIGHT' || slotName === 'MG_BOTRIGHT'){
          mod.visibility = 0;
        }
        if(slotName === 'FG_NEARMID' || slotName === 'MG_TOPLEFT'){
          mod.posMul = { x: 0.7, y: 1.0, z: 1.0 };
        }
        break;
      case 'cluster-right':
        if(slotName === 'FG_NEARMID' || slotName === 'BG_FARLEFT' || slotName === 'MG_TOPLEFT'){
          mod.visibility = 0;
        }
        if(slotName === 'FG_FARRIGHT' || slotName === 'MG_BOTRIGHT'){
          mod.posMul = { x: 0.7, y: 1.0, z: 1.0 };
        }
        break;
      case 'float-above':
        if(slotName === 'FG_BOTTOM' || slotName === 'MG_BOTRIGHT' || slotName === 'BG_FARLEFT'){
          mod.visibility = 0.3;
        }
        if(slotName === 'BG_TOP' || slotName === 'MG_TOPLEFT'){
          mod.posMul = { x: 1.0, y: 0.85, z: 1.0 };
        }
        break;
      case 'sink-below':
        if(slotName === 'BG_TOP' || slotName === 'MG_TOPLEFT' || slotName === 'FG_FARRIGHT'){
          mod.visibility = 0.3;
        }
        if(slotName === 'FG_BOTTOM' || slotName === 'MG_BOTRIGHT'){
          mod.posMul = { x: 1.0, y: 1.1, z: 1.0 };
        }
        break;
    }
    return mod;
  }
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
    // 为每张照片生成固定的 visual signature
    for(const idx of arr) ensurePhotoSignature(idx);
    return arr;
  }

  /* 为 photoIdx 生成/获取固定的 visual signature */
  function ensurePhotoSignature(photoIdx){
    if(!photoRotZ.has(photoIdx)){
      // 多个独立的 hash,基于 photoIdx
      const h1 = ((photoIdx * 0x9E3779B9) >>> 0) / 0xFFFFFFFF;
      const h2 = ((photoIdx * 0x6F4D8B17) >>> 0) / 0xFFFFFFFF;
      const h3 = ((photoIdx * 0xC2B2AE35 + 7) >>> 0) / 0xFFFFFFFF;
      const h4 = ((photoIdx * 0xA3C59AC7 + 13) >>> 0) / 0xFFFFFFFF;
      // rotation: 不同照片不同倾斜
      photoRotZ.set(photoIdx, (h1 - 0.5) * 16);   // [-8, +8]
      photoRotY.set(photoIdx, (h2 - 0.5) * 22);   // [-11, +11]
      // position micro-offset: ±30px(让相同 slot 内的照片不重叠)
      photoOffX.set(photoIdx, (h3 - 0.5) * 60);
      photoOffY.set(photoIdx, (h4 - 0.5) * 50);
      // scale 微妙变化: ±0.04
      photoScaleDelta.set(photoIdx, (h1 - 0.5) * 0.08);
      // blur 微妙变化: ±0.15
      photoBlurDelta.set(photoIdx, Math.abs(h2 - 0.5) * 0.3);
    }
  }

  /* 公共 API: 获取某张照片的完整 visual signature */
  function getPhotoSignature(photoIdx){
    ensurePhotoSignature(photoIdx);
    return {
      rotZ: photoRotZ.get(photoIdx),
      rotY: photoRotY.get(photoIdx),
      offX: photoOffX.get(photoIdx),
      offY: photoOffY.get(photoIdx),
      scaleDelta: photoScaleDelta.get(photoIdx),
      blurDelta: photoBlurDelta.get(photoIdx),
    };
  }

  /* 兼容旧 API */
  function getPhotoRotOffset(photoIdx){
    ensurePhotoSignature(photoIdx);
    return { rotZ: photoRotZ.get(photoIdx), rotY: photoRotY.get(photoIdx) };
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
        // 为新 hero 生成 visual signature
        ensurePhotoSignature(next);
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
        // 为新加入的照片生成 visual signature
        for(const idx of scenePhotoIndices) ensurePhotoSignature(idx);
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
      // FG_LEFT base is now (32, 55, rotY=-18), so to put card at center we need +0.18 x, -0.05 y
      if(k < 0.5){
        const kk = k / 0.5;
        return {
          dxRatio: lerp(0.18, 0, kk),
          dyRatio: lerp(-0.05, 0, kk),
          dz: lerp(-180, 0, kk),  // 从 z=+180 退到 z=0
          scaleDelta: lerp(0, -0.25, kk),
          opacityDelta: lerp(0, -0.30, kk),
          blurDelta: lerp(0, 0.4, kk),
          rotZ: lerp(0, -12, kk),
          rotY: lerp(0, -22, kk),
        };
      } else {
        const kk = (k - 0.5) / 0.5;
        return {
          dxRatio: lerp(0, -0.45, kk),
          dyRatio: lerp(0, 0.25, kk),
          dz: lerp(0, 280, kk),
          scaleDelta: lerp(-0.25, -0.55, kk),
          opacityDelta: lerp(-0.30, -0.85, kk),
          blurDelta: lerp(0.4, 1.8, kk),
          rotZ: lerp(-12, -25, kk),
          rotY: lerp(-22, -45, kk),
        };
      }
    }
    return null;
  }

  /* ===================== getIntroReveal ====================
     Staggered intro reveal — 在 0~6s 内,让每张 slot 以不同延迟 fade in

     每个 slot 的延迟 = i * 0.45s (slot 越远越晚出现)
     在 delay 之前: opacity = 0, scale = 0.3 (几乎不见)
     在 delay 之后: 1.2s 内平滑过渡到完整

     这样开场不会"全部卡片同时 boom 进来",
     而是"一张一张被镜头发现"
     6s 完成所有卡片,刚好衔接第一个 handoff(t=8)
   */
  const INTRO_START = 0;
  const INTRO_DURATION = 6;
  const INTRO_PER_CARD_DELAY = 0.45;
  const INTRO_REVEAL_TIME = 1.2;

  function getIntroReveal(slotIdx, time){
    if(time > INTRO_DURATION) return 1.0;  // 全部 reveal 完成
    // Hero (slot 0) 在 t=0 立即出现(不需要 staggered reveal — 用户已经点击 intro 进入)
    if(slotIdx === 0) return 1.0;
    // 其他 slot 用 i 索引作为延迟
    const delay = (slotIdx - 1) * INTRO_PER_CARD_DELAY + 0.4;
    const elapsed = time - delay;
    if(elapsed <= 0) return 0;
    if(elapsed >= INTRO_REVEAL_TIME) return 1.0;
    return smoothstep(elapsed / INTRO_REVEAL_TIME);
  }

  /* ===================== Public API ==================== */
  window.HeroDirector = {
    SCENE_SEED,
    SLOTS,
    PRESETS,
    PRESET_NAMES,
    HANDOFFS,
    HANDOFF_DURATION,
    COMPOSITION_TYPES,
    INTRO_START,
    INTRO_DURATION,
    INTRO_PER_CARD_DELAY,
    INTRO_REVEAL_TIME,
    getSceneState,
    getHandoffMotionForCard,
    getOutgoingMotion,
    getPhotoRotOffset,
    getPhotoSignature,
    getPhotoComposition,
    getCompositionModifiers,
    getIntroReveal,
  };
})();