// WebGL2 renderer for the 3D, elevation and section views. One GL context (on a
// detached canvas) holds the scene; each view renders into it with its own camera and
// clip planes and the result is copied to the view's 2D canvas, so several views can
// share the buffers. Curved surfaces (pipes) carry vertex normals and are smooth shaded;
// flat faces have a zero normal and are shaded with normals from screen-space derivatives.

export type V3 = [number, number, number]

export interface Camera {
  /** point the camera looks at (scene coordinates: model mm, elevations applied) */
  target: V3
  /** eye distance; in parallel projection it sets the zoom (half height = distance * tan(fov / 2)) */
  distance: number
  /** direction of the eye seen from the target: azimuth around +z (0 = +x) and elevation */
  yaw: number
  pitch: number
  perspective: boolean
}

/** Keep points where n · p + d >= 0 (scene coordinates). */
export type Plane = [number, number, number, number]

export interface SceneBuffers {
  /** subtracted from all positions (keeps float32 precise) */
  origin: V3
  /** triangles: xyz per vertex, rgba color, rgba-encoded pick id (object index + 1) */
  triPos: Float32Array
  /** vertex normals as signed bytes (4 per vertex, xyz used); 0 = flat face */
  triNormal: Int8Array
  triColor: Uint8Array
  triId: Uint8Array
  linePos: Float32Array
  lineColor: Uint8Array
  lineId: Uint8Array
  groups: SceneGroup[]
}

/** Vertex ranges [first, count] of one sheet. */
export interface SceneGroup {
  sheet: number
  elevation: number
  opaque: [number, number]
  /** architecture: members and imported faces (drawn translucent on request) */
  members: [number, number]
  lines: [number, number]
  plan: [number, number]
}

export interface DrawState {
  background: [number, number, number]
  visible: (sheet: number) => boolean
  translucentMembers: boolean
  showPlan: boolean
  useElevation: boolean
  clip: Plane[]
}

const FOV = (40 * Math.PI) / 180

type M4 = Float32Array

function mul(a: M4, b: M4): M4 {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return o
}

/** Camera frame: eye position and unit right / up / forward vectors. */
export function cameraFrame(c: Camera) {
  const cp = Math.cos(c.pitch)
  const dir: V3 = [cp * Math.cos(c.yaw), cp * Math.sin(c.yaw), Math.sin(c.pitch)]
  const fwd: V3 = [-dir[0], -dir[1], -dir[2]]
  const right: V3 = [-Math.sin(c.yaw), Math.cos(c.yaw), 0]
  const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]]
  const eye: V3 = [c.target[0] + dir[0] * c.distance, c.target[1] + dir[1] * c.distance, c.target[2] + dir[2] * c.distance]
  return { eye, right, up, fwd, dir }
}

/** World units per CSS pixel at the target distance. */
export function unitsPerPixel(c: Camera, heightPx: number) {
  return (2 * c.distance * Math.tan(FOV / 2)) / Math.max(heightPx, 1)
}

/** Camera distance that shows `upp` world units per CSS pixel (inverse of unitsPerPixel). */
export function distanceForUnitsPerPixel(upp: number, heightPx: number) {
  return (upp * Math.max(heightPx, 1)) / (2 * Math.tan(FOV / 2))
}

/**
 * View-projection matrix for positions relative to `origin`. `radius` bounds the scene
 * (sets the depth range).
 */
