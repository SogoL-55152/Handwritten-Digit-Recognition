import { reactive, toRefs } from 'vue'
import { defineStore } from 'pinia'
import { useUserStore } from './user.js'
import { appConfig } from '../app-config.js'
import { createWorkspaceContext } from '../workspace/context.js'
import { listWorkspaces, getWorkspace, createWorkspace } from '../api/workspaces.js'

export const useWorkspaceStore = defineStore('workspace-v2', () => {
  const context = createWorkspaceContext({ session: useUserStore(), list: listWorkspaces, get: getWorkspace, create: createWorkspace, defaultOnly: appConfig.pilot, reactive })
  return { ...toRefs(context.state), getSnapshot: context.getSnapshot, isCurrent: context.isCurrent,
    load: context.load, select: context.select, createSpace: context.createSpace, subscribe: context.subscribe }
})
