<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import TimelineStage from "./components/TimelineStage.vue";
import { JUMP_YEARS, yOf } from "./lib/timeline";

const progress = ref(0);
const showToTop = ref(false);

function onScroll() {
  const doc = document.documentElement;
  const max = doc.scrollHeight - doc.clientHeight;
  progress.value = max > 0 ? Math.min(1, Math.max(0, doc.scrollTop / max)) : 0;
  showToTop.value = doc.scrollTop > 700;
}

function jumpTo(year: number) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  const stageTop = stage.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({
    top: Math.max(0, stageTop + yOf(year) - window.innerHeight * 0.34),
    behavior: "smooth",
  });
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

  <header class="hero">
    <p class="kicker">Proportional Timeline · 1200 — 2030</p>
    <p class="hero__sub">
      左侧英国，右侧美国，中间是一条<b>按真实年份等比缩放</b>的时间轴。
      纵向距离就是时间距离：一段空白，就是一段没有事件的历史；
      越往下越拥挤，因为历史在加速。
    </p>
    <div class="legend">
      <span><span class="chipmini"><b>1215</b> · 英国</span></span>
      <hr />
      <span><span class="chipmini chipmini--us"><b>1250</b> · 美国</span></span>
    </div>
    <div class="metabar">
      <span class="scale"><i></i>每 100 年 = 320 px</span>
      <span class="hint"><span class="hint__key">点我</span>气泡只显示年份与标题，点开看全文</span>
    </div>
    <nav class="jump">
      <button
        v-for="year in JUMP_YEARS"
        :key="year"
        type="button"
        :data-year="year"
        @click="jumpTo(year)"
      >
        {{ year }}
      </button>
    </nav>
  </header>

  <div class="wrap">
    <TimelineStage />
  </div>

  <footer class="foot">
    <p>
      <b>每个气泡的中心线就是它在时间轴上的真实坐标</b>，
      气泡分居轴线左右代表英国与美国；纵向不做任何压缩或拉伸。
      密集处的气泡会略微错开，并用细线连回它真正的年份。<br />
      刻度每 25 年一格，标记了年份的百年刻度可用来校验比例。
    </p>
    <p class="foot__back"><a href="/">← 返回 TimeLines 文档</a></p>
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
