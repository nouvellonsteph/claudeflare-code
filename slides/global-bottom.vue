<template>
  <div v-if="$slidev.nav.currentPage > 1" class="deck-footer">
    <span>CLAUDEFLARE CODE / ZERO TRUST EGRESS</span>
    <span>{{ String($slidev.nav.currentPage).padStart(2, '0') }}</span>
  </div>
</template>
