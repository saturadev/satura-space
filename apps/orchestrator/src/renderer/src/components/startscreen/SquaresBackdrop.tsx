import { useEffect, useRef } from 'react'

const CELL = 3.5
const GAP = 1.5
const STEP = CELL + GAP

const BAND = 0.6
const IDLE_ALPHA = 0.5
const IDLE_MIN = 0.6
const WAVE_ALPHA = 0.14
const NOISE_SCALE = 0.03
const NOISE_SPEED = 0.5
const NOISE_AMOUNT = 0.45
const WAVE_SPEED = 340
const WAVE_WIDTH = 120
const WAVE_LIFE = 2.8

const MOVE_SCALE = 1
const CLICK_SCALE = 2.6
const HOLD_SCALE = 2.2
const HOLD_INTERVAL = 0.16

const MAX_DPR = 1.5
const MAX_CELLS = 120000
const MAX_ALPHA = 0.9
const MAX_WAVES = 160
const WAVE_DEDUP = 42

function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

type Wave = { x: number; y: number; t: number; scale: number }

const VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_pos;
layout(location = 2) in vec4 a_meta;

uniform vec2 u_resolution;
uniform float u_cell;
uniform float u_time;
uniform int u_waveCount;
uniform vec2 u_wavePos[${MAX_WAVES}];
uniform float u_waveT[${MAX_WAVES}];
uniform float u_waveScale[${MAX_WAVES}];
uniform float u_waveSpeed;
uniform float u_waveWidth;
uniform float u_waveLife;
uniform float u_idleAlpha;
uniform float u_idleMin;
uniform float u_waveAlpha;
uniform float u_maxAlpha;

uniform float u_noiseScale;
uniform float u_noiseSpeed;
uniform float u_noiseAmount;

out float v_alpha;

const float HALF_PI = 1.5707963267948966;

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float flow(vec2 p, float t) {
  float n = vnoise(p + vec2(t * 1.3, t * 0.7));
  n += 0.5 * vnoise(p * 2.1 + vec2(-t * 1.7, t * 1.1));
  return n / 1.5;
}

