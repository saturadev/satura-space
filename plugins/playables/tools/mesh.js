const meshTool = {
  read(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0x48534d50) return null;
    const flags = view.getUint32(4, true);
    if (flags & 8) return null;
    const count = view.getUint32(8, true);
    const indexCount = view.getUint32(12, true);
    const boneCount = view.getUint32(20, true);
    let offset = 48;
    const take = (Type, length) => {
      const size = Type.BYTES_PER_ELEMENT * length;
      const start = bytes.byteOffset + offset;
      offset += size;
      return new Type(bytes.buffer.slice(start, start + size));
    };
    const counts = take(Uint32Array, view.getUint32(16, true));
    const mesh = { count, counts: Array.from(counts), positions: take(Float32Array, count * 3), normals: null, uvs: null, joints: null, weights: null, bindposes: null };
    if (flags & 1) mesh.normals = take(Float32Array, count * 3);
    if (flags & 2) mesh.uvs = take(Float32Array, count * 2);
    if (flags & 4) {
      mesh.joints = take(Uint8Array, count * 4);
      mesh.weights = take(Uint8Array, count * 4);
      mesh.bindposes = take(Float32Array, boneCount * 16);
    }
    mesh.indices = Array.from(take(flags & 16 ? Uint32Array : Uint16Array, indexCount));
    return mesh;
  },

  write(mesh, quantize) {
    const count = mesh.count;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count * 3; i++) {
      min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
      max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
    }
    const center = min.map((value, axis) => (count ? (value + max[axis]) / 2 : 0));
    const extents = min.map((value, axis) => (count ? (max[axis] - value) / 2 : 0));
    const wide = count > 65535;
    const flags = (mesh.normals ? 1 : 0) | (mesh.uvs ? 2 : 0) | (mesh.joints ? 4 : 0) | (quantize ? 8 : 0) | (wide ? 16 : 0);
    const parts = [];
    const head = new DataView(new ArrayBuffer(48));
    [0x48534d50, flags, count, mesh.indices.length, mesh.counts.length, mesh.bindposes ? mesh.bindposes.length / 16 : 0].forEach((value, i) => head.setUint32(i * 4, value, true));
    center.concat(extents).forEach((value, i) => head.setFloat32(24 + i * 4, value, true));
    parts.push(new Uint8Array(head.buffer), new Uint32Array(mesh.counts));
    if (quantize) {
      const stored = Array.from(new Float32Array(center.concat(extents)));
      const packed = new Uint16Array(count * 3);
      for (let i = 0; i < count * 3; i++) {
        const extent = stored[3 + (i % 3)];
        packed[i] = extent > 0 ? Math.max(0, Math.min(65535, Math.round(((mesh.positions[i] - stored[i % 3]) / extent + 1) * 32767.5))) : 32768;
      }
      parts.push(packed);
      if (mesh.normals) {
        const small = new Int8Array(count * 3);
        for (let i = 0; i < count * 3; i++) small[i] = Math.max(-127, Math.min(127, Math.round(mesh.normals[i] * 127)));
        parts.push(small);
      }
      if (mesh.uvs) {
        const low = [Infinity, Infinity];
        const high = [-Infinity, -Infinity];
        for (let i = 0; i < count * 2; i++) {
          low[i % 2] = Math.min(low[i % 2], mesh.uvs[i]);
          high[i % 2] = Math.max(high[i % 2], mesh.uvs[i]);
        }
        const range = new Float32Array([count ? low[0] : 0, count ? low[1] : 0, count ? high[0] - low[0] : 0, count ? high[1] - low[1] : 0]);
        const small = new Uint16Array(count * 2);
        for (let i = 0; i < count * 2; i++) small[i] = range[2 + (i % 2)] > 0 ? Math.max(0, Math.min(65535, Math.round(((mesh.uvs[i] - range[i % 2]) / range[2 + (i % 2)]) * 65535))) : 0;
        parts.push(range, small);
      }
    } else {
      parts.push(mesh.positions);
      if (mesh.normals) parts.push(mesh.normals);
      if (mesh.uvs) parts.push(mesh.uvs);
    }
    if (mesh.joints) parts.push(mesh.joints, mesh.weights, mesh.bindposes);
    parts.push(wide ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices));
    const total = parts.reduce((n, part) => n + part.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at);
      at += part.byteLength;
    }
    return out;
  },

  decimate(mesh, target) {
    const count = mesh.count;
    const positions = mesh.positions;
    const group = new Int32Array(count);
    const keys = new Map();
    const point = [];
    for (let v = 0; v < count; v++) {
      const key = positions[v * 3] + ',' + positions[v * 3 + 1] + ',' + positions[v * 3 + 2];
      let id = keys.get(key);
      if (id === undefined) {
        id = point.length;
        keys.set(key, id);
        point.push([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
      }
      group[v] = id;
    }
    const groups = point.length;
    const members = Array.from({ length: groups }, () => []);
    for (let v = 0; v < count; v++) members[group[v]].push(v);
    const faces = [];
    let submesh = 0;
    let end = mesh.counts[0] || 0;
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      while (i >= end && submesh < mesh.counts.length - 1) end += mesh.counts[++submesh];
      const corners = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
      const g = corners.map((v) => group[v]);
      if (g[0] === g[1] || g[1] === g[2] || g[0] === g[2]) continue;
      faces.push({ v: corners, submesh, alive: true });
    }
    let alive = faces.length;
    if (alive <= target) return null;
    const quadric = new Float64Array(groups * 10);
    const facesOf = Array.from({ length: groups }, () => []);
    const near = Array.from({ length: groups }, () => new Set());
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const addPlane = (g, n, d, weight) => {
      const q = [n[0] * n[0], n[0] * n[1], n[0] * n[2], n[0] * d, n[1] * n[1], n[1] * n[2], n[1] * d, n[2] * n[2], n[2] * d, d * d];
      for (let i = 0; i < 10; i++) quadric[g * 10 + i] += q[i] * weight;
    };
    const normalOf = (a, b, c) => cross(sub(b, a), sub(c, a));
    const edges = new Map();
    for (const face of faces) {
      const g = face.v.map((v) => group[v]);
      const n = normalOf(point[g[0]], point[g[1]], point[g[2]]);
      const length = Math.hypot(n[0], n[1], n[2]);
      if (length > 0) {
        const unit = n.map((value) => value / length);
        for (const id of g) addPlane(id, unit, -dot(unit, point[g[0]]), length / 2);
      }
      for (let k = 0; k < 3; k++) {
        const a = g[k];
        const b = g[(k + 1) % 3];
        facesOf[a].push(face);
        near[a].add(b);
        near[b].add(a);
        const key = Math.min(a, b) * groups + Math.max(a, b);
        const entry = edges.get(key);
        if (entry) entry.count++;
        else edges.set(key, { a, b, count: 1, normal: n });
      }
    }
    for (const edge of edges.values()) {
      if (edge.count !== 1) continue;
      const along = sub(point[edge.b], point[edge.a]);
      const side = cross(along, edge.normal);
      const length = Math.hypot(side[0], side[1], side[2]);
      if (!(length > 0)) continue;
      const unit = side.map((value) => value / length);
      const weight = dot(along, along) * 10;
      addPlane(edge.a, unit, -dot(unit, point[edge.a]), weight);
      addPlane(edge.b, unit, -dot(unit, point[edge.a]), weight);
    }
    const version = new Int32Array(groups);
    const dead = new Uint8Array(groups);
    const cost = (from, to) => {
      const p = point[to];
      const q = (i) => quadric[from * 10 + i] + quadric[to * 10 + i];
      return q(0) * p[0] * p[0] + 2 * q(1) * p[0] * p[1] + 2 * q(2) * p[0] * p[2] + 2 * q(3) * p[0] + q(4) * p[1] * p[1] + 2 * q(5) * p[1] * p[2] + 2 * q(6) * p[1] + q(7) * p[2] * p[2] + 2 * q(8) * p[2] + q(9);
    };
    const heap = [];
    const push = (entry) => {
      let i = heap.length;
      heap.push(entry);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].cost <= entry.cost) break;
        heap[i] = heap[parent];
        i = parent;
      }
      heap[i] = entry;
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        let i = 0;
        for (;;) {
          let child = i * 2 + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && heap[child + 1].cost < heap[child].cost) child++;
          if (heap[child].cost >= last.cost) break;
          heap[i] = heap[child];
          i = child;
        }
        heap[i] = last;
      }
      return top;
    };
    const bend = (a, b) => {
      if (!mesh.joints) return 0;
      const va = members[a][0];
      const vb = members[b][0];
      const weights = new Map();
      for (let k = 0; k < 4; k++) {
        weights.set(mesh.joints[va * 4 + k], (weights.get(mesh.joints[va * 4 + k]) || 0) + mesh.weights[va * 4 + k]);
        weights.set(mesh.joints[vb * 4 + k], (weights.get(mesh.joints[vb * 4 + k]) || 0) - mesh.weights[vb * 4 + k]);
      }
      let gap = 0;
      for (const value of weights.values()) gap += Math.abs(value) / 255;
      const edge = sub(point[a], point[b]);
      return gap * dot(edge, edge) * dot(edge, edge) * 0.25;
    };
    const offer = (a, b) => {
      const forward = cost(a, b);
      const backward = cost(b, a);
      const from = forward <= backward ? a : b;
      const to = forward <= backward ? b : a;
      push({ cost: Math.abs(Math.min(forward, backward)) + bend(a, b), from, to, vf: version[from], vt: version[to] });
    };
    for (const edge of edges.values()) offer(edge.a, edge.b);
    let guard = heap.length * 40 + 1000;
    while (alive > target && heap.length > 0 && guard-- > 0) {
      const entry = pop();
      const from = entry.from;
      const to = entry.to;
      if (dead[from] || dead[to] || version[from] !== entry.vf || version[to] !== entry.vt) continue;
      let flipped = false;
      let shared = 0;
      for (const face of facesOf[from]) {
        if (!face.alive) continue;
        const g = face.v.map((v) => group[v]);
        if (g.includes(to)) {
          shared++;
          continue;
        }
        const before = normalOf(point[g[0]], point[g[1]], point[g[2]]);
        const moved = g.map((id) => point[id === from ? to : id]);
        const after = normalOf(moved[0], moved[1], moved[2]);
        if (dot(before, after) <= 1e-12 * dot(before, before)) {
          flipped = true;
          break;
        }
      }
      if (flipped || alive - shared < target) continue;
      const remap = new Map();
      for (const face of facesOf[from]) {
        if (!face.alive) continue;
        const moving = face.v.find((v) => group[v] === from);
        const kept = face.v.find((v) => group[v] === to);
        if (kept === undefined) continue;
        face.alive = false;
        alive--;
        if (!remap.has(moving)) remap.set(moving, kept);
      }
      for (const face of facesOf[from]) {
        if (!face.alive) continue;
        for (let k = 0; k < 3; k++) {
          const v = face.v[k];
          if (group[v] !== from) continue;
          if (remap.has(v)) face.v[k] = remap.get(v);
        }
        facesOf[to].push(face);
      }
      for (const v of members[from]) {
        group[v] = to;
        positions[v * 3] = point[to][0];
        positions[v * 3 + 1] = point[to][1];
        positions[v * 3 + 2] = point[to][2];
        members[to].push(v);
      }
      members[from] = [];
      for (let i = 0; i < 10; i++) quadric[to * 10 + i] += quadric[from * 10 + i];
      facesOf[to] = facesOf[to].filter((face) => face.alive);
      facesOf[from] = [];
      dead[from] = 1;
      version[to]++;
      for (const other of near[from]) {
        near[other].delete(from);
        if (other !== to) {
          near[other].add(to);
          near[to].add(other);
        }
      }
      near[to].delete(from);
      near[to].delete(to);
      for (const other of near[to]) {
        if (!dead[other]) offer(to, other);
      }
    }
    const remapVertex = new Int32Array(count).fill(-1);
    const order = [];
    const lists = mesh.counts.map(() => []);
    for (const face of faces) {
      if (!face.alive) continue;
      for (const v of face.v) {
        if (remapVertex[v] < 0) {
          remapVertex[v] = order.length;
          order.push(v);
        }
        lists[face.submesh].push(remapVertex[v]);
      }
    }
    const pick = (source, size, Type) => {
      if (!source) return null;
      const out = new Type(order.length * size);
      order.forEach((v, i) => {
        for (let k = 0; k < size; k++) out[i * size + k] = source[v * size + k];
      });
      return out;
    };
    return {
      count: order.length,
      counts: lists.map((list) => list.length),
      positions: pick(positions, 3, Float32Array),
      normals: pick(mesh.normals, 3, Float32Array),
      uvs: pick(mesh.uvs, 2, Float32Array),
      joints: pick(mesh.joints, 4, Uint8Array),
      weights: pick(mesh.weights, 4, Uint8Array),
      bindposes: mesh.bindposes,
      indices: lists.flat(),
    };
  },
};

tools.mesh = async ({ data, source, config }) => {
  const input = unb64(data);
  const mesh = meshTool.read(input);
  if (!mesh) return null;
  const options = (config && config.meshes) || {};
  const rule = (options.rules || []).find((item) => item && item.path && String(source || '').startsWith(item.path)) || {};
  const ratio = Number(rule.decimate !== undefined ? rule.decimate : options.decimate !== undefined ? options.decimate : 1);
  const floor = Number(options.minTriangles !== undefined ? options.minTriangles : 64);
  const quantize = options.quantize !== false;
  const triangles = Math.floor(mesh.indices.length / 3);
  const notes = [];
  let result = mesh;
  if (ratio > 0 && ratio < 1 && triangles > floor) {
    const reduced = meshTool.decimate(mesh, Math.max(floor, Math.round(triangles * ratio)));
    if (reduced) {
      result = reduced;
      notes.push('decimated ' + triangles + '→' + Math.floor(reduced.indices.length / 3) + ' tris');
    }
  }
  if (quantize) notes.push('quantized');
  if (result === mesh && !quantize) return null;
  const out = meshTool.write(result, quantize);
  if (out.length >= input.length) return null;
  return { data: b64(out), mime: 'application/octet-stream', note: notes.join(', ') };
};
