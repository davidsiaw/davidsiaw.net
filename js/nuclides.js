// 3D chart of nuclides (source/playground/nuclides.weave).
// The nuclide data is embedded in the page at build time as #nuclides-data; this
// draws one bar per nuclide with WebGL2 (instanced cubes): neutrons along x,
// protons along z, height and colour from the half-life. Plain WebGL, no library.
(function () {
  var canvas = document.getElementById('nuclides-canvas');
  var info = document.getElementById('nuclides-info');
  var data = JSON.parse(document.getElementById('nuclides-data').textContent);
  var nuclides = data.nuclides;

  // band colours, indexed like the bands in the weave file (and .band-N in css/nuclides.css)
  var BAND_COLORS = [
    '#664253', // stable
    '#d4148e', // over a year
    '#d9434f', // 1 hour – 1 year
    '#e47c35', // 1 minute – 1 hour
    '#7cc4dc', // 1 second – 1 minute
    '#3b7fd4', // 1 ms – 1 second
    '#2a4fa8', // 1 µs – 1 ms
    '#1d2c6b', // under 1 µs
    '#3a3d52'  // unknown
  ];
  var BACKGROUND = [6 / 255, 8 / 255, 24 / 255];
  var GAP = 0.08; // between bars, in cell widths

  var gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) {
    canvas.parentNode.classList.add('nuclides-no-webgl');
    info.textContent = 'This chart needs WebGL 2, which this browser doesn’t provide.';
    return;
  }

  function hexColor(hex) {
    return [1, 3, 5].map(function (i) { return parseInt(hex.substr(i, 2), 16) / 255; });
  }

  // ---- labels: every bar's top shows its symbol and mass number

  var maxN = 0;
  var maxZ = 0;
  var maxA = 0;
  var symbols = [];
  nuclides.forEach(function (nuc) {
    maxN = Math.max(maxN, nuc.n);
    maxZ = Math.max(maxZ, nuc.z);
    maxA = Math.max(maxA, nuc.a);
    symbols[nuc.z] = nuc.symbol;
  });

  // A label is made of two atlas cells drawn over each other in the shader: the
  // element's symbol (cell Z, in the upper part) and the mass number (cell
  // SYMBOL_CELLS + A, in the lower part). That's ~420 cells rather than one per
  // nuclide (3,500). The text is white; the shader picks its colour per bar.
  var SYMBOL_CELLS = maxZ + 1;
  var cellCount = SYMBOL_CELLS + maxA + 1;

  // laid out for 96px cells; on a GPU whose textures can't hold them all at that
  // size (WebGL2 only promises 2048px) the cells shrink to fit
  var ATLAS_SIZE = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  var CELL = 96;
  while (Math.ceil(cellCount / Math.floor(ATLAS_SIZE / CELL)) * CELL > ATLAS_SIZE) CELL -= 8;
  var ATLAS_COLS = Math.floor(ATLAS_SIZE / CELL);
  var atlasRows = Math.ceil(cellCount / ATLAS_COLS);
  var atlas = document.createElement('canvas');
  atlas.width = ATLAS_COLS * CELL;
  atlas.height = atlasRows * CELL;
  var ctx = atlas.getContext('2d');
  ctx.scale(CELL / 96, CELL / 96);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  function drawCell(i, text, font, baseline) {
    // in 96px-cell units (the context is scaled)
    ctx.font = font;
    ctx.fillText(text, (i % ATLAS_COLS) * 96 + 48, Math.floor(i / ATLAS_COLS) * 96 + baseline);
  }
  symbols.forEach(function (symbol, z) {
    if (symbol) drawCell(z, symbol, '600 46px system-ui, -apple-system, "Segoe UI", sans-serif', 52);
  });
  for (var a = 1; a <= maxA; a++) {
    drawCell(SYMBOL_CELLS + a, String(a), '500 28px system-ui, -apple-system, "Segoe UI", sans-serif', 84);
  }

  // ---- geometry: a unit cube (x, z in 0..1, y in 0..1) with normals

  var faces = [
    // normal, then 4 corners counter-clockwise seen from outside
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
    [[0, 0, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, -1], [1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    [[1, 0, 0], [1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
    [[-1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]
    // no bottom face: it's never seen (the camera stays above the chart)
  ];
  var cube = [];
  faces.forEach(function (f) {
    [1, 2, 3, 1, 3, 4].forEach(function (c) { cube.push.apply(cube, f[c].concat(f[0])); });
  });
  var CUBE_VERTICES = cube.length / 6;

  // ---- instances: [x, z, height, label] + [r, g, b] for every bar
  // label = Z * 512 + A (exact in a float); the shader splits it back into the two cells

  var count = nuclides.length;
  var inst = new Float32Array(count * 7);
  var bandColors = BAND_COLORS.map(hexColor);
  nuclides.forEach(function (nuc, i) {
    // a cell's left edge sits at x = n, its far edge at z = -z - 1 (protons go away from the viewer)
    inst.set([nuc.n + GAP / 2, -nuc.z - 1 + GAP / 2, nuc.height, nuc.z * 512 + nuc.a], i * 7);
    inst.set(bandColors[nuc.band], i * 7 + 4);
  });

  // ---- shaders

  var VERTEX = [
    '#version 300 es',
    'layout(location = 0) in vec3 a_pos;',
    'layout(location = 1) in vec3 a_normal;',
    'layout(location = 2) in vec4 a_inst;', // x, z, height, label index
    'layout(location = 3) in vec3 a_color;',
    'uniform mat4 u_viewProj;',
    'uniform float u_size;',
    'uniform int u_hover;',
    'uniform int u_selected;',
    'out vec3 v_normal;',
    'out vec3 v_local;', // position within the bar, in world units
    'out vec3 v_extent;', // the bar's size, in world units
    'out vec3 v_color;',
    // flat: one value per bar, not interpolated (an interpolated 62.9999 picks the wrong label)
    'flat out int v_label;',
    'flat out int v_highlight;',
    'out vec2 v_uv;',
    'void main() {',
    '  vec3 size = vec3(u_size, a_inst.z, u_size);',
    '  v_local = a_pos * size;',
    '  v_extent = size;',
    '  vec3 world = vec3(a_inst.x, 0.0, a_inst.y) + v_local;',
    '  v_normal = a_normal;',
    '  v_color = a_color;',
    '  v_label = int(round(a_inst.w));',
    '  v_uv = a_pos.xz;',
    '  v_highlight = gl_InstanceID == u_selected ? 2 : (gl_InstanceID == u_hover ? 1 : 0);',
    '  gl_Position = u_viewProj * vec4(world, 1.0);',
    '}'
  ].join('\n');

  var FRAGMENT = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 v_normal;',
    'in vec3 v_local;',
    'in vec3 v_extent;',
    'in vec3 v_color;',
    'flat in int v_label;',
    'flat in int v_highlight;',
    'in vec2 v_uv;',
    'uniform sampler2D u_atlas;',
    'uniform ivec2 u_atlasCells;', // columns, rows
    'uniform int u_symbolCells;', // number cells start after the symbols
    'out vec4 outColor;',
    'vec2 cellOrigin(int i) {',
    '  return vec2(i % u_atlasCells.x, i / u_atlasCells.x);',
    '}',
    'void main() {',
    '  vec3 n = normalize(v_normal);',
    '  vec3 light = normalize(vec3(-0.35, 0.85, 0.45));',
    '  float diffuse = 0.42 + 0.58 * max(dot(n, light), 0.0);',
    '  vec3 color = v_color;',
    // the label: symbol (cell Z) over mass number (cell u_symbolCells + A). Sampled
    // outside the top-face branch so the mipmap derivatives are well defined
    '  vec2 cells = vec2(u_atlasCells);',
    '  float ink = max(',
    '    texture(u_atlas, (cellOrigin(v_label / 512) + v_uv) / cells).a,',
    '    texture(u_atlas, (cellOrigin(u_symbolCells + v_label % 512) + v_uv) / cells).a);',
    // fade the text out as the bar's top shrinks below ~16px on screen (square root of
    // its area, so tilted tops aren't faded too early), where it would only be noise
    '  vec2 w = max(fwidth(v_uv), vec2(1e-4));',
    '  float topPx = inversesqrt(w.x * w.y);',
    '  ink *= smoothstep(8.0, 16.0, topPx);',
    '  if (n.y > 0.5) {',
    // dark text on light bars, light text on the rest
    '    bool lightBar = dot(v_color, vec3(0.2126, 0.7152, 0.0722)) > 0.6;',
    '    color = mix(color, lightBar ? vec3(0.06, 0.07, 0.16) : vec3(0.93, 0.89, 0.91), ink * 0.92);',
    '  }',
    // darken a thin band along every edge so neighbouring bars of one colour stay distinct
    '  vec2 face = n.y > 0.5 ? v_local.xz : (abs(n.x) > 0.5 ? v_local.zy : v_local.xy);',
    '  vec2 extent = n.y > 0.5 ? v_extent.xz : (abs(n.x) > 0.5 ? v_extent.zy : v_extent.xy);',
    '  vec2 d = min(face, extent - face);',
    '  float edge = smoothstep(0.0, 0.05, min(d.x, d.y));',
    '  color *= diffuse * mix(0.72, 1.0, edge);',
    '  if (v_highlight == 2) color = mix(color, vec3(1.0), 0.3);',
    '  else if (v_highlight == 1) color = mix(color, vec3(1.0), 0.15);',
    '  outColor = vec4(color, 1.0);',
    '}'
  ].join('\n');

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  var program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  var uniforms = {};
  ['u_viewProj', 'u_size', 'u_hover', 'u_selected', 'u_atlas', 'u_atlasCells', 'u_symbolCells'].forEach(function (name) {
    uniforms[name] = gl.getUniformLocation(program, name);
  });

  var vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cube), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 0);
  gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 28, 16);
  gl.vertexAttribDivisor(3, 1);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) {
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
      Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  gl.uniform1i(uniforms.u_atlas, 0);
  gl.uniform2i(uniforms.u_atlasCells, ATLAS_COLS, atlasRows);
  gl.uniform1i(uniforms.u_symbolCells, SYMBOL_CELLS);
  gl.uniform1f(uniforms.u_size, 1 - GAP);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);

  // ---- camera: orbits a target point on the ground

  var FOV = 45 * Math.PI / 180;
  var HOME = { x: 70, y: 0, z: -45, yaw: -0.35, pitch: 0.62, dist: 175 };
  var cam = homeView();
  var flight = null;

  // the home view frames the whole chart; on narrow (portrait) canvases back off so it still fits
  function homeView() {
    var view = copyView(HOME);
    var aspect = canvas.clientWidth / canvas.clientHeight;
    if (aspect < 1.5) view.dist *= Math.min(2, Math.sqrt(1.5 / aspect));
    return view;
  }

  function copyView(v) {
    return { x: v.x, y: v.y, z: v.z, yaw: v.yaw, pitch: v.pitch, dist: v.dist };
  }

  function basis() {
    var cp = Math.cos(cam.pitch);
    var back = [cp * Math.sin(cam.yaw), Math.sin(cam.pitch), cp * Math.cos(cam.yaw)];
    var eye = [cam.x + back[0] * cam.dist, cam.y + back[1] * cam.dist, cam.z + back[2] * cam.dist];
    var right = norm(cross([0, 1, 0], back));
    var up = cross(back, right);
    return { eye: eye, forward: [-back[0], -back[1], -back[2]], right: right, up: up };
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(v) {
    var l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function viewProj(b, aspect) {
    var f = 1 / Math.tan(FOV / 2);
    var near = Math.max(0.1, cam.dist / 100);
    var far = cam.dist + 600;
    var r = b.right, u = b.up, k = [-b.forward[0], -b.forward[1], -b.forward[2]], e = b.eye;
    var dot = function (a, c) { return a[0] * c[0] + a[1] * c[1] + a[2] * c[2]; };
    // view matrix rows (column-major in the final array)
    var view = [
      r[0], u[0], k[0], 0,
      r[1], u[1], k[1], 0,
      r[2], u[2], k[2], 0,
      -dot(r, e), -dot(u, e), -dot(k, e), 1
    ];
    var proj = [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, 2 * far * near / (near - far), 0
    ];
    var out = new Float32Array(16);
    for (var col = 0; col < 4; col++) {
      for (var row = 0; row < 4; row++) {
        var sum = 0;
        for (var i = 0; i < 4; i++) sum += proj[i * 4 + row] * view[col * 4 + i];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }

  // the ray from the eye through a point on the canvas (CSS pixels)
  function ray(px, py) {
    var b = basis();
    var t = Math.tan(FOV / 2);
    var sx = (px / canvas.clientWidth * 2 - 1) * t * canvas.clientWidth / canvas.clientHeight;
    var sy = (1 - py / canvas.clientHeight * 2) * t;
    return {
      origin: b.eye,
      dir: norm([0, 1, 2].map(function (i) { return b.forward[i] + b.right[i] * sx + b.up[i] * sy; }))
    };
  }

  // the nearest nuclide bar a ray hits (slab test against each box), or -1
  function pick(px, py) {
    var r = ray(px, py);
    var o = r.origin, d = r.dir;
    var size = 1 - GAP;
    var best = -1, bestT = Infinity;
    for (var i = 0; i < nuclides.length; i++) {
      var x0 = inst[i * 7], z0 = inst[i * 7 + 1], h = inst[i * 7 + 2];
      var lo = [x0, 0, z0], hi = [x0 + size, h, z0 + size];
      var tmin = 0, tmax = bestT;
      for (var a = 0; a < 3 && tmin <= tmax; a++) {
        var inv = 1 / d[a];
        var t1 = (lo[a] - o[a]) * inv, t2 = (hi[a] - o[a]) * inv;
        if (t1 > t2) { var s = t1; t1 = t2; t2 = s; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
      }
      if (tmin <= tmax) { best = i; bestT = tmin; }
    }
    return best;
  }

  // where a ray meets the ground plane, or null if it points upwards
  function ground(px, py) {
    var r = ray(px, py);
    if (r.dir[1] > -1e-4) return null;
    var t = -r.origin[1] / r.dir[1];
    return [r.origin[0] + r.dir[0] * t, 0, r.origin[2] + r.dir[2] * t];
  }

  // ---- drawing, on demand

  var hover = -1;
  var selected = -1;
  var frameQueued = false;

  function draw() {
    frameQueued = false;
    if (flight) stepFlight();

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uniforms.u_viewProj, false, viewProj(basis(), w / h));
    gl.uniform1i(uniforms.u_hover, hover);
    gl.uniform1i(uniforms.u_selected, selected);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, CUBE_VERTICES, count);

    if (flight) redraw();
  }

  function redraw() {
    if (!frameQueued) {
      frameQueued = true;
      requestAnimationFrame(draw);
    }
  }

  new ResizeObserver(redraw).observe(canvas);

  // ---- smooth camera moves (go to, reset, top view)

  function flyTo(view) {
    var from = copyView(cam);
    // turn the short way round
    var turn = (view.yaw - from.yaw) % (2 * Math.PI);
    if (turn > Math.PI) turn -= 2 * Math.PI;
    if (turn < -Math.PI) turn += 2 * Math.PI;
    flight = { from: from, to: view, turn: turn, start: performance.now(), ms: 700 };
    redraw();
  }

  function stepFlight() {
    var t = Math.min(1, (performance.now() - flight.start) / flight.ms);
    var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    var f = flight.from, to = flight.to;
    ['x', 'y', 'z', 'pitch'].forEach(function (k) { cam[k] = f[k] + (to[k] - f[k]) * e; });
    cam.yaw = f.yaw + flight.turn * e;
    // zoom geometrically, so it doesn't rush through the near end
    cam.dist = f.dist * Math.pow(to.dist / f.dist, e);
    if (t >= 1) flight = null;
  }

  // ---- info panel

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showInfo(i) {
    if (i < 0) {
      info.innerHTML = '';
      info.classList.remove('nuclides-info-open');
      return;
    }
    var nuc = nuclides[i];
    var title = nuc.z === 0 ? 'Neutron' : nuc.name + '-' + nuc.a;
    var rows = [
      ['protons', nuc.z],
      ['neutrons', nuc.n],
      ['half-life', nuc.half_life],
      ['decay', nuc.decay],
      ['natural abundance', nuc.abundance],
      ['spin & parity', nuc.spin],
      ['discovered', nuc.discovered]
    ].filter(function (row) { return row[1] !== undefined && row[1] !== ''; });

    info.innerHTML =
      '<div class="nuclides-info-head">' +
        '<span class="nuclides-info-tile band-' + nuc.band + '">' +
          '<sup>' + nuc.a + '</sup>' + esc(nuc.symbol) +
        '</span>' +
        '<div><strong>' + esc(title) + '</strong>' +
        '<span class="nuclides-info-band">' + esc(data.bands[nuc.band]) + '</span></div>' +
      '</div>' +
      '<dl>' + rows.map(function (row) {
        return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
      }).join('') + '</dl>';
    info.classList.add('nuclides-info-open');
  }

  function shownInfo() {
    showInfo(hover >= 0 ? hover : selected);
  }

  function select(i) {
    selected = i;
    shownInfo();
    redraw();
  }

  // ---- pointer: drag to rotate, right/shift-drag or two fingers to pan, wheel or pinch to zoom

  var pointers = {};
  var gesture = null;

  function pointerList() {
    return Object.keys(pointers).map(function (id) { return pointers[id]; });
  }

  function local(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function rotate(dx, dy) {
    cam.yaw -= dx * 0.006;
    cam.pitch = Math.max(0.08, Math.min(Math.PI / 2 - 0.001, cam.pitch + dy * 0.006));
  }

  function pan(dx, dy) {
    // move the target across the ground so the chart follows the pointer
    var scale = 2 * Math.tan(FOV / 2) * cam.dist / canvas.clientHeight;
    var s = Math.sin(cam.yaw), c = Math.cos(cam.yaw);
    // screen-down drag moves the target away from the viewer along the ground
    var forward = dy * scale / Math.max(Math.sin(cam.pitch), 0.35);
    cam.x += -dx * scale * c - forward * s;
    cam.z += dx * scale * s - forward * c;
    clampTarget();
  }

  function zoom(factor, px, py) {
    var before = ground(px, py);
    var dist = Math.max(4, Math.min(450, cam.dist * factor));
    var applied = dist / cam.dist;
    cam.dist = dist;
    // keep the point under the pointer where it is
    if (before) {
      cam.x = before[0] + (cam.x - before[0]) * applied;
      cam.z = before[2] + (cam.z - before[2]) * applied;
      clampTarget();
    }
  }

  function clampTarget() {
    cam.x = Math.max(-20, Math.min(maxN + 20, cam.x));
    cam.z = Math.max(-maxZ - 20, Math.min(20, cam.z));
  }

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('pointerdown', function (e) {
    // keep receiving moves when the drag leaves the canvas (throws if the pointer is already gone)
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* drag still works inside the canvas */ }
    flight = null;
    var p = local(e);
    pointers[e.pointerId] = { x: p.x, y: p.y, startX: p.x, startY: p.y };
    var list = pointerList();
    gesture = list.length === 1
      ? { mode: e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'rotate', moved: false }
      : { mode: 'pinch', moved: true, span: span(list), mid: mid(list) };
    if (e.pointerType !== 'mouse') hover = -1;
  });

  function span(list) {
    return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  }
  function mid(list) {
    return { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 };
  }

  canvas.addEventListener('pointermove', function (e) {
    var p = local(e);
    var ptr = pointers[e.pointerId];
    if (!ptr) {
      if (e.pointerType === 'mouse') {
        var hit = pick(p.x, p.y);
        if (hit !== hover) {
          hover = hit;
          canvas.style.cursor = hit >= 0 ? 'pointer' : '';
          shownInfo();
          redraw();
        }
      }
      return;
    }
    var dx = p.x - ptr.x, dy = p.y - ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;
    if (Math.hypot(p.x - ptr.startX, p.y - ptr.startY) > 4) gesture.moved = true;
    if (!gesture.moved) return;

    if (gesture.mode === 'pinch') {
      var list = pointerList();
      if (list.length < 2) return;
      var s = span(list), m = mid(list);
      pan(m.x - gesture.mid.x, m.y - gesture.mid.y);
      if (s > 0 && gesture.span > 0) zoom(gesture.span / s, m.x, m.y);
      gesture.span = s;
      gesture.mid = m;
    } else if (gesture.mode === 'pan') {
      pan(dx, dy);
    } else {
      rotate(dx, dy);
    }
    redraw();
  });

  function pointerEnd(e) {
    var ptr = pointers[e.pointerId];
    if (!ptr) return;
    delete pointers[e.pointerId];
    if (gesture && !gesture.moved && e.type === 'pointerup') {
      // a click (or tap): select what's under it, or clear the selection
      var hit = pick(ptr.x, ptr.y);
      select(hit === selected ? -1 : hit);
    }
    var list = pointerList();
    // lifting one finger of a pinch carries on as a one-finger drag, without a jump
    gesture = list.length ? { mode: 'rotate', moved: true } : null;
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);

  canvas.addEventListener('pointerleave', function () {
    if (hover >= 0) {
      hover = -1;
      shownInfo();
      redraw();
    }
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    flight = null;
    var p = local(e);
    // pixels, lines or pages; trackpad pinches arrive as ctrl+wheel with small deltas
    var delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    zoom(Math.exp(delta * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    redraw();
  }, { passive: false });

  // ---- keyboard, when the canvas has focus

  canvas.addEventListener('keydown', function (e) {
    var step = 40;
    var handled = true;
    if (e.key === 'ArrowLeft') e.shiftKey ? rotate(-step, 0) : pan(step, 0);
    else if (e.key === 'ArrowRight') e.shiftKey ? rotate(step, 0) : pan(-step, 0);
    else if (e.key === 'ArrowUp') e.shiftKey ? rotate(0, -step) : pan(0, step);
    else if (e.key === 'ArrowDown') e.shiftKey ? rotate(0, step) : pan(0, -step);
    else if (e.key === '+' || e.key === '=') zoom(0.8, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (e.key === '-' || e.key === '_') zoom(1.25, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (e.key === 'Escape') select(-1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      flight = null;
      redraw();
    }
  });

  // ---- toolbar

  document.getElementById('nuclides-reset').addEventListener('click', function () {
    flyTo(homeView());
  });

  document.getElementById('nuclides-top').addEventListener('click', function () {
    flyTo({ x: maxN / 2, y: 0, z: -maxZ / 2, yaw: 0, pitch: Math.PI / 2 - 0.001, dist: 210 });
  });

  // "U-238", "u238", "238U", "uranium 238", "Og", "iron": a nuclide, or an element's
  // main nuclide (most abundant, else longest-lived; chosen in the weave file)
  function find(query) {
    var m = query.trim().toLowerCase().match(/^([a-z]+)\s*-?\s*(\d+)?$/) ||
            query.trim().toLowerCase().match(/^(\d+)\s*-?\s*([a-z]+)$/);
    if (!m) return -1;
    var word = isNaN(m[1]) ? m[1] : m[2];
    var mass = isNaN(m[1]) ? m[2] : m[1];
    var matches = nuclides.filter(function (nuc) {
      return nuc.symbol.toLowerCase() === word || nuc.name.toLowerCase() === word;
    });
    matches = matches.filter(function (nuc) { return mass ? nuc.a === +mass : nuc.main; });
    return matches.length ? nuclides.indexOf(matches[0]) : -1;
  }

  var findInput = document.getElementById('nuclides-find-input');
  document.getElementById('nuclides-find').addEventListener('submit', function (e) {
    e.preventDefault();
    var i = find(findInput.value);
    findInput.classList.toggle('nuclides-find-miss', i < 0);
    if (i < 0) return;
    var nuc = nuclides[i];
    select(i);
    flyTo({
      x: nuc.n + 0.5, y: nuc.height / 2, z: -nuc.z - 0.5,
      yaw: cam.yaw, pitch: Math.max(cam.pitch, 0.6), dist: 28
    });
  });
  findInput.addEventListener('input', function () {
    findInput.classList.remove('nuclides-find-miss');
  });

  redraw();
})();
