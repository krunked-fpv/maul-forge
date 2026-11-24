const VS_FULLSCREEN = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FS_BRIGHT_EXTRACT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform vec2 u_texelSize;
out vec4 fragColor;

void main() {
  vec2 off = u_texelSize * 0.5;
  vec3 c0 = texture(u_scene, v_uv + vec2(-off.x, -off.y)).rgb;
  vec3 c1 = texture(u_scene, v_uv + vec2( off.x, -off.y)).rgb;
  vec3 c2 = texture(u_scene, v_uv + vec2(-off.x,  off.y)).rgb;
  vec3 c3 = texture(u_scene, v_uv + vec2( off.x,  off.y)).rgb;
  vec3 avg = (c0 + c1 + c2 + c3) * 0.25;

  float luma = dot(avg, vec3(0.2126, 0.7152, 0.0722));
  float peak = max(avg.r, max(avg.g, avg.b));
  float energy = max(luma, peak * 0.85);
  float mask = smoothstep(0.56, 0.94, energy);
  fragColor = vec4(avg * mask, 1.0);
}
`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texelOffset;
out vec4 fragColor;

void main() {
  vec3 sum = texture(u_tex, v_uv).rgb * 0.227027;
  sum += texture(u_tex, v_uv + u_texelOffset * 1.3846153).rgb * 0.1945946;
  sum += texture(u_tex, v_uv - u_texelOffset * 1.3846153).rgb * 0.1945946;
  sum += texture(u_tex, v_uv + u_texelOffset * 3.2307692).rgb * 0.1216216;
  sum += texture(u_tex, v_uv - u_texelOffset * 3.2307692).rgb * 0.1216216;
  sum += texture(u_tex, v_uv + u_texelOffset * 5.0769231).rgb * 0.054054;
  sum += texture(u_tex, v_uv - u_texelOffset * 5.0769231).rgb * 0.054054;
  fragColor = vec4(sum, 1.0);
}
`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_bloom;
uniform float u_intensity;
uniform float u_frostPulse;
uniform float u_dangerPulse;
out vec4 fragColor;

