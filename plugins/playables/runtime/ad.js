import { Time } from './core.js';
import { Engine } from './object.js';
import { SceneManager, Assets } from './scene.js';

const adStyles = `
.pa-layer{position:absolute;inset:0;pointer-events:none;font-family:"pf0",system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff}
.pa-cta{position:absolute;left:50%;transform:translateX(-50%);pointer-events:auto;cursor:pointer;white-space:nowrap;border:0;
font:inherit;font-weight:800;font-size:calc(var(--u)*5.2);line-height:1;color:#fff;padding:calc(var(--u)*3.6) calc(var(--u)*8);
border-radius:calc(var(--u)*10);background:linear-gradient(180deg,#9a7dff 0%,#6b46f5 100%);
box-shadow:0 calc(var(--u)*1.2) 0 #3d23a8,0 calc(var(--u)*2.4) calc(var(--u)*5) rgba(40,20,120,.55)}
.pa-cta:active{filter:brightness(.9)}
.pa-hint{position:absolute;left:0;right:0;text-align:center;font-weight:800;font-size:calc(var(--u)*4.2);
text-shadow:0 calc(var(--u)*.4) calc(var(--u)*1.2) rgba(0,0,0,.6);opacity:.95}
.pa-end{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;
background:rgba(9,10,18,.9);-webkit-backdrop-filter:blur(calc(var(--u)*1.6));backdrop-filter:blur(calc(var(--u)*1.6));
opacity:0;visibility:hidden}
.pa-layer.pa-ended>.pa-cta,.pa-layer.pa-ended>.pa-hint{visibility:hidden}
.pa-end.pa-on{visibility:visible}
.pa-card{display:flex;flex-direction:column;align-items:center;text-align:center;gap:calc(var(--u)*4);padding:0 calc(var(--u)*8);
transform:translateY(calc(var(--u)*4))}
.pa-logo{width:calc(var(--u)*24);height:calc(var(--u)*24);border-radius:22%;box-shadow:0 calc(var(--u)*1.5) calc(var(--u)*5) rgba(0,0,0,.5)}
.pa-title{font-weight:800;font-size:calc(var(--u)*10);line-height:1.05}
.pa-score{font-weight:800;font-size:calc(var(--u)*7);color:#ffe9a8}
.pa-sub{font-size:calc(var(--u)*4.4);line-height:1.3;opacity:.85;max-width:calc(var(--u)*76);text-wrap:balance}
.pa-end .pa-cta{position:static;transform:none;font-size:calc(var(--u)*6.4);padding:calc(var(--u)*4.6) calc(var(--u)*10);margin-top:calc(var(--u)*3)}
.pa-again{pointer-events:auto;cursor:pointer;background:none;border:0;font:inherit;font-weight:800;color:#fff;opacity:.75;
font-size:calc(var(--u)*4.4);text-decoration:underline;padding:calc(var(--u)*2)}
`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bezier(x1, y1, x2, y2) {
  return (x) => {
    let low = 0;
    let high = 1;
    let t = x;
    for (let i = 0; i < 30; i++) {
      t = (low + high) / 2;
      if (3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t < x) low = t;
      else high = t;
    }
    return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  };
}

const ease = bezier(0.25, 0.1, 0.25, 1);
const easeInOut = bezier(0.42, 0, 0.58, 1);
const pulsePeriod = 1.6;
const pulseScale = 0.045;
const fadeDuration = 0.35;

function fade(value) {
  return { value, from: value, to: value, t: 1 };
}

function fadeTo(state, to) {
  if (state.to === to) return;
  state.from = state.value;
  state.to = to;
  state.t = 0;
}

function fadeStep(state, delta) {
  if (state.t >= 1) return;
  state.t = Math.min(1, state.t + delta / fadeDuration);
  state.value = state.from + (state.to - state.from) * ease(state.t);
}

