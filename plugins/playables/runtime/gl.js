import { Vector3, Color, Mathf, Screen } from './core.js';
import { UnityObject, Component, Behaviour, Engine, FindObjectsOfType, m4Mul, m4Invert, m4Point, m4TRS } from './object.js';
import { Camera, Renderer, registerComponentType } from './components.js';
import { Assets, registerAssetTable } from './scene.js';
import { CanvasRenderer2D } from './render.js';
import { Playable } from './playable.js';

export class Bounds {
  constructor(center = new Vector3(), size = new Vector3()) {
    this.center = Vector3.From(center);
    this.extents = Vector3.From(size).mul(0.5);
  }
  get size() {
    return this.extents.mul(2);
  }
  get min() {
    return this.center.sub(this.extents);
  }
  get max() {
    return this.center.add(this.extents);
  }
  Contains(point) {
    const d = Vector3.From(point).sub(this.center);
    return Math.abs(d.x) <= this.extents.x && Math.abs(d.y) <= this.extents.y && Math.abs(d.z) <= this.extents.z;
  }
  Intersects(other) {
    const d = other.center.sub(this.center);
    return Math.abs(d.x) <= this.extents.x + other.extents.x && Math.abs(d.y) <= this.extents.y + other.extents.y && Math.abs(d.z) <= this.extents.z + other.extents.z;
  }
  clone() {
    return new Bounds(this.center, this.size);
  }
}

export function WorldBounds(matrix, center, extents) {
  const c = m4Point(matrix, center.x, center.y, center.z);
  const e = new Vector3();
  const axes = ['x', 'y', 'z'];
  for (let row = 0; row < 3; row++) {
    e[axes[row]] = Math.abs(matrix[row]) * extents.x + Math.abs(matrix[4 + row]) * extents.y + Math.abs(matrix[8 + row]) * extents.z;
  }
  return new Bounds(c, e.mul(2));
}

export class Ray {
  constructor(origin, direction) {
    this.origin = Vector3.From(origin);
    this.direction = Vector3.From(direction).normalized;
  }
  GetPoint(distance) {
    return this.origin.add(this.direction.mul(distance));
  }
}

function decodeMeshFile(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x48534d50) throw new Error('not a playable mesh');
  const flags = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const boneCount = view.getUint32(20, true);
  const box = [];
  for (let i = 0; i < 6; i++) box.push(view.getFloat32(24 + i * 4, true));
  let offset = 48;
  const take = (Type, length) => {
    const size = Type.BYTES_PER_ELEMENT * length;
    const start = bytes.byteOffset + offset;
    offset += size;
    return new Type(bytes.buffer.slice(start, start + size));
  };
  const counts = take(Uint32Array, view.getUint32(16, true));
  let positions;
  let normals = null;
  let uvs = null;
  if (flags & 8) {
    const packed = take(Uint16Array, count * 3);
    positions = new Float32Array(count * 3);
    for (let i = 0; i < packed.length; i++) positions[i] = box[i % 3] + (packed[i] / 32767.5 - 1) * box[3 + (i % 3)];
    if (flags & 1) {
      const small = take(Int8Array, count * 3);
      normals = new Float32Array(count * 3);
      for (let i = 0; i < small.length; i++) normals[i] = small[i] / 127;
    }
    if (flags & 2) {
      const range = take(Float32Array, 4);
      const small = take(Uint16Array, count * 2);
      uvs = new Float32Array(count * 2);
      for (let i = 0; i < small.length; i++) uvs[i] = range[i % 2] + (small[i] / 65535) * range[2 + (i % 2)];
    }
  } else {
    positions = take(Float32Array, count * 3);
    if (flags & 1) normals = take(Float32Array, count * 3);
    if (flags & 2) uvs = take(Float32Array, count * 2);
  }
  const skin = flags & 4 ? { joints: take(Uint8Array, count * 4), weights: take(Uint8Array, count * 4), bindposes: take(Float32Array, boneCount * 16) } : null;
  const indices = take(flags & 16 ? Uint32Array : Uint16Array, indexCount);
  const submeshes = [];
  let start = 0;
  for (const length of counts) {
    submeshes.push({ start, count: length });
    start += length;
  }
  return { count, positions, normals, uvs, skin, indices, submeshes, center: new Vector3(box[0], box[1], box[2]), extents: new Vector3(box[3], box[4], box[5]) };
}

