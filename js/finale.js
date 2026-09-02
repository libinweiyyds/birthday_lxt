/* ==================== 场景4：心形汇聚 ==================== */
/* 依赖:images.js(NUM_PHOTOS, imageUrls) 已在同页面引入 */
/* 单页:暴露 window.animateHeart,由 router 在进入 finale 时调用 */
const heartStage = document.getElementById('heartStage');

function getHeartPoint(t, scale){
  const x = 16 * Math.pow(Math.sin(t), 3);
  const y = -(13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t));
  return { x: x * scale, y: (y - 6) * scale };
}

function buildHeartPhotos(){
  for(let i=0;i<NUM_PHOTOS;i++){
    const photo = document.createElement('div');
    photo.className = 'heart-photo';
    photo.id = 'heartPhoto' + i;

    // 随机起始位置
    const startX = (Math.random()-0.5) * 600;
    const startY = (Math.random()-0.5) * 500;
    photo.style.transform = `translate(calc(-50% + ${startX}px), calc(-50% + ${startY}px)) scale(0.3) rotate(${(Math.random()-0.5)*60}deg)`;
    photo.style.opacity = '0';

    const img = document.createElement('img');
    img.src = imageUrls[i];
    img.alt = `回忆 ${i+1}`;
    img.addEventListener('error', function onErr(){
      if(this.dataset.fallbackApplied === '1') return;
      this.dataset.fallbackApplied = '1';
      this.removeEventListener('error', onErr);
      this.src = 'img/1.jpg';
    }, { once: false });
    photo.appendChild(img);

    heartStage.appendChild(photo);
  }
}
buildHeartPhotos();

let heartStarted = false;
function animateHeart(){
  if(heartStarted) return;
  heartStarted = true;
  const photos = document.querySelectorAll('.heart-photo');
  const scale = 14;

  photos.forEach((photo, i) => {
    setTimeout(() => {
      const t = (i / NUM_PHOTOS) * Math.PI * 2;
      const pt = getHeartPoint(t, scale);
      const rotation = (Math.random()-0.5) * 18;
      photo.style.opacity = '1';
      photo.style.transform = `translate(calc(-50% + ${pt.x}px), calc(-50% + ${pt.y}px)) scale(0.7) rotate(${rotation}deg)`;
    }, i * 100);
  });

  // 显示最终文字
  setTimeout(() => {
    const msg = document.getElementById('finaleMessage');
    if(msg) msg.classList.add('show');
  }, NUM_PHOTOS * 100 + 1500);

  // 心形微微跳动
  setTimeout(() => {
    const photos2 = document.querySelectorAll('.heart-photo');
    photos2.forEach((photo) => {
      photo.style.transition = 'transform 2s ease-in-out, opacity 0.5s';
    });
    heartBeat(photos2, scale);
  }, NUM_PHOTOS * 100 + 3000);
}

function heartBeat(photos, scale){
  let beat = false;
  setInterval(() => {
    beat = !beat;
    photos.forEach((photo, i) => {
      const t = (i / NUM_PHOTOS) * Math.PI * 2;
      const pt = getHeartPoint(t, scale * (beat ? 1.05 : 1));
      const rotation = (i / NUM_PHOTOS) * 60 - 30; // 整体倾斜
      photo.style.transform = `translate(calc(-50% + ${pt.x}px), calc(-50% + ${pt.y}px)) scale(${beat ? 0.74 : 0.7}) rotate(${rotation}deg)`;
    });
  }, 1500);
}

// 暴露给 router 调用
window.animateHeart = animateHeart;
