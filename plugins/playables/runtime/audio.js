import { Time } from './core.js';
import { UnityObject, Behaviour, GameObject, Engine, Destroy } from './object.js';
import { registerComponentType } from './components.js';
import { registerAssetTable, Assets } from './scene.js';
import { Playable } from './playable.js';

const audioUnlockEvents = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'click', 'keydown'];
let audioListenerVolume = 1;
let audioListenerPause = false;
let audioDecoder = null;

export const AudioSystem = {
  context: null,
  master: null,
  unlocked: false,
  bound: false,
  userMuted: false,
  deviceMuted: false,
  masterVolume: 1,
  holds: new Set(),
  voices: new Set(),
  clips: new Set(),
  log: [],

  get muted() {
    return this.userMuted;
  },
  set muted(value) {
    this.userMuted = !!value;
    this.refresh();
  },
  get volume() {
    return this.masterVolume;
  },
  set volume(value) {
    this.masterVolume = Math.max(0, Number(value) || 0);
    this.refresh();
  },
  get audible() {
    return this.unlocked && this.holds.size === 0 && !this.userMuted && !this.deviceMuted && !!this.context && this.context.state === 'running';
  },

  init(config) {
    const options = config || {};
    this.userMuted = !!options.muted;
    this.masterVolume = options.volume === undefined ? 1 : Math.max(0, Number(options.volume) || 0);
    if (this.bound) return;
    this.bound = true;
    this.onGesture = () => this.unlock();
    for (const name of audioUnlockEvents) window.addEventListener(name, this.onGesture, true);
    document.addEventListener('visibilitychange', () => (document.hidden ? this.hold('hidden') : this.release('hidden')));
    if (document.hidden) this.holds.add('hidden');
    const mraid = window.mraid;
    if (mraid && typeof mraid.addEventListener === 'function') {
      try {
        mraid.addEventListener('audioVolumeChange', (volume) => this.deviceVolume(volume));
      } catch (error) {
        this.log.push('mraid audioVolumeChange: ' + error);
      }
    }
  },

  deviceVolume(volume) {
    if (typeof volume !== 'number' || volume !== volume) return;
    this.deviceMuted = volume <= 0;
    this.refresh();
  },

  unlock(force) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return false;
    if (!this.context) {
      const activation = navigator.userActivation;
      if (!force && activation && !activation.isActive && !activation.hasBeenActive) return false;
      try {
        this.context = new Context({ latencyHint: 'interactive' });
      } catch (error) {
        this.log.push('context: ' + error);
        return false;
      }
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.context.addEventListener('statechange', () => this.stateChanged());
      this.refresh();
    }
    if (this.holds.size === 0 && this.context.state !== 'running') {
      const resumed = this.context.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch((error) => this.log.push('resume: ' + error));
    }
    this.stateChanged();
    return this.unlocked;
  },

  stateChanged() {
    if (this.unlocked || !this.context || this.context.state !== 'running') return;
    this.unlocked = true;
    for (const name of audioUnlockEvents) window.removeEventListener(name, this.onGesture, true);
    for (const clip of this.clips) clip._decode();
    for (const voice of this.voices) audioVoiceStart(voice);
  },

  hold(reason) {
    this.holds.add(reason);
    if (this.context && this.context.state === 'running') this.context.suspend();
  },

  release(reason) {
    this.holds.delete(reason);
    if (this.holds.size === 0 && this.context && this.context.state !== 'running') this.context.resume();
  },

  refresh() {
    if (!this.master) return;
    this.master.gain.value = this.userMuted || this.deviceMuted ? 0 : this.masterVolume * audioListenerVolume;
  },

  state() {
    return {
      context: this.context ? this.context.state : 'none',
      unlocked: this.unlocked,
      audible: this.audible,
      muted: this.userMuted,
      deviceMuted: this.deviceMuted,
      gain: this.master ? this.master.gain.value : null,
      holds: Array.from(this.holds),
      voices: Array.from(this.voices).map((voice) => ({ clip: voice.clip._name, position: Math.round(voice.position * 1000) / 1000, oneShot: voice.oneShot, ended: voice.ended, node: !!voice.node })),
      clips: Array.from(this.clips).map((clip) => ({ name: clip._name, length: clip.length, state: clip.loadState, decoded: clip._buffer ? Math.round(clip._buffer.duration * 1000) / 1000 : null })),
      log: this.log.slice(0, 10),
    };
  },
};

function audioVoiceFrozen(voice) {
  return voice.source._paused || (audioListenerPause && !voice.source.ignoreListenerPause);
}

function audioVoiceGain(voice) {
  const source = voice.source;
  return source._mute ? 0 : Math.max(0, source._volume) * voice.volumeScale;
}

function audioVoiceDrop(voice) {
  const node = voice.node;
  if (!node) return;
  voice.node = null;
  node.onended = null;
  try {
    node.stop();
  } catch (error) {
    voice.failed = true;
  }
  node.disconnect();
  voice.gain.disconnect();
  voice.gain = null;
}

