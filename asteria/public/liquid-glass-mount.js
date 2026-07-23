// liquid-glass-mount.js
//
// Подключает библиотеку liquid-glass (WebGL2 + SDF-рефракция, файлы в
// /lib/liquid-glass/ — vertex.glsl, fragment.glsl, webgl.js) к экрану чата
// «как есть», без единой правки самих шейдеров/утилит. Это не имитация
// blur-ом, а настоящий рефракционный "стеклянный" блик, который следует за
// курсором поверх фона переписки — тот же эффект, что в демо библиотеки.
//
// Никаких внешних сетевых картинок: в качестве фоновой текстуры берём
// локальные обои чата (--chat-wallpaper), а не unsplash-ссылку из демо.

import {
  compileShader,
  createProgram,
  createTexture,
  createMaskCanvas,
  createGradientCanvas,
} from '/lib/liquid-glass/webgl.js';

const STAGE_ID = 'liquidGlassStage';

let gl, program, uniforms = {}, vao, animationId = null;
let textureResolution = { width: 512, height: 512 };
let canvas = null;
let mounted = false;

const mouse = { x: 0.5, y: 0.5 };
const targetMouse = { x: 0.5, y: 0.5 };
const smoothing = 0.06;

// Параметры чуть мягче, чем в полноэкранном демо — это фон чата, а не
// самостоятельная витрина эффекта.
const params = {
  radius: 0.16,
  distort: 1.6,
  dispersion: 0.5,
  rotSpeed: 0.35,
  shadowIntensity: 0.22,
  shadowOffsetX: 0.01,
  shadowOffsetY: 0.05,
  shadowBlur: 0.45,
  highlightIntensity: 0.35,
  highlightSize: 1.2,
  highlightOffsetX: 0.01,
  highlightOffsetY: 0.02,
};

async function loadShaderSource(path) {
  const res = await fetch(path);
  return res.text();
}

async function initWebGL(stage) {
  canvas = document.createElement('canvas');
  canvas.id = 'liquidGlassCanvas';
  stage.appendChild(canvas);

  gl = canvas.getContext('webgl2');
  if (!gl) {
    console.warn('WebGL2 недоступен — эффект liquid-glass пропущен, остаётся CSS-стекло.');
    return false;
  }

  const [vertexSrc, fragmentSrc] = await Promise.all([
    loadShaderSource('/lib/liquid-glass/vertex.glsl'),
    loadShaderSource('/lib/liquid-glass/fragment.glsl'),
  ]);

  const vertexShader = compileShader(gl, vertexSrc, gl.VERTEX_SHADER);
  const fragmentShader = compileShader(gl, fragmentSrc, gl.FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) return false;

  program = createProgram(gl, vertexShader, fragmentShader);
  if (!program) return false;

  gl.useProgram(program);

  const uniformNames = [
    'uMVMatrix', 'uPMatrix', 'uTextureMatrix', 'uTexture', 'uMaskTexture',
    'uMousePos', 'uTMousePos', 'uResolution', 'uTextureResolution', 'uRadius', 'uDistort',
    'uDispersion', 'uRotSpeed', 'uShadowIntensity', 'uShadowOffsetX',
    'uShadowOffsetY', 'uShadowBlur', 'uHighlightIntensity', 'uHighlightSize',
    'uHighlightOffsetX', 'uHighlightOffsetY',
  ];
  uniformNames.forEach((name) => { uniforms[name] = gl.getUniformLocation(program, name); });

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  gl.uniformMatrix4fv(uniforms.uMVMatrix, false, identity);
  gl.uniformMatrix4fv(uniforms.uPMatrix, false, identity);
  gl.uniformMatrix4fv(uniforms.uTextureMatrix, false, identity);
  gl.uniform1i(uniforms.uTexture, 0);
  gl.uniform1i(uniforms.uMaskTexture, 1);

  setupGeometry();
  await setupTextures();
  resizeToStage(stage);
  return true;
}

function setupGeometry() {
  const quad = new Float32Array([
    -1, -1, 0, 0, 0,
     1, -1, 0, 1, 0,
    -1,  1, 0, 0, 1,
     1,  1, 0, 1, 1,
  ]);
  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'aVertexPosition');
  const uvLoc = gl.getAttribLocation(program, 'aTextureCoord');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 5 * 4, 0);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 5 * 4, 3 * 4);
}