void main() {
  float base = a_meta.x;
  float phase = a_meta.y;
  float speed = a_meta.z;
  float amp = a_meta.w;

  vec2 center = a_pos + vec2(u_cell * 0.5);
  float n = flow(center * u_noiseScale, u_time * u_noiseSpeed);
  float twinkle = 0.8 + 0.2 * sin(u_time * speed + phase);
  float noiseMod = 1.0 - u_noiseAmount + u_noiseAmount * n;
  float idle = max(u_idleMin, u_idleMin + u_idleAlpha * base) * twinkle * noiseMod;

  float wave = 0.0;
  for (int i = 0; i < ${MAX_WAVES}; i++) {
    if (i >= u_waveCount) break;
    float scale = u_waveScale[i];
    float age = u_time - u_waveT[i];
    float radius = age * u_waveSpeed * scale;
    float width = u_waveWidth * scale;
    float life = u_waveLife * scale;
    if (age > life) continue;
    float reach = radius + width;
    vec2 e = center - u_wavePos[i];
    float dist = length(e);
    if (dist > reach) continue;
    float d = abs(dist - radius);
    if (d < width) {
      float fade = 1.0 - age / life;
      float ring = cos((d / width) * HALF_PI);
      wave += ring * ring * fade * scale;
    }
  }

  float alpha = idle + wave * u_waveAlpha * (0.35 + 0.65 * base);
  v_alpha = clamp(alpha * 0.5, 0.0, u_maxAlpha);

  vec2 px = a_pos + a_corner * u_cell;
  vec2 ndc = (px / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`

const FRAG_SRC = `#version 300 es
precision highp float;

uniform vec3 u_color;
in float v_alpha;
out vec4 outColor;

void main() {
  outColor = vec4(u_color, v_alpha);
}
`

const compileShader = (
  gl: WebGL2RenderingContext,
  type: number,
  src: string
): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const createProgram = (gl: WebGL2RenderingContext): WebGLProgram | null => {
  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
  if (!vert || !frag) {
    if (vert) gl.deleteShader(vert)
    if (frag) gl.deleteShader(frag)
    return null
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    return null
  }
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

export function SquaresBackdrop(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false
    })
    if (!gl) return

    const program = createProgram(gl)
    if (!program) {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return
    }

    const uResolution = gl.getUniformLocation(program, 'u_resolution')
    const uCell = gl.getUniformLocation(program, 'u_cell')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uWaveCount = gl.getUniformLocation(program, 'u_waveCount')
    const uWavePos = gl.getUniformLocation(program, 'u_wavePos')
    const uWaveT = gl.getUniformLocation(program, 'u_waveT')
    const uWaveScale = gl.getUniformLocation(program, 'u_waveScale')
    const uWaveSpeed = gl.getUniformLocation(program, 'u_waveSpeed')
    const uWaveWidth = gl.getUniformLocation(program, 'u_waveWidth')
    const uWaveLife = gl.getUniformLocation(program, 'u_waveLife')
    const uIdleAlpha = gl.getUniformLocation(program, 'u_idleAlpha')
    const uIdleMin = gl.getUniformLocation(program, 'u_idleMin')
    const uWaveAlpha = gl.getUniformLocation(program, 'u_waveAlpha')
    const uMaxAlpha = gl.getUniformLocation(program, 'u_maxAlpha')
    const uColor = gl.getUniformLocation(program, 'u_color')
    const color = accentRgb()
    const uNoiseScale = gl.getUniformLocation(program, 'u_noiseScale')
    const uNoiseSpeed = gl.getUniformLocation(program, 'u_noiseSpeed')
    const uNoiseAmount = gl.getUniformLocation(program, 'u_noiseAmount')

    const vao = gl.createVertexArray()
    const cornerBuffer = gl.createBuffer()
    const instanceBuffer = gl.createBuffer()

    const corners = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1])

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    let instanceData = new Float32Array(0)
    let builtW = -1
    let builtH = -1
    let builtDpr = -1
    let buildRaf = 0
    let width = 0
    let height = 0
    let instanceCount = 0
    let step = STEP
    const waves: Wave[] = []
    const wavePos = new Float32Array(MAX_WAVES * 2)
    const waveT = new Float32Array(MAX_WAVES)
    const waveScale = new Float32Array(MAX_WAVES)
    let raf = 0
    let start = -1
    let pressed = false
    let pointerX = 0
    let pointerY = 0
    let nextHoldT = 0

    const build = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      const rect = canvas.getBoundingClientRect()
      if (rect.width === builtW && rect.height === builtH && dpr === builtDpr) return
      builtW = rect.width
      builtH = rect.height
      builtDpr = dpr
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      gl.viewport(0, 0, canvas.width, canvas.height)

      const bandFraction = Math.min(1, 1 - BAND + 0.17) * 2
      step = STEP
      let cols = Math.ceil(width / step) + 1
      let rows = Math.ceil(height / step) + 1
      while (cols * rows * bandFraction > MAX_CELLS) {
        step *= 1.12
        cols = Math.ceil(width / step) + 1
        rows = Math.ceil(height / step) + 1
      }
      const mx = (cols - 1) / 2

      if (instanceData.length < cols * rows * 6) instanceData = new Float32Array(cols * rows * 6)
      const data = instanceData
      let count = 0
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const dx = mx > 0 ? (c - mx) / mx : 0
          const h1 = hash(c, r)
          const h2 = hash(c * 1.7 + 5, r * 2.3 + 9)
          const edge = Math.abs(dx) + (h2 - 0.5) * 0.34
          if (edge < BAND) continue
          const weight = Math.min(1, (edge - BAND) / (1 - BAND))
          const x = c * step
          const y = r * step
          const o = count * 6
          data[o] = x
          data[o + 1] = y
          data[o + 2] = 0.55 + 0.45 * h1 * weight
          data[o + 3] = h1 * Math.PI * 2
          data[o + 4] = 0.4 + h2 * 1.1
          data[o + 5] = 0.6 + 0.4 * hash(r + 3, c + 7)
          count++
        }
      }
      instanceCount = count

      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 6), gl.STATIC_DRAW)
      const stride = 6 * 4
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0)
      gl.vertexAttribDivisor(1, 1)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 2 * 4)
      gl.vertexAttribDivisor(2, 1)
      gl.bindVertexArray(null)
    }

    const draw = (now: number): void => {
      if (start < 0) start = now
      const t = (now - start) / 1000

      if (pressed && t >= nextHoldT) {
        waves.push({ x: pointerX, y: pointerY, t, scale: HOLD_SCALE })
        nextHoldT = t + HOLD_INTERVAL
      }

      for (let i = waves.length - 1; i >= 0; i--) {
        if (t - waves[i].t > WAVE_LIFE * waves[i].scale) waves.splice(i, 1)
      }
      while (waves.length > MAX_WAVES) waves.shift()

      const waveCount = waves.length
      for (let i = 0; i < waveCount; i++) {
        wavePos[i * 2] = waves[i].x
        wavePos[i * 2 + 1] = waves[i].y
        waveT[i] = waves[i].t
        waveScale[i] = waves[i].scale
      }

      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      if (instanceCount > 0) {
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(program)
        gl.bindVertexArray(vao)

        gl.uniform2f(uResolution, width, height)
        gl.uniform1f(uCell, CELL)
        gl.uniform1f(uTime, t)
        gl.uniform1i(uWaveCount, waveCount)
        if (waveCount > 0) {
          gl.uniform2fv(uWavePos, wavePos)
          gl.uniform1fv(uWaveT, waveT)
          gl.uniform1fv(uWaveScale, waveScale)
        }
        gl.uniform1f(uWaveSpeed, WAVE_SPEED)
        gl.uniform1f(uWaveWidth, WAVE_WIDTH)
        gl.uniform1f(uWaveLife, WAVE_LIFE)
        gl.uniform1f(uIdleAlpha, IDLE_ALPHA)
        gl.uniform1f(uIdleMin, IDLE_MIN)
        gl.uniform1f(uWaveAlpha, WAVE_ALPHA)
        gl.uniform1f(uMaxAlpha, MAX_ALPHA)
        gl.uniform3f(uColor, color[0], color[1], color[2])
        gl.uniform1f(uNoiseScale, NOISE_SCALE)
        gl.uniform1f(uNoiseSpeed, NOISE_SPEED)
        gl.uniform1f(uNoiseAmount, NOISE_AMOUNT)

        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount)
        gl.bindVertexArray(null)
      }

      raf = requestAnimationFrame(draw)
    }

    const track = (e: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect()
      pointerX = e.clientX - rect.left
      pointerY = e.clientY - rect.top
    }

    const spawnWave = (scale: number, dedup: boolean): void => {
      if (!raf) return
      const t = start < 0 ? 0 : (performance.now() - start) / 1000
      if (dedup) {
        const last = waves[waves.length - 1]
        if (last && Math.hypot(last.x - pointerX, last.y - pointerY) < WAVE_DEDUP) return
      }
      waves.push({ x: pointerX, y: pointerY, t, scale })
    }

    const onMove = (e: MouseEvent): void => {
      track(e)
      spawnWave(MOVE_SCALE, true)
    }

    const onDown = (e: MouseEvent): void => {
      track(e)
      spawnWave(CLICK_SCALE, false)
      pressed = true
      const t = start < 0 ? 0 : (performance.now() - start) / 1000
      nextHoldT = t + HOLD_INTERVAL
    }

    const onUp = (): void => {
      pressed = false
    }

    let onScreen = true

    const stop = (): void => {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    const play = (): void => {
      if (!raf && onScreen && !document.hidden) {
        start = -1
        pressed = false
        waves.length = 0
        raf = requestAnimationFrame(draw)
      }
    }

    const onVisibility = (): void => {
      if (document.hidden) stop()
      else play()
    }

    build()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
    document.addEventListener('visibilitychange', onVisibility)
    const ro = new ResizeObserver(() => {
      if (buildRaf) return
      buildRaf = requestAnimationFrame(() => {
        buildRaf = 0
        build()
      })
    })
    ro.observe(canvas)
    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? true
        if (onScreen) play()
        else stop()
      },
      { threshold: 0 }
    )
    io.observe(canvas)
    play()

    return () => {
      stop()
      if (buildRaf) cancelAnimationFrame(buildRaf)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      document.removeEventListener('visibilitychange', onVisibility)
      ro.disconnect()
      io.disconnect()
      gl.deleteBuffer(cornerBuffer)
      gl.deleteBuffer(instanceBuffer)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}

function accentRgb(): [number, number, number] {
  const hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m) return [129 / 255, 150 / 255, 1]
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}
