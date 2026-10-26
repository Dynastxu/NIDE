/**
 * 内容读写服务（`files.*` / `gallery.*` / `overview.*`）。
 *
 * 三者共用同一批实现（`project-files.ts`）：读目录 / 读文件 / 写文件 / 新建 / 改名 /
 * 删除，以及图鉴与概述的读与更新。拆成三个包只会让它们互相 import —— 所以一个包、
 * 一个 `apply`，注册三个命名空间。
 *
 * 「当前项目」不缓存：每次调用都问 `ctx.services.require('project')`，切项目之后
 * 不需要通知任何服务。
 */
import type { NideContext } from '../../../kernel/src/context.ts'
import type { HostProjectStore } from '../../project/src/host-project-store.ts'
import {
  allowedRoots,
  caseInsensitivePaths,
  parseCreateEntryRequest,
  parseDeleteEntryRequest,
  parseGalleryCreateRequest,
  parseGalleryRegistryRequest,
  parseOverviewRoleRequest,
  parseRenameEntryRequest,
  resolveGalleryRoot,
  resolveOverviewContext,
  samePath
} from './helpers.ts'
import {
  checkProjectOverviewDocument,
  createProjectEntry,
  createProjectGallery,
  deleteProjectEntry,
  readProjectChapters,
  readProjectDir,
  readProjectForeshadowing,
  readProjectFile,
  readProjectGalleries,
  readProjectOverview,
  renameProjectEntry,
  writeProjectFile
} from './project-files.ts'
// 配置包同时也是「项目配置的纯函数库」：内容服务要读它算路径 / 注册表
import {
  loadGalleryRegistry,
  remapOverviewRole,
  updateGalleryRegistry,
  updateProjectConfig
} from '../../config/src/project-config.ts'