export function viewProj(c: Camera, aspect: number, origin: V3, radius: number): M4 {
  const { eye, right, up, fwd } = cameraFrame(c)
  // view matrix with the eye relative to the origin
  let e: V3 = [eye[0] - origin[0], eye[1] - origin[1], eye[2] - origin[2]]
  if (!c.perspective) {
    // parallel: put the eye well outside the scene so nothing is behind it
    const back = radius * 4 + c.distance
    e = [c.target[0] - origin[0] - fwd[0] * back, c.target[1] - origin[1] - fwd[1] * back, c.target[2] - origin[2] - fwd[2] * back]
  }
  const v = new Float32Array(16)
  v.set([right[0], up[0], -fwd[0], 0, right[1], up[1], -fwd[1], 0, right[2], up[2], -fwd[2], 0])
  v[12] = -(right[0] * e[0] + right[1] * e[1] + right[2] * e[2])
  v[13] = -(up[0] * e[0] + up[1] * e[1] + up[2] * e[2])
  v[14] = fwd[0] * e[0] + fwd[1] * e[1] + fwd[2] * e[2]
  v[15] = 1
  const p = new Float32Array(16)
  if (c.perspective) {
    const near = Math.max(c.distance * 0.01, radius * 1e-5, 1)
    const far = c.distance + radius * 4
    const f = 1 / Math.tan(FOV / 2)
    p[0] = f / aspect
    p[5] = f
    p[10] = (far + near) / (near - far)
    p[11] = -1
    p[14] = (2 * far * near) / (near - far)
  } else {
    const hh = c.distance * Math.tan(FOV / 2)
    const hw = hh * aspect
    const near = 1
    const far = radius * 8 + c.distance * 2
    p[0] = 1 / hw
    p[5] = 1 / hh
    p[10] = -2 / (far - near)
    p[14] = -(far + near) / (far - near)
    p[15] = 1
  }
  return mul(p, v)
}

