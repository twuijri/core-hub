import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// A Radix overlay parks `pointer-events: none` on <body> while it is open and lifts it on
// close. A test that ends with one open would make every later test in the same file think
// the page is inert, so the document starts each test the way a fresh page does.
afterEach(() => {
  document.body.style.pointerEvents = '';
});

// jsdom implements neither the Pointer Events capture API nor `scrollIntoView`, and the
// Radix primitives behind src/ui/{Menu,Select,Popover}.tsx call both while opening. Without
// these three the menus simply never appear in a test, which would say nothing about the
// browser. Real behaviour is still asserted by the Playwright journeys.
if (typeof Element !== 'undefined') {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}
// jsdom has no PointerEvent at all, so user-event falls back to MouseEvent and Radix's
// `onPointerDown` guards (which read `pointerType`) never fire. A minimal constructor is
// enough for the primitives to behave as they do in a browser.
if (typeof globalThis.PointerEvent === 'undefined') {
  class JsdomPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  globalThis.PointerEvent = JsdomPointerEvent as unknown as typeof PointerEvent;
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof globalThis.DOMRect === 'undefined') {
  globalThis.DOMRect = class {
    constructor(
      readonly x = 0,
      readonly y = 0,
      readonly width = 0,
      readonly height = 0,
    ) {}
    readonly top = 0;
    readonly left = 0;
    readonly right = 0;
    readonly bottom = 0;
    toJSON() {
      return this;
    }
    static fromRect() {
      return new globalThis.DOMRect();
    }
  } as unknown as typeof DOMRect;
}
