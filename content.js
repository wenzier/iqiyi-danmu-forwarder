/*
 * 爱奇艺实时弹幕转发器 (iQiyi Danmu Forwarder) - content script
 * 精简版：只保留“定时抓取屏上实时弹幕并原样再发”这一个功能。
 *
 * Copyright (C) 2026 wenzier
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
(function () {
  'use strict';

  if (window.__IQDF_LOADED__) return;
  window.__IQDF_LOADED__ = true;

  const STORAGE_KEY = 'iqdf_settings';
  const MIN_INTERVAL = 5; // 转发最小间隔（秒），规避高频风险

  // 抓不到实时弹幕时的内置兜底短语（无预设管理界面，仅内部使用）
  const FALLBACK_PHRASES = ['哈哈哈哈', '精彩', '前方高能', '名场面', '泪目了', '支持一下'];

  const DEFAULT_SETTINGS = {
    panelPos: null,           // { left, top }
    collapsed: false,
    inputSelector: '',        // 自定义“弹幕输入框”选择器（发送兜底）
    forward: {
      interval: 20,           // 转发间隔（秒）
      maxLen: 20,             // 跳过超过此长度的弹幕
      dedup: true,            // 短时间内不重复转发同一条
      skipAbnormal: true,     // 跳过含网址/纯表情/特殊字符的弹幕
      fallbackPreset: true,   // 抓不到时发内置兜底短语
      selector: '',           // 自定义“弹幕元素”选择器（抓取兜底）
      enabled: false          // 运行态（持久化，重开自动恢复）
    }
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let forwardTimer = null;
  let recentSent = [];        // 最近转发过的文本（去重用，最多 30 条）

  /* ------------------------- storage ------------------------- */
  function loadSettings(cb) {
    try {
      chrome.storage.local.get(STORAGE_KEY, (res) => {
        if (res && res[STORAGE_KEY]) {
          settings = Object.assign({}, DEFAULT_SETTINGS, res[STORAGE_KEY]);
          settings.forward = Object.assign({}, DEFAULT_SETTINGS.forward, res[STORAGE_KEY].forward || {});
        }
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }

  function saveSettings() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: settings }); } catch (e) { /* ignore */ }
  }

  /* --------------------- 工具 --------------------- */
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  /* --------------------- 弹幕输入框探测（发送用） --------------------- */
  function findInput() {
    if (settings.inputSelector) {
      const el = document.querySelector(settings.inputSelector);
      if (isVisible(el)) return el;
    }
    const candidates = Array.from(
      document.querySelectorAll('input[type="text"], input:not([type]), textarea')
    );
    // 策略 1：placeholder 含“弹幕”
    let hit = candidates.find(
      (el) => isVisible(el) && /弹幕/.test(el.getAttribute('placeholder') || '')
    );
    if (hit) return hit;
    // 策略 2：class/id/父级含 danmu/barrage/bullet 关键字
    const kw = /danmu|danmaku|barrage|bullet|comment-send|send-input/i;
    hit = candidates.find((el) => {
      if (!isVisible(el)) return false;
      const sig = (el.className + ' ' + el.id + ' ' +
        (el.closest('[class*="danmu"],[class*="barrage"],[class*="bullet"]') ? 'container' : ''));
      return kw.test(sig);
    });
    if (hit) return hit;
    // 策略 3：播放器区域内底部的可见文本输入框
    const player = document.querySelector('[class*="iqp-player"], [id*="player"], .qy-player, #flashbox, video');
    if (player && player.getBoundingClientRect) {
      const rect = player.getBoundingClientRect();
      hit = candidates.find((el) => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left >= rect.left - 20 && r.right <= rect.right + 20 &&
          r.top >= rect.top && r.top <= rect.bottom + 40;
      });
      if (hit) return hit;
    }
    return null;
  }

  function findSendButton(input) {
    if (!input) return null;
    let container = input.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const btns = container.querySelectorAll('button, a, span, div[role="button"], [class*="send"]');
      for (const b of btns) {
        const txt = (b.textContent || '').trim();
        const sig = (b.className + ' ' + b.id).toLowerCase();
        if (/^发\s*送$|发送弹幕|send/.test(txt) || /send-btn|btn-send|send-danmu/.test(sig)) {
          if (isVisible(b) && b !== input) return b;
        }
      }
      container = container.parentElement;
    }
    return null;
  }

  /* ---------------- React 受控输入框填值 ---------------- */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const setter = desc && desc.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dispatchEnter(el) {
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      el.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true, cancelable: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13
      }));
    });
  }

  /* ------------------------ 发送弹幕 ------------------------ */
  function sendDanmu(text) {
    text = (text || '').trim();
    if (!text) return false;
    const input = findInput();
    if (!input) {
      setStatus('未找到弹幕输入框，请先打开播放器弹幕栏', 'err');
      return false;
    }
    input.focus();
    setNativeValue(input, text);
    const btn = findSendButton(input);
    setTimeout(() => {
      if (btn) btn.click(); else dispatchEnter(input);
    }, 60);
    return true;
  }

  /* -------------- 实时弹幕探测 & 过滤 & 抽取 -------------- */
  // 注意：只能读到 DOM 渲染的弹幕（<div>/<span> 带文字）。
  // 若爱奇艺用 <canvas> 绘制弹幕，则文字是像素、DOM 读不到，探测返回空。
  function findLiveDanmus() {
    const texts = [];
    const seen = new Set();
    const pushText = (raw) => {
      const t = (raw || '').replace(/\s+/g, ' ').trim();
      if (t && !seen.has(t)) { seen.add(t); texts.push(t); }
    };

    // 策略 0：自定义选择器优先
    if (settings.forward.selector) {
      try {
        document.querySelectorAll(settings.forward.selector).forEach((el) => {
          if (isVisible(el)) pushText(el.textContent);
        });
      } catch (e) { /* 选择器非法则忽略 */ }
      if (texts.length) return texts;
    }

    // 策略 1：class/id 含弹幕关键字的元素
    const kw = '[class*="danmu"],[class*="danmaku"],[class*="barrage"],[class*="bullet"],[class*="comment-item"],[class*="mask-cmt"]';
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(kw)); } catch (e) { nodes = []; }
    nodes.forEach((el) => {
      if (!isVisible(el)) return;
      if (el.closest('#iqdf-panel')) return; // 跳过自己面板
      const txt = el.textContent || '';
      if (txt.length > 0 && txt.length <= 60) pushText(txt);
    });
    return texts;
  }

  function isForwardable(text) {
    const f = settings.forward;
    if (!text) return false;
    if (f.maxLen > 0 && text.length > f.maxLen) return false;
    if (f.dedup && recentSent.indexOf(text) !== -1) return false;
    if (f.skipAbnormal) {
      if (/https?:\/\/|www\.|\.com|\.cn/i.test(text)) return false;
      const core = text.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
      if (!/[一-龥a-zA-Z0-9]/.test(core)) return false;
      const special = (text.match(/[^一-龥a-zA-Z0-9\s，。！？、~,.!?]/g) || []).length;
      if (special > text.length * 0.5) return false;
    }
    return true;
  }

  function pickLiveDanmu() {
    const ok = findLiveDanmus().filter(isForwardable);
    if (!ok.length) return null;
    return ok[Math.floor(Math.random() * ok.length)];
  }

  function rememberSent(text) {
    recentSent.push(text);
    if (recentSent.length > 30) recentSent.shift();
  }

  /* -------------- 转发循环控制 -------------- */
  function startForward() {
    stopForward();
    const sec = Math.max(MIN_INTERVAL, Number(settings.forward.interval) || MIN_INTERVAL);
    const fire = () => {
      const picked = pickLiveDanmu();
      if (picked) {
        if (sendDanmu(picked)) { rememberSent(picked); setStatus('已转发：' + picked, 'ok'); }
      } else if (settings.forward.fallbackPreset) {
        const t = FALLBACK_PHRASES[Math.floor(Math.random() * FALLBACK_PHRASES.length)];
        if (sendDanmu(t)) setStatus('未抓到实时弹幕，已发兜底：' + t, 'warn');
      } else {
        setStatus('本轮未抓到可转发的实时弹幕', 'warn');
      }
    };
    fire();
    forwardTimer = setInterval(fire, sec * 1000);
    updateUI();
  }

  function stopForward() {
    if (forwardTimer) { clearInterval(forwardTimer); forwardTimer = null; }
    updateUI();
  }

  /* ------------------------ 面板 UI ------------------------ */
  let panel, elStatus, elDot;

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else el.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => el.appendChild(c));
    return el;
  }

  function setStatus(msg, type) {
    if (!elStatus) return;
    elStatus.textContent = msg || '';
    elStatus.className = '';
    if (type) elStatus.classList.add(type);
    if (type === 'ok') {
      clearTimeout(setStatus._t);
      setStatus._t = setTimeout(() => {
        if (elStatus.textContent === msg) { elStatus.textContent = ''; elStatus.className = ''; }
      }, 2500);
    }
  }

  function updateUI() {
    if (!panel) return;
    const running = !!forwardTimer;
    if (elDot) elDot.className = 'iqdf-dot' + (running ? '' : ' off');
    const toggle = panel.querySelector('#iqdf-toggle');
    if (toggle) {
      toggle.textContent = running ? '停止转发' : '开始转发';
      toggle.classList.toggle('secondary', running);
    }
  }

  function buildPanel() {
    const f = settings.forward;

    const interval = h('input', { class: 'iqdf-input-num', type: 'number', min: String(MIN_INTERVAL), value: String(f.interval) });
    interval.addEventListener('change', () => {
      let v = Math.floor(Number(interval.value));
      if (!(v >= MIN_INTERVAL)) { v = MIN_INTERVAL; setStatus('最小间隔 ' + MIN_INTERVAL + ' 秒', 'warn'); }
      f.interval = v; interval.value = String(v); saveSettings();
      if (forwardTimer) startForward();
    });

    const maxLen = h('input', { class: 'iqdf-input-num', type: 'number', min: '0', value: String(f.maxLen) });
    maxLen.addEventListener('change', () => { let v = Math.floor(Number(maxLen.value)); if (!(v >= 0)) v = 0; f.maxLen = v; maxLen.value = String(v); saveSettings(); });

    const mkCheck = (key, label) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!f[key];
      cb.addEventListener('change', () => { f[key] = cb.checked; saveSettings(); });
      return h('label', { class: 'iqdf-check' }, [cb, h('span', { text: label })]);
    };

    const selector = h('input', {
      type: 'text', placeholder: '抓不到弹幕？粘贴弹幕元素CSS选择器',
      value: f.selector || '', class: 'iqdf-input-text'
    });
    selector.addEventListener('change', () => { f.selector = selector.value.trim(); saveSettings(); setStatus(f.selector ? '已设置弹幕选择器' : '已清除', 'ok'); });

    const inputSel = h('input', {
      type: 'text', placeholder: '发不出？粘贴弹幕输入框CSS选择器',
      value: settings.inputSelector || '', class: 'iqdf-input-text'
    });
    inputSel.addEventListener('change', () => { settings.inputSelector = inputSel.value.trim(); saveSettings(); setStatus(settings.inputSelector ? '已设置输入框选择器' : '已清除', 'ok'); });

    const toggle = h('button', { id: 'iqdf-toggle', class: 'iqdf-btn', text: '开始转发' });
    toggle.addEventListener('click', () => {
      if (forwardTimer) { f.enabled = false; stopForward(); }
      else { f.enabled = true; startForward(); }
      saveSettings();
    });

    elStatus = h('div', { id: 'iqdf-status' });

    const body = h('div', { id: 'iqdf-body' }, [
      h('div', { class: 'iqdf-row' }, [
        h('span', { class: 'iqdf-lbl', text: '每' }), interval,
        h('span', { class: 'iqdf-lbl', text: '秒抓一条实时弹幕转发' })
      ]),
      h('div', { class: 'iqdf-row' }, [
        mkCheck('dedup', '避免重复'),
        h('label', { class: 'iqdf-check' }, [h('span', { text: '最长' }), maxLen, h('span', { text: '字' })])
      ]),
      h('div', { class: 'iqdf-row' }, [
        mkCheck('skipAbnormal', '跳过异常内容'),
        mkCheck('fallbackPreset', '抓不到发兜底')
      ]),
      h('div', { class: 'iqdf-row' }, [selector]),
      h('div', { class: 'iqdf-row' }, [inputSel]),
      h('div', { class: 'iqdf-row' }, [toggle]),
      elStatus
    ]);

    elDot = h('span', { class: 'iqdf-dot off' });
    const collapseBtn = h('span', { class: 'iqdf-hbtn', text: '—', title: '折叠/展开' });
    collapseBtn.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      panel.classList.toggle('iqdf-collapsed', settings.collapsed);
      collapseBtn.textContent = settings.collapsed ? '＋' : '—';
      saveSettings();
    });
    const header = h('div', { id: 'iqdf-header' }, [
      h('div', { id: 'iqdf-title' }, [elDot, h('span', { text: '实时弹幕转发器' })]),
      h('div', { id: 'iqdf-hbtns' }, [collapseBtn])
    ]);

    panel = h('div', { id: 'iqdf-panel' }, [header, body,
      h('div', { id: 'iqdf-footer', text: 'by wenzier' })
    ]);
    if (settings.collapsed) { panel.classList.add('iqdf-collapsed'); collapseBtn.textContent = '＋'; }
    document.body.appendChild(panel);

    if (settings.panelPos) {
      panel.style.left = settings.panelPos.left + 'px';
      panel.style.top = settings.panelPos.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    }

    makeDraggable(panel, header);
    updateUI();
    if (f.enabled) startForward(); // 恢复上次运行态
  }

  /* ------------------------ 拖动 ------------------------ */
  function makeDraggable(box, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.iqdf-hbtn')) return;
      dragging = true;
      const r = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let nl = ox + (e.clientX - sx);
      let nt = oy + (e.clientY - sy);
      nl = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, nl));
      nt = Math.max(0, Math.min(window.innerHeight - 40, nt));
      box.style.left = nl + 'px'; box.style.top = nt + 'px';
      box.style.right = 'auto'; box.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = box.getBoundingClientRect();
      settings.panelPos = { left: r.left, top: r.top };
      saveSettings();
    });
  }

  /* ------------------------ 初始化 ------------------------ */
  function init() {
    if (!document.body) { setTimeout(init, 300); return; }
    loadSettings(() => { buildPanel(); });
  }

  init();
})();
