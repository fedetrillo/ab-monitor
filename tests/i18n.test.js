import { describe, expect, it } from 'vitest';
await import('../i18n.js');
const { I18N, LANGS, pickLanguage, translate } = globalThis.AddOnI18n;

describe('translations', () => {
  const keys = Object.keys(I18N.en);
  it.each(LANGS)('%s has every text, with the same placeholders as English', (lang) => {
    const ph = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    expect(Object.keys(I18N[lang]).sort()).toEqual([...keys].sort());
    for (const k of keys) expect([k, ph(I18N[lang][k])]).toEqual([k, ph(I18N.en[k])]);
  });
  it('picks the saved language, else the system one, else English', () => {
    expect(pickLanguage('de', ['es-ES'])).toBe('de');
    expect(pickLanguage(null, ['es-ES', 'en'])).toBe('es');
    expect(pickLanguage(null, ['pt-BR'])).toBe('pt');
    expect(pickLanguage(null, ['ja-JP'])).toBe('en');
    expect(translate('es', 'stepMute', { k: 2, n: 4 })).toBe('Silenciar 2 envíos a CUE 4');
    expect(translate('fr', 'nope')).toBe('nope');
  });
});