function readWallpaperUrl() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--chat-wallpaper').trim();
  const match = raw.match(/url\((['"]?)(.*?)\1\)/);
  return match ? match[2] : '/wallpapers/default.webp';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function setupTextures() {
  try {
    const bgImage = await loadImage(readWallpaperUrl());
    createTexture(gl, 0, bgImage);
    textureResolution.width = bgImage.naturalWidth || 512;
    textureResolution.height = bgImage.naturalHeight || 512;
  } catch (e) {
    const bgCanvas = createGradientCanvas();
    createTexture(gl, 0, bgCanvas);
  }
  const maskCanvas = createMaskCanvas();
  createTexture(gl, 1, maskCanvas);
}

function resizeToStage(stage) {
  if (!gl || !canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function updateUniforms() {
  gl.uniform1f(uniforms.uRadius, params.radius);
  gl.uniform1f(uniforms.uDistort, params.distort);
  gl.uniform1f(uniforms.uDispersion, params.dispersion);
  gl.uniform1f(uniforms.uRotSpeed, params.rotSpeed);
  gl.uniform1f(uniforms.uShadowIntensity, params.shadowIntensity);
  gl.uniform1f(uniforms.uShadowOffsetX, params.shadowOffsetX);
  gl.uniform1f(uniforms.uShadowOffsetY, params.shadowOffsetY);
  gl.uniform1f(uniforms.uShadowBlur, params.shadowBlur);
  gl.uniform1f(uniforms.uHighlightIntensity, params.highlightIntensity);
  gl.uniform1f(uniforms.uHighlightSize, params.highlightSize);
  gl.uniform1f(uniforms.uHighlightOffsetX, params.highlightOffsetX);
  gl.uniform1f(uniforms.uHighlightOffsetY, params.highlightOffsetY);
}

function render() {
  if (!gl || !program) return;
  mouse.x += (targetMouse.x - mouse.x) * smoothing;
  mouse.y += (targetMouse.y - mouse.y) * smoothing;

  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform2fv(uniforms.uResolution, [canvas.width, canvas.height]);
  gl.uniform2fv(uniforms.uTextureResolution, [textureResolution.width, textureResolution.height]);
  gl.uniform2fv(uniforms.uMousePos, [mouse.x, mouse.y]);
  gl.uniform2fv(uniforms.uTMousePos, [targetMouse.x, targetMouse.y]);
  updateUniforms();

  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  animationId = requestAnimationFrame(render);
}

function handlePointerMove(event, stage) {
  const rect = stage.getBoundingClientRect();
  targetMouse.x = (event.clientX - rect.left) / rect.width;
  targetMouse.y = 1 - (event.clientY - rect.top) / rect.height;
  lastMoveAt = Date.now();
}

// Мягкий автономный дрейф блика, когда курсора давно не было над чатом
// (тач-устройства / фокус в другом окне) — чтобы стекло оставалось живым,
// а не замирало в одной точке.
let lastMoveAt = 0;
let driftT = 0;
function driftTick() {
  driftT += 0.0025 * params.rotSpeed * 4;
  if (document.hidden) return;
  if (Date.now() - lastMoveAt < 1500) return;
  targetMouse.x = 0.5 + Math.sin(driftT) * 0.28;
  targetMouse.y = 0.55 + Math.cos(driftT * 0.7) * 0.2;
}

export async function mountLiquidGlass() {
  if (mounted) return;
  const stage = document.getElementById(STAGE_ID);
  if (!stage) return;
  mounted = true;

  const ok = await initWebGL(stage);
  if (!ok) { mounted = false; return; }

  document.getElementById('chatActive')?.classList.add('lg-active');

  const ro = new ResizeObserver(() => resizeToStage(stage));
  ro.observe(stage);

  window.addEventListener('pointermove', (e) => handlePointerMove(e, stage));
  window.setInterval(driftTick, 16);

  render();
}

document.addEventListener('DOMContentLoaded', () => {
  mountLiquidGlass();
});
