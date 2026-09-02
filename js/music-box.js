/* ==================== 音乐控制器（包装 <audio> 元素） ==================== */
/* 单页应用：所有场景共享同一个 <audio>，跨场景音乐不中断。
   file:// 协议下 <audio> 用相对路径加载本地音频文件，无需服务器。
   接口与原合成器版本兼容：play/seek/currentTime/totalDuration/isPlaying/onTimeUpdate/onEnd */
class MusicBox {
  constructor(audioEl){
    this.audio = audioEl;
    this.isPlaying = false;
    this.onTimeUpdate = null;
    this.onEnd = null;
    this._endedHandled = false;
    this.totalDuration = 259; // 默认占位，loadedmetadata 后更新为真实时长

    // 元数据加载完成 → 更新总时长
    this.audio.addEventListener('loadedmetadata', () => {
      const d = this.audio.duration;
      if(isFinite(d) && d > 0){
        this.totalDuration = d;
        if(this.onTimeUpdate) this.onTimeUpdate(this.currentTime);
      }
    });

    // 播放结束 → 触发一次 onEnd，随后手动循环（不设 loop 以便 ended 能触发）
    this.audio.addEventListener('ended', () => {
      if(!this._endedHandled && this.onEnd){
        this._endedHandled = true;
        this.onEnd();
      }
      // 手动回到开头继续播放（背景循环）
      try{
        this.audio.currentTime = 0;
        const p = this.audio.play();
        if(p && p.catch) p.catch(()=>{});
      }catch(e){}
    });

    this._tickLoop = this._tickLoop.bind(this);
  }

  get currentTime(){
    return this.audio.currentTime || 0;
  }

  play(){
    // 在用户手势（intro 点击）内调用，AudioContext/autoplay 策略允许
    const p = this.audio.play();
    if(p && p.catch) p.catch((e)=>{ /* 自动播放被阻止时静默 */ });
    this.isPlaying = true;
    this._tickLoop();
  }

  seek(t){
    const target = Math.max(0, Math.min(t, this.totalDuration));
    try{ this.audio.currentTime = target; }catch(e){}
    if(this.onTimeUpdate) this.onTimeUpdate(this.currentTime);
  }

  /* 切换音频源(淡出当前 → 换 src → 淡入新音频)
     options: { src, startFrom=0, fadeMs=1500, resume=true } */
  setSource({ src, startFrom = 0, fadeMs = 1500, resume = true }){
    if(this._fading || !src) return;
    const currentSrc = this.audio.getAttribute('src') || '';
    if(currentSrc === src) return; // 已是目标源,无需切换
    this._fading = true;
    const wasPlaying = this.isPlaying;
    this._fadeTo(0, fadeMs, () => {
      // 已淡出:暂停、换源、重置时长占位
      try{ this.audio.pause(); }catch(e){}
      this._endedHandled = true; // 旧曲的 ended 已无意义
      this.audio.src = src;
      this.totalDuration = 259; // loadedmetadata 后会更新
      const onReady = () => {
        this.audio.removeEventListener('loadedmetadata', onReady);
        const d = this.audio.duration;
        if(isFinite(d) && d > 0) this.totalDuration = d;
        if(startFrom > 0){
          try{ this.audio.currentTime = Math.min(startFrom, this.totalDuration); }catch(e){}
        }
        this._fading = false;
        if(resume && wasPlaying){
          const p = this.audio.play();
          if(p && p.catch) p.catch(()=>{});
          this._fadeTo(1, fadeMs);
        }
      };
      this.audio.addEventListener('loadedmetadata', onReady);
      try{ this.audio.load(); }catch(e){}
      // 兜底:部分浏览器 metadata 已就绪或 load 同步触发
      // onReady 内部会 removeEventListener,故不会重复执行
      if(this.audio.readyState >= 1) onReady();
    });
  }

  /* 内部:音量淡变到目标值 */
  _fadeTo(targetVol, durationMs, done){
    const startVol = this.audio.volume;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      this.audio.volume = startVol + (targetVol - startVol) * t;
      if(t < 1) requestAnimationFrame(step);
      else {
        this.audio.volume = targetVol;
        if(done) done();
      }
    };
    requestAnimationFrame(step);
  }

  _tickLoop(){
    if(!this.isPlaying) return;
    if(this.onTimeUpdate) this.onTimeUpdate(this.currentTime);
    requestAnimationFrame(this._tickLoop);
  }
}

window.MusicBox = MusicBox;