function audioVoiceRemove(voice) {
  audioVoiceDrop(voice);
  voice.ended = true;
  AudioSystem.voices.delete(voice);
  voice.source._voices.delete(voice);
  if (voice.source._main === voice) voice.source._main = null;
}

function audioVoiceStart(voice) {
  const system = AudioSystem;
  if (voice.node || !system.unlocked || audioVoiceFrozen(voice) || !system.voices.has(voice)) return;
  const clip = voice.clip;
  const buffer = clip._buffer;
  if (!buffer) {
    clip._decode().then(() => {
      if (clip._buffer) audioVoiceStart(voice);
      else if (voice.ended) audioVoiceRemove(voice);
    });
    return;
  }
  const looping = !voice.oneShot && voice.source._loop;
  let offset = Math.max(0, voice.position);
  if (!looping && !voice.started && offset < 0.25) offset = 0;
  if (looping) offset %= buffer.duration;
  else if (offset >= buffer.duration || voice.ended) {
    if (voice.ended) audioVoiceRemove(voice);
    return;
  }
  const context = system.context;
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.loop = looping;
  node.playbackRate.value = Math.abs(voice.source._pitch) || 0.0001;
  const gain = context.createGain();
  gain.gain.value = audioVoiceGain(voice);
  node.connect(gain);
  gain.connect(system.master);
  node.onended = () => {
    if (voice.node !== node) return;
    audioVoiceDrop(voice);
    if (voice.ended) audioVoiceRemove(voice);
  };
  node.start(voice.position < 0 ? context.currentTime - voice.position : 0, offset);
  voice.node = node;
  voice.gain = gain;
  voice.started = true;
}

function audioVoiceFinish(voice) {
  voice.ended = true;
  if (voice.source._main === voice) voice.source._main = null;
  if (!voice.node) audioVoiceRemove(voice);
}

function audioTick() {
  const delta = Time.unscaledDeltaTime;
  for (const voice of Array.from(AudioSystem.voices)) {
    if (voice.ended || audioVoiceFrozen(voice)) continue;
    voice.position += delta * (voice.position < 0 ? 1 : Math.abs(voice.source._pitch));
    const length = voice.clip.length;
    if (voice.position < length) continue;
    if (!voice.oneShot && voice.source._loop && length > 0) voice.position %= length;
    else audioVoiceFinish(voice);
  }
}

Engine.preUpdate.push(audioTick);

export const AudioDataLoadState = Object.freeze({ Unloaded: 0, Loading: 1, Loaded: 2, Failed: 3 });

export class AudioClip extends UnityObject {
  constructor(row = {}) {
    super();
    this._name = row.name || '';
    this.frequency = row.frequency || 44100;
    this.channels = row.channels || 1;
    this.length = row.length || 0;
    this.samples = row.samples || Math.round(this.length * this.frequency);
    this.file = row.file || null;
    this.loadState = this.file ? AudioDataLoadState.Unloaded : AudioDataLoadState.Failed;
    this._buffer = null;
    this._decoding = null;
    AudioSystem.clips.add(this);
  }

  LoadAudioData() {
    this._decode();
    return this.loadState !== AudioDataLoadState.Failed;
  }

  _decode() {
    if (this._decoding) return this._decoding;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const bytes = this.file && Offline ? Assets.bytes(this.file) : null;
    if (!bytes) {
      this.loadState = AudioDataLoadState.Failed;
      this._decoding = Promise.resolve(null);
      return this._decoding;
    }
    this.loadState = AudioDataLoadState.Loading;
    if (!audioDecoder) audioDecoder = new Offline(1, 1, 48000);
    this._decoding = new Promise((resolve) => {
      let settled = false;
      const done = (buffer) => {
        if (settled) return;
        settled = true;
        this._buffer = buffer || null;
        this.loadState = buffer ? AudioDataLoadState.Loaded : AudioDataLoadState.Failed;
        if (!buffer) console.warn('Playable runtime: audio clip ' + this._name + ' could not be decoded');
        resolve(this._buffer);
      };
      const pending = audioDecoder.decodeAudioData(bytes.buffer, done, () => done(null));
      if (pending && typeof pending.catch === 'function') pending.catch(() => done(null));
    });
    return this._decoding;
  }
}

export class AudioListener extends Behaviour {
  static fields = [];

  static get volume() {
    return audioListenerVolume;
  }
  static set volume(value) {
    audioListenerVolume = Math.max(0, Math.min(1, Number(value) || 0));
    AudioSystem.refresh();
  }
  static get pause() {
    return audioListenerPause;
  }
  static set pause(value) {
    value = !!value;
    if (audioListenerPause === value) return;
    audioListenerPause = value;
    for (const voice of AudioSystem.voices) {
      if (audioVoiceFrozen(voice)) audioVoiceDrop(voice);
      else audioVoiceStart(voice);
    }
  }

  _load() {}
}