export const contentService = {
  name: 'nide:service:content',

  apply(ctx: NideContext): void {
    /** 当前项目根；没有打开的项目时是 undefined */
    const currentRoot = (): string | undefined =>
      ctx.services.require<HostProjectStore>('project').getCurrent()?.path

    ctx.rpc.register('files', {
      readDir: (dirPath) =>
        readProjectDir(String(dirPath ?? ''), {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        }),
      readFile: (filePath) =>
        readProjectFile(String(filePath ?? ''), {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        }),
      readChapters: (dirPath) =>
        readProjectChapters(String(dirPath ?? ''), {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        }),
      readForeshadowing: (dirPath) =>
        readProjectForeshadowing(String(dirPath ?? ''), {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        }),
      writeFile: (request) => {
        const payload = (request ?? {}) as { filePath?: unknown; content?: unknown }
        return writeProjectFile(
          {
            filePath: String(payload.filePath ?? ''),
            content: payload.content as string
          },
          {
            roots: allowedRoots(currentRoot()),
            caseInsensitive: caseInsensitivePaths()
          }
        )
      },
      createEntry: (request) => {
        const parsed = parseCreateEntryRequest(request)
        if (!parsed) return { ok: false, reason: 'invalid-name' }

        return createProjectEntry(parsed, {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        })
      },
      renameEntry: async (request) => {
        const parsed = parseRenameEntryRequest(request)
        if (!parsed) return { ok: false, reason: 'invalid-name' }

        const result = await renameProjectEntry(parsed, {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        })

        /**
         * 概述里的大纲 / 写作风格是按**文件名**记在 `.nide/config.yml` 里的：改名之后
         * 不跟着改，那条映射就断了。配置服务已经在 host，这一步直接在这里做。
         * 失败只记日志：改名本身已经落盘，不能把它报成失败。
         */
        if (result.ok) {
          const root = currentRoot()
          if (root) {
            try {
              await remapOverviewRole(root, result.previousPath, result.path)
            } catch (error) {
              console.warn('[nide-host] failed to remap the overview role after a rename', {
                error
              })
            }
          }
        }

        return result
      },
      deleteEntry: (request) => {
        const parsed = parseDeleteEntryRequest(request)
        if (!parsed) return { ok: false, reason: 'unreadable' }

        return deleteProjectEntry(parsed, {
          roots: allowedRoots(currentRoot()),
          caseInsensitive: caseInsensitivePaths()
        })
      }
    })

    /**
     * 图鉴：内容目录下每个子目录一个图鉴。
     *
     * 与文件树同一套边界（根由 host 取当前项目，渲染进程只声明路径），另外多一条：
     * 报上来的路径必须**正是配置里那个图鉴内容目录**。注册表与列表在同一个结果里，
     * 因为界面上总是一起用。
     */
    ctx.rpc.register('gallery', {
      read: async (targetPath) => {
        const roots = allowedRoots(currentRoot())
        const root = roots[0]
        if (!root) return { ok: false, reason: 'outside-project' }

        const galleryRoot = await resolveGalleryRoot(root)
        if (galleryRoot === null || !samePath(galleryRoot, String(targetPath ?? ''))) {
          return { ok: false, reason: 'outside-project' }
        }

        const listing = await readProjectGalleries(galleryRoot, {
          roots,
          caseInsensitive: caseInsensitivePaths()
        })
        if (!listing.ok) return listing

        return {
          ok: true,
          path: listing.path,
          registry: await loadGalleryRegistry(root),
          galleries: listing.galleries
        }
      },

      create: async (request) => {
        const parsed = parseGalleryCreateRequest(request)
        if (!parsed) return { ok: false, reason: 'invalid-name' }

        const roots = allowedRoots(currentRoot())
        const root = roots[0]
        if (!root) return { ok: false, reason: 'unreadable' }

        const galleryRoot = await resolveGalleryRoot(root)
        if (galleryRoot === null || !samePath(galleryRoot, parsed.targetPath)) {
          return { ok: false, reason: 'not-a-directory' }
        }

        return createProjectGallery(parsed, {
          roots,
          caseInsensitive: caseInsensitivePaths()
        })
      },

      updateRegistry: async (request) => {
        const root = currentRoot()
        if (!root) return null

        const characters = parseGalleryRegistryRequest(request)
        if (characters === null) return { ok: false, reason: 'invalid-name' }

        return updateGalleryRegistry(root, characters)
      }
    })

    /**
     * 概述：内容目录里平铺的 Markdown，其中两份被项目配置登记成大纲 / 写作风格。
     *
     * 与图鉴同一套边界，另外多一条：报上来的路径必须正是配置里那个概述内容目录。
     */
    ctx.rpc.register('overview', {
      read: async (targetPath) => {
        const roots = allowedRoots(currentRoot())
        const root = roots[0]
        if (!root) return { ok: false, reason: 'outside-project' }

        const overview = await resolveOverviewContext(root)
        if (overview === null || !samePath(overview.path, String(targetPath ?? ''))) {
          return { ok: false, reason: 'outside-project' }
        }

        return readProjectOverview(overview.path, {
          roots,
          caseInsensitive: caseInsensitivePaths()
        })
      },

      setRole: async (request) => {
        const parsed = parseOverviewRoleRequest(request)
        if (!parsed) return { ok: false, reason: 'invalid-name' }

        const roots = allowedRoots(currentRoot())
        const root = roots[0]
        if (!root) return { ok: false, reason: 'unreadable' }

        const overview = await resolveOverviewContext(root)
        if (overview === null) return { ok: false, reason: 'unreadable' }

        const options = { roots, caseInsensitive: caseInsensitivePaths() }
        const check = await checkProjectOverviewDocument(overview.path, parsed.fileName, options)
        if (check !== 'ok') return { ok: false, reason: check }

        const updated = await updateProjectConfig(root, {
          overview: { [parsed.role]: parsed.fileName }
        })

        if (!updated.ok) return { ok: false, reason: 'invalid-name' }
        return { ok: true, config: updated.config }
      }
    })

    /**
     * 项目配置（`.nide/config.yml`）。
     *
     * 项目根由 host 取当前项目，渲染进程只声明「我要配置」—— 它指定不了读谁、更指定
     * 不了写到哪儿。服务会在 `.nide` 缺失或坏掉时静默重建默认配置，所以调用方永远拿得到
     * 一份可用的配置。
     */
  }
}

/** profile 通过 `kind: service` 行指向本文件，宿主入口取 default 后 apply */
export default contentService
