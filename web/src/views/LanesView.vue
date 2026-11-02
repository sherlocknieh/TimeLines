<script setup lang="ts">
import TimelineStage from "../components/TimelineStage.vue";
import { JUMP_YEARS, yOf } from "../lib/timeline";

function jumpTo(year: number) {
  const stage = document.getElementById("stage");
  if (!stage) return;
  const stageTop = stage.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({
    top: Math.max(0, stageTop + yOf(year) - window.innerHeight * 0.34),
    behavior: "smooth",
  });
}
</script>

<template>
  <main>
    <header class="hero">
      <p class="kicker">Scheme 01 · Proportional Lanes</p>
      <h1>同一时间，<em>两种命运</em></h1>
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
  </main>
</template>