void main() {
  vec3 bloom = texture(u_bloom, v_uv).rgb;

  vec2 centered = v_uv * 2.0 - 1.0;
  float distSq = dot(centered, centered);
  float edgeFactor = smoothstep(0.55, 1.65, distSq);

  // Subtle dark bastion perimeter vignette (alpha stays 0.0 across center arena)
  float darkAlpha = edgeFactor * 0.22;
  vec3 tintRgb = vec3(0.015, 0.02, 0.035) * darkAlpha;
  float tintAlpha = darkAlpha;

  // Sanctuary frost edge vignette
  if (u_frostPulse > 0.001) {
    float frostRim = smoothstep(0.55, 1.48, distSq) * clamp(u_frostPulse, 0.0, 1.0) * 0.42;
    tintRgb = tintRgb * (1.0 - frostRim) + vec3(0.45, 0.82, 0.99) * frostRim;
    tintAlpha = tintAlpha * (1.0 - frostRim) + frostRim;
  }

  // Danger edge vignette
  if (u_dangerPulse > 0.001) {
    float dangerRim = smoothstep(0.48, 1.42, distSq) * clamp(u_dangerPulse, 0.0, 1.0) * 0.48;
    tintRgb = tintRgb * (1.0 - dangerRim) + vec3(0.95, 0.18, 0.24) * dangerRim;
    tintAlpha = tintAlpha * (1.0 - dangerRim) + dangerRim;
  }

  // Premultiplied additive bloom with gentle highlight rolloff
  vec3 bloomAdd = bloom * (0.48 * u_intensity);
  bloomAdd = bloomAdd / (vec3(1.0) + max(vec3(0.0), bloomAdd - vec3(0.45)) * 0.65);

  vec3 outRgb = clamp(tintRgb + bloomAdd, 0.0, 1.0);
  float outAlpha = clamp(tintAlpha, 0.0, 1.0);

  fragColor = vec4(outRgb, outAlpha);
}
`;

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Transparent half-CSS-resolution WebGL2 additive bloom & frost/danger vignette
 * overlay with quarter-res Canvas2D downsample upload, context-loss recovery,
 * and transparent Canvas2D gradient fallback.
 */
export class PostFxCompositor {
  constructor(webglCanvas = null) {
    this.canvas = webglCanvas;
    this.gl = null;
    this._fallbackCtx2d = null;

    this._cssWidth = 1280;
    this._cssHeight = 720;
    this._dpr = 1;
    this._pixelWidth = 1280;
    this._pixelHeight = 720;
    this._outWidth = 640;
    this._outHeight = 360;
    this._bloomWidth = 0;
    this._bloomHeight = 0;
    this._hasResized = false;

    this._downsampleCanvas = null;
    this._downsampleCtx = null;

    this._shaderErrors = false;
    this._contextLost = false;
    this._ready = false;

    this._vao = null;
    this._vbo = null;
    this._sceneTex = null;
    this._bloomTexA = null;
    this._bloomTexB = null;
    this._fboA = null;
    this._fboB = null;

    this._progExtract = null;
    this._progBlur = null;
    this._progComposite = null;
    this._uniforms = {};

    this._onContextLost = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
      this._contextLost = true;
      this._ready = false;
    };

    this._onContextRestored = () => {
      this._contextLost = false;
      this._bloomWidth = 0;
      this._bloomHeight = 0;
      this._initWebGL();
      this._allocateTargets();
    };

    if (this.canvas && typeof this.canvas.getContext === 'function') {
      if (typeof this.canvas.addEventListener === 'function') {
        this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
        this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
      }

      let gl = null;
      try {
        gl = this.canvas.getContext('webgl2', {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
        });
      } catch {
        gl = null;
      }

      if (gl) {
        this.gl = gl;
        this._initWebGL();
        this._allocateTargets();
      } else {
        try {
          this._fallbackCtx2d = this.canvas.getContext('2d');
        } catch {
          this._fallbackCtx2d = null;
        }
      }
    }
  }

  hasShaderErrors() {
    return this._shaderErrors;
  }

  isWebGL2Active() {
    return Boolean(this.gl && this._ready && !this._contextLost && !this._shaderErrors);
  }

  _compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) {
      this._shaderErrors = true;
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      this._shaderErrors = true;
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  _linkProgram(gl, vsSource, fsSource) {
    const vs = this._compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }

    const prog = gl.createProgram();
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this._shaderErrors = true;
      return null;
    }

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this._shaderErrors = true;
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  _initWebGL() {
    const gl = this.gl;
    if (!gl || (typeof gl.isContextLost === 'function' && gl.isContextLost())) {
      return;
    }

    this._shaderErrors = false;
    this._progExtract = this._linkProgram(gl, VS_FULLSCREEN, FS_BRIGHT_EXTRACT);
    this._progBlur = this._linkProgram(gl, VS_FULLSCREEN, FS_BLUR);
    this._progComposite = this._linkProgram(gl, VS_FULLSCREEN, FS_COMPOSITE);

    if (!this._progExtract || !this._progBlur || !this._progComposite) {
      this._ready = false;
      return;
    }

    this._uniforms = {
      extractScene: gl.getUniformLocation(this._progExtract, 'u_scene'),
      extractTexel: gl.getUniformLocation(this._progExtract, 'u_texelSize'),
      blurTex: gl.getUniformLocation(this._progBlur, 'u_tex'),
      blurOffset: gl.getUniformLocation(this._progBlur, 'u_texelOffset'),
      compBloom: gl.getUniformLocation(this._progComposite, 'u_bloom'),
      compIntensity: gl.getUniformLocation(this._progComposite, 'u_intensity'),
      compFrost: gl.getUniformLocation(this._progComposite, 'u_frostPulse'),
      compDanger: gl.getUniformLocation(this._progComposite, 'u_dangerPulse'),
    };

    // Fullscreen quad VAO + VBO
    this._vao = gl.createVertexArray();
    this._vbo = gl.createBuffer();
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this._sceneTex = this._createLinearTexture(gl);
    this._bloomTexA = this._createLinearTexture(gl);
    this._bloomTexB = this._createLinearTexture(gl);
    this._fboA = gl.createFramebuffer();
    this._fboB = gl.createFramebuffer();
    this._bloomWidth = 0;
    this._bloomHeight = 0;

    this._ready = true;
  }

  _createLinearTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _ensureDownsampleCanvas(w, h) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return;
    }
    if (!this._downsampleCanvas) {
      this._downsampleCanvas = document.createElement('canvas');
      try {
        this._downsampleCtx =
          this._downsampleCanvas.getContext('2d', { alpha: false }) ||
          this._downsampleCanvas.getContext('2d');
      } catch {
        this._downsampleCtx = null;
      }
    }
    if (this._downsampleCanvas.width !== w) {
      this._downsampleCanvas.width = w;
    }
    if (this._downsampleCanvas.height !== h) {
      this._downsampleCanvas.height = h;
    }
  }

  _allocateTargets(qW = 0, qH = 0) {
    const targetW = qW > 0 ? qW : Math.max(64, Math.min(320, Math.floor(this._pixelWidth * 0.25)));
    const targetH = qH > 0 ? qH : Math.max(64, Math.min(200, Math.floor(this._pixelHeight * 0.25)));

    this._ensureDownsampleCanvas(targetW, targetH);

    const gl = this.gl;
    if (!gl || !this._ready || this._contextLost) return;
    if (this._bloomWidth === targetW && this._bloomHeight === targetH) return;

    this._bloomWidth = targetW;
    this._bloomHeight = targetH;

    gl.bindTexture(gl.TEXTURE_2D, this._sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._bloomTexA, 0);

    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._bloomTexB, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(w, h, dpr = 1) {
    const validW = Number.isFinite(w) && w > 0 ? w : 1;
    const validH = Number.isFinite(h) && h > 0 ? h : 1;
    const clampedDpr = clamp(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 1, 2);

    this._cssWidth = validW;
    this._cssHeight = validH;
    this._dpr = clampedDpr;
    this._pixelWidth = Math.max(1, Math.round(validW * clampedDpr));
    this._pixelHeight = Math.max(1, Math.round(validH * clampedDpr));
    this._outWidth = Math.max(120, Math.floor(validW * 0.5));
    this._outHeight = Math.max(80, Math.floor(validH * 0.5));
    this._hasResized = true;

    if (this.canvas) {
      if (this.canvas.width !== this._outWidth) this.canvas.width = this._outWidth;
      if (this.canvas.height !== this._outHeight) this.canvas.height = this._outHeight;
    }

    const qW = Math.max(64, Math.min(320, Math.floor(this._pixelWidth * 0.25)));
    const qH = Math.max(64, Math.min(200, Math.floor(this._pixelHeight * 0.25)));
    if (qW !== this._bloomWidth || qH !== this._bloomHeight) {
      this._allocateTargets(qW, qH);
    }
  }

  render(sourceCanvas2D, intensity = 1, frostPulse = 0, dangerPulse = 0) {
    if (!sourceCanvas2D) return false;

    const safeIntensity = Number.isFinite(intensity) ? clamp(intensity, 0, 2.5) : 1;
    const safeFrost = Number.isFinite(frostPulse) ? clamp(frostPulse, 0, 1) : 0;
    const safeDanger = Number.isFinite(dangerPulse) ? clamp(dangerPulse, 0, 1) : 0;

    if (this.isWebGL2Active()) {
      return this._renderWebGL2(sourceCanvas2D, safeIntensity, safeFrost, safeDanger);
    }

    return this._renderFallback2D(sourceCanvas2D, safeFrost, safeDanger);
  }

  _renderWebGL2(sourceCanvas2D, intensity, frostPulse, dangerPulse) {
    const gl = this.gl;
    if (!gl || this._contextLost) return false;

    const srcW = sourceCanvas2D.width || this._pixelWidth;
    const srcH = sourceCanvas2D.height || this._pixelHeight;
    if (srcW <= 0 || srcH <= 0) return false;

    if (!this._hasResized && this.canvas) {
      this._outWidth = Math.max(120, Math.floor(srcW * 0.5));
      this._outHeight = Math.max(80, Math.floor(srcH * 0.5));
      if (this.canvas.width !== this._outWidth) this.canvas.width = this._outWidth;
      if (this.canvas.height !== this._outHeight) this.canvas.height = this._outHeight;
    }

    const qW = Math.max(64, Math.min(320, Math.floor(srcW * 0.25)));
    const qH = Math.max(64, Math.min(200, Math.floor(srcH * 0.25)));
    if (qW !== this._bloomWidth || qH !== this._bloomHeight) {
      this._allocateTargets(qW, qH);
    }

    const outW = this.canvas ? (this.canvas.width || this._outWidth) : this._outWidth;
    const outH = this.canvas ? (this.canvas.height || this._outHeight) : this._outHeight;
    if (outW <= 0 || outH <= 0) return false;

    // Downsample 2D scene canvas into tiny scratch canvas, then fast-upload via texSubImage2D
    const dsCanvas = this._downsampleCanvas;
    const dsCtx = this._downsampleCtx;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sceneTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (dsCanvas && dsCtx) {
      dsCtx.clearRect(0, 0, qW, qH);
      dsCtx.drawImage(sourceCanvas2D, 0, 0, qW, qH);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, dsCanvas);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas2D);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this._vao);

    // Pass 1: Bright extract -> quarter-res FBO A
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.viewport(0, 0, qW, qH);
    gl.useProgram(this._progExtract);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sceneTex);
    gl.uniform1i(this._uniforms.extractScene, 0);
    gl.uniform2f(this._uniforms.extractTexel, 1 / qW, 1 / qH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: Horizontal blur (FBO A -> FBO B)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboB);
    gl.useProgram(this._progBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA);
    gl.uniform1i(this._uniforms.blurTex, 0);
    gl.uniform2f(this._uniforms.blurOffset, 1 / qW, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 3: Vertical blur (FBO B -> FBO A)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexB);
    gl.uniform2f(this._uniforms.blurOffset, 0, 1 / qH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 4: Transparent additive bloom + frost/danger perimeter vignette -> default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this._progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA);
    gl.uniform1i(this._uniforms.compBloom, 0);
    gl.uniform1f(this._uniforms.compIntensity, intensity);
    gl.uniform1f(this._uniforms.compFrost, frostPulse);
    gl.uniform1f(this._uniforms.compDanger, dangerPulse);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);
    return true;
  }

  _renderFallback2D(_sourceCanvas2D, frostPulse, dangerPulse) {
    const ctx = this._fallbackCtx2d;
    if (!ctx || !this.canvas) return false;

    const w = this.canvas.width || this._outWidth;
    const h = this.canvas.height || this._outHeight;
    if (w <= 0 || h <= 0) return false;

    ctx.clearRect(0, 0, w, h);

    if (frostPulse > 0.01 && typeof ctx.createRadialGradient === 'function') {
      const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.35, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0)');
      grad.addColorStop(1, `rgba(125, 211, 252, ${frostPulse * 0.32})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    if (dangerPulse > 0.01 && typeof ctx.createRadialGradient === 'function') {
      const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.34, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
      grad.addColorStop(0, 'rgba(239, 68, 68, 0)');
      grad.addColorStop(1, `rgba(239, 68, 68, ${dangerPulse * 0.36})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    return true;
  }

  dispose() {
    if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    }
    const gl = this.gl;
    if (gl) {
      if (this._fboA) gl.deleteFramebuffer(this._fboA);
      if (this._fboB) gl.deleteFramebuffer(this._fboB);
      if (this._sceneTex) gl.deleteTexture(this._sceneTex);
      if (this._bloomTexA) gl.deleteTexture(this._bloomTexA);
      if (this._bloomTexB) gl.deleteTexture(this._bloomTexB);
      if (this._vbo) gl.deleteBuffer(this._vbo);
      if (this._vao) gl.deleteVertexArray(this._vao);
      if (this._progExtract) gl.deleteProgram(this._progExtract);
      if (this._progBlur) gl.deleteProgram(this._progBlur);
      if (this._progComposite) gl.deleteProgram(this._progComposite);
    }
    this._downsampleCanvas = null;
    this._downsampleCtx = null;
    this._ready = false;
  }
}
