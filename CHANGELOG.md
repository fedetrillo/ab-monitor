# Changelog

## 1.0.3 — 2026-11-26

- **Fixed on Windows:** LUNA on Windows sizes the page to the window's outer size, title bar and frame included, so the bottom 39 px and the right 16 px were hidden. The page now leaves that space out on Windows, so everything at the bottom and right edges shows in full.
  the part you can see, so the controls at the bottom were hidden. The page now fits itself to
  the window size LUNA reports; nothing changes where the two match.
- **Version and report:** the version now shows next to the name; Alt-click on it copies a report and says so in the status bar.
- **Report copy:** Alt-click on the version now always says in the status bar that the report was copied. Where the system clipboard is blocked (seen on some Windows set-ups) it uses a fallback, and if that fails too it shows the report selected so you can copy it by hand.

## 1.0.2 — 2026-11-25

- A new icon that reads at any size: two speakers, A lit and B waiting, and the switch between
  them.
- In a narrow window, Undo MIX no longer gets cut off: when the full label does not fit next to
  the title, it shows the arrow and MIX (the full text is in its tooltip).
- Screenshots in the README and the package, and a description that starts with what it is: a
  monitor controller inside LUNA.

## 1.0.1 — 2026-11-25

- A short getting-started guide: the first time it opens it asks for your language, then walks
  you through the window in it. The **?** button brings it back.

