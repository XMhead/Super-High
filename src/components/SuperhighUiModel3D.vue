<script setup lang="ts">
import { inject, onBeforeUnmount, ref, watch } from 'vue'
import type { UiNode } from '@/lib/superhighUi'
import { SUPERHIGH_UI_CONTEXT } from './SuperhighUiNode'

const props = defineProps<{ node: UiNode }>()
const ui = inject(SUPERHIGH_UI_CONTEXT)!
const host = ref<HTMLDivElement | null>(null)
const error = ref('')
const loading = ref(true)
let dispose: (() => void) | undefined
let generation = 0

function resourcePath(model: string, resource: string) {
  if (/^(?:data:|https?:)/i.test(resource)) return resource
  if (/^https?:/i.test(model)) return new URL(resource, model).href
  return `${model.replace(/[^/\\]*$/, '')}${decodeURIComponent(resource)}`
}

watch(() => [String(props.node.props.src ?? ''), ui.imageRevision(String(props.node.props.src ?? '')), host.value] as const,
  async ([src, , element], _old, onCleanup) => {
    const id = ++generation
    onCleanup(() => { generation++; dispose?.(); dispose = undefined })
    error.value = ''; loading.value = true
    if (!src || !element) return
    let cleanup: (() => void) | undefined
    try {
      const [THREE, { GLTFLoader }, { OrbitControls }, url] = await Promise.all([
        import('three'), import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/controls/OrbitControls.js'), ui.resolveMedia(src),
      ])
      if (id !== generation) return
      const bytes = await fetch(url).then((response) => { if (!response.ok) throw new Error('读取失败'); return response.arrayBuffer() })
      const isGltf = /\.gltf(?:[?#]|$)/i.test(src)
      const dependencies = new Map<string, string>()
      if (isGltf) {
        const json = JSON.parse(new TextDecoder().decode(bytes))
        const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])].map((item: { uri?: string }) => item.uri).filter((uri): uri is string => !!uri && !uri.startsWith('data:'))
        await Promise.all(uris.map(async (uri) => dependencies.set(uri, await ui.resolveMedia(resourcePath(src, uri)))))
      }
      if (id !== generation) return
      const manager = new THREE.LoadingManager()
      manager.setURLModifier((uri) => dependencies.get(uri) ?? uri)
      const loader = new GLTFLoader(manager)
      const gltf = await loader.parseAsync(isGltf ? new TextDecoder().decode(bytes) : bytes, '')
      const release = () => gltf.scene.traverse((item) => {
        const mesh = item as import('three').Mesh
        mesh.geometry?.dispose()
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
        for (const material of materials) {
          for (const value of Object.values(material)) if (value && typeof value === 'object' && (value as import('three').Texture).isTexture) (value as import('three').Texture).dispose()
          material.dispose()
        }
      })
      if (id !== generation) { release(); return }
      cleanup = release
      const scene = new THREE.Scene()
      scene.add(gltf.scene, new THREE.HemisphereLight(0xffffff, 0x777777, 2))
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(3, 5, 4); scene.add(light)
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const center = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3())
      const extent = Math.max(size.x, size.y, size.z) || 1
      const camera = new THREE.PerspectiveCamera(45, 1, extent / 1000, extent * 1000)
      camera.position.copy(center).add(new THREE.Vector3(extent * 1.5, extent, extent * 1.5))
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      element.appendChild(renderer.domElement)
      const controls = new OrbitControls(camera, renderer.domElement)
      controls.target.copy(center); controls.update()
      const render = () => renderer.render(scene, camera)
      controls.addEventListener('change', render)
      const resize = () => { const width = element.clientWidth || 1; const height = element.clientHeight || 1; camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); render() }
      const observer = new ResizeObserver(resize); observer.observe(element); resize()
      cleanup = () => { observer.disconnect(); controls.removeEventListener('change', render); controls.dispose(); release(); renderer.dispose(); renderer.domElement.remove() }
      dispose = cleanup; loading.value = false
    } catch (reason) {
      cleanup?.()
      if (id === generation) { error.value = reason instanceof Error ? reason.message : String(reason); loading.value = false }
    }
  }, { immediate: true })
onBeforeUnmount(() => { generation++; dispose?.() })
</script>

<template>
  <div>
    <button type="button" class="shui-resource-link" @click="ui.openResource(String(node.props.src || ''))">{{ node.props.label || node.props.src }}</button>
    <div ref="host" class="shui-model" :aria-label="String(node.props.label || node.props.src)" />
    <div v-if="loading" class="shui-pending">正在加载模型</div>
    <div v-else-if="error" class="shui-issue">模型无法读取：{{ error }}</div>
  </div>
</template>