export class Mesh extends UnityObject {
  constructor(row) {
    super();
    this._name = row ? row.name : '';
    this.file = row ? row.file : null;
    this._data = null;
    this._buffers = null;
  }
  _decoded() {
    if (!this._data) {
      const bytes = this.file ? Assets.bytes(this.file) : null;
      this._data = bytes
        ? decodeMeshFile(bytes)
        : { count: 0, positions: new Float32Array(0), normals: null, uvs: null, skin: null, indices: new Uint16Array(0), submeshes: [], center: new Vector3(), extents: new Vector3() };
    }
    return this._data;
  }
  get vertexCount() {
    return this._decoded().count;
  }
  get subMeshCount() {
    return this._decoded().submeshes.length;
  }
  get vertices() {
    const positions = this._decoded().positions;
    const list = [];
    for (let i = 0; i < positions.length; i += 3) list.push(new Vector3(positions[i], positions[i + 1], positions[i + 2]));
    return list;
  }
  get triangles() {
    return Array.from(this._decoded().indices);
  }
  get bounds() {
    const data = this._decoded();
    return new Bounds(data.center, data.extents.mul(2));
  }
}

const glImages = new Map();

export class Texture2D extends UnityObject {
  constructor(row) {
    super();
    this._name = row.name;
    this.file = row.file;
    this.width = row.width;
    this.height = row.height;
    this.repeat = row.repeat !== false;
    this.point = !!row.point;
    this._texture = null;
  }
}

export class Shader extends UnityObject {
  constructor(name) {
    super();
    this._name = name;
  }
  static Find(name) {
    return new Shader(name);
  }
}

const colorNames = { _Color: 'color', _BaseColor: 'color', _TintColor: 'color', _EmissionColor: 'emission' };
const floatNames = { _Cutoff: 'cutoff', _Glossiness: 'gloss', _Smoothness: 'gloss' };

export class Material extends UnityObject {
  constructor(source) {
    super();
    const from = source || {};
    this._name = from.name || from._name || '';
    this.shader = from.shader instanceof Shader ? from.shader : new Shader(from.shader || 'Standard');
    this._color = from.color ? from.color.clone() : from._color ? from._color.clone() : new Color(1, 1, 1, 1);
    this.mainTexture = from.texture || from.mainTexture || null;
    this.st = from.st ? from.st.clone() : null;
    this.mode = from.mode || 0;
    this.cutoff = from.cutoff === undefined ? 0.5 : from.cutoff;
    this.unlit = !!from.unlit;
    this.doubleSided = !!from.doubleSided;
    this.gloss = from.gloss || 0;
    this.emission = from.emission ? from.emission.clone() : null;
    this.renderQueue = from.queue || from.renderQueue || 2000;
  }
  get color() {
    return this._color.clone();
  }
  set color(value) {
    this._color = new Color(value.r, value.g, value.b, value.a);
  }
  copy() {
    return new Material(this);
  }
  HasProperty(name) {
    return name in colorNames || name in floatNames || name === '_MainTex' || name === '_BaseMap';
  }
  GetColor(name) {
    const value = this[colorNames[name] === 'color' ? '_color' : colorNames[name]];
    return value ? value.clone() : new Color(0, 0, 0, 1);
  }
  SetColor(name, value) {
    const key = colorNames[name];
    if (key) this[key === 'color' ? '_color' : key] = new Color(value.r, value.g, value.b, value.a);
  }
  GetFloat(name) {
    return floatNames[name] ? this[floatNames[name]] : 0;
  }
  SetFloat(name, value) {
    if (floatNames[name]) this[floatNames[name]] = value;
  }
  GetTexture() {
    return this.mainTexture;
  }
  SetTexture(name, value) {
    this.mainTexture = value;
  }
}

