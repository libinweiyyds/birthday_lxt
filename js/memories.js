/* ==================== Memory Director V5 ====================
   《特别的人》Cinematic Camera + Lyrics Sync Director Spec V5

   整体结构 — "摄影机在回忆中穿行":

     MusicTimeline    按歌词情绪切分 8 个 StyleStage(决定 slots/cardVisual/fx/typography)
     ShotTimeline     8 个 Sequence: Memory Discovery → Intimacy → Chorus Expansion
                     → Time Rewind → Memory Explosion → Waiting → Final Recognition → Afterglow
     LyricCues        53 个歌词触发点,每个带 motionType:
                       micro / emotion / key / time-rewind / final
     HeroLight        Hero Card 的 radial glow,opacity 跟随关键歌词
     EventTimeline    一次性的卡片动作(time-rewind / hero-depth-enter / background-crowd /
                     group-gather-outside / focus-pull / slow-push / depth-dive 等)

   设计原则:
     - 歌词 → 情绪 → Camera → Depth → Card → Light → Lyrics(完整视觉链)
     - 不是"歌词变化 = 照片切换",而是 Camera + Depth + Choreography 一起响应
     - Motion Density: 静→中→高→中→高→极低→高→低
     - 卡片不自身无限旋转/漂浮;Camera 是主要运动源
     - Hero 始终是视觉焦点,镜头时刻围绕 Hero 编舞
*/
(function(){
  'use strict';

  /* ===================== 工具 ===================== */
  const lerp       = (a,b,t) => a + (b-a) * t;
  const clamp      = (v,a,b) => v < a ? a : (v > b ? b : v);
  const smoothstep = t => t*t*(3 - 2*t);
  const damp       = (lambda, dt) => 1 - Math.exp(-lambda * dt);
  const TAU = Math.PI * 2;

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

  /* fx 元素初始全部 opacity:0,通过 CSS 变量 --fx-op 控制 */
  Object.values(dom.fx).forEach(el => { el.style.setProperty('--fx-op', '0'); el.classList.add('fx'); });

  /* ===================== Music Timeline =====================
     按歌词情绪切分 8 段,每段对应一个 StyleStage。
     最后一段延长到 totalDuration。 */
  function getTotalDuration(){
    return (window.musicBox && window.musicBox.totalDuration) || 259;
  }
  function getTimeline(){
    const total = getTotalDuration();
    const end   = Math.min(total, 259);
    return [0, 15, 55, 90, 115, 135, 170, 195, end];
  }
  const STYLE_SEQUENCE = ['cinematic','film','polaroid','editorial','collage','dream','glitch','constellation'];

  function getStageState(time){
    const tl = getTimeline();
    let idx = 0;
    for(let i=1;i<tl.length;i++){
      if(time >= tl[i]) idx = i;
      else break;
    }
    const fromName = STYLE_SEQUENCE[clamp(idx-1, 0, STYLE_SEQUENCE.length-1)];
    const toName   = STYLE_SEQUENCE[clamp(idx,   0, STYLE_SEQUENCE.length-1)];
    const start = tl[idx];
    const end   = tl[Math.min(idx+1, tl.length-1)];
    let progress = 1;
    if(idx > 0 && end > start){
      progress = clamp((time - start) / (end - start), 0, 1);
    }
    return { from:fromName, to:toName, progress, index:idx };
  }

  /* ===================== 照片索引 ===================== */
  function getCurrentPhotoIndex(){
    const t = window.musicBox ? window.musicBox.currentTime : 0;
    const total = getTotalDuration();
    const dur = total / (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42);
    return clamp(Math.floor(t / dur), 0, (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42) - 1);
  }
  function getPhotoSrc(idx){
    if(typeof imageUrls === 'undefined') return '';
    return imageUrls[clamp(idx, 0, imageUrls.length-1)] || '';
  }

  /* ===================== 双层 Image Buffer + 预加载 =====================
     每张 card 内部有两个 .card-img 层(A、B),通过 .visible 切换。
     切换流程:
       1. 当前显示 A
       2. 预加载 nextSrc 到 B(等 load 事件)
       3. B 加 .visible, A 移除 .visible(crossfade)
       4. 闲置层 A 准备下次
     永不直接给"正在显示"的层设 src(避免 broken image 状态)。
  */
  const NUM_CARDS = 9;

  /* 预加载队列:key = src, value = Image() 对象,加载完成时设置 .complete=true */
  const preloadCache = new Map();
  const brokenSet = new Set();
  function preloadImage(src){
    if(!src) return Promise.resolve(null);
    if(brokenSet.has(src)) return Promise.resolve(null);
    if(preloadCache.has(src)){
      const im = preloadCache.get(src);
      if(im.complete){
        // 404/失败的 image:complete=true 但 naturalWidth=0
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

  /* 每张 card 的 DOM 结构: <card> <img-A/> <img-B/> <caption/> </card>
     实际采用 div + background-image(避免 <img> 加载闪烁)。 */
  const cards = [];
  function buildCards(){
    for(let i=0;i<NUM_CARDS;i++){
      const el = document.createElement('div');
      el.className = 'memory-card';
      const imgA = document.createElement('div');
      const imgB = document.createElement('div');
      imgA.className = 'card-img visible'; // 默认 A 显示
      imgB.className = 'card-img';
      const cap = document.createElement('div');
      cap.className = 'caption';
      el.appendChild(imgA); el.appendChild(imgB); el.appendChild(cap);
      dom.cardsStack.appendChild(el);

      cards.push({
        el, imgA, imgB, cap,
        activeLayer:'A',          // 当前可见层是 A 还是 B
        currentSrc:'',            // 当前显示的 src
        // 每张卡片距 active photo 的距离(由 photoSync 计算)
        photoOffset:0,
        // 内插的目标 slot(由 StageState 提供)
        target:{x:0,y:0,z:0,w:300,h:400,rotX:0,rotY:0,rotZ:0,scale:1,blur:0,opacity:0,brightness:1,saturate:1},
        // 当前实时 lerp 值
        live:{x:0,y:0,z:0,w:300,h:400,rotX:0,rotY:0,rotZ:0,scale:1,blur:0,opacity:0,brightness:1,saturate:1},
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
      // 加载失败:回退到 fallback,避免卡片空白
      if(useSrc === FALLBACK_SRC) return;
      useSrc = FALLBACK_SRC;
      im = await preloadImage(useSrc);
      if(!im) return;
    }
    // 选择非 active 的层写入新 src
    const target = c.activeLayer === 'A' ? c.imgB : c.imgA;
    const hide   = c.activeLayer === 'A' ? c.imgA : c.imgB;
    target.style.backgroundImage = `url("${useSrc}")`;
    // 等下一帧再加 visible,触发 CSS transition crossfade
    requestAnimationFrame(() => {
      target.classList.add('visible');
      hide.classList.remove('visible');
      c.activeLayer = c.activeLayer === 'A' ? 'B' : 'A';
      c.currentSrc = useSrc;
    });
  }

  /* ===================== StyleStage 定义 =====================
     每个 stage 是"视觉意图"(决定 slots / cardVisual / fx / typography),
     不再包含 motionName / cameraPattern — Camera 运动交给 SHOT_TIMELINE。
       slots         Array<9> 每张 card 的目标 {x,y,z,w,h,rotX,rotY,rotZ,scale,blur,opacity,brightness,saturate}
                                x,y 是相对中心 % ; z 是 px 深度(0=近,-700=远)
       cardVisual    CSS 变量驱动 card 视觉 { bg, border, shadow, radius, imgFilter, caption }
       fxMap         { fxName: 0~1 }  哪些 fx 在该 stage 显示多强
       defaultShot   该 stage 默认 Camera Shot(实际由 SHOT_TIMELINE 决定)
       typography    body.class 后缀
       imgTreatment  'normal'|'grayscale'|'high-contrast'|'vintage'|'dreamy'

     每个 stage 通过不同 slots 实现"构图变化"和"景别变化":
       cinematic     中心 + 散布(MEDIUM)
       film          横向胶片带(WIDE)
       polaroid      倾斜散落(MEDIUM)
       editorial     主图偏左巨大 + 小图散布(CLOSE UP + 非对称)
       collage       多张密集,无单一焦点(WIDE)+ 前景遮挡
       dream         极深空间,照片漂浮(EXTREME WIDE)
       glitch        中心 + 错位(MEDIUM)
       constellation 远景小点(EXTREME WIDE)
  */
  /* 通用 slot helper:相对中心 % */
  function S(x,y,z,w,h,rotX,rotY,rotZ,scale,blur,opacity,brightness,saturate){
    return { x, y, z, w, h, rotX, rotY, rotZ, scale, blur, opacity, brightness, saturate };
  }
  const centerSlot = () => S(50, 50, 0, 300, 400, 0, 0, 0, 1.00, 0, 1.00, 1.05, 1.10);

  const STAGES = {
    cinematic:{
      // 中心 + 散布(MEDIUM 景别),Z 深度 -650 ~ 0
      slots:[
        S(50,50, 0,    320,420, 0, 0,  0,  1.00, 0,   1.00, 1.05, 1.10),
        S(24,48,-90,   240,320, 0, 0,  4,  0.82, 0.5, 0.80, 0.95, 1.00),
        S(76,52,-90,   240,320, 0, 0, -4, 0.82, 0.5, 0.80, 0.95, 1.00),
        S(10,45,-280,  180,240, 0, 0,  6,  0.62, 0.9, 0.45, 0.80, 0.85),
        S(90,55,-280,  180,240, 0, 0, -6, 0.62, 0.9, 0.45, 0.80, 0.85),
        S(5, 60,-480,  140,180, 0, 0,  3,  0.50, 1.2, 0.22, 0.70, 0.75),
        S(95,40,-480,  140,180, 0, 0, -3, 0.50, 1.2, 0.22, 0.70, 0.75),
        S(30,80,-650,  110,150, 0, 0,  2,  0.40, 1.4, 0.12, 0.60, 0.70),
        S(70,20,-650,  110,150, 0, 0, -2, 0.40, 1.4, 0.12, 0.60, 0.70),
      ],
      cardVisual:{
        bg:'rgba(255,245,248,0.95)',
        border:'2px solid #FFB7C5',
        shadow:'0 8px 32px rgba(0,0,0,0.15)',
        radius:'20px',
        imgFilter:'saturate(1.05)',
      },
      fxMap:{ leak:0.5, vignette:0.8, stars:0, grain:0, scan:0, rgb:0, particles:0.6 },
      defaultShot:'ESTABLISHING',
      typography:'cinematic',
      imgTreatment:'normal',
    },
    film:{
      // 横向胶片带(WIDE 景别):8 张卡横向排列,主图居中,远卡偏到视口外
      slots:[
        S(50,50, 0,    320,420, 0, 0, 0,  1.00, 0,   1,    1.05, 0.95),
        S(30,50,-60,   220,290, 0, 0, 0,  0.85, 0.3, 0.85, 1,    0.90),
        S(70,50,-60,   220,290, 0, 0, 0,  0.85, 0.3, 0.85, 1,    0.90),
        S(12,50,-180,  200,270, 0, 0, 0,  0.72, 0.6, 0.65, 0.90, 0.85),
        S(88,50,-180,  200,270, 0, 0, 0,  0.72, 0.6, 0.65, 0.90, 0.85),
        S(-6,50,-320,  180,240, 0, 0, 0,  0.60, 0.9, 0.40, 0.85, 0.80),
        S(106,50,-320, 180,240, 0, 0, 0,  0.60, 0.9, 0.40, 0.85, 0.80),
        S(-18,50,-450, 150,200, 0, 0, 0,  0.45, 1.2, 0.22, 0.75, 0.75),
        S(118,50,-450, 150,200, 0, 0, 0,  0.45, 1.2, 0.22, 0.75, 0.75),
      ],
      cardVisual:{
        bg:'transparent',
        border:'0 solid transparent',
        shadow:'inset 0 0 0 12px rgba(0,0,0,0.85)',  /* 仅 .is-main */
        radius:'0',
        imgFilter:'contrast(1.05) saturate(0.95)',
      },
      fxMap:{ leak:0.6, vignette:0.9, stars:0, grain:0.55, scan:0, rgb:0, particles:0.3 },
      defaultShot:'SIDE_TRACK',
      typography:'film',
      imgTreatment:'vintage',
    },
    polaroid:{
      // 倾斜散落(MEDIUM 景别)
      slots:[
        S(50,50, 10, 320,400, 0, 0,  0,  1.05, 0,  1,    1.05, 1.05),
        S(22,38,-30,  220,280, 0, 0, -6, 0.85, 0,  0.95, 1,    1),
        S(78,38,-30,  220,280, 0, 0,  6, 0.85, 0,  0.95, 1,    1),
        S(18,74,-80,  200,250, 0, 0,  4, 0.78, 0,  0.90, 0.95, 0.95),
        S(82,74,-80,  200,250, 0, 0, -4, 0.78, 0,  0.90, 0.95, 0.95),
        S(36,80,-160, 170,210, 0, 0, -2, 0.65, 0,  0.70, 0.90, 0.90),
        S(64,18,-160, 170,210, 0, 0,  3, 0.65, 0,  0.70, 0.90, 0.90),
        S(8, 55,-280, 140,180, 0, 0,  5, 0.50, 0,  0.45, 0.80, 0.80),
        S(92,50,-280, 140,180, 0, 0, -5, 0.50, 0,  0.45, 0.80, 0.80),
      ],
      cardVisual:{
        bg:'#fff',
        border:'1px solid rgba(0,0,0,0.08)',
        shadow:'0 18px 40px rgba(0,0,0,0.35),0 4px 10px rgba(0,0,0,0.18)',  /* 仅 .is-main */
        radius:'4px',
        imgFilter:'none',
      },
      fxMap:{ leak:0.4, vignette:0.7, stars:0, grain:0, scan:0, rgb:0, particles:0.2 },
      defaultShot:'CRANE',
      typography:'polaroid',
      imgTreatment:'normal',
    },
    editorial:{
      // 非对称构图:主图偏左巨大 + 小图散布(CLOSE UP + 非对称)
      slots:[
        S(36,50, 0,   560,440, 0, 0, 0,   1.00, 0,  1,    1.05, 0.95),
        S(78,28,-80,  200,260, 0, 0, 2,   0.78, 0,  0.85, 1,    0.95),
        S(78,72,-80,  200,260, 0, 0,-2,   0.78, 0,  0.85, 1,    0.95),
        S(18,15,-180, 130,170, 0, 0, 3,   0.65, 0.4,0.60, 0.95, 0.90),
        S(88,15,-180, 130,170, 0, 0,-3,   0.65, 0.4,0.60, 0.95, 0.90),
        S(8, 50,-260, 110,140, 0, 0, 0,   0.55, 0.8,0.40, 0.85, 0.85),
        S(85,88,-260, 110,140, 0, 0, 0,   0.55, 0.8,0.40, 0.85, 0.85),
        S(50,8, -340, 100,130, 0, 0, 0,   0.45, 1.0,0.30, 0.80, 0.80),
        S(50,92,-340, 100,130, 0, 0, 0,   0.45, 1.0,0.30, 0.80, 0.80),
      ],
      cardVisual:{
        bg:'transparent',
        border:'0 solid transparent',
        shadow:'none',
        radius:'0',
        imgFilter:'contrast(1.1) saturate(0.9)',
      },
      fxMap:{ leak:0.3, vignette:0.8, stars:0, grain:0, scan:0, rgb:0, particles:0.1 },
      defaultShot:'PUSH_RACK_FOCUS',
      typography:'editorial',
      imgTreatment:'high-contrast',
    },
    collage:{
      // 多张密集分布,无单一焦点(WIDE)+ 前景遮挡(slot 9 z=80 在镜头前)
      slots:[
        S(42,40, 0,   260,330, 0, 0,-3,  1.0, 0,  1,    1.05, 1.0),
        S(58,40,-20,  260,330, 0, 0, 2,  1.0, 0,  0.95, 1,    1.0),
        S(42,60,-20,  260,330, 0, 0, 3,  1.0, 0,  0.95, 1,    1.0),
        S(58,60,-40,  260,330, 0, 0,-2,  1.0, 0,  0.95, 1,    1.0),
        S(14,18,-100, 140,180, 0, 0,-10, 0.8, 0.4,0.85, 1,    1),
        S(86,22,-100, 140,180, 0, 0,12,  0.8, 0.4,0.85, 1,    1),
        S(18,84,-100, 140,180, 0, 0, 9,  0.8, 0.4,0.85, 1,    1),
        S(84,80,-120, 140,180, 0, 0,-13, 0.8, 0.4,0.85, 1,    1),
        S(50,50, 80,  120,150, 0, 0, 0,  0.9, 0,  0,    1,    1),  // 前景遮挡(z=80 在镜头前)
      ],
      cardVisual:{
        bg:'#fff',
        border:'2px solid #fff',
        shadow:'0 12px 30px rgba(0,0,0,0.3)',  /* 仅 .is-main */
        radius:'0',
        imgFilter:'none',
      },
      fxMap:{ leak:0.2, vignette:0.7, stars:0, grain:0, scan:0, rgb:0, particles:0.15 },
      defaultShot:'DOLLY_THROUGH',
      typography:'collage',
      imgTreatment:'normal',
    },
    dream:{
      // 极深空间,照片漂浮(EXTREME WIDE 景别),Z 深度 -700 ~ 0
      slots:[
        S(50,50, 0,    340,440, 0, 0, 0,  1.0, 0,   0.95, 1.10, 1.15),
        S(28,40,-150,  240,320, 0, 0,-5, 0.80, 0.5, 0.70, 1.00, 1.10),
        S(72,60,-150,  240,320, 0, 0, 6, 0.80, 0.5, 0.70, 1.00, 1.10),
        S(18,70,-350,  200,260, 0, 0, 7, 0.65, 1.0, 0.50, 0.95, 1.05),
        S(82,30,-350,  200,260, 0, 0,-6, 0.65, 1.0, 0.50, 0.95, 1.05),
        S(40,85,-550,  170,220, 0, 0,-3, 0.50, 1.3, 0.30, 0.90, 1.00),
        S(60,15,-550,  170,220, 0, 0, 3, 0.50, 1.3, 0.30, 0.90, 1.00),
        S(5, 50,-700,  140,180, 0, 0, 0, 0.40, 1.5, 0.20, 0.85, 0.95),
        S(95,50,-700,  140,180, 0, 0, 0, 0.40, 1.5, 0.20, 0.85, 0.95),
      ],
      cardVisual:{
        bg:'transparent',
        border:'0 solid transparent',
        shadow:'none',
        radius:'18px',
        imgFilter:'saturate(1.05) brightness(1.0)',
      },
      fxMap:{ leak:0.7, vignette:0.6, stars:0, grain:0, scan:0, rgb:0, particles:0.5 },
      defaultShot:'PULL_AWAY',
      typography:'dream',
      imgTreatment:'dreamy',
    },
    glitch:{
      // 中心 + 错位(MEDIUM 景别)
      slots:[
        S(50,50, 0,    300,380, 0, 0,  0,  1.0, 0,   1,    1.10, 1.20),
        S(24,48,-100,  220,300, 0, 0, -7, 0.85, 0.4, 0.90, 1.05, 1.15),
        S(76,52,-100,  220,300, 0, 0,  8, 0.85, 0.4, 0.90, 1.05, 1.15),
        S(14,38,-280,  180,240, 0, 0,-12, 0.70, 0.7, 0.65, 0.95, 1.10),
        S(86,62,-280,  180,240, 0, 0, 11, 0.70, 0.7, 0.65, 0.95, 1.10),
        S(35,82,-440,  160,210, 0, 0,  5, 0.55, 1.0, 0.45, 0.85, 1.05),
        S(65,18,-440,  160,210, 0, 0, -4, 0.55, 1.0, 0.45, 0.85, 1.05),
        S(8, 55,-580,  140,180, 0, 0,  3, 0.45, 1.2, 0.25, 0.75, 1.00),
        S(92,45,-580,  140,180, 0, 0, -3, 0.45, 1.2, 0.25, 0.75, 1.00),
      ],
      cardVisual:{
        bg:'transparent',
        border:'1px solid rgba(255,80,140,0.6)',  /* 仅 .is-main */
        shadow:'0 0 18px rgba(255,80,140,0.35)',  /* 仅 .is-main */
        radius:'0',
        imgFilter:'contrast(1.15) saturate(1.1)',
      },
      fxMap:{ leak:0, vignette:0.7, stars:0, grain:0, scan:0.7, rgb:0.5, particles:0.1 },
      defaultShot:'SNAP_ZOOM',
      typography:'glitch',
      imgTreatment:'high-contrast',
    },
    constellation:{
      // 远景小点(EXTREME WIDE 景别),Z 深度最深
      slots:[
        S(50,50, 0,    260,340, 0, 0, 0,  1.0, 0,   1,    1.0,  0.90),
        S(20,30,-150,  160,210, 0, 0, 5,  0.70, 0.6, 0.80, 0.90, 0.85),
        S(80,70,-150,  160,210, 0, 0,-6,  0.70, 0.6, 0.80, 0.90, 0.85),
        S(85,24,-280,  130,170, 0, 0, 8,  0.55, 1.0, 0.60, 0.85, 0.80),
        S(15,76,-280,  130,170, 0, 0,-8,  0.55, 1.0, 0.60, 0.85, 0.80),
        S(48,12,-400,  110,140, 0, 0, 3,  0.45, 1.2, 0.45, 0.80, 0.75),
        S(52,88,-400,  110,140, 0, 0,-3,  0.45, 1.2, 0.45, 0.80, 0.75),
        S(8, 50,-550,   90,120, 0, 0, 0,  0.35, 1.4, 0.30, 0.75, 0.70),
        S(92,50,-550,   90,120, 0, 0, 0,  0.35, 1.4, 0.30, 0.75, 0.70),
      ],
      cardVisual:{
        bg:'transparent',
        border:'1px solid rgba(255,255,255,0.18)',  /* 仅 .is-main */
        shadow:'0 0 40px rgba(200,180,255,0.35)',   /* 仅 .is-main */
        radius:'6px',
        imgFilter:'brightness(0.92) saturate(0.9)',
      },
      fxMap:{ leak:0, vignette:0.5, stars:0.9, grain:0, scan:0, rgb:0, particles:0.8 },
      defaultShot:'ORBIT',
      typography:'constellation',
      imgTreatment:'normal',
    },
  };

  /* ===================== Image Treatment =====================
     把 imgTreatment 翻译成具体的 CSS filter 字符串,
     与 cardVisual.imgFilter 合并 */
  function applyImageTreatment(treatment, baseFilter){
    const map = {
      'normal': '',
      'grayscale': 'grayscale(1)',
      'high-contrast': 'contrast(1.2)',
      'vintage': 'sepia(0.15) contrast(1.05) saturate(0.9)',
      'dreamy': 'saturate(1.15) brightness(1.05)',
    };
    const t = map[treatment] || '';
    if(!baseFilter) return t;
    if(!t) return baseFilter;
    return baseFilter + ' ' + t;
  }

  /* ===================== Speed Curve 库 =====================
     easeIn: 加速起步
     easeOut: 减速收尾
     easeInOut: S 曲线
     overshoot: overshoot 后 settle(关键帧)
  */
  const CURVES = {
    easeIn:    t => t*t,
    easeOut:   t => 1 - (1-t)*(1-t),
    easeInOut: t => t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2, 2)/2,
    overshoot: t => {
      const c = 1.70158;
      return 1 + (c+1)*Math.pow(t-1,3) + c*Math.pow(t-1,2);
    },
    smoothstep: t => t*t*(3-2*t),
  };

  /* ===================== Camera Shot 系统 ====================
     10 种一次性 Shot,每个 Shot 在生命周期内 [0,1] 进度有不同运动。
     每个 Shot 函数接收 (p, t, ctx) 返回 { cam, focusIdx }:
       p          Shot 进度 0..1(由 SHOT_TIMELINE 计算)
       t          全局时间(秒,用于 ambient breathing)
       ctx        { cardZ: Array<9> } 用于 parallax 计算
     cam 包含 { x, y, z, rotX, rotY, scale }(都是 px / deg / 倍率)
     focusIdx   Rack Focus 焦点(只 PUSH_RACK_FOCUS 用)

     设计原则:
       - 每个 Shot 是一次性曲线(easeInOut / overshoot / easeOut),
         不会无限循环
       - Camera 是主要运动源
       - 卡片不旋转,只跟随相机做小幅 parallax
  */
  const SHOTS = {
    /* 01 ESTABLISHING — 几乎静止,只有 ambient breathing(开场) */
    ESTABLISHING: (p, t) => ({
      cam: {
        x: Math.sin(t*0.04)*3 + Math.sin(t*0.025)*1.5,
        y: Math.sin(t*0.05)*2 + Math.sin(t*0.03)*1,
        z: 0, rotX: 0, rotY: 0, scale: 1,
      },
    }),
    /* 02 PUSH_IN — Camera 缓慢向前推进 5~12s */
    PUSH_IN: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: Math.sin(t*0.05)*2,
          y: Math.sin(t*0.04)*1.5,
          z: k * 200,
          rotX: Math.sin(t*0.03)*0.3,
          rotY: 0,
          scale: 1 + k*0.05,
        },
      };
    },
    /* 03 SIDE_TRACK — 摄影机横向移动 -200 → +200 */
    SIDE_TRACK: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: -200 + k*400 + Math.sin(t*0.05)*2,
          y: Math.sin(t*0.04)*1,
          z: 0, rotX: 0,
          rotY: Math.sin(t*0.03)*0.3,
          scale: 1,
        },
      };
    },
    /* 04 DOLLY_THROUGH — 摄影机直接穿过照片空间(z 0 → 800)
          近卡快速从镜头边缘掠过,远卡几乎不动 */
    DOLLY_THROUGH: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: Math.sin(t*0.05)*1.5,
          y: Math.sin(t*0.04)*1,
          z: k * 800,
          rotX: 0, rotY: 0,
          scale: 1,
        },
      };
    },
    /* 05 ORBIT — 极小角度轨道运动 rotY -4 → +4,12~20s */
    ORBIT: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: Math.sin(t*0.05)*1.5,
          y: Math.sin(t*0.04)*1,
          z: 0,
          rotX: Math.sin(t*0.03)*0.2,
          rotY: -4 + k*8,
          scale: 1,
        },
      };
    },
    /* 06 CRANE — 摄影机轻微上升 + 俯视,然后下降(三角形) */
    CRANE: (p, t) => {
      const triangle = p < 0.5 ? p*2 : (1-p)*2;
      return {
        cam: {
          x: Math.sin(t*0.05)*1,
          y: -triangle*60,
          z: 0,
          rotX: triangle*4,  // 略俯视
          rotY: 0,
          scale: 1,
        },
      };
    },
    /* 07 PUSH_RACK_FOCUS — 推进 + 焦点切换 Photo A → B → C */
    PUSH_RACK_FOCUS: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: Math.sin(t*0.05)*1,
          y: Math.sin(t*0.04)*0.8,
          z: k * 120,
          rotX: 0, rotY: 0,
          scale: 1 + k*0.06,
        },
        focusIdx: Math.floor(k * 4.99),  // 0→1→2→3→4 焦点漫游
      };
    },
    /* 08 SNAP_ZOOM — 250~450ms 突然推进,overshoot 后 settle
          只用于关键音乐节点(副歌/重音) */
    SNAP_ZOOM: (p, t) => {
      if(p < 0.4){
        const k = p/0.4;
        return {
          cam: {
            x: 0, y: 0, z: 0, rotX: 0, rotY: 0,
            scale: 1 + CURVES.overshoot(k)*0.18,
          },
        };
      }
      const k = (p-0.4)/0.6;
      return {
        cam: {
          x: 0, y: 0, z: 0, rotX: 0, rotY: 0,
          scale: 1.18 - k*0.18,
        },
      };
    },
    /* 09 PULL_AWAY — 摄影机快速拉远,照片群 → 空间 → 星空 */
    PULL_AWAY: (p, t) => {
      const k = CURVES.easeOut(p);
      return {
        cam: {
          x: Math.sin(t*0.04)*2,
          y: Math.sin(t*0.05)*1.5,
          z: -k * 400,
          rotX: 0, rotY: 0,
          scale: 1 - k*0.15,
        },
      };
    },
    /* 10 STILLNESS — 所有照片几乎停止,只有 ambient breathing + particle
          Motion → Stillness → Motion 形成节奏 */
    STILLNESS: (p, t) => ({
      cam: {
        x: Math.sin(t*0.04)*1.5,
        y: Math.sin(t*0.05)*1,
        z: 0, rotX: 0, rotY: 0, scale: 1,
      },
    }),
    /* 11 MICRO_PULL — 极短 350ms 的轻微拉远,Spec V5 用作"被拉开"的视觉 */
    MICRO_PULL: (p, t) => {
      // 整体只持续 ~1.5s,然后归零返回
      const k = p < 0.3 ? p/0.3 : (1 - (p-0.3)/0.7);
      return {
        cam: {
          x: Math.sin(t*0.04)*1.5 + 15 * k,
          y: Math.sin(t*0.05)*1,
          z: -k * 30,
          rotX: 0, rotY: 0,
          scale: 1 - k*0.015,
        },
      };
    },
    /* 12 SLOW_PUSH — 比 PUSH_IN 更慢、更长的推进(Spec V5:Long Push for "而我曾经多次的等待未来") */
    SLOW_PUSH: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: Math.sin(t*0.04)*1.5,
          y: Math.sin(t*0.05)*1,
          z: k * 90,        // 推进更少
          rotX: 0, rotY: 0,
          scale: 1 + k*0.035,
        },
      };
    },
    /* 13 LATERAL_TRACK — 摄影机横向缓慢漂移(Spec V5:"今后的岁月") */
    LATERAL_TRACK: (p, t) => {
      // 短 lateral,避免太宽
      const k = CURVES.easeInOut(p);
      const dir = (Math.floor(t) % 2 === 0) ? 1 : -1;
      return {
        cam: {
          x: -80 + k * 160 * dir + Math.sin(t*0.04)*1.5,
          y: Math.sin(t*0.05)*1,
          z: 0, rotX: 0,
          rotY: 0,
          scale: 1,
        },
      };
    },
    /* 14 REVERSE_PARALLAX — 反向视差(Spec V5:"让那时间每一刻在倒退")
          摄影机 Pull,所有照片整体产生"远离"的方向,但深度反向 */
    REVERSE_PARALLAX: (p, t) => {
      const k = CURVES.easeOut(p);
      return {
        cam: {
          x: Math.sin(t*0.04)*1,
          y: Math.sin(t*0.05)*0.8,
          z: -k * 250,
          rotX: 0, rotY: 0,
          scale: 1 - k*0.08,
        },
      };
    },
    /* 15 HERO_DEPTH_ENTER — Hero 从极远进入前景(Spec V5:"总有你的存在") */
    HERO_DEPTH_ENTER: (p, t) => {
      const k = CURVES.easeInOut(p);
      return {
        cam: {
          x: Math.sin(t*0.04)*1.5,
          y: Math.sin(t*0.05)*1,
          z: -k * 100,   // 推进前略拉远
          rotX: 0, rotY: 0,
          scale: 1 + k*0.06,
        },
      };
    },
  };

  /* ===================== Shot Timeline ====================
     按音乐时间切分若干一次性 Shot,每个 Shot 持续到下一个 Shot 开始。
     时间点根据现有 8 个 Stage timeline 对齐,确保运动服从音乐情绪:
       cinematic (0-15s):  ESTABLISHING → PUSH_IN → STILLNESS
       film (15-55s):     SIDE_TRACK → DOLLY_THROUGH → PULL_AWAY → ORBIT
       polaroid (55-90s): CRANE → ORBIT → STILLNESS → SIDE_TRACK
       editorial (90-115):PUSH_RACK_FOCUS → STILLNESS → SIDE_TRACK
       collage (115-135):DOLLY_THROUGH → SNAP_ZOOM → ORBIT → STILLNESS
       dream (135-170):   PULL_AWAY → STILLNESS → PUSH_RACK_FOCUS → ORBIT
       glitch (170-195):  SNAP_ZOOM → DOLLY_THROUGH → SIDE_TRACK
       constellation (195-259): PULL_AWAY → STILLNESS → ORBIT → STILLNESS → PULL_AWAY(收尾)
  */
  /* ===================== Shot Timeline (Director Spec V5) ====================
     8 个 Sequence 严格按歌词结构划分:

     01 Memory Discovery       0:00–0:15   建立空间 + Perspective Sweep + Stillness
     02 Intimacy              0:15–0:42   Camera Push + Focus Pull + Group Lateral Tracking
     03 Chorus Expansion      1:08–1:30   Hero Reveal + Group Gather + Snap Zoom
     04 Time Rewind (1)       1:29–1:38   Reverse Parallax + Old Memory Enter
     04b Chorus Outro         1:38–1:44   Hero Light + Stillness Hit
     05 Second Verse          1:48–2:13   Lateral Track + Depth Dive + Camera Pass
     06 Memory Explosion      2:13–2:38   Camera Pass + Group Gather + Time Rewind
     06b Foreground Cover     2:38–2:50   Foreground Pass + Hero Swap
     07 Waiting (Bridge)      2:50–3:18   Pull + Long Push + Background Crowd + HERO ARRIVAL
     08 Final Recognition     3:18–3:49   Hero Reveal + Reassemble + Final Slow Push
     09 Afterglow             3:49–4:19   Slow Pull + Star Dust + Final Stillness

     每个 Shot 仍然是一次性曲线(easeInOut / easeOut / overshoot),不循环。
  */
  const SHOT_TIMELINE = [
    // === Sequence 01 Memory Discovery (0:00–0:15) ===
    { t: 0,      shot: 'ESTABLISHING' },       // 开场静
    { t: 4,      shot: 'SLOW_PUSH' },           // 第一批 Background Cards 出现
    { t: 8,      shot: 'PUSH_IN' },             // 摄影机向空间深处移动
    { t: 12,     shot: 'STILLNESS' },           // 照片稳定,歌词即将开始

    // === Sequence 02 Intimacy (0:15–0:42) ===
    { t: 15,     shot: 'PUSH_IN' },             // "爱一个人或许要慷慨" Hero 第一次靠近
    { t: 20,     shot: 'STILLNESS' },           // "若只想要被爱" 收
    { t: 22,     shot: 'PUSH_RACK_FOCUS' },     // "最后没有了对白" Focus Pull
    { t: 27,     shot: 'PUSH_RACK_FOCUS' },     // "必须有你我的情真" Focus 回来
    { t: 31,     shot: 'LATERAL_TRACK' },       // "不求计分的平等" Lateral Tracking
    { t: 34,     shot: 'STILLNESS' },           // "总有幸福有心疼" 双层照片编舞
    { t: 38,     shot: 'PULL_AWAY' },           // "生命的起伏要认可" Camera 微微 Pull
    { t: 41,     shot: 'STILLNESS' },           // 段末约 600ms Stillness

    // === Sequence 03 Chorus Expansion (1:08–1:30) ===
    { t: 42,     shot: 'STILLNESS' },           // 续上,持续到副歌前
    { t: 68,     shot: 'PUSH_IN' },             // "我们是对方 特别的人" Hero Reveal
    { t: 75,     shot: 'PUSH_IN' },             // "奋不顾身 难舍难分" Group Motion (slow push)
    { t: 78,     shot: 'STILLNESS' },           // "不是一般人的认真" Stillness Hit 500ms
    { t: 82,     shot: 'PULL_AWAY' },           // "若只有一天" Camera Pull (Dolly Zoom 感)
    { t: 89,     shot: 'REVERSE_PARALLAX' },    // "让那时间每一刻在倒退" Time Rewind (1)

    // === Sequence 03b Chorus Outro (1:38–1:48) ===
    { t: 93,     shot: 'PULL_AWAY' },           // "生命中有万事的可能" 空间扩大
    { t: 98,     shot: 'PULL_AWAY' },           // "你就是我要遇见的 特别的人" Hero Isolation
    { t: 100,    shot: 'STILLNESS' },           // 800ms Stillness

    // === Sequence 04 Second Verse (1:48–2:13) ===
    { t: 108,    shot: 'LATERAL_TRACK' },       // "懂一个人也许要忍耐" Slow Drift Right
    { t: 113,    shot: 'PULL_AWAY' },           // "要经过了意外" Depth Dive 起点
    { t: 115,    shot: 'PUSH_IN' },             // "才了解所谓的爱" Focus
    { t: 119,    shot: 'LATERAL_TRACK' },       // "今后的岁月" Lateral
    { t: 122,    shot: 'STILLNESS' },           // "让我们一起了解" 两侧靠近
    { t: 125,    shot: 'PULL_AWAY' },           // "多少天长地久" Camera Pull
    { t: 128,    shot: 'STILLNESS' },           // "有几回细水长流" 600-900ms Stillness

    // === Sequence 05 Memory Explosion (2:13–2:38) ===
    { t: 133,    shot: 'PUSH_IN' },             // "我们是对方 特别的人" Camera Pass + Hero Reveal
    { t: 140,    shot: 'PUSH_IN' },             // "奋不顾身" Group Gather
    { t: 144,    shot: 'STILLNESS' },           // "不是一般人的认真" 400-600ms 静止
    { t: 147,    shot: 'PULL_AWAY' },           // "若只有一天" Hero 轻微后退
    { t: 154,    shot: 'REVERSE_PARALLAX' },    // "让那时间每一刻在倒退" Time Rewind (2)

    // === Sequence 05b Foreground Cover (2:38–2:50) ===
    { t: 158,    shot: 'PULL_AWAY' },           // "生命中有万事的可能" 空间打开
    { t: 163,    shot: 'PUSH_IN' },             // "你就是我要遇见的" Foreground Pass + Hero Swap
    { t: 167,    shot: 'STILLNESS' },           // Foreground 离场后短暂静止

    // === Sequence 06 Waiting / Bridge (2:50–3:18) ===
    { t: 170,    shot: 'PULL_AWAY' },           // "有时候我们都会寂寞" Pull
    { t: 174,    shot: 'PULL_AWAY' },           // "有时也会失败" Hero 主动远离
    { t: 179,    shot: 'LATERAL_TRACK' },       // "想去找一个明白" 横移
    { t: 182,    shot: 'SLOW_PUSH' },           // "而我曾经多次的等待未来" Long Push
    { t: 188,    shot: 'STILLNESS' },           // "你何时会来" 800ms Stillness(全曲最重要的等待)
    { t: 191,    shot: 'STILLNESS' },           // "人山人海" Background Cards Staggered Enter
    { t: 196,    shot: 'HERO_DEPTH_ENTER' },    // "有你我的爱" Hero Arrival
    { t: 197,    shot: 'SLOW_PUSH' },           // "我们是对方 特别的人" Last Chorus 入口

    // === Sequence 07 Final Recognition (3:18–3:49) ===
    { t: 205,    shot: 'PUSH_IN' },             // "奋不顾身" Reassemble
    { t: 209,    shot: 'STILLNESS' },           // "不是一般人的认真" Settle
    { t: 212,    shot: 'PULL_AWAY' },           // "若只有一天" Pull + Reverse Parallax
    { t: 219,    shot: 'REVERSE_PARALLAX' },    // "让那时间每一刻在倒退" 第三次 Time Rewind (轻量)
    { t: 223,    shot: 'PULL_AWAY' },           // "生命中有万事的可能" 完整展示 Memory Space
    { t: 228,    shot: 'PUSH_IN' },             // "你就是我要遇见的" 最终 Slow Push + Hero Light
    { t: 232,    shot: 'STILLNESS' },           // 静止

    // === Sequence 08 Afterglow (3:49–4:19) ===
    { t: 235,    shot: 'PULL_AWAY' },           // 非常轻的 Camera Pull
    { t: 240,    shot: 'STILLNESS' },           // Hero 恢复稳定
    { t: 245,    shot: 'STILLNESS' },           // Star Dust + 极轻微 drift
    { t: 252,    shot: 'PULL_AWAY' },           // 一张旧照片从 Background 缓慢出现
    { t: 256,    shot: 'STILLNESS' },           // Very Slow Pull
    { t: 259,    shot: 'STILLNESS' },           // 最终静止
  ];

  /* 获取当前 Shot 状态:shot 名 + 0..1 进度 */
  function getShotState(time){
    let idx = 0;
    for(let i=1;i<SHOT_TIMELINE.length;i++){
      if(time >= SHOT_TIMELINE[i].t) idx = i;
      else break;
    }
    const start = SHOT_TIMELINE[idx].t;
    const end   = idx + 1 < SHOT_TIMELINE.length
                  ? SHOT_TIMELINE[idx+1].t
                  : getTotalDuration();
    const progress = end > start ? clamp((time - start) / (end - start), 0, 1) : 0;
    return { shot: SHOT_TIMELINE[idx].shot, progress, start, end };
  }

  /* ===================== Motion Events(事件驱动的卡片编舞)====================
     在 Shot Timeline 之上叠加一次性"事件",触发特定卡片做特殊动作。
     事件类型:
       card-enter        指定卡片从特定方向飞入(ENTER_PRESET)
       foreground-pass   指定卡片从镜头前掠过(scale 1.5+,z=+200,横穿屏幕)
       scatter           所有外围卡片向外飞散(stagger 80~180ms)
       reassemble        散开的卡片重新汇聚(stagger,反向 scatter)
       card-fly          指定卡片从远处飞到镜头前再飞走

     事件特性:
       - 一次性曲线(easeOut / overshoot / easeInOut),不循环
       - duration 700~1400ms
       - 与 SHOT_TIMELINE 共存:事件叠加在 slot 计算后的 target 上
       - 由 SHOT_TIMELINE 决定的大场景 + 由 EVENT_TIMELINE 决定的小事件
  */
  const ENTER_PRESETS = {
    /* 8 种 ENTER PRESET:不同卡片可用不同方式进入画面
       dx/dy/dz = 起始偏移(px),drz = 起始旋转,scale = 起始缩放,
       dur = 进入时长(ms),easing = 曲线
    */
    'fly-left':      { dx:-500, dy: 30,  dz:-200, drz:-10, scale:0.7, dur:1100, easing:'easeOut' },
    'fly-right':     { dx: 500, dy:-30,  dz:-200, drz: 10, scale:0.7, dur:1100, easing:'easeOut' },
    'drop-top':      { dx:  0,  dy:-500, dz:-150, drz:  0, scale:0.7, dur:1000, easing:'easeOut' },
    'rise-bottom':   { dx:  0,  dy: 500, dz:-150, drz:  0, scale:0.7, dur:1000, easing:'easeOut' },
    'diagonal-in':   { dx:-400, dy:-300, dz:-250, drz:-6,  scale:0.65,dur:1200, easing:'easeOut' },
    'depth-in':      { dx:  0,  dy:  0,  dz:-700, drz: 0,  scale:0.55,dur:1300, easing:'easeInOut' },
    'depth-out':     { dx:  0,  dy:  0,  dz: 700,  drz: 0,  scale:0.5, dur:1400, easing:'easeInOut' },
    'rotate-reveal': { dx:-200, dy: 100, dz:-150, drz:-25, scale:0.7, dur:1200, easing:'overshoot' },
  };

  /* 事件时间轴 — 与 SHOT_TIMELINE 共存,在重要音乐节点触发
     foreground-pass 使用可见卡片(1/2/3),让前景掠过明显可见
     card-fly 在重要音乐节点触发(副歌/段落切换),戏剧性最高 */
  /* ===================== Lyric Cues + Motion Events (Director Spec V5) ====================
   V5 把 Shot 和 Event 完全歌词化:歌词出现 → 触发 Camera/Card/Light。

   LYRIC_CUES:每个歌词触发点带 motionType(micro/emotion/key/time-rewind/final)
   与 LYRICS_DATA 中的 time 一一对应(0.0~0.5s offset)。

   新增 Event 类型:
     hero-reveal / hero-depth-enter / hero-flee / hero-recover / hero-settle /
     hero-zoom-in / hero-secondary / background-crowd / group-gather /
     group-gather-outside / focus-pull / slow-push / long-push / micro-pull /
     camera-pull / pull-reverse-parallax / depth-dive / secondary-drift /
     lateral-track / lateral-balance / lateral-couple / soft-perspective-enter /
     time-rewind / past-to-present / bg-fade / stillness-hit /
     memory-space-open / final-slow-push / afterglow-pull /
     afterglow-memories / lyrics-focus / foreground-cover-swap / old-memory-enter
*/

  /* ===================== Event Default Duration ====================
     每种事件类型的默认持续时间(ms)。
     LYRIC_CUES 中 events 数组里的 dur 会优先覆盖这里的默认值。 */
  const EVENT_DEFAULT_DURATION = {
    'card-enter':           1200,
    'foreground-pass':      1000,
    'foreground-cover-swap':1500,
    'scatter':              900,
    'reassemble':           1100,
    'card-fly':             1400,
    'hero-reveal':          1400,
    'camera-pass-hero-reveal': 1400,
    'hero-depth-enter':     1600,
    'background-crowd':     1800,
    'group-gather':         1200,
    'group-gather-outside': 1200,
    'focus-pull':           1100,
    'slow-push':            1600,
    'long-push':            1500,
    'micro-pull':           1400,
    'camera-pull':          1100,
    'pull-reverse-parallax':1400,
    'depth-dive':           1400,
    'secondary-drift':      900,
    'lateral-track':        3000,
    'lateral-balance':      1500,
    'lateral-couple':       1500,
    'soft-perspective-enter':1400,
    'hero-zoom-in':         1300,
    'hero-settle':          1100,
    'hero-secondary':       1200,
    'hero-flee':            1500,
    'hero-light':           1500,
    'hero-recover':         2000,
    'old-memory-enter':     1700,
    'time-rewind':          1700,
    'past-to-present':      1300,
    'bg-fade':              2000,
    'stillness-hit':        800,
    'memory-space-open':    1500,
    'final-slow-push':      2200,
    'afterglow-pull':       2500,
    'afterglow-memories':   3500,
    'lyrics-focus':         1800,
  };

