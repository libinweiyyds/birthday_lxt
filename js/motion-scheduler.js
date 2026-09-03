/* ==================== Motion Scheduler V6 ====================
   Cinematic Motion System 的核心:ContinuousMotionScheduler。

   架构层级:
     Ambient   永远存在,基于 audioTime + seed 的微动(0.5-1.5 像素级)
     Micro     0.8-2.5 秒间隔,由 seed 决定时间和类型(camera micro push,
               card depth shift, lateral drift, focus pull 等)
     Key       LYRIC_CUES 触发的 LYRIC_EVENT_TIMELINE(flyary, / scatter /
               reassemble / hero-reveal / time-rewind / hero-depth-enter 等)
     Camera    SHOT_TIMELINE 的一次性 Camera Shot

   所有状态都由 audioTime 决定(Seek 可即时重建)。
   没有任何 setInterval / 每帧 Math.random。
   SceneSeed 保证 deterministic。
*/
(function(){
  'use strict';

  /* ===================== Seeded Random ====================
     mulberry32 — 32-bit hash, deterministic. */
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

  const SCENE_SEED = 91732191;
  const TAU = Math.PI * 2;
  const clamp = (v,a,b) => v < a ? a : (v > b ? b : v);
  const lerp  = (a,b,t) => a + (b-a) * t;
  const smoothstep = t => t*t*(3 - 2*t);

  /* ===================== Motion Phase 系统 ====================
     7 个 Motion Phase(基于音频时间),每个 Phase 决定:
       ambientDensity  Ambient 微动幅度系数
       microDensity    Micro Motion 频率系数
       cameraTone      Camera 偏向(establish/push/pull/drift/pass)
       lyricEnergy     歌词动画强度
     音乐 0-259s 切分为:
       INTRO   0-15s   (Discovery / Establishing)
       VERSE1  15-42s  (Intimacy / Push)
       VERSE2  43-67s  (Mature / Lateral Drift)
       CHORUS1 68-107s (Expansion / Hero Reveal)
       VERSE3  108-132s(Memory Echo / Depth Drift)
       CHORUS2 133-167s(Memory Explosion)
       BRIDGE  168-197s(Waiting / Quiet + Hero Arrival)
       CHORUS3 198-228s(Final Recognition)
       OUTRO   229-259s(Afterglow)
  */
  const PHASE_TABLE = [
    { name:'INTRO',   start:0,   end:15,   ambientDensity:0.55, microDensity:0.30, cameraTone:'establish', lyricEnergy:'micro' },
    { name:'VERSE1',  start:15,  end:42,   ambientDensity:0.65, microDensity:0.55, cameraTone:'push',     lyricEnergy:'emotion' },
    { name:'VERSE2',  start:42,  end:67,   ambientDensity:0.65, microDensity:0.55, cameraTone:'drift',    lyricEnergy:'micro' },
    { name:'CHORUS1', start:67,  end:107,  ambientDensity:0.80, microDensity:0.85, cameraTone:'push',     lyricEnergy:'key' },
    { name:'VERSE3',  start:107, end:132,  ambientDensity:0.60, microDensity:0.50, cameraTone:'drift',    lyricEnergy:'emotion' },
    { name:'CHORUS2', start:132, end:167,  ambientDensity:0.85, microDensity:0.95, cameraTone:'pass',     lyricEnergy:'key' },
    { name:'BRIDGE',  start:167, end:197,  ambientDensity:0.45, microDensity:0.25, cameraTone:'pull',     lyricEnergy:'emotion' },
    { name:'CHORUS3', start:197, end:228,  ambientDensity:0.75, microDensity:0.80, cameraTone:'push',     lyricEnergy:'final' },
    { name:'OUTRO',   start:228, end:259,  ambientDensity:0.55, microDensity:0.40, cameraTone:'pull',     lyricEnergy:'final' },
  ];

  function getPhaseState(time){
    let idx = 0;
    for(let i=0;i<PHASE_TABLE.length;i++){
      if(time >= PHASE_TABLE[i].start && time < PHASE_TABLE[i].end){ idx = i; break; }
      if(time >= PHASE_TABLE[i].start) idx = i;
    }
    const phase = PHASE_TABLE[idx];
    const span = phase.end - phase.start;
    const progress = span > 0 ? clamp((time - phase.start) / span, 0, 1) : 0;
    return { name:phase.name, idx, progress, density:phase, next: PHASE_TABLE[Math.min(idx+1, PHASE_TABLE.length-1)] };
  }

  /* ===================== Ambient Motion ====================
     getAmbientForCard(i, time, depthZ) → {dx, dy, dz, drotZ, dscale, dopacity, dblur}

     永远存在,无论是否在 Key Event。
     每张卡片基于 cardIndex 的 seed 偏移 + Z depth 的幅度系数。
     Z 越远(深度负) → 振幅越小(0.1 倍)
     Z 越近(深度正) → 振幅越大(1.5 倍)
  */
  function getAmbientForCard(i, time, slotZ){
    const phaseBase = i * 0.917 + SCENE_SEED * 0.000013;
    // 深度 → 振幅系数。远卡最小 0.4(避免几乎不动),近卡最大 1.6
    const depthFactor = clamp(1 + slotZ / 600, 0.4, 1.6);
    // 各维度独立频率(避免所有维度同步)
    // 额外乘 1.4 让微动始终超过 toFixed(3) 的 0.001px 截断
    const k = 1.4;
    return {
      dx:      Math.sin(time * 0.18 + phaseBase)        * 8  * depthFactor * k,
      dy:      Math.cos(time * 0.23 + phaseBase * 1.3)  * 5  * depthFactor * k,
      dz:      Math.sin(time * 0.13 + phaseBase * 0.7)  * 4  * depthFactor * k,
      drotZ:   Math.sin(time * 0.11 + phaseBase * 1.7)  * 0.4 * depthFactor * k,
      dscale:  Math.sin(time * 0.07 + phaseBase * 2.1)  * 0.008 * depthFactor * k,
      dopacity: 0,
      dblur:   Math.sin(time * 0.09 + phaseBase * 0.5)  * 0.05 * depthFactor * k,
    };
  }

  /* Camera Ambient — 永远存在的摄影机微漂移(避免完全静止)
     即使 Shot = STILLNESS,也允许微呼吸 */
  function getAmbientCamera(time, phaseDensity){
    const amb = phaseDensity.ambientDensity;
    return {
      x:     Math.sin(time * 0.04) * 3 * amb,
      y:     Math.cos(time * 0.05) * 2 * amb,
      z:     Math.sin(time * 0.03) * 1.5 * amb,
      rotX:  Math.sin(time * 0.03) * 0.15 * amb,
      rotY:  Math.cos(time * 0.025) * 0.15 * amb,
      scale: 1 + Math.sin(time * 0.02) * 0.003 * amb,
    };
  }

  /* Hero Light Ambient — Hero 周围的柔和呼吸 */
  function getAmbientHeroLight(time){
    return {
      r:  22 + Math.sin(time * 0.07) * 1.5,
      op: 0.08 + Math.sin(time * 0.11) * 0.03,
    };
  }

  /* ===================== Micro Motion Events ====================
     用 SCENE_SEED 预生成一组 Micro Events,在音频时间内按时间排列:
       types: 'camera-push', 'camera-drift', 'depth-shift', 'lateral-drift',
              'focus-pull', 'hero-breathe', 'side-card-tilt'
     每种类型的 dur 1000-2200ms,间隔 800-2500ms。
     Bridge Phase 密度 × 0.25,Outro × 0.40,Chorus × 0.95。

     生成流程(在 module 加载时一次性执行):
       1. 决定总 Micro Event 数量(基于密度)
       2. 用 seeded RNG 按时间顺序放置
       3. 记录每个 event 的 (type, startT, dur, seed)
  */
  const MICRO_TYPES = [
    { name:'camera-push',      durRange:[1100, 1800] },
    { name:'camera-drift',     durRange:[1400, 2200] },
    { name:'depth-shift',      durRange:[1000, 1600] },
    { name:'lateral-drift',    durRange:[1200, 2000] },
    { name:'focus-pull',       durRange:[900,  1400] },
    { name:'hero-breathe',     durRange:[1500, 2200] },
    { name:'side-card-tilt',   durRange:[1100, 1700] },
  ];

  /* 重复检测:记录最近 4 个类型签名,避免连续重复同种 type */
  const recentTypes = [];
  function recordType(t){ recentTypes.push(t); if(recentTypes.length > 4) recentTypes.shift(); }
  function pickMicroType(rng){
    let tries = 0;
    while(tries < 8){
      const idx = Math.floor(rng() * MICRO_TYPES.length);
      const t = MICRO_TYPES[idx];
      const sig = t.name;
      if(!recentTypes.includes(sig) || recentTypes.filter(x => x === sig).length < 2){
        recordType(sig);
        return t;
      }
      tries++;
    }
    // fallback:随机选
    const t = MICRO_TYPES[Math.floor(rng() * MICRO_TYPES.length)];
    recordType(t.name);
    return t;
  }

  /* 生成 MICRO_TIMELINE,基于 phase 密度 */
  const MICRO_TIMELINE = [];
  function buildMicroTimeline(){
    const rng = mulberry32(SCENE_SEED ^ 0xA53F);
    let t = 0.5;
    // 总时长 259s
    while(t < 259){
      // 找到当前 t 对应的 phase
      let phaseIdx = 0;
      for(let i=0;i<PHASE_TABLE.length;i++){
        if(t >= PHASE_TABLE[i].start && t < PHASE_TABLE[i].end){ phaseIdx = i; break; }
      }
      const phase = PHASE_TABLE[phaseIdx];
      // 间隔基于 phase 密度
      const baseGap = 0.8 + rng() * 1.7;
      const gap = baseGap / Math.max(0.3, phase.microDensity);
      t += gap;
      if(t >= 259) break;
      // 选 type
      const type = pickMicroType(rng);
      const durMs = type.durRange[0] + rng() * (type.durRange[1] - type.durRange[0]);
      const dur = durMs / 1000;
      MICRO_TIMELINE.push({
        t: +t.toFixed(2),
        type: type.name,
        dur: +dur.toFixed(2),
        phaseIdx,
        seed: Math.floor(rng() * 1000),
      });
    }
  }
  buildMicroTimeline();

  /* 当前活跃 micro events */
  function getActiveMicroEvents(time){
    const out = [];
    for(const ev of MICRO_TIMELINE){
      const startT = ev.t;
      const endT = ev.t + ev.dur;
      if(time >= startT && time < endT){
        const p = clamp((time - startT) / ev.dur, 0, 1);
        out.push({ ...ev, p, startT, endT });
      }
    }
    return out;
  }

  /* ===================== Micro Event → Card / Camera Offset ====================
     返回 {cameraOff, heroOff, cardOffs[i]}
     所有偏移都很小(0.5-3 像素级),保证画面持续变化但不破坏主要视觉。
   */
  function getMicroEffects(microEvents, time, cardIndexCount){
    const cameraOff = { x:0, y:0, z:0, rotX:0, rotY:0, scale:0 };
    const heroOff = { x:0, y:0, z:0, scale:0, opacity:0 };
    const cardOffs = new Array(cardIndexCount).fill(null).map(() => ({
      dx:0, dy:0, dz:0, drotZ:0, dscale:0, dopacity:0, dblur:0,
    }));
    for(const ev of microEvents){
      const p = ev.p;
      // easeOut:开始最强,慢慢消失
      const k = (1 - p) * Math.sin(p * Math.PI * 2);  // 0..1..0 振荡
      const easeK = 1 - p;
      switch(ev.type){
        case 'camera-push':{
          const f = easeK * 0.4;
          cameraOff.z += f * 12;
          cameraOff.scale += f * 0.008;
          break;
        }
        case 'camera-drift':{
          const f = (ev.seed % 2 === 0 ? 1 : -1) * easeK;
          cameraOff.x += f * 8;
          cameraOff.rotY += f * 0.4;
          break;
        }
        case 'depth-shift':{
          // 选择一张非 Hero 卡片
          const targetIdx = 1 + (ev.seed % 8);
          const f = easeK * 0.7;
          cardOffs[targetIdx].dz += f * 15;
          cardOffs[targetIdx].dscale += f * 0.04;
          break;
        }
        case 'lateral-drift':{
          // 选择一对卡片
          const idx1 = 1 + (ev.seed % 4);
          const idx2 = 5 + (ev.seed % 4);
          const f = (ev.seed % 2 === 0 ? 1 : -1) * easeK;
          cardOffs[idx1].dx += f * 18;
          cardOffs[idx2].dx -= f * 18;
          break;
        }
        case 'focus-pull':{
          // Hero scale 微变(电影 focus 抖动)
          const f = Math.sin(p * Math.PI) * 0.6;
          heroOff.scale += f * 0.02;
          for(let i=1;i<cardIndexCount;i++){
            cardOffs[i].dblur += f * 0.3;
            cardOffs[i].dopacity += f * 0.05;
          }
          break;
        }
        case 'hero-breathe':{
          const f = Math.sin(p * Math.PI);
          heroOff.scale += f * 0.015;
          heroOff.z += f * 8;
          break;
        }
        case 'side-card-tilt':{
          // 一张侧卡轻微 Z 倾斜
          const idx = 1 + (ev.seed % 8);
          const f = easeK;
          cardOffs[idx].drotZ += f * (ev.seed % 2 === 0 ? 1 : -1) * 1.2;
          cardOffs[idx].dz += f * 6;
          break;
        }
      }
    }
    return { cameraOff, heroOff, cardOffs };
  }

  /* ===================== Public API ==================== */
  window.MotionScheduler = {
    SCENE_SEED,
    PHASE_TABLE,
    getPhaseState,
    getAmbientForCard,
    getAmbientCamera,
    getAmbientHeroLight,
    getActiveMicroEvents,
    getMicroEffects,
    buildMicroTimeline,
    mulberry32,
  };
})();