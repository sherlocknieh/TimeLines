<script setup lang="ts">
import { RouterLink } from "vue-router";

const schemes = [
  {
    path: "/lanes",
    no: "01",
    title: "等比泳道",
    desc: "纵向时间轴，左右两条泳道。按真实年份等比缩放，密集事件自动避让并用细线连回真实坐标。",
    meta: "纵向滚动 · 点击展开 · 年份跳转",
  },
  {
    path: "/gantt",
    no: "02",
    title: "横向甘特",
    desc: "年份作为横轴，每条泳道一行。适合快速扫视一段时间内的分布，以及跨泳道的同频对比。",
    meta: "拖拽平移 · 按钮/Ctrl+滚轮缩放 · 适应宽度",
  },
  {
    path: "/zoom",
    no: "03",
    title: "缩放轴",
    desc: "竖直时间轴默认水平居中。轴上滚轮缩放、轴外滚轮滚动页面，上下拖动平移时间、左右拖动移动轴线；缩放会自动切换事件层级，并可切到对数分布。",
    meta: "轴上滚轮缩放 · 悬停日期 · 语义层级 · 线性/对数 · 轴线左右拖动",
  },
  {
    path: "/list",
    no: "04",
    title: "世纪清单",
    desc: "放弃图形化，按世纪分组阅读。适合整理、检索与校对数据，也是其他视图的原始来源。",
    meta: "搜索 · 泳道筛选 · 标签筛选",
  },
] as const;
</script>

<template>
  <section class="view">
    <header class="view__head">
      <p class="view__kicker">TimeLines · Display & Control Schemes</p>
      <h1 class="view__title">同一份数据，四种时间线读法</h1>
      <p class="view__sub">
        每个页面用同一份 demo 数据（英国 × 美国，52 个事件）验证一种显示与控制的组合。
        结构和交互都是独立的，可以单独取用、替换。
      </p>
    </header>

    <div class="gallery">
      <RouterLink
        v-for="scheme in schemes"
        :key="scheme.path"
        class="view-card"
        :to="scheme.path"
      >
        <span class="view-card__no">SCHEME {{ scheme.no }}</span>
        <span class="view-card__title">{{ scheme.title }}</span>
        <span class="view-card__desc">{{ scheme.desc }}</span>
        <span class="view-card__meta">{{ scheme.meta }}</span>
      </RouterLink>
    </div>
  </section>
</template>
