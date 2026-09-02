/* ==================== Memory Director (Shot-based) ====================
   整个 S1 场景的视觉大脑。
   架构:
     MusicTimeline     按歌词情绪切分 8 个 StyleStage(决定 slots/cardVisual/fx/typography)
     ShotTimeline      按音乐时间切分若干一次性 Shot(决定 camera 运动)
     Camera Shot       10 种一次性 Shot: ESTABLISHING / PUSH_IN / SIDE_TRACK /
                       DOLLY_THROUGH / ORBIT / CRANE / PUSH_RACK_FOCUS / SNAP_ZOOM /
                       PULL_AWAY / STILLNESS
                       每个 Shot 有开始/发展/结束,不 infinite loop。
     RenderLoop        单 RAF: Shot 决定 camera transform → 写入 .camera-rig。
                       卡片只做"服务于相机"的小幅 parallax,不再自身随机漂浮/旋转。

   设计原则:
     - 卡片不自身无限旋转 / 圆周运动 / 随机漂浮
     - Camera 是主要运动源(push/pull/track/dolly/orbit/crane)
     - 卡片有固定 Z 深度(-700 ~ 0),相机推进时近卡快速掠过、远卡几乎不动(parallax)
     - 包含 Stillness 镜头(Motion → Stillness → Motion 形成节奏)
     - Shot 一次性完成,不循环

   Render Layer 架构 (氛围层 fixed 全视口,camera 不影响背景):
     L0 .layer-bg / L1 .layer-ambient / L2 .layer-particles / L4 .layer-effects / L5 .layer-typography
     都是 position:fixed inset:0,与 camera 完全解耦。
     L3 .layer-photo(camera-rig + 9 张 card)在 .carousel-area 内,接受 perspective。
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
  const SHOT_TIMELINE = [
    // cinematic (0-15s)
    { t: 0,     shot: 'ESTABLISHING' },
    { t: 6,     shot: 'PUSH_IN' },
    { t: 13,    shot: 'STILLNESS' },
    // film (15-55s)
    { t: 16,    shot: 'SIDE_TRACK' },
    { t: 25,    shot: 'STILLNESS' },
    { t: 27,    shot: 'DOLLY_THROUGH' },
    { t: 35,    shot: 'PULL_AWAY' },
    { t: 42,    shot: 'ORBIT' },
    // polaroid (55-90s)
    { t: 55,    shot: 'CRANE' },
    { t: 63,    shot: 'STILLNESS' },
    { t: 65,    shot: 'ORBIT' },
    { t: 78,    shot: 'SIDE_TRACK' },
    // editorial (90-115s)
    { t: 90,    shot: 'PUSH_RACK_FOCUS' },
    { t: 98,    shot: 'STILLNESS' },
    { t: 101,   shot: 'SIDE_TRACK' },
    { t: 110,   shot: 'PUSH_IN' },
    // collage (115-135s)
    { t: 115,   shot: 'DOLLY_THROUGH' },
    { t: 122,   shot: 'SNAP_ZOOM' },
    { t: 123,   shot: 'ORBIT' },
    { t: 132,   shot: 'STILLNESS' },
    // dream (135-170s)
    { t: 135,   shot: 'PULL_AWAY' },
    { t: 145,   shot: 'STILLNESS' },
    { t: 148,   shot: 'PUSH_RACK_FOCUS' },
    { t: 158,   shot: 'ORBIT' },
    // glitch (170-195s)
    { t: 170,   shot: 'SNAP_ZOOM' },
    { t: 171,   shot: 'DOLLY_THROUGH' },
    { t: 180,   shot: 'SIDE_TRACK' },
    { t: 190,   shot: 'STILLNESS' },
    // constellation (195-259s)
    { t: 195,   shot: 'PULL_AWAY' },
    { t: 205,   shot: 'STILLNESS' },
    { t: 210,   shot: 'ORBIT' },
    { t: 230,   shot: 'STILLNESS' },
    { t: 240,   shot: 'PULL_AWAY' },
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
  const EVENT_TIMELINE = [
    // cinematic (0-15s) — ESTABLISHING → PUSH_IN → STILLNESS
    { t: 3,    type:'card-enter',     card:1, preset:'fly-left' },
    { t: 7,    type:'card-enter',     card:2, preset:'fly-right' },
    { t: 12,   type:'foreground-pass',card:1 },                // card 1 掠过镜头(可见)

    // film (15-55s) — SIDE_TRACK → DOLLY_THROUGH → PULL_AWAY → ORBIT
    { t: 19,   type:'card-enter',     card:3, preset:'depth-in' },
    { t: 25,   type:'card-fly',       card:2 },                // card 2 飞过镜头(戏剧性)
    { t: 28,   type:'scatter' },                                // DOLLY_THROUGH 时散开
    { t: 31,   type:'reassemble' },                              // 重新汇聚(stagger)
    { t: 38,   type:'card-enter',     card:4, preset:'diagonal-in' },
    { t: 46,   type:'foreground-pass',card:2 },                // card 2 掠过

    // polaroid (55-90s) — CRANE → STILLNESS → ORBIT → SIDE_TRACK
    { t: 58,   type:'card-enter',     card:6, preset:'drop-top' },
    { t: 68,   type:'card-fly',       card:3 },                // card 3 飞过镜头
    { t: 70,   type:'card-enter',     card:7, preset:'rise-bottom' },
    { t: 82,   type:'scatter' },
    { t: 85,   type:'reassemble' },

    // editorial (90-115s) — PUSH_RACK_FOCUS → STILLNESS → SIDE_TRACK → PUSH_IN
    { t: 95,   type:'card-enter',     card:3, preset:'rotate-reveal' },
    { t: 108,  type:'foreground-pass',card:1 },

    // collage (115-135s) — DOLLY_THROUGH → SNAP_ZOOM → ORBIT → STILLNESS
    { t: 119,  type:'scatter' },
    { t: 124,  type:'reassemble' },
    { t: 128,  type:'card-fly',       card:4 },
    { t: 130,  type:'card-enter',     card:7, preset:'fly-right' },

    // dream (135-170s) — PULL_AWAY → STILLNESS → PUSH_RACK_FOCUS → ORBIT
    { t: 140,  type:'card-enter',     card:4, preset:'depth-out' },
    { t: 155,  type:'card-enter',     card:5, preset:'diagonal-in' },
    { t: 162,  type:'foreground-pass',card:3 },

    // glitch (170-195s) — SNAP_ZOOM → DOLLY_THROUGH → SIDE_TRACK → STILLNESS
    { t: 174,  type:'scatter' },
    { t: 178,  type:'reassemble' },
    { t: 188,  type:'card-fly',       card:5 },

    // constellation (195-259s) — PULL_AWAY → STILLNESS → ORBIT → STILLNESS → PULL_AWAY
    { t: 215,  type:'card-enter',     card:8, preset:'depth-in' },
    { t: 225,  type:'foreground-pass',card:2 },
    { t: 245,  type:'scatter' },
    { t: 250,  type:'reassemble' },
    { t: 255,  type:'card-fly',       card:1 },                // 收尾戏剧性
  ];

  /* 事件默认时长(ms) */
  const EVENT_DEFAULT_DURATION = {
    'card-enter':     1200,
    'foreground-pass':1000,
    'scatter':        900,
    'reassemble':     1100,
    'card-fly':       1400,
  };

  /* 获取当前活跃事件 — 返回数组,每个含 { type, card?, preset?, p, progress, startT, endT }
     p = 0..1 事件进度
     注:scatter/reassemble 期间,scatter 完成后立即 reassemble,所以两事件不重叠
  */
  function getActiveEvents(time){
    const out = [];
    for(const ev of EVENT_TIMELINE){
      const dur = (ev.dur || EVENT_DEFAULT_DURATION[ev.type]) / 1000;
      const startT = ev.t;
      const endT = ev.t + dur;
      if(time >= startT && time < endT){
        const p = clamp((time - startT) / dur, 0, 1);
        out.push({ ...ev, p, startT, endT });
      }
    }
    return out;
  }

  /* 计算事件对单张卡片造成的偏移 — 返回 {dx, dy, dz, dscale, drotZ, dopacity, dblur}
     偏移叠加到 slot 计算后的 target 上,然后参与 lerp */
  function getEventOffset(event, cardIdx, slot, time){
    const p = event.p;
    const type = event.type;

    if(type === 'card-enter' && event.card === cardIdx){
      /* ENTER PRESET:卡片从远处飞入,1→0 偏移(p=0 起始位置,p=1 无偏移)
         使用 easeOut 让运动减速到位 */
      const preset = ENTER_PRESETS[event.preset] || ENTER_PRESETS['fly-left'];
      const curve = CURVES[preset.easing] || CURVES.easeOut;
      const k = 1 - curve(p);  // 1 → 0 的偏移
      return {
        dx: preset.dx * k,
        dy: preset.dy * k,
        dz: preset.dz * k,
        dscale: (preset.scale - 1) * k,  // 起始 scale 0.7 → 减 0.3,最终 0
        drotZ: preset.drz * k,
        dopacity: -k * 0.5,  // 起始 opacity 0.5,最终 0 偏移
        dblur: 0,
      };
    }

    if(type === 'foreground-pass' && event.card === cardIdx){
      /* 前景掠过:卡片从屏幕一侧到另一侧,scale 2.5,opacity 1.0,z=+400
         p=0 在左侧外,p=0.5 中央(峰值),p=1 右侧外
         使用 sine curve 形成连续平滑移动
         视觉效果:大卡片横穿镜头,短暂遮挡主图 */
      const phase = p;  // 0..1
      const xMove = -1400 + phase * 2800;  // -1400 → +1400(屏幕外到屏幕外)
      const k = Math.sin(phase * Math.PI);  // 0→1→0 峰值
      return {
        dx: xMove,
        dy: -80 + k * -60,  // 中央时略上升
        dz: 400 * k,        // 峰值时 z=+400,镜头前
        dscale: 2.0 * k,   // 峰值 scale +2.0(配合 z=+400 + perspective,实际更大)
        drotZ: 12 * Math.cos(phase * Math.PI),  // 旋转跟随移动方向
        dopacity: 1.0 * k - 0.2,  // 峰值 +0.8,起始/结束 -0.2(隐藏)
        dblur: -1.0,  // 前景卡片不模糊
      };
    }

    if(type === 'scatter'){
      /* scatter: 所有外围卡片向外飞散(中心 card 0 不动)
         使用 easeOut 在前 60% 时间到达峰值,后 40% 稳定
         stagger 基于卡片 index(外围卡片先飞,中心稍后)
         视觉效果:外围卡片明显向外散开 */
      const stagger = cardIdx * 0.08;  // 每张卡片 stagger
      const adjP = clamp((p - stagger) / (1 - stagger), 0, 1);
      const k = CURVES.easeOut(adjP) * (adjP < 0.7 ? 1 : 1 - (adjP - 0.7) / 0.3 * 0.3);
      if(cardIdx === 0) return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
      // 根据卡片位置决定飞散方向
      const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
      const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
      return {
        dx: dirX * 500 * k,    // 增加位移(原本 300 → 500)
        dy: dirY * 350 * k,   // 增加位移(原本 200 → 350)
        dz: -200 * k,          // 略向远处退
        dscale: -0.4 * k,      // 缩小更多
        drotZ: dirX * 25 * k,  // 旋转更多
        dopacity: -0.5 * k,    // 透明度减少
        dblur: 2.0 * k,
      };
    }

    if(type === 'reassemble'){
      /* reassemble: 卡片从远处回到 slot(stagger)
         前 30% 时间散得更远(延续 scatter 状态),后 70% 时间汇聚到位
         使用 easeInOut 形成"先散后聚"的感觉 */
      const stagger = (NUM_CARDS - cardIdx) * 0.06;  // 反向 stagger(中心先聚,外围后聚)
      const adjP = clamp((p - stagger) / (1 - stagger), 0, 1);
      if(cardIdx === 0) return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
      // p<0.3 时偏移最大(散开),p>0.3 时偏移渐变到 0
      const dirX = slot.x > 50 ? 1 : (slot.x < 50 ? -1 : 0);
      const dirY = slot.y > 50 ? 1 : (slot.y < 50 ? -1 : 0);
      let k;
      if(adjP < 0.3){
        k = adjP / 0.3;  // 0→1,继续散开
      } else {
        k = 1 - CURVES.easeInOut((adjP - 0.3) / 0.7);  // 1→0,汇聚
      }
      return {
        dx: dirX * 500 * k,
        dy: dirY * 350 * k,
        dz: -200 * k,
        dscale: -0.4 * k,
        drotZ: dirX * 25 * k,
        dopacity: -0.5 * k,
        dblur: 2.0 * k,
      };
    }

    if(type === 'card-fly' && event.card === cardIdx){
      /* 卡片从远处飞到镜头前再飞走
         p=0 远处,p=0.5 镜头前(峰值),p=1 远处
         形成"飞过镜头"的感觉
         视觉效果:卡片穿越摄影机,非常戏剧性 */
      const k = Math.sin(p * Math.PI);  // 0→1→0
      const zMove = -700 + (1 - Math.abs(p - 0.5) * 2) * 1100;  // 远(z=-700) → 近(z=+400) → 远
      return {
        dx: -400 * (1 - p * 2),  // 左→右移动
        dy: 60 * k,
        dz: zMove,
        dscale: 1.5 * k,         // 峰值 +1.5(配合 z=+400 perspective)
        drotZ: 15 * (p - 0.5) * 2,
        dopacity: 1.0 * k - 0.3,
        dblur: -1.0,
      };
    }

    return { dx:0, dy:0, dz:0, dscale:0, drotZ:0, dopacity:0, dblur:0 };
  }

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
  function initParticles(){
    for(let i=0;i<MAX_PARTICLES;i++){
      const p = document.createElement('div');
      p.className = 'ambient-particle';
      p.style.width = (2 + Math.random()*3) + 'px';
      p.style.height = p.style.width;
      p.style.opacity = '0';
      dom.layerParts.appendChild(p);
      particles.push({
        el:p,
        x: Math.random()*100,
        y: Math.random()*100,
        vx: (Math.random()-0.5)*0.02,
        vy: (Math.random()-0.5)*0.02 - 0.005,
        phase: Math.random()*TAU,
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

  /* photo 同步:每张卡片绑定一个 photoOffset(相对于 active 的偏移) */
  function syncCardPhotos(activeIdx){
    // slot 0 = active, slot 1,2 = ±1, slot 3,4 = ±2, slot 5,6 = ±3, slot 7,8 = ±4
    const offsets = [0,-1,1,-2,2,-3,3,-4,4];
    cards.forEach((c, i) => {
      const photoIdx = clamp(activeIdx + offsets[i], 0, (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42) - 1);
      const src = getPhotoSrc(photoIdx);
      setCardImage(c, src);
      c.photoOffset = offsets[i];
    });
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
    const targetCam = shotResult.cam;

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

    /* 5) Photo:每张 card
       卡片只做"服务于相机"的小幅 parallax:
         - camera.x 移动时,近卡反向位移大、远卡位移小
         - camera.z 推进时,近卡 z 跟随变化更大(产生过镜头效果)
         - camera.scale 由 .camera-rig 的 scale 统一处理,这里不再额外 scale
         - 卡片不自身旋转
       parallax factor:z=0 时 = 1(完全跟随),z=-700 时 = 0.1(几乎不动) */
    const activeIdx = getCurrentPhotoIndex();
    syncCardPhotos(activeIdx);

    /* 焦点(仅 PUSH_RACK_FOCUS Shot 用,其他 Shot focusIdx 不存在,所有 card 都 sharp) */
    const focusIdx = shotResult.focusIdx;

    /* 当前活跃事件 — 在 Shot 之上叠加一次性事件编舞(card-enter/foreground-pass/scatter/reassemble) */
    const activeEvents = getActiveEvents(time);

    cards.forEach((c, i) => {
      const slotA = fromStage.slots[i];
      const slotB = toStage.slots[i];
      const slot  = {
        x: lerp(slotA.x, slotB.x, morphT),
        y: lerp(slotA.y, slotB.y, morphT),
        z: lerp(slotA.z, slotB.z, morphT),
        w: lerp(slotA.w, slotB.w, morphT),
        h: lerp(slotA.h, slotB.h, morphT),
        rotX: lerp(slotA.rotX, slotB.rotX, morphT),
        rotY: lerp(slotA.rotY, slotB.rotY, morphT),
        rotZ: lerp(slotA.rotZ, slotB.rotZ, morphT),
        scale: lerp(slotA.scale, slotB.scale, morphT),
        blur: lerp(slotA.blur, slotB.blur, morphT),
        opacity: lerp(slotA.opacity, slotB.opacity, morphT),
        brightness: lerp(slotA.brightness, slotB.brightness, morphT),
        saturate: lerp(slotA.saturate, slotB.saturate, morphT),
      };

      /* Parallax factor:基于卡片 z 深度
         z = 0 时 factor = 1(完全跟随相机)
         z = -700 时 factor = 0.1(几乎不动)
         z = +80(前景遮挡)时 factor = 1.5(更快掠过) */
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
      if(i === 0){
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

      /* 卡片只做服务于相机的 parallax + 事件叠加:
         - camera.x 移动时,近卡反向位移大、远卡位移小
         - camera.y 同理
         - camera.z 推进时,卡片 z 也跟随调整(近卡更敏感)
         - 事件偏移直接加到 target 上(参与 lerp,平滑过渡) */
      const targetX = px - camLive.x * parallaxFactor + evOff.dx;
      const targetY = py - camLive.y * parallaxFactor + evOff.dy;
      const targetZ = slot.z + camLive.z * parallaxFactor * 0.3 + evOff.dz;
      const rotX = slot.rotX;  // 不动
      const rotY = slot.rotY;
      const rotZ = slot.rotZ + evOff.drotZ;
      const blur = clamp(slot.blur + focus.blur + evOff.dblur, 0, 2.5);
      const brightness = slot.brightness * focus.brightness;
      const saturate = slot.saturate * focus.saturate;
      const targetScale = Math.max(0.1, slot.scale + evOff.dscale);  // 事件可改 scale
      const targetOpacity = clamp(slot.opacity + evOff.dopacity, 0, 1);

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
      c.el.style.transform =
        `translate3d(-50%, -50%, 0)` +
        ` translate3d(${L.x.toFixed(2)}px, ${L.y.toFixed(2)}px, ${L.z.toFixed(2)}px)` +
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

    /* 7) 歌词 */
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
      dom.lyricsText.classList.add('fading');
      setTimeout(() => {
        dom.lyricsText.textContent = lyricsData[idx].text;
        dom.lyricsText.classList.remove('fading');
        dom.lyricsText.classList.add('show');
      }, 380);
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
  function swapVinyl(){
    const forbid = forbidSet();
    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42));
      attempts++;
    } while(forbid.has(idx) && attempts < 50);
    if(forbid.has(idx)) return;
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
      const forbid = forbidSet();
      let idx = Math.floor(Math.random() * (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42));
      while(forbid.has(idx)) idx = Math.floor(Math.random() * (typeof NUM_PHOTOS !== 'undefined' ? NUM_PHOTOS : 42));
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
  startRAF();
  window._memoriesStart = startRAF;
  window._memoriesStop  = stopRAF;
})();
