# @designjs/chrome-extension

MV3 Chrome extension — capture any web page or DOM subtree and drop it onto the running [DesignJS](https://github.com/rubychilds/DesignJS) canvas as **real, editable HTML/CSS**. Private workspace package — not published to the Chrome Web Store yet; load unpacked from `dist/`.

The content script walks the DOM, serializes computed styles + author CSS, hoists shared classes, takes a stitched screenshot for a backplate, and ships everything over the local WebSocket bridge into a fresh artboard on the canvas. See the [repo root README](https://github.com/rubychilds/DesignJS#capture-web-pages-with-the-chrome-extension) for the full capture pipeline (and known limitations).

## Install (load unpacked)

```bash
pnpm install                                       # from repo root
pnpm --filter @designjs/chrome-extension build     # builds dist/
```

In Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** and select `packages/chrome-extension/dist/`
4. Pin the DesignJS icon to the toolbar

For hot rebuild while developing:

```bash
pnpm --filter @designjs/chrome-extension dev
```

Reload via the circular **reload** arrow on the DesignJS card in `chrome://extensions` whenever the source changes.

## Source layout

```
src/
├── background/   # Service worker — owns the WS bridge connection
├── capture/      # DOM walker + computed-style serializer
├── content/      # Content-script entry — overlay UI + capture orchestration
├── popup/        # Minimal React popup
├── transport/    # WebSocket peer for the DesignJS bridge
└── utils/        # Chrome API promise wrappers + timeout helpers
```

## Architecture

The decisions that shaped this package — direct WebSocket transport, hybrid inline/inherited-diff style serialization, content-script overlay (not a browser-action popup), `add_css_rules` bridge tool for author CSS, hybrid screenshot backplate — are recorded in:

- [ADR-0011 — Browser extension architecture](../../docs/adr/0011-browser-extension-architecture.md) (transport + style serialization + 2026-05-24 CSS routing pivot addendum)
- [ADR-0012 — Capture fidelity evolution](../../docs/adr/0012-capture-fidelity-evolution.md) (screenshot backplate, CDP pivot, future direction)
- [`docs/epic-8-followups.md`](../../docs/epic-8-followups.md) (operational state, open followups)

## Packaging

```bash
pnpm --filter @designjs/chrome-extension package
```

Produces `designjs-extension.zip` at the package root, ready for a Chrome Web Store submission (planned for v0.3 public).

## License

MIT — see [LICENSE](LICENSE) (or the LICENSE in the repo root).
