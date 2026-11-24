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
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_intensity;
uniform float u_frostPulse;
uniform float u_dangerPulse;
out vec4 fragColor;

void main() {
  vec4 scene = texture(u_scene, v_uv);
  vec3 bloom = texture(u_bloom, v_uv).rgb;

  vec3 hdr = scene.rgb + bloom * (0.58 * u_intensity);
  vec3 rolloff = hdr / (vec3(1.0) + max(vec3(0.0), hdr - vec3(0.88)) * 0.45);
  vec3 color = mix(hdr, rolloff, 0.72);

  vec2 centered = v_uv * 2.0 - 1.0;
  float distSq = dot(centered, centered);
  float edgeFactor = smoothstep(0.42, 1.55, distSq);

  // Subtle dark bastion vignette
  color *= mix(1.0, 0.86, edgeFactor * 0.65);

  // Sanctuary frost edge vignette
  if (u_frostPulse > 0.001) {
    float frostRim = smoothstep(0.55, 1.48, distSq) * clamp(u_frostPulse, 0.0, 1.0);
    color = mix(color, vec3(0.45, 0.82, 0.99), frostRim * 0.42);
  }

  // Danger edge vignette
  if (u_dangerPulse > 0.001) {
    float dangerRim = smoothstep(0.48, 1.42, distSq) * clamp(u_dangerPulse, 0.0, 1.0);
    color = mix(color, vec3(0.95, 0.18, 0.24), dangerRim * 0.48);
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), scene.a);
}
`;

function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/**
 * Half-resolution WebGL2 dual-pass bloom & frost/danger vignette compositor
 * with automatic context-loss recovery and graceful Canvas2D fallback.
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
    this._halfWidth = 640;
    this._halfHeight = 360;

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
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: false,
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
      compScene: gl.getUniformLocation(this._progComposite, 'u_scene'),
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

  _allocateTargets() {
    const gl = this.gl;
    if (!gl || !this._ready || this._contextLost) return;

    this._halfWidth = Math.max(1, Math.floor(this._pixelWidth * 0.5));
    this._halfHeight = Math.max(1, Math.floor(this._pixelHeight * 0.5));

    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this._halfWidth, this._halfHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._bloomTexA, 0);

    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this._halfWidth, this._halfHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
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

    if (this.canvas) {
      if (this.canvas.width !== this._pixelWidth) this.canvas.width = this._pixelWidth;
      if (this.canvas.height !== this._pixelHeight) this.canvas.height = this._pixelHeight;
    }

    this._allocateTargets();
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

    if (srcW !== this._pixelWidth || srcH !== this._pixelHeight) {
      this._pixelWidth = srcW;
      this._pixelHeight = srcH;
      if (this.canvas) {
        this.canvas.width = srcW;
        this.canvas.height = srcH;
      }
      this._allocateTargets();
    }

    // Upload 2D scene canvas to WebGL texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sceneTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas2D);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    gl.bindVertexArray(this._vao);

    // Pass 1: Bright extract -> half-res FBO A
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.viewport(0, 0, this._halfWidth, this._halfHeight);
    gl.useProgram(this._progExtract);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sceneTex);
    gl.uniform1i(this._uniforms.extractScene, 0);
    gl.uniform2f(this._uniforms.extractTexel, 1 / srcW, 1 / srcH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: Horizontal blur (FBO A -> FBO B)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboB);
    gl.useProgram(this._progBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA);
    gl.uniform1i(this._uniforms.blurTex, 0);
    gl.uniform2f(this._uniforms.blurOffset, 1 / this._halfWidth, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 3: Vertical blur (FBO B -> FBO A)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboA);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexB);
    gl.uniform2f(this._uniforms.blurOffset, 0, 1 / this._halfHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 4: Final composite + frost/danger edge vignette -> default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, srcW, srcH);
    gl.useProgram(this._progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._sceneTex);
    gl.uniform1i(this._uniforms.compScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA);
    gl.uniform1i(this._uniforms.compBloom, 1);
    gl.uniform1f(this._uniforms.compIntensity, intensity);
    gl.uniform1f(this._uniforms.compFrost, frostPulse);
    gl.uniform1f(this._uniforms.compDanger, dangerPulse);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindVertexArray(null);
    return true;
  }

  _renderFallback2D(sourceCanvas2D, frostPulse, dangerPulse) {
    const ctx = this._fallbackCtx2d;
    if (!ctx || !this.canvas) return false;

    const w = this.canvas.width || this._pixelWidth;
    const h = this.canvas.height || this._pixelHeight;
    if (w <= 0 || h <= 0) return false;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(sourceCanvas2D, 0, 0, w, h);

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
    this._ready = false;
  }
}
