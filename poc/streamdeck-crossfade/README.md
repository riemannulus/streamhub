# Streamhub Studio + Stream Deck plugin PoC

This throwaway vertical slice tests the smallest useful hybrid architecture:

- Stream Deck owns HID, device lifecycle, and plugin hosting.
- The plugin owns all 15 visible cells so they can crossfade as one canvas.
- Studio owns the background, fixed-button placement, and dynamic-button rules.

The included page uses the supplied Cyberpunk artwork as a continuous 5×3
background. A translucent Firefox button can be moved to any cell in Studio;
pressing that physical key launches the Firefox bundle without using a shell.
The canvas follows the Stream Deck Classic 480×272 LCD pixel layout—including
its 11px/5px leading margins and 25px gaps—so the artwork matches the native
lock-screen composition instead of being squeezed into a gapless 5×3 grid.

## Run

The development plugin must already be linked and all 15 cells must contain the
`Streamhub 캔버스 셀` action.

```sh
bun run check
bun run studio
streamdeck restart com.streamhub.crossfade-poc
```

Open <http://127.0.0.1:31418>. Select a cell or change the button controls, then
press `장치에 적용`. Studio renders all 105 PNG files before atomically publishing
the new generation. The plugin then sends the seven frames to all 15 visible
actions over roughly 230 ms.

`bun run studio` is a foreground development server, so keep that terminal
running while editing. If it stops, Studio marks the connection as unavailable;
restart the command and the open page reconnects automatically without discarding
the current draft.

Studio also persists the first Claude automation rule shape: enabled state,
maximum visible buttons, and completed-session retention. This PoC does not yet
connect to a live Claude session collector; it only validates where that rule is
edited and how the runtime configuration is separated from the device plugin.

Generated frames, live settings, logs, build output, and dependencies are ignored.
The supplied background image is kept in the plugin's `studio/background.jpg`.
