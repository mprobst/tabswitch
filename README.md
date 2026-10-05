# tabswitch

A simple Chrome extension to switch between the two most recently used tabs,
with minimal permissions required. There are other extensions with similar
functionality, but they often require excessive permissions.

## Installation

You can install this by visiting [Switch Tabs in the Chrome Web
Store](https://chrome.google.com/webstore/detail/switch-tabs/jpfcacngcfejgnoaobkgoojockhdlphi).

## Permissions

The extension requires Storage permissions to keep the list of recently used
tabs while its service worker is suspended. The list lives in session storage,
so it is cleared when Chrome restarts (tab IDs don't survive a restart anyway).

## Configuration

By default, you can toggle between the two most recently used tabs using
`Ctrl-Q` (on Mac, Windows, and Linux alike). You can choose a different
keybinding via `More Tools -> Extensions -> (Hotdog Menu) Keybindings`.

## Development

`npm run build` compiles the extension and creates `tabswitch.zip` for upload.

### Tests

`npm test` runs fast unit tests (no browser needed) against an in-memory fake of
the Chrome APIs; see `test/unit`.

`npm run test:e2e` runs end-to-end tests in a real Chromium (Playwright's
build; `npx playwright-core install chromium` downloads it, or set
`CHROME_PATH`). Each test starts a fresh browser with a temporary profile,
loads the extension plus a small driver extension (`test/driver-ext`) and
presses the actual keyboard shortcut. They need:

- an X display on which window focus works; headless Chromium reports every
  window as focused. Use Xvfb: `xvfb-run -a npm run test:e2e`.
- `xdotool`, because extension shortcuts don't fire for synthetic (CDP) key
  events.

On Debian/Ubuntu: `sudo apt install xvfb xdotool`. Set `EXT_DIR` to run the
tests against a different build of the extension.
