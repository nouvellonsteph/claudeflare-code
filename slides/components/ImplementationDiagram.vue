<script setup lang="ts">
import { computed, ref } from 'vue'

type Mode = 'http' | 'ssh' | 'blocked'

const mode = ref<Mode>('http')
const selectedNode = ref('gateway')

const modes: Array<{ id: Mode; label: string }> = [
  { id: 'http', label: 'HTTP / HTTPS' },
  { id: 'ssh', label: 'Private SSH / TCP' },
  { id: 'blocked', label: 'Direct internet' },
]

const nodes = [
  { id: 'identity', title: 'Access identity', meta: 'user@company.com', x: 2, y: 40 },
  { id: 'container', title: 'Per-user container', meta: 'enableInternet = false', x: 20, y: 40 },
  { id: 'capture', title: 'Egress capture', meta: 'trusted Worker hook', x: 41, y: 40 },
  { id: 'gateway', title: 'Zero Trust', meta: 'identity-scoped policy', x: 62, y: 40 },
  { id: 'ai', title: 'AI Gateway', meta: 'HTTP / inspected', x: 83, y: 7 },
  { id: 'ssh', title: 'Private SSH target', meta: '10.154.0.33', x: 83, y: 40 },
  { id: 'internet', title: 'Direct internet', meta: 'no fallback route', x: 83, y: 73 },
]

const details: Record<string, { kicker: string; text: string }> = {
  identity: { kicker: 'CONTROL 01', text: 'The verified Access email keys the Durable Object and becomes the runtime identity for egress.' },
  container: { kicker: 'CONTROL 02', text: 'Deny-by-default removes the public fallback path before untrusted workspace code runs.' },
  capture: { kicker: 'CONTROL 03', text: 'HTTP handlers and the targeted TCP interceptor hand connections to trusted Workers code.' },
  gateway: { kicker: 'CONTROL 04', text: 'The VPC fetcher carries user identity into Cloudflare One for policy, inspection, and logs.' },
  ai: { kicker: 'HTTP PATH', text: 'Claude API calls are translated, tagged, and forwarded through AI Gateway without exposing its token.' },
  ssh: { kicker: 'SSH PATH', text: 'Access for Infrastructure authorizes the target and username, then replaces static keys with a short-lived certificate.' },
  internet: { kicker: 'DENY PATH', text: 'Unmatched public TCP has no route. HTTP can proceed only through the explicit identity-aware handler.' },
}

const activeEdges = computed(() => {
  if (mode.value === 'http') return ['identity', 'container', 'capture', 'gateway', 'http']
  if (mode.value === 'ssh') return ['identity', 'container', 'capture', 'gateway', 'tcp']
  return ['identity', 'container', 'deny']
})

const currentDetail = computed(() => details[selectedNode.value])

function setMode(next: Mode) {
  mode.value = next
  selectedNode.value = next === 'http' ? 'ai' : next === 'ssh' ? 'ssh' : 'internet'
}

function edgeClass(id: string) {
  return {
    active: activeEdges.value.includes(id),
    denied: mode.value === 'blocked' && id === 'deny',
  }
}
</script>

<template>
  <div class="diagram-shell">
    <div class="mode-picker" role="group" aria-label="Traffic path">
      <button
        v-for="item in modes"
        :key="item.id"
        type="button"
        :aria-pressed="mode === item.id"
        @click.stop="setMode(item.id)"
      >
        {{ item.label }}
      </button>
    </div>

    <div class="diagram-canvas">
      <svg viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <path d="M170 194 H200" :class="edgeClass('identity')" />
        <path d="M360 194 H410" :class="edgeClass('container')" />
        <path d="M570 194 H620" :class="edgeClass('capture')" />
        <path d="M780 194 C810 194 805 62 835 62" :class="edgeClass('http')" />
        <path d="M780 194 H835" :class="edgeClass('tcp')" />
        <path d="M360 230 C470 350 720 350 835 326" class="deny-line" :class="edgeClass('deny')" />
        <text x="474" y="338" :class="{ show: mode === 'blocked' }">NO PUBLIC FALLBACK</text>
      </svg>

      <button
        v-for="node in nodes"
        :key="node.id"
        type="button"
        class="diagram-node"
        :class="[
          node.id,
          { selected: selectedNode === node.id },
          { dimmed: mode === 'blocked' && ['capture', 'gateway', 'ai', 'ssh'].includes(node.id) },
        ]"
        :style="{ left: `${node.x}%`, top: `${node.y}%` }"
        @click.stop="selectedNode = node.id"
      >
        <span>{{ node.title }}</span>
        <small>{{ node.meta }}</small>
      </button>
    </div>

    <div class="diagram-detail" aria-live="polite">
      <span>{{ currentDetail.kicker }}</span>
      <p>{{ currentDetail.text }}</p>
    </div>
  </div>
