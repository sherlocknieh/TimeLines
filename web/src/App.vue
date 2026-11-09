<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";

const progress = ref(0);
const showToTop = ref(false);
const docsUrl = `${import.meta.env.BASE_URL}docs/`;

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
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});

onBeforeUnmount(() => {
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

  <header class="app-nav">
    <div class="app-nav__inner">
      <RouterLink class="brand" to="/">Time<span>Lines</span></RouterLink>
    </div>
  </header>

  <RouterView />

  <footer class="foot">
    <p>
      <b>TimeLines</b> · 同一份 demo 数据（英国 × 美国，52 个事件）的缩放时间轴。
    </p>
    <p class="foot__back"><a :href="docsUrl">← 返回 TimeLines 文档</a></p>
  </footer>

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
