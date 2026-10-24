import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { PermissionReply, PermissionRequest } from '@/types/permission';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
// React DOM detects input-event support when imported.
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, Element: browser.Element,
  HTMLElement: browser.HTMLElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, KeyboardEvent: browser.KeyboardEvent,
  Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'permission-actions-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
  if (url.pathname === '/api/fs/home') {
    return Response.json({ home: '/fixture', chatsRoot: '/fixture/chats' });
  }
  if (url.pathname === '/api/config/settings') return Response.json({});
  throw new Error(`Unexpected request: ${url.pathname}`);
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { PermissionActions } = await import('./PermissionCard');
const { usePermissionResponse } = await import('./usePermissionResponse');
const sessionActions = await import('@/sync/session-actions');

const permission: PermissionRequest = {
  id: 'permission-reason', sessionID: 'child-session', action: 'bash',
  resources: ['pwd'], metadata: {},
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

afterAll(async () => {
  await browser.happyDOM.close();
  fetchSpy.mockRestore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const button = (label: string) => {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const click = async (label: string) => {
  await act(async () => button(label).click());
};
const textarea = () => {
  const field = host.querySelector('textarea');
  if (!field) throw new Error('Missing reason field');
  return field;
};
const typeReason = async (value: string) => {
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Missing textarea value setter');
  await act(async () => {
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    textarea().dispatchEvent(new Event('change', { bubbles: true }));
  });
};

const responseRecorder = (...results: boolean[]) => {
  const calls: Array<[PermissionReply, string?]> = [];
  const respond = async (...args: [PermissionReply, string?]): Promise<boolean> => {
    calls.push(args);
    return results.shift() ?? true;
  };
  return { respond, calls };
};

for (const variant of ['inline', 'dock'] as const) {
  describe(`PermissionActions ${variant}`, () => {
    const render = async (onRespond: (reply: PermissionReply, message?: string) => Promise<boolean>, isResponding = false) => {
      await act(async () => root.render(
        <I18nProvider>
          <PermissionActions permission={permission} variant={variant} isResponding={isResponding} onRespond={onRespond} />
        </I18nProvider>,
      ));
    };

    test('ordinary denial sends no comment', async () => {
      const { respond, calls } = responseRecorder();
      await render(respond);
      await click('Deny');
      expect(calls).toEqual([['reject']]);
    });

    test('opening and cancelling sends nothing', async () => {
      const { respond, calls } = responseRecorder();
      await render(respond);
      await click('Deny with reason');
      expect(document.activeElement).toBe(textarea());
      await typeReason('Use a read-only command');
      await click('Cancel');
      expect(host.querySelector('textarea')).toBeNull();
      expect(calls).toHaveLength(0);
    });

    test('empty and whitespace-only reasons cannot submit', async () => {
      const { respond, calls } = responseRecorder();
      await render(respond);
      await click('Deny with reason');
      expect(button('Deny and send').disabled).toBe(true);
      await typeReason('  \n  ');
      expect(button('Deny and send').disabled).toBe(true);
      await click('Deny and send');
      expect(calls).toHaveLength(0);
    });

    test('submits a trimmed reason with the rejection', async () => {
      const { respond, calls } = responseRecorder();
      await render(respond);
      await click('Deny with reason');
      await typeReason('  Use a read-only command\n');
      await click('Deny and send');
      expect(calls).toEqual([['reject', 'Use a read-only command']]);
    });

    test('Enter in the reason field submits without a newline or composer submit', async () => {
      const { respond, calls } = responseRecorder();
      const outerSubmit = () => outerCalls.push(true);
      const outerCalls: boolean[] = [];
      await act(async () => root.render(
        <I18nProvider>
          <form onSubmit={(event) => { event.preventDefault(); outerSubmit(); }}>
            <PermissionActions permission={permission} variant={variant} isResponding={false} onRespond={respond} />
          </form>
        </I18nProvider>,
      ));
      await click('Deny with reason');
      await typeReason('Use a read-only command');
      await act(async () => {
        textarea().dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true,
        }));
      });
      expect(calls).toEqual([['reject', 'Use a read-only command']]);
      expect(textarea().value).toBe('Use a read-only command');
      expect(outerCalls).toHaveLength(0);
    });

    test('failed submission retains the reason for retry', async () => {
      const { respond, calls } = responseRecorder(false, true);
      await render(respond);
      await click('Deny with reason');
      await typeReason('Keep the original file');
      await click('Deny and send');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('Try again');
      expect(textarea().value).toBe('Keep the original file');
      expect(button('Deny and send').disabled).toBe(false);
      await click('Deny and send');
      expect(calls).toEqual([
        ['reject', 'Keep the original file'],
        ['reject', 'Keep the original file'],
      ]);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    test('pending submission disables editing and cancellation', async () => {
      const { respond, calls } = responseRecorder();
      await render(respond);
      await click('Deny with reason');
      await typeReason('Keep the original file');
      await render(respond, true);
      expect(textarea().disabled).toBe(true);
      expect(button('Cancel').disabled).toBe(true);
      expect(button('Deny and send').disabled).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });
}

describe('reason controls inside the composer', () => {
  test('sending the reason creates no nested form and does not submit the composer', async () => {
    const { respond, calls } = responseRecorder();
    const outerSubmit = () => outerCalls.push(true);
    const outerCalls: boolean[] = [];
    await act(async () => root.render(
      <I18nProvider>
        <form onSubmit={(event) => { event.preventDefault(); outerSubmit(); }}>
          <PermissionActions permission={permission} variant="inline" isResponding={false} onRespond={respond} />
        </form>
      </I18nProvider>,
    ));
    await click('Deny with reason');
    expect(host.querySelectorAll('form')).toHaveLength(1);
    expect(button('Deny and send').type).toBe('button');
    await typeReason('Use a read-only command');
    await click('Deny and send');
    expect(calls).toEqual([['reject', 'Use a read-only command']]);
    expect(outerCalls).toHaveLength(0);
  });
});

describe('permission response submission and shortcuts', () => {
  const ConnectedActions = () => {
    const { isResponding, respond } = usePermissionResponse(permission);
    return <PermissionActions permission={permission} variant="dock" isResponding={isResponding} onRespond={respond} />;
  };

  const render = async () => {
    await act(async () => root.render(<I18nProvider><ConnectedActions /></I18nProvider>));
  };

  test('repeated shortcuts cannot submit while pending or after success', async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const respond = spyOn(sessionActions, 'respondToPermission').mockImplementation(() => pending);
    const press = () => host.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', altKey: true, bubbles: true, cancelable: true,
    }));
    try {
      await render();
      await act(async () => {
        press();
        press();
      });
      expect(respond.mock.calls).toHaveLength(1);
      await act(async () => finish());
      await act(async () => press());
      expect(respond.mock.calls).toHaveLength(1);
    } finally {
      finish();
      respond.mockRestore();
    }
  });

  test('reason controls keep permission shortcuts from sending a reply', async () => {
    const respond = spyOn(sessionActions, 'respondToPermission').mockResolvedValue(undefined);
    try {
      await render();
      await click('Deny with reason');
      await typeReason('Use a read-only command');
      await act(async () => {
        for (const target of [textarea(), button('Cancel'), button('Deny and send')]) {
          for (const key of ['Enter', 'Backspace']) {
            target.dispatchEvent(new KeyboardEvent('keydown', {
              key, altKey: true, bubbles: true, cancelable: true,
            }));
          }
        }
      });
      expect(respond.mock.calls).toHaveLength(0);
      await click('Deny and send');
      expect(respond.mock.calls).toEqual([
        ['child-session', 'permission-reason', 'reject', undefined, 'Use a read-only command'],
      ]);
    } finally {
      respond.mockRestore();
    }
  });

  test('an unrelated textarea retains the ordinary permission shortcut', async () => {
    const respond = spyOn(sessionActions, 'respondToPermission').mockResolvedValue(undefined);
    try {
      await render();
      const composer = document.createElement('textarea');
      host.append(composer);
      await act(async () => {
        composer.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', altKey: true, bubbles: true, cancelable: true,
        }));
      });
      expect(respond.mock.calls).toEqual([
        ['child-session', 'permission-reason', 'reject', undefined, undefined],
      ]);
      composer.remove();
    } finally {
      respond.mockRestore();
    }
  });
});
