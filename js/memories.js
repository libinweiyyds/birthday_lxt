/* ==================== 场景2：回忆（黑胶 + 单卡轮播 + 歌词 + 进度条） ==================== */
/* 依赖:images.js(NUM_PHOTOS, imageUrls, memoryCaptions) 与 歌词 .js(window.LYRICS_DATA)
   单页:音乐时间由 window.musicBox(包装 <audio>)提供,router 进入本场景时挂载 _memoriesTick */
const memoryCarousel = document.getElementById('memoryCarousel');
const memoryLeftZone = document.getElementById('memoryLeftZone');
const memoryRightZone = document.getElementById('memoryRightZone');
const diskCoverImg = document.getElementById('diskCoverImg');
const skipBtn = document.getElementById('skipBtn');

/* ---- 图片加载失败 fallback:统一用 img/1.jpg ---- */
function applyImgFallback(imgEl){
  imgEl.addEventListener('error', function onErr(){
    if(this.dataset.fallbackApplied === '1') return;
    this.dataset.fallbackApplied = '1';
    this.removeEventListener('error', onErr);
    this.src = 'img/1.jpg';
  }, { once: false });
}

/* ---- 卡片构建 ---- */
function buildMemoryCards(){
  for(let i=0;i<NUM_PHOTOS;i++){
    const card = document.createElement('div');
    card.className = 'memory-card';
    card.dataset.index = i;
    const img = document.createElement('img');
    img.src = imageUrls[i];
    img.alt = `回忆 ${i+1}`;
    img.loading = 'lazy';
    applyImgFallback(img);
    const caption = document.createElement('div');
    caption.className = 'caption';
    caption.textContent = memoryCaptions[i] || ('回忆 · ' + (i+1));
    card.appendChild(img);
    card.appendChild(caption);
    memoryCarousel.appendChild(card);
  }
}
buildMemoryCards();
const memoryCards = document.querySelectorAll('.memory-card');
let currentCardIdx = -1;

/* 唱片中心图片也加 fallback */
applyImgFallback(diskCoverImg);

function getSingleCardDuration(){
  return (window.musicBox ? window.musicBox.totalDuration : 259) / NUM_PHOTOS;
}
function getCurrentMemoryIndex(){
  const t = window.musicBox ? window.musicBox.currentTime : 0;
  const singleDur = getSingleCardDuration();
  return Math.min(Math.floor(t / singleDur), NUM_PHOTOS - 1);
}

/* 5层级：active/prev1/prev2/next1/next2 */
function updateMemoryCarousel(time){
  const idx = getCurrentMemoryIndex();
  if(idx === currentCardIdx) return;
  currentCardIdx = idx;

  memoryCards.forEach((card, i) => {
    card.classList.remove('active','prev1','prev2','next1','next2');
    const diff = i - idx;
    if(diff === 0) card.classList.add('active');
    else if(diff === -1) card.classList.add('prev1');
    else if(diff === -2) card.classList.add('prev2');
    else if(diff === 1) card.classList.add('next1');
    else if(diff === 2) card.classList.add('next2');
  });
}

function goToMemory(index){
  index = Math.max(0, Math.min(NUM_PHOTOS - 1, index));
  const singleDur = getSingleCardDuration();
  if(window.musicBox) window.musicBox.seek(index * singleDur + 0.01);
  updateMemoryCarousel(window.musicBox ? window.musicBox.currentTime : 0);
}

/* 左右翻页 = 前进/后退 10 秒（同步音乐与图片） */
memoryLeftZone.addEventListener('click', (e) => {
  e.stopPropagation();
  if(window.musicBox) window.musicBox.seek(Math.max(0, window.musicBox.currentTime - 10));
  updateMemoryCarousel(window.musicBox ? window.musicBox.currentTime : 0);
});
memoryRightZone.addEventListener('click', (e) => {
  e.stopPropagation();
  if(window.musicBox) window.musicBox.seek(Math.min(window.musicBox.totalDuration, window.musicBox.currentTime + 10));
  updateMemoryCarousel(window.musicBox ? window.musicBox.currentTime : 0);
});