registerAssetTable('meshes', (row) => new Mesh(row));
registerAssetTable('textures', (row) => new Texture2D(row));
registerAssetTable('materials', (row, index, revive) => new Material({ ...row, color: revive(row.color), texture: revive(row.texture), st: revive(row.st), emission: revive(row.emission) }));

export class MeshFilter extends Component {
  constructor() {
    super();
    this.sharedMesh = null;
  }
  static fields = ['sharedMesh'];
  get mesh() {
    return this.sharedMesh;
  }
  set mesh(value) {
    this.sharedMesh = value;
  }
  _load(props, revive) {
    this.sharedMesh = revive(props.m_Mesh);
  }
}

export class MeshRenderer extends Renderer {
  constructor() {
    super();
    this.sharedMaterials = [];
    this._own = false;
  }
  static fields = ['enabled', 'sharedMaterials'];
  static animated = { m_Enabled: 'enabled' };
  _load(props, revive, data) {
    this.enabled = data.enabled !== false;
    this.sharedMaterials = (props.m_Materials || []).map((material) => revive(material));
  }
  get sharedMaterial() {
    return this.sharedMaterials[0] || null;
  }
  set sharedMaterial(value) {
    this.sharedMaterials[0] = value;
  }
  get materials() {
    if (!this._own) {
      this.sharedMaterials = this.sharedMaterials.map((material) => (material ? material.copy() : material));
      this._own = true;
    }
    return this.sharedMaterials;
  }
  set materials(value) {
    this.sharedMaterials = value.slice();
    this._own = true;
  }
  get material() {
    return this.materials[0] || null;
  }
  set material(value) {
    this.sharedMaterials[0] = value;
  }
  _mesh() {
    const filter = this.gameObject.GetComponent(MeshFilter);
    return filter ? filter.sharedMesh : null;
  }
  get bounds() {
    const mesh = this._mesh();
    if (!mesh) return new Bounds(this.transform.position, new Vector3());
    const data = mesh._decoded();
    return WorldBounds(this.transform._world4(), data.center, data.extents);
  }
}

