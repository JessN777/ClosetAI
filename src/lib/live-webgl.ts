import { buildGarmentGrid, type BodyCalibration, type GarmentFit, type TorsoPose } from "./live-pose";
import type { PersonMask } from "./pose-protocol";

const QUAD = new Float32Array([
  -1, 1, 0, 1,  -1, -1, 0, 0,  1, 1, 1, 1,
  -1, -1, 0, 0,  1, -1, 1, 0,  1, 1, 1, 1,
]);

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
out vec2 vUv;
out vec2 vScreen;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vUv = aUv;
  vScreen = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
}`;

const QUAD_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); vUv = aUv; }`;

const VIDEO_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uVideo;
out vec4 outColor;
void main() { outColor = texture(uVideo, vUv); }`;

const LIGHT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uPersonMask;
uniform bool uUseMask;
uniform bool uMaskFlipY;
uniform vec4 uTorsoRect;
out vec4 outColor;
void main() {
  vec3 sum = vec3(0.0);
  float weights = 0.0;
  for (int y = 0; y < 10; y++) {
    for (int x = 0; x < 10; x++) {
      vec2 p = uTorsoRect.xy + uTorsoRect.zw * (vec2(float(x), float(y)) + 0.5) / 10.0;
      vec2 uv = vec2(p.x, 1.0 - p.y);
      vec2 maskUv = vec2(uv.x, uMaskFlipY ? 1.0 - uv.y : uv.y);
      float person = uUseMask ? texture(uPersonMask, maskUv).r : 1.0;
      vec3 color = texture(uVideo, uv).rgb;
      sum += color * person;
      weights += person;
    }
  }
  vec3 average = sum / max(weights, 0.001);
  outColor = vec4(average, 1.0);
}`;

const GARMENT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
in vec2 vScreen;
uniform sampler2D uGarment;
uniform sampler2D uPersonMask;
uniform sampler2D uLighting;
uniform sampler2D uBlurredGarment;
uniform sampler2D uBlurredPerson;
uniform bool uUseMask;
uniform bool uMaskFlipY;
uniform bool uMaskPass;
uniform bool uUseShadow;
uniform float uOpacity;
uniform vec2 uResolution;
uniform vec4 uArms[4];
uniform vec2 uHands[2];
uniform vec4 uHead;
uniform float uArmRadius;
out vec4 outColor;
float segmentDistance(vec2 point, vec2 a, vec2 b) {
  vec2 pa = point - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec2 screenUv = vec2(vScreen.x, 1.0 - vScreen.y);
  vec2 maskUv = vec2(screenUv.x, uMaskFlipY ? 1.0 - screenUv.y : screenUv.y);
  vec4 garment = texture(uGarment, vUv);
  float person = uUseMask ? smoothstep(0.12, 0.62, texture(uPersonMask, maskUv).r) : 0.0;
  float occlusion = 0.0;
  vec2 pixel = vScreen * uResolution;
  for (int i = 0; i < 4; i++) {
    vec4 segment = uArms[i];
    if (segment.x >= 0.0) {
      float d = segmentDistance(pixel, segment.xy * uResolution, segment.zw * uResolution);
      occlusion = max(occlusion, 1.0 - smoothstep(uArmRadius - 1.0, uArmRadius + 2.0, d));
    }
  }
  for (int i = 0; i < 2; i++) {
    if (uHands[i].x >= 0.0) {
      float d = distance(pixel, uHands[i] * uResolution);
      occlusion = max(occlusion, 1.0 - smoothstep(uArmRadius * 0.65, uArmRadius, d));
    }
  }
  if (uHead.x >= 0.0) {
    vec2 ellipse = (vScreen - uHead.xy) / max(uHead.zw, vec2(0.001));
    occlusion = max(occlusion, 1.0 - smoothstep(0.82, 1.05, length(ellipse)));
  }
  float alpha = garment.a * person * (1.0 - occlusion) * uOpacity;
  if (uMaskPass) {
    outColor = vec4(alpha);
    return;
  }
  if (alpha <= 0.01) discard;
  vec3 light = texture(uLighting, vec2(0.5)).rgb;
  float brightness = dot(light, vec3(0.2126, 0.7152, 0.0722));
  float gain = clamp(0.78 + brightness * 0.46, 0.78, 1.14);
  float warmth = clamp((light.r - light.b) * 0.18, -0.07, 0.07);
  vec3 sourceColor = garment.a > 0.002 ? garment.rgb / garment.a : vec3(0.0);
  vec3 color = sourceColor * gain + vec3(warmth, warmth * 0.15, -warmth);
  if (uUseShadow) {
    float softened = texture(uBlurredGarment, screenUv).a;
    float innerContact = clamp(garment.a * person - softened, 0.0, 1.0);
    float personSoft = texture(uBlurredPerson, maskUv).r;
    float personContact = uUseMask ? clamp(person - personSoft, 0.0, 1.0) * garment.a : 0.0;
    float collarShade = (1.0 - smoothstep(0.0, 0.07, abs(vUv.y - 0.84)))
      * (1.0 - smoothstep(0.08, 0.48, abs(vUv.x - 0.5)));
    color *= 1.0 - clamp(innerContact * 0.18 + personContact * 0.18 + collarShade * 0.11, 0.0, 0.32);
  }
  outColor = vec4(color * alpha, alpha);
}`;

const BLUR_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uStep;
out vec4 outColor;
void main() {
  float a = texture(uSource, vUv).r * 0.227027;
  a += texture(uSource, vUv + uStep * 1.384615).r * 0.316216;
  a += texture(uSource, vUv - uStep * 1.384615).r * 0.316216;
  a += texture(uSource, vUv + uStep * 3.230769).r * 0.070270;
  a += texture(uSource, vUv - uStep * 3.230769).r * 0.070270;
  outColor = vec4(a);
}`;