/* ---- 唱片中心：每2秒随机切换图片（不与 active/prev1/next1/当前相同） ---- */
let currentVinylIdx = -1;
let vinylSwapTimer = null;

function getForbidIndices(){
  const forbid = new Set();
  if(currentCardIdx >= 0){
    forbid.add(currentCardIdx);
    forbid.add(currentCardIdx - 1);
    forbid.add(currentCardIdx + 1);
  }
  if(currentVinylIdx >= 0) forbid.add(currentVinylIdx);
  return forbid;
}

function swapVinylImage(){
  if(NUM_PHOTOS < 4) return;
  const forbid = getForbidIndices();
  let randomIdx;
  let attempts = 0;
  do {
    randomIdx = Math.floor(Math.random() * NUM_PHOTOS);
    attempts++;
  } while(forbid.has(randomIdx) && attempts < 50);
  if(forbid.has(randomIdx)) return;
  currentVinylIdx = randomIdx;
  diskCoverImg.style.opacity = '0';
  diskCoverImg.style.transform = 'scale(0.92)';
  setTimeout(() => {
    diskCoverImg.src = imageUrls[randomIdx];
    diskCoverImg.style.opacity = '1';
    diskCoverImg.style.transform = 'scale(1)';
  }, 350);
}

function startVinylSwap(){
  if(currentVinylIdx < 0){
    const forbid = getForbidIndices();
    let idx = Math.floor(Math.random() * NUM_PHOTOS);
    while(forbid.has(idx)) idx = Math.floor(Math.random() * NUM_PHOTOS);
    currentVinylIdx = idx;
    diskCoverImg.src = imageUrls[idx];
  }
  if(vinylSwapTimer) clearInterval(vinylSwapTimer);
  vinylSwapTimer = setInterval(swapVinylImage, 2000);
}
startVinylSwap();

/* ---- 歌词同步（来自 music/.../lyrics.js 的 window.LYRICS_DATA） ---- */
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
    }, 400);
  }
}

/* ---- 进度条 ---- */
const progressTrack = document.getElementById('progressTrack');
const progressFill = document.getElementById('progressFill');
const progressThumb = document.getElementById('progressThumb');
const currentTimeEl = document.getElementById('currentTime');
const totalTimeEl = document.getElementById('totalTime');

function formatTime(s){
  if(!isFinite(s) || isNaN(s)) s = 0;
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}

function updateProgressBar(time){
  const total = window.musicBox ? window.musicBox.totalDuration : 259;
  const pct = (time / total) * 100;
  progressFill.style.width = pct + '%';
  progressThumb.style.left = pct + '%';
  currentTimeEl.textContent = formatTime(time);
  totalTimeEl.textContent = formatTime(total);
}

let isDragging = false;

function seekToX(clientX){
  const rect = progressTrack.getBoundingClientRect();
  const x = clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, x / rect.width));
  const total = window.musicBox ? window.musicBox.totalDuration : 259;
  const time = ratio * total;
  if(window.musicBox) window.musicBox.seek(time);
  updateMemoryCarousel(time);
  updateLyrics(time);
  updateProgressBar(time);
}

progressTrack.addEventListener('mousedown', (e) => {
  isDragging = true;
  seekToX(e.clientX);
});
document.addEventListener('mousemove', (e) => {
  if(isDragging) seekToX(e.clientX);
});
document.addEventListener('mouseup', () => { isDragging = false; });

// 触摸支持
progressTrack.addEventListener('touchstart', (e) => {
  isDragging = true;
  seekToX(e.touches[0].clientX);
});
document.addEventListener('touchmove', (e) => {
  if(isDragging) seekToX(e.touches[0].clientX);
});
document.addEventListener('touchend', () => { isDragging = false; });

/* ---- 跳过按钮 ---- */
skipBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if(window.Router) window.Router.go('interactive');
});

/* ---- 时间驱动回调（由 router 在进入本场景时挂到 musicBox.onTimeUpdate） ---- */
window._memoriesTick = function(time){
  updateMemoryCarousel(time);
  updateLyrics(time);
  updateProgressBar(time);
};

/* ---- 初始化显示 ---- */
if(totalTimeEl) totalTimeEl.textContent = formatTime(window.musicBox ? window.musicBox.totalDuration : 259);
