import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  dialog,
  protocol
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

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
