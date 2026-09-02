/* ==================== 场景3：互动（蛋糕 / 蜡烛 / 气球 / 彩带） ==================== */
function addDots(containerId, count){
  const el = document.getElementById(containerId);
  if(!el) return;
  for(let i=0;i<count;i++){
    const dot = document.createElement('div');
    dot.className = 'cake-dot';
    dot.style.left = (5 + Math.random()*90) + '%';
    dot.style.top = (10 + Math.random()*80) + '%';
    el.appendChild(dot);
  }
}
addDots('dotsBottom', 8);
addDots('dotsMiddle', 6);
addDots('dotsTop', 5);

/* 蜡烛 */
const candleRow = document.getElementById('candleRow');
const CANDLE_COUNT = 5;
for(let i=0;i<CANDLE_COUNT;i++){
  const candle = document.createElement('div');
  candle.className = 'candle';
  candle.innerHTML = '<div class="flame"></div><div class="smoke"></div>';
  candleRow.appendChild(candle);
}

/* 蛋糕互动 */
let cakeClicked = false;
const cakeArea = document.getElementById('cakeArea');
const interactiveHint = document.getElementById('interactiveHint');
const wishText = document.getElementById('wishText');

cakeArea.addEventListener('click', () => {
  if(cakeClicked) return;
  cakeClicked = true;

  // 吹灭蜡烛
  const flames = document.querySelectorAll('.flame');
  const smokes = document.querySelectorAll('.smoke');
  flames.forEach((f, i) => {
    setTimeout(() => {
      f.classList.add('out');
      if(smokes[i]) smokes[i].classList.add('active');
    }, i * 150);
  });

  // 许愿文字
  setTimeout(() => {
    wishText.classList.add('show');
    interactiveHint.textContent = '愿望已许下 一定会实现';
  }, 800);

  // 释放气球
  setTimeout(releaseBalloons, 1000);

  // 撒彩带
  setTimeout(burstConfetti, 1200);

  // 过渡到结尾
  setTimeout(() => {
    if(window.Router) window.Router.go('finale');
  }, 5000);
});

/* 气球释放 */
function releaseBalloons(){
  const layer = document.getElementById('balloonLayer');
  if(!layer) return;
  const colors = [
    'radial-gradient(ellipse at 30% 30%, #fff0f5, #ffb6c1)',
    'radial-gradient(ellipse at 30% 30%, #f3edff, #c8a2c8)',
    'radial-gradient(ellipse at 30% 30%, #fff5e0, #ffd700)',
    'radial-gradient(ellipse at 30% 30%, #e8f0ff, #87ceeb)',
    'radial-gradient(ellipse at 30% 30%, #fff0f5, #ff9bb3)',
  ];
  for(let i=0;i<25;i++){
    const b = document.createElement('div');
    b.className = 'balloon';
    b.style.background = colors[i % colors.length];
    b.style.left = Math.random() * 100 + '%';
    b.style.width = (30 + Math.random()*25) + 'px';
    b.style.height = (40 + Math.random()*30) + 'px';
    b.style.setProperty('--dur', (3.5 + Math.random()*3.5) + 's');
    b.style.setProperty('--drift', ((Math.random()-0.5)*200) + 'px');
    b.style.animationDelay = (Math.random()*1.5) + 's';
    layer.appendChild(b);
    setTimeout(() => b.classList.add('fly'), 50);
    setTimeout(() => b.remove(), 9000);
  }
}

/* 彩带 */
function burstConfetti(){
  const layer = document.getElementById('confettiLayer');
  if(!layer) return;
  const colors = ['#FFB6C1','#E6B0FF','#FFD700','#87CEEB','#FF69B4','#DDA0DD','#FFA07A','#98FB98'];
  for(let i=0;i<80;i++){
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.backgroundColor = colors[i % colors.length];
    p.style.left = Math.random() * 100 + '%';
    p.style.width = (6 + Math.random()*8) + 'px';
    p.style.height = (10 + Math.random()*12) + 'px';
    p.style.setProperty('--dur', (2.5 + Math.random()*2.5) + 's');
    p.style.animationDelay = (Math.random()*0.8) + 's';
    if(Math.random() > 0.5) p.style.borderRadius = '50%';
    layer.appendChild(p);
    setTimeout(() => p.classList.add('fall'), 50);
    setTimeout(() => p.remove(), 6000);
  }
}
