<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowLeft, ArrowRight, BookOpen, Check, X } from 'lucide-vue-next'

const props = defineProps<{ manual?: boolean }>()
const storageKey = 'superhigh.desktop-onboarding.dismissed'
const dialog = ref<HTMLDialogElement | null>(null)
const stepIndex = ref(0)
const steps = [
  {
    label: '项目', title: '先选项目，再开始工作',
    description: '把一个本地文件夹作为工作区。对话、文件和终端围绕这个目录展开，开始任务前先确认当前项目。',
    actions: ['通过「打开项目」选择实际要处理的文件夹；之后可从最近项目返回。', '同时处理多个项目时，用顶部工作区标签切换，留意当前项目路径。'],
    tip: '给智能体布置任务时，说清要改什么、哪些内容不能动，以及怎样算完成。',
    route: ['打开项目', '确认目录', '开始任务'],
  },
  {
    label: '对话', title: '一个任务，保留一条对话',
    description: '在对话列表中新建对话，选择要用的 CLI，并填写初始指令。运行环境取决于本机已安装和配置的工具。',
    actions: ['启动前确认工作目录和 CLI；工具不可用时，到「设置 → 终端」检查环境。', '在左侧切换已有对话继续追问；重命名便于区分任务，删除对话会结束对应会话。'],
    tip: '先让智能体确认范围，再执行改动。同一文件尽量只交给一个正在运行的任务。',
    route: ['新建对话', '选择 CLI', '输入任务'],
  },
  {
    label: '文件', title: '边处理，边核对实际文件',
    description: '从文件树打开文件，在代码预览中查看或编辑；需要浏览更多目录时，切换活动栏的文件管理器。',
    actions: ['智能体修改后，打开相关文件核对结果，不只看对话中的完成提示。', '自己的编辑要及时保存；关闭工作区时若提示未保存，先确认保存或放弃的范围。'],
    tip: 'Markdown 可以切换渲染模式，方便直接检查文档呈现。',
    route: ['文件树', '代码预览', '核对并保存'],
  },
  {
    label: '终端', title: '把对话任务与本地命令配合起来',
    description: '智能体对话用于持续推进任务，本地终端用于运行命令和查看输出。需要同时观察多个任务时，可使用多终端模式。',
    actions: ['通过「本地终端」进入命令环境，运行前确认所在目录。', '切换对话可以保留任务上下文；遇到失败先查看输出，再决定重试或调整指令。'],
    tip: '有任务运行时，避免直接结束会话或关闭应用，以免打断当前工作。',
    route: ['运行任务', '查看输出', '核对结果'],
  },
  {
    label: '小管家', title: '按需显示小管家，右击展开面板',
    description: '小管家与宠物可以随时显示或隐藏。在 Super High 应用窗口内，按反引号键（`）切换显示状态，再按一次即可恢复。',
    actions: ['先关闭教程，将焦点放在 Super High 窗口内，按反引号键（`）显示或隐藏小管家与宠物。', '宠物显示时，右击宠物展开或收起管家面板；点击面板右上角的「收起管家」也可收起面板。'],
    tip: '忘记快捷键时，可到「设置 → 键盘快捷键」查看「SuperHigh 管家」。反引号键通常位于 Esc 下方，与波浪号（~）共用一个键。',
    route: ['反引号切换显示', '右击宠物', '展开或收起'],
  },
  {
    label: '排错', title: '连不上模型时，先检查渠道',
    description: '「设置 → 集成 → 渠道检测」用于检查已配置供应商与模型的请求是否正常。先确认 CLI 环境，再定位模型连接问题。',
    actions: ['在渠道检测中选择需要检查的供应商和模型，查看检测结果。', '根据失败信息检查地址、密钥或模型配置；调整后再检测，并回到原对话继续任务。'],
    tip: '检测结果只反映这次请求。它可以帮助定位问题，但不代表长任务一定成功。',
    route: ['CLI 环境', '渠道检测', '继续对话'],
  },
  {
    label: '接续', title: '需要时，用手机接上电脑',
    description: '在「设置 → 手机端」启动 Host，让同一局域网里的手机连接这台电脑，使用电脑提供的手机界面。',
    actions: ['按手机端设置中显示的地址和连接信息操作；使用期间保持电脑和 Host 运行。', '以后想重新查看这份教程，打开「设置 → 常规」，点击「再次播放新手教程」。'],
    tip: '日常顺序：选项目 → 开对话 → 核对文件和输出 → 保存成果。现在就可以开始了。',
    route: ['电脑启动 Host', '手机连接', '接续工作'],
  },
]
const step = computed(() => steps[stepIndex.value])
const lastStep = computed(() => stepIndex.value === steps.length - 1)

async function openTutorial() {
  stepIndex.value = 0
  await nextTick()
  if (!dialog.value?.open) dialog.value?.showModal()
}

function closeTutorial() {
  // 主动关闭也视为已看过，避免每次启动打扰；设置入口始终可重放。
  if (!props.manual) {
    try { localStorage.setItem(storageKey, 'true') } catch { /* 存储不可用时仍允许关闭。 */ }
  }
  dialog.value?.close()
}

function handleKeydown(event: KeyboardEvent) {
  if (!dialog.value?.open) return
  if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (event.key === 'Escape') closeTutorial()
  else if (event.key === 'ArrowLeft') stepIndex.value = Math.max(0, stepIndex.value - 1)
  else stepIndex.value = Math.min(steps.length - 1, stepIndex.value + 1)
}

