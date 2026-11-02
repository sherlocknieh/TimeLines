import { createRouter, createWebHashHistory } from "vue-router";

import GalleryView from "./views/GalleryView.vue";
import GanttView from "./views/GanttView.vue";
import LanesView from "./views/LanesView.vue";
import ListView from "./views/ListView.vue";
import ZoomView from "./views/ZoomView.vue";

/**
 * 使用 hash 路由：静态托管与本地中间件都不需要 SPA 回退规则，
 * 直接访问 /timeline/#/gantt 即可。
 */
export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "gallery", component: GalleryView },
    { path: "/lanes", name: "lanes", component: LanesView },
    { path: "/gantt", name: "gantt", component: GanttView },
    { path: "/zoom", name: "zoom", component: ZoomView },
    { path: "/list", name: "list", component: ListView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
