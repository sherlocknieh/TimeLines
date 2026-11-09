import { createRouter, createWebHistory } from "vue-router";

import ZoomView from "./views/ZoomView.vue";

/**
 * 使用 /timeline/ 下的 HTML5 history：应用只有根页面，不需要把根路由编码到 hash 中。
 */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "zoom", component: ZoomView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
