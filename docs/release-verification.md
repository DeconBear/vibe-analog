# Release Verification Checklist (Desktop)

Status as of v0.1.11. This checklist exists because CI builds are **unsigned**
and the auto-update consumer is **not yet wired**; both facts change what
"released" means for users. Re-run the relevant sections before claiming any
release is stable on real hardware.

## 1. Signing status (blocking for "stable" claim)

- CI builds are unsigned by design (`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` in
  `.github/workflows/release-desktop.yml`). There are no certificates in the
  repository or GitHub secrets yet.
- Consequences today:
  - **Windows**: SmartScreen shows "Windows protected your PC" on first run
    (NSIS installer is unsigned). Users must click "More info → Run anyway".
  - **macOS**: the arm64 DMG is ad-hoc/unsigned; Gatekeeper blocks launch from
    Finder. Users must right-click → Open, or run
    `xattr -dr com.apple.quarantine /Applications/Vibe\ Analog.app`.
  - **Linux**: AppImage unsigned; no platform gate, `chmod +x` and run.
- To sign for real:
  1. Windows: acquire an OV/EV code-signing certificate; add
     `CSC_LINK` / `CSC_KEY_PASSWORD` secrets; remove the
     `CSC_IDENTITY_AUTO_DISCOVERY` override.
  2. macOS: Apple Developer ID Application certificate + notarization
     (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets;
     enable `notarize` in `electron-builder.yml`).
  3. Verify signatures: `signtool verify /pa <exe>` (Windows),
     `codesign --verify --deep --strict` + `spctl -a` (macOS).

## 2. Auto-update status (not wired yet)

- `electron-builder.yml` sets `publish: github`, so every release uploads
  `latest.yml` / `latest-mac.yml` / `latest-linux.yml` update feeds. However,
  **no code consumes them**: `electron-updater` is not a dependency and
  `autoUpdater` is never imported in `electron/`.
- Until this is implemented, users must download installers manually; do NOT
  tell anyone that auto-update works.
- Implementation follow-up (small, but needs GUI validation per AGENTS.md):
  add `electron-updater`, check for updates after app ready, surface a
  renderer notice + "download & restart" action, then validate with a staged
  feed (see §4).

## 3. Per-platform real-machine smoke (run on each release)

Windows 10/11 x64:
- [ ] Installer runs; SmartScreen path understood and documented in release notes.
- [ ] App launches; create a simulation project; run one agent chat turn.
- [ ] Export EDA: KiCad push to a local folder; re-open after restart.
- [ ] Uninstall via "Apps & features" removes the app cleanly.

macOS (Apple Silicon):
- [ ] DMG mounts; app copied to /Applications; quarantine bypass works as documented.
- [ ] Same project/chat/export smoke as Windows.
- [ ] `electron-builder.yml` targets arm64 only — state this in release notes
      (Intel macs are unsupported today).

Linux x64:
- [ ] AppImage runs on a stock Ubuntu 22.04 (the CI build host).
- [ ] Same project/chat/export smoke.

## 4. Update-feed rehearsal (after electron-updater is wired)

- [ ] Publish release `vN`; install it on a clean machine.
- [ ] Publish `vN+1` as a draft; run the app with `update-electron-app` style
      dev-app-update.yml pointed at the draft feed.
- [ ] Confirm: update detected → downloaded → restart installs → version
      reported by the app matches `vN+1`.
- [ ] Only then flip the draft to published.

## 5. Release pipeline facts (verified 2026-09)

- Tag push `v*` triggers `release-desktop.yml`: three-platform builds →
  `publish-github-release` creates the release with installers + blockmaps +
  `latest*.yml` and auto-generated notes. Observed duration ≈ 5 minutes.
- `npm run test:schematic-release` / `:gui` are **not** part of the release
  workflow; run them before tagging (see AGENTS.md).
- `npm run test:unit` is also not part of CI release gating — as of v0.1.11 it
  has 2 pre-existing failures (grid renderer); fix or quarantine before the
  next release.