export class SkinnedMeshRenderer extends MeshRenderer {
  constructor() {
    super();
    this.sharedMesh = null;
    this.bones = [];
    this.rootBone = null;
    this._skin = null;
  }
  static fields = ['enabled', 'sharedMaterials', 'sharedMesh', 'bones', 'rootBone'];
  _load(props, revive, data) {
    super._load(props, revive, data);
    this.sharedMesh = revive(props.m_Mesh);
    this.bones = (props.m_Bones || []).map((bone) => revive(bone));
    this.rootBone = revive(props.m_RootBone);
  }
  _mesh() {
    return this.sharedMesh;
  }
  _skinned() {
    const data = this.sharedMesh._decoded();
    const skin = data.skin;
    if (!skin) return null;
    const count = data.count;
    if (!this._skin || this._skin.positions.length !== count * 3) this._skin = { positions: new Float32Array(count * 3), normals: new Float32Array(count * 3) };
    const boneCount = skin.bindposes.length / 16;
    const matrices = [];
    for (let i = 0; i < boneCount; i++) {
      const bone = this.bones[i];
      matrices.push(bone && !bone._destroyed ? m4Mul(bone._world4(), skin.bindposes.subarray(i * 16, i * 16 + 16)) : null);
    }
    const m = new Float64Array(12);
    const out = this._skin;
    for (let v = 0; v < count; v++) {
      m.fill(0);
      for (let k = 0; k < 4; k++) {
        const weight = skin.weights[v * 4 + k] / 255;
        const matrix = weight > 0 ? matrices[skin.joints[v * 4 + k]] : null;
        if (!matrix) continue;
        for (let c = 0; c < 4; c++) {
          m[c * 3] += matrix[c * 4] * weight;
          m[c * 3 + 1] += matrix[c * 4 + 1] * weight;
          m[c * 3 + 2] += matrix[c * 4 + 2] * weight;
        }
      }
      const p = v * 3;
      const x = data.positions[p];
      const y = data.positions[p + 1];
      const z = data.positions[p + 2];
      out.positions[p] = m[0] * x + m[3] * y + m[6] * z + m[9];
      out.positions[p + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
      out.positions[p + 2] = m[2] * x + m[5] * y + m[8] * z + m[11];
      if (data.normals) {
        const nx = data.normals[p];
        const ny = data.normals[p + 1];
        const nz = data.normals[p + 2];
        out.normals[p] = m[0] * nx + m[3] * ny + m[6] * nz;
        out.normals[p + 1] = m[1] * nx + m[4] * ny + m[7] * nz;
        out.normals[p + 2] = m[2] * nx + m[5] * ny + m[8] * nz;
      }
    }
    return out;
  }
}

export class Light extends Behaviour {
  constructor() {
    super();
    this.type = 1;
    this.color = new Color(1, 1, 1, 1);
    this.intensity = 1;
  }
  static fields = ['type', 'color', 'intensity'];
  _load(props, revive) {
    this.type = props.m_Type;
    if (props.m_Color) this.color = revive(props.m_Color);
    this.intensity = props.m_Intensity === undefined ? 1 : props.m_Intensity;
  }
}

Camera.prototype._basis = function () {
  const transform = this.transform;
  const rotation = transform.rotation;
  return { position: transform.position, right: rotation.mul(Vector3.right), up: rotation.mul(Vector3.up), forward: rotation.mul(Vector3.forward) };
};

Camera.prototype._half = function (depth) {
  const height = this.orthographic ? this.orthographicSize : depth * Math.tan((this.fieldOfView * Mathf.Deg2Rad) / 2);
  return [height * this.aspect, height];
};

Camera.prototype.WorldToViewportPoint = function (point) {
  const basis = this._basis();
  const d = Vector3.From(point).sub(basis.position);
  const z = Vector3.Dot(d, basis.forward);
  const half = this._half(z);
  return new Vector3(Vector3.Dot(d, basis.right) / half[0] / 2 + 0.5, Vector3.Dot(d, basis.up) / half[1] / 2 + 0.5, z);
};

Camera.prototype.ViewportToWorldPoint = function (point) {
  const basis = this._basis();
  const z = point.z || 0;
  const half = this._half(z);
  return basis.position
    .add(basis.right.mul((point.x - 0.5) * 2 * half[0]))
    .add(basis.up.mul((point.y - 0.5) * 2 * half[1]))
    .add(basis.forward.mul(z));
};

Camera.prototype.WorldToScreenPoint = function (point) {
  const viewport = this.WorldToViewportPoint(point);
  return new Vector3(viewport.x * Screen.width, viewport.y * Screen.height, viewport.z);
};

Camera.prototype.ScreenToWorldPoint = function (point) {
  return this.ViewportToWorldPoint(new Vector3(point.x / Screen.width, point.y / Screen.height, point.z || 0));
};

Camera.prototype.ScreenToViewportPoint = function (point) {
  return new Vector3(point.x / Screen.width, point.y / Screen.height, point.z || 0);
};

Camera.prototype.ViewportToScreenPoint = function (point) {
  return new Vector3(point.x * Screen.width, point.y * Screen.height, point.z || 0);
};

Camera.prototype.ViewportPointToRay = function (point) {
  const origin = this.ViewportToWorldPoint(new Vector3(point.x, point.y, this.nearClipPlane));
  return new Ray(origin, this.orthographic ? this.transform.forward : origin.sub(this.transform.position));
};

Camera.prototype.ScreenPointToRay = function (point) {
  return this.ViewportPointToRay(new Vector3(point.x / Screen.width, point.y / Screen.height, 0));
};

const glVertex = `attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat4 uModel;
uniform mat3 uNormal;
uniform vec4 uSt;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vWorld = (uModel * vec4(aPos, 1.0)).xyz;
  vNormal = uNormal * aNormal;
  vUv = aUv * uSt.xy + uSt.zw;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const glFragment = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec4 uColor;
uniform vec3 uEmission;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uSky;
uniform vec3 uEquator;
uniform vec3 uGround;
uniform vec3 uEye;
uniform vec4 uFog;
uniform vec3 uFogColor;
uniform vec4 uMode;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorld;
vec3 toLinear(vec3 c) {
  return uMode.w > 0.5 ? pow(c, vec3(2.2)) : c;
}
void main() {
  vec4 c = uColor * texture2D(uTex, vUv);
  if (c.a < uMode.y) discard;
  vec3 rgb = toLinear(c.rgb);
  if (uMode.x < 0.5) {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    float d = max(dot(n, -uLightDir), 0.0);
    vec3 ambient = n.y > 0.0 ? mix(uEquator, uSky, n.y) : mix(uEquator, uGround, -n.y);
    vec3 h = normalize(normalize(uEye - vWorld) - uLightDir);
    rgb = rgb * (toLinear(ambient) + toLinear(uLightColor) * d) + toLinear(uLightColor) * pow(max(dot(n, h), 0.0), 8.0 + uMode.z * 120.0) * uMode.z * 0.4 * step(0.0001, d);
  }
  rgb += toLinear(uEmission);
  if (uMode.w > 0.5) rgb = pow(rgb, vec3(1.0 / 2.2));
  if (uFog.x > 0.5) {
    float z = length(uEye - vWorld);
    float f = uFog.x < 1.5 ? (uFog.w - z) / max(uFog.w - uFog.z, 0.0001) : uFog.x < 2.5 ? exp(-uFog.y * z) : exp(-uFog.y * uFog.y * z * z);
    rgb = mix(uFogColor, rgb, clamp(f, 0.0, 1.0));
  }
  gl_FragColor = vec4(rgb, c.a);
}`;

function cssColor(text) {
  const hex = String(text || '#000').replace('#', '');
  const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
  const value = parseInt(full, 16) || 0;
  return new Color(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1);
}

function asColor(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return new Color(value[0], value[1], value[2], 1);
  return typeof value === 'string' ? cssColor(value) : value;
}

export const Graphics3D = {
  canvas: null,
  gl: null,
  failed: false,
  uniforms: {},
  white: null,
  quad: null,
  backdrop: null,
  drawCalls: 0,
  triangles: 0,

  init(target) {
    const canvas = document.createElement('canvas');
    canvas.id = 'game3d';
    const options = { alpha: false, antialias: true, preserveDrawingBuffer: true };
    const gl = canvas.getContext('webgl2', options) || canvas.getContext('webgl', options);
    if (!gl) {
      this.failed = true;
      console.warn('Playable runtime: WebGL is not available, 3D objects are not drawn');
      return;
    }
    target.parentNode.insertBefore(canvas, target);
    this.canvas = canvas;
    this.gl = gl;
    this.wide = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? true : !!gl.getExtension('OES_element_index_uint');
    this.mips = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, glVertex], [gl.FRAGMENT_SHADER, glFragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.error('Playable runtime: shader ' + gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, 'aPos');
    gl.bindAttribLocation(program, 1, 'aNormal');
    gl.bindAttribLocation(program, 2, 'aUv');
    gl.linkProgram(program);
    gl.useProgram(program);
    for (const name of ['uMvp', 'uModel', 'uNormal', 'uSt', 'uTex', 'uColor', 'uEmission', 'uLightDir', 'uLightColor', 'uSky', 'uEquator', 'uGround', 'uEye', 'uFog', 'uFogColor', 'uMode']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    this.white = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.quad = { position: this.buffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0])), uv: this.buffer(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])) };
    gl.enableVertexAttribArray(0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  },

  buffer(kind, data, usage) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(kind, buffer);
    gl.bufferData(kind, data, usage || gl.STATIC_DRAW);
    return buffer;
  },

  texture(source, repeat, point) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const wrap = repeat && this.mips ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, point ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, point ? gl.NEAREST : this.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (this.mips && !point) gl.generateMipmap(gl.TEXTURE_2D);
    return texture;
  },

  bindTexture(asset) {
    const gl = this.gl;
    let texture = this.white;
    if (asset instanceof Texture2D) {
      if (!asset._texture && glImages.has(asset.file)) asset._texture = this.texture(glImages.get(asset.file), asset.repeat, asset.point);
      if (asset._texture) texture = asset._texture;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
  },

  meshBuffers(mesh) {
    if (mesh._buffers) return mesh._buffers;
    const gl = this.gl;
    const data = mesh._decoded();
    mesh._buffers = {
      position: this.buffer(gl.ARRAY_BUFFER, data.positions),
      normal: data.normals ? this.buffer(gl.ARRAY_BUFFER, data.normals) : null,
      uv: data.uvs ? this.buffer(gl.ARRAY_BUFFER, data.uvs) : null,
      index: this.buffer(gl.ELEMENT_ARRAY_BUFFER, data.indices),
      type: data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      size: data.indices.BYTES_PER_ELEMENT,
    };
    if (mesh._buffers.type === gl.UNSIGNED_INT && !this.wide) console.warn('Playable runtime: mesh ' + mesh._name + ' needs 32 bit indices');
    return mesh._buffers;
  },

  attribute(index, buffer, size, fallback) {
    const gl = this.gl;
    if (!buffer) {
      gl.disableVertexAttribArray(index);
      gl.vertexAttrib3f(index, fallback[0], fallback[1], fallback[2]);
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, 0, 0);
  },

  collect(gameObject, parent, list) {
    if (!gameObject.activeSelf || gameObject._destroyed) return;
    const transform = gameObject.transform;
    const local = transform._local4();
    const world = parent ? m4Mul(parent, local) : local;
    for (const component of gameObject.components) {
      if (component instanceof MeshRenderer && component.enabled && !component._destroyed) list.push({ renderer: component, world });
    }
    for (const child of transform._children) this.collect(child.gameObject, world, list);
  },

  settings() {
    const scene = Assets.row('render', 0) || {};
    const config = (Playable.config && Playable.config.render) || {};
    const flat = asColor(config.ambient, null);
    return {
      sky: flat || scene.sky || new Color(0.4, 0.4, 0.4, 1),
      equator: flat || scene.equator || new Color(0.4, 0.4, 0.4, 1),
      ground: flat || scene.ground || new Color(0.4, 0.4, 0.4, 1),
      linear: config.linear === undefined ? !!scene.linear : !!config.linear,
      fog: config.fog === undefined ? !!scene.fog : !!config.fog,
      fogColor: scene.fogColor || new Color(0.5, 0.5, 0.5, 1),
      fogMode: scene.fogMode || 1,
      fogDensity: scene.fogDensity || 0.01,
      fogStart: scene.fogStart || 0,
      fogEnd: scene.fogEnd || 300,
      background: asColor(config.background, null),
      backdrop: config.backdrop === false ? null : scene.backdrop || null,
    };
  },

  render(target, background) {
    if (this.failed) return false;
    if (!this.gl) this.init(target);
    const gl = this.gl;
    if (!gl) return false;
    const canvas = this.canvas;
    if (canvas.width !== target.width || canvas.height !== target.height) {
      canvas.width = target.width;
      canvas.height = target.height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    const settings = this.settings();
    const items = [];
    for (const root of Engine.roots) this.collect(root, null, items);
    const light = FindObjectsOfType(Light).find((candidate) => candidate._enabled && candidate.type === 1);
    const direction = light ? light.transform.forward : new Vector3(0, -1, 0);
    const lightColor = light ? light.color : new Color(0, 0, 0, 1);
    const power = light ? light.intensity : 0;
    const u = this.uniforms;
    gl.uniform3f(u.uLightDir, direction.x, direction.y, direction.z);
    gl.uniform3f(u.uLightColor, lightColor.r * power, lightColor.g * power, lightColor.b * power);
    gl.uniform3f(u.uSky, settings.sky.r, settings.sky.g, settings.sky.b);
    gl.uniform3f(u.uEquator, settings.equator.r, settings.equator.g, settings.equator.b);
    gl.uniform3f(u.uGround, settings.ground.r, settings.ground.g, settings.ground.b);
    gl.uniform3f(u.uFogColor, settings.fogColor.r, settings.fogColor.g, settings.fogColor.b);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    this.drawCalls = 0;
    this.triangles = 0;
    let first = true;
    for (const camera of Camera.all) {
      const flags = camera.clearFlags;
      gl.depthMask(true);
      if (first || flags <= 2) {
        const color = settings.background || (first && flags > 2 ? cssColor(background) : camera.backgroundColor);
        gl.clearColor(color.r, color.g, color.b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (flags === 1 && settings.backdrop && !settings.background) this.drawBackdrop(settings.backdrop);
      } else if (flags === 3) {
        gl.clear(gl.DEPTH_BUFFER_BIT);
      }
      first = false;
      this.drawCamera(camera, items, settings);
    }
    if (first) {
      const color = settings.background || cssColor(background);
      gl.clearColor(color.r, color.g, color.b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    return true;
  },

  drawBackdrop(file) {
    const gl = this.gl;
    const u = this.uniforms;
    if (!this.backdrop && glImages.has(file)) this.backdrop = this.texture(glImages.get(file), false, false);
    if (!this.backdrop) return;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    gl.uniformMatrix4fv(u.uMvp, false, identity);
    gl.uniformMatrix4fv(u.uModel, false, identity);
    gl.uniform4f(u.uSt, 1, 1, 0, 0);
    gl.uniform4f(u.uColor, 1, 1, 1, 1);
    gl.uniform3f(u.uEmission, 0, 0, 0);
    gl.uniform4f(u.uMode, 1, 0, 0, 0);
    gl.uniform4f(u.uFog, 0, 0, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.backdrop);
    this.attribute(0, this.quad.position, 3);
    this.attribute(1, null, 3, [0, 1, 0]);
    this.attribute(2, this.quad.uv, 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);
  },

  drawCamera(camera, items, settings) {
    const gl = this.gl;
    const u = this.uniforms;
    const transform = camera.transform;
    const eye = transform.position;
    const view = m4Invert(m4TRS(eye.x, eye.y, eye.z, transform.rotation, new Vector3(1, 1, 1)));
    for (let column = 0; column < 4; column++) view[column * 4 + 2] *= -1;
    const near = camera.nearClipPlane;
    const far = camera.farClipPlane;
    const aspect = this.canvas.width / this.canvas.height;
    let projection;
    if (camera.orthographic) {
      const size = camera.orthographicSize;
      projection = [1 / (size * aspect), 0, 0, 0, 0, 1 / size, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1];
    } else {
      const f = 1 / Math.tan((camera.fieldOfView * Mathf.Deg2Rad) / 2);
      projection = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
    }
    const viewProjection = m4Mul(projection, view);
    gl.uniform3f(u.uEye, eye.x, eye.y, eye.z);
    gl.uniform4f(u.uFog, settings.fog ? settings.fogMode : 0, settings.fogDensity, settings.fogStart, settings.fogEnd);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    const forward = transform.forward;
    const draws = [];
    for (const item of items) {
      const renderer = item.renderer;
      if (((camera.cullingMask >>> renderer.gameObject.layer) & 1) === 0) continue;
      const mesh = renderer._mesh();
      if (!mesh) continue;
      const data = mesh._decoded();
      const skinned = renderer instanceof SkinnedMeshRenderer && data.skin ? renderer._skinned() : null;
      const world = skinned ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : item.world;
      const depth = (item.world[12] - eye.x) * forward.x + (item.world[13] - eye.y) * forward.y + (item.world[14] - eye.z) * forward.z;
      for (let s = 0; s < data.submeshes.length; s++) {
        const material = renderer.sharedMaterials[Math.min(s, renderer.sharedMaterials.length - 1)];
        if (!material || data.submeshes[s].count === 0) continue;
        draws.push({ mesh, data, skinned, world, depth, material, submesh: data.submeshes[s], blend: material.mode === 2 });
      }
    }
    draws.sort((a, b) => (a.blend === b.blend ? (a.blend ? b.depth - a.depth : a.material.renderQueue - b.material.renderQueue) : a.blend ? 1 : -1));
    let bound = null;
    for (const draw of draws) {
      const material = draw.material;
      const world = draw.world;
      const inverse = m4Invert(world);
      const determinant = world[0] * (world[5] * world[10] - world[6] * world[9]) - world[4] * (world[1] * world[10] - world[2] * world[9]) + world[8] * (world[1] * world[6] - world[2] * world[5]);
      gl.uniformMatrix4fv(u.uMvp, false, m4Mul(viewProjection, world));
      gl.uniformMatrix4fv(u.uModel, false, world);
      gl.uniformMatrix3fv(u.uNormal, false, [inverse[0], inverse[4], inverse[8], inverse[1], inverse[5], inverse[9], inverse[2], inverse[6], inverse[10]]);
      const color = material._color;
      const st = material.st;
      gl.uniform4f(u.uColor, color.r, color.g, color.b, material.mode === 2 ? color.a : 1);
      gl.uniform4f(u.uSt, st ? st.x : 1, st ? st.y : 1, st ? st.z : 0, st ? st.w : 0);
      const emission = material.emission;
      gl.uniform3f(u.uEmission, emission ? emission.r : 0, emission ? emission.g : 0, emission ? emission.b : 0);
      gl.uniform4f(u.uMode, material.unlit ? 1 : 0, material.mode === 1 ? material.cutoff : 0, material.gloss, settings.linear ? 1 : 0);
      if (material.doubleSided) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);
      gl.frontFace(determinant < 0 ? gl.CCW : gl.CW);
      if (draw.blend) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      this.bindTexture(material.mainTexture);
      const buffers = this.meshBuffers(draw.mesh);
      if (draw.skinned) {
        if (!buffers.skinPosition) {
          buffers.skinPosition = gl.createBuffer();
          buffers.skinNormal = gl.createBuffer();
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.skinPosition);
        gl.bufferData(gl.ARRAY_BUFFER, draw.skinned.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.skinNormal);
        gl.bufferData(gl.ARRAY_BUFFER, draw.skinned.normals, gl.DYNAMIC_DRAW);
        this.attribute(0, buffers.skinPosition, 3);
        this.attribute(1, draw.data.normals ? buffers.skinNormal : null, 3, [0, 1, 0]);
        this.attribute(2, buffers.uv, 2, [0, 0, 0]);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
        bound = null;
      } else if (bound !== buffers) {
        this.attribute(0, buffers.position, 3);
        this.attribute(1, buffers.normal, 3, [0, 1, 0]);
        this.attribute(2, buffers.uv, 2, [0, 0, 0]);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
        bound = buffers;
      }
      gl.drawElements(gl.TRIANGLES, draw.submesh.count, buffers.type, draw.submesh.start * buffers.size);
      this.drawCalls++;
      this.triangles += draw.submesh.count / 3;
    }
    gl.depthMask(true);
  },
};

CanvasRenderer2D.under = Graphics3D;

Playable.preloads.push(async (payload) => {
  const tables = payload.data.tables || {};
  const files = (tables.textures || []).map((row) => row.file);
  const scene = (tables.render || [])[0];
  if (scene && scene.backdrop) files.push(scene.backdrop);
  await Promise.all(
    files.map(async (file) => {
      const url = (payload.files || {})[file];
      if (!url) return;
      const image = document.createElement('img');
      image.src = url;
      try {
        await image.decode();
        glImages.set(file, image);
      } catch (error) {
        console.warn('Playable runtime: texture ' + file + ' failed to decode');
      }
    })
  );
});

registerComponentType('UnityEngine.MeshFilter', MeshFilter);
registerComponentType('UnityEngine.MeshRenderer', MeshRenderer);
registerComponentType('UnityEngine.SkinnedMeshRenderer', SkinnedMeshRenderer);
registerComponentType('UnityEngine.Light', Light);
