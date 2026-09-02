/* ==================== 单页 hash 路由器 ==================== */
/* file:// 双击可用：用 location.hash 切换 .scene.active，无 iframe 跨窗口、无服务器。
   场景切换 + 转场闪光 + 场景 enter 钩子（启动 memories 时间驱动 / finale 心形动画） */
(function(){
  const SCENES = ['intro','memories','interactive','finale'];
  let currentScene = null;

  const transFlash = document.getElementById('transFlash');

  function flash(){
    if(!transFlash) return;
    transFlash.classList.remove('flash');
    void transFlash.offsetWidth;
    transFlash.classList.add('flash');
  }

  function setActive(sceneId){
    document.querySelectorAll('.scene').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(sceneId);
    if(el) el.classList.add('active');
  }

  function onEnter(sceneId){
    if(sceneId === 'memories' && window.musicBox){
      // 进入回忆:音乐结束自动切到互动
      window.musicBox.onEnd = () => go('interactive');
      // 挂载时间驱动回调(轮播/歌词/进度)
      if(typeof window._memoriesTick === 'function'){
        window.musicBox.onTimeUpdate = window._memoriesTick;
      }
      // 启动 3D 卡片空间 RAF
      if(typeof window._memoriesStart === 'function') window._memoriesStart();
    }
    if(sceneId === 'interactive' && window.musicBox){
      // 进入互动:淡出"特别的人"→淡入"生日快乐"歌(无需歌词)
      // 卸载回忆阶段的时间回调(切歌期间不再更新回忆 UI)
      window.musicBox.onTimeUpdate = null;
      window.musicBox.setSource({
        src: 'music/生日快乐/生日快乐.MP3',
        startFrom: 0,
        fadeMs: 1500,
        resume: true
      });
      // 生日快乐歌循环播放(无歌词,场景停留期间背景循环)
      window.musicBox.onEnd = null;
      // 停止 S1 的 RAF(避免在不可见场景空转)
      if(typeof window._memoriesStop === 'function') window._memoriesStop();
    }
    if(sceneId === 'finale' && typeof window.animateHeart === 'function'){
      setTimeout(window.animateHeart, 800);
      // 停止 S1 的 RAF
      if(typeof window._memoriesStop === 'function') window._memoriesStop();
    }
  }

  function onLeave(sceneId){
    if(sceneId === 'memories' && window.musicBox){
      // 离开回忆：卸载时间回调，避免更新已隐藏的 DOM
      window.musicBox.onTimeUpdate = null;
      // 停止 RAF
      if(typeof window._memoriesStop === 'function') window._memoriesStop();
    }
  }

  function go(sceneId){
    if(!SCENES.includes(sceneId) || sceneId === currentScene) return;
    flash();
    if(currentScene) onLeave(currentScene);
    setActive(sceneId);
    currentScene = sceneId;
    onEnter(sceneId);
    if(location.hash !== '#' + sceneId) location.hash = sceneId;
  }

  // hash 变化 → 切换
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#','');
    if(SCENES.includes(h) && h !== currentScene) go(h);
  });

  // 初始场景
  const initial = (location.hash.replace('#','')) || 'intro';
  currentScene = null;
  go(SCENES.includes(initial) ? initial : 'intro');

  window.Router = { go, flash, get current(){ return currentScene; } };
})();
