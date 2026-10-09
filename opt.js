/* CDFT geometry optimization: status, figures, and the 3Dmol.js trajectory viewer. */
(() => {
  const COLORS = ['#111', '#c00000', '#0070c0', '#548235', '#7030a0', '#ed7d31'];
  const DASHES = [[], [5, 3], [2, 2], [6, 2, 2, 2], [8, 3], [1, 2]];
  const DN_ALL = [0.1, 0.2, 0.5, 1.0, 1.5, 2.0];
  const EL = {
    Pt: { c: '#d4a017', bs: 0.62, sf: 1.39 },
    Sr: { c: '#5cb85c', bs: 0.55, sf: 1.55 },
    Ti: { c: '#8fa3bf', bs: 0.45, sf: 1.15 },
    O: { c: '#d62728', bs: 0.36, sf: 1.05 },
    H: { c: '#f2f2f2', bs: 0.22, sf: 0.55 },
    K: { c: '#8e44ad', bs: 0.60, sf: 1.60 },
  };
  const $ = id => document.getElementById(id);
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('static') && window.Chart) Chart.defaults.animation = false;
  const fmt = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
  const sgn = (x, d = 3) => (x === null || x === undefined ? '—' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d));

  let OPT = null;
  let viewer = null;
  let T = null;
  let frame = 0;
  let timer = null;
  let mini = null;
  let needZoom = true;
  let loadToken = 0;
  const cache = new Map();

  const axisOpts = (xTitle, yTitle, extraY = {}) => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom',
        labels: {
          boxWidth: 16, font: { size: 9 }, color: '#111', padding: 8,
          filter: item => !item.text.endsWith('(fixed)'),
        },
      },
    },
    scales: {
      x: {
        type: 'linear', min: 0, max: 2.05,
        title: { display: true, text: xTitle, font: { size: 11 }, color: '#111' },
        ticks: { color: '#111', stepSize: 0.5, callback: v => (v <= 2.0001 ? v : '') },
        grid: { color: '#e8e8e8' }, border: { color: '#111' },
      },
      y: {
        title: { display: true, text: yTitle, font: { size: 11 }, color: '#111' },
        ticks: { color: '#111' },
        grid: { color: '#e8e8e8' }, border: { color: '#111' },
        ...extraY,
      },
    },
  });

  const converged = s => s.points.filter(p => p.status === 'converged');

  /* ---------- tables ---------- */
  function buildStatus() {
    let html = '<thead><tr><th>System</th>' + DN_ALL.map(d => `<th>Δn = ${d.toFixed(1)}</th>`).join('') + '</tr></thead><tbody>';
    let nConv = 0, nRun = 0, nAll = 0;
    OPT.systems.forEach(s => {
      html += `<tr><td>${s.title}</td>`;
      DN_ALL.forEach(dn => {
        const p = s.points.find(q => Math.abs(q.dn - dn) < 1e-6);
        nAll += 1;
        if (!p || p.status === 'missing') { html += '<td class="miss">—</td>'; return; }
        if (p.status === 'converged') { nConv += 1; html += `<td class="ok">✓ ${p.steps}</td>`; return; }
        nRun += 1;
        const steps = p.frames ? p.frames - 1 : 0;
        const word = p.status === 'running' ? 'running' : 'interrupted';
        html += `<td class="run">${word} · ${steps}, ${fmt(p.fmax_last, 2)}</td>`;
      });
      html += '</tr>';
    });
    $('opt-status').innerHTML = html + '</tbody>';
    $('opt-progress').innerHTML =
      `Status: <b>${nConv}/${nAll}</b> converged; ${nRun} still running (resumed from their trajectories after a node failure on 1&nbsp;October). Data exported ${OPT.generated}.`;
    const d = new Date(OPT.generated.replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) {
      $('opt-updated').textContent = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    }
  }

  function buildTable() {
    const head = ['System', 'Δn', 'Q_ach.', 'Steps', 'f_max', 'ΔE_opt (eV)', 'ΔE_fixed', 'λ_opt (eV)', 'λ_fixed', 'max|d| Pt (Å)', 'max|d| solv.'];
    let html = '<thead><tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    OPT.systems.forEach(s => converged(s).forEach(p => {
      html += `<tr><td>${s.title}</td><td>${p.dn.toFixed(1)}</td><td>${fmt(p.Q_achieved, 4)}</td>` +
        `<td>${p.steps}</td><td>${fmt(p.fmax, 3)}</td>` +
        `<td><b>${sgn(p.dE_opt)}</b></td><td>${p.dE_fixed === null ? '—' : sgn(p.dE_fixed)}</td>` +
        `<td>${fmt(p.lambda_opt, 3)}</td><td>${p.lambda_fixed === null ? '—' : fmt(p.lambda_fixed, 3)}</td>` +
        `<td>${fmt(p.pt_max_disp, 3)}</td><td>${s.id.endsWith('vacuum') ? '—' : fmt(p.solvent_max_disp, 2)}</td></tr>`;
    }));
    $('opt-table').innerHTML = html + '</tbody>';
  }

  /* ---------- static figures ---------- */
  function lineDs(label, pts, i, faint) {
    return {
      label,
      data: pts,
      borderColor: faint ? COLORS[i] + '55' : COLORS[i],
      backgroundColor: 'transparent',
      borderDash: faint ? [3, 3] : DASHES[i],
      borderWidth: faint ? 1 : 1.75,
      pointRadius: faint ? 0 : 3.5,
      pointBackgroundColor: COLORS[i],
      tension: 0,
    };
  }

  function buildCharts() {
    const eSets = [], lSets = [], dSets = [];
    OPT.systems.forEach((s, i) => {
      const c = converged(s);
      eSets.push(lineDs(s.title, [{ x: 0, y: 0 }, ...c.map(p => ({ x: p.dn, y: +p.dE_opt.toFixed(4) }))], i, false));
      lSets.push(lineDs(s.title, [{ x: 0, y: 0 }, ...c.map(p => ({ x: p.dn, y: +p.lambda_opt.toFixed(4) }))], i, false));
      const fixed = c.filter(p => p.dE_fixed !== null);
      eSets.push(lineDs(`${s.title} (fixed)`, [{ x: 0, y: 0 }, ...fixed.map(p => ({ x: p.dn, y: +p.dE_fixed.toFixed(4) }))], i, true));
      lSets.push(lineDs(`${s.title} (fixed)`, [{ x: 0, y: 0 }, ...fixed.map(p => ({ x: p.dn, y: +p.lambda_fixed.toFixed(4) }))], i, true));
      dSets.push(lineDs(s.title, c.map(p => ({ x: p.dn, y: Math.max(p.pt_max_disp, 1e-3) })), i, false));
    });
    new Chart($('chart-opt-e'), { type: 'line', data: { datasets: eSets }, options: axisOpts('Δn (e⁻ on Pt₆)', 'ΔE vs neutral (eV)') });
    new Chart($('chart-opt-lam'), { type: 'line', data: { datasets: lSets }, options: axisOpts('Δn (e⁻ on Pt₆)', 'λ (eV)') });
    new Chart($('chart-opt-disp'), {
      type: 'line',
      data: { datasets: dSets },
      options: axisOpts('Δn (e⁻ on Pt₆)', 'max Pt displacement (Å)', { type: 'logarithmic', min: 0.001, max: 5 }),
    });
  }

  /* ---------- 3D viewer ---------- */
  function fillSystems() {
    const sel = $('v-sys');
    sel.innerHTML = OPT.systems.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
    const want = urlParams.get('sys') || 'Vo-interface-vacuum';
    sel.value = OPT.systems.some(s => s.id === want) ? want : OPT.systems[0].id;
  }

  function syncUrl() {
    const u = new URL(window.location.href);
    u.searchParams.set('sys', $('v-sys').value);
    u.searchParams.set('traj', $('v-traj').value);
    window.history.replaceState(null, '', u);
  }

  function fillTrajs(preferTag) {
    const s = OPT.systems.find(q => q.id === $('v-sys').value);
    const opts = [`<option value="series">Δn series: neutral → each converged Δn (${converged(s).length + 1} frames)</option>`];
    s.points.filter(p => p.file).forEach(p => {
      const steps = p.frames - 1;
      const note = p.status === 'converged' ? `✓ converged, ${steps} steps` : `${p.status}, ${steps} steps so far`;
      opts.push(`<option value="${p.tag}">Δn = ${p.dn.toFixed(1)} optimization (${note})</option>`);
    });
    const sel = $('v-traj');
    sel.innerHTML = opts.join('');
    const tags = [...sel.options].map(o => o.value);
    sel.value = tags.includes(preferTag) ? preferTag : 'series';
  }

  async function getTraj(label, tag) {
    const key = `${label}/${tag}`;
    if (!cache.has(key)) {
      cache.set(key, fetch(`traj/${key}.json`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${key}`);
        return r.json();
      }));
    }
    return cache.get(key);
  }

  async function load() {
    stop();
    const token = ++loadToken;
    const label = $('v-sys').value;
    const tag = $('v-traj').value;
    $('v-readout').textContent = 'Loading trajectory…';
    let t;
    try {
      t = await getTraj(label, tag);
    } catch (e) {
      $('v-readout').textContent = `Could not load trajectory: ${e.message}`;
      return;
    }
    if (token !== loadToken) return;
    if (urlParams.has('sys') || T) syncUrl();
    T = t;
    T.n = T.symbols.length;
    T.nf = T.pos.length;
    T.solventSet = new Set(T.solvent);
    T.isSeries = tag === 'series';
    T.xs = T.isSeries ? T.dn : T.E.map((_, i) => i);
    const s = OPT.systems.find(q => q.id === label);
    T.point = s.points.find(p => p.tag === tag) || null;
    T.title = s.title;
    $('v-slider').max = String(T.nf - 1);
    frame = 0;
    if (urlParams.has('frame')) {
      const f = Number(urlParams.get('frame'));
      frame = f < 0 ? T.nf - 1 : Math.min(Math.max(f, 0), T.nf - 1);
      urlParams.delete('frame');
    }
    buildLegend();
    buildMini();
    draw();
  }

  function frameAtoms(f, withRep) {
    const P = T.pos[f], C = T.cell;
    const hideSolv = !$('v-solvent').checked;
    const shifts = withRep && $('v-rep').checked ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]];
    const out = [];
    for (const [a, b] of shifts) {
      for (let k = 0; k < T.n; k++) {
        if (hideSolv && T.solventSet.has(k)) continue;
        out.push({
          k, home: a === 0 && b === 0, el: T.symbols[k],
          x: P[3 * k] + a * C[0][0] + b * C[1][0],
          y: P[3 * k + 1] + a * C[0][1] + b * C[1][1],
          z: P[3 * k + 2] + a * C[0][2] + b * C[1][2],
        });
      }
    }
    return out;
  }

  function applyStyle() {
    const st = $('v-style').value;
    viewer.setStyle({}, { sphere: { radius: 0.4, color: '#999' }, stick: { radius: 0.11, color: '#999' } });
    Object.entries(EL).forEach(([el, p]) => {
      let s;
      if (st === 'sf') s = { sphere: { radius: p.sf, color: p.c } };
      else if (st === 'lic') s = { stick: { radius: el === 'Pt' ? 0.24 : 0.16, color: p.c }, sphere: { radius: el === 'Pt' ? 0.48 : 0.16, color: p.c } };
      else s = { sphere: { radius: p.bs, color: p.c }, stick: { radius: 0.11, color: p.c } };
      viewer.setStyle({ elem: el }, s);
    });
  }

  function drawCell() {
    const m = $('v-rep').checked ? 2 : 1;
    const [a, b, c] = T.cell;
    const v = (i, j, k) => ({
      x: i * m * a[0] + j * m * b[0] + k * c[0],
      y: i * m * a[1] + j * m * b[1] + k * c[1],
      z: i * m * a[2] + j * m * b[2] + k * c[2],
    });
    const edges = [];
    for (const j of [0, 1]) for (const k of [0, 1]) edges.push([v(0, j, k), v(1, j, k)]);
    for (const i of [0, 1]) for (const k of [0, 1]) edges.push([v(i, 0, k), v(i, 1, k)]);
    for (const i of [0, 1]) for (const j of [0, 1]) edges.push([v(i, j, 0), v(i, j, 1)]);
    edges.forEach(([s, e]) => viewer.addCylinder({ start: s, end: e, radius: 0.035, color: '#555', fromCap: 1, toCap: 1 }));
  }

  function resetView(kind) {
    if (!viewer) return;
    viewer.removeAllShapes();
    viewer.zoomTo();
    const v = viewer.getView();
    const q = kind === 'top' ? [0, 0, 0, 1] : [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    v[4] = q[0]; v[5] = q[1]; v[6] = q[2]; v[7] = q[3];
    viewer.setView(v);
    viewer.zoomTo();
    if ($('v-cell').checked) drawCell();
    viewer.render();
  }

  function draw() {
    if (!T) return;
    if (viewer) render3D();
    $('v-slider').value = String(frame);
    readout();
    if (mini) mini.update('none');
  }

  function render3D() {
    const atoms = frameAtoms(frame, true);
    const xyz = `${atoms.length}\nframe ${frame}\n` +
      atoms.map(a => `${a.el} ${a.x.toFixed(3)} ${a.y.toFixed(3)} ${a.z.toFixed(3)}`).join('\n');
    viewer.removeAllModels();
    viewer.removeAllLabels();
    viewer.removeAllShapes();
    viewer.addModel(xyz, 'xyz');
    applyStyle();
    if (needZoom) { resetView('side'); needZoom = false; } else if ($('v-cell').checked) drawCell();
    if ($('v-label').checked) {
      atoms.filter(a => a.home && a.el === 'Pt').forEach(a => viewer.addLabel(`Pt${a.k}`, {
        position: { x: a.x, y: a.y, z: a.z }, fontSize: 11, fontColor: '#111', font: 'Times New Roman',
        backgroundColor: '#ffffff', backgroundOpacity: 0.8, borderColor: '#d4a017', borderThickness: 1, inFront: true,
      }));
    }
    viewer.render();
  }

  function readout() {
    const E = T.E[frame];
    if (T.isSeries) {
      const dn = T.dn[frame];
      const what = dn === 0 ? 'neutral relaxed structure (no constraint)' : `optimized at Δn = ${dn.toFixed(1)}`;
      $('v-readout').innerHTML = `<b>${T.title}</b> · frame ${frame + 1}/${T.nf}: ${what} · E = ${E.toFixed(4)} eV · ΔE vs neutral = <b>${sgn(E - T.E[0])} eV</b>`;
      return;
    }
    const last = frame === T.nf - 1;
    const p = T.point;
    let tail = '';
    if (last && p && p.status === 'converged') tail = ' · <span style="color:var(--ok)"><b>converged</b></span>';
    else if (last && p) tail = ` · <span style="color:#9a6700"><i>${p.status}</i></span>`;
    $('v-readout').innerHTML = `<b>${T.title}</b>, Δn = ${p ? p.dn.toFixed(1) : '?'} · BFGS step ${frame}/${T.nf - 1}` +
      ` · E = ${E.toFixed(4)} eV · E − E<sub>0</sub> = <b>${sgn(E - T.E[0], 4)} eV</b>` +
      ` · f<sub>max</sub> = ${T.fmax[frame].toFixed(3)} eV/Å (target ${OPT.fmax_target})${tail}`;
  }

  const markerPlugin = {
    id: 'frameMarker',
    afterDatasetsDraw(chart) {
      if (!T) return;
      const x = chart.scales.x.getPixelForValue(T.xs[frame]);
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = '#d4a017';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };

  function buildMini() {
    if (mini) mini.destroy();
    const pts = T.E.map((e, i) => ({ x: T.xs[i], y: +(e - T.E[0]).toFixed(5) }));
    const datasets = [{
      label: T.isSeries ? 'ΔE vs neutral (eV)' : 'E − E(step 0) (eV)',
      data: pts, borderColor: '#111', backgroundColor: 'transparent',
      borderWidth: 1.5, pointRadius: T.isSeries ? 3.5 : 0, tension: 0, yAxisID: 'y',
    }];
    const scales = {
      x: {
        type: 'linear',
        min: 0,
        max: T.isSeries ? Math.max(...T.xs) : Math.max(T.nf - 1, 1),
        title: { display: true, text: T.isSeries ? 'Δn (e⁻ on Pt₆)' : 'BFGS step', font: { size: 10 } },
        ticks: { font: { size: 9 } }, grid: { color: '#eee' }, border: { color: '#111' },
      },
      y: {
        position: 'left',
        title: { display: true, text: datasets[0].label, font: { size: 10 } },
        ticks: { font: { size: 9 } }, grid: { color: '#eee' }, border: { color: '#111' },
      },
    };
    if (!T.isSeries) {
      datasets.push({
        label: 'f_max (eV/Å, log)',
        data: T.fmax.map((f, i) => ({ x: i, y: Math.max(f, 1e-3) })),
        borderColor: '#c00000', backgroundColor: 'transparent', borderDash: [4, 3],
        borderWidth: 1.25, pointRadius: 0, tension: 0, yAxisID: 'y2',
      });
      datasets.push({
        label: 'f_max target 0.05',
        data: [{ x: 0, y: OPT.fmax_target }, { x: Math.max(T.nf - 1, 1), y: OPT.fmax_target }],
        borderColor: '#c0000066', borderWidth: 1, pointRadius: 0, borderDash: [1, 3], yAxisID: 'y2',
      });
      scales.y2 = {
        type: 'logarithmic', position: 'right',
        title: { display: true, text: 'f_max (eV/Å)', font: { size: 10 }, color: '#c00000' },
        ticks: { font: { size: 9 }, color: '#c00000' }, grid: { display: false }, border: { color: '#c00000' },
      };
    }
    mini = new Chart($('v-chart'), {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: { legend: { position: 'top', labels: { boxWidth: 14, font: { size: 9 } } }, tooltip: { enabled: true } },
        scales,
        onClick(evt, _els, chart) {
          const xv = chart.scales.x.getValueForPixel(evt.x);
          let best = 0;
          T.xs.forEach((x, i) => { if (Math.abs(x - xv) < Math.abs(T.xs[best] - xv)) best = i; });
          stop();
          frame = best;
          draw();
        },
      },
      plugins: [markerPlugin],
    });
  }

  function buildLegend() {
    const present = new Set(T.symbols);
    $('v-legend').innerHTML = Object.entries(EL).filter(([el]) => present.has(el))
      .map(([el, p]) => `<span><i style="background:${p.c}"></i>${el}</span>`).join('') +
      `<span style="color:var(--muted)">${T.n} atoms · ${T.pt.length} Pt (indices ${T.pt[0]}–${T.pt[T.pt.length - 1]}) · ${T.fixed.length} fixed</span>`;
  }

  /* ---------- playback ---------- */
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    $('v-play').textContent = '▶ Play';
  }
  function play() {
    if (timer) { stop(); return; }
    if (!T || T.nf < 2) return;
    if (frame >= T.nf - 1) frame = 0;
    const fps = Number($('v-speed').value);
    $('v-play').textContent = '❚❚ Pause';
    timer = setInterval(() => {
      if (frame >= T.nf - 1) {
        if ($('v-loop').checked) frame = 0;
        else { stop(); return; }
      } else frame += 1;
      draw();
    }, 1000 / fps);
  }
  const step = d => { stop(); if (!T) return; frame = Math.min(Math.max(frame + d, 0), T.nf - 1); draw(); };

  function downloadXYZ() {
    if (!T) return;
    const C = T.cell;
    const lattice = C.flat().map(v => v.toFixed(4)).join(' ');
    let txt = '';
    for (let f = 0; f < T.nf; f++) {
      txt += `${T.n}\nLattice="${lattice}" Properties=species:S:1:pos:R:3 energy=${T.E[f]} fmax=${T.fmax[f]} pbc="T T T"\n`;
      const P = T.pos[f];
      for (let k = 0; k < T.n; k++) {
        txt += `${T.symbols[k]} ${P[3 * k].toFixed(3)} ${P[3 * k + 1].toFixed(3)} ${P[3 * k + 2].toFixed(3)}\n`;
      }
    }
    const blob = new Blob([txt], { type: 'chemical/x-xyz' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${$('v-sys').value}_${$('v-traj').value}.xyz`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function initViewer() {
    if (typeof $3Dmol === 'undefined') {
      $('v-readout').textContent = '3Dmol.js failed to load (check network / CDN access).';
      return;
    }
    try {
      viewer = $3Dmol.createViewer($('v3d'), { backgroundColor: 'white', antialias: true });
    } catch (e) {
      viewer = null;
    }
    if (!viewer) {
      $('v-readout').textContent = 'This browser could not start WebGL, so the 3D viewer is unavailable. Use “Download .xyz” or another browser.';
    }
    fillSystems();
    fillTrajs(urlParams.get('traj') || 'dn1p00');
    $('v-sys').addEventListener('change', () => { needZoom = true; fillTrajs($('v-traj').value); load(); });
    $('v-traj').addEventListener('change', load);
    ['v-style', 'v-solvent', 'v-cell', 'v-label'].forEach(id => $(id).addEventListener('change', draw));
    $('v-rep').addEventListener('change', () => { needZoom = true; draw(); });
    $('v-side').addEventListener('click', () => resetView('side'));
    $('v-top').addEventListener('click', () => resetView('top'));
    $('v-dl').addEventListener('click', downloadXYZ);
    $('v-play').addEventListener('click', play);
    $('v-prev').addEventListener('click', () => step(-1));
    $('v-next').addEventListener('click', () => step(1));
    $('v-first').addEventListener('click', () => step(-1e9));
    $('v-last').addEventListener('click', () => step(1e9));
    $('v-slider').addEventListener('input', e => { stop(); frame = Number(e.target.value); draw(); });
    $('v-speed').addEventListener('change', () => { if (timer) { stop(); play(); } });
    window.addEventListener('resize', () => viewer && viewer.resize());
    load();
  }

  fetch('opt.json').then(r => r.json()).then(data => {
    OPT = data;
    [buildStatus, buildTable, buildCharts, initViewer].forEach(fn => {
      try { fn(); } catch (e) { console.error(fn.name, e); }
    });
  }).catch(e => {
    const el = $('opt-progress');
    if (el) el.textContent = `Could not load opt.json: ${e && e.message ? e.message : e}`;
  });
})();
