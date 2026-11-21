// AB Monitor: logic with no DOM, tested against Luna.MockEngine.
//
// How it listens on two pairs of speakers:
//   A = LUNA's Main Output (its physical outputs are set in LUNA's audio settings).
//   B = one of the cue buses, CUE 1-4, which LUNA's audio settings send to other outputs.
// Everything plays through one summing folder, MIX. MIX goes to the Main Output (A), and its cue
// send to the chosen cue (B), at 0 dB, post-fader, in stereo. Switching A and B mutes one bus and unmutes the
// other; MONO puts both buses' pans in the centre; DIM and the per-speaker trims use the buses'
// gain_trim, so their faders and automation are never touched.

const MIX_NAME = 'MIX';
const DIM_DB = -20;

const AddOnLogic = {
  MIX_NAME,
  DIM_DB,

  // ---- Finding things ----------------------------------------------------------------------

  /** The MIX summing folder, if the session has one. */
  findMix(session) {
    return session.buses.items.find((b) => b.isFolder && (b.name.value ?? '').trim().toUpperCase() === MIX_NAME && b.folderMode.value === 'summing');
  },

  /** The cue bus CUE n (1-4). */
  cueBus(session, n) {
    return session.buses.items.find((b) => b.busType.value === `cue_${n - 1}`);
  },

  /** A channel's output that feeds CUE n. */
  cueSend(ch, n) {
    return ch.outputs.byId(`cue_${n - 1}`);
  },

  /** A control of an output, or undefined when the output does not have it. */
  ctl(output, id) {
    return output?.controls.byId(id) ? output.controls.get(id) : undefined;
  },

  /** Tracks, aux buses and folders: what can go into MIX (not the master, cues or system tracks). */
  isMixable(ch) {
    if (ch instanceof Luna.Track) return !['click', 'count_in'].includes(ch.trackType.value);
    return ch.busType.value === 'aux';
  },

  /**
   * True unless a channel's main output is routed to another bus (an aux bus or a folder): such
   * a channel is kept where it is, and reaches MIX through that bus. Read from the raw
   * `assignments` rows, which list every destination with its bus type; a row with no bus type
   * (LUNA's default output) or the master counts as "to the master".
   */
  goesToMaster(ch) {
    const rows = ch.main.assignments.value ?? [];
    return !rows.some((r) => r.type && r.type !== 'master');
  },


  /** Everything that must load before the checks can be read: outputs and their controls. */
  async load(session, n) {
    const chans = session.channelsInOrder;
    await Promise.all(chans.map((ch) => Promise.all([ch.loadStrip(), ch.outputs.load()]).catch(() => undefined)));
    await Promise.all(chans.map((ch) => AddOnLogic.cueSend(ch, n)?.controls.load().catch(() => undefined)));
    await AddOnLogic.findMix(session)?.effects.load().catch(() => undefined);
  },

  // ---- Preparing MIX -------------------------------------------------------------------------

  /** The buses a channel's main output is routed to by hand (not the master): their uids. */
  busRoutes(ch) {
    return (ch.main.assignments.value ?? []).filter((r) => r.type && r.type !== 'master' && r.value).map((r) => r.value);
  },

  /**
   * What "Prepare" moves: every track, bus and folder at the session root (folders with everything
   * in them). LUNA reroutes whatever it moves into a summing folder to that folder, so the ones
   * routed by hand to a bus are listed in `restore`, with their buses, to be routed back to them
   * in the same step.
   */
  planMix(session) {
    const mix = AddOnLogic.findMix(session);
    const move = session.channelsInOrder.filter((ch) => (ch.folderUid.value ?? null) === null && AddOnLogic.isMixable(ch) && ch !== mix);
    const restore = move.map((ch) => ({ ch, buses: AddOnLogic.busRoutes(ch) })).filter((r) => r.buses.length);
    return { move, restore };
  },

  /** The MIX folder's colour: red, packed ARGB. */
  MIX_COLOR: 0xffe03131,

  /** True when MIX exists but is not red. */
  needsColor(mix) {
    return !!mix && (mix.color.value ?? 0) >>> 0 !== AddOnLogic.MIX_COLOR >>> 0;
  },

  /**
   * Route `ch`'s main output back to `buses`. Inside a transaction LUNA holds its pushes, so the
   * output's routing is re-read first (LUNA answers reads with the current state, and the read
   * refreshes the SDK's copy), then replaced.
   */
  async restoreRoute(luna, ch, buses) {
    await luna.raw.get(ch.main.path, { properties: true, children: true, levels: 2, flatvalue: true, commands: false });
    await ch.main.retarget(buses[0], 'AB Monitor: keep route');
    for (const b of buses.slice(1)) await ch.main.assign(b);
  },

  /**
   * The slots on MIX that hold a plugin: console, summing, tape or effect inserts. MIX must stay
   * clean, so that A and B sound exactly like the mix did before (LUNA can add a bus console or
   * a tape machine to new buses by itself).
   */
  mixPlugins(session, mix = AddOnLogic.findMix(session)) {
    return (mix?.effects.items ?? []).filter((sl) => !sl.isEmpty && !/^(record_fx|sidechain)/.test(sl.id));
  },

  /**
   * Empty every plugin slot on MIX (console, summing, tape, inserts), one slot at a time so one
   * refusal does not stop the others. Resolves to what was removed, to put back on revert, and
   * what is still there after a fresh read.
   */
  async clearMixPlugins(session, mix = AddOnLogic.findMix(session)) {
    const removed = [];
    if (!mix) return { removed, left: [] };
    await mix.effects.load();
    for (const sl of AddOnLogic.mixPlugins(session, mix)) {
      const pluginId = sl.pluginId.value;
      try { await sl.clear(); removed.push({ slot: sl.id, pluginId }); } catch { /* listed as left below */ }
    }
    await AddOnLogic.settle(() => AddOnLogic.mixPlugins(session, mix).length === 0, () => mix.effects.reload());
    return { removed, left: AddOnLogic.mixPlugins(session, mix) };
  },

  /** Wait (up to `ms`) until `done()` is true, re-reading with `refresh` between tries. */
  async settle(done, refresh, ms = 3000) {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 150));
      try { await refresh?.(); } catch { /* try again */ }
    }
    return done();
  },

  /** Is MIX's send to CUE n on, unmuted, at 0 dB, post-fader and stereo? */
  mixCueOk(mix, n) {
    const out = mix && AddOnLogic.cueSend(mix, n);
    if (!out) return false;
    const v = (id) => AddOnLogic.ctl(out, id);
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.05;
    const pansOk = out.controls.byId('pan_left')
      ? near(v('pan_left').normalized.value, 0) && near(v('pan_right').normalized.value, 1)
      : true;
    return v('enabled')?.on !== false && v('mute')?.on !== true && near(v('gain')?.real.value, 0) && v('pre_fader')?.on !== true && pansOk;
  },

  /** Set MIX's send to CUE n: on, unmuted, 0 dB, post-fader, hard left and right. One undo step. */
  async setupMixCue(session, mix, n) {
    const out = AddOnLogic.cueSend(mix, n);
    await out.controls.load();
    const c = (id) => AddOnLogic.ctl(out, id);
    await session.transaction(`AB Monitor: send MIX to CUE ${n}`, async () => {
      if (c('enabled')) await c('enabled').real.set(true);
      if (c('mute')) await c('mute').real.set(false);
      if (c('pre_fader')) await c('pre_fader').real.set(false);
      if (c('gain')) await c('gain').real.set(0);
      if (c('pan_left')) await c('pan_left').normalized.set(0);
      if (c('pan_right')) await c('pan_right').normalized.set(1);
    });
  },

  /** Channels other than MIX that also send to CUE n (on and unmuted): they would play twice in B. */
  otherCueSenders(session, n) {
    const mix = AddOnLogic.findMix(session);
    return session.channelsInOrder.filter((ch) => {
      if (ch === mix || !AddOnLogic.isMixable(ch)) return false;
      const out = AddOnLogic.cueSend(ch, n);
      if (!out?.controls.byId('mute')) return false;
      const enabled = AddOnLogic.ctl(out, 'enabled');
      return (enabled ? enabled.on : true) && !AddOnLogic.ctl(out, 'mute').on;
    });
  },

  /** Mute those sends, as one undo step. */
  async muteOtherCueSenders(session, n) {
    const list = AddOnLogic.otherCueSenders(session, n);
    await session.transaction(`AB Monitor: mute other sends to CUE ${n}`, async () => {
      for (const ch of list) await AddOnLogic.ctl(AddOnLogic.cueSend(ch, n), 'mute').real.set(true);
    });
  },

  /** What "Prepare" would do now: create MIX, colour it, move tracks in, empty its slots. */
  preparePlan(session) {
    const plan = AddOnLogic.planMix(session);
    const mix = AddOnLogic.findMix(session);
    return { createMix: !mix, move: plan.move, restore: plan.restore, color: !mix || AddOnLogic.needsColor(mix), clear: AddOnLogic.mixPlugins(session, mix) };
  },

  /** True when MIX exists, is red, holds every track and carries no plugin. */
  isPrepared(session) {
    const p = AddOnLogic.preparePlan(session);
    return !p.createMix && p.move.length === 0 && !p.color && p.clear.length === 0;
  },

  /**
   * Prepare: what you would otherwise do by hand. Select every track and bus except the Main
   * Output and the cues, put them into a new red summing folder MIX, and take every process off
   * MIX. Tracks routed by hand to a bus keep that route. Done in plain steps, not one batch:
   * LUNA holds a batch's changes until it ends, so a folder made inside one cannot be used in it.
   *
   * Resolves to a report, and `undo`: what is needed to put everything back as it was.
   */
  async prepare(session, luna) {
    const plan = AddOnLogic.planMix(session);
    let mix = AddOnLogic.findMix(session);
    const undo = {
      mixUid: mix?.id ?? null,
      created: !mix,
      color: mix ? (mix.color.value ?? null) : null,
      moved: plan.move.map((ch) => ({ uid: ch.id, buses: AddOnLogic.busRoutes(ch) })),
      removed: [],
    };
    const errors = [];
    const step = async (what, fn) => { try { return await fn(); } catch (e) { errors.push(`${what}: ${e?.message ?? e}`); return undefined; } };

    if (!mix) {
      mix = await session.newFolder({ name: MIX_NAME, mode: 'summing', stemFormat: 'stereo' });
      undo.mixUid = mix.id;
    }
    if (AddOnLogic.needsColor(mix)) await step('color', () => mix.color.set(AddOnLogic.MIX_COLOR));
    if (plan.move.length) {
      await step('move', () => session.moveToFolder(plan.move, mix));
      await AddOnLogic.settle(() => plan.move.every((ch) => ch.folderUid.value === mix.id), () => Promise.all([session.tracks.reload(), session.buses.reload()]));
    }
    for (const { ch, buses } of plan.restore) await step(`route ${ch.name.value}`, () => AddOnLogic.restoreRoute(luna, ch, buses));
    const cleared = await step('plugins', () => AddOnLogic.clearMixPlugins(session, mix)) ?? { removed: [], left: AddOnLogic.mixPlugins(session, mix) };
    undo.removed = cleared.removed;

    const notMoved = plan.move.filter((ch) => ch.folderUid.value !== mix.id);
    return { mix, undo, moved: plan.move.length - notMoved.length, notMoved, kept: plan.restore.length, removed: cleared.removed.length, left: cleared.left, errors };
  },

  /**
   * Put back what `prepare` did, from its `undo` record: the tracks it moved go back to the root
   * (in their order, where MIX was) with their bus routes; MIX is deleted if Prepare made it,
   * else its plugins and colour come back. Only those tracks: anything else is left as it is.
   */
  async revert(session, luna, undo) {
    const mix = session.buses.byId(undo.mixUid);
    const errors = [];
    const step = async (what, fn) => { try { return await fn(); } catch (e) { errors.push(`${what}: ${e?.message ?? e}`); return undefined; } };
    const chan = (uid) => session.tracks.byId(uid) ?? session.buses.byId(uid);
    const back = undo.moved.map((m) => ({ ch: chan(m.uid), buses: m.buses })).filter((m) => m.ch && mix && m.ch.folderUid.value === mix.id);
    if (back.length) {
      await step('move', () => session.moveToFolder(back.map((m) => m.ch), null, { after: mix }));
      await AddOnLogic.settle(() => back.every((m) => (m.ch.folderUid.value ?? null) === null), () => Promise.all([session.tracks.reload(), session.buses.reload()]));
    }
    for (const { ch, buses } of back) if (buses.length) await step(`route ${ch.name.value}`, () => AddOnLogic.restoreRoute(luna, ch, buses));
    if (mix && undo.created) {
      if (session.folderContents(mix).length === 0) await step('delete MIX', () => session.deleteTracks([mix.id]));
      else errors.push('MIX is not empty, so it was kept');
    } else if (mix) {
      await mix.effects.load().catch(() => undefined);
      for (const r of undo.removed) await step(`plugin ${r.pluginId}`, () => mix.effects.byId(r.slot).setPlugin(r.pluginId, { wait: false }));
      if (undo.color !== null) await step('color', () => mix.color.set(undo.color));
    }
    return { back: back.length, errors };
  },

  /** Make B play the mix: MIX's send to CUE n set, and other sends to CUE n muted. One undo step. */
  async ensureCue(session, n) {
    const mix = AddOnLogic.findMix(session);
    if (!mix) return false;
    await AddOnLogic.load(session, n);
    if (!AddOnLogic.mixCueOk(mix, n)) await AddOnLogic.setupMixCue(session, mix, n);
    if (AddOnLogic.otherCueSenders(session, n).length) await AddOnLogic.muteOtherCueSenders(session, n);
    return true;
  },

  /** What is still at the root and plays to the master outside MIX: B will not hear it. */
  outsideMix(session) {
    return AddOnLogic.findMix(session) ? AddOnLogic.planMix(session).move : [];
  },

  /** Every check the setup panel shows. */
  status(session, n) {
    const mix = AddOnLogic.findMix(session);
    const cue = AddOnLogic.cueBus(session, n);
    return {
      mix,
      cue,
      mixCueOk: AddOnLogic.mixCueOk(mix, n),
      plugins: AddOnLogic.mixPlugins(session, mix),
      others: AddOnLogic.otherCueSenders(session, n),
      outside: AddOnLogic.outsideMix(session),
      listening: AddOnLogic.listening(session, n),
    };
  },

  // ---- Listening ---------------------------------------------------------------------------

  /** 'A', 'B', 'both' or 'none', read from the two buses' mutes. */
  listening(session, n) {
    const a = session.master;
    const b = AddOnLogic.cueBus(session, n);
    if (!a || !b) return 'none';
    const aOn = !a.mute.on;
    const bOn = !b.mute.on;
    return aOn && bOn ? 'both' : aOn ? 'A' : bOn ? 'B' : 'none';
  },

  /** Listen on A or B: unmute that bus and mute the other, as one undo step. */
  async listen(session, which, n) {
    const a = session.master;
    const b = AddOnLogic.cueBus(session, n);
    await session.transaction(`AB Monitor: listen ${which}`, async () => {
      await a.mute.real.set(which !== 'A');
      await b.mute.real.set(which !== 'B');
    });
  },

  /** A bus's trim, in dB, for its speakers' level plus DIM. */
  trimFor(trimDb, dim) {
    return trimDb + (dim ? DIM_DB : 0);
  },

  /** Write both trims (A on the Main Output, B on the cue bus), with DIM folded in. */
  async applyTrims(session, n, { trimA, trimB, dim }) {
    const set = (bus, db) => AddOnLogic.ctl(bus?.main, 'gain_trim')?.real.set(AddOnLogic.trimFor(db, dim));
    await session.transaction('AB Monitor: levels', async () => {
      await set(session.master, trimA);
      await set(AddOnLogic.cueBus(session, n), trimB);
    });
  },

  /** The pans of both buses, to restore after MONO. */
  savePans(session, n) {
    const read = (bus) => (bus?.main.pans ?? []).map((p) => p.normalized.value ?? null);
    return { a: read(session.master), b: read(AddOnLogic.cueBus(session, n)) };
  },

  /** True when both buses' pans sit in the centre (MONO on). */
  isMono(session, n) {
    const centred = (bus) => {
      const pans = bus?.main.pans ?? [];
      return pans.length === 2 && pans.every((p) => Math.abs((p.normalized.value ?? 0) - 0.5) < 0.01);
    };
    return centred(session.master) && centred(AddOnLogic.cueBus(session, n));
  },

  /** MONO on: both buses' left and right pans to the centre. Off: back to `saved` (or hard L/R). */
  async setMono(session, n, on, saved) {
    const buses = [session.master, AddOnLogic.cueBus(session, n)];
    await session.transaction(`AB Monitor: mono ${on ? 'on' : 'off'}`, async () => {
      for (const [i, bus] of buses.entries()) {
        const pans = bus?.main.pans ?? [];
        const back = (i === 0 ? saved?.a : saved?.b) ?? [0, 1];
        for (const [j, p] of pans.entries()) {
          const v = on ? 0.5 : (back[j] ?? (j === 0 ? 0 : 1));
          await p.normalized.set(v === 0.5 && !on ? (j === 0 ? 0 : 1) : v);
        }
      }
    });
  },
};

globalThis.AddOnLogic = AddOnLogic;
