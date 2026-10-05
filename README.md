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

`npm test` runs fast unit tests (no browser needed, `node:test`) against an
in-memory fake of the Chrome APIs; see `test/unit`. `npm run typecheck`
type-checks the extension and the tests. Tests are TypeScript, run directly
by Node (type stripping), without a build step.
