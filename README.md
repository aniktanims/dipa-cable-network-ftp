# DHAKA FLIX Movie Fetcher

Browse, stream and download movies and series from the DHAKA FLIX servers (172.16.50.x) on Windows and iPhone.

- Every section (English, Hindi, South Indian, Animation, TV series, Korean, Anime, ...) with year / A–Z shelves
- Opens on the newest year and remembers where you left off
- Instant filter, plus search across all sections (press Enter)
- TMDB ratings, plots and trailers; My List
- Built-in player: audio language switching (dual audio), subtitles (built-in tracks and .srt files,
  size and timing), resume, next episode, speed, keyboard shortcuts

Needs a connection that can reach the DHAKA FLIX servers.

## Windows

| How | Command |
| --- | --- |
| Desktop app | `dist/win-unpacked/DHAKA FLIX Movie Fetcher.exe` (or the desktop shortcut) |
| Portable app | `dist/MovieFetcher-Portable.exe` |
| In the browser | `start.bat` or `npm start`, then open http://localhost:8000 |
| Dev mode | `run-dev.bat` or `npm run dev` |
| Rebuild the app | `build.bat` |

On Windows the player uses FFmpeg (bundled): video is passed through untouched, audio is converted so any
track (AC3, EAC3, DTS...) plays, and image subtitles (PGS/VobSub) are burned in.

Player keys: Space play/pause · ←/→ 10 s · ↑/↓ volume · F full screen · M mute · A audio · C subtitles · N next · Esc close

## iPhone (no PC needed)

The iPhone version runs inside the free [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) app.

1. Install **Scriptable** from the App Store and open it once.
2. Put [`ios/Movie Fetcher.js`](ios/Movie%20Fetcher.js) in the **iCloud Drive › Scriptable** folder (Files app),
   e.g. from OneDrive / email: open the file › Share › Save to Files › iCloud Drive › Scriptable.
3. In Scriptable tap **Movie Fetcher**. To get an app icon: tap ⋯ on the script › Add to Home Screen.
4. Be on Wi-Fi/data that reaches DHAKA FLIX (same as on the PC).

On iPhone the player repackages the MKV in the page (no re-encoding), so it needs iOS 17.1 or newer.
Text subtitles and audio switching work; image subtitles (PGS/VobSub) and DTS audio can't play there.
If a file won't play, the player offers to open it in VLC instead. Tap **Close** (top left) to leave the player.

After changing `index.html`, `core.js`, `mkv.js` or `player-ui.js`, run `npm run build:ios` to regenerate the
iPhone script.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The app UI |
| `core.js` | DHAKA FLIX catalogue logic (sections, listings, search) shared by Windows and iPhone |
| `player-ui.js` | The video player |
| `mkv.js` | In-browser MKV streaming engine (iPhone) |
| `server.js`, `player.js` | Local server and FFmpeg streaming (Windows) |
| `electron.js` | Desktop app window |
| `build-ios.js` | Bundles everything into the iPhone script |
