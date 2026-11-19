# System Tray

**Windows-style background apps & system tray for GNOME Wayland — crisp icons, instant open, total kill.**

![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-49%20%7C%2050%20%7C%2051-4a86cf?style=flat-square&logo=gnome)
![Wayland](https://img.shields.io/badge/Display-Wayland-orange?style=flat-square)
![License](https://img.shields.io/badge/License-GPL--3.0-green?style=flat-square)

A lightweight, Wayland-native GNOME Shell extension that brings a clean, Libadwaita-inspired background applications manager and system tray to your top panel.

---

## Preview

![System Tray Preview](screenshot.jpg)

---

## Why System Tray?

Many desktop apps continue running in the background after closing their windows, while traditional tray extensions rely solely on legacy protocols, display blurry or monochrome icons, or consume unnecessary resources.

**System Tray** combines event-driven Linux & GNOME technologies into a minimal, responsive popup:

- **Auto-Hide Top Bar Button:** Stays hidden when no matching apps are running (optional), with a clean count badge when active.
- **Multi-Layer App Discovery:** Uses `systemd --user` cgroups (`app.slice`), `StatusNotifierWatcher` (SNI), XDG Background Portal cross-checks, and GNOME `AppSystem` — filtering out OS/system daemons automatically.
- **Crisp Real App Icons:** Prioritizes native `.desktop` vector SVG / high-DPI icons over low-resolution tray pixmaps.
- **Click-to-Open:** Click anywhere on an app card to focus or wake its window on Wayland (using valid XDG Activation tokens).
- **Full Cgroup Force Kill:** Click **Kill** to terminate the entire application cgroup and all child processes cleanly (supports both **Instant Kill** and **Safe Kill** modes, plus optional **Sure?** confirmation).
- **Two Clean Views:** Toggle between **Background** apps and **All Apps** with live process counts and smooth hidden scrolling.
- **Custom Apps Watchlist:** Add standalone AppImages, binaries, or command-line keywords from Preferences.

---

## Installation

### Option 1: GNOME Extensions Website *(Recommended)*
Install directly from [extensions.gnome.org](https://extensions.gnome.org/) once approved.

### Option 2: Manual Installation from GitHub
1. Clone this repository directly into your GNOME Shell extensions folder:
   ```bash
   git clone https://github.com/aninduuthsara/system-tray.git ~/.local/share/gnome-shell/extensions/system-tray@anindu.uthsara