export class AudioSource extends Behaviour {
  constructor() {
    super();
    this.clip = null;
    this.playOnAwake = true;
    this.ignoreListenerPause = false;
    this._volume = 1;
    this._pitch = 1;
    this._loop = false;
    this._mute = false;
    this._paused = false;
    this._seek = 0;
    this._main = null;
    this._voices = new Set();
  }

  static fields = ['clip', 'playOnAwake', 'ignoreListenerPause', 'volume', 'pitch', 'loop', 'mute'];

  static PlayClipAtPoint(clip, position, volume = 1) {
    if (!clip) return;
    const gameObject = new GameObject('One shot audio');
    if (position) gameObject.transform.position = position;
    const source = gameObject.AddComponent(AudioSource);
    source.clip = clip;
    source.volume = volume;
    source.Play();
    Destroy(gameObject, clip.length * (Time.timeScale < 0.01 ? 0.01 : Time.timeScale));
  }

  get volume() {
    return this._volume;
  }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    for (const voice of this._voices) if (voice.gain) voice.gain.gain.value = audioVoiceGain(voice);
  }
  get mute() {
    return this._mute;
  }
  set mute(value) {
    this._mute = !!value;
    for (const voice of this._voices) if (voice.gain) voice.gain.gain.value = audioVoiceGain(voice);
  }
  get pitch() {
    return this._pitch;
  }
  set pitch(value) {
    this._pitch = Number(value) || 0;
    for (const voice of this._voices) if (voice.node) voice.node.playbackRate.value = Math.abs(this._pitch) || 0.0001;
  }
  get loop() {
    return this._loop;
  }
  set loop(value) {
    this._loop = !!value;
    if (this._main && this._main.node) this._main.node.loop = this._loop;
  }
  get isPlaying() {
    if (this._paused) return false;
    for (const voice of this._voices) if (!voice.ended) return true;
    return false;
  }
  get time() {
    return this._main ? Math.max(0, this._main.position) : this._seek;
  }
  set time(value) {
    const length = this.clip ? this.clip.length : 0;
    const seconds = Math.max(0, Math.min(Number(value) || 0, length));
    this._seek = seconds;
    if (!this._main) return;
    this._main.position = seconds;
    audioVoiceDrop(this._main);
    audioVoiceStart(this._main);
  }
  get timeSamples() {
    return this.clip ? Math.round(this.time * this.clip.frequency) : 0;
  }
  set timeSamples(value) {
    if (this.clip) this.time = value / this.clip.frequency;
  }

  _load(props, revive) {
    const clip = revive(props.m_audioClip);
    const resource = revive(props.m_Resource);
    this.clip = clip instanceof AudioClip ? clip : resource instanceof AudioClip ? resource : null;
    this.playOnAwake = props.m_PlayOnAwake === undefined ? true : !!props.m_PlayOnAwake;
    this._volume = props.m_Volume === undefined ? 1 : props.m_Volume;
    this._pitch = props.m_Pitch === undefined ? 1 : props.m_Pitch;
    this._loop = !!props.Loop;
    this._mute = !!props.Mute;
  }

  _voice(clip, position, oneShot, volumeScale) {
    const voice = { source: this, clip, position, oneShot, volumeScale, ended: false, started: false, node: null, gain: null };
    this._voices.add(voice);
    AudioSystem.voices.add(voice);
    clip._decode();
    audioVoiceStart(voice);
    return voice;
  }

  OnEnable() {
    if (this.playOnAwake && this.clip) this.Play();
  }

  OnDisable() {
    this.Stop();
  }

  Play() {
    this._start(0);
  }

  PlayDelayed(delay) {
    this._start(Math.max(0, Number(delay) || 0));
  }

  _start(delay) {
    if (!this.clip || !this.isActiveAndEnabled) return;
    if (this._main) audioVoiceRemove(this._main);
    this._paused = false;
    for (const voice of this._voices) audioVoiceStart(voice);
    const from = delay > 0 ? -delay : Math.min(this._seek, this.clip.length);
    this._seek = 0;
    this._main = this._voice(this.clip, from, false, 1);
  }

  PlayOneShot(clip, volumeScale = 1) {
    if (!clip || !this.isActiveAndEnabled) return;
    this._voice(clip, 0, true, volumeScale);
  }

  Stop() {
    for (const voice of Array.from(this._voices)) audioVoiceRemove(voice);
    this._paused = false;
    this._seek = 0;
  }

  Pause() {
    if (this._paused) return;
    this._paused = true;
    for (const voice of this._voices) audioVoiceDrop(voice);
  }

  UnPause() {
    if (!this._paused) return;
    this._paused = false;
    for (const voice of this._voices) audioVoiceStart(voice);
  }
}

registerAssetTable('audio', (row) => new AudioClip(row));
registerComponentType('UnityEngine.AudioSource', AudioSource);
registerComponentType('UnityEngine.AudioListener', AudioListener);
Playable.audio = AudioSystem;