const LYRIC_CUES = [
  // === Verse 1 (15-42) ===
  { idx:0,  motionType:'micro',  events:[] },
  { idx:1,  motionType:'emotion',events:[{type:'micro-pull', dur:1400}] },
  { idx:2,  motionType:'emotion',events:[{type:'focus-pull', dir:'away', dur:1200}] },
  { idx:3,  motionType:'key',    events:[{type:'focus-pull', dir:'back', dur:1100},{type:'secondary-drift', dur:900}] },
  { idx:4,  motionType:'micro',  events:[{type:'lateral-balance', dur:1500}] },
  { idx:5,  motionType:'key',    events:[{type:'depth-dive', card:1, dur:1300},{type:'card-enter', card:2, preset:'fly-left', dur:1200}] },
  { idx:6,  motionType:'emotion',events:[{type:'micro-pull', dur:1300}] },
  { idx:7,  motionType:'micro',  events:[] },
  { idx:8,  motionType:'micro',  events:[{type:'micro-pull', dur:350}] },
  { idx:9,  motionType:'emotion',events:[{type:'hero-settle', dur:1100}] },
  { idx:10, motionType:'micro',  events:[{type:'lateral-track', dur:3000}] },
  { idx:11, motionType:'micro',  events:[{type:'soft-perspective-enter', card:3, dur:1400}] },
  { idx:12, motionType:'emotion',events:[{type:'hero-zoom-in', dur:1300}] },
  { idx:13, motionType:'emotion',events:[{type:'slow-push', dur:1600},{type:'bg-fade', amount:0.12}] },

  // === Verse 2 (68-98) — First Chorus ===
  { idx:14, motionType:'key',    events:[{type:'hero-reveal', dur:1400},{type:'card-enter', card:1, preset:'fly-left', dur:1100},{type:'card-enter', card:2, preset:'diagonal-in', dur:1100}] },
  { idx:15, motionType:'key',    events:[{type:'group-gather', dur:1200, stagger:120}] },
  { idx:16, motionType:'emotion',events:[{type:'stillness-hit', dur:500}] },
  { idx:17, motionType:'emotion',events:[{type:'camera-pull', amount:0.10, dur:1100}] },
  { idx:18, motionType:'time-rewind',events:[{type:'time-rewind', dur:1700},{type:'old-memory-enter', dur:1700}] },
  { idx:19, motionType:'emotion',events:[{type:'camera-pull', amount:0.15, dur:1100}] },
  { idx:20, motionType:'final',  events:[{type:'hero-light', dur:1500, op:0.15},{type:'bg-fade', amount:0.20},{type:'stillness-hit', dur:800}] },

  // === Verse 3 (108-128) — Second Verse ===
  { idx:21, motionType:'micro',  events:[{type:'lateral-track', dur:3000, dir:'right'}] },
  { idx:22, motionType:'emotion',events:[{type:'depth-dive', card:3, dur:1500}] },
  { idx:23, motionType:'emotion',events:[{type:'hero-secondary', dur:1200}] },
  { idx:24, motionType:'micro',  events:[{type:'lateral-track', dur:3000}] },
  { idx:25, motionType:'micro',  events:[{type:'lateral-couple', dur:1500}] },
  { idx:26, motionType:'emotion',events:[{type:'camera-pull', amount:0.08, dur:1300}] },
  { idx:27, motionType:'emotion',events:[{type:'stillness-hit', dur:700}] },

  // === Verse 4 (133-163) — Second Chorus (Memory Explosion) ===
  { idx:28, motionType:'key',    events:[{type:'camera-pass-hero-reveal', dur:1400},{type:'hero-reveal', dur:1400}] },
  { idx:29, motionType:'key',    events:[{type:'group-gather-outside', dur:1200}] },
  { idx:30, motionType:'emotion',events:[{type:'stillness-hit', dur:500}] },
  { idx:31, motionType:'emotion',events:[{type:'past-to-present', dur:1300}] },
  { idx:32, motionType:'time-rewind',events:[{type:'time-rewind', dur:1800, intensity:1.4}] },
  { idx:33, motionType:'emotion',events:[{type:'camera-pull', amount:0.12, dur:1100}] },
  { idx:34, motionType:'key',    events:[{type:'foreground-cover-swap', dur:1500}] },

  // === Verse 5 (170-196) — Bridge / Waiting ===
  { idx:35, motionType:'emotion',events:[{type:'bg-fade', amount:0.10},{type:'camera-pull', amount:0.10, dur:1500}] },
  { idx:36, motionType:'emotion',events:[{type:'hero-flee', dur:1500}] },
  { idx:37, motionType:'micro',  events:[{type:'lateral-track', dur:3000, dir:'left'},{type:'bg-fade', amount:0.05}] },
  { idx:38, motionType:'emotion',events:[{type:'long-push', dur:1500}] },
  { idx:39, motionType:'key',    events:[{type:'stillness-hit', dur:800}] },
  { idx:40, motionType:'key',    events:[{type:'background-crowd', dur:1800, count:5, stagger:90}] },
  { idx:41, motionType:'key',    events:[{type:'hero-depth-enter', dur:1600},{type:'hero-light', dur:1500, op:0.12}] },
  { idx:42, motionType:'emotion',events:[{type:'long-push', dur:1200, amount:0.04}] },

  // === Verse 6 (198-228) — Final Chorus ===
  { idx:43, motionType:'key',    events:[{type:'hero-reveal', dur:1400},{type:'reassemble', dur:1200}] },
  { idx:44, motionType:'emotion',events:[{type:'group-gather', dur:1000, stagger:120}] },
  { idx:45, motionType:'emotion',events:[{type:'stillness-hit', dur:500}] },
  { idx:46, motionType:'emotion',events:[{type:'pull-reverse-parallax', dur:1400}] },
  { idx:47, motionType:'time-rewind',events:[{type:'time-rewind', dur:1500, intensity:0.8}] },
  { idx:48, motionType:'emotion',events:[{type:'memory-space-open', dur:1500}] },
  { idx:49, motionType:'final',  events:[{type:'final-slow-push', dur:2200},{type:'hero-light', dur:1800, op:0.16},{type:'bg-fade', amount:0.15},{type:'lyrics-focus', dur:1800}] },

  // === Afterglow (228-259) ===
  { idx:50, motionType:'emotion',events:[{type:'afterglow-pull', dur:2500},{type:'bg-fade', amount:0.25, blur:5}] },
  { idx:51, motionType:'emotion',events:[{type:'hero-recover', dur:2000}] },
  { idx:52, motionType:'emotion',events:[{type:'afterglow-memories', dur:3500}] },
];

