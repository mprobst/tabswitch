# <img src="logo128.png" width="48" height="48" alt="" align="top"> tabswitch

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

Requires Node.js 24 (see `.nvmrc`). Run `npm install` first.

- `npm run build` compiles the extension; `npm run bundle` also creates
  `tabswitch.zip` for the Chrome Web Store.
- `npm run check` runs everything that should pass before a commit: the
  formatting check, linting, type checks and unit tests.
- `npm run format` formats all files with [Prettier](https://prettier.io);
  `npm run lint` runs [ESLint](https://eslint.org) with typescript-eslint.

### Releasing

`npm run release -- <patch|minor|major>` releases a new version from an
up-to-date `main`. It runs `npm run check`, bumps the version in
`manifest.json` and `package.json`, builds the zip, commits and tags
`vX.Y.Z` with the commit subjects since the last release as notes, pushes,
creates a GitHub release with the zip, and uploads the zip to the Chrome Web
Store, where it is submitted for review. `--dry-run` stops after the checks
and shows the new version and notes.

The Web Store upload needs `CLIENT_ID`, `CLIENT_SECRET` and `REFRESH_TOKEN`
in the environment or in a git-ignored `.env` file; see
[chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload-keys)
for how to create them. The extension and publisher IDs are `webStore` in
`package.json` (`PUBLISHER_ID` in the environment also works). `--no-store`
skips the upload. The release also needs
`gh` to be logged in.

### Tests

`npm test` runs fast unit tests (no browser needed, `node:test`) against an
in-memory fake of the Chrome APIs; see `test/unit`. `npm run typecheck`
type-checks the extension and the tests. Tests are TypeScript, run directly
by Node (type stripping) and by Playwright, without a build step.

`npm run test:e2e` runs end-to-end tests with [Playwright
Test](https://playwright.dev/docs/intro) in a real Chromium
(`npx playwright install chromium` downloads it, or set `CHROME_PATH`). Each
test starts a fresh browser with a temporary profile, loads the extension plus
a small driver extension (`test/driver-ext`) and presses the actual keyboard
shortcut. They need:

- an X display on which window focus works; headless Chromium reports every
  window as focused. Use Xvfb: `xvfb-run -a npm run test:e2e`.
- `xdotool`, because extension shortcuts don't fire for synthetic (CDP) key
  events.

On Debian/Ubuntu: `sudo apt install xvfb xdotool`. Set `EXT_DIR` to run the
tests against a different build of the extension. For failed tests, the
report (`npx playwright show-report`) includes the extension's console output
and the final window and tab state.

## License

[MIT](LICENSE)
