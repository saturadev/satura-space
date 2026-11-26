const oggCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ oggCrcTable[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc;
}

function oggPage(packets, granule, serial, sequence, flags) {
  const lacing = [];
  let size = 0;
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) {
      lacing.push(255);
      left -= 255;
    }
    lacing.push(left);
    size += packet.length;
  }
  const page = new Uint8Array(27 + lacing.length + size);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
  view.setUint32(6, granule % 0x100000000, true);
  view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(channels, preSkip, inputRate) {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}

function opusTags(vendor) {
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);
  view.setUint32(8, vendor.length, true);
  for (let i = 0; i < vendor.length; i++) tags[12 + i] = vendor.charCodeAt(i);
  view.setUint32(12 + vendor.length, 0, true);
  return tags;
}

function opusPacketSamples(packet) {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frame;
  if (config < 12) frame = [480, 960, 1920, 2880][config & 3];
  else if (config < 16) frame = [480, 960][config & 1];
  else frame = [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (packet.length > 1 ? packet[1] & 63 : 0) : 2;
  return frame * count;
}

function oggOpus(packets, channels, preSkip, inputRate, totalSamples) {
  const serial = 0x70617564;
  const pages = [oggPage([opusHead(channels, preSkip, inputRate)], 0, serial, 0, 2), oggPage([opusTags('playables')], 0, serial, 1, 0)];
  const end = preSkip + totalSamples;
  let sequence = 2;
  let granule = 0;
  let group = [];
  let segments = 0;
  let span = 0;
  const flush = (last) => {
    if (group.length === 0) return;
    pages.push(oggPage(group, last ? Math.min(granule, end) : granule, serial, sequence++, last ? 4 : 0));
    group = [];
    segments = 0;
    span = 0;
  };
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i];
    const needed = Math.floor(packet.length / 255) + 1;
    if (segments + needed > 255 || span >= 48000) flush(false);
    group.push(packet);
    segments += needed;
    const samples = opusPacketSamples(packet);
    span += samples;
    granule += samples;
    if (granule >= end) break;
  }
  flush(true);
  let size = 0;
  for (const page of pages) size += page.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }
  return out;
}

async function encodeOpus(channels, frames, sampleRate, bitrate) {
  if (typeof AudioEncoder !== 'function' || typeof AudioData !== 'function') throw new Error('no AudioEncoder');
  const numberOfChannels = channels.length;
  const config = { codec: 'opus', sampleRate, numberOfChannels, bitrate, opus: { format: 'opus', frameDuration: 20000, complexity: 10 } };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('Opus encoding is not supported here');
  const packets = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes);
      const d = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
      if (d && !description) description = new Uint8Array(d instanceof ArrayBuffer ? d.slice(0) : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(config);
  const frame = sampleRate / 50;
  const padded = Math.ceil((frames + frame) / frame) * frame + frame;
  const block = frame * 50;
  for (let start = 0; start < padded && !failure; start += block) {
    const count = Math.min(block, padded - start);
    const data = new Float32Array(count * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) {
      const from = channels[c].subarray(Math.min(start, frames), Math.min(start + count, frames));
      data.set(from, c * count);
    }
    const audio = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: count, numberOfChannels, timestamp: Math.round((start / sampleRate) * 1e6), data });
    encoder.encode(audio);
    audio.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (packets.length === 0) throw new Error('the Opus encoder produced no packets');
  let preSkip = 312;
  if (description && description.length >= 19 && String.fromCharCode.apply(null, description.subarray(0, 8)) === 'OpusHead') {
    const reported = description[10] | (description[11] << 8);
    const atInputRate = sampleRate !== 48000 && Math.abs(reported - 0.0065 * sampleRate) <= 2;
    if (reported > 0) preSkip = atInputRate ? Math.round((reported * 48000) / sampleRate) : reported;
  }
  return oggOpus(packets, numberOfChannels, preSkip, sampleRate, Math.round((frames * 48000) / sampleRate));
}