/* ===================== Event Timeline (从 LYRIC_CUES 平铺生成,运行时初始化) ==================== */
let EVENT_TIMELINE = [];
function buildEventTimeline(){
  EVENT_TIMELINE = [];
  if(typeof lyricsData === 'undefined') return;
  for(const cue of LYRIC_CUES){
    for(const ev of (cue.events || [])){
      EVENT_TIMELINE.push({
        t: lyricsData[cue.idx] ? lyricsData[cue.idx].time : 0,
        dur: ev.dur || EVENT_DEFAULT_DURATION[ev.type] || 1500,
        ...ev,
      });
    }
  }
}

/* 获取当前活跃事件 — 返回数组,每个含事件所有字段 + p (0..1 进度) */
function getActiveEvents(time){
  const out = [];
  for(const ev of EVENT_TIMELINE){
    const dur = ev.dur / 1000;
    const startT = ev.t;
    const endT = ev.t + dur;
    if(time >= startT && time < endT){
      const p = clamp((time - startT) / dur, 0, 1);
      out.push({ ...ev, p, startT, endT });
    }
  }
  return out;
}

/* 计算事件对单张卡片造成的偏移 — 返回 {dx, dy, dz, dscale, drotZ, dopacity, dblur} */
function getEventOffset(event, cardIdx, slot, time){
  const p = event.p;
  const type = event.type;

  /* === card-enter === */
  if(type === 'card-enter' && event.card === cardIdx){
    const preset = ENTER_PRESETS[event.preset] || ENTER_PRESETS['fly-left'];
    const curve = CURVES[preset.easing] || CURVES.easeOut;
    const k = 1 - curve(p);
    return {
      dx: preset.dx * k, dy: preset.dy * k, dz: preset.dz * k,
      dscale: (preset.scale - 1) * k, drotZ: preset.drz * k,
      dopacity: -k * 0.5, dblur: 0,
    };
  }

  /* === foreground-pass === */
  if(type === 'foreground-pass' && event.card === cardIdx){
    const phase = p;
    const xMove = -1400 + phase * 2800;
    const k = Math.sin(phase * Math.PI);
    return {
      dx: xMove, dy: -80 + k * -60, dz: 400 * k,
      dscale: 2.0 * k, drotZ: 12 * Math.cos(phase * Math.PI),
      dopacity: 1.0 * k - 0.2, dblur: -1.0,
    };
  }

  /* === foreground-cover-swap === 大卡片横穿镜头,card 3 作为遮挡 */
  if(type === 'foreground-cover-swap'){
    if(cardIdx !== 3) return zeroOffset();
    const phase = p;
    const xMove = -1200 + phase * 2400;
    const k = Math.sin(phase * Math.PI);
    return {
      dx: xMove, dy: -40 + k * -50, dz: 500 * k,
      dscale: 2.6 * k, drotZ: 10 * Math.cos(phase * Math.PI),
      dopacity: 1.0 * k - 0.2, dblur: -1.0,
    };
  }

  /* === scatter === */
  if(type === 'scatter'){
    const stagger = cardIdx * 0.08;
    const adjP = clamp((p - stagger) / (1 - stagger), 0, 1);
    const k = CURVES.easeOut(adjP) * (adjP < 0.7 ? 1 : 1 - (adjP - 0.7) / 0.3 * 0.3);
    if(cardIdx === 0) return zeroOffset();
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
    return {
      dx: dirX * 500 * k, dy: dirY * 350 * k, dz: -200 * k,
      dscale: -0.4 * k, drotZ: dirX * 25 * k,
      dopacity: -0.5 * k, dblur: 2.0 * k,
    };
  }

  /* === reassemble === */
  if(type === 'reassemble'){
    const stagger = (NUM_CARDS - cardIdx) * 0.06;
    const adjP = clamp((p - stagger) / (1 - stagger), 0, 1);
    if(cardIdx === 0) return zeroOffset();
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
    let k;
    if(adjP < 0.3){ k = adjP / 0.3; }
    else { k = 1 - CURVES.easeInOut((adjP - 0.3) / 0.7); }
    return {
      dx: dirX * 500 * k, dy: dirY * 350 * k, dz: -200 * k,
      dscale: -0.4 * k, drotZ: dirX * 25 * k,
      dopacity: -0.5 * k, dblur: 2.0 * k,
    };
  }

  /* === card-fly === */
  if(type === 'card-fly' && event.card === cardIdx){
    const k = Math.sin(p * Math.PI);
    const zMove = -700 + (1 - Math.abs(p - 0.5) * 2) * 1100;
    return {
      dx: -400 * (1 - p * 2), dy: 60 * k, dz: zMove,
      dscale: 1.5 * k, drotZ: 15 * (p - 0.5) * 2,
      dopacity: 1.0 * k - 0.3, dblur: -1.0,
    };
  }

  /* === hero-reveal === Hero 从背景向中景靠近 */
  if(type === 'hero-reveal' && cardIdx === 0){
    const k = CURVES.overshoot ? (() => {
      const t = p;
      if(t < 0.7){
        const c = 1.70158;
        return 1 + (c+1)*Math.pow(t/0.7-1,3) + c*Math.pow(t/0.7-1,2);
      }
      return 1 - (t-0.7)/0.3 * 0.04;
    })() : CURVES.easeInOut(p);
    return {
      dx: 0, dy: 0, dz: -120 + k * 120, dscale: -0.10 + k * 0.14, drotZ: 0,
      dopacity: -0.45 + k * 0.45, dblur: 0,
    };
  }

  /* === camera-pass-hero-reveal === */
  if(type === 'camera-pass-hero-reveal' && cardIdx === 0){
    const k = Math.sin(p * Math.PI);
    return { dx: 0, dy: 0, dz: 30 * k, dscale: 0.10 * k, drotZ: 0, dopacity: 0, dblur: 0 };
  }

  /* === hero-depth-enter === "总有你的存在" Hero Arrival */
  if(type === 'hero-depth-enter' && cardIdx === 0){
    const k = CURVES.easeInOut(p);
    return {
      dx: 0, dy: 0,
      dz: -450 + k * 450,
      dscale: -0.28 + k * 0.28,
      drotZ: 0,
      dopacity: -1 * (1 - k),
      dblur: (1 - k) * 4,
    };
  }

  /* === hero-flee === "有时也会失败" Hero 主动远离 */
  if(type === 'hero-flee' && cardIdx === 0){
    const k = CURVES.easeOut(p);
    return { dx: 0, dy: 0, dz: -k * 120, dscale: -k * 0.10, drotZ: 0, dopacity: -k * 0.10, dblur: k * 1.5 };
  }

  /* === hero-recover === Afterglow Hero scale 1.035 → 1 */
  if(type === 'hero-recover' && cardIdx === 0){
    const k = CURVES.easeInOut(p);
    return { dx: 0, dy: 0, dz: 0, dscale: (1 - k) * 0.035, drotZ: 0, dopacity: 0, dblur: 0 };
  }

  /* === hero-settle === "才了解所谓的爱" overshoot */
  if(type === 'hero-settle' && cardIdx === 0){
    const t = p;
    const k = t < 0.5 ? (t/0.5) * 0.025 : (1 - (t-0.5)/0.5) * 0.025;
    return { dx:0, dy:0, dz:0, dscale: k, drotZ:0, dopacity:0, dblur:0 };
  }
  if(type === 'hero-settle' && cardIdx !== 0){ return zeroOffset(); }

  /* === hero-zoom-in === "多少天长地久" scale 1 → 1.04 → 1 */
  if(type === 'hero-zoom-in' && cardIdx === 0){
    const t = p;
    const k = t < 0.6 ? (t/0.6) * 0.04 : (1 - (t-0.6)/0.4) * 0.04;
    return { dx:0, dy:0, dz:0, dscale:k, drotZ:0, dopacity:0, dblur:0 };
  }
  if(type === 'hero-zoom-in' && cardIdx !== 0){
    return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:-CURVES.easeOut(p)*0.20, dblur:CURVES.easeOut(p)*1.5 };
  }

  /* === hero-secondary === Hero 暂时成为 Midground */
  if(type === 'hero-secondary' && cardIdx === 0){
    const k = CURVES.easeOut(p);
    return { dx:0, dy:0, dz:-k*30, dscale:-k*0.05, drotZ:0, dopacity:-k*0.15, dblur:k*0.8 };
  }

  /* === secondary-drift === 周围两张卡向 Hero 靠近 20-40px */
  if(type === 'secondary-drift'){
    if(cardIdx === 0) return zeroOffset();
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const k = CURVES.easeOut(p);
    return { dx:-dirX * 35 * k, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
  }

  /* === lateral-track / lateral-balance / lateral-couple / soft-perspective-enter === */
  if(type === 'lateral-track'){ return zeroOffset(); }

  if(type === 'lateral-balance'){
    if(cardIdx === 0) return zeroOffset();
    const k = CURVES.easeOut(p);
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const startX = 20 * dirX, endX = 5 * dirX;
    return { dx:(startX + (endX - startX) * k), dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
  }

  if(type === 'lateral-couple'){
    if(cardIdx === 0) return zeroOffset();
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const k = CURVES.easeOut(p);
    return { dx:-dirX * 60 * k, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
  }

  if(type === 'soft-perspective-enter' && event.card === cardIdx){
    const curve = CURVES.easeOut;
    const k = 1 - curve(p);
    return { dx:300 * k, dy:0, dz:-280 * k, dscale:(0.85-1)*k, drotZ:0, dopacity:0, dblur:0 };
  }

  /* === depth-dive === 一张旧照片从极远推进到中景 */
  if(type === 'depth-dive' && event.card === cardIdx){
    const k = CURVES.easeInOut(p);
    return {
      dx: 0, dy: 0,
      dz: -500 + k * 450,
      dscale: -0.4 + k * 0.5,
      drotZ: 0,
      dopacity: -0.85 + k * 0.85,
      dblur: (1-k) * 4,
    };
  }

  /* === old-memory-enter === Time Rewind 时的旧照片进入(card 4) */
  if(type === 'old-memory-enter'){
    if(cardIdx !== 4) return zeroOffset();
    const k = CURVES.easeOut(p);
    return { dx:0, dy:0, dz:-400 + k * 400, dscale:-0.28 + k * 0.28, drotZ:0, dopacity:-0.85 + k * 0.85, dblur:(1-k) * 3 };
  }

  /* === time-rewind === Reverse Parallax */
  if(type === 'time-rewind'){
    if(cardIdx === 0){
      const k = CURVES.easeOut(p);
      return { dx:0, dy:0, dz:0, dscale:0.08 * k, drotZ:0, dopacity:-0.75 * k, dblur:k*1.5 };
    }
    const k = CURVES.easeOut(p);
    return { dx:0, dy:0, dz:0, dscale:-0.15 * k, drotZ:0, dopacity:-0.20 * k, dblur:k*1.5 };
  }

  /* === pull-reverse-parallax === */
  if(type === 'pull-reverse-parallax'){
    if(cardIdx === 0) return zeroOffset();
    const k = CURVES.easeOut(p);
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
    return { dx:dirX*30*k, dy:dirY*20*k, dz:-50*k, dscale:-0.10*k, drotZ:0, dopacity:-0.10*k, dblur:k*0.8 };
  }

  /* === group-gather === 外围卡片向 Hero 靠近 */
  if(type === 'group-gather'){
    if(cardIdx === 0) return zeroOffset();
    const stagger = cardIdx * (event.stagger || 120) / 1000 / (event.dur/1000);
    const adjP = clamp((p - stagger) / (1 - stagger), 0, 1);
    const k = CURVES.easeInOut(adjP);
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
    return { dx:-dirX * 40 * k, dy:-dirY * 25 * k, dz:0, dscale:0.05 * k, drotZ:0, dopacity:0, dblur:0 };
  }

  /* === group-gather-outside === 从外侧向中心汇聚 */
  if(type === 'group-gather-outside'){
    if(cardIdx === 0) return zeroOffset();
    const k = CURVES.easeOut(p);
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
    return { dx:-dirX * 60 * k, dy:-dirY * 40 * k, dz:-k * 60, dscale:k * 0.05, drotZ:0, dopacity:0, dblur:0 };
  }

  /* === background-crowd === Background Cards Staggered Enter */
  if(type === 'background-crowd'){
    if(cardIdx < 4) return zeroOffset();
    const staggerIdx = (cardIdx - 4);
    const stagger = staggerIdx * (event.stagger || 100) / 1000 / (event.dur/1000);
    const adjP = clamp((p - stagger) / (1 - stagger), 0, 1);
    const k = CURVES.easeOut(adjP);
    const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
    return {
      dx: dirX * (200 + 100 * (1-k)),
      dy: 0,
      dz: -k * 200,
      dscale: -0.30 * (1-k),
      drotZ: 0,
      dopacity: -0.7 * (1-k),
      dblur: (1-k) * 4,
    };
  }

  /* === focus-pull === */
  if(type === 'focus-pull'){
    const k = CURVES.easeInOut(p);
    if(event.dir === 'away'){
      if(cardIdx === 0) return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:k*2.5 };
      return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:-k*0.15, dblur:k*3 };
    } else {
      if(cardIdx === 0) return { dx:0, dy:0, dz:0, dscale:CURVES.easeOut(p)*0.025 - k*0.025, drotZ:0, dopacity:0, dblur:-k*2.5 };
      return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:k*0.15, dblur:-k*3 };
    }
  }

  /* === past-to-present === 旧照片从 Hero 后方进入(card 4) */
  if(type === 'past-to-present'){
    if(cardIdx !== 4) return zeroOffset();
    const k = CURVES.easeInOut(p);
    return { dx:0, dy:0, dz:-300 + k*200, dscale:-0.20 + k*0.20, drotZ:0, dopacity:-0.50+k*0.50, dblur:(1-k)*3 };
  }

  /* === memory-space-open === Background/Midground/Foreground 全部可见 */
  if(type === 'memory-space-open'){
    if(cardIdx === 0) return zeroOffset();
    const k = CURVES.easeInOut(p);
    return { dx:0, dy:0, dz:0, dscale:0.10*k, drotZ:0, dopacity:0.20*k, dblur:-k*0.8 };
  }

  /* === afterglow-memories === Afterglow 时让 card 8 从 Background 缓慢出现 */
  if(type === 'afterglow-memories'){
    if(cardIdx !== 8) return zeroOffset();
    const k = CURVES.easeOut(p);
    return { dx:0, dy:0, dz:-500 + k*250, dscale:-0.50 + k*0.40, drotZ:0, dopacity:-0.95+k*0.20, dblur:(1-k)*5 };
  }

  /* === bg-fade === 非 Hero 卡片整体降低 opacity,Hero 不动 */
  if(type === 'bg-fade'){
    if(cardIdx === 0) return zeroOffset();
    const k = CURVES.easeInOut(p);
    const amount = (event.amount || 0.10) * k;
    const blur = (event.blur || 0) * k;
    return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:-amount, dblur:blur };
  }

  /* === stillness-hit / lyrics-focus / micro-pull / slow-push / long-push ===
     camera/fx-only events,card 层不偏移 */
  if(type === 'stillness-hit' || type === 'lyrics-focus' || type === 'micro-pull' ||
     type === 'slow-push' || type === 'long-push' || type === 'camera-pull' ||
     type === 'final-slow-push' || type === 'afterglow-pull'){
    return zeroOffset();
  }

  /* === 作用于 camera/fx 的事件在 card 层不产生偏移 === */
  return zeroOffset();
}

