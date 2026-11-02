<script setup lang="ts">
import { computed, ref } from "vue";

import { EVENTS, type Side } from "../data/events";
import { LANES, TAGS, laneLabel, laneOf } from "../lib/dataset";

const lane = ref<Side | "all">("all");
const tag = ref<string | "all">("all");
const query = ref("");
const tagsExpanded = ref(false);

const TAG_PREVIEW = 14;
const visibleTags = computed(() =>
  tagsExpanded.value ? TAGS : TAGS.slice(0, TAG_PREVIEW),
);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return EVENTS.map((event, id) => ({ id, event, side: laneOf(event) }))
    .filter((item) => lane.value === "all" || item.side === lane.value)
    .filter((item) => tag.value === "all" || item.event.tag === tag.value)
    .filter((item) => {
      if (!q) return true;
      const haystack = `${item.event.y} ${item.event.t} ${item.event.d} ${item.event.tag}`;
      return haystack.toLowerCase().includes(q);
    });
});

/** 按世纪分组，便于阅读与校对 */
const groups = computed(() => {
  const map = new Map<number, typeof filtered.value>();
  for (const item of filtered.value) {
    const century = Math.floor(item.event.y / 100) * 100;
    const bucket = map.get(century);
    if (bucket) bucket.push(item);
    else map.set(century, [item]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([century, items]) => ({
      century,
      items: [...items].sort((a, b) => a.event.y - b.event.y),
    }));
});

function toggleLane(next: Side | "all") {
  lane.value = next;
}

function toggleTag(next: string) {
  tag.value = tag.value === next ? "all" : next;
}

function reset() {
  lane.value = "all";
  tag.value = "all";
  query.value = "";
}
</script>

<template>
  <section class="view">
    <header class="view__head">
      <p class="view__kicker">Scheme 04 · Century List</p>
      <h1 class="view__title">世纪清单</h1>
      <p class="view__sub">
        不画时间轴，按世纪分组的可筛选清单。它适合整理、检索和校对数据，
        也用来检验其他视图是否漏掉事件。
      </p>
    </header>

    <div class="filters">
      <input v-model="query" class="search" type="search" placeholder="搜索年份、标题、描述…" />
      <button
        class="chip"
        :class="{ 'is-on': lane === 'all' }"
        type="button"
        @click="toggleLane('all')"
      >
        全部泳道
      </button>
      <button
        v-for="item in LANES"
        :key="item.id"
        class="chip"
        :class="{ 'is-on': lane === item.id }"
        type="button"
        @click="toggleLane(item.id)"
      >
        {{ item.label }}
      </button>
      <button class="chip chip--ghost" type="button" @click="reset">重置</button>
    </div>

    <div class="filters filters--tags">
      <button
        v-for="item in visibleTags"
        :key="item"
        class="chip chip--sm"
        :class="{ 'is-on': tag === item }"
        type="button"
        @click="toggleTag(item)"
      >
        {{ item }}
      </button>
      <button
        v-if="TAGS.length > TAG_PREVIEW"
        class="chip chip--sm chip--ghost"
        type="button"
        @click="tagsExpanded = !tagsExpanded"
      >
        {{ tagsExpanded ? "收起标签" : `更多标签（${TAGS.length - TAG_PREVIEW}）` }}
      </button>
    </div>

    <p class="result-count">
      共 <b>{{ filtered.length }}</b> 个事件<template v-if="lane !== 'all'">
        · {{ laneLabel(lane) }}</template
      ><template v-if="tag !== 'all'"> · {{ tag }}</template>
    </p>

    <div v-if="groups.length === 0" class="empty">
      没有匹配的事件，试试清空关键词或筛选条件。
    </div>

    <section v-for="group in groups" :key="group.century" class="century">
      <h2 class="century__head">
        <span>{{ group.century }}</span>
        <i></i>
        <em>{{ group.items.length }}</em>
      </h2>
      <div class="cards">
        <article
          v-for="item in group.items"
          :key="item.id"
          class="event-card"
          :class="`is-${item.side}`"
        >
          <p class="event-card__top">
            <span class="event-card__year">{{ item.event.y }}</span>
            <span class="event-card__tag">{{ item.event.tag }}</span>
          </p>
          <h3 class="event-card__title">{{ item.event.t }}</h3>
          <p class="event-card__desc">{{ item.event.d }}</p>
          <p class="event-card__lane">{{ laneLabel(item.side) }}</p>
        </article>
      </div>
    </section>
  </section>
</template>
