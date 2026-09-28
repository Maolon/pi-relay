import { it, expect } from 'vitest';
import { Presentation } from '../../dist/pi/presentation.js';

function harness({ mode = 'tui', active = true } = {}) {
  const calls = { status: [], widget: [] };
  const ctx = {
    mode,
    ui: {
      theme: { fg: (color, text) => `<${color}>${text}</${color}>` },
      setStatus: (key, text) => calls.status.push([key, text]),
      setWidget: (key, content) => calls.widget.push([key, content]),
    },
    sessionManager: { getEntries: () => [] },
  };
  const core = {
    list: () => [{ id: 'bnd-1', authority: 'valid', state: active ? 'active' : 'paused' }],
    store: { all: () => [] },
  };
  const presentation = new Presentation({ appendEntry() {} }, ctx, core);
  return { presentation, calls };
}

it('shows a dimmed "relay: on" footer status, not a widget above the editor', () => {
  const { presentation, calls } = harness();
  presentation.flush();
  expect(calls.status).toEqual([['pi-relay', '<dim>relay: on</dim>']]);
  expect(calls.widget).toEqual([]);
  presentation.dispose();
  expect(calls.status.at(-1)).toEqual(['pi-relay', undefined]);
});

it('clears the footer status when no binding is active', () => {
  const { presentation, calls } = harness({ active: false });
  presentation.flush();
  expect(calls.status).toEqual([['pi-relay', undefined]]);
  presentation.dispose();
});

it('touches no TUI status outside TUI mode', () => {
  const { presentation, calls } = harness({ mode: 'rpc' });
  presentation.flush();
  presentation.dispose();
  expect(calls.status).toEqual([]);
  expect(calls.widget).toEqual([]);
});