export const Ad = {
  playable: null,
  config: null,
  layer: null,
  hint: null,
  end: null,
  title: null,
  score: null,
  sub: null,
  pending: null,
  endCardShown: false,
  clicks: 0,
  endSent: false,
  lastOpened: null,
  logo: null,
  logoDrawn: false,
  buttons: [],
  card: null,
  clock: 0,
  hintFade: fade(1),
  endFade: fade(0),

  init(playable) {
    this.playable = playable;
    this.config = playable.config;
    const cta = this.config.cta || {};
    const endCard = this.config.endCard || {};
    const style = document.createElement('style');
    style.textContent = adStyles;
    document.head.appendChild(style);

    this.layer = element('div', 'pa-layer');
    const button = element('button', 'pa-cta', cta.label || 'Install');
    button.style.bottom = (cta.bottom === undefined ? 5 : cta.bottom) + '%';
    button.addEventListener('click', () => this.open());
    this.layer.appendChild(button);

    if (this.config.hint && this.config.hint.text) {
      this.hint = element('div', 'pa-hint', this.config.hint.text);
      this.hint.style.bottom = (this.config.hint.bottom === undefined ? 16 : this.config.hint.bottom) + '%';
      this.layer.appendChild(this.hint);
    }

    this.end = element('div', 'pa-end');
    const card = element('div', 'pa-card');
    this.title = element('div', 'pa-title');
    this.score = element('div', 'pa-score');
    this.sub = element('div', 'pa-sub', endCard.subtitle || '');
    const endButton = element('button', 'pa-cta', cta.label || 'Install');
    endButton.addEventListener('click', () => this.open());
    const again = element('button', 'pa-again', endCard.playAgain || 'Play again');
    again.addEventListener('click', () => this.playable.restart());
    if (endCard.logoSprite) {
      this.logo = element('canvas', 'pa-logo');
      card.appendChild(this.logo);
    }
    card.append(this.title, this.score, this.sub, endButton, again);
    this.buttons = [button, endButton];
    this.card = card;
    this.end.appendChild(card);
    this.layer.appendChild(this.end);
    playable.stage.appendChild(this.layer);
    this.animate(0);

    Engine.preUpdate.push(() => this.tick());
    SceneManager.sceneLoaded.AddListener(() => this.reset());
    SceneManager.onMissingScene = () => this.showEndCard({});
  },

  whenReady(start) {
    const network = this.config.network || 'mraid';
    if (network === 'mintegral') {
      let begun = false;
      const begin = () => {
        if (begun) return;
        begun = true;
        start();
      };
      window.gameStart = begin;
      window.gameClose = () => this.playable.pause();
      if (typeof window.gameReady === 'function') window.gameReady();
      setTimeout(begin, typeof window.install === 'function' ? 10000 : 3000);
      return;
    }
    const mraid = window.mraid;
    if (!mraid || typeof mraid.getState !== 'function') {
      start();
      return;
    }
    const begin = () => {
      mraid.addEventListener('viewableChange', (viewable) => {
        if (viewable) {
          start();
          this.playable.resume();
        } else {
          this.playable.pause();
        }
      });
      if (typeof mraid.isViewable !== 'function' || mraid.isViewable()) start();
    };
    if (mraid.getState() === 'loading') mraid.addEventListener('ready', begin);
    else begin();
  },

  storeUrl() {
    const cta = this.config.cta || {};
    const store = this.config.storeUrl || {};
    const ios = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent || '');
    return (ios ? store.ios : store.android) || store.android || store.ios || cta.url || '';
  },

  open() {
    const url = this.storeUrl();
    const network = this.config.network || 'mraid';
    this.clicks++;
    this.lastOpened = url;
    const has = (target, name) => !!target && typeof target[name] === 'function';
    if (network === 'google' && has(window.ExitApi, 'exit')) return ExitApi.exit();
    if (network === 'meta' && has(window.FbPlayableAd, 'onCTAClick')) return FbPlayableAd.onCTAClick();
    if (network === 'mintegral' && has(window, 'install')) return window.install();
    if (network === 'tiktok' && has(window, 'openAppStore')) return window.openAppStore();
    if (network === 'tiktok' && has(window.playableSDK, 'openAppStore')) return window.playableSDK.openAppStore();
    if (has(window.mraid, 'open')) return mraid.open(url);
    window.open(url, '_blank');
  },

  ended() {
    if (this.endSent) return;
    this.endSent = true;
    if ((this.config.network || '') === 'mintegral' && typeof window.gameEnd === 'function') window.gameEnd();
  },

  interaction() {
    if (this.hint) this.hint.classList.add('pa-off');
    fadeTo(this.hintFade, 0);
  },

  reset() {
    this.pending = null;
    this.endCardShown = false;
    this.endSent = false;
    if (this.end) this.end.classList.remove('pa-on');
    if (this.layer) this.layer.classList.remove('pa-ended');
    if (this.hint) this.hint.classList.remove('pa-off');
    this.clock = 0;
    this.endFade = fade(0);
    fadeTo(this.hintFade, 1);
    if (this.card) this.animate(0);
  },

  scheduleEndCard(delay, info) {
    if (this.endCardShown) return;
    if (this.pending && this.pending.at <= Time.timeAsDouble + delay) return;
    this.pending = { at: Time.timeAsDouble + delay, info: info || {} };
  },

  tick() {
    if (this.pending && Time.timeAsDouble >= this.pending.at) {
      const info = this.pending.info;
      this.pending = null;
      this.showEndCard(info);
    }
    const endCard = this.config.endCard || {};
    if (endCard.afterSeconds > 0 && !this.endCardShown && !this.pending && this.clock >= endCard.afterSeconds) {
      this.scheduleEndCard(0, { title: endCard.timeTitle || endCard.winTitle });
    }
    this.animate(Time.deltaTime);
  },

  animate(delta) {
    this.clock += delta;
    const phase = (this.clock % pulsePeriod) / pulsePeriod;
    const scale = (1 + pulseScale * easeInOut(phase < 0.5 ? phase * 2 : 2 - phase * 2)).toFixed(5);
    for (const button of this.buttons) button.style.scale = scale;
    fadeStep(this.hintFade, delta);
    fadeStep(this.endFade, delta);
    if (this.hint) this.hint.style.opacity = (0.95 * this.hintFade.value).toFixed(4);
    this.end.style.opacity = this.endFade.value.toFixed(4);
    this.card.style.transform = 'translateY(calc(var(--u)*' + (4 * (1 - this.endFade.value)).toFixed(4) + '))';
  },

  drawLogo() {
    const sprite = this.logo && !this.logoDrawn ? Assets.sprite(this.config.endCard.logoSprite) : null;
    const renderer = this.playable.renderer;
    if (!sprite || !renderer) return;
    this.logoDrawn = true;
    const size = Math.min(512, sprite.w);
    this.logo.width = size;
    this.logo.height = Math.round((size * sprite.h) / sprite.w);
    const context = this.logo.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(renderer.atlases[sprite.atlas], sprite.x, sprite.y, sprite.w, sprite.h, 0, 0, this.logo.width, this.logo.height);
  },

  showEndCard(info) {
    const endCard = this.config.endCard || {};
    this.pending = null;
    this.endCardShown = true;
    this.title.textContent = info.title || endCard.title || this.config.title || '';
    this.score.textContent = info.score === undefined ? '' : String(info.score);
    this.score.style.display = info.score === undefined ? 'none' : '';
    this.end.classList.add('pa-on');
    fadeTo(this.endFade, 1);
    this.layer.classList.add('pa-ended');
    this.drawLogo();
    this.interaction();
    this.ended();
  },
};
