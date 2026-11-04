import { onUnmounted, reactive, watch } from 'vue'
import { useWorkspaceStore } from '../stores/workspace.js'
import { createScopedResource } from './resource.js'

export function useWorkspaceResource(fetch) {
  const workspace = useWorkspaceStore()
  const resource = createScopedResource({ scope: workspace, fetch, reactive })
  watch(() => [workspace.generation, workspace.active?.id], () => void resource.load(), { immediate: true })
  onUnmounted(resource.dispose)
  return resource
}
