import { handle, listeners, startLiveMail } from './router';

// A minimal EventSource replacement wired to the mock router's emitter.
class MockEventSource extends EventTarget {
  url: string;
  readyState = 1;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private unsub: () => void;
  constructor(url: string) {
    super();
    this.url = url;
    const fn = (ev: { type: string; data: unknown }) => {
      this.dispatchEvent(new MessageEvent(ev.type, { data: JSON.stringify(ev.data) }));
    };
    listeners.add(fn);
    this.unsub = () => listeners.delete(fn);
    setTimeout(() => this.onopen?.(new Event('open')), 10);
  }
  close() {
    this.readyState = 2;
    this.unsub();
  }
}

export function installMock() {
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`)) return handle(input, init);
    return realFetch(input, init);
  }) as typeof window.fetch;
  (window as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  startLiveMail();
  console.info('[postino] mock API active. Login password: "password"');
}