function zeroOffset(){ return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 }; }


/* ===================== Rack Focus(服务于 PUSH_RACK_FOCUS Shot)=====================
     focusIdx (0..8) 决定哪张 card 是 sharp:
       sharp    → blur 0, opacity 1, brightness 1.05
       unfocus  → blur +, opacity 减, brightness 减(距离越远越虚)
  */
  function rackFocusForIndex(i, focusIdx){
    if(typeof focusIdx !== 'number') return { blur:0, brightness:1, saturate:1 };
    if(i === focusIdx) return { blur:0, brightness:1.05, saturate:1.10 };
    const dist = Math.abs(i - focusIdx);
    if(dist === 1) return { blur:0.8, brightness:0.92, saturate:0.92 };
    if(dist === 2) return { blur:1.5, brightness:0.85, saturate:0.82 };
    return { blur:2.0, brightness:0.75, saturate:0.70 };
  }

  /* ===================== 粒子(Layer 2) ===================== */
  const MAX_PARTICLES = 12;
  const particles = [];
  /* V6: seeded random(粒子初始状态由 seed 决定,Seek 一致) */
  const particleRng = window.MotionScheduler.mulberry32(window.MotionScheduler.SCENE_SEED ^ 0x917321);
  function initParticles(){
    for(let i=0;i<MAX_PARTICLES;i++){
      const p = document.createElement('div');
      p.className = 'ambient-particle';
      const w = (2 + particleRng()*3);
      p.style.width = w + 'px';
      p.style.height = p.style.width;
      p.style.opacity = '0';
      dom.layerParts.appendChild(p);
      particles.push({
        el:p,
        x: particleRng()*100,
        y: particleRng()*100,
        vx: (particleRng()-0.5)*0.02,
        vy: (particleRng()-0.5)*0.02 - 0.005,
        phase: particleRng()*TAU,
        w,
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

  /* ===================== RAF Render Loop ===================== */
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let lastT = performance.now();
  let rafId = 0;

  /* 摄影机 live 值(平滑插值) */
  const camLive = { x:0,y:0,rotX:0,rotY:0,z:0,scale:1 };

  /* 当前 stage 名(用于 body.class 切换 typography) */
  let currentStageName = '';

  /* fx 当前 opacity(平滑过渡) */
  const fxOpacity = {};
  Object.keys(dom.fx).forEach(k => fxOpacity[k] = 0);

  /* V7: photo 同步 — 每张 DOM card 显示 slotPhotoIdx[i] 决定的 photoIdx
     不再固定 slot 0 = active,而是 HeroDirector 决定每张 card 该显示哪张照片 */
  function syncCardPhotosFromScene(slotPhotoIdx){
    cards.forEach((c, i) => {
      const photoIdx = slotPhotoIdx[i];
      const src = getPhotoSrc(photoIdx);
      setCardImage(c, src);
    });
  }

  /* 兼容旧 API:seek 时仍可手动设 hero */
  function syncCardPhotos(activeIdx){
    const offsets = [0,-1,1,-2,2,-3,3,-4,4];
    cards.forEach((c, i) => {
      const photoIdx = clamp(activeIdx + offsets[i], 0, (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42) - 1);
      const src = getPhotoSrc(photoIdx);
      setCardImage(c, src);
      c.photoOffset = offsets[i];
    });
  }

  /* V7: 用 NUM_PHOTOS 重建 HeroDirector timeline */
  if(window.HeroDirector && typeof NUM_PHOTOS !== 'undefined'){
    window.HeroDirector.rebuildRotationTimeline(NUM_PHOTOS);
  }

  function tick(now){
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const time = window.musicBox ? window.musicBox.currentTime : 0;
    const t = now / 1000;

    /* 1) 当前 stage 状态(用于 slots/cardVisual/fx/typography) */
    const stState = getStageState(time);
    const fromStage = STAGES[stState.from];
    const toStage   = STAGES[stState.to];
    const morphT    = smoothstep(stState.progress);

    /* 2) body.style-* 切换 typography(只在 stage 名变化时) */
    if(toStage.typography !== currentStageName){
      if(currentStageName) document.body.classList.remove('style-' + currentStageName);
      document.body.classList.add('style-' + toStage.typography);
      currentStageName = toStage.typography;
    }

    /* 3) fx opacity 平滑收敛(from→to) */
    function mergeFx(baseFxA, baseFxB){
      const merged = {};
      Object.keys(dom.fx).forEach(k => {
        merged[k] = lerp(baseFxA[k]||0, baseFxB[k]||0, morphT);
      });
      return merged;
    }
    const targetFx = mergeFx(fromStage.fxMap, toStage.fxMap);
    Object.keys(dom.fx).forEach(k => {
      fxOpacity[k] = lerp(fxOpacity[k], clamp(targetFx[k], 0, 1), damp(2.0, dt));
      dom.fx[k].style.setProperty('--fx-op', fxOpacity[k].toFixed(3));
    });
    /* light-leak 做一个 translateX 缓慢漂移 */
    if(dom.fx.leak){
      dom.fx.leak.style.transform = `translateX(${Math.sin(t*0.12)*5}%)`;
    }
    /* stars 做一个轻微 opacity 闪烁 */
    if(dom.fx.stars){
      const flick = 0.7 + Math.sin(t*1.7)*0.15;
      dom.fx.stars.style.opacity = (fxOpacity.stars * flick).toFixed(3);
    }

    /* 4) Camera:由 SHOT_TIMELINE 决定,从 Shot 函数取 cam 目标值 */
    const shotState = getShotState(time);
    const shotFn = SHOTS[shotState.shot] || SHOTS.ESTABLISHING;
    const shotResult = shotFn(shotState.progress, t, {});
    const shotCam = shotResult.cam;

    /* V6: Ambient + Micro Motion 叠加在 Shot Camera 之上
       Ambient Camera:永远存在,避免 >2 秒完全静止 */
    const phaseState = window.MotionScheduler.getPhaseState(time);
    const ambientCam = window.MotionScheduler.getAmbientCamera(time, phaseState.density);
    const activeMicro = window.MotionScheduler.getActiveMicroEvents(time);
    const microFx = window.MotionScheduler.getMicroEffects(activeMicro, time, NUM_CARDS);

    const targetCam = {
      x:     shotCam.x     + ambientCam.x     + microFx.cameraOff.x,
      y:     shotCam.y     + ambientCam.y     + microFx.cameraOff.y,
      z:     shotCam.z     + ambientCam.z     + microFx.cameraOff.z,
      rotX:  shotCam.rotX  + ambientCam.rotX  + microFx.cameraOff.rotX,
      rotY:  shotCam.rotY  + ambientCam.rotY  + microFx.cameraOff.rotY,
      scale: shotCam.scale + ambientCam.scale + microFx.cameraOff.scale,
    };

    /* Camera 平滑插值 — Shot 切换时 camLive 不会突变,形成 MATCH MOTION */
    camLive.x     = lerp(camLive.x,     targetCam.x,     damp(1.5, dt));
    camLive.y     = lerp(camLive.y,     targetCam.y,     damp(1.5, dt));
    camLive.z     = lerp(camLive.z,     targetCam.z,     damp(1.5, dt));
    camLive.rotX  = lerp(camLive.rotX,  targetCam.rotX,  damp(1.0, dt));
    camLive.rotY  = lerp(camLive.rotY,  targetCam.rotY,  damp(1.0, dt));
    camLive.scale = lerp(camLive.scale, targetCam.scale, damp(0.8, dt));

    if(dom.cameraRig){
      dom.cameraRig.style.transform =
        `translate3d(${camLive.x.toFixed(2)}px, ${camLive.y.toFixed(2)}px, ${camLive.z.toFixed(2)}px)` +
        ` rotateX(${camLive.rotX.toFixed(3)}deg) rotateY(${camLive.rotY.toFixed(3)}deg)` +
        ` scale(${camLive.scale.toFixed(4)})`;
    }

    /* V7: Scene State — HeroDirector 决定 slot layout 和 photoIdx 分配
     旧 fromStage.slots / toStage.slots 系统被替换为 HeroDirector.SLOTS
     但保留 StageMorph 让 cardVisual / fx / typography 仍按时间切换 */
    const sceneState = window.HeroDirector.getSceneState(time);

    /* 同步每张 DOM card 显示 sceneState.slotPhotoIdx[i] 决定的照片 */
    syncCardPhotosFromScene(sceneState.slotPhotoIdx);

    /* 焦点(仅 PUSH_RACK_FOCUS Shot 用,其他 Shot focusIdx 不存在,所有 card 都 sharp) */
    const focusIdx = shotResult.focusIdx;

    /* 当前活跃事件 — 在 Shot 之上叠加一次性事件编舞 */
    const activeEvents = getActiveEvents(time);

    /* V7: HeroRotation 状态(决定新 hero 推进 / 旧 hero 退场) */
    const rotation = sceneState.rotation;
    const rotationMot = (rotation && rotation.active)
      ? window.HeroDirector.getSlotMotionForRotation(rotation, 0, 'HERO', time)
      : null;

    cards.forEach((c, i) => {
      /* V7: 用 HeroDirector.SLOTS[i] 决定基础 slot(x, y, z, scale, blur, opacity) */
      const baseSlot = window.HeroDirector.SLOTS[i];
      /* 与原 STAGE 系统 blend:cardVisual / typography 仍由 stage 决定 */
      const slotA = fromStage.slots[i];
      const slotB = toStage.slots[i];
      const stageMorph = (slotA && slotB) ? {
        w: lerp(slotA.w, slotB.w, morphT),
        h: lerp(slotA.h, slotB.h, morphT),
        rotX: lerp(slotA.rotX, slotB.rotX, morphT),
        brightness: lerp(slotA.brightness, slotB.brightness, morphT),
        saturate: lerp(slotA.saturate, slotB.saturate, morphT),
      } : { w: baseSlot.scale * 350, h: baseSlot.scale * 460, rotX: 0, brightness: 1.05, saturate: 1.10 };
      const slot  = {
        x: baseSlot.x,
        y: baseSlot.y,
        z: baseSlot.z,
        w: stageMorph.w,
        h: stageMorph.h,
        rotX: stageMorph.rotX,
        rotY: 0,
        rotZ: 0,
        scale: baseSlot.scale,
        blur: baseSlot.blur,
        opacity: baseSlot.opacity,
        brightness: stageMorph.brightness,
        saturate: stageMorph.saturate,
      };

      /* Parallax factor:基于卡片 z 深度 */
      const parallaxFactor = clamp(1 + slot.z / 500, 0.1, 1.5);

      /* 视觉 CSS 变量(只主图显示 cardVisual) */
      const cvA = fromStage.cardVisual;
      const cvB = toStage.cardVisual;
      const cv = {
        bg: morphT < 0.5 ? cvA.bg : cvB.bg,
        border: morphT < 0.5 ? cvA.border : cvB.border,
        shadow: morphT < 0.5 ? cvA.shadow : cvB.shadow,
        radius: morphT < 0.5 ? cvA.radius : cvB.radius,
        imgFilter: applyImageTreatment(morphT < 0.5 ? fromStage.imgTreatment : toStage.imgTreatment,
                       morphT < 0.5 ? cvA.imgFilter : cvB.imgFilter),
      };
      /* V7: is-main 跟随 HeroDirector 的 slot 名 */
      const isMainNow = (baseSlot.name === 'HERO');
      if(isMainNow){
        c.el.style.setProperty('--card-bg', cv.bg);
        c.el.style.setProperty('--card-border', cv.border);
        c.el.style.setProperty('--card-shadow', cv.shadow);
        c.el.style.setProperty('--card-radius', cv.radius);
        c.el.classList.add('is-main');
      } else {
        c.el.classList.remove('is-main');
      }
      c.el.style.setProperty('--card-img-filter', cv.imgFilter);

      /* caption(只在 polaroid/editorial/film 显示) */
      if(toStage.typography === 'polaroid' || toStage.typography === 'film'){
        c.el.classList.add('show-caption');
        c.cap.classList.add('visible');
      } else {
        c.cap.classList.remove('visible');
      }

      /* 像素化 slot(中心=0) */
      const rect = getCarouselRect();
      const px = (slot.x - 50) / 100 * rect.width;
      const py = (slot.y - 50) / 100 * rect.height;

      /* Rack focus 叠加(只 PUSH_RACK_FOCUS 用,其他 Shot 无 focusIdx) */
      const focus = rackFocusForIndex(i, focusIdx);

      /* 事件偏移叠加:累加所有活跃事件对该卡片的影响 */
      let evOff = { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
      for(const ev of activeEvents){
        const off = getEventOffset(ev, i, slot, time);
        evOff.dx      += off.dx;
        evOff.dy      += off.dy;
        evOff.dz      += off.dz;
        evOff.dscale  += off.dscale;
        evOff.drotZ   += off.drotZ;
        evOff.dopacity+= off.dopacity;
        evOff.dblur   += off.dblur;
      }

      /* V7: HeroRotation 偏移 — 新 hero 推进 / 旧 hero 退场 */
      let rotOff = { dx:0, dy:0, dz:0, dscale:0, drotZ:0, drotY:0, dopacity:0, dblur:0 };
      if(rotationMot && i === 0 && isMainNow){
        // 当前 slot 是 HERO 且 rotation 进行中 → 新 hero 接收 preset motion
        rotOff.dx = rotationMot.dx;
        rotOff.dy = rotationMot.dy;
        rotOff.dz = rotationMot.dz;
        rotOff.dscale = rotationMot.dscale;
        rotOff.drotZ = rotationMot.drotZ;
        rotOff.drotY = rotationMot.drotY || 0;
        rotOff.dopacity = rotationMot.dopacity;
        rotOff.dblur = rotationMot.dblur;
      } else if(rotation && rotation.active){
        // FG_LEFT = 退场 hero
        if(baseSlot.name === 'FG_LEFT' && rotation.fromIdx !== null && rotation.fromIdx !== rotation.toIdx){
          const op = (1 - rotation.progress);
          rotOff.dx = lerp(0, -25, 1 - op);
          rotOff.dz = lerp(0, -200, 1 - op);
          rotOff.dscale = lerp(0, -0.15, 1 - op);
          rotOff.drotZ = lerp(0, -8, 1 - op);
          rotOff.dopacity = lerp(0, -0.20, 1 - op);
          rotOff.dblur = lerp(0, 1.5, 1 - op);
        }
      }

      /* V6: Ambient Motion — 永远存在的微动 */
      const ambOff = window.MotionScheduler.getAmbientForCard(i, time, slot.z);
      const microCard = microFx.cardOffs[i];

      /* Hero(i==0)叠加 microFx.heroOff */
      let heroScaleOff = 0, heroZOff = 0;
      if(i === 0){
        heroScaleOff = microFx.heroOff.scale;
        heroZOff = microFx.heroOff.z;
      }

      /* V7: 卡片 transform = slot + parallax + ambient + micro + event + rotation */
      const targetX = px - camLive.x * parallaxFactor + ambOff.dx + microCard.dx + evOff.dx + rotOff.dx;
      const targetY = py - camLive.y * parallaxFactor + ambOff.dy + microCard.dy + evOff.dy + rotOff.dy;
      const targetZ = slot.z + camLive.z * parallaxFactor * 0.3 + ambOff.dz + microCard.dz + evOff.dz + rotOff.dz + (i === 0 ? heroZOff : 0);
      const rotX = slot.rotX;
      const rotY = (slot.rotY || 0) + rotOff.drotY;
      const rotZ = (slot.rotZ || 0) + ambOff.drotZ + microCard.drotZ + evOff.drotZ + rotOff.drotZ;
      const blur = clamp(slot.blur + focus.blur + ambOff.dblur + microCard.dblur + evOff.dblur + rotOff.dblur, 0, 2.5);
      const brightness = slot.brightness * focus.brightness;
      const saturate = slot.saturate * focus.saturate;
      const targetScale = Math.max(0.1, slot.scale + ambOff.dscale + microCard.dscale + evOff.dscale + rotOff.dscale + (i === 0 ? heroScaleOff : 0));
      const targetOpacity = clamp(slot.opacity + evOff.dopacity + rotOff.dopacity, 0, 1);

      /* 实时 lerp */
      const lambda = 6.0;
      const L = c.live;
      L.x = lerp(L.x, targetX, damp(lambda, dt));
      L.y = lerp(L.y, targetY, damp(lambda, dt));
      L.z = lerp(L.z, targetZ, damp(lambda*1.2, dt));
      L.w = lerp(L.w, slot.w, damp(lambda*0.7, dt));
      L.h = lerp(L.h, slot.h, damp(lambda*0.7, dt));
      L.scale = lerp(L.scale, targetScale, damp(lambda, dt));
      L.rotX  = lerp(L.rotX,  rotX,  damp(lambda*0.8, dt));
      L.rotY  = lerp(L.rotY,  rotY,  damp(lambda*0.8, dt));
      L.rotZ  = lerp(L.rotZ,  rotZ,  damp(lambda*0.8, dt));
      L.blur  = lerp(L.blur,  blur,  damp(lambda*1.4, dt));
      L.opacity = lerp(L.opacity, targetOpacity, damp(lambda*1.2, dt));
      L.brightness = lerp(L.brightness, brightness, damp(lambda, dt));
      L.saturate   = lerp(L.saturate,   saturate,   damp(lambda, dt));

      /* 写入 DOM */
      c.el.style.width  = L.w.toFixed(1) + 'px';
      c.el.style.height = L.h.toFixed(1) + 'px';
      /* V6: transform 保留 3 位小数,让微动可见(否则 toFixed(2) 会把 <0.005px 截掉) */
      c.el.style.transform =
        `translate3d(-50%, -50%, 0)` +
        ` translate3d(${L.x.toFixed(3)}px, ${L.y.toFixed(3)}px, ${L.z.toFixed(3)}px)` +
        ` rotateX(${L.rotX.toFixed(3)}deg) rotateY(${L.rotY.toFixed(3)}deg) rotateZ(${L.rotZ.toFixed(3)}deg)` +
        ` scale(${L.scale.toFixed(4)})`;
      c.el.style.opacity = L.opacity.toFixed(3);
      c.el.style.zIndex = Math.round(1000 + L.z);
      c.el.style.filter = `blur(${L.blur.toFixed(2)}px) brightness(${L.brightness.toFixed(3)}) saturate(${L.saturate.toFixed(3)})`;
    });

    /* 6) 粒子(L2) */
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      if(p.x < 0) p.x = 100;
      if(p.x > 100) p.x = 0;
      if(p.y < 0) p.y = 100;
      if(p.y > 100) p.y = 0;
      const opacity = (0.3 + Math.sin(t*0.5 + p.phase)*0.3) * (fxOpacity.particles || 0.5);
      p.el.style.transform = `translate3d(${p.x}vw, ${p.y}vh, 0)`;
      p.el.style.opacity = opacity.toFixed(3);
    });

    /* 7) Hero Light — 跟随 Hero 卡片位置,opacity 由 hero-light 事件驱动 + Ambient breathing */
    const heroCard = cards[0];
    if(heroCard && dom.fx.heroLight){
      const carouselRect = dom.carousel.getBoundingClientRect();
      // Hero 卡片中心的视口坐标
      const heroScreenX = carouselRect.left + carouselRect.width / 2 + heroCard.live.x;
      const heroScreenY = carouselRect.top  + carouselRect.height / 2 + heroCard.live.y;
      // 视口百分比
      const vpX = (heroScreenX / window.innerWidth) * 100;
      const vpY = (heroScreenY / window.innerHeight) * 100;
      // V6: Ambient Hero Light breathing — 永远存在
      const ambLight = window.MotionScheduler.getAmbientHeroLight(time);
      let heroLightOp = ambLight.op;
      let heroLightR  = ambLight.r;
      // Key events 叠加
      for(const ev of activeEvents){
        if(ev.type === 'hero-light'){
          const k = CURVES.easeInOut(ev.p);
          const op = (ev.op || 0.15) * k;
          if(op > heroLightOp) heroLightOp = op;
        }
        if(ev.type === 'final-slow-push'){
          // 最终歌词触发时 Hero Light 也加强
          const k = CURVES.easeInOut(ev.p);
          const op = 0.16 * k;
          if(op > heroLightOp) heroLightOp = op;
        }
        if(ev.type === 'afterglow-pull' || ev.type === 'afterglow-memories'){
          // Afterglow 期间 Hero Light 渐淡到 0.05
          const k = CURVES.easeOut(ev.p);
          const op = 0.15 * (1 - k) + 0.05 * k;
          if(op > heroLightOp) heroLightOp = op;
        }
      }
      dom.fx.heroLight.style.setProperty('--hero-x', vpX.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-y', vpY.toFixed(1));
      dom.fx.heroLight.style.setProperty('--hero-r', heroLightR.toString());
      dom.fx.heroLight.style.setProperty('--hero-op', heroLightOp.toFixed(3));
    }

    /* 8) 歌词 */
    updateLyrics(time);

    rafId = requestAnimationFrame(tick);
  }

  /* ===================== 辅助 ===================== */
  /* carousel 容器 rect 缓存 */
  let cachedRect = null;
  let cachedRectW = 0, cachedRectH = 0;
  function getCarouselRect(){
    if(cachedRect && cachedRect.width === cachedRectW && cachedRect.height === cachedRectH){
      return cachedRect;
    }
    cachedRect = dom.carousel.getBoundingClientRect();
    cachedRectW = cachedRect.width;
    cachedRectH = cachedRect.height;
    return cachedRect;
  }
  window.addEventListener('resize', () => { cachedRect = null; });

  /* ===================== 歌词 =====================
   Director Spec V5:歌词根据 emotion 触发 5 种动画类型
     micro         普通:opacity 0→1, translateY 8px→0
     emotion       情绪:blur 7px→0, opacity .4→1, scale .96→1
     key           关键:Hero Light + Camera Focus
     time-rewind   "让那时间每一刻在倒退":Camera Pull + Reverse Parallax
     final         最终:Hero Isolation + Soft Glow
*/
  const lyricsData = (typeof LYRICS_DATA !== 'undefined') ? LYRICS_DATA : [];
  let currentLyricIdx = -1;
  let currentLyricMotionType = 'micro';

  /* 把 LYRIC_CUES 转成 idx → motionType 快速查询表 */
  const lyricMotionTypeMap = (() => {
    const m = new Map();
    for(const cue of LYRIC_CUES){ m.set(cue.idx, cue.motionType); }
    return m;
  })();

  function updateLyrics(time){
    if(lyricsData.length === 0) return;
    let idx = 0;
    for(let i=0;i<lyricsData.length;i++){
      if(time >= lyricsData[i].time) idx = i;
      else break;
    }
    if(idx !== currentLyricIdx){
      currentLyricIdx = idx;
      const motionType = lyricMotionTypeMap.get(idx) || 'micro';
      currentLyricMotionType = motionType;
      const text = lyricsData[idx].text;
      dom.lyricsText.classList.remove('show', 'fading', 'cue-micro', 'cue-emotion', 'cue-key', 'cue-time-rewind', 'cue-final');
      // 添加新类型(初始状态),使用 rAF 触发 show 进入下一帧
      dom.lyricsText.textContent = '';
      requestAnimationFrame(() => {
        dom.lyricsText.textContent = text;
        dom.lyricsText.classList.add('cue-' + motionType);
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
    syncCardPhotos(getCurrentPhotoIndex());
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
    syncCardPhotos(getCurrentPhotoIndex());
  });
  dom.rightZone.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.musicBox) window.musicBox.seek(Math.min(window.musicBox.totalDuration, window.musicBox.currentTime + 10));
    syncCardPhotos(getCurrentPhotoIndex());
  });

  /* Skip */
  dom.skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.Router) window.Router.go('interactive');
  });

  /* 唱片封面 2s 随机切换(保持原逻辑) */
  let currentVinylIdx = -1;
  let vinylSwapTimer = null;
  function forbidSet(){
    const set = new Set();
    const active = getCurrentPhotoIndex();
    if(active >= 0){
      set.add(active); set.add(active-1); set.add(active+1);
    }
    if(currentVinylIdx >= 0) set.add(currentVinylIdx);
    return set;
  }
  /* V6: vinyl swap 用 seeded RNG + 调用次数计数保证确定性 */
  const vinylRng = window.MotionScheduler.mulberry32(window.MotionScheduler.SCENE_SEED ^ 0x1B05);
  let vinylSwapCount = 0;
  function nextVinylIdx(forbid){
    const total = (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42);
    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(vinylRng() * total);
      attempts++;
    } while(forbid.has(idx) && attempts < 50);
    return forbid.has(idx) ? -1 : idx;
  }
  function swapVinyl(){
    const forbid = forbidSet();
    const idx = nextVinylIdx(forbid);
    if(idx < 0) return;
    currentVinylIdx = idx;
    vinylSwapCount++;
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
      const forbid = forbidSet();
      const idx = nextVinylIdx(forbid);
      if(idx < 0) return;
      currentVinylIdx = idx;
      dom.diskCover.src = getPhotoSrc(idx);
    }
    if(vinylSwapTimer) clearInterval(vinylSwapTimer);
    vinylSwapTimer = setInterval(swapVinyl, 2000);
  }
  startVinylSwap();

  /* RAF 启动 */
  function startRAF(){
    if(rafId) return;
    if(reduceMotion){
      // 静态渲染当前 stage
      const st = getStageState(0);
      const sty = STAGES[st.to];
      Object.keys(sty.fxMap).forEach(k => {
        if(dom.fx[k]) dom.fx[k].style.setProperty('--fx-op', sty.fxMap[k].toString());
      });
      document.body.classList.add('style-' + sty.typography);
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
  // 在 lyricsData 准备好后构建 EVENT_TIMELINE
  buildEventTimeline();
  startRAF();
  window._memoriesStart = startRAF;
  window._memoriesStop  = stopRAF;
})();