const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec3 aNormal;
uniform mat4 uMVP;
uniform vec3 uShift;
out vec3 vPos;
out vec4 vColor;
out vec3 vNormal;
void main() {
  vec3 p = aPos + uShift;
  vPos = p;
  vColor = aColor;
  vNormal = aNormal;
  gl_Position = uMVP * vec4(p, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec4 vColor;
in vec3 vNormal;
uniform vec3 uLight;
uniform float uAlpha;
uniform int uShade;
uniform vec4 uClip[6];
uniform int uClipN;
out vec4 oColor;
void main() {
  for (int i = 0; i < 6; i++) {
    if (i >= uClipN) break;
    if (dot(uClip[i].xyz, vPos) + uClip[i].w < 0.0) discard;
  }
  if (uShade == 0) {
    oColor = vec4(vColor.rgb, vColor.a * uAlpha);
    return;
  }
  vec3 n = length(vNormal) > 0.5 ? normalize(vNormal) : normalize(cross(dFdx(vPos), dFdy(vPos)));
  float d = abs(dot(n, uLight));
  oColor = vec4(vColor.rgb * (0.4 + 0.6 * d), vColor.a * uAlpha);
}`

interface Attr {
  pos: WebGLBuffer
  color: WebGLBuffer
  id: WebGLBuffer
  normal: WebGLBuffer | null
  vaoColor: WebGLVertexArrayObject
  vaoId: WebGLVertexArrayObject
}

export class Gl3d {
  readonly canvas = document.createElement('canvas')
  readonly gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private u: Record<string, WebGLUniformLocation | null> = {}
  private tri: Attr | null = null
  private line: Attr | null = null
  scene: SceneBuffers | null = null
  private radius = 1
  private fbo: WebGLFramebuffer | null = null
  private fboTex: WebGLTexture | null = null
  private fboDepth: WebGLRenderbuffer | null = null
  private fboSize: [number, number] = [0, 0]

  constructor() {
    const gl = this.canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false })
    if (!gl) throw new Error('この環境では WebGL2 を利用できません')
    this.gl = gl
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
    this.prog = p
    for (const n of ['uMVP', 'uShift', 'uLight', 'uAlpha', 'uShade', 'uClip', 'uClipN']) this.u[n] = gl.getUniformLocation(p, n)
    // lines have no normal buffer: the attribute then reads this constant (flat)
    gl.vertexAttrib4f(2, 0, 0, 0, 0)
  }

  setScene(s: SceneBuffers) {
    const gl = this.gl
    this.dispose()
    this.scene = s
    const make = (pos: Float32Array, color: Uint8Array, id: Uint8Array, normal?: Int8Array): Attr => {
      const buf = (data: ArrayBufferView) => {
        const b = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, b)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
        return b
      }
      const a = { pos: buf(pos), color: buf(color), id: buf(id), normal: normal ? buf(normal) : null } as Attr
      const vao = (colorBuf: WebGLBuffer) => {
        const v = gl.createVertexArray()!
        gl.bindVertexArray(v)
        gl.bindBuffer(gl.ARRAY_BUFFER, a.pos)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0)
        if (a.normal) {
          gl.bindBuffer(gl.ARRAY_BUFFER, a.normal)
          gl.enableVertexAttribArray(2)
          gl.vertexAttribPointer(2, 3, gl.BYTE, true, 4, 0)
        }
        gl.bindVertexArray(null)
        return v
      }
      a.vaoColor = vao(a.color)
      a.vaoId = vao(a.id)
      return a
    }
    this.tri = make(s.triPos, s.triColor, s.triId, s.triNormal)
    this.line = make(s.linePos, s.lineColor, s.lineId)
    // scene radius around the origin (for depth ranges)
    let r = 1
    for (const arr of [s.triPos, s.linePos]) for (let i = 0; i < arr.length; i += 3) r = Math.max(r, Math.abs(arr[i]), Math.abs(arr[i + 1]), Math.abs(arr[i + 2]))
    for (const g of s.groups) r = Math.max(r, Math.abs(g.elevation) * 2)
    this.radius = r * 1.8
  }

  /** Replace colors of vertex ranges (highlighting); `kind` selects triangles or lines. */
  updateColors(kind: 'tri' | 'line', first: number, colors: Uint8Array) {
    const a = kind === 'tri' ? this.tri : this.line
    if (!a || !colors.length) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, a.color)
    gl.bufferSubData(gl.ARRAY_BUFFER, first * 4, colors)
  }

  get sceneRadius() {
    return this.radius
  }

  private ensureSize(w: number, h: number) {
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w)
      this.canvas.height = Math.max(this.canvas.height, h)
    }
  }

  private draw(cam: Camera, w: number, h: number, st: DrawState, pick: boolean) {
    const gl = this.gl
    const s = this.scene
    gl.viewport(0, 0, w, h)
    const bg = pick ? [0, 0, 0] : st.background
    gl.clearColor(bg[0] / 255, bg[1] / 255, bg[2] / 255, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    if (!s || !this.tri || !this.line) return
    gl.useProgram(this.prog)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.CULL_FACE)
    const mvp = viewProj(cam, w / h, s.origin, this.radius)
    gl.uniformMatrix4fv(this.u.uMVP, false, mvp)
    const { right, up, fwd } = cameraFrame(cam)
    const L: V3 = [-fwd[0] * 0.75 + up[0] * 0.5 - right[0] * 0.3, -fwd[1] * 0.75 + up[1] * 0.5 - right[1] * 0.3, -fwd[2] * 0.75 + up[2] * 0.5 - right[2] * 0.3]
    const ln = Math.hypot(...L)
    gl.uniform3f(this.u.uLight, L[0] / ln, L[1] / ln, L[2] / ln)
    // clip planes relative to the origin
    const clip = new Float32Array(24)
    const n = Math.min(st.clip.length, 6)
    for (let i = 0; i < n; i++) {
      const [a, b, c, d] = st.clip[i]
      clip.set([a, b, c, d + a * s.origin[0] + b * s.origin[1] + c * s.origin[2]], i * 4)
    }
    gl.uniform4fv(this.u.uClip, clip)
    gl.uniform1i(this.u.uClipN, n)
    const shift = (g: SceneGroup) => gl.uniform3f(this.u.uShift, 0, 0, st.useElevation ? g.elevation : 0)
    const groups = s.groups.filter((g) => st.visible(g.sheet))

    // faces (pushed back a little so edges drawn on them stay visible)
    gl.bindVertexArray(pick ? this.tri.vaoId : this.tri.vaoColor)
    gl.uniform1i(this.u.uShade, pick ? 0 : 1)
    gl.uniform1f(this.u.uAlpha, 1)
    gl.disable(gl.BLEND)
    gl.enable(gl.POLYGON_OFFSET_FILL)
    gl.polygonOffset(1, 1)
    for (const g of groups) {
      shift(g)
      if (g.opaque[1]) gl.drawArrays(gl.TRIANGLES, g.opaque[0], g.opaque[1])
      // translucent architecture is drawn last and cannot be picked
      if (g.members[1] && !st.translucentMembers) gl.drawArrays(gl.TRIANGLES, g.members[0], g.members[1])
    }
    gl.disable(gl.POLYGON_OFFSET_FILL)

    // lines: 3D edges, then the plan drawing
    gl.bindVertexArray(pick ? this.line.vaoId : this.line.vaoColor)
    gl.uniform1i(this.u.uShade, 0)
    if (!pick) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    }
    for (const g of groups) {
      shift(g)
      if (g.lines[1]) gl.drawArrays(gl.LINES, g.lines[0], g.lines[1])
      if (!pick && st.showPlan && g.plan[1]) gl.drawArrays(gl.LINES, g.plan[0], g.plan[1])
    }

    // translucent members last, without writing depth
    if (!pick && st.translucentMembers) {
      gl.bindVertexArray(this.tri.vaoColor)
      gl.uniform1i(this.u.uShade, 1)
      gl.uniform1f(this.u.uAlpha, 0.28)
      gl.depthMask(false)
      for (const g of groups) {
        shift(g)
        if (g.members[1]) gl.drawArrays(gl.TRIANGLES, g.members[0], g.members[1])
      }
      gl.depthMask(true)
    }
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  /** Render a view and copy it to the target canvas (sized in device pixels). */
  render(cam: Camera, target: HTMLCanvasElement, st: DrawState) {
    const w = target.width
    const h = target.height
    if (w < 1 || h < 1) return
    this.ensureSize(w, h)
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
    this.draw(cam, w, h, st, false)
    const ctx = target.getContext('2d')!
    ctx.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h)
  }

  /** Object index under device pixel (x, y) of a view, or -1. Looks a few pixels around. */
  pick(cam: Camera, w: number, h: number, x: number, y: number, st: DrawState, radius = 4): number {
    const gl = this.gl
    if (!this.scene || w < 1 || h < 1) return -1
    if (!this.fbo || this.fboSize[0] < w || this.fboSize[1] < h) {
      if (this.fbo) {
        gl.deleteFramebuffer(this.fbo)
        gl.deleteTexture(this.fboTex)
        gl.deleteRenderbuffer(this.fboDepth)
      }
      const fw = Math.max(w, this.fboSize[0])
      const fh = Math.max(h, this.fboSize[1])
      this.fboTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      this.fboDepth = gl.createRenderbuffer()
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.fboDepth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, fw, fh)
      this.fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.fboDepth)
      this.fboSize = [fw, fh]
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE)
    this.draw(cam, w, h, st, true)
    const r = radius
    const x0 = Math.max(0, Math.round(x) - r)
    const y0 = Math.max(0, h - 1 - Math.round(y) - r)
    const pw = Math.min(w - x0, 2 * r + 1)
    const ph = Math.min(h - y0, 2 * r + 1)
    const px = new Uint8Array(pw * ph * 4)
    gl.readPixels(x0, y0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    let best = -1
    let bestD = Infinity
    const cx = Math.round(x) - x0
    const cy = h - 1 - Math.round(y) - y0
    for (let j = 0; j < ph; j++) {
      for (let i = 0; i < pw; i++) {
        const k = (j * pw + i) * 4
        const id = px[k] | (px[k + 1] << 8) | (px[k + 2] << 16)
        if (!id) continue
        const d = (i - cx) ** 2 + (j - cy) ** 2
        if (d < bestD) {
          bestD = d
          best = id - 1
        }
      }
    }
    return best
  }

  dispose() {
    const gl = this.gl
    for (const a of [this.tri, this.line]) {
      if (!a) continue
      gl.deleteBuffer(a.pos)
      gl.deleteBuffer(a.color)
      gl.deleteBuffer(a.id)
      if (a.normal) gl.deleteBuffer(a.normal)
      gl.deleteVertexArray(a.vaoColor)
      gl.deleteVertexArray(a.vaoId)
    }
    this.tri = this.line = null
    this.scene = null
  }
}