function wavPcm(samples, sampleRate, bits) {
  const width = bits / 8;
  const out = new Uint8Array(44 + samples.length * width);
  const view = new DataView(out.buffer);
  const tag = (offset, text) => {
    for (let i = 0; i < 4; i++) out[offset + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * width, true);
  view.setUint16(32, width, true);
  view.setUint16(34, bits, true);
  tag(36, 'data');
  view.setUint32(40, samples.length * width, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    if (bits === 8) out[44 + i] = Math.round((s + 1) * 127.5);
    else view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}

async function decodeAudio(bytes, sampleRate) {
  const context = new OfflineAudioContext(1, 1, sampleRate);
  return context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

tools.audio = async ({ data, name, config }) => {
  const options = (config && config.audio) || {};
  const input = unb64(data);
  const bitrate = Math.max(6, Math.min(256, Number(options.bitrate) || 32));
  const wanted = Number(options.sampleRate) || 24000;
  const sampleRate = [8000, 12000, 16000, 24000, 48000].reduce((best, rate) => (Math.abs(rate - wanted) < Math.abs(best - wanted) ? rate : best), 48000);
  const mono = options.mono !== false;
  const maxSeconds = options.maxSeconds === undefined ? 30 : Number(options.maxSeconds);
  let decoded;
  try {
    decoded = await decodeAudio(input, sampleRate);
  } catch (error) {
    return null;
  }
  const sourceSeconds = decoded.duration;
  let frames = decoded.length;
  const trimmed = maxSeconds > 0 && frames > Math.round(maxSeconds * sampleRate);
  if (trimmed) frames = Math.round(maxSeconds * sampleRate);
  let channels = [];
  for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) channels.push(decoded.getChannelData(c).slice(0, frames));
  if (mono && channels.length > 1) {
    const mix = new Float32Array(frames);
    for (let i = 0; i < frames; i++) mix[i] = (channels[0][i] + channels[1][i]) * 0.5;
    channels = [mix];
  }
  if (trimmed) {
    const fade = Math.min(frames, Math.round(sampleRate * 0.02));
    for (const channel of channels) for (let i = 0; i < fade; i++) channel[frames - 1 - i] *= i / fade;
  }
  const seconds = frames / sampleRate;
  const shape = `${channels.length === 1 ? 'mono' : 'stereo'} ${seconds.toFixed(2)}s${trimmed ? ` (trimmed from ${sourceSeconds.toFixed(2)}s)` : ''}`;
  let problem = '';
  try {
    const ogg = await encodeOpus(channels, frames, sampleRate, bitrate * 1000);
    const check = await decodeAudio(ogg, 48000);
    const drift = Math.abs(check.duration - seconds);
    if (drift > 0.005) throw new Error(`the encoded file decodes to ${check.duration.toFixed(3)}s instead of ${seconds.toFixed(3)}s`);
    if (ogg.length >= input.length && !trimmed) return null;
    return { data: b64(ogg), mime: 'audio/ogg', note: `ogg opus ${bitrate} kbps ${sampleRate} Hz ${shape}, ${input.length} -> ${ogg.length} bytes, decodes to ${check.duration.toFixed(3)}s` };
  } catch (error) {
    problem = String((error && error.message) || error);
  }
  const lowRate = Math.min(sampleRate, Number(options.fallbackRate) || 11025);
  const low = await decodeAudio(input, lowRate);
  const lowFrames = Math.min(low.length, Math.round(seconds * lowRate));
  const mix = new Float32Array(lowFrames);
  const count = Math.min(2, low.numberOfChannels);
  for (let c = 0; c < count; c++) {
    const channel = low.getChannelData(c);
    for (let i = 0; i < lowFrames; i++) mix[i] += channel[i] / count;
  }
  const bits = Number(options.fallbackBits) === 8 ? 8 : 16;
  const wav = wavPcm(mix, lowRate, bits);
  if (wav.length >= input.length && !trimmed) return null;
  return { data: b64(wav), mime: 'audio/wav', note: `wav pcm ${bits}-bit ${lowRate} Hz mono ${(lowFrames / lowRate).toFixed(2)}s, ${input.length} -> ${wav.length} bytes, Opus was not possible for ${name}: ${problem}` };
};
