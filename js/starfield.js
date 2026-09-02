/* ==================== 星空粒子 ==================== */
/* 在父窗口 index.html 运行,canvas#starfield 跨场景持续显示 */
const canvas = document.getElementById('starfield');
const ctx = canvas.getContext('2d');
let stars = [];
let shootingStars = [];

function resizeCanvas(){
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function initStars(){
  stars = [];
  const count = Math.floor((canvas.width * canvas.height) / 6000);
  for(let i=0;i<count;i++){
    stars.push({
      x: Math.random()*canvas.width,
      y: Math.random()*canvas.height,
      r: Math.random()*1.5+0.3,
      a: Math.random()*0.5+0.2,
      phase: Math.random()*Math.PI*2,
      speed: Math.random()*0.02+0.005,
      hue: Math.random()<0.3 ? 'gold' : (Math.random()<0.5 ? 'pink' : 'white')
    });
  }
}
initStars();

function spawnShootingStar(){
  if(Math.random() < 0.003 && shootingStars.length < 3){
    shootingStars.push({
      x: Math.random()*canvas.width,
      y: Math.random()*canvas.height*0.4,
      len: Math.random()*80+40,
      speed: Math.random()*8+5,
      angle: Math.PI/4 + (Math.random()-0.5)*0.3,
      life: 1
    });
  }
}

function drawStarfield(){
  ctx.clearRect(0,0,canvas.width,canvas.height);

  for(const s of stars){
    s.phase += s.speed;
    const alpha = s.a * (0.5 + 0.5*Math.sin(s.phase));
    let color;
    if(s.hue === 'gold') color = `rgba(255,215,0,${alpha})`;
    else if(s.hue === 'pink') color = `rgba(255,182,193,${alpha})`;
    else color = `rgba(255,248,251,${alpha})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
    if(s.r > 1){
      ctx.shadowBlur = 6;
      ctx.shadowColor = color;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  spawnShootingStar();
  for(let i = shootingStars.length-1; i>=0; i--){
    const ss = shootingStars[i];
    const dx = Math.cos(ss.angle)*ss.speed;
    const dy = Math.sin(ss.angle)*ss.speed;
    ss.x += dx; ss.y += dy; ss.life -= 0.02;
    const grad = ctx.createLinearGradient(ss.x, ss.y, ss.x - Math.cos(ss.angle)*ss.len, ss.y - Math.sin(ss.angle)*ss.len);
    grad.addColorStop(0, `rgba(255,240,245,${ss.life})`);
    grad.addColorStop(1, 'rgba(255,240,245,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ss.x, ss.y);
    ctx.lineTo(ss.x - Math.cos(ss.angle)*ss.len, ss.y - Math.sin(ss.angle)*ss.len);
    ctx.stroke();
    if(ss.life <= 0 || ss.x > canvas.width || ss.y > canvas.height) shootingStars.splice(i,1);
  }

  requestAnimationFrame(drawStarfield);
}
drawStarfield();
