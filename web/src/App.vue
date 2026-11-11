<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";

import { applyTheme, THEMES, theme } from "./lib/theme";

const progress = ref(0);
const showToTop = ref(false);
const navEl = ref<HTMLElement | null>(null);
const themeOpen = ref(false);
const themeWrap = ref<HTMLElement | null>(null);
const docsUrl = `${import.meta.env.BASE_URL}docs/`;

/** 点选主题后收起面板，让配色变化立刻可见 */
function pickTheme(id: (typeof THEMES)[number]["id"]) {
  applyTheme(id);
  themeOpen.value = false;
}

/** 点击面板外部或按 Esc 收起主题面板 */
function onDocumentPointerDown(event: PointerEvent) {
  if (!themeOpen.value) return;
  if (themeWrap.value?.contains(event.target as Node)) return;
  themeOpen.value = false;
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") themeOpen.value = false;
}

/** 视图高度按导航实际高度收尾，底部操作栏才能贴齐视口 */
function syncNavHeight() {
  if (!navEl.value) return;
  document.documentElement.style.setProperty(
    "--nav-h",
    `${navEl.value.offsetHeight}px`,
  );
}

let navObserver: ResizeObserver | undefined;

function onScroll() {
  const doc = document.documentElement;
  const max = doc.scrollHeight - doc.clientHeight;
  progress.value = max > 0 ? Math.min(1, Math.max(0, doc.scrollTop / max)) : 0;
  showToTop.value = doc.scrollTop > 700;
}

function backToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

onMounted(() => {
  syncNavHeight();
  if (navEl.value) {
    navObserver = new ResizeObserver(syncNavHeight);
    navObserver.observe(navEl.value);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
  onScroll();
});

onBeforeUnmount(() => {
  navObserver?.disconnect();
  window.removeEventListener("scroll", onScroll);
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div class="progress">
    <div
      class="progress__bar"
      :style="{ transform: `scaleX(${progress.toFixed(4)})` }"
    ></div>
  </div>

  <header ref="navEl" class="app-nav">
    <div class="app-nav__inner">
      <RouterLink class="brand" to="/">Time<span>Lines</span></RouterLink>
      <a class="app-nav__docs" :href="docsUrl">文档</a>
      <div ref="themeWrap" class="theme">
        <button
          class="theme__toggle"
          type="button"
          aria-label="切换配色主题"
          title="切换配色主题"
          :aria-expanded="themeOpen"
          aria-haspopup="listbox"
          @click="themeOpen = !themeOpen"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1.6a6.4 6.4 0 1 0 0 12.8c.9 0 1.4-.6 1.4-1.3 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.7.6-1.3 1.4-1.3h1.2A3.2 3.2 0 0 0 14.4 6.6C14.4 3.8 11.5 1.6 8 1.6Z"
            ></path>
            <circle cx="5.2" cy="6" r="1"></circle>
            <circle cx="8" cy="4.4" r="1"></circle>
            <circle cx="10.8" cy="6" r="1"></circle>
          </svg>
        </button>
        <ul
          v-if="themeOpen"
          class="theme__menu"
          role="listbox"
          aria-label="配色主题"
        >
          <li v-for="item in THEMES" :key="item.id">
            <button
              class="theme__option"
              :class="{ 'is-on': theme === item.id }"
              type="button"
              role="option"
              :aria-selected="theme === item.id"
              :style="{ background: item.swatch[0], color: item.swatch[1] }"
              @click="pickTheme(item.id)"
            >
              {{ item.label }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </header>

  <RouterView />

  <button
    class="to-top"
    :class="{ show: showToTop }"
    type="button"
    aria-label="回到顶部"
    @click="backToTop"
  >
    ↑
  </button>
</template>
