import fs from 'fs'
import path from 'path'
import express from 'express'
import { Logger } from '../types.js'

export interface DataOperationOptions {
  dataDir: string
  dataPath: string
  logger: Logger
}

export interface DirectoryEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
  modified: string
}

export function createDataEndpoints(
  app: express.Application,
  options: DataOperationOptions,
  authMiddleware?: express.RequestHandler,
) {
  const { dataDir, dataPath, logger } = options

  const sanitizePath = (requestPath: string): string => {
    const normalizedPath = path.normalize(requestPath)
    if (normalizedPath.includes('..')) {
      throw new Error('Path traversal not allowed')
    }
    return path.join(dataDir, normalizedPath)
  }

  const getDirectoryContents = async (
    fullPath: string,
  ): Promise<DirectoryEntry[]> => {
    try {
      const entries = await fs.promises.readdir(fullPath)
      const results: DirectoryEntry[] = []

      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry)
        try {
          const stats = await fs.promises.stat(entryPath)
          results.push({
            name: entry,
            type: stats.isDirectory() ? 'directory' : 'file',
            size: stats.isFile() ? stats.size : undefined,
            modified: stats.mtime.toISOString(),
          })
        } catch (err) {
          logger.error(`Error getting stats for ${entryPath}:`, err)
        }
      }

      return results.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
    } catch (err) {
      throw new Error(`Unable to read directory: ${err}`)
    }
  }

  app.get(
    `${dataPath}/*`,
    authMiddleware || ((_req, _res, next) => next()),
    async (req, res) => {
      try {
        const requestPath = (req.params as any)[0] || ''
        const fullPath = sanitizePath(requestPath)

        logger.info(`Data operation request: ${requestPath} -> ${fullPath}`)

        const stats = await fs.promises.stat(fullPath)

        if (stats.isDirectory()) {
          const contents = await getDirectoryContents(fullPath)
          res.json({
            type: 'directory',
            path: requestPath,
            contents,
          })
        } else if (stats.isFile()) {
          const content = await fs.promises.readFile(fullPath, 'utf8')
          res.json({
            type: 'file',
            path: requestPath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
            content,
          })
        } else {
          res.status(400).json({ error: 'Path is neither file nor directory' })
        }
      } catch (err) {
        logger.error('Data operation error:', err)
        if ((err as any).code === 'ENOENT') {
          res.status(404).json({ error: 'Path not found' })
        } else if ((err as any).message?.includes('Path traversal')) {
          res.status(400).json({ error: 'Invalid path' })
        } else {
          res.status(500).json({ error: 'Internal server error' })
        }
      }
    },
  )

  logger.info(
    `Data endpoints registered at ${dataPath}/* serving from ${dataDir}`,
  )
}
