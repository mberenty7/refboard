# RefBoard

An infinite reference canvas for tablets, in the spirit of PureRef, built for painting from reference photos (watercolor in particular). It's a plain HTML/CSS/JS web app with no dependencies or build step, and it installs as an offline app on Android.

**Live app:** https://mberenty7.github.io/refboard/

## Features

- **Infinite canvas**: one finger pans, pinch zooms, double-tap fits everything or zooms to a photo
- **Arrange photos**: drag to move; select then pinch-twist (or drag the corner handle) to resize and rotate; flip, layer, duplicate, lock
- **Value studies** per photo: Color → Gray → 3 values → 5 values (notan). Gray uses perceived brightness, so yellow reads light and blue reads dark
- **Grid overlay**: 3×3, 4×4 or 6×6 for transferring a drawing
- **Squint mode**: blurs the board so you see the big shapes and masses
- **Value check**: shows the whole board in grayscale
- **Color picker**: touch a photo to read its hex color and value %; picks collect in a palette tray
- **Painting mode**: locks every photo so a brushing hand can't move things; pan and zoom still work
- **Keep screen awake**, fullscreen, three background tones (dark, mid gray, paper)
- **Add photos** from the gallery, from Google Drive or other files, by paste, by drag and drop, or by sharing from other apps
- **Multiple boards** saved on the device (IndexedDB); export and import a board as a single `.json` file for backup
- Big photos are downscaled to 2048 px on import to stay light on tablet memory

## Install on an Android tablet

1. Open the live app link in **Chrome**.
2. Tap **⋮ → Add to home screen → Install**.
3. It opens fullscreen, works offline, and shows up in the Android Share menu.

### Adding images from Google Drive

Tap **+ → Files & Drive**, open the **☰** side menu in the file browser and choose **Drive**. Press Back to leave the file browser without picking anything.

You can also share photos into RefBoard from other apps (needs the installed app).

## Gestures

| Action | Gesture |
|---|---|
| Pan | Drag empty space, or two fingers anywhere |
| Zoom | Pinch (on empty space or an unselected photo) |
| Fit all | Double-tap empty space |
| Zoom to a photo | Double-tap the photo |
| Move a photo | Drag it |
| Resize / rotate | Tap to select, then pinch and twist on it, or drag its corner handle |

On a computer: mouse wheel zooms, trackpad scroll pans, Ctrl+Z / Ctrl+Shift+Z undo and redo, Delete removes the selected photo, F fits all.

## Development

Serve the folder with any static server and open it in a browser:

```bash
npx http-server . -p 8080
```

The service worker, installing, keep-awake, clipboard paste and the share target need HTTPS or `localhost`.

## Deployment

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`. In the repo's **Settings → Pages**, set **Source** to **GitHub Actions** once.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure and toolbars |
| `style.css` | Styles |
| `app.js` | Canvas, gestures, image processing, storage |
| `sw.js` | Offline cache and Android share target |
| `manifest.webmanifest` | Install metadata |
| `icons/` | App icons |

## License

MIT
