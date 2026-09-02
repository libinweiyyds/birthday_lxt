/* ==================== 场景2：回忆 — Style Engine ====================
   整段音乐被切分为 8 个视觉风格:
     01 CINEMATIC  02 FILM  03 POLAROID  04 EDITORIAL
     05 COLLAGE    06 DREAM 07 GLITCH   08 CONSTELLATION
   每个 Style 是一个完整描述符:卡片布局 + 摄影机 + 运动 + 装饰 + typography。
   切换不是 fade-out/in,而是真正的 morph:卡片位置 / 尺寸 / 旋转 / 模糊 / 透明度
   都在相邻 Style 之间由 RAF lerp,照片内容跨 Style 保持连续。

   依赖:images.js(NUM_PHOTOS, imageUrls, memoryCaptions)
        music/.../lyrics.js(window.LYRICS_DATA)
        window.musicBox(包装 <audio>)提供 currentTime / totalDuration
*/
(function(){
  'use strict';

  /* ===================== DOM 引用 ===================== */
  const memoryCarousel = document.getElementById('memoryCarousel');
  const cameraRig      = document.getElementById('cameraRig');
  const memoryLeftZone = document.getElementById('memoryLeftZone');
  const memoryRightZone= document.getElementById('memoryRightZone');
  const diskCoverImg   = document.getElementById('diskCoverImg');
  const skipBtn        = document.getElementById('skipBtn');

  const decorMap = {
    cinematic:    null,                                 // 无装饰
    film:         document.getElementById('decorFilm'),
    polaroid:     document.getElementById('decorPolaroid'),
    editorial:    document.getElementById('decorEditorial'),
    collage:      document.getElementById('decorCollage'),
    dream:        document.getElementById('decorDream'),
    glitch:       document.getElementById('decorGlitch'),
    constellation:document.getElementById('decorConstellation'),
  };

  /* ===================== 工具 ===================== */
  const lerp  = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const smoothstep = t => t * t * (3 - 2 * t);
  const damp  = (lambda, dt) => 1 - Math.exp(-lambda * dt);

  /* 把 angle(度)做最短路径插值 */
  function lerpAngle(a, b, t){
    let d = b - a;
    while(d > 180) d -= 360;
    while(d < -180) d += 360;
    return a + d * t;
  }

  /* ===================== 卡片池(共享 9 张 DOM) ===================== */
  const POOL_SIZE = 9;
  function buildCard(){
    const card = document.createElement('div');
    card.className = 'memory-card';
    const img = document.createElement('img');
    img.alt = '回忆';
    img.loading = 'eager';
    const cap = document.createElement('div');
    cap.className = 'caption';
    card.appendChild(img);
    card.appendChild(cap);
    memoryCarousel.appendChild(card);
    return { el:card, img:img, cap:cap, photoIdx:-1, st:makeCardState() };
  }
  function makeCardState(){
    return {
      // 真实 lerp 值(由 RAF 写入)
      x:0, y:0, z:0,
      w:300, h:400,
      rotX:0, rotY:0, rotZ:0,
      scale:1,
      blur:0, opacity:0,
      brightness:1, saturate:1,
      // 浮动相位(独立 → 不同步)
      bob:{ amp:4, freq:0.18, phase:Math.random()*Math.PI*2 },
      drift:{ amp:3, freq:0.13, phase:Math.random()*Math.PI*2 },
      spin:{ amp:0.8, freq:0.07, phase:Math.random()*Math.PI*2 },
      // 上次触发图片切换的时间(避免每帧重设 src)
      lastSrcAt:0,
    };
  }

  function imgFallback(imgEl){
    imgEl.addEventListener('error', function(){
      if(this.dataset.fallbackApplied === '1') return;
      this.dataset.fallbackApplied = '1';
      this.src = 'img/1.jpg';
    });
  }

  const pool = [];
  for(let i=0;i<POOL_SIZE;i++){
    const c = buildCard();
    imgFallback(c.img);
    pool.push(c);
  }

  function setCardPhoto(c, photoIdx){
    if(c.photoIdx === photoIdx) return;
    c.photoIdx = photoIdx;
    const src = (typeof imageUrls !== 'undefined') ? imageUrls[photoIdx] : '';
    const cap = (typeof memoryCaptions !== 'undefined') ? memoryCaptions[photoIdx] : '';
    if(src && c.img.getAttribute('src') !== src){
      c.img.src = src;
      // 仅在 CINEMATIC 风格下触发切换滑入动画
      if(currentStyleName === 'cinematic'){
        c.img.classList.remove('switching');
        void c.img.offsetWidth;
        c.img.classList.add('switching');
      }
    }
    c.cap.textContent = cap;
  }

  /* ===================== 8 个 Style 描述符 =====================
     每个描述符:
       cssClass  卡片要加的 css 类
       camera    {x, y, z, rotX, rotY, rotZ, scale} 摄影机状态
       motion    {floatingAmp, rotationAmp, parallax} 浮动强度
       slots     Array<{x,y,z,w,h,rotX,rotY,rotZ,scale,blur,opacity,brightness,saturate}>
                 长度 = POOL_SIZE, 每个 slot 描述该卡片在当前 Style 下的"目标空间状态"
                 坐标采用相对 carousel 中心 (%) 的百分比
       transition 0~1,从上一个 Style 到当前 Style 的过渡速度
  */

  /* slot 工厂:横向 5 张 + 远处 4 张(相对中心百分比) */
  const CENTER = { x:50, y:50 };

  function makeCinematic(){
    const s = [];
    // 0:主图(中央) 1:左1 2:右1 3:左2 4:右2 5~8:更远
    s.push({ x:50, y:50, z:0,    w:300, h:400, rotX:0, rotY:0,   rotZ:0,   scale:1.00, blur:0,   opacity:1.00, brightness:1.05, saturate:1.10 });
    s.push({ x:24, y:48, z:-90,  w:240, h:340, rotX:0, rotY:-6,  rotZ:10,  scale:0.86, blur:0.6, opacity:0.80, brightness:0.95, saturate:0.95 });
    s.push({ x:76, y:52, z:-90,  w:240, h:340, rotX:0, rotY:6,   rotZ:-10, scale:0.86, blur:0.6, opacity:0.80, brightness:0.95, saturate:0.95 });
    s.push({ x:10, y:45, z:-200, w:200, h:300, rotX:0, rotY:-10, rotZ:16,  scale:0.70, blur:2.4, opacity:0.45, brightness:0.80, saturate:0.75 });
    s.push({ x:90, y:55, z:-200, w:200, h:300, rotX:0, rotY:10,  rotZ:-16, scale:0.70, blur:2.4, opacity:0.45, brightness:0.80, saturate:0.75 });
    // 5~8 更远的浮动背景
    s.push({ x:5,  y:60, z:-340, w:160, h:220, rotX:0, rotY:-8,  rotZ:6,   scale:0.55, blur:5,   opacity:0.20, brightness:0.65, saturate:0.6 });
    s.push({ x:95, y:40, z:-340, w:160, h:220, rotX:0, rotY:8,   rotZ:-6,  scale:0.55, blur:5,   opacity:0.20, brightness:0.65, saturate:0.6 });
    s.push({ x:30, y:80, z:-420, w:140, h:190, rotX:0, rotY:-4,  rotZ:3,   scale:0.45, blur:7,   opacity:0.12, brightness:0.55, saturate:0.5 });
    s.push({ x:70, y:20, z:-420, w:140, h:190, rotX:0, rotY:4,   rotZ:-3,  scale:0.45, blur:7,   opacity:0.12, brightness:0.55, saturate:0.5 });
    return s;
  }

  function makeFilm(){
    // 横向胶片:所有卡片同一高度,横排
    const s = [];
    // 主图(中央,稍大)
    s.push({ x:50, y:50, z:0,    w:300, h:380, rotX:0, rotY:0, rotZ:0,   scale:1.00, blur:0,   opacity:1,    brightness:1.08, saturate:0.95 });
    // 左 1~3 / 右 1~3:连续胶片
    const arr = [];
    [40, 30, 20].forEach(px => arr.push({ x:px, y:50, rotZ: 1.5 }));
    [60, 70, 80].forEach(px => arr.push({ x:px, y:50, rotZ:-1.5 }));
    arr.forEach((it, i) => {
      s.push({ x:it.x, y:it.y, z:-30-i*15, w:200, h:280, rotX:0, rotY:0, rotZ:it.rotZ, scale:0.85, blur:0.4, opacity:0.85, brightness:1, saturate:0.9 });
    });
    // 2 张最远
    s.push({ x:8,  y:50, z:-120, w:170, h:230, rotX:0, rotY:0, rotZ:2,  scale:0.72, blur:1.2, opacity:0.6, brightness:0.85, saturate:0.8 });
    s.push({ x:92, y:50, z:-120, w:170, h:230, rotX:0, rotY:0, rotZ:-2, scale:0.72, blur:1.2, opacity:0.6, brightness:0.85, saturate:0.8 });
    return s;
  }

  function makePolaroid(){
    // 桌面式错落,每张卡不同 size/rotate
    const s = [];
    s.push({ x:50, y:50, z:10, w:300, h:380, rotX:0, rotY:0,  rotZ:0,   scale:1.05, blur:0,   opacity:1,    brightness:1.05, saturate:1.05 });
    s.push({ x:22, y:38, z:-20, w:220, h:280, rotX:0, rotY:0,  rotZ:-9,  scale:0.85, blur:0,   opacity:0.95, brightness:1,    saturate:1   });
    s.push({ x:78, y:38, z:-20, w:220, h:280, rotX:0, rotY:0,  rotZ:8,   scale:0.85, blur:0,   opacity:0.95, brightness:1,    saturate:1   });
    s.push({ x:18, y:74, z:-50, w:200, h:250, rotX:0, rotY:0,  rotZ:5,   scale:0.78, blur:0.3, opacity:0.9,  brightness:0.95, saturate:0.95});
    s.push({ x:82, y:74, z:-50, w:200, h:250, rotX:0, rotY:0,  rotZ:-6,  scale:0.78, blur:0.3, opacity:0.9,  brightness:0.95, saturate:0.95});
    s.push({ x:36, y:80, z:-90, w:170, h:210, rotX:0, rotY:0,  rotZ:-3,  scale:0.65, blur:0.8, opacity:0.7,  brightness:0.9,  saturate:0.9 });
    s.push({ x:64, y:18, z:-90, w:170, h:210, rotX:0, rotY:0,  rotZ:4,   scale:0.65, blur:0.8, opacity:0.7,  brightness:0.9,  saturate:0.9 });
    s.push({ x:8,  y:55, z:-150, w:140, h:180, rotX:0, rotY:0, rotZ:7,   scale:0.5,  blur:2,   opacity:0.45, brightness:0.8,  saturate:0.8 });
    s.push({ x:92, y:50, z:-150, w:140, h:180, rotX:0, rotY:0, rotZ:-7,  scale:0.5,  blur:2,   opacity:0.45, brightness:0.8,  saturate:0.8 });
    return s;
  }

  function makeEditorial(){
    // 杂志版式:主图大、靠一边,左右副图小
    const s = [];
    s.push({ x:50, y:50, z:0,    w:520, h:380, rotX:0, rotY:0, rotZ:0,   scale:1.0, blur:0, opacity:1, brightness:1.05, saturate:0.95 });
    s.push({ x:12, y:78, z:-30,  w:160, h:200, rotX:0, rotY:0, rotZ:-2,  scale:0.9, blur:0, opacity:0.95, brightness:1, saturate:0.95 });
    s.push({ x:88, y:22, z:-30,  w:160, h:200, rotX:0, rotY:0, rotZ:2,   scale:0.9, blur:0, opacity:0.95, brightness:1, saturate:0.95 });
    s.push({ x:25, y:18, z:-90,  w:130, h:160, rotX:0, rotY:0, rotZ:3,   scale:0.7, blur:0.5, opacity:0.7, brightness:0.95, saturate:0.9 });
    s.push({ x:75, y:82, z:-90,  w:130, h:160, rotX:0, rotY:0, rotZ:-3,  scale:0.7, blur:0.5, opacity:0.7, brightness:0.95, saturate:0.9 });
    s.push({ x:50, y:8,  z:-160, w:120, h:140, rotX:0, rotY:0, rotZ:0,   scale:0.55, blur:2, opacity:0.45, brightness:0.8, saturate:0.85 });
    s.push({ x:50, y:92, z:-160, w:120, h:140, rotX:0, rotY:0, rotZ:0,   scale:0.55, blur:2, opacity:0.45, brightness:0.8, saturate:0.85 });
    s.push({ x:5,  y:50, z:-220, w:110, h:140, rotX:0, rotY:0, rotZ:0,   scale:0.45, blur:4, opacity:0.25, brightness:0.7, saturate:0.8 });
    s.push({ x:95, y:50, z:-220, w:110, h:140, rotX:0, rotY:0, rotZ:0,   scale:0.45, blur:4, opacity:0.25, brightness:0.7, saturate:0.8 });
    return s;
  }

  function makeCollage(){
    // 2x2 网格 + 角落碎片
    const s = [];
    // 0~3 主 4 块:2x2
    s.push({ x:42, y:40, z:0,    w:260, h:300, rotX:0, rotY:0, rotZ:-3,  scale:1.0, blur:0, opacity:1,    brightness:1.05, saturate:1.0 });
    s.push({ x:58, y:40, z:-10,  w:260, h:300, rotX:0, rotY:0, rotZ:2,   scale:1.0, blur:0, opacity:0.95, brightness:1,    saturate:1.0 });
    s.push({ x:42, y:60, z:-10,  w:260, h:300, rotX:0, rotY:0, rotZ:3,   scale:1.0, blur:0, opacity:0.95, brightness:1,    saturate:1.0 });
    s.push({ x:58, y:60, z:-10,  w:260, h:300, rotX:0, rotY:0, rotZ:-2,  scale:1.0, blur:0, opacity:0.95, brightness:1,    saturate:1.0 });
    // 4~8 角落小碎片
    s.push({ x:14, y:18, z:-50,  w:140, h:180, rotX:0, rotY:0, rotZ:-12, scale:0.8, blur:0.4, opacity:0.85, brightness:1,    saturate:1 });
    s.push({ x:86, y:22, z:-50,  w:140, h:180, rotX:0, rotY:0, rotZ:14,  scale:0.8, blur:0.4, opacity:0.85, brightness:1,    saturate:1 });
    s.push({ x:18, y:84, z:-50,  w:140, h:180, rotX:0, rotY:0, rotZ:10,  scale:0.8, blur:0.4, opacity:0.85, brightness:1,    saturate:1 });
    s.push({ x:84, y:80, z:-60,  w:140, h:180, rotX:0, rotY:0, rotZ:-15, scale:0.8, blur:0.4, opacity:0.85, brightness:1,    saturate:1 });
    s.push({ x:50, y:50, z:30,   w:120, h:140, rotX:0, rotY:0, rotZ:0,   scale:0.9, blur:0,   opacity:0,    brightness:1,    saturate:1 });
    return s;
  }

  function makeDream(){
    // 散乱大尺寸,大幅 blur 与飘忽
    const s = [];
    s.push({ x:50, y:50, z:0,    w:340, h:440, rotX:0, rotY:0, rotZ:0,  scale:1.0, blur:0, opacity:0.95, brightness:1.1, saturate:1.15 });
    s.push({ x:28, y:40, z:-60,  w:240, h:320, rotX:0, rotY:0, rotZ:-6, scale:0.85, blur:0.5, opacity:0.85, brightness:1,    saturate:1.1 });
    s.push({ x:72, y:60, z:-60,  w:240, h:320, rotX:0, rotY:0, rotZ:7,  scale:0.85, blur:0.5, opacity:0.85, brightness:1,    saturate:1.1 });
    s.push({ x:18, y:70, z:-140, w:200, h:260, rotX:0, rotY:0, rotZ:8,  scale:0.7, blur:1.5, opacity:0.6,  brightness:0.95, saturate:1.05 });
    s.push({ x:82, y:30, z:-140, w:200, h:260, rotX:0, rotY:0, rotZ:-7, scale:0.7, blur:1.5, opacity:0.6,  brightness:0.95, saturate:1.05 });
    s.push({ x:40, y:85, z:-220, w:170, h:220, rotX:0, rotY:0, rotZ:-4, scale:0.55, blur:3,  opacity:0.45, brightness:0.9,  saturate:1 });
    s.push({ x:60, y:15, z:-220, w:170, h:220, rotX:0, rotY:0, rotZ:4,  scale:0.55, blur:3,  opacity:0.45, brightness:0.9,  saturate:1 });
    s.push({ x:8,  y:50, z:-300, w:150, h:200, rotX:0, rotY:0, rotZ:0,  scale:0.4, blur:6,  opacity:0.3,  brightness:0.85, saturate:0.95 });
    s.push({ x:92, y:50, z:-300, w:150, h:200, rotX:0, rotY:0, rotZ:0,  scale:0.4, blur:6,  opacity:0.3,  brightness:0.85, saturate:0.95 });
    return s;
  }

  function makeGlitch(){
    // 倾斜切割,部分 RGB 偏移
    const s = [];
    s.push({ x:50, y:50, z:0,    w:300, h:380, rotX:0, rotY:0,  rotZ:0,    scale:1.0, blur:0,   opacity:1,    brightness:1.1,  saturate:1.2 });
    s.push({ x:24, y:48, z:-50,  w:220, h:300, rotX:0, rotY:0,  rotZ:-8,   scale:0.85, blur:0.4, opacity:0.9,  brightness:1.05, saturate:1.15 });
    s.push({ x:76, y:52, z:-50,  w:220, h:300, rotX:0, rotY:0,  rotZ:9,    scale:0.85, blur:0.4, opacity:0.9,  brightness:1.05, saturate:1.15 });
    s.push({ x:14, y:38, z:-120, w:180, h:240, rotX:0, rotY:0,  rotZ:-14,  scale:0.7, blur:1,    opacity:0.65, brightness:0.95, saturate:1.1 });
    s.push({ x:86, y:62, z:-120, w:180, h:240, rotX:0, rotY:0,  rotZ:13,   scale:0.7, blur:1,    opacity:0.65, brightness:0.95, saturate:1.1 });
    s.push({ x:35, y:82, z:-200, w:160, h:210, rotX:0, rotY:0,  rotZ:6,    scale:0.55, blur:3,   opacity:0.45, brightness:0.85, saturate:1.05 });
    s.push({ x:65, y:18, z:-200, w:160, h:210, rotX:0, rotY:0,  rotZ:-5,   scale:0.55, blur:3,   opacity:0.45, brightness:0.85, saturate:1.05 });
    s.push({ x:8,  y:55, z:-280, w:140, h:180, rotX:0, rotY:0,  rotZ:3,    scale:0.45, blur:5,   opacity:0.25, brightness:0.75, saturate:1.0 });
    s.push({ x:92, y:45, z:-280, w:140, h:180, rotX:0, rotY:0,  rotZ:-3,   scale:0.45, blur:5,   opacity:0.25, brightness:0.75, saturate:1.0 });
    return s;
  }

  function makeConstellation(){
    // 卡片变小,主要在远处,中央放主卡(像星空中一颗)
    const s = [];
    s.push({ x:50, y:50, z:0,    w:260, h:340, rotX:0, rotY:0, rotZ:0,  scale:1.0, blur:0, opacity:1,    brightness:1,    saturate:0.9 });
    s.push({ x:20, y:30, z:-100, w:160, h:210, rotX:0, rotY:0, rotZ:6,  scale:0.7, blur:0.6, opacity:0.8,  brightness:0.9,  saturate:0.85 });
    s.push({ x:80, y:70, z:-100, w:160, h:210, rotX:0, rotY:0, rotZ:-7, scale:0.7, blur:0.6, opacity:0.8,  brightness:0.9,  saturate:0.85 });
    s.push({ x:85, y:24, z:-180, w:130, h:170, rotX:0, rotY:0, rotZ:9,  scale:0.55, blur:1.5, opacity:0.6,  brightness:0.85, saturate:0.8 });
    s.push({ x:15, y:76, z:-180, w:130, h:170, rotX:0, rotY:0, rotZ:-9, scale:0.55, blur:1.5, opacity:0.6,  brightness:0.85, saturate:0.8 });
    s.push({ x:48, y:12, z:-260, w:110, h:140, rotX:0, rotY:0, rotZ:4,  scale:0.45, blur:2.5, opacity:0.45, brightness:0.8,  saturate:0.75 });
    s.push({ x:52, y:88, z:-260, w:110, h:140, rotX:0, rotY:0, rotZ:-4, scale:0.45, blur:2.5, opacity:0.45, brightness:0.8,  saturate:0.75 });
    s.push({ x:8,  y:50, z:-340, w:90,  h:120, rotX:0, rotY:0, rotZ:0,  scale:0.35, blur:4,   opacity:0.3,  brightness:0.75, saturate:0.7 });
    s.push({ x:92, y:50, z:-340, w:90,  h:120, rotX:0, rotY:0, rotZ:0,  scale:0.35, blur:4,   opacity:0.3,  brightness:0.75, saturate:0.7 });
    return s;
  }

  const STYLES = {
    cinematic: {
      name:'cinematic', cssClass:'style-cinematic', bodyClass:'style-cinematic',
      slots: makeCinematic(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1 },
      motion:{ floatingAmp:1.0, rotationAmp:1.0, parallax:1.0, drift:1.0 },
      glow:  1.0,
    },
    film: {
      name:'film', cssClass:'style-film', bodyClass:'style-film',
      slots: makeFilm(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1.02 },
      motion:{ floatingAmp:0.15, rotationAmp:0.05, parallax:0.0, drift:0.4 }, // 胶片基本只横向移动
      glow:  0.4,
    },
    polaroid: {
      name:'polaroid', cssClass:'style-polaroid', bodyClass:'style-polaroid',
      slots: makePolaroid(),
      camera:{ x:0, y:-10, rotX:2, rotY:0, scale:1.0 },
      motion:{ floatingAmp:0.6, rotationAmp:0.4, parallax:0.4, drift:0.7 },
      glow:  0.5,
    },
    editorial: {
      name:'editorial', cssClass:'style-editorial', bodyClass:'style-editorial',
      slots: makeEditorial(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1.0 },
      motion:{ floatingAmp:0.3, rotationAmp:0.05, parallax:0.2, drift:0.3 },
      glow:  0.6,
    },
    collage: {
      name:'collage', cssClass:'style-collage', bodyClass:'style-collage',
      slots: makeCollage(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1.0 },
      motion:{ floatingAmp:0.4, rotationAmp:0.2, parallax:0.3, drift:0.4 },
      glow:  0.7,
    },
    dream: {
      name:'dream', cssClass:'style-dream', bodyClass:'style-dream',
      slots: makeDream(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1.01 },
      motion:{ floatingAmp:0.7, rotationAmp:0.5, parallax:0.5, drift:0.8 },
      glow:  1.0,
    },
    glitch: {
      name:'glitch', cssClass:'style-glitch', bodyClass:'style-glitch',
      slots: makeGlitch(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1.0 },
      motion:{ floatingAmp:0.6, rotationAmp:1.2, parallax:0.6, drift:1.4 },
      glow:  0.85,
    },
    constellation: {
      name:'constellation', cssClass:'style-constellation', bodyClass:'style-constellation',
      slots: makeConstellation(),
      camera:{ x:0, y:0, rotX:0, rotY:0, scale:1.0 },
      motion:{ floatingAmp:0.25, rotationAmp:0.15, parallax:0.4, drift:0.3 },
      glow:  1.1,
    },
  };

  /* ===================== 时间轴(按歌词情绪切分) ===================== */
  /* 8 段时间(秒),与 LYRICS_DATA 同步;最后一段延长到 totalDuration */
  function getTotalDuration(){
    return (window.musicBox && window.musicBox.totalDuration) || 259;
  }
  function getTimeline(){
    const total = getTotalDuration();
    const end   = Math.min(total, 259);
    // 8 个切换点(秒),从 0 开始
    return [
      0,        // -> cinematic 起始
      15,       // -> film
      55,       // -> polaroid
      90,       // -> editorial
      115,      // -> collage
      135,      // -> dream
      170,      // -> glitch
      195,      // -> constellation
      end,      // 总长
    ];
  }
  // 切换顺序:0~15 cinematic,15~55 film, 55~90 polaroid, 90~115 editorial, 115~135 collage, 135~170 dream, 170~195 glitch, 195~end constellation
  const STYLE_SEQUENCE = ['cinematic','film','polaroid','editorial','collage','dream','glitch','constellation'];

  /* 给定 currentTime,返回 { from, to, progress } */
  function getCurrentStyleState(time){
    const tl = getTimeline();
    // tl[i] 是 STYLE_SEQUENCE[i-1] 起始时刻
    // i = 0 时不切换;从 i=1 开始, STYLE_SEQUENCE[i-1] 在 tl[i] 开始生效
    let idx = 0;
    for(let i=1;i<tl.length;i++){
      if(time >= tl[i]) idx = i;
      else break;
    }
    const fromName = STYLE_SEQUENCE[clamp(idx-1, 0, STYLE_SEQUENCE.length-1)];
    const toName   = STYLE_SEQUENCE[clamp(idx,   0, STYLE_SEQUENCE.length-1)];
    const start = tl[idx];
    const end   = tl[Math.min(idx+1, tl.length-1)];
    // 头尾段:progress=1(已稳定在 to)
    let progress = 1;
    if(idx > 0 && end > start){
      progress = clamp((time - start) / (end - start), 0, 1);
    }
    return { from:fromName, to:toName, progress, index:idx };
  }

  /* ===================== 照片分配 ===================== */
  function getCurrentMemoryIndex(){
    const t = window.musicBox ? window.musicBox.currentTime : 0;
    const total = getTotalDuration();
    const singleDur = total / NUM_PHOTOS;
    return clamp(Math.floor(t / singleDur), 0, NUM_PHOTOS - 1);
  }

  /* 给每张卡片分配 photoIdx:0=主图,1~8=周围 */
  /* 周围卡片按"当前 active idx 的偏移"挑选,保证跨 Style 连续 */
  function pickPhotoForSlot(slotIdx, activeIdx){
    // slot 0 = 主图 = active
    // 其他 slot 与 active 的"逻辑距离"由 STYLE 决定,但这里用一个稳定的 lookup 数组
    const slots = [0, -1, 1, -2, 2, -3, 3, -4, 4];
    return clamp(activeIdx + (slots[slotIdx] || 0), 0, NUM_PHOTOS - 1);
  }

  /* 把当前 active index 应用到所有卡片 */
  let currentActiveIdx = -1;
  function syncCardPhotos(){
    const active = getCurrentMemoryIndex();
    if(active === currentActiveIdx) return;
    currentActiveIdx = active;
    pool.forEach((c, i) => setCardPhoto(c, pickPhotoForSlot(i, active)));
  }

  /* ===================== Decor / body class 切换 ===================== */
  let currentStyleName = 'cinematic';
  function applyStyleClass(toName){
    if(currentStyleName === toName) return;
    const old = STYLES[currentStyleName];
    const nw  = STYLES[toName];
    // body class
    document.body.classList.remove(old.bodyClass);
    document.body.classList.add(nw.bodyClass);
    // 卡片 css class(只切主图需要的视觉,这里给所有卡片加,后续每张按 slot 决定)
    pool.forEach(c => {
      c.el.classList.remove(old.cssClass);
      c.el.classList.add(nw.cssClass);
    });
    // 主图加 .is-main(用于 polaroid / collage / dream / glitch / constellation / film 仅主卡显示 box-shadow 等)
    pool.forEach((c, i) => {
      c.el.classList.toggle('is-main', i === 0);
    });
    // decor
    if(decorMap[old.name]) decorMap[old.name].classList.remove('active');
    if(decorMap[nw.name])  decorMap[nw.name].classList.add('active');
    currentStyleName = toName;
  }

  /* ===================== RAF 主循环 ===================== */
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let camX=0, camY=0, camRX=0, camRY=0, camScale=1;
  let lastT = performance.now();
  let rafId = 0;

  /* 把 slot(%) 转成像素,基于 carousel 区域
     缓存 rect,只在 resize 时重读,避免每帧 9 次 layout */
  let cachedRect = null;
  let cachedRectW = 0, cachedRectH = 0;
  function getCarouselRect(){
    if(cachedRect && cachedRect.width === cachedRectW && cachedRect.height === cachedRectH){
      return cachedRect;
    }
    cachedRect = memoryCarousel.getBoundingClientRect();
    cachedRectW = cachedRect.width;
    cachedRectH = cachedRect.height;
    return cachedRect;
  }
  window.addEventListener('resize', () => {
    cachedRect = null;
  });
  function pctToPx(slot){
    const rect = getCarouselRect();
    return {
      x: (slot.x/100) * rect.width  - rect.width  / 2,
      y: (slot.y/100) * rect.height - rect.height / 2,
    };
  }

  function lerpSlot(a, b, t){
    // a,b 是 STYLES.x.slots[i]
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      w: lerp(a.w, b.w, t),
      h: lerp(a.h, b.h, t),
      rotX: lerp(a.rotX, b.rotX, t),
      rotY: lerp(a.rotY, b.rotY, t),
      rotZ: lerpAngle(a.rotZ, b.rotZ, t),
      scale: lerp(a.scale, b.scale, t),
      blur: lerp(a.blur, b.blur, t),
      opacity: lerp(a.opacity, b.opacity, t),
      brightness: lerp(a.brightness, b.brightness, t),
      saturate: lerp(a.saturate, b.saturate, t),
    };
  }
  function lerpMotion(a, b, t){
    return {
      floatingAmp: lerp(a.floatingAmp, b.floatingAmp, t),
      rotationAmp: lerp(a.rotationAmp, b.rotationAmp, t),
      parallax:    lerp(a.parallax, b.parallax, t),
      drift:       lerp(a.drift, b.drift, t),
    };
  }
  function lerpCamera(a, b, t){
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      rotX: lerp(a.rotX, b.rotX, t),
      rotY: lerp(a.rotY, b.rotY, t),
      scale: lerp(a.scale, b.scale, t),
    };
  }

  function tick(now){
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const time = window.musicBox ? window.musicBox.currentTime : 0;

    /* 1) 当前 Style 状态 */
    const st = getCurrentStyleState(time);
    const fromStyle = STYLES[st.from];
    const toStyle   = STYLES[st.to];
    const morphT    = smoothstep(st.progress);

    // 切 cssClass / bodyClass(只在 Style 名称变化时)
    applyStyleClass(st.to);

    // 主图 active class(仅在 style 不含 .active 隐含语义时手动加;
    // CINEMATIC 风格下 .active 也用于"图片切换滑入"选择器)
    if(st.to === 'cinematic' || st.from === 'cinematic'){
      pool.forEach((c, i) => c.el.classList.toggle('active', i === 0));
    } else {
      pool.forEach((c, i) => { if(c.el.classList.contains('active')) c.el.classList.remove('active'); });
    }

    // 同步照片
    syncCardPhotos();

    /* 2) 摄影机 = fromStyle.camera lerp 到 toStyle.camera */
    const cam = lerpCamera(fromStyle.camera, toStyle.camera, morphT);
    // 摄影机再叠加自身微浮动(per-style 强度)
    const camTime = now / 1000;
    const camAmp = lerp(fromStyle.motion.parallax, toStyle.motion.parallax, morphT);
    const camTargetX     = cam.x + (Math.sin(camTime * 0.07) + Math.sin(camTime*0.041+1.3)*0.6) * 6 * camAmp;
    const camTargetY     = cam.y + (Math.cos(camTime * 0.053 + 0.7) + Math.sin(camTime*0.029+2.1)*0.5) * 4 * camAmp;
    const camTargetRX    = cam.rotX + Math.sin(camTime * 0.045 + 0.4) * 0.4 * camAmp;
    const camTargetRY    = cam.rotY + Math.sin(camTime * 0.061 + 1.7) * 0.5 * camAmp;
    const camTargetScale = cam.scale * (1 + Math.sin(camTime*0.038+2.3) * 0.008 * camAmp);

    camX     = lerp(camX, camTargetX, damp(1.2, dt));
    camY     = lerp(camY, camTargetY, damp(1.2, dt));
    camRX    = lerp(camRX, camTargetRX, damp(1.0, dt));
    camRY    = lerp(camRY, camTargetRY, damp(1.0, dt));
    camScale = lerp(camScale, camTargetScale, damp(0.8, dt));

    if(cameraRig){
      cameraRig.style.transform =
        `translate3d(${camX.toFixed(2)}px, ${camY.toFixed(2)}px, 0)` +
        ` rotateX(${camRX.toFixed(3)}deg) rotateY(${camRY.toFixed(3)}deg)` +
        ` scale(${camScale.toFixed(4)})`;
    }

    /* 3) 浮动 motion 参数 */
    const motion = lerpMotion(fromStyle.motion, toStyle.motion, morphT);
    const glow   = lerp(fromStyle.glow, toStyle.glow, morphT);

    /* 4) 每张卡片 */
    pool.forEach((c, i) => {
      const slotA = fromStyle.slots[i];
      const slotB = toStyle.slots[i];
      const slot  = lerpSlot(slotA, slotB, morphT);
      const cur   = c.st;

      // slot (x,y) 是 %,转像素(基于当前 carousel 实际尺寸)
      const px = pctToPx(slot);

      // 浮动 offset
      const bob  = cur.bob.amp  * motion.floatingAmp * Math.sin(camTime * cur.bob.freq * Math.PI*2 + cur.bob.phase);
      const drf  = cur.drift.amp * motion.drift     * Math.cos(camTime * cur.drift.freq * Math.PI*2 + cur.drift.phase);
      const spn  = cur.spin.amp  * motion.rotationAmp * Math.sin(camTime * cur.spin.freq * Math.PI*2 + cur.spin.phase);

      const tx = px.x + drf;
      const ty = px.y + bob;
      const tz = slot.z;
      const tScale = slot.scale;
      const tRotX  = slot.rotX;
      const tRotY  = slot.rotY;
      const tRotZ  = slot.rotZ + spn;
      const tBlur  = slot.blur;
      const tOp    = slot.opacity;
      const tBr    = slot.brightness;
      const tSat   = slot.saturate;
      const tW     = slot.w;
      const tH     = slot.h;

      // 每帧直接 lerp(由 motion / 切换速度决定速度)
      const lambda = 6.0;
      cur.x = lerp(cur.x, tx, damp(lambda, dt));
      cur.y = lerp(cur.y, ty, damp(lambda, dt));
      cur.z = lerp(cur.z, tz, damp(lambda*1.2, dt));
      cur.w = lerp(cur.w, tW, damp(lambda*0.7, dt));
      cur.h = lerp(cur.h, tH, damp(lambda*0.7, dt));
      cur.scale = lerp(cur.scale, tScale, damp(lambda, dt));
      cur.rotX  = lerp(cur.rotX,  tRotX,  damp(lambda*0.8, dt));
      cur.rotY  = lerp(cur.rotY,  tRotY,  damp(lambda*0.8, dt));
      cur.rotZ  = lerp(cur.rotZ,  tRotZ,  damp(lambda*0.8, dt));
      cur.blur  = lerp(cur.blur,  tBlur,  damp(lambda*1.4, dt));
      cur.opacity = lerp(cur.opacity, tOp, damp(lambda*1.2, dt));
      cur.brightness = lerp(cur.brightness, tBr, damp(lambda, dt));
      cur.saturate   = lerp(cur.saturate,   tSat, damp(lambda, dt));

      // 写入 DOM
      c.el.style.width  = cur.w.toFixed(1) + 'px';
      c.el.style.height = cur.h.toFixed(1) + 'px';
      c.el.style.transform =
        `translate3d(-50%, -50%, 0)` +
        ` translate3d(${cur.x.toFixed(2)}px, ${cur.y.toFixed(2)}px, ${cur.z.toFixed(2)}px)` +
        ` rotateX(${cur.rotX.toFixed(3)}deg) rotateY(${cur.rotY.toFixed(3)}deg) rotateZ(${cur.rotZ.toFixed(3)}deg)` +
        ` scale(${cur.scale.toFixed(4)})`;
      // 关键:卡片本体保持纯几何层(不写 filter),所有视觉滤镜都交给 img,
      // 避免对卡片整体 filter 暴露矩形蒙层。
      c.el.style.opacity = cur.opacity.toFixed(3);
      c.el.style.zIndex = Math.round(1000 + cur.z);
      // 把 blur / brightness / saturate 都通过 CSS 变量传给 img,
      // 由各 style-X 的 .memory-card.style-X img 规则把 var(--img-blur) 拼到自己的 filter 里。
      const imgBlur = Math.min(cur.blur, 1.5);
      c.img.style.setProperty('--img-blur', `${imgBlur.toFixed(2)}px`);
      c.img.style.setProperty('--img-bright', cur.brightness.toFixed(3));
      c.img.style.setProperty('--img-saturate', cur.saturate.toFixed(3));
    });
    rafId = requestAnimationFrame(tick);
  }

  function startRAF(){
    if(rafId) return;
    if(reduceMotion){
      // 静态渲染当前 Style 的目标 slot
      const st = getCurrentStyleState(0);
      const sty = STYLES[st.to];
      pool.forEach((c, i) => {
        const slot = sty.slots[i];
        const px = pctToPx(slot);
        c.el.style.width  = slot.w + 'px';
        c.el.style.height = slot.h + 'px';
        c.el.style.transform =
          `translate3d(-50%, -50%, 0) translate3d(${px.x}px, ${px.y}px, ${slot.z}px)` +
          ` rotateX(${slot.rotX}deg) rotateY(${slot.rotY}deg) rotateZ(${slot.rotZ}deg) scale(${slot.scale})`;
        c.el.style.opacity = slot.opacity;
        c.el.style.zIndex = Math.round(1000 + slot.z);
        // 滤镜全部交给 img,通过 CSS 变量
        const imgBlur = Math.min(slot.blur, 1.5);
        c.img.style.setProperty('--img-blur', `${imgBlur}px`);
        c.img.style.setProperty('--img-bright', slot.brightness);
        c.img.style.setProperty('--img-saturate', slot.saturate);
      });
      applyStyleClass(st.to);
      syncCardPhotos();
      return;
    }
    applyStyleClass('cinematic');
    syncCardPhotos();
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
  }
  function stopRAF(){ if(rafId){ cancelAnimationFrame(rafId); rafId = 0; } }

  /* ===================== 唱片封面 2s 随机切换 ===================== */
  imgFallback(diskCoverImg);
  let currentVinylIdx = -1;
  let vinylSwapTimer = null;
  function forbidSet(){
    const set = new Set();
    const active = getCurrentMemoryIndex();
    if(active >= 0){
      set.add(active); set.add(active-1); set.add(active+1);
    }
    if(currentVinylIdx >= 0) set.add(currentVinylIdx);
    return set;
  }
  function swapVinyl(){
    if(NUM_PHOTOS < 4) return;
    const forbid = forbidSet();
    let idx;
    let attempts = 0;
    do {
      idx = Math.floor(Math.random() * NUM_PHOTOS);
      attempts++;
    } while(forbid.has(idx) && attempts < 50);
    if(forbid.has(idx)) return;
    currentVinylIdx = idx;
    diskCoverImg.style.opacity = '0';
    diskCoverImg.style.transform = 'scale(0.92)';
    setTimeout(() => {
      diskCoverImg.src = imageUrls[idx];
      diskCoverImg.style.opacity = '1';
      diskCoverImg.style.transform = 'scale(1)';
    }, 350);
  }
  function startVinylSwap(){
    if(currentVinylIdx < 0){
      const forbid = forbidSet();
      let idx = Math.floor(Math.random() * NUM_PHOTOS);
      while(forbid.has(idx)) idx = Math.floor(Math.random() * NUM_PHOTOS);
      currentVinylIdx = idx;
      diskCoverImg.src = imageUrls[idx];
    }
    if(vinylSwapTimer) clearInterval(vinylSwapTimer);
    vinylSwapTimer = setInterval(swapVinyl, 2000);
  }
  startVinylSwap();

  /* ===================== 左右翻页 ===================== */
  function getSingleCardDuration(){ return getTotalDuration() / NUM_PHOTOS; }
  function goToMemory(index){
    index = clamp(index, 0, NUM_PHOTOS - 1);
    if(window.musicBox) window.musicBox.seek(index * getSingleCardDuration() + 0.01);
    syncCardPhotos();
  }
  memoryLeftZone.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.musicBox) window.musicBox.seek(Math.max(0, window.musicBox.currentTime - 10));
    syncCardPhotos();
  });
  memoryRightZone.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.musicBox) window.musicBox.seek(Math.min(window.musicBox.totalDuration, window.musicBox.currentTime + 10));
    syncCardPhotos();
  });

  /* ===================== 歌词 ===================== */
  const lyricsText = document.getElementById('lyricsText');
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
      lyricsText.classList.add('fading');
      setTimeout(() => {
        lyricsText.textContent = lyricsData[idx].text;
        lyricsText.classList.remove('fading');
      }, 380);
    }
  }

  /* ===================== 进度条 ===================== */
  const progressTrack = document.getElementById('progressTrack');
  const progressFill  = document.getElementById('progressFill');
  const progressThumb = document.getElementById('progressThumb');
  const currentTimeEl = document.getElementById('currentTime');
  const totalTimeEl   = document.getElementById('totalTime');

  function formatTime(s){
    if(!isFinite(s) || isNaN(s)) s = 0;
    const m = Math.floor(s/60);
    const sec = Math.floor(s%60);
    return `${m}:${sec.toString().padStart(2,'0')}`;
  }
  function updateProgressBar(time){
    const total = getTotalDuration();
    const pct = (time / total) * 100;
    progressFill.style.width = pct + '%';
    progressThumb.style.left = pct + '%';
    currentTimeEl.textContent = formatTime(time);
    totalTimeEl.textContent   = formatTime(total);
  }

  let isDragging = false;
  function seekToX(clientX){
    const rect = progressTrack.getBoundingClientRect();
    const x = clientX - rect.left;
    const ratio = clamp(x / rect.width, 0, 1);
    const total = getTotalDuration();
    const time = ratio * total;
    if(window.musicBox) window.musicBox.seek(time);
    syncCardPhotos();
    updateLyrics(time);
    updateProgressBar(time);
  }
  progressTrack.addEventListener('mousedown', (e) => { isDragging = true; seekToX(e.clientX); });
  document.addEventListener('mousemove', (e) => { if(isDragging) seekToX(e.clientX); });
  document.addEventListener('mouseup',    () => { isDragging = false; });
  progressTrack.addEventListener('touchstart', (e) => { isDragging = true; seekToX(e.touches[0].clientX); });
  document.addEventListener('touchmove',  (e) => { if(isDragging) seekToX(e.touches[0].clientX); });
  document.addEventListener('touchend',   () => { isDragging = false; });

  skipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if(window.Router) window.Router.go('interactive');
  });

  /* ===================== 时间驱动回调 ===================== */
  window._memoriesTick = function(time){
    updateLyrics(time);
    updateProgressBar(time);
  };

  /* 初始化显示 */
  if(totalTimeEl) totalTimeEl.textContent = formatTime(getTotalDuration());

  /* 启动 */
  startRAF();
  window._memoriesStart = startRAF;
  window._memoriesStop  = stopRAF;
})();
