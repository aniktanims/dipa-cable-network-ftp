# Dipa Cable Network FTP

Browse, stream and download movies and series from the DHAKA FLIX servers (172.16.50.x) on Windows and iPhone.

Made by **Mostofa Tanim Anik**, Senior Software Engineer · [GitHub](https://github.com/aniktanims)

An unofficial app for browsing the DHAKA FLIX FTP servers, for Dipa Cable TV Network users.

- Every section (English, Hindi, South Indian, Animation, TV series, Korean, Anime, ...) with year / A–Z shelves
- Opens on the newest year and remembers where you left off
- Instant filter, plus search across all sections (press Enter)
- TMDB ratings, plots and trailers; My List
- Built-in player: audio language switching (dual audio), subtitles (built-in tracks and .srt files,
  size and timing), resume, next episode, speed, keyboard shortcuts

Needs a connection that can reach the DHAKA FLIX servers.

## Download

Get the latest version from **[Releases](https://github.com/aniktanims/dipa-cable-network-ftp/releases/latest)**.

| Device | File | How to use |
| --- | --- | --- |
| Windows 10/11 | `DipaCableNetworkFTP-Portable.exe` | Double-click to run, no install needed. If Windows says "Windows protected your PC", click **More info → Run anyway** (the app isn't code-signed). |
| iPhone (iOS 17.1+) | `DipaCableNetworkFTP-iPhone-Starter.js` | Install the free [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) app, save the file to **Files › iCloud Drive › Scriptable**, then tap it in Scriptable. |

### Automatic updates

Both versions update themselves. On Windows the app checks for a new release when it starts and every
30 minutes; if there is one it downloads it, replaces itself and restarts, and it can't be used until the
update is installed. On iPhone the starter downloads the newest version every time it opens.

## Windows

On Windows the player uses FFmpeg (bundled): video is passed through untouched, audio is converted so any
track (AC3, EAC3, DTS...) plays, and image subtitles (PGS/VobSub) are burned in.

Player keys: Space play/pause · ←/→ 10 s · ↑/↓ volume · F full screen · M mute · A audio · C subtitles · N next · Esc close

## iPhone

The player repackages the MKV in the page (no re-encoding), so it needs iOS 17.1 or newer.
Text subtitles and audio switching work; image subtitles (PGS/VobSub) and DTS audio can't play there.
If a file won't play, the player offers to open it in VLC instead. Tap **Close** (top left) to leave the player.

## Development

| Task | Command |
| --- | --- |
| Run from source | `npm run dev` (desktop app) or `npm start` and open http://localhost:8000 |
| Rebuild the iPhone script | `npm run build:ios` |
| Publish an update | `release.bat patch "What changed"` (or `minor` / `major`) |

`release.bat` bumps the version, builds the Windows app and the iPhone script, commits, pushes and creates
the GitHub release. Every installed copy then updates itself.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The app UI |
| `core.js` | DHAKA FLIX catalogue logic (sections, listings, search) shared by Windows and iPhone |
| `player-ui.js` | The video player |
| `mkv.js` | In-browser MKV streaming engine (iPhone) |
| `server.js`, `player.js` | Local server and FFmpeg streaming (Windows) |
| `electron.js` | Desktop app window |
| `updater.js` | Forced self-update from GitHub releases |
| `scripts/release.js` | Publishes an update |
| `build-ios.js` | Bundles everything into the iPhone script |
