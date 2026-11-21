// AB Monitor: DOM wiring. Connects to LUNA, follows the focused session, and drives the two
// listening buses (A = Main Output, B = the chosen cue) through AddOnLogic. Every text goes
// through AddOnI18n, so the language selector re-labels the whole page.

(() => {
  const $ = (id) => document.getElementById(id);
  const L = AddOnLogic;
  const { I18N, LANGS, pickLanguage, translate } = AddOnI18n;

  // ---- Language (kept for this viewer) ------------------------------------------------------
  const KEY = 'com.fedetrillo.ab_monitor.';
  const store = {
    get: (k) => { try { return localStorage.getItem(KEY + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(KEY + k, v); } catch { /* not fatal */ } },
  };
  let lang = pickLanguage(store.get('lang'));
  const t = (key, vars) => translate(lang, key, vars);
  $('lang').replaceChildren(...LANGS.map((code) => Object.assign(document.createElement('option'), { value: code, textContent: I18N[code]._name })));
  $('lang').value = lang;

  let message = { key: 'connecting', vars: {}, error: false, raw: null };
  const say = (key, vars = {}) => { message = { key, vars, error: false, raw: null }; paintMessage(); };
  const report = (e) => { message = { key: null, vars: {}, error: true, raw: String(e?.message || e) }; paintMessage(); };
  function paintMessage() {
    $('msg').textContent = message.raw ?? (message.key ? t(message.key, message.vars) : '');
    $('msg').classList.toggle('error', message.error);
  }

  /** The texts that do not depend on the session. */
  function paintStatic() {
    document.documentElement.lang = lang;
    $('monoLabel').textContent = t('mono'); $('btnMono').title = t('monoTitle');
    $('dimLabel').textContent = t('dim'); $('btnDim').title = t('dimTitle');
    $('cueLabel').textContent = t('listenB');
    $('trim').title = t('trimTitle');
    $('setupTitle').textContent = t('setup');
    $('helpTitle').textContent = t('help');
    $('helpBody').replaceChildren(...['help1', 'help2', 'help3', 'help6', 'help4', 'help7', 'help5'].map((k) => Object.assign(document.createElement('p'), { textContent: t(k) })));
    $('lang').setAttribute('aria-label', t('language'));
    $('undoLabel').textContent = t('undo'); $('undo').title = t('undoTitle');
    paintMessage();
  }
  let repaint = () => {};
  $('lang').onchange = () => { lang = $('lang').value; store.set('lang', lang); paintStatic(); repaint(); };
  paintStatic();

  // ---- Per-session settings (this viewer only) ----------------------------------------------
  const defaults = { cue: 4, trimA: 0, trimB: 0, dim: false, savedPans: null, setupOpen: null, lastPrep: null };
  const loadCfg = (uid) => { try { return { ...defaults, ...JSON.parse(store.get(uid) || '{}') }; } catch { return { ...defaults }; } };
  const saveCfg = (uid, cfg) => store.set(uid, JSON.stringify(cfg));

  let luna;
  let built;
  let page = new Luna.Bindings();
  let watch = new Luna.Bindings();

  async function build() {
    const s = luna.sessions.current();
    if (s === built) return;
    built = s;
    page.dispose(); watch.dispose();
    page = new Luna.Bindings(); watch = new Luna.Bindings();
    if (!s) { say('openSession'); return; }
    await s.ready();
    if (s !== built) return;
    const cfg = loadCfg(s.uid);
    const save = () => saveCfg(s.uid, cfg);
    $('cue').value = String(cfg.cue);
    message = { key: null, vars: {}, error: false, raw: s.name.value ?? '' }; paintMessage();

    // A plugin slot's name for the lists: the catalog's name, the slot's, else its id.
    const slotName = (sl) => luna.plugins.byId(sl.pluginId.value)?.name.value ?? sl.pluginName.value ?? sl.pluginId.value ?? sl.id;
    const slotNames = (slots) => slots.map(slotName).join(', ');
    const names = (list, max = 5) => list.slice(0, max).map((c) => c.name.value).join(', ') + (list.length > max ? ` ${t('andMore', { k: list.length - max })}` : '');

    // ---- Speaker names: the user's own (kept for every session), else the output's ----------
    const loadNames = () => { try { return { A: '', B: '', ...JSON.parse(store.get('names') || '{}') }; } catch { return { A: '', B: '' }; } };
    let custom = loadNames();
    const outName = (x) => (x === 'A' ? t('mainOutput') : t('cueN', { n: cfg.cue }));
    const nameOf = (x) => custom[x] || outName(x);
    const startRename = (x) => {
      const input = $(`name${x}`);
      input.value = custom[x];
      input.placeholder = outName(x);
      input.hidden = false;
      input.focus(); input.select();
      const finish = (keep) => {
        input.onkeydown = null; input.onblur = null;
        input.hidden = true;
        if (keep) { custom = { ...custom, [x]: input.value.trim() }; store.set('names', JSON.stringify(custom)); }
        renderAB();
        $(`btn${x}`).focus();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        e.stopPropagation();   // typing is not a LUNA shortcut
      };
      input.onblur = () => finish(true);
    };
    for (const x of ['A', 'B']) {
      $(`pen${x}`).onclick = () => startRename(x);
      $(`btn${x}`).ondblclick = () => startRename(x);
    }

    // ---- Listening state ------------------------------------------------------------------
    const renderAB = () => {
      const st = L.listening(s, cfg.cue);
      const one = st === 'A' || st === 'B';
      $('btnA').classList.toggle('on', st === 'A' || st === 'both');
      $('btnB').classList.toggle('on', st === 'B' || st === 'both');
      $('btnA').title = `${t('titleA')}. ${t('renameHint')}`; $('btnB').title = `${t('titleB', { n: cfg.cue })}. ${t('renameHint')}`;
      $('subA').textContent = nameOf('A'); $('subB').textContent = nameOf('B');
      for (const x of ['A', 'B']) { $(`pen${x}`).title = t('rename'); $(`pen${x}`).setAttribute('aria-label', `${t('rename')} ${x}`); }
      $('status').className = `status ${one ? st : 'warn'}`;
      $('statusText').textContent = t({ A: 'playingA', B: 'playingB', both: 'playingBoth', none: 'playingNone' }[st]);
      $('statusSub').textContent = one ? nameOf(st) : t('pickOne');
      $('btnMono').classList.toggle('on', L.isMono(s, cfg.cue));
      $('btnDim').classList.toggle('on', cfg.dim);
      const which = st === 'B' ? 'B' : 'A';
      $('trimLabel').textContent = t('trim', { x: which });
      const v = which === 'A' ? cfg.trimA : cfg.trimB;
      $('trim').value = String(v);
      $('trimVal').textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
      bindTrim(which);
      bindMeters();
      renderFlow();
    };

    // ---- Signal flow: Tracks → MIX → A / B, the live path lit, what is missing dashed --------
    const renderFlow = () => {
      const st = L.status(s, cfg.cue);
      const live = st.listening;
      const mixCls = st.mix ? '' : 'missing';
      const toA = live === 'A' || live === 'both' ? 'liveA' : '';
      const toB = !st.mixCueOk ? 'missing' : live === 'B' || live === 'both' ? 'liveB' : '';
      const feed = !st.mix ? 'missing' : toA ? 'liveA' : toB === 'liveB' ? 'liveB' : '';
      const short = (x) => (x.length > 13 ? `${x.slice(0, 12)}…` : x);
      const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      $('flow').innerHTML = `
        <path class="wire ${feed}" d="M60 46 H96"/>
        <path class="wire ${toA || (st.mix ? '' : 'missing')}" d="M148 46 C170 46 170 18 190 18"/>
        <path class="wire ${toB}" d="M148 46 C170 46 170 74 190 74"/>
        <rect class="node" x="2" y="32" width="58" height="28" rx="8"/><text x="31" y="50" text-anchor="middle">${esc(t('flowTracks'))}</text>
        <rect class="node ${st.mix ? 'mixnode' : ''} ${mixCls} ${feed && feed !== 'missing' ? feed : ''}" x="96" y="32" width="52" height="28" rx="8"/><text x="122" y="50" text-anchor="middle">${esc(t('flowMix'))}</text>
        <rect class="node ${toA}" x="190" y="4" width="108" height="28" rx="8"/><text x="201" y="22">A</text><text class="small" x="215" y="22">${esc(short(nameOf('A')))}</text>
        <rect class="node ${toB === 'liveB' ? 'liveB' : ''}" x="190" y="60" width="108" height="28" rx="8"/><text x="201" y="78">B</text><text class="small" x="215" y="78">${esc(short(nameOf('B')))}</text>`;
      $('flow').setAttribute('aria-label', `${t('flowTracks')} → ${t('flowMix')} → A ${nameOf('A')}, B ${nameOf('B')}`);
    };

    // ---- Setup checks and the Prepare button ------------------------------------------------
    const check = (state, text, detail, btnLabel, action) => {
      const el = document.createElement('div');
      el.className = 'check';
      el.innerHTML = `<span class="ic ${state}">${state === 'ok' ? '✓' : state === 'bad' ? '!' : 'i'}</span><span class="tx"></span>`;
      el.querySelector('.tx').textContent = text;
      if (detail) el.querySelector('.tx').append(Object.assign(document.createElement('small'), { textContent: detail }));
      if (state === 'bad' && btnLabel) {
        const b = Object.assign(document.createElement('button'), { textContent: btnLabel });
        b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { report(e); } finally { await refresh(); } };
        el.append(b);
      } else el.append(document.createElement('span'));
      return el;
    };
    const renderSetup = () => {
      const st = L.status(s, cfg.cue);
      const n = cfg.cue;
      const rows = [check(st.mix ? 'ok' : 'bad', t('chkMix'), st.mix ? null : t('chkMixNo'), t('fix'), runPrepare)];
      if (st.mix) rows.push(check(st.outside.length ? 'bad' : 'ok', t('chkOutside'), st.outside.length ? t('chkOutsideNo', { list: names(st.outside) }) : null, t('fix'), runPrepare));
      if (st.mix) rows.push(check(st.plugins.length ? 'bad' : 'ok', t('chkPlugins'), st.plugins.length ? t('chkPluginsNo', { list: slotNames(st.plugins) }) : null, t('remove'), () => L.clearMixPlugins(s, st.mix)));
      rows.push(check(st.mixCueOk || !st.mix ? 'ok' : 'bad', t('chkCue', { n }), st.mixCueOk ? null : t('chkCueNo'), t('adjust'), () => L.ensureCue(s, n)));
      rows.push(check(st.others.length ? 'bad' : 'ok', t('chkOthers', { n }), st.others.length ? t('chkOthersNo', { list: names(st.others) }) : null, t('mute'), () => L.muteOtherCueSenders(s, n)));
      rows.push(check('info', t('chkHw', { n }), t('chkHwNote'), null, null));
      $('checks').replaceChildren(...rows);
      const ready = L.isPrepared(s);
      $('setupState').textContent = ready ? t('setupOk') : t('setupPending');
      $('setupState').className = `state ${ready ? 'ok' : 'bad'}`;
      if (cfg.setupOpen === null) $('setup').open = !ready;   // open until ready, then the user decides
      renderPrep(ready);
      renderFlow();
    };
    $('setup').addEventListener('toggle', () => { cfg.setupOpen = $('setup').open; save(); });

    const renderPrep = (ready = L.isPrepared(s)) => {
      const p = L.preparePlan(s);
      const n = cfg.cue;
      const btn = $('prep');
      btn.classList.toggle('ready', ready);
      btn.querySelector('.pt').textContent = ready ? `✓ ${t('ready')}` : p.createMix ? t('prepare') : t('update');
      btn.querySelector('.ps').textContent = ready ? t('prepReady', { n })
        : p.createMix ? t('prepNew', { n })
          : [p.move.length ? t('partOutside', { k: p.move.length }) : '', p.color ? t('stepColor') : '', p.clear.length ? t('partPlugins', { k: p.clear.length }) : ''].filter(Boolean).join(', ');
    };
    $('prep').onclick = () => { if (!L.isPrepared(s)) void runPrepare(); else void refresh(); };

    repaint = () => { renderAB(); renderSetup(); };

    let refreshing = null;
    const refresh = async () => {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        await L.load(s, cfg.cue);
        if (s !== built) return;
        watchBuses();
        renderAB(); renderSetup();
      })().finally(() => { refreshing = null; });
      return refreshing;
    };

    const watchBuses = () => {
      watch.dispose(); watch = new Luna.Bindings();
      for (const bus of [s.master, L.cueBus(s, cfg.cue)].filter(Boolean)) {
        watch.on(bus.mute.real, renderAB);
        for (const p of bus.main.pans) watch.on(p.normalized, renderAB);
      }
    };
    // Undo MIX: puts back only what the last Prepare did (not LUNA's whole history).
    const renderHist = () => { $('undo').disabled = !cfg.lastPrep; };
    $('undo').onclick = async () => {
      if (!cfg.lastPrep) { say('nothingToUndo'); return; }
      $('undo').disabled = true; $('prep').disabled = true;
      try {
        const r = await L.revert(s, luna, cfg.lastPrep);
        cfg.lastPrep = null; save();
        say('undone', { k: r.back });
        if (r.errors.length) report(`${t('undone', { k: r.back })} ${r.errors.join(' · ')}`);
      } catch (e) { report(e); }
      $('prep').disabled = false;
      renderHist();
      await refresh();
    };
    renderHist();

    const timer = setInterval(() => { if (!document.hidden) renderSetup(); }, 2000);
    page.add(() => clearInterval(timer));
    page.on(s.tracks, () => void refresh());
    page.on(s.buses, () => void refresh());

    // ---- Controls ---------------------------------------------------------------------------
    $('btnA').onclick = () => L.listen(s, 'A', cfg.cue).catch(report);
    $('btnB').onclick = async () => { try { await L.ensureCue(s, cfg.cue); await L.listen(s, 'B', cfg.cue); } catch (e) { report(e); } await refresh(); };
    $('btnMono').onclick = async () => {
      try {
        if (L.isMono(s, cfg.cue)) await L.setMono(s, cfg.cue, false, cfg.savedPans);
        else { cfg.savedPans = L.savePans(s, cfg.cue); save(); await L.setMono(s, cfg.cue, true, cfg.savedPans); }
      } catch (e) { report(e); }
    };
    $('btnDim').onclick = async () => {
      cfg.dim = !cfg.dim; save(); renderAB();
      await L.applyTrims(s, cfg.cue, cfg).catch(report);
    };
    $('cue').onchange = async () => {
      const prev = cfg.cue;
      const listeningB = L.listening(s, prev) === 'B';
      cfg.cue = Number($('cue').value); save();
      trimFor = null;
      await refresh();
      if (listeningB) {
        await L.ensureCue(s, cfg.cue).catch(report);
        await s.transaction('AB Monitor: change B', async () => {
          await L.cueBus(s, prev)?.mute.real.set(true);
          await L.listen(s, 'B', cfg.cue);
        }).catch(report);
      }
      await L.applyTrims(s, cfg.cue, cfg).catch(report);
    };

    // Trim: the slider drives the active bus's gain_trim, one touch per drag (one undo step).
    let trimGesture = null;
    let trimFor = null;
    function bindTrim(which) {
      if (trimFor === which && trimGesture) return;
      trimFor = which;
      trimGesture?.dispose();
      const ctl = L.ctl((which === 'A' ? s.master : L.cueBus(s, cfg.cue))?.main, 'gain_trim');
      trimGesture = ctl ? Luna.bindGesture($('trim'), ctl, { bindings: page }) : null;
    }
    $('trim').oninput = () => {
      const v = Number($('trim').value);
      const which = trimFor ?? 'A';
      if (which === 'A') cfg.trimA = v; else cfg.trimB = v;
      save();
      $('trimVal').textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
      L.ctl((which === 'A' ? s.master : L.cueBus(s, cfg.cue))?.main, 'gain_trim')?.real.set(L.trimFor(v, cfg.dim)).catch(report);
    };
    $('trim').ondblclick = () => { $('trim').value = '0'; $('trim').oninput(); };

    // Each monitor's woofer ring follows its bus level (a CSS variable, so no layout work).
    let meterOffs = [];
    let meterKey = '';
    function bindMeters() {
      const cue = L.cueBus(s, cfg.cue);
      const key = `${s.master?.id}|${cue?.id}`;
      if (key === meterKey) return;
      meterKey = key;
      meterOffs.forEach((off) => off()); meterOffs = [];
      for (const [bus, el] of [[s.master, $('btnA')], [cue, $('btnB')]]) {
        if (!bus) continue;
        meterOffs.push(bus.meter.onChange(() => {
          const lv = bus.meter.level.value ?? [];
          const peak = Math.max(0, ...lv.filter((x) => typeof x === 'number'));
          const db = peak > 0 ? 20 * Math.log10(peak) : -80;
          el.style.setProperty('--lvl', Math.max(0, Math.min(1, (db + 48) / 48)).toFixed(3));
        }));
      }
      page.add(() => meterOffs.forEach((off) => off()));
    }

    // ---- Prepare: one click, every track into a red MIX with nothing on it -------------------
    async function runPrepare() {
      const btn = $('prep');
      btn.disabled = true; $('undo').disabled = true;
      btn.querySelector('.pt').textContent = t('preparing');
      try {
        await L.load(s, cfg.cue);
        const r = await L.prepare(s, luna);
        // Keep the first record: a second Prepare only adds to MIX, and Undo goes back to before both.
        if (cfg.lastPrep && cfg.lastPrep.mixUid === r.undo.mixUid) {
          const had = new Set(cfg.lastPrep.moved.map((m) => m.uid));
          cfg.lastPrep.moved.push(...r.undo.moved.filter((m) => !had.has(m.uid)));
          cfg.lastPrep.removed.push(...r.undo.removed);
        } else cfg.lastPrep = r.undo;
        save();
        if (L.listening(s, cfg.cue) === 'both') await L.listen(s, 'A', cfg.cue);   // never both pairs at once
        const parts = [t('prepDone', { k: r.moved, p: r.removed })];
        if (r.notMoved.length) parts.push(t('prepNotMoved', { list: names(r.notMoved) }));
        if (r.left.length) parts.push(t('prepLeft', { list: slotNames(r.left) }));
        if (r.notMoved.length || r.left.length || r.errors.length) report([...parts, ...r.errors].join(' '));
        else say('prepDone', { k: r.moved, p: r.removed });
      } catch (e) { report(e); }
      btn.disabled = false;
      renderHist();
      await refresh();
    }

    await refresh();
  }

  // ---- Start --------------------------------------------------------------------------------
  (async () => {
    for (;;) {
      try { luna = await Luna.connect(); break; }
      catch (e) { if (e instanceof Luna.NotRunning) say('waiting'); else report(e); await new Promise((r) => setTimeout(r, 1500)); }
    }
    Luna.bindShortcuts(luna, { onError: report });
    await luna.plugins.load().catch(() => undefined);   // plugin names for the lists
    luna.status.onChange(() => { if (luna.status.value !== 'connected') say('reconnecting'); else { message = { key: null, raw: built?.name.value ?? '', error: false }; paintMessage(); } });
    await luna.sessions.ready();
    luna.sessions.focused.onChange(() => void build());
    await build();
  })();
})();