onMounted(() => {
  window.addEventListener('superhigh:replay-onboarding', openTutorial)
  window.addEventListener('keydown', handleKeydown, true)
  let dismissed = false
  try { dismissed = localStorage.getItem(storageKey) === 'true' } catch { /* 保留首次引导。 */ }
  if (!dismissed && !props.manual) void openTutorial()
})
onBeforeUnmount(() => {
  window.removeEventListener('superhigh:replay-onboarding', openTutorial)
  window.removeEventListener('keydown', handleKeydown, true)
  dialog.value?.close()
})
</script>

<template>
  <dialog ref="dialog" class="desktop-onboarding" aria-labelledby="onboarding-title" @cancel.prevent="closeTutorial">
    <header class="onboarding-header">
      <span><BookOpen :size="16" /> Super High · 桌面版新手教程</span>
      <button class="ghost-button small" aria-label="关闭新手教程" @click="closeTutorial"><X :size="16" /></button>
    </header>
    <nav class="onboarding-steps" aria-label="教程章节">
      <button v-for="(item, index) in steps" :key="item.label" :class="{ active: index === stepIndex }"
        :aria-current="index === stepIndex ? 'step' : undefined" @click="stepIndex = index">
        {{ index + 1 }} {{ item.label }}
      </button>
    </nav>
    <main class="onboarding-body" aria-live="polite" aria-atomic="true">
      <div class="onboarding-count">日常使用 · {{ stepIndex + 1 }} / {{ steps.length }}</div>
      <h1 id="onboarding-title">{{ step.title }}</h1>
      <p>{{ step.description }}</p>
      <div class="onboarding-route" aria-label="操作顺序">
        <template v-for="(part, index) in step.route" :key="part">
          <ArrowRight v-if="index" :size="14" aria-hidden="true" />
          <span>{{ part }}</span>
        </template>
      </div>
      <ol><li v-for="action in step.actions" :key="action">{{ action }}</li></ol>
      <aside>{{ step.tip }}</aside>
    </main>
    <footer class="onboarding-footer">
      <span>← → 切换 · ESC 关闭</span>
      <div>
        <button class="ghost-button small" :disabled="stepIndex === 0" @click="stepIndex--"><ArrowLeft :size="14" />上一步</button>
        <button v-if="!lastStep" class="primary-button small" @click="stepIndex++">下一步<ArrowRight :size="14" /></button>
        <button v-else class="primary-button small" @click="closeTutorial"><Check :size="14" />完成教程</button>
      </div>
    </footer>
  </dialog>
</template>

<style scoped>
.desktop-onboarding { width: min(700px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-primary); color: var(--color-text-primary); box-shadow: none; overflow: auto; }
.desktop-onboarding::backdrop { background: var(--surface-overlay); }
.onboarding-header, .onboarding-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 20px; }
.onboarding-header { border-bottom: 1px solid var(--color-border); font-size: 13px; }
.onboarding-header > span, .onboarding-footer > div { display: flex; align-items: center; gap: 8px; }
.onboarding-steps { display: flex; gap: 4px; overflow-x: auto; padding: 16px 20px 0; }
.onboarding-steps button { flex: 1 0 auto; padding: 8px 10px; border: 1px solid var(--color-border); border-radius: 4px; background: var(--color-bg-secondary); color: var(--color-text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.onboarding-steps button.active { background: var(--surface-accent-blue-soft); color: var(--color-accent-blue); border-color: var(--color-accent-blue); }
.onboarding-body { padding: 24px 28px; min-height: 350px; }
.onboarding-count { color: var(--color-accent-blue); font-size: 12px; }
.onboarding-body h1 { margin: 10px 0 12px; font-size: 24px; line-height: 1.4; }
.onboarding-body p, .onboarding-body li { font-size: 14px; line-height: 1.8; }
.onboarding-body p { color: var(--color-text-secondary); margin: 0; }
.onboarding-route { display: flex; align-items: center; gap: 8px; margin: 20px 0; color: var(--color-accent-blue); }
.onboarding-route span { padding: 7px 10px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: 4px; font-size: 12px; }
.onboarding-route svg { flex-shrink: 0; }
.onboarding-body ol { padding-left: 20px; margin: 0 0 20px; }
.onboarding-body li + li { margin-top: 8px; }
.onboarding-body aside { padding: 12px; border-left: 2px solid var(--color-accent-blue); background: var(--color-bg-secondary); color: var(--color-text-secondary); font-size: 12px; line-height: 1.7; }
.onboarding-footer { border-top: 1px solid var(--color-border); }
.onboarding-footer > span { color: var(--color-text-secondary); font-size: 12px; }
.desktop-onboarding button:focus-visible { outline: 2px solid var(--color-accent-blue); outline-offset: 2px; box-shadow: none; }
@media (max-width: 520px) {
  .onboarding-header, .onboarding-footer { padding: 12px; }
  .onboarding-steps { padding: 12px 12px 0; }
  .onboarding-body { padding: 20px 16px; min-height: 0; }
  .onboarding-body h1 { font-size: 21px; }
  .onboarding-route { gap: 4px; }
  .onboarding-route span { padding: 6px; }
  .onboarding-footer { flex-wrap: wrap; }
}
</style>
