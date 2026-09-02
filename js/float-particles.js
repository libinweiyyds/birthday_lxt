/* ==================== 漂浮粒子 ==================== */
/* 在父窗口 index.html body 创建,跨场景持续漂浮 */
function createFloatParticles(){
  for(let i=0;i<15;i++){
    const p = document.createElement('div');
    p.className = 'float-particle';
    const size = Math.random()*4+2;
    p.style.width = size+'px';
    p.style.height = size+'px';
    p.style.left = Math.random()*100+'%';
    p.style.bottom = '-10px';
    p.style.animationDuration = (Math.random()*15+10)+'s';
    p.style.animationDelay = (Math.random()*10)+'s';
    p.style.setProperty('--drift', (Math.random()*100-50)+'px');
    p.style.background = ['rgba(255,182,193,0.4)','rgba(200,162,200,0.4)','rgba(255,215,0,0.3)'][Math.floor(Math.random()*3)];
    document.body.appendChild(p);
  }
}
createFloatParticles();