</template>

<style scoped>
.diagram-shell { color: #521000; }
.mode-picker { display: flex; gap: 7px; margin-bottom: 10px; }
.mode-picker button { padding: 7px 13px; color: rgba(82,16,0,.62); border: 1px solid #ebd5c1; border-radius: 999px; background: #fffdfb; font: 500 10px/1 "SF Mono", monospace; cursor: pointer; }
.mode-picker button:hover { color: #ff4801; border-color: #ff7038; border-style: dashed; }
.mode-picker button[aria-pressed="true"] { color: #fffaf5; border-color: #ff4801; background: #ff4801; }
.diagram-canvas { position: relative; height: 295px; border: 1px solid #ebd5c1; background-color: rgba(255,253,251,.92); background-image: radial-gradient(circle, #ebd5c1 .7px, transparent .75px); background-size: 12px 12px; overflow: hidden; }
.diagram-canvas::before,
.diagram-canvas::after { content: ""; position: absolute; width: 9px; height: 9px; border: 1px solid #ff7038; background: #fffbf5; z-index: 3; }
.diagram-canvas::before { top: -5px; left: -5px; }
.diagram-canvas::after { right: -5px; bottom: -5px; }
svg { position: absolute; inset: 0; width: 100%; height: 100%; }
svg path { fill: none; stroke: #ebd5c1; stroke-width: 2; marker-end: url(#arrow); transition: stroke .2s, stroke-width .2s, opacity .2s; }
svg marker path { fill: #ebd5c1; stroke: none; }
svg path.active { stroke: #ff7038; stroke-width: 3; }
svg path.denied { stroke: #c24137; stroke-dasharray: 7 6; }
svg text { fill: #c24137; opacity: 0; font: 500 10px "SF Mono", monospace; letter-spacing: .08em; transition: opacity .2s; }
svg text.show { opacity: 1; }
.diagram-node { position: absolute; width: 16%; min-height: 62px; transform: translateY(-50%); padding: 12px 10px; text-align: left; color: #521000; border: 1px solid #ebd5c1; border-radius: 3px; background: #fffdfb; box-shadow: 0 6px 18px rgba(82,16,0,.04); cursor: pointer; transition: opacity .2s, border-color .2s, transform .2s, box-shadow .2s; }
.diagram-node::after { content: ""; position: absolute; top: -4px; right: -4px; width: 7px; height: 7px; border: 1px solid #ff7038; border-radius: 1.5px; background: #fffbf5; }
.diagram-node:hover,
.diagram-node.selected { border-color: #ff7038; transform: translateY(-50%) scale(1.02); box-shadow: 0 9px 22px rgba(255,72,1,.1); }
.diagram-node span { display: block; font-size: 12px; font-weight: 500; }
.diagram-node small { display: block; margin-top: 5px; color: rgba(82,16,0,.52); font: 9px/1.2 "SF Mono", monospace; }
.diagram-node.dimmed { opacity: .28; }
.diagram-node.internet { border-style: dashed; }
.diagram-detail { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: center; min-height: 50px; padding: 0 14px; border: 1px solid #ebd5c1; border-top: 0; background: rgba(255,72,1,.045); }
.diagram-detail > span { color: #ff4801; font: 500 9px/1 "SF Mono", monospace; letter-spacing: .08em; }
.diagram-detail p { margin: 0; color: rgba(82,16,0,.68); font-size: 11px; line-height: 1.35; }
</style>
