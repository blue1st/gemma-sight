import { app, shell, BrowserWindow, ipcMain, desktopCapturer, dialog, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

let logWindow: BrowserWindow | null = null

const LOG_WINDOW_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Match Log</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #1a1a2e; color: #eee; padding: 0;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 12px; background: #16213e;
    border-bottom: 1px solid #0f3460;
  }
  .toolbar h1 { font-size: 14px; font-weight: 600; color: #e94560; }
  .toolbar-controls { display: flex; align-items: center; gap: 12px; }
  .toolbar span { font-size: 12px; color: #888; }
  .sound-control { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #aaa; cursor: pointer; }
  .sound-control input { cursor: pointer; }
  .clear-btn {
    padding: 4px 12px; border: none; border-radius: 4px;
    background: #e94560; color: white; font-size: 12px; cursor: pointer;
  }
  .clear-btn:hover { background: #c73650; }
  #log { padding: 4px 0; }
  .entry {
    display: flex; gap: 10px; padding: 6px 12px;
    border-bottom: 1px solid #0f3460; font-size: 12px;
    align-items: baseline;
  }
  .entry:hover { background: rgba(233,69,96,0.08); }
  .time { color: #53d8fb; font-weight: 600; white-space: nowrap; font-family: monospace; }
  .match { color: #e94560; font-weight: 600; white-space: nowrap; }
  .text { color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .empty { text-align: center; padding: 40px; color: #555; font-size: 13px; }
</style>
</head>
<body>
  <div class="toolbar">
    <h1>\u{1F514} Match Log</h1>
    <div class="toolbar-controls">
      <label class="sound-control">
        <input type="checkbox" id="playSound" checked> Sound
      </label>
      <span id="count">0 entries</span>
      <button class="clear-btn" onclick="clearLog()">Clear</button>
    </div>
  </div>
  <div id="log"><div class="empty">Waiting for matches...</div></div>
  <script>
    const { ipcRenderer } = require('electron');
    const logEl = document.getElementById('log');
    const countEl = document.getElementById('count');
    const playSoundEl = document.getElementById('playSound');
    let entries = 0;

    // Simple beep sound using Web Audio API
    function playBeep() {
      if (!playSoundEl.checked) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    }

    ipcRenderer.on('notify-log-entry', (_, entry) => {
      if (entries === 0) logEl.innerHTML = '';
      entries++;
      const div = document.createElement('div');
      div.className = 'entry';
      div.innerHTML =
        '<span class="time">' + escHtml(entry.timestamp) + '</span>' +
        '<span class="match">' + escHtml(entry.matched) + '</span>' +
        '<span class="text">' + escHtml(entry.text) + '</span>';
      logEl.appendChild(div);
      countEl.textContent = entries + ' entries';
      div.scrollIntoView({ behavior: 'smooth' });
      playBeep();
    });

    ipcRenderer.on('notify-log-clear', () => {
      logEl.innerHTML = '<div class="empty">Waiting for matches...</div>';
      entries = 0;
      countEl.textContent = '0 entries';
    });

    function clearLog() {
      ipcRenderer.send('notify-log-clear-from-window');
      logEl.innerHTML = '<div class="empty">Waiting for matches...</div>';
      entries = 0;
      countEl.textContent = '0 entries';
    }

    function escHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
  </script>
</body>
</html>`

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    title: `${app.getName()} v${app.getVersion()}`,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Prevent HTML <title> from overriding our custom title with version
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.gemmasight.app')

  // Register custom protocol to serve local video files
  protocol.handle('local-video', async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    console.log('local-video protocol: serving', filePath)

    const fs = await import('fs')
    const path = await import('path')

    const stat = fs.statSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.m4v': 'video/mp4',
      '.ogg': 'video/ogg'
    }
    const contentType = mimeTypes[ext] || 'application/octet-stream'

    // Handle Range requests (required for video seeking)
    const rangeHeader = request.headers.get('range')
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      const chunkSize = end - start + 1

      const stream = fs.createReadStream(filePath, { start, end })
      // Collect chunks into a buffer (Electron Response needs a body)
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const buffer = Buffer.concat(chunks)

      return new Response(buffer, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': chunkSize.toString(),
          'Accept-Ranges': 'bytes'
        }
      })
    }

    // Full file request
    const buffer = fs.readFileSync(filePath)
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': stat.size.toString(),
        'Accept-Ranges': 'bytes'
      }
    })
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('get-desktop-sources', async (_, opts) => {
    const sources = await desktopCapturer.getSources(opts)
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id
    }))
  })

  ipcMain.handle('select-video-file', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Select Video File',
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogg'] }
      ],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  })

  ipcMain.handle('save-analysis-result', async (_, content: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Save Analysis Result',
      defaultPath: `analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })

    if (canceled || !filePath) return false

    try {
      const fs = await import('fs/promises')
      await fs.writeFile(filePath, content, 'utf8')
      return true
    } catch (err) {
      console.error('Failed to save file:', err)
      return false
    }
  })

  ipcMain.handle('select-output-file', async () => {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Select Output File for Streaming',
      defaultPath: 'streaming-output.txt',
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })
    return canceled ? null : filePath
  })

  ipcMain.handle(
    'append-to-file',
    async (_, { filePath, content }: { filePath: string; content: string }) => {
      try {
        const fs = await import('fs/promises')
        await fs.appendFile(filePath, content, 'utf8')
        return true
      } catch (err) {
        console.error('Failed to append to file:', err)
        return false
      }
    }
  )

  // --- Notify Log Window ---
  ipcMain.handle('open-notify-log-window', async () => {
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.focus()
      return true
    }
    logWindow = new BrowserWindow({
      width: 520,
      height: 400,
      title: 'Match Log',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })
    logWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOG_WINDOW_HTML)}`)
    logWindow.on('closed', () => {
      logWindow = null
    })
    return true
  })

  ipcMain.handle(
    'add-notify-log-entry',
    async (_, entry: { timestamp: string; matched: string; text: string }) => {
      if (logWindow && !logWindow.isDestroyed()) {
        logWindow.webContents.send('notify-log-entry', entry)
      }
    }
  )

  ipcMain.handle('clear-notify-log-window', async () => {
    if (logWindow && !logWindow.isDestroyed()) {
      logWindow.webContents.send('notify-log-clear')
    }
  })

  ipcMain.on('notify-log-clear-from-window', () => {
    // Forward clear request back to renderer
    const mainWin = BrowserWindow.getAllWindows().find((w) => w !== logWindow && !w.isDestroyed())
    if (mainWin) {
      mainWin.webContents.send('notify-log-cleared')
    }
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
