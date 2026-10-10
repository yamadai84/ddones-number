(() => {
  'use strict';

  // ===== 設定 =====
  const MAX_NUMBER = 8;          // 1〜8
  const ROLL_INTERVAL_MS = 55;   // 高速表示の切り替え間隔
  const STORAGE_KEY = 'number-lottery-state-v1';
  // 音源ファイル（置くとそちらを優先。無ければ自動生成の音を使う）
  const SOUND_FILES = { roll: 'sounds/drumroll.mp3', pan: 'sounds/pan.mp3' };

  // ===== 要素 =====
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const numberEl = $('number');
  const messageEl = $('message');
  const historyEl = $('history');
  const btnUndo = $('btn-undo');
  const btnReset = $('btn-reset');
  const btnSound = $('btn-sound');
  const btnFullscreen = $('btn-fullscreen');
  const confirmEl = $('confirm');

  // ===== 状態 =====
  // phase: 'idle'（待機） | 'rolling'（高速表示中） | 'decided'（決定表示中） | 'finished'（全部出た）
  let history = [];   // 出た数字（出た順）
  let phase = 'idle';
  let rollTimer = null;
  let rollShown = null;
  let soundOn = true;

  const remaining = () => {
    const out = [];
    for (let n = 1; n <= MAX_NUMBER; n++) if (!history.includes(n)) out.push(n);
    return out;
  };

  const randomOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ===== 保存・復元（誤ってリロードしても続きから） =====
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ history, soundOn })); } catch (_) {}
  }
  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (data && Array.isArray(data.history)) {
        history = data.history.filter((n, i, a) => Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER && a.indexOf(n) === i);
      }
      if (data && typeof data.soundOn === 'boolean') soundOn = data.soundOn;
    } catch (_) {}
  }

  // ===== 描画 =====
  function buildHistorySlots() {
    historyEl.innerHTML = '';
    for (let i = 0; i < MAX_NUMBER; i++) historyEl.appendChild(document.createElement('li'));
  }

  function renderHistory(animateLatest = false) {
    const slots = historyEl.children;
    for (let i = 0; i < MAX_NUMBER; i++) {
      const li = slots[i];
      const n = history[i];
      li.textContent = n ?? '';
      li.classList.toggle('filled', n !== undefined);
      li.classList.toggle('current', i === history.length - 1);
      li.classList.remove('latest');
      if (animateLatest && i === history.length - 1) {
        void li.offsetWidth; // アニメーション再生のためのリフロー
        li.classList.add('latest');
      }
    }
  }

  function setNumber(text, cls) {
    numberEl.textContent = text;
    numberEl.className = cls || '';
  }

  function render() {
    const rest = remaining().length;
    if (phase === 'idle') {
      setNumber('?', 'idle');
      messageEl.textContent = 'タップでスタート';
    } else if (phase === 'decided') {
      setNumber(history[history.length - 1], 'decided-static');
      messageEl.textContent = `${history.length}つ目　タップで次へ（残り${rest}）`;
    } else if (phase === 'finished') {
      setNumber(history[history.length - 1], 'decided-static');
      messageEl.textContent = '全ての数字が出ました！';
    } else if (phase === 'rolling') {
      messageEl.textContent = 'タップでストップ！';
    }
    btnUndo.disabled = history.length === 0 && phase !== 'rolling';
    btnSound.textContent = soundOn ? '🔊' : '🔇';
    renderHistory();
  }

  function phaseFromHistory() {
    if (history.length === 0) return 'idle';
    if (history.length >= MAX_NUMBER) return 'finished';
    return 'decided';
  }

  // ===== 抽選の流れ =====
  function startRolling() {
    const pool = remaining();
    if (pool.length === 0) return;
    phase = 'rolling';
    numberEl.className = 'rolling';
    rollShown = null;
    const tick = () => {
      // 前回と同じ数字が続かないように（候補が2つ以上ある場合）
      let n = randomOf(pool);
      if (pool.length > 1) while (n === rollShown) n = randomOf(pool);
      rollShown = n;
      numberEl.textContent = n;
    };
    tick();
    rollTimer = setInterval(tick, ROLL_INTERVAL_MS);
    sound.startRoll();
    render();
  }

  function stopRolling() {
    clearInterval(rollTimer);
    rollTimer = null;
    sound.stopRoll();
  }

  function decide() {
    stopRolling();
    const picked = randomOf(remaining());
    history.push(picked);
    save();
    phase = history.length >= MAX_NUMBER ? 'finished' : 'decided';
    render();
    // 決定演出
    setNumber(picked, 'decided');
    renderHistory(true);
    document.body.classList.remove('flash');
    void document.body.offsetWidth;
    document.body.classList.add('flash');
    setTimeout(() => document.body.classList.remove('flash'), 600);
    sound.pan();
  }

  function onStageTap() {
    sound.unlock();
    if (!confirmEl.hidden) return;
    if (phase === 'rolling') decide();
    else if (phase === 'idle' || phase === 'decided') startRolling();
    // finished のときは何もしない（やり直しボタンで再スタート）
  }

  function undo() {
    if (phase === 'rolling') {
      // 高速表示中なら、表示前の状態に戻すだけ
      stopRolling();
    } else if (history.length > 0) {
      history.pop();
      save();
    }
    phase = phaseFromHistory();
    render();
  }

  function reset() {
    stopRolling();
    history = [];
    save();
    phase = 'idle';
    render();
  }

  // ===== サウンド =====
  const sound = (() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let noiseBuf = null;
    const files = { roll: null, pan: null };
    let rollSchedTimer = null;
    let rollNodes = [];      // 停止用
    let rollFileSrc = null;
    let rollGain = null;

    function ensureCtx() {
      if (!AC) return null;
      if (!ctx) {
        ctx = new AC();
        // ホワイトノイズ（スネア・シンバル用）
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        loadFiles();
      }
      return ctx;
    }

    async function loadFiles() {
      for (const key of Object.keys(SOUND_FILES)) {
        try {
          const res = await fetch(SOUND_FILES[key]);
          if (!res.ok) continue;
          const arr = await res.arrayBuffer();
          files[key] = await new Promise((ok, ng) => ctx.decodeAudioData(arr, ok, ng));
        } catch (_) { /* ファイルが無ければ生成音を使う */ }
      }
    }

    function unlock() {
      const c = ensureCtx();
      if (c && c.state === 'suspended') c.resume();
    }

    function noise(t, dur) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.start(t, Math.random() * 1.5, dur);
      return src;
    }

    // スネア1打
    function snareHit(t, vel, out) {
      const n = noise(t, 0.12);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1200;
      const bp = ctx.createBiquadFilter();
      bp.type = 'peaking'; bp.frequency.value = 3500; bp.gain.value = 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vel, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      n.connect(hp).connect(bp).connect(g).connect(out);

      // 胴鳴り
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.05);
      const og = ctx.createGain();
      og.gain.setValueAtTime(vel * 0.5, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(og).connect(out);
      o.start(t); o.stop(t + 0.07);
      rollNodes.push(n, o);
    }

    function startRoll() {
      if (!soundOn) return;
      const c = ensureCtx();
      if (!c) return;
      stopRoll();
      rollGain = c.createGain();
      rollGain.gain.value = 1;
      rollGain.connect(c.destination);

      if (files.roll) {
        rollFileSrc = c.createBufferSource();
        rollFileSrc.buffer = files.roll;
        rollFileSrc.loop = true;
        rollFileSrc.connect(rollGain);
        rollFileSrc.start();
        return;
      }

      // 生成ドラムロール：だんだん大きくなる高速スネア連打
      const start = c.currentTime + 0.02;
      let next = start;
      let i = 0;
      const step = 0.042;
      const schedule = () => {
        while (next < c.currentTime + 0.12) {
          const progress = Math.min(1, (next - start) / 2.5);
          const base = 0.18 + 0.32 * progress;
          const vel = base * (i % 2 ? 0.8 : 1) * (0.9 + Math.random() * 0.2);
          snareHit(next, vel, rollGain);
          next += step * (0.97 + Math.random() * 0.06);
          i++;
        }
        rollNodes = rollNodes.slice(-40);
      };
      schedule();
      rollSchedTimer = setInterval(schedule, 25);
    }

    function stopRoll() {
      clearInterval(rollSchedTimer);
      rollSchedTimer = null;
      if (rollFileSrc) { try { rollFileSrc.stop(); } catch (_) {} rollFileSrc = null; }
      if (rollGain && ctx) {
        // 予約済みの打音もまとめて消す
        const g = rollGain;
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
        setTimeout(() => g.disconnect(), 200);
      }
      rollNodes.forEach((n) => { try { n.stop(); } catch (_) {} });
      rollNodes = [];
      rollGain = null;
    }

    // 「パン！」決定音
    function pan() {
      if (!soundOn) return;
      const c = ensureCtx();
      if (!c) return;
      const t = c.currentTime + 0.01;
      const out = c.createGain();
      out.gain.value = 0.9;
      out.connect(c.destination);

      if (files.pan) {
        const s = c.createBufferSource();
        s.buffer = files.pan;
        s.connect(out);
        s.start(t);
        return;
      }

      // ① アタック（クラップ＋キック）
      const clap = noise(t, 0.25);
      const cbp = c.createBiquadFilter();
      cbp.type = 'bandpass'; cbp.frequency.value = 1800; cbp.Q.value = 0.8;
      const cg = c.createGain();
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.exponentialRampToValueAtTime(0.9, t + 0.003);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      clap.connect(cbp).connect(cg).connect(out);

      const kick = c.createOscillator();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(160, t);
      kick.frequency.exponentialRampToValueAtTime(45, t + 0.15);
      const kg = c.createGain();
      kg.gain.setValueAtTime(0.9, t);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      kick.connect(kg).connect(out);
      kick.start(t); kick.stop(t + 0.3);

      // ② シンバル
      const cym = noise(t, 1.6);
      const chp = c.createBiquadFilter();
      chp.type = 'highpass'; chp.frequency.value = 5000;
      const cyg = c.createGain();
      cyg.gain.setValueAtTime(0.0001, t);
      cyg.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      cyg.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      cym.connect(chp).connect(cyg).connect(out);

      // ③ 明るい和音（ドミソド）＋キラキラ
      const chord = [1046.5, 1318.5, 1568.0, 2093.0];
      chord.forEach((f, idx) => {
        const o = c.createOscillator();
        o.type = idx % 2 ? 'triangle' : 'sine';
        o.frequency.value = f;
        const g = c.createGain();
        const st = t + idx * 0.025;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(0.16, st + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, st + 1.1);
        o.connect(g).connect(out);
        o.start(st); o.stop(st + 1.2);
      });
      [3136, 4186, 5274].forEach((f, idx) => {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const g = c.createGain();
        const st = t + 0.12 + idx * 0.07;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(0.07, st + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, st + 0.4);
        o.connect(g).connect(out);
        o.start(st); o.stop(st + 0.45);
      });
    }

    return { unlock, startRoll, stopRoll, pan };
  })();

  // ===== 全画面 =====
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  async function toggleFullscreen() {
    const el = document.documentElement;
    try {
      if (isFullscreen()) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        return;
      }
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!req) throw new Error('unsupported');
      await req.call(el);
      // Android などでは横向きに固定
      try { await screen.orientation.lock('landscape'); } catch (_) {}
    } catch (_) {
      showToast('この端末では全画面ボタンが使えません。\nSafariの「共有」→「ホーム画面に追加」から開くと全画面で表示できます。');
    }
  }
  function updateFullscreenButton() {
    btnFullscreen.textContent = isFullscreen() ? '✕ 全画面解除' : '⛶ 全画面';
    btnFullscreen.hidden = isStandalone();
  }

  let toastTimer = null;
  function showToast(text) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '18vh', transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '14px 20px', borderRadius: '12px',
        fontSize: '15px', lineHeight: '1.6', whiteSpace: 'pre-line', textAlign: 'center',
        zIndex: 150, maxWidth: '86vw', pointerEvents: 'none',
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  // ===== 画面スリープ防止 =====
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  // ===== ボタンを使っていないときは薄くする =====
  let dimTimer = null;
  function wakeControls() {
    document.body.classList.remove('controls-dim');
    clearTimeout(dimTimer);
    dimTimer = setTimeout(() => document.body.classList.add('controls-dim'), 5000);
  }

  // ===== イベント =====
  // 反応を速くするため pointerdown を使う
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    requestWakeLock();
    onStageTap();
  });

  const guard = (fn) => (e) => { e.stopPropagation(); sound.unlock(); wakeControls(); fn(); };
  [btnUndo, btnReset, btnSound, btnFullscreen].forEach((b) =>
    b.addEventListener('pointerdown', (e) => e.stopPropagation()));

  btnUndo.addEventListener('click', guard(undo));
  btnReset.addEventListener('click', guard(() => {
    if (history.length === 0 && phase !== 'rolling') return;
    confirmEl.hidden = false;
  }));
  btnSound.addEventListener('click', guard(() => {
    soundOn = !soundOn;
    if (!soundOn) sound.stopRoll();
    save();
    render();
  }));
  btnFullscreen.addEventListener('click', guard(toggleFullscreen));

  $('confirm-no').addEventListener('click', () => { confirmEl.hidden = true; });
  $('confirm-yes').addEventListener('click', () => { confirmEl.hidden = true; reset(); });
  confirmEl.addEventListener('pointerdown', (e) => e.stopPropagation());

  // キーボード操作（PCで試すとき用）：スペース/Enter=タップ、Backspace=1つ戻す
  document.addEventListener('keydown', (e) => {
    if (!confirmEl.hidden) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onStageTap(); }
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
  });

  document.addEventListener('fullscreenchange', updateFullscreenButton);
  document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
  document.addEventListener('pointerdown', wakeControls, true);

  // ===== 初期化 =====
  load();
  buildHistorySlots();
  phase = phaseFromHistory();
  render();
  updateFullscreenButton();
  wakeControls();
})();