const SHADOW_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uShadow;
out vec4 outColor;
void main() {
  float a = texture(uShadow, vUv).a * 0.18;
  outColor = vec4(vec3(0.025, 0.035, 0.03) * a, a);
}`;

type Target = { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number };

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL could not create a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "WebGL shader compilation failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const result = gl.createProgram();
  if (!result) throw new Error("WebGL could not create a render program.");
  gl.attachShader(result, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(result, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result) || "WebGL program linking failed.");
  return result;
}

function createTexture(gl: WebGL2RenderingContext, source?: TexImageSource, width?: number, height?: number) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("WebGL could not create a texture.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (source) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  } else if (width && height) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  return texture;
}

function renderTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const texture = createTexture(gl, undefined, width, height);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error("WebGL could not create a render target.");
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("WebGL render target is incomplete.");
  return { framebuffer, texture, width, height };
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function sourceDimensions(source: TexImageSource) {
  // TexImageSource includes VideoFrame, which exposes displayWidth/displayHeight
  // instead of width/height in some DOM typings.
  const value = source as {
    width?: number; height?: number; videoWidth?: number; videoHeight?: number;
    naturalWidth?: number; naturalHeight?: number; displayWidth?: number; displayHeight?: number;
  };
  return {
    width: value.videoWidth ?? value.naturalWidth ?? value.displayWidth ?? value.width ?? 0,
    height: value.videoHeight ?? value.naturalHeight ?? value.displayHeight ?? value.height ?? 0,
  };
}

export type RenderQuality = { shadows: boolean; columns: number; rows: number; scale: number };

export class LiveWebGLRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly videoProgram: WebGLProgram;
  private readonly lightingProgram: WebGLProgram;
  private readonly garmentProgram: WebGLProgram;
  private readonly blurProgram: WebGLProgram;
  private readonly shadowProgram: WebGLProgram;
  private readonly quadBuffer: WebGLBuffer;
  private readonly meshBuffer: WebGLBuffer;
  private readonly videoTexture: WebGLTexture;
  private readonly garmentTexture: WebGLTexture;
  private readonly personTexture: WebGLTexture;
  private readonly lighting: Target;
  private shadowMask: Target;
  private blurHorizontal: Target;
  private blurVertical: Target;
  private personBlurHorizontal: Target;
  private personBlurVertical: Target;
  private personMaskReady = false;
  private personMaskFlipY = false;
  private videoAllocated = false;
  private uploadedFrameSource: TexImageSource | null = null;
  private uploadedFrameTime = -1;
  private lastLightingAt = -Infinity;
  private quality: RenderQuality = { shadows: true, columns: 8, rows: 12, scale: 1 };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly video: HTMLVideoElement, garment: TexImageSource) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL 2 is unavailable on this device. Use the static preview or photo try-on.");
    this.gl = gl;
    this.videoProgram = program(gl, QUAD_VERTEX_SHADER, VIDEO_FRAGMENT_SHADER);
    this.lightingProgram = program(gl, QUAD_VERTEX_SHADER, LIGHT_FRAGMENT_SHADER);
    this.garmentProgram = program(gl, VERTEX_SHADER, GARMENT_FRAGMENT_SHADER);
    this.blurProgram = program(gl, QUAD_VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
    this.shadowProgram = program(gl, QUAD_VERTEX_SHADER, SHADOW_FRAGMENT_SHADER);
    this.quadBuffer = gl.createBuffer()!;
    this.meshBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.videoTexture = createTexture(gl);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    this.garmentTexture = createTexture(gl, garment);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    this.personTexture = createTexture(gl, undefined, 1, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.personTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.lighting = renderTarget(gl, 1, 1);
    this.shadowMask = renderTarget(gl, Math.max(1, Math.ceil((canvas.width || 1) / 2)), Math.max(1, Math.ceil((canvas.height || 1) / 2)));
    this.blurHorizontal = renderTarget(gl, this.shadowMask.width, this.shadowMask.height);
    this.blurVertical = renderTarget(gl, this.shadowMask.width, this.shadowMask.height);
    this.personBlurHorizontal = renderTarget(gl, this.shadowMask.width, this.shadowMask.height);
    this.personBlurVertical = renderTarget(gl, this.shadowMask.width, this.shadowMask.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  setQuality(quality: RenderQuality) { this.quality = quality; }

  updateGarment(garment: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.garmentTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, garment);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  }

  resize(width: number, height: number) {
    const scaledWidth = Math.max(1, Math.round(width * this.quality.scale));
    const scaledHeight = Math.max(1, Math.round(height * this.quality.scale));
    const shadowWidth = Math.max(1, Math.ceil(scaledWidth / 2));
    const shadowHeight = Math.max(1, Math.ceil(scaledHeight / 2));
    if (this.canvas.width === scaledWidth && this.canvas.height === scaledHeight
      && this.shadowMask.width === shadowWidth && this.shadowMask.height === shadowHeight) return;
    this.canvas.width = scaledWidth;
    this.canvas.height = scaledHeight;
    const gl = this.gl;
    this.deleteTarget(this.shadowMask); this.deleteTarget(this.blurHorizontal); this.deleteTarget(this.blurVertical);
    this.deleteTarget(this.personBlurHorizontal); this.deleteTarget(this.personBlurVertical);
    // Soft shadow masks are half-resolution; the garment itself still renders at full preview size.
    this.shadowMask = renderTarget(gl, shadowWidth, shadowHeight);
    this.blurHorizontal = renderTarget(gl, shadowWidth, shadowHeight);
    this.blurVertical = renderTarget(gl, shadowWidth, shadowHeight);
    this.personBlurHorizontal = renderTarget(gl, shadowWidth, shadowHeight);
    this.personBlurVertical = renderTarget(gl, shadowWidth, shadowHeight);
    if (this.personMaskReady) this.blurPersonMask();
  }

  setPersonMask(mask: PersonMask | null) {
    if (!mask || mask.width <= 0 || mask.height <= 0) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.personTexture);
    // Typed-array uploads keep their row order; the shader applies the mask's
    // orientation flag to align CPU-backed data and bottom-up GPU readbacks.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.personMaskFlipY = mask.flipY;
    this.personMaskReady = true;
    this.blurPersonMask();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  draw(pose: TorsoPose | null, fit: GarmentFit, opacity: number, swayPixels: number, calibration: BodyCalibration | null, now: number, frameSource: TexImageSource = this.video) {
    const gl = this.gl;
    const { width: sourceWidth, height: sourceHeight } = sourceDimensions(frameSource);
    this.resize(sourceWidth || this.canvas.width, sourceHeight || this.canvas.height);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const frameTime = frameSource instanceof HTMLVideoElement ? frameSource.currentTime : 0;
    if (!this.videoAllocated || this.uploadedFrameSource !== frameSource || frameTime !== this.uploadedFrameTime) {
      gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      if (!this.videoAllocated) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frameSource);
        this.videoAllocated = true;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frameSource);
      }
      this.uploadedFrameSource = frameSource;
      this.uploadedFrameTime = frameTime;
    }

    this.drawQuad(this.videoProgram, null, ["uVideo"] , [this.videoTexture]);
    if (!pose) return;
    this.drawLighting(pose, now);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    const vertices = buildGarmentGrid(pose, this.canvas.width, this.canvas.height, fit,
      this.quality.columns, this.quality.rows, swayPixels, calibration);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    this.setMeshAttributes();
    this.setGarmentUniforms(pose, opacity, 0);

    if (this.quality.shadows) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowMask.framebuffer);
      gl.viewport(0, 0, this.shadowMask.width, this.shadowMask.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      this.drawMesh(vertices.length / 4);
      this.blurPass(this.shadowMask.texture, this.blurHorizontal, 1, 0);
      this.blurPass(this.blurHorizontal.texture, this.blurVertical, 0, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.enable(gl.BLEND);
      this.drawQuad(this.shadowProgram, null, ["uShadow"], [this.blurVertical.texture]);
    }

    gl.enable(gl.BLEND);
    this.setGarmentUniforms(pose, opacity, 1);
    this.drawMesh(vertices.length / 4);
  }

  dispose() {
    const gl = this.gl;
    for (const target of [this.lighting, this.shadowMask, this.blurHorizontal, this.blurVertical, this.personBlurHorizontal, this.personBlurVertical]) this.deleteTarget(target);
    for (const texture of [this.videoTexture, this.garmentTexture, this.personTexture]) gl.deleteTexture(texture);
    for (const item of [this.quadBuffer, this.meshBuffer]) gl.deleteBuffer(item);
    for (const item of [this.videoProgram, this.lightingProgram, this.garmentProgram, this.blurProgram, this.shadowProgram]) gl.deleteProgram(item);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private deleteTarget(target: Target) {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  private drawLighting(pose: TorsoPose, now: number) {
    if (now - this.lastLightingAt < 1000) return;
    this.lastLightingAt = now;
    const gl = this.gl;
    const points = [pose.leftShoulder, pose.rightShoulder, pose.leftHip, pose.rightHip];
    const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    const minX = clamp01(Math.min(...xs) - 0.04), minY = clamp01(Math.min(...ys) - 0.04);
    const maxX = clamp01(Math.max(...xs) + 0.04), maxY = clamp01(Math.max(...ys) + 0.04);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lighting.framebuffer);
    gl.viewport(0, 0, 1, 1);
    const target = this.lightingProgram;
    gl.useProgram(target);
    this.bindQuad(target);
    this.bindTexture(target, "uVideo", this.videoTexture, 0);
    this.bindTexture(target, "uPersonMask", this.personTexture, 1);
    gl.uniform1i(gl.getUniformLocation(target, "uUseMask"), this.personMaskReady ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(target, "uMaskFlipY"), this.personMaskFlipY ? 1 : 0);
    gl.uniform4f(gl.getUniformLocation(target, "uTorsoRect"), minX, minY, maxX - minX, maxY - minY);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private bindQuad(target: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const position = gl.getAttribLocation(target, "aPosition");
    const uv = gl.getAttribLocation(target, "aUv");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
  }

  private bindTexture(target: WebGLProgram, name: string, texture: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(target, name), unit);
  }

  private drawQuad(target: WebGLProgram, framebuffer: WebGLFramebuffer | null, names: string[], textures: WebGLTexture[]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.useProgram(target);
    this.bindQuad(target);
    names.forEach((name, index) => this.bindTexture(target, name, textures[index], index));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private setMeshAttributes() {
    const gl = this.gl;
    const target = this.garmentProgram;
    gl.useProgram(target);
    const position = gl.getAttribLocation(target, "aPosition");
    const uv = gl.getAttribLocation(target, "aUv");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uv); gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
  }

  private setGarmentUniforms(pose: TorsoPose, opacity: number, useShadow: number) {
    const gl = this.gl;
    const target = this.garmentProgram;
    gl.useProgram(target);
    this.bindTexture(target, "uGarment", this.garmentTexture, 0);
    this.bindTexture(target, "uPersonMask", this.personTexture, 1);
    this.bindTexture(target, "uLighting", this.lighting.texture, 2);
    this.bindTexture(target, "uBlurredGarment", this.blurVertical.texture, 3);
    this.bindTexture(target, "uBlurredPerson", this.personBlurVertical.texture, 4);
    gl.uniform1i(gl.getUniformLocation(target, "uUseMask"), this.personMaskReady ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(target, "uMaskFlipY"), this.personMaskFlipY ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(target, "uMaskPass"), useShadow ? 0 : 1);
    gl.uniform1i(gl.getUniformLocation(target, "uUseShadow"), useShadow && this.quality.shadows ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(target, "uOpacity"), opacity);
    gl.uniform2f(gl.getUniformLocation(target, "uResolution"), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(target, "uArmRadius"), Math.max(8, this.canvas.width * 0.018));
    const arms = [
      pose.leftShoulder, pose.leftElbow ?? pose.leftWrist, pose.leftElbow ?? pose.leftShoulder, pose.leftWrist,
      pose.rightShoulder, pose.rightElbow ?? pose.rightWrist, pose.rightElbow ?? pose.rightShoulder, pose.rightWrist,
    ];
    const armValues = new Float32Array(16);
    for (let index = 0; index < 4; index++) {
      const a = arms[index * 2], b = arms[index * 2 + 1], offset = index * 4;
      if (a && b) armValues.set([a.x, a.y, b.x, b.y], offset);
      else armValues.set([-1, -1, -1, -1], offset);
    }
    gl.uniform4fv(gl.getUniformLocation(target, "uArms[0]"), armValues);
    const handValues = new Float32Array([
      pose.leftWrist?.x ?? -1, pose.leftWrist?.y ?? -1,
      pose.rightWrist?.x ?? -1, pose.rightWrist?.y ?? -1,
    ]);
    gl.uniform2fv(gl.getUniformLocation(target, "uHands[0]"), handValues);
    const shoulderMidY = (pose.leftShoulder.y + pose.rightShoulder.y) / 2;
    const shoulderWidth = Math.abs(pose.leftShoulder.x - pose.rightShoulder.x);
    const headX = pose.nose?.x ?? (pose.leftEar && pose.rightEar ? (pose.leftEar.x + pose.rightEar.x) / 2 : -1);
    const headY = pose.nose?.y ?? shoulderMidY - shoulderWidth * 0.55;
    gl.uniform4f(gl.getUniformLocation(target, "uHead"), headX, headY, Math.max(0.025, shoulderWidth * 0.3), Math.max(0.03, shoulderWidth * 0.28));
  }

  private drawMesh(vertexCount: number) {
    const gl = this.gl;
    const target = this.garmentProgram;
    this.bindTexture(target, "uGarment", this.garmentTexture, 0);
    this.bindTexture(target, "uPersonMask", this.personTexture, 1);
    this.bindTexture(target, "uLighting", this.lighting.texture, 2);
    this.bindTexture(target, "uBlurredGarment", this.blurVertical.texture, 3);
    this.bindTexture(target, "uBlurredPerson", this.personBlurVertical.texture, 4);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  private blurPass(source: WebGLTexture, destination: Target, x: number, y: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination.framebuffer);
    gl.viewport(0, 0, destination.width, destination.height);
    gl.useProgram(this.blurProgram);
    this.bindQuad(this.blurProgram);
    this.bindTexture(this.blurProgram, "uSource", source, 0);
    gl.uniform2f(gl.getUniformLocation(this.blurProgram, "uStep"), x / destination.width, y / destination.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private blurPersonMask() {
    this.blurPass(this.personTexture, this.personBlurHorizontal, 1, 0);
    this.blurPass(this.personBlurHorizontal.texture, this.personBlurVertical, 0, 1);
  }
}
