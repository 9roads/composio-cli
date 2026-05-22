import { describe, expect, it } from 'vitest';
import { executeHelp } from '../src/help/execute.js';
import { proxyHelp } from '../src/help/proxy.js';
import { rootHelp } from '../src/help/root.js';
import { searchHelp } from '../src/help/search.js';

describe('help output', () => {
  it('matches root help snapshot', () => {
    expect(rootHelp()).toMatchSnapshot();
  });

  it('matches search help snapshot', () => {
    expect(searchHelp()).toMatchSnapshot();
  });

  it('matches execute help snapshot', () => {
    expect(executeHelp()).toMatchSnapshot();
  });

  it('matches proxy help snapshot', () => {
    expect(proxyHelp()).toMatchSnapshot();
  });

  it('does not advertise unsupported commands', () => {
    const allHelp = [rootHelp(), searchHelp(), executeHelp(), proxyHelp()].join('\n');
    expect(allHelp).not.toMatch(/\blogin\b/);
    expect(allHelp).not.toMatch(/\blink\b/);
    expect(allHelp).not.toMatch(/\bartifacts\b/);
    expect(allHelp).not.toMatch(/\btools info\b/);
    expect(allHelp).not.toMatch(/\bdev\b/);
    expect(allHelp).not.toMatch(/\bgenerate\b/);
    expect(allHelp).not.toMatch(/\bconnections\b/);
    expect(allHelp).not.toMatch(/\btriggers\b/);
  });
});

