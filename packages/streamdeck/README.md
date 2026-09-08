# Session deck logical view

`SessionDeck` is a synchronous, device-independent 15-key session view. Feed it
the complete current live-record snapshot after each committed core update.
It keeps positions stable, fills vacant positions with new sessions, and adds
another page for the thirteenth session. Records use `(source, id)` identity.

```ts
import { SessionDeck } from './index';

const deck = new SessionDeck(savedLayout); // savedLayout is optional
deck.update(records);
const plan = deck.page(); // { index, pageCount, epoch, keys }
deck.down(0);
const intent = deck.up(0);
// Pass effect intents through host authorization and current-revision checks.
const layout = deck.exportLayout();
```

Content occupies keys 0–9, 11, and 12. Key 10 goes back, key 14 goes forward,
and key 13 pins the longest-waiting urgent session. A pin press navigates to
the original session; it never executes its action. Navigation keys report
urgent session counts strictly before or after the current page.

`page(index)` selects a zero-based page and clamps at the ends. Page changes
invalidate outstanding presses and require all held keys to release. The
currently visible empty final page remains until navigation leaves it.
`up()` yields an effect intent, a navigation intent, or `undefined`. Navigation
intents have already been applied to the view. Effects have not been executed.

The layout snapshot contains positions and current page, not signal state or
pending input. Persist it separately from the core snapshot. Version 1 denotes
this exact 15-key arrangement; unsupported layouts are rejected.

This module models an immediately displayed plan. It does **not** claim that
calling `page()` means an image reached physical hardware. A renderer/driver
integration must retain the binding of each successfully written image,
disable input during writes/reconnection, and reject old display epochs.
Do not attach raw hardware key events to this model without that layer.
The `lifecycle.ts`, `hid.ts`, and `render.ts` modules now provide serialized HID ownership, static images, suspend/resume, and write-time input gating. The host connects OS session events and persists layout. Event/gauge support and effect execution remain outside this implementation.

Run `bun test packages/streamdeck` for allocation, pin, restore, and input
regression scenarios.
