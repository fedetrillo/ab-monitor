// Runs against Luna.MockEngine: `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna;
await import('../logic.js');
const L = globalThis.AddOnLogic;
const N = 4;   // B on CUE 4

async function setup() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Kick', 'Snare', 'Bass', 'Vox'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  const verb = await session.newBus({ name: 'Verb' });
  const drums = await session.newBus({ name: 'Drums' });
  await engine.settled(); await luna.settled();
  await L.load(session, N);
  const by = (n) => session.channelsInOrder.find((c) => c.name.value === n);
  // Kick and Snare go by hand to the Drums bus (not a folder): they must stay where they are.
  for (const t of ['Kick', 'Snare']) await by(t).main.retarget(drums.id);
  await engine.settled(); await luna.settled();
  const settle = async () => { await engine.settled(); await luna.settled(); await L.load(session, N); };
  return { engine, luna, session, by, settle };
}

describe('AB Monitor', () => {
  it('plans MIX: every root track moves; hand-routed ones are noted to keep their bus', async () => {
    const { luna, session, by } = await setup();
    const plan = L.planMix(session);
    expect(plan.move.map((c) => c.name.value)).toEqual(['Kick', 'Snare', 'Bass', 'Vox', 'Verb', 'Drums']);
    expect(plan.restore.map((r) => [r.ch.name.value, r.buses])).toEqual([['Kick', [by('Drums').id]], ['Snare', [by('Drums').id]]]);
    expect(L.isMixable(session.master)).toBe(false);
    expect(L.isMixable(L.cueBus(session, N))).toBe(false);
    expect(L.isMixable(by('Verb'))).toBe(true);
  });

  it('Prepare: creates a red MIX and puts every track into it, routes kept', async () => {
    const { engine, luna, session, by, settle } = await setup();
    engine.transactions.length = 0;
    const { mix } = await L.prepare(session, luna);
    await settle();
    expect(L.findMix(session)).toBe(mix);
    for (const n of ['Kick', 'Snare', 'Bass', 'Vox', 'Verb', 'Drums']) expect(by(n).folderUid.value).toBe(mix.id);
    expect(mix.color.value >>> 0).toBe(L.MIX_COLOR >>> 0);
    expect(by('Bass').main.assignments.value.map((d) => d.name)).toEqual(['MIX']);
    expect(L.busRoutes(by('Kick'))).toEqual([by('Drums').id]);   // in MIX, and still to Drums
    expect(L.busRoutes(by('Snare'))).toEqual([by('Drums').id]);
    expect(L.outsideMix(session)).toEqual([]);
    // Running it again creates no second MIX and moves nothing.
    await L.prepare(session, luna); await settle();
    expect(session.buses.items.filter((b) => b.name.value === 'MIX').length).toBe(1);
  });

  it('sends MIX to the chosen cue at 0 dB, post-fader, stereo', async () => {
    const { luna, session, settle } = await setup();
    const { mix } = await L.prepare(session, luna); await settle();
    expect(L.mixCueOk(mix, N)).toBe(false);
    await L.setupMixCue(session, mix, N); await settle();
    expect(L.mixCueOk(mix, N)).toBe(true);
    const out = L.cueSend(mix, N);
    expect(L.ctl(out, 'enabled').on).toBe(true);
    expect(L.ctl(out, 'pan_left').normalized.value).toBe(0);
    expect(L.ctl(out, 'pan_right').normalized.value).toBe(1);
  });

  it('finds and mutes other sends to the same cue', async () => {
    const { luna, session, by, settle } = await setup();
    await L.prepare(session, luna); await settle();
    const vs = L.cueSend(by('Vox'), N);
    await L.ctl(vs, 'enabled').real.set(true); await settle();
    expect(L.otherCueSenders(session, N).map((c) => c.name.value)).toEqual(['Vox']);
    await L.muteOtherCueSenders(session, N); await settle();
    expect(L.otherCueSenders(session, N)).toEqual([]);
    expect(L.ctl(vs, 'mute').on).toBe(true);
  });

  it('switches A and B by muting one bus, as one undo step', async () => {
    const { luna, engine, session, settle } = await setup();
    expect(L.listening(session, N)).toBe('both');
    engine.transactions.length = 0;
    await L.listen(session, 'B', N); await settle();
    expect(L.listening(session, N)).toBe('B');
    expect(session.master.mute.on).toBe(true);
    expect(engine.transactions).toEqual(['begin', 'commit']);
    await L.listen(session, 'A', N); await settle();
    expect(L.listening(session, N)).toBe('A');
    expect(L.cueBus(session, N).mute.on).toBe(true);
  });

  it('applies trims and DIM on gain_trim, never the faders', async () => {
    const { luna, session, settle } = await setup();
    const faderA = session.master.gain.real.value;
    await L.applyTrims(session, N, { trimA: -1.5, trimB: 2, dim: false }); await settle();
    expect(L.ctl(session.master.main, 'gain_trim').real.value).toBe(-1.5);
    expect(L.ctl(L.cueBus(session, N).main, 'gain_trim').real.value).toBe(2);
    await L.applyTrims(session, N, { trimA: -1.5, trimB: 2, dim: true }); await settle();
    expect(L.ctl(session.master.main, 'gain_trim').real.value).toBe(-21.5);
    expect(L.ctl(L.cueBus(session, N).main, 'gain_trim').real.value).toBe(-18);
    expect(session.master.gain.real.value).toBe(faderA);
  });

  it('MONO centres both buses and restores their pans', async () => {
    const { luna, session, settle } = await setup();
    const cue = L.cueBus(session, N);
    await session.master.main.pans[0].normalized.set(0); await session.master.main.pans[1].normalized.set(1);
    await cue.main.pans[0].normalized.set(0.1); await cue.main.pans[1].normalized.set(0.9);
    await settle();
    const saved = L.savePans(session, N);
    await L.setMono(session, N, true, saved); await settle();
    expect(L.isMono(session, N)).toBe(true);
    await L.setMono(session, N, false, saved); await settle();
    expect(L.isMono(session, N)).toBe(false);
    expect(cue.main.pans.map((p) => p.normalized.value)).toEqual([0.1, 0.9]);
  });

  it('prepares with no cue work, and B sets the cue send and mutes duplicates', async () => {
    const { luna, session, by, settle } = await setup();
    const vs = L.cueSend(by('Vox'), N);
    await L.ctl(vs, 'enabled').real.set(true); await settle();
    expect(L.isPrepared(session)).toBe(false);
    const r = await L.prepare(session, luna); await settle();
    expect(r.moved).toBe(6);
    expect(r.errors).toEqual([]);
    expect(L.isPrepared(session)).toBe(true);
    expect(L.ctl(vs, 'mute').on).toBe(false);          // Prepare leaves the cues alone
    await L.ensureCue(session, N); await settle();
    expect(L.mixCueOk(r.mix, N)).toBe(true);
    expect(L.ctl(vs, 'mute').on).toBe(true);
    // A MIX turned another colour is painted red again.
    await r.mix.color.set(0xff3070d0); await settle();
    expect(L.preparePlan(session).color).toBe(true);
    await L.prepare(session, luna); await settle();
    expect(r.mix.color.value >>> 0).toBe(L.MIX_COLOR >>> 0);
  });

  it('takes every process off MIX', async () => {
    const { engine, luna, session, settle } = await setup();
    engine.addPlugin('uaudio_api_2500', { name: 'API 2500', categories: ['Compressor'] });
    engine.addPlugin('uaudio_ampex', { name: 'Ampex ATR-102', categories: ['Tape'] });
    await engine.settled(); await luna.plugins.load();
    const { mix } = await L.prepare(session, luna); await settle();
    await mix.effects.load();
    await mix.insert('uaudio_api_2500');
    await mix.insert('uaudio_ampex', 'tape');
    await settle();
    expect(L.preparePlan(session).clear.map((sl) => sl.id).sort()).toEqual(['effect_0', 'tape']);
    const r = await L.prepare(session, luna); await settle();
    expect(r.removed).toBe(2);
    expect(L.mixPlugins(session)).toEqual([]);
    expect(L.isPrepared(session)).toBe(true);
  });

  it('Undo MIX puts back only what Prepare did: tracks out, routes back, MIX deleted', async () => {
    const { luna, session, by, settle } = await setup();
    const order = session.channelsInOrder.map((c) => c.name.value);
    const r = await L.prepare(session, luna); await settle();
    const back = await L.revert(session, luna, r.undo); await settle();
    expect(back.back).toBe(6);
    expect(back.errors).toEqual([]);
    expect(L.findMix(session)).toBeUndefined();
    for (const n of ['Kick', 'Snare', 'Bass', 'Vox', 'Verb', 'Drums']) expect(by(n).folderUid.value ?? null).toBe(null);
    expect(L.busRoutes(by('Kick'))).toEqual([by('Drums').id]);
    expect(L.busRoutes(by('Bass'))).toEqual([]);
    expect(session.channelsInOrder.map((c) => c.name.value)).toEqual(order);
  });

  it('keeps going when one route is refused, and says so', async () => {
    const { luna, session, by, settle } = await setup();
    const real = L.restoreRoute;
    let refused = false;
    L.restoreRoute = async (...args) => { if (!refused) { refused = true; throw new Error('refused'); } return real(...args); };
    try {
      const r = await L.prepare(session, luna); await settle();
      expect(r.moved).toBe(6);
      expect(r.errors.length).toBe(1);
      expect(L.busRoutes(by('Snare'))).toEqual([by('Drums').id]);
    } finally { L.restoreRoute = real; }
  });
});
