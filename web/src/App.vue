<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";

const progress = ref(0);
const showToTop = ref(false);
const navEl = ref<HTMLElement | null>(null);
const docsUrl = `${import.meta.env.BASE_URL}docs/`;

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
  onScroll();
});

onBeforeUnmount(() => {
  navObserver?.disconnect();
  window.removeEventListener("scroll", onScroll);
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
