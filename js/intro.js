/* ==================== 场景1：开场 ==================== */
/* 单页：直接用 window.musicBox / window.Router，无跨窗口 */
document.getElementById('intro').addEventListener('click', () => {
  if(window.musicBox) window.musicBox.play();
  if(window.Router) window.Router.go('memories');
});
