import fs from 'node:fs/promises'
import path from 'node:path'

export class FileService {
  async read(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8')
  }

  async write(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async list(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath)
  }
}

export const fileService = new FileService()
